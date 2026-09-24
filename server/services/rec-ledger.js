/**
 * The recommendation ledger (plan item 13, GR-01): every call the app makes is
 * frozen here when it is made, and graded later against what the players
 * actually scored.
 *
 * Table: `rec_ledger` (server/migrations/071_rec_ledger.js).
 * Writers: `record()` below, called through `recordRoute()` by the recommending
 * routes in server/routes/trades.js (/find, /offer, /offer-many, /lineup,
 * /waivers); /find also writes, through `recordConsidered()`, the ideas
 * findTrades' edge test removed (carried on the result under `LOST_IDEAS`).
 * Grader: `gradeDue()`, run by the scheduler
 * job `rec_ledger_grade`. Reader: `ledgerSummary()`, served at
 * GET /api/grades/:leagueId/ledger (server/routes/grades.js).
 *
 * WHAT A GRADE IS. Each row compares the call against the call we would
 * otherwise have made (`baseline_call_json`), in realised fantasy points over
 * the horizon weeks:
 *   - lineup (+1 week): each decided slot's starter against the best benched
 *     player who could have filled it (lineup-brain.js `over`). A slot with no
 *     alternative was not a decision and is not scored.
 *   - trade (+2 and +5 weeks): points of the players received minus points of
 *     the players sent. Baseline: no trade.
 *   - waiver (+2 and +5 weeks, the trade horizons; a guess, GR-02 may move it):
 *     points of the player added minus points of the player dropped.
 * These are raw player points, not lineup points: a received player who sits
 * on the bench still counts. That is a known simplification, stated on every
 * outcome as `basis`.
 *
 * REALISED POINTS COME FROM ONE PRODUCER. `actuals()` in backtest.js, which
 * scores `player_week_usage` (writer nflverse.js:260) with the league's own
 * rules (`scoringFor`, scoring.js:52). `player_gamelog` is not used: fixed PPR,
 * top-250 only, and empty on the local copy. A week counts as played when the
 * league's clock has passed it (`weekIsOver`, via league-week.js
 * leagueCurrentWeek) AND `player_week_usage` holds rows for it; a player with
 * no row in a played week scored 0 (he did not play).
 *
 * A LEDGER WRITE NEVER TAKES DOWN THE PAGE. `record()` returns a state instead
 * of throwing, and logs the error it caught. The recommendation is the product;
 * the ledger is the measurement.
 */
import crypto from 'node:crypto';
import { db, row, rows } from '../db/index.js';
import { actuals } from './backtest.js';
import { scoringFor } from './scoring.js';
import { leagueCurrentWeek } from './league-week.js';

/** Grading horizons in weeks, per kind. `scenario` has no grader yet (GR-02). */
export const HORIZONS = Object.freeze({
  trade: Object.freeze([2, 5]),
  lineup: Object.freeze([1]),
  waiver: Object.freeze([2, 5]),
  scenario: Object.freeze([]),
});
const DISPOSITIONS = new Set(['shown', 'considered_not_shown']);

const BASIS = 'raw player points from player_week_usage, scored by the league\'s own rules '
  + '(backtest.js actuals + scoring.js scoringFor); a player with no row in a played week scored 0';

