/**
 * First-party MLB auto-picks.
 *
 * The previous auto-picks came from the proxied board, so when that pipeline
 * stopped publishing the page froze on July 19 forever — and worse, the picks
 * could never be graded, because grading depended on the same dead feed.
 *
 * These are generated from local projections and graded against local box
 * scores. Both halves are self-sufficient, so the page keeps working whether or
 * not anyone else's pipeline is alive.
 *
 * One honest limitation: there is no MLB odds feed wired up, so these cannot be
 * ranked by edge against a market price the way the NFL board is. They are
 * ranked by model conviction — how far the projection sits from a coin flip —
 * and the record below is therefore a test of the projections, not of any
 * claimed edge over a sportsbook.
 */
import { db, rows, run } from '../db/index.js';
import { boardFor } from './mlb-projections.js';
import { mean } from './stats-util.js';
import { latestMlbQuotes, latestMlbSnapshot } from './mlb-pregame.js';
import { appDate } from './date-util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS mlb_first_party_picks (
    pick_date TEXT NOT NULL, rank INTEGER NOT NULL,
    market TEXT NOT NULL, selection TEXT, player_id INTEGER,
    matchup TEXT, game_pk INTEGER,
    side TEXT, line REAL, model_probability REAL, projection REAL,
    selected_at TEXT NOT NULL,
    PRIMARY KEY (pick_date, rank)
  );
  CREATE TABLE IF NOT EXISTS mlb_pick_decisions (
    pick_date TEXT NOT NULL, market TEXT NOT NULL, selection TEXT NOT NULL,
    game_pk INTEGER, side TEXT, line REAL, model_probability REAL,
    eligible INTEGER NOT NULL, abstention_reason TEXT, recorded_at TEXT NOT NULL,
    model_version TEXT NOT NULL, evidence_json TEXT NOT NULL,
    PRIMARY KEY (pick_date,market,selection,side,line,model_version)
  );
`);

for (const [name, type] of [
  ['american_price', 'INTEGER'], ['implied_probability', 'REAL'], ['probability_difference', 'REAL'],
  ['book', 'TEXT'], ['quote_at', 'TEXT'], ['quote_event_id', 'TEXT'], ['model_version', 'TEXT'],
  ['pregame_snapshot_at', 'TEXT'], ['lineup_status', 'TEXT'], ['tracking_mode', 'TEXT']
]) {
  const cols = db.prepare('PRAGMA table_info(mlb_first_party_picks)').all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE mlb_first_party_picks ADD COLUMN ${name} ${type}`);
}

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
/** Distance from a coin flip — the only conviction measure available without prices. */
const conviction = p => Math.abs(p - 0.5);

/**
 * Bounds on what counts as a real pick.
 *
 * Ranking purely by conviction selects trivially true props — "this reliever
 * will not strike out six batters" projects at 96% and would win essentially
 * always, because no sportsbook would ever post that line. Including such picks
 * inflates the win rate while testing nothing.
 *
 * A pick only counts when the projection sits in the band a book would actually
 * price around a standard number. Anything more certain than PLAUSIBLE_MAX is a
 * line that would not exist, and anything under PLAUSIBLE_MIN is a coin flip
 * with no opinion behind it.
 */
const PLAUSIBLE_MIN = 0.54;
const PLAUSIBLE_MAX = 0.78;
/** A starter, not an opener or a long reliever who happened to start. */
const MIN_IP_PER_START = 4.0;
const auditCache = new Map();

/**
 * Builds the day's candidate plays across all three markets, ranked by how
 * confident the model is rather than by edge, since no prices exist to compare.
 */
