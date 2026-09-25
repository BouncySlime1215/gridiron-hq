/**
 * AUTOPSY-01 Monday Autopsy, team-week: was the week lost to lineup decisions or
 * to variance?
 *
 * For every team in a league and every completed ESPN scoring period (a period
 * with `source = 'final'` rows in league_roster_snapshots, the boxscore capture of
 * scripts/collect-roster-snapshots.mjs), three numbers on one basis, ESPN's own
 * pregame projection in the league's own scoring (league_roster_snapshots
 * .projected_points, statSourceId 1), which every team saw when it set a lineup:
 *
 *   actual_points            the starters' actual points (= ESPN's team score)
 *   expected_points          the starters' pregame projections, summed
 *   optimal_expected_points  the best legal lineup from the same roster, by
 *                            pregame projection (bestLineup in trade-engine.js
 *                            for the skill and flex slots; K and D/ST fill only
 *                            their own slots, so they solve independently)
 *
 *   decision_points = expected - optimal_expected   (<= 0: points given up at lineup lock)
 *   luck_points     = actual - expected             (what the games did to that lineup)
 *
 * The split is an identity: actual = optimal_expected + decision + luck.
 * Hindsight (the best lineup by ACTUAL points) is stored for the bench line only;
 * it is not a decision anyone could have made, so it is never in the split.
 *
 * Read by EVAL E7 (server/services/eval/e7.js on #235/#266), which checks that
 * luck averages about 0 across weeks: a luck line that runs one way is a biased
 * projection, not luck.
 *
 * Default off. GRIDIRON_WEEKLY_AUTOPSY=1 is the ship switch; preview mode
 * (preview-mode.js) turns it on locally and marks every row it writes preview = 1.
 */
import { db, rows, row } from '../db/index.js';
import { bestLineup, FLEX_ELIGIBLE } from './trade-engine.js';
import { previewUnconfirmed } from './preview-mode.js';

export const AUTOPSY_ENV = 'GRIDIRON_WEEKLY_AUTOPSY';
export const AUTOPSY_OFF_REASON =
  'Monday Autopsy (team-week luck vs decision) is default-off until E7 has graded four 2026 weeks';
/** The league the producer runs for first (leagues.id). */
export const AUTOPSY_DEFAULT_LEAGUE = 4;
export const PROJECTION_BASIS = 'espn_pregame';

/** ESPN lineupSlotId -> the slot name bestLineup understands (K and DEF solved here). */
export const SLOT_BY_ID = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DEF', 17: 'K',
  23: 'FLEX', 7: 'OP', 3: 'WRRB_FLEX', 5: 'REC_FLEX'
};
const BENCH_SLOT = 20, IR_SLOT = 21;
/** ESPN defaultPositionId -> position. ESPN's own id decides slot eligibility. */
const ESPN_POSITION = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const OWN_SLOT_ONLY = ['K', 'DEF'];

const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** On when the site flag is '1', or (marked preview) when preview mode is on. */
export function autopsyEnabled() {
  if (process.env[AUTOPSY_ENV] === '1') return { on: true, preview: false };
  if (process.env[AUTOPSY_ENV] === '0') return { on: false, preview: false };
  return previewUnconfirmed() ? { on: true, preview: true } : { on: false, preview: false };
}

function positionOf(r) {
  const pos = ESPN_POSITION[r.espn_position_id] ?? r.position ?? null;
  return pos === 'D/ST' || pos === 'DST' ? 'DEF' : pos;
}

/**
 * The league's starting slots as bestLineup names, from ESPN's lineupSlotCounts in
 * the stored payload. Null when the payload has none, so the caller falls back.
 * `unknown` lists slot ids this module cannot solve.
 */
export function slotsFromPayload(payload) {
  let counts;
  try { counts = JSON.parse(payload ?? 'null')?.settings?.rosterSettings?.lineupSlotCounts; }
  catch (e) { return { slots: null, unknown: [], error: `league payload is not JSON: ${e.message}` }; }
  if (!counts || typeof counts !== 'object') return { slots: null, unknown: [] };
  const slots = [], unknown = [];
  for (const [id, n] of Object.entries(counts)) {
    const k = Number(id);
    if (!n || k === BENCH_SLOT || k === IR_SLOT) continue;
    if (SLOT_BY_ID[k]) for (let i = 0; i < n; i++) slots.push(SLOT_BY_ID[k]);
    else unknown.push(k);
  }
  return { slots, unknown };
}