const tableExists = () =>
  !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'rec_ledger'`);

/** JSON with object keys sorted at every depth, so key order is never a different call. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * sha256 over what identifies a call: league, kind, scoring period and inputs.
 * The prediction is deliberately not part of it: the same package on the same
 * week is the same recommendation even if its projected gain moved.
 */
export function inputsHash(rec) {
  return crypto.createHash('sha256').update(canonical({
    league_id: rec?.league_id ?? null, kind: rec?.kind ?? null,
    season: rec?.season ?? null, week: rec?.week ?? null, inputs: rec?.inputs ?? null,
  })).digest('hex');
}

function validate(rec) {
  if (!rec || typeof rec !== 'object') return { state: 'invalid', reason: 'no recommendation was given' };
  if (!Object.hasOwn(HORIZONS, rec.kind)) {
    return { state: 'invalid', reason: `kind must be one of ${Object.keys(HORIZONS).join(', ')}; got ${rec.kind}` };
  }
  if (!HORIZONS[rec.kind].length) {
    return { state: 'invalid', reason: `kind ${rec.kind} has no grading horizon yet, so a row could never be graded` };
  }
  const disposition = rec.disposition ?? 'shown';
  if (!DISPOSITIONS.has(disposition)) return { state: 'invalid', reason: `unknown disposition ${disposition}` };
  if (!Number.isInteger(Number(rec.league_id))) return { state: 'invalid', reason: 'league_id is required' };
  if (!Number.isInteger(Number(rec.season)) || !(Number(rec.week) >= 1) || rec.week == null || rec.season == null) {
    return { state: 'no_week', reason: 'the call carries no scoring period (season/week), so no horizon can be placed' };
  }
  return null;
}

/**
 * Write one recommendation (or a list) to the ledger: one row per grading
 * horizon, `INSERT OR IGNORE` on (league, kind, disposition, inputs_hash,
 * horizon), so a page refresh adds nothing.
 *
 * @returns {{state:string, inserted:number, skipped:number, invalid:number, reason?:string}}
 */
export function record(recOrList) {
  const list = Array.isArray(recOrList) ? recOrList : [recOrList];
  const out = { state: 'recorded', inserted: 0, skipped: 0, invalid: 0, reason: null };
  if (!tableExists()) {
    return { ...out, state: 'ledger_absent', reason: 'rec_ledger does not exist here; migration 071 has not run' };
  }
  const valid = [];
  let firstProblem = null;
  for (const rec of list) {
    const problem = validate(rec);
    if (problem) { out.invalid++; firstProblem ??= problem; continue; }
    valid.push(rec);
  }
  if (!valid.length && firstProblem) return { ...out, ...firstProblem };

  const madeAt = new Date().toISOString();
  const owned = !db.isTransaction;
  try {
    if (owned) db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare(`INSERT OR IGNORE INTO rec_ledger
      (league_id, kind, disposition, made_at, season, week, inputs_hash, predicted_json,
       baseline_call_json, horizon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const rec of valid) {
      const hash = inputsHash(rec);
      const predicted = JSON.stringify(rec.predicted ?? {});
      const baseline = rec.baseline_call == null ? null : JSON.stringify(rec.baseline_call);
      for (const h of HORIZONS[rec.kind]) {
        const info = insert.run(Number(rec.league_id), rec.kind, rec.disposition ?? 'shown', madeAt,
          Number(rec.season), Number(rec.week), hash, predicted, baseline, h);
        if (Number(info.changes) > 0) out.inserted++; else out.skipped++;
      }
    }
    if (owned) db.exec('COMMIT');
  } catch (e) {
    if (owned && db.isTransaction) db.exec('ROLLBACK');
    console.warn(`[rec-ledger] record failed, recommendation served unrecorded: ${e.message}`);
    return { ...out, state: 'error', inserted: 0, reason: e.message };
  }
  return out;
}

/* ------------------------------------------------------------- from routes */

const playerRef = p => ({ id: p?.id ?? null, name: p?.name ?? null, position: p?.position ?? null,
  value: p?.value ?? null, proj: p?.proj ?? null });
const ids = list => (list ?? []).map(p => p?.id).filter(v => v != null).sort((a, b) => a - b);

function tradeRec(lg, { season, week }, { source, partnerId, give, get, ev, disposition = 'shown', extra = {} }) {
  const giveIds = ids(give), getIds = ids(get);
  if (!giveIds.length || !getIds.length) return null;
  return {
    league_id: lg.id, kind: 'trade', disposition, season, week,
    inputs: { partner_id: partnerId == null ? null : String(partnerId), give: giveIds, get: getIds },
    predicted: { source, partner_id: partnerId == null ? null : String(partnerId),
      give: give.map(playerRef), get: get.map(playerRef),
      ppg_delta: ev?.me?.ppg_delta ?? null, horizon_gain: ev?.horizon?.value ?? null,
      score_signed: ev?.score_signed ?? null, ...extra },
    baseline_call: { call: 'no_trade', keep: giveIds },
  };
}

function periodOf(result) {
  const src = result?.context?.week != null ? result.context : result;
  const season = Number(src?.season), week = Number(src?.week);
  return Number.isInteger(season) && week >= 1 ? { season, week } : null;
}