export function candidatesFor(date) {
  const board = boardFor(date, { limit: 120 });
  if (!board.games?.length) return { date: board.date, candidates: [], note: board.note };

  const out = [];

  for (const g of board.games) {
    if (!g.nrfi) continue;
    const side = g.nrfi.nrfi_probability >= 0.5 ? 'NRFI' : 'YRFI';
    const p = Math.max(g.nrfi.nrfi_probability, g.nrfi.yrfi_probability);
    if (p < PLAUSIBLE_MIN || p > PLAUSIBLE_MAX) continue;
    out.push({
      market: 'nrfi', selection: g.matchup, matchup: g.matchup, game_pk: g.game_pk,
      side, line: 0.5, model_probability: r3(p), projection: null,
      conviction: r3(conviction(p))
    });
  }

  const historical = date < appDate();
  for (const b of historical ? [] : board.batters) {
    // 1.5 total bases is the standard line and the one worth an opinion.
    const p = b.probabilities?.['over_1.5'];
    if (p == null) continue;
    const over = p >= 0.5;
    const sideProb = over ? p : 1 - p;
    if (sideProb < PLAUSIBLE_MIN || sideProb > PLAUSIBLE_MAX) continue;
    out.push({
      market: 'batter_total_bases', selection: b.name, player_id: b.player_id,
      matchup: b.matchup, game_pk: b.game_pk, side: over ? 'Over' : 'Under', line: 1.5,
      model_probability: r3(sideProb), projection: b.mean_tb,
      conviction: r3(conviction(p))
    });
  }

  for (const pit of historical ? [] : board.pitchers) {
    // Openers and long relievers make the strikeout line meaningless — a book
    // only posts 5.5 for someone expected to work into the fifth or beyond.
    if ((pit.ip_per_start ?? 0) < MIN_IP_PER_START) continue;
    const p = pit.probabilities?.['over_5.5'];
    if (p == null) continue;
    const over = p >= 0.5;
    const sideProb = over ? p : 1 - p;
    if (sideProb < PLAUSIBLE_MIN || sideProb > PLAUSIBLE_MAX) continue;
    out.push({
      market: 'pitcher_strikeouts', selection: pit.name, player_id: pit.player_id,
      matchup: pit.matchup, game_pk: pit.game_pk, side: over ? 'Over' : 'Under', line: 5.5,
      model_probability: r3(sideProb), projection: pit.mean_k,
      conviction: r3(conviction(p))
    });
  }

  out.sort((a, b) => b.conviction - a.conviction);
  return { date: board.date, fell_back: board.fell_back ?? null, candidates: out };
}

const normalize = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const implied = o => o == null ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);

function priceForwardCandidates(date, candidates) {
  const quotes = latestMlbQuotes(date);
  const marketKey = { nrfi: 'totals_1st_1_innings', batter_total_bases: 'batter_total_bases', pitcher_strikeouts: 'pitcher_strikeouts' };
  const out = [];
  for (const c of candidates) {
    const snapshot = latestMlbSnapshot(c.game_pk);
    if (!snapshot || snapshot.odds_status !== 'captured') continue;
    if (c.market === 'nrfi' && (snapshot.probable_starters?.length ?? 0) < 2) continue;
    if (c.market === 'batter_total_bases' && !snapshot.lineups?.some(p => p.player_id === c.player_id && p.batting_order)) continue;
    if (c.market === 'pitcher_strikeouts' && !snapshot.probable_starters?.some(p => p.pitcher_id === c.player_id)) continue;
    const desiredSide = c.market === 'nrfi' ? (c.side === 'NRFI' ? 'Under' : 'Over') : c.side;
    const available = quotes.filter(q => q.game_pk === c.game_pk && q.market === marketKey[c.market]
      && normalize(q.side) === normalize(desiredSide) && (c.market === 'nrfi' || normalize(q.selection) === normalize(c.selection))
      && (q.line == null || c.line == null || Number(q.line) === Number(c.line)));
    if (!available.length) continue;
    const best = available.reduce((a, b) => b.price > a.price ? b : a);
    const oppositeSide = desiredSide === 'Over' ? 'Under' : 'Over';
    const opposite = quotes.find(q => q.event_id === best.event_id && q.book === best.book && q.market === best.market
      && normalize(q.selection) === normalize(best.selection) && normalize(q.side) === normalize(oppositeSide)
      && (q.line == null || best.line == null || Number(q.line) === Number(best.line)));
    const pa = implied(best.price), pb = implied(opposite?.price);
    const marketP = pa != null && pb != null && pa + pb > 0 ? pa / (pa + pb) : null;
    if (marketP == null) continue;
    out.push({ ...c, american_price: best.price, implied_probability: r3(marketP),
      probability_difference: r3(c.model_probability - marketP), book: best.book,
      quote_at: best.captured_at, quote_event_id: best.event_id,
      pregame_snapshot_at: snapshot.captured_at, lineup_status: snapshot.lineup_status,
      model_version: 'mlb-projection-v2-cutoff' });
  }
  return out.filter(c => c.probability_difference >= 0.03)
    .sort((a, b) => b.probability_difference - a.probability_difference);
}

