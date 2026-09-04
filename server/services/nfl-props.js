/**
 * NFL player prop projections and weekly total picks.
 *
 * Same philosophy as the fantasy projection engine: volume x efficiency, with
 * volume shifted by the game script the market is forecasting, then simulated
 * rather than reported as a single number. A prop is a question about a
 * distribution ("does he clear 61.5 receiving yards"), so a point estimate
 * alone cannot answer it — the probability comes from where the line falls in
 * the simulated distribution.
 *
 * Market comparison is optional by design. With an Odds API key the board shows
 * model probability against the no-vig price and ranks by disagreement; without
 * one it still ranks by model confidence, and every market column simply reads
 * as unavailable instead of the page breaking.
 */
import { db, rows, run } from '../db/index.js';
import { playerWeeks } from './nfl-pbp.js';
import { gameScriptFor } from './gamescript.js';
import { quantile, mean } from './stats-util.js';
import {
  buildPlayerWeekEngine, playerPropEligibility, playerWeekEventExpectation,
  playerWeekProjection, sampleTeamWeekEvents, teamWeekEventExpectations
} from './player-week-engine.js';
import { hasKey, events, playerProps, flattenProps, PROP_MARKETS } from './odds-api.js';
import { calibrateAnytimeTd, activeTdCalibration } from './nfl-prop-calibration.js';
import { playerSignalTrace } from './model-signal-quality.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { nflEngineVersionFor } from './nfl-engine-registry.js';
import { calibratedTotalProbability } from './nfl-total-calibration.js';
import { shinNoVig } from './nfl-devig.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_total_picks (
    season INTEGER NOT NULL, week INTEGER NOT NULL, rank INTEGER NOT NULL,
    home_team TEXT, away_team TEXT, matchup TEXT,
    side TEXT, line REAL, american_price INTEGER,
    model_probability REAL, implied_probability REAL, probability_difference REAL,
    model_total REAL, detail TEXT, units_staked REAL DEFAULT 1, selected_at TEXT NOT NULL,
    PRIMARY KEY (season, week, rank)
  );
  CREATE TABLE IF NOT EXISTS nfl_prop_quote_snapshots (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL, commence_time TEXT,
    home_team TEXT, away_team TEXT, book TEXT NOT NULL, market TEXT NOT NULL,
    player TEXT NOT NULL, side TEXT NOT NULL, line REAL, line_key TEXT NOT NULL,
    american_price INTEGER NOT NULL,
    PRIMARY KEY (captured_at,event_id,book,market,player,side,line_key)
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_prop_quotes_event
    ON nfl_prop_quote_snapshots(event_id,market,captured_at);
`);

// Totals used to be staked at a flat 1 unit with no calibration gate at all
// (unlike spread, blocked from staking until `calibratedCoverProbability`
// proves an out-of-sample edge). A real walk-forward audit of the totals
// model (nfl-total-calibration.js, 2010-2025, n=4317) found no lambda that
// beats the no-vig market and no significant edge-predicts-outcome
// relationship — the model has nothing over the market to stake. These
// columns record that gate's verdict on every pick going forward instead of
// silently staking 1 unit regardless.
for (const [name, type] of [['calibration_eligible', 'INTEGER'], ['calibrated_probability', 'REAL']]) {
  const cols = db.prepare('PRAGMA table_info(nfl_total_picks)').all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE nfl_total_picks ADD COLUMN ${name} ${type}`);
}

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const accuracyCache = new Map();
const replayCache = new Map();

