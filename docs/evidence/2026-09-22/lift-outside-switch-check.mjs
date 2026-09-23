// S-03: where the betting line still reaches a fantasy number outside BETTING_LINE_LIFT
// (the Ceiling tab and the season simulation), on a local copy (not production).
// Written by the S-03 structure skeptic (2026-09-23), committed by the builder so the
// numbers in the TDD section 6 have their command. Writes only to GRIDIRON_DB_PATH (072 if
// missing; promotes fit 7 only when nothing is promoted).
// Usage: GRIDIRON_DB_PATH=<copy> SCHEDULER_DISABLED=1 NFL_SEASON=2026 node docs/evidence/2026-09-22/lift-outside-switch-check.mjs <leagueId>
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const WT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const leagueId = Number(process.argv[2] ?? 1);
const t0 = Date.now();
const lap = label => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

const { db, rows, migrate } = await import(`${WT}/server/db/index.js`);
const m072 = await import(`${WT}/server/migrations/072_fantasy_coordinator_fit_promotion.js`);
migrate(m072.name, () => m072.up(db));
const coord = await import(`${WT}/server/services/fantasy-coordinator.js`);
const out = { db: process.env.GRIDIRON_DB_PATH, label: 'local copy, not production', league: leagueId };
const pre = coord.activeFantasyCoordinatorFit();
out.before_promotion = { ready: pre.ready, reason: pre.reason ?? null, key: coord.servedCoordinatorFitKey() };
if (!pre.ready) {
  coord.promoteFantasyCoordinatorFit(7, { windows: { '2-4': 'on', '5-17': 'on' },
    evidence: 'docs/evidence/2026-09-22/weekly-construction-walk-forward-output.json (skeptic copy)' });
}
out.after_promotion = { key: coord.servedCoordinatorFitKey() };
lap('migrated + promoted');

const te = await import(`${WT}/server/services/trade-engine.js`);
const lb = await import(`${WT}/server/services/lineup-brain.js`);
const wb = await import(`${WT}/server/services/waiver-brain.js`);
const { deriveFormat } = await import(`${WT}/server/services/format.js`);
const { ceilingLineup } = await import(`${WT}/server/services/ceiling-lineup.js`);
const { gameScriptFor } = await import(`${WT}/server/services/gamescript.js`);
const { buildProjections, sampleWeeks } = await import(`${WT}/server/services/projections.js`);
const { gameMultiplier, matchupModel } = await import(`${WT}/server/services/matchups.js`);
const { WEEKLY_ROLE_RECENCY } = await import(`${WT}/server/services/weekly-ensemble.js`);
const { PPR } = await import(`${WT}/server/services/scoring.js`);
const { withRandomSeed } = await import(`${WT}/server/services/stats-util.js`);

// Never select the cookie columns (espn_s2, swid).
const cols = rows("SELECT name FROM pragma_table_info('leagues')").map(c => c.name)
  .filter(c => c !== 'espn_s2' && c !== 'swid');
const lg = rows(`SELECT ${cols.join(', ')} FROM leagues WHERE id = ?`, leagueId)[0];
const ctx = te.tradeWeekContext();
out.week = ctx;
const { formatKey } = deriveFormat(lg);
const assets = te.assetUniverse(lg, formatKey);
lap(`assetUniverse (${assets.size} assets)`);
out.context_week_basis = assets.context?.week_basis ?? null;

// 1. The four "this week" surfaces that read current_week_ppg (S-03's claim).
const teams = te.loadRosters(lg, assets);
const me = teams.find(t => t.roster_id === String(lg.my_team_id)) ?? teams[0];
let checked = 0, startSitVsCard = 0, startSitVsWaiver = 0, liftApplied = 0;
for (const p of [...assets.values()]) {
  if (!Number.isFinite(p.current_week_ppg)) continue;
  checked++;
  const ss = lb.startSitWeekPoints(p, ctx.season, ctx.week).week_points;
  const lift = wb.vegasLift(p, ctx.season, ctx.week);
  const card = +(((p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0) * (lift.applied ? lift.multiplier : 1)).toFixed(2));
  const waiver = +(p.current_week_ppg ?? p.adj_ppg ?? p.ppg ?? 0).toFixed(2);
  if (Math.abs(ss - card) > 0.005) startSitVsCard++;
  if (Math.abs(ss - waiver) > 0.005) startSitVsWaiver++;
  if (lift.applied) liftApplied++;
}
out.four_surfaces = { assets_checked: checked, startsit_ne_card: startSitVsCard,
  startsit_ne_waiver: startSitVsWaiver, vegasLift_applied: liftApplied };

