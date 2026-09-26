#!/usr/bin/env node
/**
 * U6 IS-TITLE: the pre-registered bench (docs/tdd/2026-09-25-is-title.tdd.md).
 *
 * Synthetic league-4 shape: 10 teams, 13 regular weeks, 6-team fixed bracket over
 * weeks 14-16, weekly lineups Normal(mean_i, 25), team-mean term on at SD 8, team '5'
 * (Nick's slot) a longshot. Per seed: IS (pilot + main) vs direct plain runs at the same
 * budget, work-normalized by wall time; the mean of the seeds' IS estimates vs a
 * 100k-run direct reference. No database, no league data.
 *
 *   node scripts/rnd/is-title-bench.mjs [--seeds 10] [--ref 100000] [--budget 10000] [--nick-mean 100] [--rb]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const SEEDS = Number(arg('seeds', 10)), REF = Number(arg('ref', 100000)), BUDGET = Number(arg('budget', 10000));
const NICK_MEAN = Number(arg('nick-mean', 100));
const RB = process.argv.includes('--rb');
const WORLD = Number(arg('world', 4242));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-is-bench-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'bench.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
const { db } = await import('../../server/db/index.js');
const S = await import('../../server/services/season-sim.js');
const IS = await import('../../server/services/is-title.js');
const { keyedSeed, keyedNormal } = await import('../../server/services/stats-util.js');

export function synthLeague(world, nickMean) {
  const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const means = { 1: 118, 2: 116, 3: 114, 4: 112, 5: nickMean, 6: 110, 7: 108, 8: 106, 9: 102, 10: 100 };
  const teams = ids.map(id => ({ roster_id: id, owner: `o${id}`, players: [] }));
  const weeks = Array.from({ length: 13 }, (_, i) => i + 1);
  const sched = new Map(weeks.map(w => {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w) % 9)])];
    return [w, Array.from({ length: 5 }, (_, i) => [rot[i], rot[9 - i]])];
  }));
  const roundWeeks = [[14], [15], [16]];
  return {
    teams,
    prep: {
      lg: { payload: '{}' }, fromWeek: 1, sched, weeks, bracketWeeks: roundWeeks, playoffTeams: 6,
      medianGame: false, world, teamMeanSd: S.TEAM_MEAN_SD, rbTitle: RB ? 'on' : 'off',
      rules: { schedule: { playoff_weeks: roundWeeks, reseed: false }, seeding: { tiebreaker: 'TOTAL_POINTS_SCORED' } }
    },
    points: (t, run, week) => means[t.roster_id] + 25 * keyedNormal(keyedSeed(world, t.roster_id, week), run)
  };
}

const now = () => performance.now();
function direct(lg, start, n) {
  const t0 = now();
  const out = S.__test.playSeasons(lg.prep, lg.teams, n, true, (t, run, week) => lg.points(t, start + run, week));
  const v = Array.from(out.per_run.get('5').title);
  const ms = now() - t0;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { mean, sd, se: sd / Math.sqrt(n), ms };
}

const lg = synthLeague(WORLD, NICK_MEAN);
// The reference: REF plain runs on their own window (beyond every IS window).
const ref = direct(lg, 5 << 24, REF);
const perRunMs = ref.ms / REF;
console.log(`reference: ${REF} direct runs, title ${ref.mean.toFixed(5)} (SE ${ref.se.toFixed(5)}), ${perRunMs.toFixed(4)} ms/run, estimator ${RB ? 'conditional' : 'indicator'}`);

const pilotRuns = Math.round(BUDGET * 0.1), mainRuns = BUDGET - 2 * pilotRuns;
const rows = [];
for (let s = 0; s < SEEDS; s++) {
  const sl = synthLeague(WORLD, NICK_MEAN);
  // Each seed gets its own IS key (world) and run windows via a distinct Nick-z key.
  sl.prep.world = WORLD + 1 + s;
  const pts = (t, run, week) => lg.points(t, run + (s + 1) * (1 << 20), week);
  const t0 = now();
  const r = IS.isTitleRun({ prep: sl.prep, teams: sl.teams, meId: '5', rawPointsFor: pts,
    playSeasons: S.__test.playSeasons, teamOffsets: S.__test.teamOffsets, rbMode: RB ? 'on' : 'off',
    opts: { pilotRuns, mainRuns, checkRuns: 0 } });
  const isMs = now() - t0 - r.ms.check;
  const dirMs = perRunMs * BUDGET;
  const dirSe = ref.sd / Math.sqrt(BUDGET);
  const ratio = (r.se * Math.sqrt(isMs)) / (dirSe * Math.sqrt(dirMs));
  // The same-budget direct estimate on this seed's own window: the empirical check that
  // the estimator itself (not IS) has no run-count bias, and its spread across seeds.
  const dseed = direct(lg, (s + 1) * (1 << 20) + (7 << 24), BUDGET);
  rows.push({ dir: dseed.mean, seed: s, est: r.estimate, se: r.se, ess: r.ess_event, ratio, isMs, dirMs, mix: r.mixture, pilot: r.pilot_events, maxW: r.max_weight });
  console.log(`seed ${s}: IS ${r.estimate.toFixed(5)} SE ${r.se.toFixed(5)} ESS_event ${r.ess_event} | wall IS ${isMs.toFixed(0)} ms vs direct ${dirMs.toFixed(0)} ms | work-normalized SE ratio ${ratio.toFixed(3)} | mix ${JSON.stringify(r.mixture)} pilot events ${r.pilot_events} max w ${r.max_weight}`);
}
const k = rows.length;
const pooled = rows.reduce((s, r) => s + r.est, 0) / k;
const pooledSe = Math.sqrt(rows.reduce((s, r) => s + r.se ** 2, 0)) / k;
const z = Math.abs(pooled - ref.mean) / Math.sqrt(pooledSe ** 2 + ref.se ** 2);
const worstRatio = Math.max(...rows.map(r => r.ratio)), minEss = Math.min(...rows.map(r => r.ess));
const med = [...rows.map(r => r.ratio)].sort((a, b) => a - b)[k >> 1];
console.log(`\nbar 1 work-normalized SE ratio: max ${worstRatio.toFixed(3)}, median ${med.toFixed(3)} -> ${worstRatio <= 0.5 ? 'PASS' : 'FAIL'} (<= 0.5 on every seed)`);
console.log(`bar 2 unbiased: pooled IS ${pooled.toFixed(5)} (SE ${pooledSe.toFixed(5)}) vs direct ${ref.mean.toFixed(5)} (SE ${ref.se.toFixed(5)}), z ${z.toFixed(2)} -> ${z <= 2 ? 'PASS' : 'FAIL'} (<= 2)`);
console.log(`bar 3 ESS_event: min ${minEss} -> ${minEss >= 200 ? 'PASS' : 'FAIL'} (>= 200 on every seed)`);
const dirMean = rows.reduce((a, r) => a + r.dir, 0) / k;
const dirSd = Math.sqrt(rows.reduce((a, r) => a + (r.dir - dirMean) ** 2, 0) / (k - 1));
const isSd = Math.sqrt(rows.reduce((a, r) => a + (r.est - pooled) ** 2, 0) / (k - 1));
console.log(`cross-seed spread: direct ${BUDGET} runs mean ${dirMean.toFixed(5)} SD ${dirSd.toFixed(5)}; IS mean ${pooled.toFixed(5)} SD ${isSd.toFixed(5)} (empirical SD ratio ${(isSd / dirSd).toFixed(3)}); mean reported IS SE ${(rows.reduce((a, r) => a + r.se, 0) / k).toFixed(5)}`);
console.log(`direct title odds in 0.1-1%: ${ref.mean >= 0.001 && ref.mean <= 0.01 ? 'yes' : 'NO'}`);
db.close(); fs.rmSync(temp, { recursive: true, force: true });