function persistPropQuotes(quotes, capturedAt) {
  const insert = db.prepare(`INSERT OR IGNORE INTO nfl_prop_quote_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,player,side,line,line_key,american_price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let stored = 0;
  for (const q of quotes) stored += insert.run(capturedAt, q.event_id, q.commence_time,
    q.home_team, q.away_team, q.book, q.market, q.player, q.side, q.line,
    q.line == null ? 'null' : String(q.line), q.american_price).changes;
  return stored;
}

export function propQuoteStatus() {
  const x = rows(`SELECT COUNT(*) quotes,COUNT(DISTINCT captured_at) captures,
                         COUNT(DISTINCT event_id) events,MIN(captured_at) first,MAX(captured_at) latest
                  FROM nfl_prop_quote_snapshots`)[0];
  return { ...x, replay_ready: (x?.captures ?? 0) >= 2 && (x?.events ?? 0) >= 25 };
}

/* ------------------------------------------------------------- projection */

/** Thin props adapter over the canonical player-week engine. */
function propView(projection, season, week, { useGameScript = true } = {}) {
  if (!projection) return null;
  const gs = useGameScript && projection.team ? gameScriptFor(projection.team, season, week) : null;
  const mult = gs?.line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
  const state = playerWeekEventExpectation(projection, { mult });
  return {
    ...state,
    projection,
    mult,
    opponent: gs?.line?.opponent ?? null,
    game_script: gs?.line ? { pass_mult: gs.pass_mult, rush_mult: gs.rush_mult, ...gs.line } : null
  };
}

/**
 * Walk-forward point and probability accuracy for the prop engine.
 *
 * Each player-week is projected only from earlier games. The same cutoff-fitted
 * game-script adjustment is used in replay and production so the audit measures
 * the policy that will actually run on Sunday.
 */
export function propReplayRows(seasons, { reconciliationStrength = 0, useCache = true } = {}) {
  const normalizedSeasons = [...new Set(seasons.map(Number))].sort((a, b) => a - b);
  const cacheKey = `${normalizedSeasons.join(',')}|reconcile=${reconciliationStrength}`;
  const cached = replayCache.get(cacheKey);
  if (useCache && cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value;
  seasons = normalizedSeasons;
  const replayRows = [];
  let eligible = 0, projected = 0;
  // Season-to-date own-average, per player, strictly prior weeks only — the
  // "beat the baseline" comparator. Reset every season so it never crosses
  // the season boundary a real bettor also can't cross.
  const history = { pass_yds: new Map(), rush_yds: new Map(), rec_yds: new Map(), receptions: new Map() };
  for (const season of seasons) {
    for (const m of Object.values(history)) m.clear();
    const actualWeeks = playerWeeks(season).filter(p => p.week >= 2);
    for (const week of [...new Set(actualWeeks.map(p => p.week))].sort((a, b) => a - b)) {
      const engine = buildPlayerWeekEngine({ season, week });
      const teamStates = new Map(), marketTeamStates = new Map();
      for (const team of new Set([...engine.values()].map(p => p.team).filter(Boolean))) {
        const gs = gameScriptFor(team, season, week);
        const mult = gs?.line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
        teamStates.set(team, teamWeekEventExpectations(engine, team, {
          mult, reconciliationStrength, conditionalPrimary: false
        }));
        marketTeamStates.set(team, teamWeekEventExpectations(engine, team, {
          mult, reconciliationStrength, conditionalPrimary: false
        }));
      }
      for (const actual of actualWeeks.filter(p => p.week === week)) {
        eligible++;
        const projection = playerWeekProjection(engine, actual.player_id);
        if (!projection) continue;
        projected++;
        const p = teamStates.get(projection.team)?.get(projection.player_id)
          ?? playerWeekEventExpectation(projection, { mult: 0 });
        const marketP = marketTeamStates.get(projection.team)?.get(projection.player_id) ?? p;
        const eligibility = playerPropEligibility(engine, projection);
        const f = actual.features;

        const noPass = (1 - Math.min(0.35, p.efficiency.pass_td_rate)) ** Math.max(0, p.volume.attempts);
        const noRush = (1 - Math.min(0.3, p.efficiency.rush_td_rate)) ** Math.max(0, p.volume.carries);
        const noRec = (1 - Math.min(0.35, p.efficiency.rec_td_rate)) ** Math.max(0, p.volume.targets);
        const noInt = (1 - Math.min(0.2, p.efficiency.int_rate)) ** Math.max(0, p.volume.attempts);
        const prob = Math.max(0.001, Math.min(0.999, 1 - noRush * noRec)); // sportsbook "anytime TD": excludes passing
        const totalTdProb = Math.max(0.001, Math.min(0.999, 1 - noPass * noRush * noRec));
        const lambdaAll = -Math.log(Math.max(1e-9, noPass * noRush * noRec));
        const multiTdProb = Math.max(0.001, Math.min(0.999, 1 - Math.exp(-lambdaAll) * (1 + lambdaAll))); // Poisson approx, 2+ TDs

        const marketNoPass = (1 - Math.min(0.35, marketP.efficiency.pass_td_rate)) ** Math.max(0, marketP.volume.attempts);
        const marketNoRush = (1 - Math.min(0.3, marketP.efficiency.rush_td_rate)) ** Math.max(0, marketP.volume.carries);
        const marketNoRec = (1 - Math.min(0.35, marketP.efficiency.rec_td_rate)) ** Math.max(0, marketP.volume.targets);
        const marketNoInt = (1 - Math.min(0.2, marketP.efficiency.int_rate)) ** Math.max(0, marketP.volume.attempts);
        const marketProb = Math.max(0.001, Math.min(0.999, 1 - marketNoRush * marketNoRec));
        const marketTotalTdProb = Math.max(0.001, Math.min(0.999, 1 - marketNoPass * marketNoRush * marketNoRec));
        const marketLambdaAll = -Math.log(Math.max(1e-9, marketNoPass * marketNoRush * marketNoRec));
        const marketMultiTdProb = Math.max(0.001, Math.min(0.999, 1 - Math.exp(-marketLambdaAll) * (1 + marketLambdaAll)));

        const actualTotalTds = (f.passing_tds ?? 0) + (f.rushing_tds ?? 0) + (f.receiving_tds ?? 0);

        const seasonToDate = key => {
          const hist = history[key].get(actual.player_id);
          return hist && hist.length >= 2 ? hist.reduce((s, v) => s + v, 0) / hist.length : null;
        };

        replayRows.push({
          season, week, player_id: actual.player_id, player_name: actual.player_name,
          team: actual.team, opponent: actual.opponent, position: projection.position,
          eligibility,
          baseline: { pass_yds: seasonToDate('pass_yds'), rush_yds: seasonToDate('rush_yds'),
            rec_yds: seasonToDate('rec_yds'), receptions: seasonToDate('receptions') },
          // Snapshot (not a reference) — the underlying arrays keep growing as
          // the replay walks forward, and a shared reference would let a later
          // week's outcome appear in an earlier week's history.
          history: {
            pass_yds: [...(history.pass_yds.get(actual.player_id) ?? [])],
            rush_yds: [...(history.rush_yds.get(actual.player_id) ?? [])],
            rec_yds: [...(history.rec_yds.get(actual.player_id) ?? [])],
            receptions: [...(history.receptions.get(actual.player_id) ?? [])]
          },
          broad: {
            pass_yds: p.events.passYd, rush_yds: p.events.rushYd,
            rec_yds: p.events.recYd, receptions: p.events.rec,
            pass_attempts: p.volume.attempts, carries: p.volume.carries, targets: p.volume.targets,
            passing_tds: p.events.passTd, rushing_tds: p.events.rushTd, receiving_tds: p.events.recTd,
            interceptions: p.events.int,
            total_touches: p.volume.carries + p.events.rec,
            total_yards: p.events.passYd + p.events.rushYd + p.events.recYd,
            total_tds: p.events.passTd + p.events.rushTd + p.events.recTd,
            anytime_td: prob, total_td: totalTdProb, multi_td: multiTdProb,
            pass_td_prob: 1 - noPass, rush_td_prob: 1 - noRush, rec_td_prob: 1 - noRec,
            interception_prob: 1 - noInt,
            volume: p.volume
          },
          market: {
            pass_yds: marketP.events.passYd, rush_yds: marketP.events.rushYd,
            rec_yds: marketP.events.recYd, receptions: marketP.events.rec,
            pass_attempts: marketP.volume.attempts, carries: marketP.volume.carries, targets: marketP.volume.targets,
            passing_tds: marketP.events.passTd, rushing_tds: marketP.events.rushTd, receiving_tds: marketP.events.recTd,
            interceptions: marketP.events.int,
            total_touches: marketP.volume.carries + marketP.events.rec,
            total_yards: marketP.events.passYd + marketP.events.rushYd + marketP.events.recYd,
            total_tds: marketP.events.passTd + marketP.events.rushTd + marketP.events.recTd,
            anytime_td: marketProb, total_td: marketTotalTdProb, multi_td: marketMultiTdProb,
            pass_td_prob: 1 - marketNoPass, rush_td_prob: 1 - marketNoRush, rec_td_prob: 1 - marketNoRec,
            interception_prob: 1 - marketNoInt,
            volume: marketP.volume
          },
          actual: {
            pass_yds: f.passing_yards ?? 0, rush_yds: f.rushing_yards ?? 0,
            rec_yds: f.receiving_yards ?? 0, receptions: f.receptions ?? 0,
            pass_attempts: f.pass_attempts ?? 0, carries: f.carries ?? 0, targets: f.targets ?? 0,
            passing_tds: f.passing_tds ?? 0, rushing_tds: f.rushing_tds ?? 0, receiving_tds: f.receiving_tds ?? 0,
            interceptions: f.interceptions ?? 0,
            total_touches: f.total_touches ?? ((f.carries ?? 0) + (f.receptions ?? 0)),
            total_yards: f.total_yards ?? ((f.passing_yards ?? 0) + (f.rushing_yards ?? 0) + (f.receiving_yards ?? 0)),
            total_tds: f.total_tds ?? actualTotalTds,
            anytime_td: (f.rushing_tds ?? 0) + (f.receiving_tds ?? 0) > 0 ? 1 : 0,
            total_td: actualTotalTds > 0 ? 1 : 0,
            multi_td: actualTotalTds >= 2 ? 1 : 0,
            pass_td: (f.passing_tds ?? 0) > 0 ? 1 : 0,
            rush_td: (f.rushing_tds ?? 0) > 0 ? 1 : 0,
            rec_td: (f.receiving_tds ?? 0) > 0 ? 1 : 0,
            interception: (f.interceptions ?? 0) > 0 ? 1 : 0
          }
        });

        // Record actuals only when the player had real involvement that week,
        // so the baseline is an average over games he actually featured in
        // rather than being dragged to zero by inactive weeks.
        const record = (key, value, involved) => {
          if (!involved) return;
          const arr = history[key].get(actual.player_id) ?? [];
          arr.push(value ?? 0);
          history[key].set(actual.player_id, arr);
        };
        record('pass_yds', f.passing_yards, (f.pass_attempts ?? 0) > 10);
        record('rush_yds', f.rushing_yards, (f.carries ?? 0) >= 1);
        record('rec_yds', f.receiving_yards, (f.targets ?? 0) >= 1);
        record('receptions', f.receptions, (f.targets ?? 0) >= 1);
      }
    }
  }
  const result = { seasons, eligible, projected, rows: replayRows };
  if (useCache) replayCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

const POINT_METRIC_KEYS = [
  'pass_yds', 'rush_yds', 'rec_yds', 'receptions',
  'pass_attempts', 'carries', 'targets',
  'passing_tds', 'rushing_tds', 'receiving_tds', 'interceptions',
  'total_touches', 'total_yards', 'total_tds',
  'yards_per_attempt', 'yards_per_carry', 'yards_per_target', 'yards_per_reception'
];
const PROBABILITY_METRIC_KEYS = ['anytime_td', 'total_td', 'multi_td', 'pass_td', 'rush_td', 'rec_td', 'interception'];

/**
 * The replay grades RAW simulated probabilities. Production does not ship
 * those: `propBoard` and the pick generator both route anytime-TD through
 * `calibrateAnytimeTd`, which applies whichever calibration head is active.
 * So these probability metrics describe the pre-calibration model, and a
 * "TD calibration is red" reading off them is grading something that never
 * reaches a user.
 *
 * The audit deliberately does NOT apply the active calibrator instead: it is
 * fit through 2025, so applying it to a 2022-2025 replay would leak the
 * outcome seasons into their own grade — exactly the look-ahead the rest of
 * this pipeline exists to prevent. Making the calibrated path measurable
 * honestly needs a walk-forward calibrator (fit per-season on prior seasons
 * only), which is a real piece of work, not a flag flip.
 *
 * Reported rather than silently resolved in either direction.
 */
function probabilityCalibrationStatus() {
  const active = activeTdCalibration();
  return {
    graded: 'raw',
    production_applies_calibration: true,
    active_calibrator: active
      ? { id: active.id, candidate_id: active.candidate_id, train_through: active.train_through }
      : null,
    why_not_applied_here: active
      ? `active calibrator is fit through ${active.train_through}; applying it to a replay of those same seasons would leak outcomes into their own grade`
      : 'no calibrator is currently active, so production and this replay agree',
    resolution: 'a per-season walk-forward calibrator would let the shipped path be graded without leakage'
  };
}

export function propAccuracy(seasons, { reconciliationStrength = 0, useCache = true } = {}) {
  const normalizedSeasons = [...new Set(seasons.map(Number))].sort((a, b) => a - b);
  const cacheKey = `${normalizedSeasons.join(',')}|reconcile=${reconciliationStrength}`;
  const cached = accuracyCache.get(cacheKey);
  if (useCache && cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value;
  const replay = propReplayRows(normalizedSeasons, { reconciliationStrength, useCache });
  const metric = () => ({ n: 0, abs: 0, sq: 0, signed: 0 });
  const metricSet = () => Object.fromEntries(POINT_METRIC_KEYS.map(k => [k, metric()]));
  const stats = metricSet(), marketStats = metricSet();
  const tdSet = () => ({ n: 0, brier: 0, logloss: 0,
    buckets: Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, actual: 0 })) });
  const probSet = () => Object.fromEntries(PROBABILITY_METRIC_KEYS.map(k => [k, tdSet()]));
  const td = probSet(), marketTd = probSet();
  const add = (set, key, pred, actual) => {
    if (!Number.isFinite(pred) || !Number.isFinite(actual)) return;
    const e = pred - actual, s = set[key];
    s.n++; s.abs += Math.abs(e); s.sq += e * e; s.signed += e;
  };
  const addTd = (set, key, prob, y) => {
    if (!Number.isFinite(prob) || !Number.isFinite(y)) return;
    const s = set[key];
    s.n++; s.brier += (prob - y) ** 2;
    s.logloss += -(y * Math.log(prob) + (1 - y) * Math.log(1 - prob));
    const b = s.buckets[Math.min(9, Math.floor(prob * 10))];
    b.n++; b.predicted += prob; b.actual += y;
  };
  const rate = (numer, denom) => (Number.isFinite(numer) && denom > 0.5 ? numer / denom : null);
  for (const r of replay.rows) {
    const p = r.broad, m = r.market, f = r.actual, eligibility = r.eligibility;
    const passOk = p.volume.attempts > 2, rushOk = p.volume.carries > 0.5, recOk = p.volume.targets > 0.5;

    if (passOk) {
      add(stats, 'pass_yds', p.pass_yds, f.pass_yds);
      add(stats, 'pass_attempts', p.pass_attempts, f.pass_attempts);
      add(stats, 'passing_tds', p.passing_tds, f.passing_tds);
      add(stats, 'interceptions', p.interceptions, f.interceptions);
      add(stats, 'yards_per_attempt', rate(p.pass_yds, p.pass_attempts), rate(f.pass_yds, f.pass_attempts));
      addTd(td, 'pass_td', p.pass_td_prob, f.pass_td);
      addTd(td, 'interception', p.interception_prob, f.interception);
      if (eligibility.markets.player_pass_yds) {
        add(marketStats, 'pass_yds', m.pass_yds, f.pass_yds);
        add(marketStats, 'pass_attempts', m.pass_attempts, f.pass_attempts);
        add(marketStats, 'passing_tds', m.passing_tds, f.passing_tds);
        add(marketStats, 'interceptions', m.interceptions, f.interceptions);
        add(marketStats, 'yards_per_attempt', rate(m.pass_yds, m.pass_attempts), rate(f.pass_yds, f.pass_attempts));
        addTd(marketTd, 'pass_td', m.pass_td_prob, f.pass_td);
        addTd(marketTd, 'interception', m.interception_prob, f.interception);
      }
    }
    if (rushOk) {
      add(stats, 'rush_yds', p.rush_yds, f.rush_yds);
      add(stats, 'carries', p.carries, f.carries);
      add(stats, 'rushing_tds', p.rushing_tds, f.rushing_tds);
      add(stats, 'yards_per_carry', rate(p.rush_yds, p.carries), rate(f.rush_yds, f.carries));
      addTd(td, 'rush_td', p.rush_td_prob, f.rush_td);
      if (eligibility.markets.player_rush_yds) {
        add(marketStats, 'rush_yds', m.rush_yds, f.rush_yds);
        add(marketStats, 'carries', m.carries, f.carries);
        add(marketStats, 'rushing_tds', m.rushing_tds, f.rushing_tds);
        add(marketStats, 'yards_per_carry', rate(m.rush_yds, m.carries), rate(f.rush_yds, f.carries));
        addTd(marketTd, 'rush_td', m.rush_td_prob, f.rush_td);
      }
    }
    const recMarketOk = eligibility.markets.player_reception_yds || eligibility.markets.player_receptions;
    if (recOk) {
      add(stats, 'rec_yds', p.rec_yds, f.rec_yds);
      add(stats, 'receptions', p.receptions, f.receptions);
      add(stats, 'targets', p.targets, f.targets);
      add(stats, 'receiving_tds', p.receiving_tds, f.receiving_tds);
      add(stats, 'yards_per_target', rate(p.rec_yds, p.targets), rate(f.rec_yds, f.targets));
      add(stats, 'yards_per_reception', rate(p.rec_yds, p.receptions), rate(f.rec_yds, f.receptions));
      addTd(td, 'rec_td', p.rec_td_prob, f.rec_td);
      if (eligibility.markets.player_reception_yds) {
        add(marketStats, 'rec_yds', m.rec_yds, f.rec_yds);
        add(marketStats, 'yards_per_target', rate(m.rec_yds, m.targets), rate(f.rec_yds, f.targets));
        add(marketStats, 'yards_per_reception', rate(m.rec_yds, m.receptions), rate(f.rec_yds, f.receptions));
      }
      if (eligibility.markets.player_receptions) {
        add(marketStats, 'receptions', m.receptions, f.receptions);
        add(marketStats, 'targets', m.targets, f.targets);
      }
      if (recMarketOk) {
        add(marketStats, 'receiving_tds', m.receiving_tds, f.receiving_tds);
        addTd(marketTd, 'rec_td', m.rec_td_prob, f.rec_td);
      }
    }
    const anyMarketOk = eligibility.markets.player_pass_yds || eligibility.markets.player_rush_yds || recMarketOk;
    if (rushOk || recOk) {
      add(stats, 'total_touches', p.total_touches, f.total_touches);
      if ((eligibility.markets.player_rush_yds && rushOk) || (recMarketOk && recOk)) {
        add(marketStats, 'total_touches', m.total_touches, f.total_touches);
      }
    }
    if (passOk || rushOk || recOk) {
      add(stats, 'total_yards', p.total_yards, f.total_yards);
      add(stats, 'total_tds', p.total_tds, f.total_tds);
      addTd(td, 'total_td', p.total_td, f.total_td);
      addTd(td, 'multi_td', p.multi_td, f.multi_td);
      if (anyMarketOk) {
        add(marketStats, 'total_yards', m.total_yards, f.total_yards);
        add(marketStats, 'total_tds', m.total_tds, f.total_tds);
        addTd(marketTd, 'total_td', m.total_td, f.total_td);
        addTd(marketTd, 'multi_td', m.multi_td, f.multi_td);
      }
    }
    addTd(td, 'anytime_td', p.anytime_td, f.anytime_td);
    if (eligibility.markets.player_anytime_td) addTd(marketTd, 'anytime_td', m.anytime_td, f.anytime_td);
  }

  const summarizePoint = set => Object.fromEntries(Object.entries(set).map(([key, s]) => [key, {
    n: s.n,
    mae: s.n ? +(s.abs / s.n).toFixed(3) : null,
    rmse: s.n ? +Math.sqrt(s.sq / s.n).toFixed(3) : null,
    bias: s.n ? +(s.signed / s.n).toFixed(3) : null
  }]));
  /*
   * Brier alone is not comparable across populations with different base
   * rates, and reporting it that way produced a false "red" gate: broad TD
   * Brier 0.1531 vs market-eligible 0.1955 looked like the eligible model was
   * much worse, when the eligible population simply has a higher base rate
   * (28.5% vs 20.5%) and therefore a higher achievable floor. Against each
   * population's own climatology the gap is far smaller (6.2% vs 4.0% skill)
   * — real, but a fraction of what the raw numbers implied.
   *
   * `brier_skill` is 1 - brier/climatology, where climatology is the
   * base-rate-only forecast (p(1-p)). 0 means "no better than knowing the
   * base rate"; negative means actively worse than it.
   */
  const summarizeProbSet = set => Object.fromEntries(Object.entries(set).map(([key, s]) => [key, {
    n: s.n,
    brier: s.n ? +(s.brier / s.n).toFixed(4) : null,
    log_loss: s.n ? +(s.logloss / s.n).toFixed(4) : null,
    base_rate: s.n ? +(s.buckets.reduce((sum, b) => sum + b.actual, 0) / s.n).toFixed(4) : null,
    brier_skill: (() => {
      if (!s.n) return null;
      const base = s.buckets.reduce((sum, b) => sum + b.actual, 0) / s.n;
      const climatology = base * (1 - base);
      return climatology > 0 ? +(1 - (s.brier / s.n) / climatology).toFixed(4) : null;
    })(),
    reliability: s.buckets.map((b, i) => ({
      range: `${i * 10}-${(i + 1) * 10}%`, n: b.n,
      predicted: b.n ? +(b.predicted / b.n).toFixed(3) : null,
      actual: b.n ? +(b.actual / b.n).toFixed(3) : null
    }))
  }]));
  const probResult = summarizeProbSet(td), marketProbResult = summarizeProbSet(marketTd);
  const result = {
    seasons: normalizedSeasons,
    coverage: { eligible: replay.eligible, projected: replay.projected,
      rate: replay.eligible ? +(replay.projected / replay.eligible).toFixed(4) : null },
    point_metrics: summarizePoint(stats),
    touchdown_probability: probResult.anytime_td,
    probability_metrics: probResult,
    market_eligible: {
      point_metrics: summarizePoint(marketStats),
      touchdown_probability: marketProbResult.anytime_td,
      probability_metrics: marketProbResult,
      rule: 'Pregame-only role gate: clear projected QB1 (>=20 attempts and >=3-attempt lead), >=4 carries, >=2 targets, or >=4 combined TD opportunities. No target-week outcome is read.'
    },
    note: 'Strictly walk-forward within each season. Broad-population and pregame market-eligible metrics are both reported so abstention cannot masquerade as accuracy. ' +
      `${POINT_METRIC_KEYS.length} point metrics and ${PROBABILITY_METRIC_KEYS.length} probability markets graded ` +
      '(up from the original 4 point + 1 probability). touchdown_probability/point_metrics kept for backward compatibility; ' +
      'probability_metrics/point_metrics are the full set.',
    probability_calibration: probabilityCalibrationStatus()
  };
  if (useCache) accuracyCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

/**
 * Is the passing-yards model's edge over a trivial baseline real, or noise?
 *
 * The old gate ("<60 MAE") was calibrated against a bad prior model (70.14
 * MAE), not against anything with real skill. Measured directly: the model's
 * 59.3 MAE barely beats a constant "always guess the league mean" (61.1) and
 * barely beats each QB's own season-to-date average (60.5) — a 2-3% edge that
 * clearing "<60" made look like a solid pass.
 *
 * This runs the same paired bootstrap this codebase already uses for the
 * Stage 1 CRPS-vs-noise question (`backtest-significance.js`): resample which
 * player-weeks are in the test set, thousands of times, and check whether the
 * model's improvement over the season-to-date baseline survives a different,
 * similarly-drawn sample. If the 90% interval straddles zero, the model does
 * not have a demonstrated real edge over a trivial baseline, regardless of
 * which one has the lower raw MAE.
 */
const GATE_CONFIG = {
  pass_yds: { market: 'player_pass_yds', eligible: v => v.attempts > 2, unit: 'yds', who: 'QB' },
  rush_yds: { market: 'player_rush_yds', eligible: v => v.carries > 0.5, unit: 'yds', who: 'rusher' },
  rec_yds: { market: 'player_reception_yds', eligible: v => v.targets > 0.5, unit: 'yds', who: 'receiver' },
  receptions: { market: 'player_receptions', eligible: v => v.targets > 0.5, unit: 'rec', who: 'receiver' }
};

export function baselineGateTest(metricKey, seasons, { reconciliationStrength = 0, useCache = true } = {}) {
  const cfg = GATE_CONFIG[metricKey];
  if (!cfg) throw new Error(`no baseline gate defined for ${metricKey}`);
  const replay = propReplayRows(seasons, { reconciliationStrength, useCache });
  const modelErr = [], baselineErr = [], groups = [];
  for (const r of replay.rows) {
    if (!cfg.eligible(r.broad.volume)) continue;
    if (!r.eligibility.markets[cfg.market]) continue;
    if (r.baseline[metricKey] == null) continue;
    const act = r.actual[metricKey];
    modelErr.push(Math.abs(r.broad[metricKey] - act));
    baselineErr.push(Math.abs(r.baseline[metricKey] - act));
    // Cluster by the actual game (both teams), not just player — several
    // player-weeks in this array share one real NFL game (weather, game
    // script, pace), so their errors are correlated, not independent draws.
    groups.push(`${r.season}|${r.week}|${[r.team, r.opponent].filter(Boolean).sort().join('-')}`);
  }
  const test = pairedBootstrapDiff(baselineErr, modelErr, { iterations: 2000, seed: 7, groups });
  const modelMae = modelErr.length ? modelErr.reduce((a, b) => a + b, 0) / modelErr.length : null;
  const baselineMae = baselineErr.length ? baselineErr.reduce((a, b) => a + b, 0) / baselineErr.length : null;
  return {
    metric: metricKey,
    seasons: [...new Set(seasons.map(Number))].sort((a, b) => a - b),
    n: modelErr.length,
    model_mae: modelMae != null ? +modelMae.toFixed(3) : null,
    baseline_mae: baselineMae != null ? +baselineMae.toFixed(3) : null,
    baseline: `each ${cfg.who}'s own season-to-date average ${metricKey} (walk-forward, min. 2 prior games with involvement)`,
    bootstrap: test,
    // `test.significant` is true only when the 90% CI on (model - baseline) excludes zero.
    // A negative mean_diff means the model wins; it still needs `significant: true` to count as real.
    gate_passes: test.significant === true && test.mean_diff < 0,
    verdict: test.error
      ? `not enough paired data: ${test.error}`
      : (test.significant
          ? (test.mean_diff < 0
              ? `real edge: model beats season-to-date average by ${(-test.mean_diff).toFixed(2)} ${cfg.unit} MAE, CI excludes zero`
              : `real, but backwards: model is WORSE than season-to-date average by ${test.mean_diff.toFixed(2)} ${cfg.unit} MAE`)
          : `not distinguishable from noise: 90% CI on the difference is [${test.ci90?.[0]}, ${test.ci90?.[1]}], straddles zero`)
  };
}