// Known-nonzero control for the lift: the multiplier vegasLift used to apply (gameScriptLift)
// is != 1 for many of the same players; vegasLift itself returns 1.
let gslNotOne = 0, gslN = 0;
for (const p of [...assets.values()]) {
  if (!['QB', 'RB', 'WR', 'TE'].includes(p.position) || !p.team_abbr) continue;
  gslN++;
  if (Math.abs(wb.gameScriptLift(p, ctx.season, ctx.week).multiplier - 1) > 0.0005) gslNotOne++;
}
out.control_gameScriptLift_ne_1 = { skill_assets: gslN, multiplier_ne_1: gslNotOne };
lap('four surfaces + control');

// 2. The Ceiling tab (MyTeam) for my team, same week: per-player "avg" (mean_points).
const ceil = ceilingLineup(lg.id, { teamId: me.roster_id, week: ctx.week, objective: 'mean', trials: 2000 });
lap('ceilingLineup');
const byName = new Map(me.players.map(p => [p.name, p]));
const ceilingRows = (ceil.lineup ?? []).map(s => {
  const p = byName.get(s.player) ?? me.players.find(x => x.id === s.id);
  const ss = p ? lb.startSitWeekPoints(p, ctx.season, ctx.week).week_points : null;
  return { slot: s.slot, position: p?.position ?? null, team: p?.team_abbr ?? null,
    ceiling_tab_mean_points: s.mean_points, startsit_week_points: ss,
    active_probability: p?.active_probability ?? null, week_basis: p?.week_basis ?? null };
});
out.ceiling_vs_startsit = ceilingRows;
out.ceiling_lineup_keys = Object.keys(ceil.lineup?.[0] ?? {});

// 3. Isolate the betting-line game script inside the Ceiling tab's pool (ceiling-lineup.js:89-110
// replicated): the same draws (seeded) with gs multipliers vs with 1/1.
const proj = buildProjections({ through: ctx.season, throughWeek: ctx.week - 1, scoring: PPR, roleRecency: WEEKLY_ROLE_RECENCY });
const { schedule } = matchupModel();
lap('buildProjections');
const liftRows = [];
for (const p of me.players) {
  if (!['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
  const pr = proj.get(p.id);
  const game = schedule.get(p.team_abbr)?.find(g => g.week === ctx.week);
  if (!pr || !game) continue;
  const base = gameMultiplier(game.opponent_abbr, game.home, p.position);
  const gs = gameScriptFor(p.team_abbr, ctx.season, ctx.week);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const withGs = withRandomSeed(11, () => mean(sampleWeeks(pr.params, 4000, PPR, { pass: base * gs.pass_mult, rush: base * gs.rush_mult }, 1)));
  const noGs = withRandomSeed(11, () => mean(sampleWeeks(pr.params, 4000, PPR, { pass: base, rush: base }, 1)));
  liftRows.push({ position: p.position, team: p.team_abbr, pass_mult: gs.pass_mult, rush_mult: gs.rush_mult,
    ceiling_pool_mean_with_line: +withGs.toFixed(2), ceiling_pool_mean_without_line: +noGs.toFixed(2),
    lift_points: +(withGs - noGs).toFixed(2),
    startsit_vegasLift: wb.vegasLift(p, ctx.season, ctx.week).multiplier });
}
out.ceiling_lift_isolation = liftRows;
const moved = liftRows.filter(r => Math.abs(r.lift_points) >= 0.01);
out.ceiling_lift_summary = { players: liftRows.length, moved_by_line: moved.length,
  mean_abs_points: +(moved.reduce((s, r) => s + Math.abs(r.lift_points), 0) / Math.max(1, moved.length)).toFixed(2),
  max_abs_points: +Math.max(0, ...liftRows.map(r => Math.abs(r.lift_points))).toFixed(2) };
lap('ceiling lift isolation');

// 4. Season sim (season-sim.js:224-225): every team-week it simulates with a line gets the multipliers.
const teamsAll = [...new Set([...assets.values()].map(p => p.team_abbr).filter(Boolean))];
let tw = 0, twMoved = 0;
for (let w = ctx.week; w <= 17; w++) for (const t of teamsAll) {
  const gs = gameScriptFor(t, ctx.season, w);
  if (!gs.line) continue;
  tw++;
  if (Math.abs(gs.pass_mult - 1) > 0.0005 || Math.abs(gs.rush_mult - 1) > 0.0005) twMoved++;
}
out.season_sim_team_weeks = { weeks: `${ctx.week}-17`, team_weeks_with_line: tw, multipliers_ne_1: twMoved };
lap('season-sim multipliers');

console.log(JSON.stringify(out, null, 1));