function diversifiedTop(candidates, n = 5) {
  const picked = [], perMarket = {};
  for (const c of candidates) {
    const used = perMarket[c.market] ?? 0;
    if (used >= 2) continue;
    picked.push(c); perMarket[c.market] = used + 1;
    if (picked.length >= n) break;
  }
  for (const c of candidates) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.slice(0, n);
}

const decisionKey = c => `${c.market}|${c.selection}|${c.side}|${c.line ?? ''}`;
function recordCandidateDecisions(date, raw, eligible, forward) {
  const accepted = new Set(eligible.map(decisionKey));
  const now = new Date().toISOString();
  for (const c of raw) {
    const snapshot = latestMlbSnapshot(c.game_pk);
    const ok = accepted.has(decisionKey(c));
    const reason = ok ? null : !forward ? 'retrospective_quarantine'
      : !snapshot ? 'missing_pregame_snapshot'
      : snapshot.odds_status !== 'captured' ? 'missing_real_price'
      : snapshot.lineup_status !== 'confirmed' && c.market !== 'pitcher_strikeouts' ? 'lineup_not_confirmed'
      : 'price_edge_below_threshold_or_market_unmatched';
    run(`INSERT INTO mlb_pick_decisions
      (pick_date,market,selection,game_pk,side,line,model_probability,eligible,abstention_reason,
       recorded_at,model_version,evidence_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, date, c.market, c.selection ?? '', c.game_pk ?? null,
      c.side, c.line, c.model_probability, ok ? 1 : 0, reason, now, 'mlb-projection-v2-cutoff',
      JSON.stringify({ snapshot_at: snapshot?.captured_at ?? null, lineup_status: snapshot?.lineup_status ?? null,
        odds_status: snapshot?.odds_status ?? 'missing' }));
  }
}

export function auditCandidateDecisions(date) {
  const { candidates: rawCandidates, date: actualDate } = candidatesFor(date);
  const forward = actualDate >= appDate();
  const eligible = forward ? priceForwardCandidates(actualDate, rawCandidates ?? []) : rawCandidates ?? [];
  recordCandidateDecisions(actualDate, rawCandidates ?? [], eligible, forward);
  return { requested_date: date, slate_date: actualDate, candidates: rawCandidates?.length ?? 0,
    eligible: eligible.length, abstained: Math.max(0, (rawCandidates?.length ?? 0) - eligible.length),
    tracking_mode: forward ? 'forward' : 'retrospective' };
}

/**
 * Locks in the day's five picks. Idempotent per date, so revisiting the page
 * never reshuffles a slate that has already been committed to.
 */
export function ensurePicksFor(date, n = 5) {
  const existing = rows('SELECT * FROM mlb_first_party_picks WHERE pick_date = ? ORDER BY rank', date);
  if (existing.length) return existing;

  const audited = auditCandidateDecisions(date);
  const { candidates: rawCandidates, date: actualDate } = candidatesFor(audited.slate_date);
  const forward = audited.tracking_mode === 'forward';
  const candidates = forward ? priceForwardCandidates(actualDate, rawCandidates ?? []) : rawCandidates;
  if (!candidates?.length) return [];

  // Spread the five across markets rather than letting one dominate — five
  // strikeout unders on the same slate is one correlated bet, not five.
  const picked = diversifiedTop(candidates, n);

  const now = new Date().toISOString();
  picked.slice(0, n).forEach((c, i) => {
    run(`INSERT INTO mlb_first_party_picks
        (pick_date, rank, market, selection, player_id, matchup, game_pk, side, line,
         model_probability, projection, selected_at,american_price,implied_probability,probability_difference,
         book,quote_at,quote_event_id,model_version,pregame_snapshot_at,lineup_status,tracking_mode)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pick_date, rank) DO NOTHING`,
      actualDate, i + 1, c.market, c.selection, c.player_id ?? null, c.matchup ?? null,
      c.game_pk ?? null, c.side, c.line, c.model_probability, c.projection, now,
      c.american_price ?? null,c.implied_probability ?? null,c.probability_difference ?? null,
      c.book ?? null,c.quote_at ?? null,c.quote_event_id ?? null,c.model_version ?? 'mlb-projection-v2-cutoff',
      c.pregame_snapshot_at ?? null,c.lineup_status ?? null,forward ? 'forward' : 'retrospective');
  });
  return rows('SELECT * FROM mlb_first_party_picks WHERE pick_date = ? ORDER BY rank', actualDate);
}

/* ---------------------------------------------------------------- grading */

/**
 * Grades a pick against the local box score.
 *
 * This is what the proxied version could never do: results live in the same
 * database, so a pick settles as soon as the day's games are synced.
 */
function gradePick(p) {
  if (p.market === 'nrfi') {
    const g = rows(`SELECT first_inning_home_runs h, first_inning_away_runs a, yrfi
                    FROM mlb_games WHERE game_pk = ?`, p.game_pk)[0];
    if (!g || g.yrfi == null) return { status: 'Pending', detail: 'Awaiting first-inning result' };
    const noRun = g.yrfi === 0;
    const won = p.side === 'NRFI' ? noRun : !noRun;
    return {
      status: won ? 'Won' : 'Lost',
      detail: noRun ? 'No run in the 1st' : `Run scored in the 1st (${g.a}-${g.h})`
    };
  }

  if (p.market === 'batter_total_bases') {
    const b = rows(`SELECT total_bases FROM mlb_batter_games
                    WHERE player_id = ? AND date = ?`, p.player_id, p.pick_date)[0];
    if (!b) return gameIsFinal(p)
      ? { status: 'Void', detail: 'Player did not appear — excluded from settled record' }
      : { status: 'Pending', detail: 'Awaiting box score' };
    if (b.total_bases === p.line) return { status: 'Push', detail: `Exactly ${b.total_bases} TB` };
    const won = p.side === 'Over' ? b.total_bases > p.line : b.total_bases < p.line;
    return { status: won ? 'Won' : 'Lost', detail: `${b.total_bases} total bases` };
  }

  if (p.market === 'pitcher_strikeouts') {
    const s = rows(`SELECT strikeouts FROM mlb_pitcher_games
                    WHERE player_id = ? AND date = ?`, p.player_id, p.pick_date)[0];
    if (!s) return gameIsFinal(p)
      ? { status: 'Void', detail: 'Pitcher did not start — excluded from settled record' }
      : { status: 'Pending', detail: 'Awaiting box score' };
    if (s.strikeouts === p.line) return { status: 'Push', detail: `Exactly ${s.strikeouts} K` };
    const won = p.side === 'Over' ? s.strikeouts > p.line : s.strikeouts < p.line;
    return { status: won ? 'Won' : 'Lost', detail: `${s.strikeouts} strikeouts` };
  }

  return { status: 'Pending', detail: 'Unknown market' };
}

function gameIsFinal(p) {
  if (p.game_pk != null) {
    const g = rows(`SELECT status FROM mlb_games WHERE game_pk = ?`, p.game_pk)[0];
    if (g) return /final|completed|game over/i.test(String(g.status ?? ''));
  }
  // Player props currently do not persist a game id. A completed game involving
  // the player's team on the pick date is sufficient to distinguish a void from
  // data that has not arrived yet.
  if (p.player_id != null) {
    const table = p.market === 'pitcher_strikeouts' ? 'mlb_pitcher_games' : 'mlb_batter_games';
    const lastTeam = rows(`SELECT team_id FROM ${table}
                           WHERE player_id = ? AND date < ? ORDER BY date DESC LIMIT 1`,
                          p.player_id, p.pick_date)[0]?.team_id;
    if (lastTeam != null) {
      const g = rows(`SELECT status FROM mlb_games
                      WHERE date = ? AND (home_team_id = ? OR away_team_id = ?) LIMIT 1`,
                     p.pick_date, lastTeam, lastTeam)[0];
      return !!g && /final|completed|game over/i.test(String(g.status ?? ''));
    }
  }
  return false;
}

/** Every pick ever made, graded. Economics stay null unless a real quote exists. */
export function allPicks() {
  return rows('SELECT * FROM mlb_first_party_picks ORDER BY pick_date DESC, rank ASC')
    .map(p => {
      const g = gradePick(p);
      const selectedDate = String(p.selected_at ?? '').slice(0, 10);
      const forward = (p.tracking_mode ?? (selectedDate && selectedDate > p.pick_date ? 'retrospective' : 'forward')) === 'forward';
      const priced = forward && p.american_price != null;
      const units = !priced ? null : g.status === 'Won'
        ? (p.american_price > 0 ? p.american_price / 100 : 100 / Math.abs(p.american_price))
        : g.status === 'Lost' ? -1 : 0;
      return {
        ...p, ...g, units: units == null ? null : +units.toFixed(3),
        tracking_mode: forward ? 'forward' : 'retrospective',
        evidence_eligible: forward
          ? Boolean(p.american_price && p.pregame_snapshot_at)
          : p.market === 'nrfi' && p.model_version === 'mlb-projection-v2-cutoff'
      };
    });
}

export function standing(throughDate = null) {
  const graded = allPicks().filter(g => throughDate == null || g.pick_date <= throughDate);
  const eligible = graded.filter(g => g.evidence_eligible);
  const settled = eligible.filter(g => g.status === 'Won' || g.status === 'Lost');
  const wins = settled.filter(g => g.status === 'Won').length;
  const losses = settled.filter(g => g.status === 'Lost').length;
  const pricedSettled = settled.filter(g => g.tracking_mode === 'forward' && g.american_price != null && g.units != null);
  const pricedUnits = pricedSettled.reduce((sum, g) => sum + g.units, 0);
  return {
    wins, losses,
    pushes: graded.filter(g => g.status === 'Push').length,
    voids: graded.filter(g => g.status === 'Void').length,
    pending: graded.filter(g => g.status === 'Pending').length,
    quarantined: graded.filter(g => !g.evidence_eligible).length,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    priced_settled: pricedSettled.length,
    units: pricedSettled.length ? +pricedUnits.toFixed(2) : null,
    roi: pricedSettled.length ? +(pricedUnits / pricedSettled.length).toFixed(4) : null,
    days_tracked: new Set(graded.map(g => g.pick_date)).size,
    by_market: ['nrfi', 'batter_total_bases', 'pitcher_strikeouts'].map(m => {
      const sub = eligible.filter(g => g.market === m);
      const s = sub.filter(g => g.status === 'Won' || g.status === 'Lost');
      const w = s.filter(g => g.status === 'Won').length;
      return {
        market: m, picks: sub.length, wins: w, losses: s.length - w,
        win_rate: s.length ? +(w / s.length).toFixed(4) : null
      };
    }).filter(x => x.picks > 0)
  };
}

/**
 * Chronological, reproducible model audit on prior completed slates. Dates are
 * sampled at a fixed cadence to keep the endpoint responsive; each prediction
 * still uses only information strictly before its slate date.
 */
export function modelAudit(season, throughDate, { lookbackDays = 120, cadenceDays = 7, fromDate = null } = {}) {
  const key = `${season}|${throughDate}|${lookbackDays}|${cadenceDays}|${fromDate ?? ''}`;
  if (auditCache.has(key)) return auditCache.get(key);
  const start = new Date(`${throughDate}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  const lowerBound = fromDate ?? start.toISOString().slice(0, 10);
  const eligible = rows(`SELECT DISTINCT date FROM mlb_games
                         WHERE season=? AND date>=? AND date<? AND yrfi IS NOT NULL ORDER BY date`,
                        season, lowerBound, throughDate).map(x => x.date);
  const sampled = [];
  let last = 0;
  for (const date of eligible) {
    const ms = Date.parse(`${date}T12:00:00Z`);
    if (last && ms - last < cadenceDays * 86400000) continue;
    sampled.push(date); last = ms;
  }

  const graded = [];
  for (const date of sampled) {
    const slate = candidatesFor(date);
    for (const p of diversifiedTop(slate.candidates ?? [], 5)) {
      const result = gradePick({ ...p, pick_date: date });
      if (result.status !== 'Won' && result.status !== 'Lost') continue;
      graded.push({ ...p, date, outcome: result.status === 'Won' ? 1 : 0 });
    }
  }

  const score = list => {
    const n = list.length, wins = list.reduce((s, x) => s + x.outcome, 0);
    if (!n) return { n: 0, wins: 0, win_rate: null, brier: null, log_loss: null, win_rate_95: [null, null], status: 'insufficient' };
    const brier = mean(list.map(x => (x.model_probability - x.outcome) ** 2));
    const logLoss = -mean(list.map(x => x.outcome * Math.log(Math.max(1e-6, x.model_probability))
      + (1 - x.outcome) * Math.log(Math.max(1e-6, 1 - x.model_probability))));
    const phat = wins / n, z = 1.96, den = 1 + z * z / n;
    const center = (phat + z * z / (2 * n)) / den;
    const half = z * Math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n) / den;
    const lo = Math.max(0, center - half), hi = Math.min(1, center + half);
    const reliability = Array.from({ length: 5 }, (_, i) => {
      const bucket = list.filter(x => Math.min(4, Math.floor(x.model_probability * 5)) === i);
      return { range: `${i * 20}-${(i + 1) * 20}%`, n: bucket.length,
        predicted: bucket.length ? r3(mean(bucket.map(x => x.model_probability))) : null,
        actual: bucket.length ? r3(mean(bucket.map(x => x.outcome))) : null };
    });
    const pMean = mean(list.map(x => x.model_probability));
    const yMean = phat;
    const variance = mean(list.map(x => (x.model_probability - pMean) ** 2));
    const calibrationSlope = variance > 0
      ? mean(list.map(x => (x.model_probability - pMean) * (x.outcome - yMean))) / variance : null;
    const calibrationIntercept = calibrationSlope == null ? null : yMean - calibrationSlope * pMean;
    const ece = reliability.reduce((sum, b) => sum + (b.n / n) * Math.abs((b.predicted ?? 0) - (b.actual ?? 0)), 0);
    const calibrated = n >= 500 && brier < 0.25 && calibrationSlope >= 0.85 && calibrationSlope <= 1.15 && ece <= 0.03;
    return {
      n, wins, losses: n - wins, win_rate: r3(phat), brier: r3(brier), log_loss: r3(logLoss),
      win_rate_95: [r3(lo), r3(hi)],
      reliability, calibration_slope: r3(calibrationSlope), calibration_intercept: r3(calibrationIntercept),
      expected_calibration_error: r3(ece), market_brier: null,
      status: n < 30 ? 'insufficient' : calibrated ? 'validated' : 'provisional'
    };
  };
  const byMarket = Object.fromEntries(['nrfi', 'batter_total_bases', 'pitcher_strikeouts']
    .map(m => [m, score(graded.filter(x => x.market === m))]));
  const out = {
    season, from_date: lowerBound, through_date: throughDate, sampled_dates: sampled.length,
    overall: score(graded), by_market: byMarket,
    note: 'Fixed-cadence walk-forward audit of the frozen selection policy. Every slate uses earlier games only. Validation requires 500 samples, Brier below 0.25, calibration slope 0.85–1.15, ECE at most 0.03, and separate real-price market evidence before promotion.'
  };
  auditCache.set(key, out);
  return out;
}

/** Backfills picks for past dates so the record is not empty on day one. */
export function backfill(days = 14, endDate = appDate()) {
  const dates = rows(`SELECT DISTINCT date FROM mlb_games
                      WHERE date <= ? ORDER BY date DESC LIMIT ?`, endDate, days)
    .map(r => r.date).reverse();
  let made = 0;
  for (const d of dates) made += ensurePicksFor(d).length;
  return { dates: dates.length, picks: made };
}