/** Build the ledger rows one route's response implies. Pure; never mutates the response. */
export function recsFromRoute(route, lg, result) {
  if (!lg?.id || !result || result.error) return [];
  const period = periodOf(result);
  if (!period) return [];
  switch (route) {
    case 'find':
      return (result.deals ?? []).map(d => tradeRec(lg, period,
        { source: 'find', partnerId: d.partner_id, give: d.i_give, get: d.i_get, ev: d })).filter(Boolean);
    case 'offer':
      return (result.offers ?? []).map(o => tradeRec(lg, period,
        { source: 'offer', partnerId: result.owner_id, give: o.i_give, get: [result.target], ev: o }))
        .filter(Boolean);
    case 'offer-many':
      return (result.ladders ?? []).filter(l => !l.error).flatMap(l => (l.offers ?? []).map(o =>
        tradeRec(lg, period, { source: 'offer-many', partnerId: l.owner_id, give: o.i_give, get: l.targets, ev: o })))
        .filter(Boolean);
    case 'lineup': {
      const calls = (result.lineup ?? []).filter(c => c?.player?.id != null);
      if (!calls.length) return [];
      return [{
        league_id: lg.id, kind: 'lineup', ...period,
        inputs: { starters: calls.map(c => [c.slot, c.player.id]), objective: result.objective ?? null },
        predicted: { source: 'lineup', objective: result.objective ?? null,
          starters: calls.map(c => ({ slot: c.slot, id: c.player.id, week_points: c.player.week_points ?? null })) },
        baseline_call: { call: 'bench_alternative',
          alternatives: calls.filter(c => c.over?.id != null)
            .map(c => ({ slot: c.slot, id: c.over.id, week_points: c.over.week_points ?? null })) },
      }];
    }
    case 'waivers': {
      // An immediate claim cuts `drop_candidate`; a stash (rest-of-season play)
      // cuts `ros_drop_candidate` (waiver-wire.js board.push). Both are calls.
      const claim = (b, type, drop) => ({
        league_id: lg.id, kind: 'waiver', ...period,
        inputs: { add: b.player_id, drop: drop?.player_id ?? null, type },
        predicted: { source: 'waivers', claim_type: type,
          add: { id: b.player_id, name: b.player ?? null, projected_ppg: b.projected_ppg ?? null,
            ros_ppg: b.ros_ppg ?? null },
          drop: drop?.player_id == null ? null : { id: drop.player_id, name: drop.player ?? null },
          upgrade: type === 'immediate' ? (b.upgrade ?? null) : (b.ros_upgrade ?? null) },
        baseline_call: { call: 'no_move', keep: drop?.player_id == null ? [] : [drop.player_id] },
      });
      return [
        ...(result.immediate ?? []).filter(b => b?.player_id != null)
          .map(b => claim(b, 'immediate', b.drop_candidate)),
        ...(result.stashes ?? []).filter(b => b?.player_id != null)
          .map(b => claim(b, 'stash', b.ros_drop_candidate)),
      ];
    }
    default:
      return [];
  }
}

/** The one call each recommending route makes. */
export function recordRoute(route, lg, result) {
  // /find also writes the ideas its edge test removed (C-08), from the same
  // result object, so shown and considered rows come from one search context.
  const considered = route === 'find' && Array.isArray(result?.[LOST_IDEAS]) && !result.error
    ? recordConsidered(lg, result[LOST_IDEAS], periodOf(result)) : null;
  const recs = recsFromRoute(route, lg, result);
  if (!recs.length) {
    const none = { state: 'no_recommendation', inserted: 0, skipped: 0, invalid: 0 };
    return considered ? { ...none, considered } : none;
  }
  const out = record(recs);
  return considered ? { ...out, considered } : out;
}

/**
 * Where findTrades (trade-engine.js findTradesUncached) hangs the ideas its edge
 * test removed. A Symbol, so no response JSON changes; set only on a search of
 * the real rosters (never with teamsOverride / assetsOverride).
 */
export const LOST_IDEAS = Symbol('rec_ledger.lost_ideas');

/**
 * The ideas findTrades' edge test removed (C-08), as considered-not-shown rows.
 * Called only from recordRoute('find'). `week` is { season, week }. A repeat
 * call for the same ideas inserts nothing (INSERT OR IGNORE on inputs_hash).
 */