/** Fallback: the most of each starting slot any team used that week. */
export function slotsFromStarters(teamRows) {
  const max = new Map(), unknown = new Set();
  for (const players of teamRows.values()) {
    const c = new Map();
    for (const p of players) {
      if (!p.is_starter) continue;
      c.set(p.lineup_slot_id, (c.get(p.lineup_slot_id) ?? 0) + 1);
    }
    for (const [id, n] of c) max.set(id, Math.max(max.get(id) ?? 0, n));
  }
  const slots = [];
  for (const [id, n] of [...max].sort((a, b) => a[0] - b[0])) {
    if (SLOT_BY_ID[id]) for (let i = 0; i < n; i++) slots.push(SLOT_BY_ID[id]);
    else unknown.add(id);
  }
  return { slots, unknown: [...unknown] };
}

/** Best lineup total on `key` over the given slots: bestLineup for skill + flex, K/DEF by their own slot. */
export function optimalLineup(players, slots, key) {
  const skillSlots = slots.filter(s => SKILL.has(s) || FLEX_ELIGIBLE[s]);
  const skill = bestLineup(players.filter(p => SKILL.has(p.position)), skillSlots, key);
  let points = skill.slots.reduce((s, f) => s + (f.player?.[key] ?? 0), 0);
  const picked = skill.slots.map(f => f.player?.id).filter(id => id != null);
  for (const pos of OWN_SLOT_ONLY) {
    const n = slots.filter(s => s === pos).length;
    const best = players.filter(p => p.position === pos).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, n);
    points += best.reduce((s, p) => s + (p[key] ?? 0), 0);
    picked.push(...best.map(p => p.id));
  }
  return { points, picked };
}

export function autopsyLine({ week, decision, luck, bench }) {
  const pts = v => `${Math.abs(v).toFixed(1)}`;
  const luckWord = luck >= 0 ? `luck added ${pts(luck)}` : `luck cost ${pts(luck)}`;
  const benchPart = bench == null ? '' : `; ${pts(bench)} sat on the bench in hindsight`;
  if (decision == null) return `Week ${week}: ${luckWord}; lineup decisions not graded${benchPart}.`;
  return `Week ${week}: decisions cost ${pts(decision)}, ${luckWord}${benchPart}.`;
}

/**
 * One team-week. `players` are that team's snapshot rows for the period.
 * Returns the stored row (without league/season/timestamps).
 */
export function autopsyTeamWeek({ week, players, slots, unknownSlots = [] }) {
  const starters = players.filter(p => p.is_starter);
  const actual = starters.reduce((s, p) => s + (num(p.actual_points) ?? 0), 0);
  const expected = starters.reduce((s, p) => s + (num(p.projected_points) ?? 0), 0);
  const missing = starters.filter(p => num(p.projected_points) == null).length;
  // Who could have started: everyone on the roster outside the IR slot, plus anyone
  // who actually started (a starter later dropped still scored for this team).
  const pool = players
    .filter(p => p.is_starter || (p.on_roster && p.lineup_slot_id !== IR_SLOT))
    .map(p => ({
      id: p.espn_player_id, position: positionOf(p),
      proj: num(p.projected_points) ?? 0, act: num(p.actual_points) ?? 0
    }));
  const unsolvable = starters.filter(p => !SLOT_BY_ID[p.lineup_slot_id]).map(p => p.lineup_slot_id);
  const noPosition = pool.filter(p => !p.position).length;
  let status = 'ok', optimalExpected = null, optimalActual = null;
  if (unknownSlots.length || unsolvable.length) {
    status = `unsolved: lineup slot ids ${[...new Set([...unknownSlots, ...unsolvable])].join(',')} not modelled`;
  } else if (!slots?.length) {
    status = 'unsolved: no starting slots known for this league';
  } else {
    optimalExpected = optimalLineup(pool, slots, 'proj').points;
    optimalActual = optimalLineup(pool, slots, 'act').points;
    // Started lineup must be feasible, so optimal >= expected. If not, the slot model
    // is wrong for this team-week: keep the numbers, but say so and do not grade it.
    if (optimalExpected < expected - 1e-9) {
      status = `unsolved: best lineup ${r2(optimalExpected)} below started ${r2(expected)} (slot model mismatch)`;
      optimalExpected = null; optimalActual = null;
    } else if (noPosition) {
      status = `ok; ${noPosition} rostered player(s) with no position left out of the best lineup`;
    }
  }
  const decision = optimalExpected == null ? null : expected - optimalExpected;
  const luck = actual - expected;
  const bench = optimalActual == null ? null : Math.max(0, optimalActual - actual);
  return {
    actual_points: r2(actual), expected_points: r2(expected),
    optimal_expected_points: r2(optimalExpected), optimal_actual_points: r2(optimalActual),
    decision_points: r2(decision), luck_points: r2(luck), bench_points_lost: r2(bench),
    starters: starters.length, missing_projections: missing,
    projection_basis: PROJECTION_BASIS, status,
    line: autopsyLine({ week, decision, luck, bench })
  };
}

