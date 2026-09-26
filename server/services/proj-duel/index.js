/**
 * PROJ-DUEL: ESPN's weekly projection beside our shadow model's (E-XGB, arm A_xgb), per player per
 * week, and who was closer once the week is graded. The one producer of what the "ESPN vs our model"
 * view and Coach's one-line fact show. It reads and never recomputes:
 *
 *   ESPN       the frozen pre-kickoff ESPN PPR projection (espn-weekly-projection-capture.js
 *              #frozenEspnForGrading), the grader's own population
 *   ours       the latest pre-kickoff shadow forecast (exgb-grader.js#latestForecasts), arm A_xgb
 *              (the pre-registered primary arm, docs/tdd/EXGB-PREREG.md)
 *   actual     exgb-grader.js#actualPoints, only once exgb-grader.js#weekFinal says the week is final
 *   scoreboard exgb_weekly_grades (the grader's MAEs per week and position, latest grade of each)
 *
 * Our model is in testing and is not used for any served number: nothing here feeds a lineup, a
 * trade, a range or title odds. $0: no model call.
 */
import { row, rows } from '../../db/index.js';
import { frozenEspnForGrading } from '../espn-weekly-projection-capture.js';
import { latestForecasts, actualPoints, weekFinal } from '../exgb-grader.js';
import { readPlansFile, leagueEntry } from '../coach/brief.js';
import { warRoomPlansPath } from '../warroom-flag.js';
import { explainRows, driversText, happenedText } from './explain.js';

export const DUEL_ARM = 'A_xgb';
export const TESTING_LABEL = 'Our model is in testing and not used for your numbers.';
const BENCH_SLOTS = new Set([20, 21]);
const r1 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const tableIn = name => !!row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

/** Nick's starters this week (app player ids), from the league's synced roster. */
function starterIds(lg) {
  let payload;
  try { payload = typeof lg.payload === 'string' ? JSON.parse(lg.payload) : lg.payload; } catch (e) {
    console.warn(`[proj-duel] league ${lg?.id}: payload unreadable: ${e?.message ?? e}`);
    return new Set();
  }
  const team = (payload?.teams ?? []).find(t => String(t.id) === String(lg.my_team_id));
  const espn = (team?.roster?.entries ?? []).filter(e => !BENCH_SLOTS.has(Number(e.lineupSlotId)))
    .map(e => e.playerPoolEntry?.player?.id).filter(x => x != null).map(String);
  if (!espn.length) return new Set();
  return new Set(rows(`SELECT id FROM players WHERE espn_id IN (${espn.map(() => '?').join(',')})`, ...espn).map(r => Number(r.id)));
}

async function targetIds(leagueId, plansPath) {
  try {
    const entry = leagueEntry(await readPlansFile(plansPath), leagueId);
    return new Set((entry?.targets?.status === 'ok' ? entry.targets.value : []).map(t => Number(t.player)));
  } catch (e) {
    console.warn(`[proj-duel] plans file unreadable: ${e?.message ?? e}`);
    return new Set();
  }
}

/**
 * Weeks won, mean error per side and n, from the grader's rows (latest grade per week and position,
 * arm A_xgb). The verdict stays "Not proven yet" until the pre-registered promotion rule passes
 * (PROJ-DUEL part 2); nothing here can promote the model.
 */
export function duelScoreboard(season) {
  const empty = { weeks: 0, won: 0, lost: 0, tied: 0, n: 0, mae_ours: null, mae_espn: null, verdict: 'not_proven', verdict_text: 'Not proven yet' };
  if (!tableIn('exgb_weekly_grades')) return empty;
  const latest = rows(`SELECT g.* FROM exgb_weekly_grades g
    JOIN (SELECT week, position, MAX(graded_at) AS at FROM exgb_weekly_grades WHERE season = ? AND arm = ? GROUP BY week, position) l
      ON l.week = g.week AND l.position = g.position AND l.at = g.graded_at
    WHERE g.season = ? AND g.arm = ? AND g.n > 0 AND g.mae_model IS NOT NULL AND g.mae_espn IS NOT NULL`, season, DUEL_ARM, season, DUEL_ARM);
  if (!latest.length) return empty;
  const byWeek = new Map();
  for (const g of latest) {
    const w = byWeek.get(g.week) ?? { n: 0, ours: 0, espn: 0 };
    w.n += g.n; w.ours += g.mae_model * g.n; w.espn += g.mae_espn * g.n;
    byWeek.set(g.week, w);
  }
  let won = 0, lost = 0, tied = 0, n = 0, ours = 0, espn = 0;
  for (const w of byWeek.values()) {
    const a = w.ours / w.n, b = w.espn / w.n;
    if (Math.abs(a - b) < 1e-9) tied++; else if (a < b) won++; else lost++;
    n += w.n; ours += w.ours; espn += w.espn;
  }
  return { ...empty, weeks: byWeek.size, won, lost, tied, n, mae_ours: r1(ours / n), mae_espn: r1(espn / n) };
}