export function recordConsidered(lg, lostIdeas, week) {
  const period = week?.week != null ? { season: Number(week.season), week: Number(week.week) } : null;
  if (!lg?.id || !period || !lostIdeas?.length) return { state: 'no_recommendation', inserted: 0, skipped: 0, invalid: 0 };
  const recs = lostIdeas.map(d => tradeRec(lg, period, {
    source: 'find:edge_removed', partnerId: d.partner_id, give: d.i_give, get: d.i_get, ev: d,
    disposition: 'considered_not_shown',
    extra: { failed: d.edge?.failed ?? [],
      checks: Object.fromEntries((d.edge?.checks ?? []).map(c => [c.name, c.value])) },
  })).filter(Boolean);
  return recs.length ? record(recs) : { state: 'no_recommendation', inserted: 0, skipped: 0, invalid: 0 };
}

/* ------------------------------------------------------------------ grader */

const r2 = x => +Number(x).toFixed(2);
const weeksFor = (week, h) => Array.from({ length: h }, (_, i) => week + i);

function gradeRow(r, pts) {
  const predicted = JSON.parse(r.predicted_json);
  const baseline = r.baseline_call_json ? JSON.parse(r.baseline_call_json) : null;
  const weeks = weeksFor(r.week, r.horizon);
  const sum = list => r2(list.reduce((s, id) => s + pts(id, weeks), 0));
  if (r.kind === 'trade') {
    const got = sum((predicted.get ?? []).map(p => p.id)), gave = sum((predicted.give ?? []).map(p => p.id));
    return { score: r2(got - gave), outcome: { weeks, called_points: got, baseline_points: gave,
      baseline: 'no_trade', basis: BASIS } };
  }
  if (r.kind === 'waiver') {
    const added = sum([predicted.add?.id].filter(v => v != null));
    const dropped = sum([predicted.drop?.id].filter(v => v != null));
    return { score: r2(added - dropped), outcome: { weeks, called_points: added, baseline_points: dropped,
      baseline: predicted.drop ? 'keep_the_drop' : 'no_drop_named', basis: BASIS } };
  }
  // lineup: each alternative is paired with the starter it was benched behind (same slot).
  const used = new Set();
  const slots = (baseline?.alternatives ?? []).map(alt => {
    const i = (predicted.starters ?? []).findIndex((s, k) => s.slot === alt.slot && !used.has(k));
    if (i < 0) return null;
    used.add(i);
    const starter = predicted.starters[i];
    return { slot: alt.slot, starter: starter.id, alternative: alt.id,
      starter_points: sum([starter.id]), alternative_points: sum([alt.id]) };
  }).filter(Boolean);
  const called = r2(slots.reduce((s, x) => s + x.starter_points, 0));
  const base = r2(slots.reduce((s, x) => s + x.alternative_points, 0));
  return {
    score: slots.length ? r2(called - base) : null,
    outcome: { weeks, called_points: called, baseline_points: base, baseline: 'bench_alternative',
      slots_graded: slots.length,
      slots_won: slots.filter(x => x.starter_points > x.alternative_points).length,
      slots_lost: slots.filter(x => x.starter_points < x.alternative_points).length,
      slots_tied: slots.filter(x => x.starter_points === x.alternative_points).length,
      slots, basis: BASIS },
  };
}

/**
 * Has `week` of `season` finished for this league? A past season is over. In
 * the league's own season the week must be strictly before leagueCurrentWeek
 * (league-week.js:12), the canonical "what week is it" producer. Not
 * leagueLastCompletedWeek (league-week.js:24): it floors at 1, so during week 1
 * it would call week 1 complete.
 */
export function weekIsOver(lg, season, week) {
  const lgSeason = Number(lg?.season);
  if (Number.isInteger(lgSeason) && Number(season) < lgSeason) return true;
  if (Number.isInteger(lgSeason) && Number(season) > lgSeason) return false;
  return leagueCurrentWeek(lg) > Number(week);
}

/**
 * Grade every ungraded row whose horizon weeks have all been played.
 * Idempotent: a graded row is never touched again.
 */
