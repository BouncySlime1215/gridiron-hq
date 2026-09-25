#!/usr/bin/env node
/**
 * PROJ-ESPN Q2: build server/services/range-residuals.json from a DB COPY.
 *
 *  1. Residual quantiles per position (QB/RB/WR/TE): actual PPR (player_week_usage, scoring.js
 *     PPR) minus ESPN's weekly projection for 2022-2025 (ESPN RETRO files written by
 *     scripts/eval/exgb-espn-retro.mjs), player-weeks where ESPN projected >= MIN_PROJ and the
 *     player has a usage row (he played). 200-point grid at u = (i + 0.5) / 200.
 *  2. The initial global width k: range-calibration.js#fitK on 2026 weeks 1-3 real team-weeks
 *     (every completed league-week in league_roster_snapshots). Each starter's mean is the
 *     frozen pre-kickoff ESPN number where one exists (espn_weekly_projection_snapshots, else the
 *     2026-W2 live capture in espn_player_market_weekly), else the league snapshot's RETRO
 *     projection (labelled; ESPN backfilled weeks 1-2 after the games).
 *
 * Usage: node scripts/eval/proj-espn-residuals.mjs --db <copy.sqlite> --retro-dir <dir> [--out <json>] [--dry]
 *        [--fit-basis frozen_w2_market|all] [--fixture-out <json>]
 * Refuses the live database. Writes ids-free numbers only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const dbPath = arg('--db');
const retroDir = arg('--retro-dir') ?? path.join(os.homedir(), 'gridiron-local', 'evidence', 'exgb');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = arg('--out') ?? path.join(HERE, '..', '..', 'server', 'services', 'range-residuals.json');
const dry = process.argv.includes('--dry');
if (!dbPath) { console.error('usage: --db <copy.sqlite> --retro-dir <dir> [--out <json>]'); process.exit(2); }
const LIVE = path.join(os.homedir(), 'gridiron-local', 'data.sqlite');
if (fs.existsSync(LIVE) && fs.realpathSync(dbPath) === fs.realpathSync(LIVE)) {
  console.error('refusing the live database; pass a copy'); process.exit(2);
}
process.env.GRIDIRON_DB_PATH = path.resolve(dbPath);
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../../server/db/index.js');
const { PPR, scoreLine } = await import('../../server/services/scoring.js');
const cal = await import('../../server/services/range-calibration.js');

const SEASONS = [2022, 2023, 2024, 2025];
const MIN_PROJ = 3;
const GRID = 200;
const POS = ['QB', 'RB', 'WR', 'TE'];

// 1. residual pools
const idByEspn = new Map(db.prepare('SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL').all()
  .map(r => [Number(r.espn_id), r.id]));
const pools = Object.fromEntries(POS.map(p => [p, []]));
const usageStmt = db.prepare('SELECT * FROM player_week_usage WHERE season = ? AND week = ? AND player_id = ?');
const counts = {};
for (const season of SEASONS) {
  const file = path.join(retroDir, `espn-retro-${season}.json`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const r of doc.rows) {
    if (!POS.includes(r.position) || !(r.projected_pts >= MIN_PROJ)) continue;
    const pid = idByEspn.get(Number(r.espn_id));
    if (pid == null) continue;
    const u = usageStmt.get(season, r.week, pid);
    if (!u) continue;
    pools[r.position].push(scoreLine(u, PPR) - r.projected_pts);
    counts[`${r.position} ${season}`] = (counts[`${r.position} ${season}`] ?? 0) + 1;
  }
}
const positions = {};
for (const p of POS) {
  const xs = Float64Array.from(pools[p]).sort();
  positions[p] = Array.from({ length: GRID }, (_, i) => {
    const pos = ((i + 0.5) / GRID) * xs.length - 0.5;
    const lo = Math.max(0, Math.floor(pos)), hi = Math.min(xs.length - 1, lo + 1);
    return +(xs[lo] + (pos - lo) * (xs[hi] - xs[lo])).toFixed(3);
  });
}
const table = { positions, k: { value: 1 } };

// 2. initial k on 2026 weeks 1-3
const SEASON = 2026;
const done = cal.completedWeeks(SEASON, db).filter(w => w <= 3);
const { teamWeeks: base, sources } = cal.replayTeamWeeks({ season: SEASON, weeks: done, retroFallback: true, database: db });
// The 2026-W2 live capture (frozen before kickoff, ESPN PPR defaults) replaces RETRO where the
// snapshot table has nothing for that week (it started capturing on 2026-09-25).
const W2_FIRST_KICKOFF = '2026-09-18T00:15:00Z';
const w2 = new Map(db.prepare(`SELECT espn_id, week_proj FROM espn_player_market_weekly WHERE season = 2026 AND week = 2
    AND is_live_capture = 1 AND week_proj IS NOT NULL AND captured_at < ?`).all(W2_FIRST_KICKOFF)
  .map(r => [Number(r.espn_id), Number(r.week_proj)]));
const starterRows = db.prepare(`SELECT league_id, team_id, espn_player_id, position, projected_points FROM league_roster_snapshots
    WHERE season = 2026 AND scoring_period_id = 2 AND is_starter = 1`).all();
const w2ByTeam = new Map();
for (const s of starterRows) {
  const key = `${s.league_id}:${s.team_id}`;
  if (!w2ByTeam.has(key)) w2ByTeam.set(key, []);
  w2ByTeam.get(key).push(s);
}
let w2Frozen = 0;
const teamWeeks = base.map(tw => {
  if (tw.week !== 2 || tw.basis !== 'retro') return tw;
  const st = w2ByTeam.get(`${tw.league_id}:${tw.team_id}`) ?? [];
  const skill = st.filter(s => POS.includes(s.position));
  if (!skill.length || !skill.every(s => w2.has(Number(s.espn_player_id)))) return tw;
  w2Frozen++;
  return { ...tw, basis: 'frozen_w2_market', starters: st.map(s => ({ position: s.position,
    mean: POS.includes(s.position) ? w2.get(Number(s.espn_player_id)) : Number(s.projected_points) })) };
});
const FIT_BASIS = arg('--fit-basis') ?? 'frozen_w2_market';
const fitSet = FIT_BASIS === 'all' ? teamWeeks : teamWeeks.filter(t => t.basis === FIT_BASIS);
const fit = cal.fitK(fitSet, { table });
const byBasis = {};
for (const b of new Set(teamWeeks.map(t => t.basis))) {
  const sub = teamWeeks.filter(t => t.basis === b);
  byBasis[b] = { n: sub.length, coverage_at_k: +cal.coverageAt(sub, fit.k, { table }).coverage.toFixed(3),
    coverage_at_1: +cal.coverageAt(sub, 1, { table }).coverage.toFixed(3) };
}
const fitDate = new Date().toISOString().slice(0, 10);
const doc = {
  built_at: new Date().toISOString(),
  method: 'residual = actual PPR (player_week_usage) - ESPN weekly projection (RETRO files), player-weeks with ESPN >= '
    + `${MIN_PROJ} that were played; quantile grid u = (i + 0.5) / ${GRID}`,
  seasons: SEASONS, min_proj: MIN_PROJ, grid: GRID,
  n: Object.fromEntries(POS.map(p => [p, pools[p].length])), n_by_position_season: counts,
  positions,
  k: { value: fit.k, fit_date: fitDate, target: cal.TARGET_COVERAGE, coverage: +fit.coverage.toFixed(3), capped: fit.capped,
    fit_season: SEASON, fit_weeks: [...new Set(fitSet.map(t => t.week))], fit_basis: FIT_BASIS, n_team_weeks: fitSet.length,
    pooled_weeks_1_3: { weeks: done, n: teamWeeks.length, coverage_at_k: +cal.coverageAt(teamWeeks, fit.k, { table }).coverage.toFixed(3) }, by_basis: byBasis,
    replay: { runs: cal.REPLAY_RUNS, seed: cal.REPLAY_SEED }, sources: { ...sources, w2_frozen_market: w2Frozen } },
};
console.log(JSON.stringify({ n: doc.n, k: doc.k,
  q: Object.fromEntries(POS.map(p => [p, [positions[p][19], positions[p][99], positions[p][179]]])) }, null, 1));
if (!dry) fs.writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
// --fixture-out: the frozen fit set, anonymised (positions, means, final totals; no ids or names),
// for test/proj-espn.test.js's coverage replay.
const fixtureOut = arg('--fixture-out');
if (fixtureOut) {
  fs.writeFileSync(fixtureOut, `${JSON.stringify({ note: '2026-W2 real team-weeks, frozen pre-kickoff ESPN means (PPR defaults) and final league totals; anonymised',
    k: fit.k, team_weeks: fitSet.map(t => ({ key: t.key, starters: t.starters.map(x => ({ position: x.position, mean: +x.mean.toFixed(2) })),
      actual: +t.actual.toFixed(2) })) })}\n`);
}
