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
import { playerFeatureVector, teamFeatureVector } from './nfl-features.js';
import { playerWeeks } from './nfl-pbp.js';
import { gameScriptFor } from './gamescript.js';
import { randNegBinomial, randGamma, randBinomial, quantile, mean } from './stats-util.js';
import { hasKey, events, playerProps, flattenProps, PROP_MARKETS } from './odds-api.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_total_picks (
    season INTEGER NOT NULL, week INTEGER NOT NULL, rank INTEGER NOT NULL,
    home_team TEXT, away_team TEXT, matchup TEXT,
    side TEXT, line REAL, american_price INTEGER,
    model_probability REAL, implied_probability REAL, probability_difference REAL,
    model_total REAL, detail TEXT, units_staked REAL DEFAULT 1, selected_at TEXT NOT NULL,
    PRIMARY KEY (season, week, rank)
  );
`);

const SIMS = 8000;
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/* ------------------------------------------------------------- projection */

/**
 * A player's expected volume and efficiency for one upcoming week.
 * Volume comes from recent form weighted toward the last three games, then the
 * market's game script nudges pass and rush opportunity in opposite directions.
 */
function projectPlayer(season, week, playerId) {
  const pv = playerFeatureVector(season, week, playerId);
  if (!pv) return null;
  const f = pv.features;

  // Recent form leads, season average anchors — a three-game sample alone is
  // too noisy to project from, and a season average alone ignores role changes.
  const blend = (recent, seasonAvg) => {
    if (recent == null) return seasonAvg;
    if (seasonAvg == null) return recent;
    return 0.65 * recent + 0.35 * seasonAvg;
  };

  const gs = pv.team ? gameScriptFor(pv.team, season, week) : null;
  const mPass = gs?.line ? gs.pass_mult : 1;
  const mRush = gs?.line ? gs.rush_mult : 1;

  const targets = (blend(f.targets_last3, f.targets) ?? 0) * mPass;
  const carries = (blend(f.carries_last3, f.carries) ?? 0) * mRush;
  const attempts = (f.pass_attempts ?? 0) * mPass;

  return {
    player_id: playerId, name: pv.name, team: pv.team, position: pv.position,
    opponent: gs?.line?.opponent ?? null,
    game_script: gs?.line ? { pass_mult: gs.pass_mult, rush_mult: gs.rush_mult, ...gs.line } : null,
    volume: { targets, carries, attempts },
    eff: {
      ypa: f.yards_per_attempt ?? 7,
      ypc: f.yards_per_carry ?? 4.2,
      catch_rate: f.catch_rate ?? 0.65,
      ypt: f.yards_per_target ?? 7.5,
      pass_td_rate: f.pass_td_rate ?? 0.045,
      rush_td_rate: f.rush_td_rate ?? 0.03,
      rec_td_rate: f.rec_td_rate ?? 0.05
    }
  };
}

/** Monte Carlo of one player's week, returning the stat lines a prop asks about. */
function simulatePlayer(p, sims = SIMS) {
  const out = { pass_yds: [], rush_yds: [], rec_yds: [], receptions: [], any_td: [] };
  const { volume: v, eff: e } = p;
  for (let i = 0; i < sims; i++) {
    let passYd = 0, rushYd = 0, recYd = 0, rec = 0, tds = 0;
    if (v.attempts > 0.5) {
      const att = randNegBinomial(v.attempts, 6);
      passYd = att > 0 ? randGamma(att * 0.9, e.ypa / 0.9) : 0;
      tds += randBinomial(att, Math.min(0.35, e.pass_td_rate));
    }
    if (v.carries > 0.5) {
      const car = randNegBinomial(v.carries, 6);
      rushYd = car > 0 ? randGamma(car * 0.75, e.ypc / 0.75) : 0;
      tds += randBinomial(car, Math.min(0.3, e.rush_td_rate));
    }
    if (v.targets > 0.5) {
      const tgt = randNegBinomial(v.targets, 6);
      rec = randBinomial(tgt, Math.min(0.95, e.catch_rate));
      recYd = rec > 0 ? randGamma(rec * 0.8, (e.ypt / Math.max(0.05, e.catch_rate)) / 0.8) : 0;
      tds += randBinomial(tgt, Math.min(0.35, e.rec_td_rate));
    }
    out.pass_yds.push(passYd); out.rush_yds.push(rushYd); out.rec_yds.push(recYd);
    out.receptions.push(rec); out.any_td.push(tds > 0 ? 1 : 0);
  }
  return out;
}

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
function noVig(a, b) {
  if (a == null || b == null) return null;
  const pa = americanToProb(a), pb = americanToProb(b);
  return pa + pb > 0 ? pa / (pa + pb) : null;
}

/* ------------------------------------------------------------------ board */

/** Every projectable player for a week, with distribution percentiles. */
export function projectWeek(season, week, { minVolume = 2 } = {}) {
  const ids = [...new Set(
    playerWeeks(season).filter(p => p.week < week).map(p => p.player_id)
  )];
  const out = [];
  for (const id of ids) {
    const p = projectPlayer(season, week, id);
    if (!p) continue;
    const vol = p.volume.targets + p.volume.carries + p.volume.attempts;
    if (vol < minVolume) continue;
    const sims = simulatePlayer(p, 3000);
    out.push({
      ...p,
      projection: {
        pass_yds: r3(mean(sims.pass_yds)), rush_yds: r3(mean(sims.rush_yds)),
        rec_yds: r3(mean(sims.rec_yds)), receptions: r3(mean(sims.receptions)),
        any_td_prob: r3(mean(sims.any_td))
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
      const evs = await events();
      const all = (evs ?? []).filter(e => withinWeek(e.commence_time, season, week));
      // Earliest kickoffs first, so a capped fetch covers the games closest to
      // locking rather than an arbitrary slice.
      const wk = all.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time)).slice(0, maxEvents);
      for (const e of wk) {
        const before = market.length;
        const payload = await playerProps(e.id, { markets });
        if (payload) market.push(...flattenProps(payload));
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
    const modelP = pOver(proj._sims[stat], line);
    const marketP = m.market === 'player_anytime_td'
      ? (m.over != null ? americanToProb(m.over) : null)
      : noVig(m.over, m.under);
    const overIsBetter = marketP == null || modelP >= marketP;
    board.push({
      market: m.market, market_label: MARKET_LABEL[m.market],
      player: m.player, team: proj.team, position: proj.position,
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
      pass_yds: p.projection.pass_yds, rush_yds: p.projection.rush_yds,
      rec_yds: p.projection.rec_yds, receptions: p.projection.receptions,
      any_td_prob: p.projection.any_td_prob,
      percentiles: p.percentiles,
      game_script: p.game_script
    }))
    .sort((a, b) =>
      (b.pass_yds + b.rush_yds + b.rec_yds) - (a.pass_yds + a.rush_yds + a.rec_yds))
    .slice(0, limit);

  return { season, week, market_status: marketStatus, board: board.slice(0, limit), projections: modelOnly };
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
  return board.filter(b => b.market === 'total').slice(0, n);
}

/** Locks in the week's five total picks as straight 1-unit bets. */
export async function ensureTotalPicks(season, week, n = 5) {
  const existing = rows('SELECT * FROM nfl_total_picks WHERE season=? AND week=? ORDER BY rank', season, week);
  if (existing.length) return existing;
  const picks = await topTotals(season, week, n);
  if (picks?.error || !picks?.length) return [];
  const now = new Date().toISOString();
  picks.forEach((b, i) => {
    run(`INSERT INTO nfl_total_picks
        (season, week, rank, home_team, away_team, matchup, side, line, american_price,
         model_probability, implied_probability, probability_difference, model_total, detail, units_staked, selected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(season, week, rank) DO NOTHING`,
      season, week, i + 1, b.home_team, b.away_team, b.matchup, b.side, b.line, b.american_price,
      b.model_probability, b.implied_probability, b.probability_difference,
      Number(String(b.detail).replace(/[^\d.]/g, '')) || null, b.detail, now);
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
    if (!g || g.team_score == null) return { ...p, status: 'Pending', units: 0, actual_total: null };
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