export function gradeDue() {
  const out = { state: 'graded', graded: 0, pending: 0, league_missing: 0, no_grader: 0 };
  if (!tableExists()) return { ...out, state: 'ledger_absent' };
  const due = rows(`SELECT id, league_id, kind, season, week, horizon, predicted_json, baseline_call_json
    FROM rec_ledger WHERE graded_at IS NULL ORDER BY league_id, season, id`);
  const played = new Map();
  const playedWeeks = season => {
    if (!played.has(season)) {
      played.set(season, new Set(rows('SELECT DISTINCT week FROM player_week_usage WHERE season = ?', season)
        .map(x => Number(x.week))));
    }
    return played.get(season);
  };
  const actualsCache = new Map();
  const leagues = new Map();
  const update = db.prepare(`UPDATE rec_ledger SET graded_at = ?, outcome_json = ?, score = ?
    WHERE id = ? AND graded_at IS NULL`);
  for (const r of due) {
    if (!HORIZONS[r.kind]?.length) { out.no_grader++; continue; }
    const weeks = weeksFor(r.week, r.horizon);
    if (!leagues.has(r.league_id)) {
      // Only the columns scoringFor and leagueCurrentWeek read. Never espn_s2 / swid.
      leagues.set(r.league_id, row(`SELECT id, platform, ppr, payload, season, current_week
        FROM leagues WHERE id = ?`, r.league_id) ?? null);
    }
    const lg = leagues.get(r.league_id);
    if (!lg) { out.league_missing++; continue; }
    // A week is played when the league's own clock has moved past it
    // (league-week.js leagueCurrentWeek, ESPN currentMatchupPeriod) AND the
    // usage feed holds rows for it. A usage row alone is not enough: the
    // nflverse writer has no completed-week filter, so a Thursday game would
    // make a week look played, and a graded row is never re-graded.
    if (!weekIsOver(lg, r.season, weeks[weeks.length - 1])) { out.pending++; continue; }
    const have = playedWeeks(r.season);
    if (!weeks.every(w => have.has(w))) { out.pending++; continue; }
    const scoring = scoringFor(lg);
    const key = `${r.season}:${JSON.stringify(scoring)}`;
    if (!actualsCache.has(key)) actualsCache.set(key, actuals(r.season, scoring));
    const act = actualsCache.get(key);
    const pts = (id, ws) => ws.reduce((s, w) => s + (act.get(Number(id))?.weeks.get(w) ?? 0), 0);
    const { score, outcome } = gradeRow(r, pts);
    const info = update.run(new Date().toISOString(), JSON.stringify(outcome), score, r.id);
    if (Number(info.changes) > 0) out.graded++;
  }
  return out;
}

/* ------------------------------------------------------------------ reader */

/** Counts per kind and the graded share, for one league. */
export function ledgerSummary(leagueId) {
  const horizons = Object.fromEntries(Object.entries(HORIZONS).map(([k, v]) => [k, [...v]]));
  if (!tableExists()) return { state: 'table_absent', league_id: leagueId, kinds: null, total: null, horizons };
  const kinds = Object.fromEntries(Object.keys(HORIZONS).map(k =>
    [k, { rows: 0, shown: 0, considered_not_shown: 0, graded: 0, graded_share: null }]));
  for (const g of rows(`SELECT kind, disposition, COUNT(*) AS n,
      SUM(CASE WHEN graded_at IS NOT NULL THEN 1 ELSE 0 END) AS graded
    FROM rec_ledger WHERE league_id = ? GROUP BY kind, disposition`, leagueId)) {
    const k = kinds[g.kind];
    if (!k) continue;
    k.rows += Number(g.n);
    k[g.disposition] += Number(g.n);
    k.graded += Number(g.graded);
  }
  const share = (graded, n) => (n ? +(graded / n).toFixed(4) : null);
  for (const k of Object.values(kinds)) k.graded_share = share(k.graded, k.rows);
  const n = Object.values(kinds).reduce((s, k) => s + k.rows, 0);
  const graded = Object.values(kinds).reduce((s, k) => s + k.graded, 0);
  return { state: n ? 'ok' : 'empty', league_id: leagueId, kinds,
    total: { rows: n, graded, graded_share: share(graded, n) }, horizons };
}