const COLS = ['league_id', 'season', 'week', 'team_id', 'actual_points', 'expected_points',
  'optimal_expected_points', 'optimal_actual_points', 'decision_points', 'luck_points', 'bench_points_lost',
  'starters', 'missing_projections', 'projection_basis', 'status', 'line', 'detail_json', 'preview', 'computed_at'];

/**
 * Build weekly_autopsy for one league: every completed period, every team.
 * Idempotent: a league-week's rows are replaced together in one transaction.
 * `enabled` overrides the flag (tests); `season` limits the run to one season.
 */
export function runWeeklyAutopsy({ leagueId = AUTOPSY_DEFAULT_LEAGUE, enabled, season = null,
  now = () => new Date().toISOString() } = {}) {
  const flag = enabled === undefined ? autopsyEnabled() : { on: !!enabled, preview: false };
  if (!flag.on) return { ok: true, off: true, reason: AUTOPSY_OFF_REASON, written: 0, weeks: [] };
  const lg = row('SELECT id, payload FROM leagues WHERE id = ?', leagueId);
  if (!lg) return { ok: false, error: `league ${leagueId} not found`, written: 0, weeks: [] };
  const fromPayload = slotsFromPayload(lg.payload);

  const periods = rows(`SELECT DISTINCT season, scoring_period_id AS week FROM league_roster_snapshots
    WHERE league_id = ? AND source = 'final' ${season == null ? '' : 'AND season = ?'}
    ORDER BY season, scoring_period_id`, ...(season == null ? [leagueId] : [leagueId, season]));
  const insert = db.prepare(`INSERT INTO weekly_autopsy (${COLS.join(', ')})
    VALUES (${COLS.map(() => '?').join(', ')})`);
  const out = [];
  let written = 0;
  for (const { season: s, week } of periods) {
    const snap = rows(`SELECT team_id, espn_player_id, position, espn_position_id, lineup_slot_id,
        is_starter, on_roster, projected_points, actual_points
      FROM league_roster_snapshots WHERE league_id = ? AND season = ? AND scoring_period_id = ? AND source = 'final'`,
    leagueId, s, week);
    const byTeam = new Map();
    for (const r of snap) {
      if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []);
      byTeam.get(r.team_id).push(r);
    }
    const slotSrc = fromPayload.slots?.length ? { ...fromPayload, from: 'payload' }
      : { ...slotsFromStarters(byTeam), from: 'starters' };
    const at = now();
    const results = [...byTeam].map(([teamId, players]) => ({
      teamId, r: autopsyTeamWeek({ week, players, slots: slotSrc.slots, unknownSlots: slotSrc.unknown })
    }));
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM weekly_autopsy WHERE league_id = ? AND season = ? AND week = ?').run(leagueId, s, week);
      for (const { teamId, r } of results) {
        const detail = JSON.stringify({ slots: slotSrc.slots, slots_from: slotSrc.from });
        insert.run(leagueId, s, week, teamId, r.actual_points, r.expected_points, r.optimal_expected_points,
          r.optimal_actual_points, r.decision_points, r.luck_points, r.bench_points_lost, r.starters,
          r.missing_projections, r.projection_basis, r.status, r.line, detail, flag.preview ? 1 : 0, at);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    written += results.length;
    out.push({ season: s, week, teams: results.length,
      unsolved: results.filter(x => x.r.status.startsWith('unsolved')).length });
  }
  return { ok: true, off: false, preview: flag.preview, league_id: leagueId, written, weeks: out,
    slots_error: fromPayload.error ?? null };
}