/** "ours 2-3 vs ESPN so far" (weeks won-lost), or "no graded weeks yet". */
export const recordText = b => (b.weeks ? `ours ${b.won}-${b.lost}${b.tied ? `-${b.tied}` : ''} vs ESPN so far` : 'no graded weeks yet');

/**
 * One league's duel for one NFL week: rows for every player with both numbers, Nick's starters and
 * his plan's targets pinned first, then the biggest disagreements. After the week is final each row
 * carries the actual and which side was closer.
 */
export async function projDuel(lg, { season, week, now = new Date(), plansPath = warRoomPlansPath() } = {}) {
  const base = { season, week, arm: DUEL_ARM, label: TESTING_LABEL, final: false, rows: [], scoreboard: duelScoreboard(season) };
  if (!tableIn('exgb_shadow_predictions') || !tableIn('espn_weekly_projection_snapshots')) {
    return { ...base, status: 'empty', reason: 'The shadow model has not run on this database yet.' };
  }
  const espn = frozenEspnForGrading(season, week, 'ppr').filter(r => r.player_id != null);
  const forecasts = latestForecasts(season, week);
  const final = weekFinal(season, week, now);
  const actual = final ? actualPoints(season, week) : null;
  const starters = starterIds(lg);
  const targets = await targetIds(lg.id, plansPath);
  const why = explainRows(season, week);
  const names = new Map();
  const out = [];
  for (const e of espn) {
    const ours = forecasts.get(`${DUEL_ARM}:${e.player_id}`);
    if (ours == null) continue;
    const pid = Number(e.player_id);
    if (!names.has(pid)) names.set(pid, row('SELECT name, position FROM players WHERE id = ?', pid));
    const nm = names.get(pid);
    const a = actual ? actual.get(pid)?.pts ?? 0 : null;
    const closer = a == null ? null : Math.abs(a - ours) < Math.abs(a - e.projected_pts) ? 'ours'
      : Math.abs(a - ours) > Math.abs(a - e.projected_pts) ? 'espn' : 'tie';
    const position = e.position ?? nm?.position ?? null;
    // Drivers only when the stored forecast is the one the drivers recomputed (the model did not change).
    const d = why.drivers.get(pid);
    const res = why.residuals.get(pid);
    out.push({ player_id: String(pid), name: nm?.name ?? `Player ${pid}`, position,
      espn: r1(e.projected_pts), ours: r1(ours), gap: r1(ours - e.projected_pts),
      starter: starters.has(pid), target: targets.has(pid), actual: r1(a), closer,
      why: d?.matches ? driversText({ ours, espn: e.projected_pts, contribs: d.contribs, position }) : null,
      happened: res ? happenedText(res, d?.expected ?? {}) : null });
  }
  const pin = r => (r.starter ? 2 : 0) + (r.target ? 1 : 0);
  out.sort((x, y) => (pin(y) - pin(x)) || (Math.abs(y.gap) - Math.abs(x.gap)) || x.name.localeCompare(y.name));
  return { ...base, status: out.length ? 'ok' : 'empty', final, rows: out,
    ...(out.length ? {} : { reason: 'No player has both an ESPN projection and a shadow forecast for this week yet.' }) };
}

/** The one-line fact per player Coach reads (ids for the players asked about). */
export function duelFacts(season, week, playerIds, scoreboard = duelScoreboard(season)) {
  if (!tableIn('exgb_shadow_predictions') || !tableIn('espn_weekly_projection_snapshots')) return [];
  const want = new Set(playerIds.map(Number));
  const forecasts = latestForecasts(season, week);
  const why = explainRows(season, week);
  const rec = recordText(scoreboard);
  return frozenEspnForGrading(season, week, 'ppr').filter(e => want.has(Number(e.player_id)))
    .map(e => ({ e, ours: forecasts.get(`${DUEL_ARM}:${e.player_id}`) })).filter(x => x.ours != null)
    .map(({ e, ours }) => ({ player_id: String(e.player_id), week, espn_projection: r1(e.projected_pts), our_model: r1(ours),
      line: `ESPN ${r1(e.projected_pts)}, our model ${r1(ours)} (shadow; ${rec})`, used_for_numbers: false,
      why: (() => { const d = why.drivers.get(Number(e.player_id)); return d?.matches ? driversText({ ours, espn: e.projected_pts, contribs: d.contribs, position: e.position }) : null; })() }));
}

/** The weeks of `season` with any shadow forecast, newest first. */
export function duelWeeks(season) {
  if (!tableIn('exgb_shadow_predictions')) return [];
  return rows('SELECT DISTINCT week FROM exgb_shadow_predictions WHERE season = ? AND arm = ? ORDER BY week DESC', season, DUEL_ARM).map(r => r.week);
}