/** Back-compat wrapper: the passing-yards gate, which existed before the others. */
export function passingYardsGateTest(seasons, opts = {}) {
  return baselineGateTest('pass_yds', seasons, opts);
}

/** All four prop gates at once. */
export function allBaselineGates(seasons, opts = {}) {
  return Object.fromEntries(Object.keys(GATE_CONFIG).map(k => [k, baselineGateTest(k, seasons, opts)]));
}

function propSamples(events) {
  const out = { pass_yds: [], rush_yds: [], rec_yds: [], receptions: [], any_td: [] };
  for (const e of events) {
    out.pass_yds.push(e.passYd); out.rush_yds.push(e.rushYd); out.rec_yds.push(e.recYd);
    out.receptions.push(e.rec); out.any_td.push(anytimeTdHit(e));
  }
  return out;
}

/** Sportsbook anytime-TD markets exclude passing touchdowns. */
export const anytimeTdHit = event => (event?.rushTd ?? 0) + (event?.recTd ?? 0) > 0 ? 1 : 0;

const MARKET_STAT = {
  player_pass_yds: 'pass_yds', player_rush_yds: 'rush_yds',
  player_reception_yds: 'rec_yds', player_receptions: 'receptions',
  player_anytime_td: 'any_td'
};
export const MARKET_LABEL = {
  player_pass_yds: 'Passing Yards', player_rush_yds: 'Rushing Yards',
  player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions',
  player_anytime_td: 'Anytime TD'
};

const pOver = (samples, line) => mean(samples.map(v => (v > line ? 1 : 0)));

/* -------------------------------------------------------------- odds math */

const americanToProb = o => (o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
/** No-vig fair probability, via Shin's method (see nfl-devig.js). */
function noVig(a, b) {
  if (a == null || b == null) return null;
  return shinNoVig(a, b);
}

/* ------------------------------------------------------------------ board */

/** Every projectable player for a week, with distribution percentiles. */
export function projectWeek(season, week, { minVolume = 2 } = {}) {
  const engine = buildPlayerWeekEngine({ season, week });
  const out = [];
  const teamSamples = new Map();
  for (const team of new Set([...engine.values()].map(p => p.team).filter(Boolean))) {
    const gs = gameScriptFor(team, season, week);
    const mult = gs?.line ? { pass: gs.pass_mult, rush: gs.rush_mult } : 1;
    let seed = 2166136261;
    for (const ch of `${season}|${week}|${team}`) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
    teamSamples.set(team, sampleTeamWeekEvents(engine, team, { runs: 3000, mult, seed: seed >>> 0 }));
  }
  for (const projection of engine.values()) {
    const p = propView(projection, season, week);
    if (!p) continue;
    const eligibility = playerPropEligibility(engine, projection);
    if (!eligibility.eligible) continue;
    const vol = p.volume.targets + p.volume.carries + p.volume.attempts;
    if (vol < minVolume) continue;
    const events = teamSamples.get(projection.team)?.get(projection.player_id);
    if (!events?.length) continue;
    const sims = propSamples(events);
    out.push({
      player_id: p.player_id, espn_id: projection.espn_id, sleeper_id: projection.sleeper_id,
      name: p.name, team: p.team, position: p.position,
      opponent: p.opponent, game_script: p.game_script,
      volume: p.volume, eligibility, engine_version: p.engine_version, cutoff: p.cutoff,
      signal_quality: playerSignalTrace({ projection, eligibility,
        gameScript: p.game_script, eventState: p }),
      news_context: projection.player_week_engine?.news_context ?? null,
      projection: {
        pass_yds: r3(mean(sims.pass_yds)), rush_yds: r3(mean(sims.rush_yds)),
        rec_yds: r3(mean(sims.rec_yds)), receptions: r3(mean(sims.receptions)),
        any_td_prob_raw: r3(mean(sims.any_td)),
        any_td_prob: r3(calibrateAnytimeTd(mean(sims.any_td), { position: p.position }))
      },
      percentiles: {
        rec_yds: [10, 50, 90].map(q => r3(quantile(sims.rec_yds, q / 100))),
        rush_yds: [10, 50, 90].map(q => r3(quantile(sims.rush_yds, q / 100))),
        pass_yds: [10, 50, 90].map(q => r3(quantile(sims.pass_yds, q / 100)))
      },
      _sims: sims
    });
  }
  return out;
}

/**
 * Prop board: model probability for each offered line, with the market edge
 * filled in when a key is configured. `fetchMarket` is opt-in so simply loading
 * the page never spends credits.
 */
export async function propBoard(season, week, {
  fetchMarket = false, limit = 60,
  maxEvents = 4, markets = PROP_MARKETS
} = {}) {
  const projections = projectWeek(season, week);
  const byName = new Map();
  for (const p of projections) if (p.name) byName.set(normalizeName(p.name), p);

  let market = [];
  let creditsSpent = 0;
  // The Odds API bills one credit per market per event, so a full 16-game slate
  // across five markets is 80 credits — most of a free month in one click.
  // Fetching is capped and the cost is reported rather than discovered later.
  const estimate = maxEvents * markets.length;
  let marketStatus = hasKey()
    ? (fetchMarket ? 'fetching' : `not requested — refreshing costs about ${estimate} credits (${maxEvents} games x ${markets.length} markets)`)
    : 'no ODDS_API_KEY configured — model-only';

  if (fetchMarket && hasKey()) {
    try {
      const capturedAt = new Date().toISOString();
      const evs = await events();
      const all = (evs ?? []).filter(e => withinWeek(e.commence_time, season, week));
      // Earliest kickoffs first, so a capped fetch covers the games closest to
      // locking rather than an arbitrary slice.
      const wk = all.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time)).slice(0, maxEvents);
      for (const e of wk) {
        const before = market.length;
        const payload = await playerProps(e.id, { markets });
        if (payload) {
          const quotes = flattenProps(payload);
          market.push(...quotes);
          persistPropQuotes(quotes, capturedAt);
        }
        if (market.length !== before) creditsSpent += markets.length;
      }
      marketStatus = market.length
        ? `${market.length} priced props from ${wk.length} of ${all.length} games (~${creditsSpent} credits used; cached 6h)`
        : `no player props posted yet for week ${week} — books post these closer to kickoff, and no credits were charged`;
    } catch (e) {
      marketStatus = `odds fetch failed: ${e.message}`;
    }
  }

  // Pair Over/Under quotes so the vig can actually be removed.
  const pairs = new Map();
  for (const m of market) {
    const k = [m.market, normalizeName(m.player), m.line].join('|');
    const e = pairs.get(k) ?? { ...m, over: null, under: null };
    if (/^over$/i.test(m.side)) e.over = m.american_price;
    else if (/^under$/i.test(m.side)) e.under = m.american_price;
    else e.over = m.american_price; // anytime TD is one-sided
    pairs.set(k, e);
  }

  const board = [];
  for (const [, m] of pairs) {
    const proj = byName.get(normalizeName(m.player));
    if (!proj) continue;
    const stat = MARKET_STAT[m.market];
    if (!stat) continue;
    const line = m.line ?? 0.5;
    const rawModelP = pOver(proj._sims[stat], line);
    const modelP = m.market === 'player_anytime_td'
      ? calibrateAnytimeTd(rawModelP, { position: proj.position }) : rawModelP;
    const marketP = m.market === 'player_anytime_td'
      ? (m.over != null ? americanToProb(m.over) : null)
      : noVig(m.over, m.under);
    const overIsBetter = marketP == null || modelP >= marketP;
    board.push({
      market: m.market, market_label: MARKET_LABEL[m.market],
      player: m.player, team: proj.team, position: proj.position,
      espn_id: proj.espn_id, sleeper_id: proj.sleeper_id,
      matchup: `${m.away_team} at ${m.home_team}`, line,
      side: m.market === 'player_anytime_td' ? 'Yes' : (overIsBetter ? 'Over' : 'Under'),
      american_price: overIsBetter ? m.over : m.under,
      book: m.book,
      model_probability: r3(overIsBetter ? modelP : 1 - modelP),
      implied_probability: r3(marketP == null ? null : (overIsBetter ? marketP : 1 - marketP)),
      probability_difference: marketP == null ? null : r3(Math.abs(modelP - marketP)),
      projection: r3(mean(proj._sims[stat]))
    });
  }
  board.sort((a, b) => (b.probability_difference ?? -1) - (a.probability_difference ?? -1));

  // Model-only view, always available: the highest-conviction projections even
  // when nothing is priced. Ranked by distance from a coin flip at the median.
  const modelOnly = projections
    .filter(p => p.projection.rec_yds > 20 || p.projection.rush_yds > 20 || p.projection.pass_yds > 100)
    .map(p => ({
      player: p.name, team: p.team, position: p.position, opponent: p.opponent,
      espn_id: p.espn_id, sleeper_id: p.sleeper_id, eligibility: p.eligibility,
      engine_version: p.engine_version, cutoff: p.cutoff,
      pass_yds: p.projection.pass_yds, rush_yds: p.projection.rush_yds,
      rec_yds: p.projection.rec_yds, receptions: p.projection.receptions,
      any_td_prob: p.projection.any_td_prob,
      percentiles: p.percentiles,
      game_script: p.game_script,
      signal_quality: p.signal_quality
    }))
    .sort((a, b) =>
      (b.pass_yds + b.rush_yds + b.rec_yds) - (a.pass_yds + a.rush_yds + a.rec_yds))
    .slice(0, limit);

  return { season, week, engine_version: nflEngineVersionFor(season, week),
    market_status: marketStatus, board: board.slice(0, limit), projections: modelOnly };
}

const normalizeName = n => String(n ?? '')
  .toLowerCase().replace(/[^a-z ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();

/** nflverse weeks run Thursday to Wednesday; good enough to bucket API events. */
function withinWeek(commenceTime, season, week) {
  const g = rows(`SELECT gameday FROM game_lines WHERE season=? AND week=? AND gameday IS NOT NULL LIMIT 1`,
    season, week)[0];
  if (!g?.gameday) return true;
  const anchor = new Date(`${g.gameday}T00:00:00Z`).getTime();
  const t = new Date(commenceTime).getTime();
  return Math.abs(t - anchor) < 5 * 24 * 3600e3;
}

/* -------------------------------------------------------- weekly totals */

/**
 * The five favourite over/unders for a week. Uses the same ratings model the
 * spread picks use, so a game the model thinks is a shootout shows up here for
 * the same reason it moves that game's spread.
 */
export async function topTotals(season, week, n = 5) {
  const { boardFor } = await import('./nfl-market.js');
  const board = boardFor(season, week);
  if (board?.error) return board;
  return board.filter(b => b.market === 'total').slice(0, n).map(b => {
    // A large raw model-vs-market gap is not evidence by itself — the same
    // rule spread already lives under. `nfl-total-calibration.js`'s
    // walk-forward audit (2010-2025, n=4317) found the totals model has no
    // demonstrated out-of-sample edge over the no-vig market, so a null
    // calibrated probability here is the correct, honest answer until a
    // future refit proves otherwise — not a bug to paper over.
    const calibrated = calibratedTotalProbability({ season, marketProbability: b.implied_probability,
      edgePoints: b.edge_points });
    return { ...b, calibrated_probability: calibrated.probability,
      calibration_eligible: calibrated.probability != null };
  });
}

/**
 * Locks in the week's total picks. A pick is still recorded — and gradeable
 * — even when the calibration gate has not been cleared, exactly like
 * spread's auto-picks (PROFITABILITY_PLAN §8): the frozen decision is the
 * audit trail. It simply carries zero stake until `calibration_eligible` is
 * true, so it can never again silently ride a flat 1-unit bet on a model
 * that has not proven it beats the market.
 */
export async function ensureTotalPicks(season, week, n = 5) {
  const existing = rows('SELECT * FROM nfl_total_picks WHERE season=? AND week=? ORDER BY rank', season, week);
  if (existing.length) return existing;
  const picks = await topTotals(season, week, n);
  if (picks?.error || !picks?.length) return [];
  const now = new Date().toISOString();
  const units = Number(process.env.NFL_MODEL_STAKE_UNITS) || 0;
  picks.forEach((b, i) => {
    run(`INSERT INTO nfl_total_picks
        (season, week, rank, home_team, away_team, matchup, side, line, american_price,
         model_probability, implied_probability, probability_difference, model_total, detail,
         calibration_eligible, calibrated_probability, units_staked, selected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(season, week, rank) DO NOTHING`,
      season, week, i + 1, b.home_team, b.away_team, b.matchup, b.side, b.line, b.american_price,
      b.model_probability, b.implied_probability, b.probability_difference,
      Number(String(b.detail).replace(/[^\d.]/g, '')) || null, b.detail,
      b.calibration_eligible ? 1 : 0, b.calibrated_probability,
      b.calibration_eligible ? units : 0, now);
  });
  return rows('SELECT * FROM nfl_total_picks WHERE season=? AND week=? ORDER BY rank', season, week);
}

const americanToDecimal = o => (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));

/** Grades total picks against the real final score. */
export function gradeTotalPicks(season = null, week = null) {
  const where = [], args = [];
  if (season) { where.push('season = ?'); args.push(season); }
  if (week) { where.push('week = ?'); args.push(week); }
  const picks = rows(`SELECT * FROM nfl_total_picks
                      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                      ORDER BY season DESC, week DESC, rank`, ...args);
  return picks.map(p => {
    const g = rows(`SELECT team_score, opp_score FROM game_lines
                    WHERE season=? AND week=? AND team=?`, p.season, p.week, p.home_team)[0];
    // `24 + null` is 24 in JavaScript, so a half-final game would grade against a
    // total that assumes the opponent scored nothing. Require both scores.
    if (!g || g.team_score == null || g.opp_score == null) return { ...p, status: 'Pending', units: 0, actual_total: null };
    const actual = g.team_score + g.opp_score;
    if (actual === p.line) return { ...p, status: 'Push', units: 0, actual_total: actual };
    const wentOver = actual > p.line;
    const won = /^over/i.test(p.side) ? wentOver : !wentOver;
    return {
      ...p, actual_total: actual, status: won ? 'Won' : 'Lost',
      units: won ? p.units_staked * (americanToDecimal(p.american_price) - 1) : -p.units_staked
    };
  });
}

export function totalPicksStanding() {
  const graded = gradeTotalPicks();
  const settled = graded.filter(g => g.status === 'Won' || g.status === 'Lost');
  const wins = settled.filter(g => g.status === 'Won').length;
  return {
    wins, losses: settled.filter(g => g.status === 'Lost').length,
    pushes: graded.filter(g => g.status === 'Push').length,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    units: +graded.reduce((s, g) => s + g.units, 0).toFixed(2),
    weeks_tracked: new Set(graded.map(g => `${g.season}-${g.week}`)).size
  };
}
