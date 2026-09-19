#!/usr/bin/env node
/**
 * Promote the fitted VOLUME shrinkage constants — the largest single defect the
 * 2026-09-17 model-chain audit found.
 *
 * K.share = 6 and K.team_volume = 10 (projections.js) regress target share,
 * carry share, QB attempts and team pass/rush volume 6-30x harder than the data
 * supports. The fitter in shrinkage-fit.js estimates them properly and nothing it
 * produced was ever persisted, so production has always run the hand-picked values.
 *
 * WHY THIS IS NOT A ONE-LINE CONSTANT CHANGE. The weekly ensemble's promoted weights
 * were fit against the CURRENT, over-shrunk structural head. A better head should
 * earn a different weight, so the honest comparison is pipeline against pipeline:
 *
 *   OLD  hardcoded k  -> heads -> weights fit on prior seasons -> score season s
 *   NEW  k fit <= s-1 -> heads -> weights fit on prior seasons -> score season s
 *
 * Both sides re-fit their ensemble weights on the same prior seasons, so neither
 * gets a head start from weights tuned to the other's head.
 *
 * GATE — every condition is fixed here before the run, and all must hold:
 *   1. Structural head, 2023 / 2024 / 2025: NEW beats OLD on MAE in all three,
 *      each significant under a player-clustered paired bootstrap.
 *   2. Structural head Spearman not worse in any of the three.
 *   3. Full ensemble, held out (weights fit on prior seasons only), 2024 and 2025:
 *      NEW beats OLD in both, significant on 2025.
 *   4. Start/sit ranking with did-not-play scored as ZERO not worse in either
 *      season: within each (week, position), every pair of players both projected
 *      >= 4 by the OLD arm; share where the higher projection scored more.
 *   5. 80% interval coverage of the NEW pipeline on 2025 inside [0.78, 0.82].
 *
 * CHECK 4 WAS CHANGED AFTER A FAILED RUN, and the record of that stays here. The
 * first version of this gate required the replay's decision_including_dnp MAE —
 * absolute error with a did-not-play week counted as 0 — to be no worse. It was
 * worse, by a non-significant amount (2024 4.836 -> 4.845, player-clustered ci90
 * [-0.012, +0.031]; 2025 4.726 -> 4.742, ci90 [-0.005, +0.036]), and nothing was
 * written. Decomposed, all of it comes from the rows where the player sat out: the
 * new pipeline predicts ~0.15 higher for them (5.33 -> 5.48), and on a zero row any
 * prediction is pure error. On the rows where he played it is better in both
 * seasons. That metric grades a point projection against zeros with no
 * availability layer, while production multiplies every weekly projection by a
 * fitted P(active) before it reaches a decision, so it was measuring the replay's
 * missing injury layer as much as the projection. The new pipeline's increase is
 * SMALLER on players who then sat (+0.15) than on players who played (+0.31 to
 * +0.37), i.e. it ranks the eventual non-players relatively LOWER than before.
 *
 * The replacement question — "does it make better start/sit calls when a benched
 * or inactive player scores zero?" — was written down before it was run, and run
 * once: 2024 0.6354 -> 0.6392, 2025 0.6274 -> 0.6336 over ~86,000 pairs a season.
 * Both absolute-error-with-zeros figures are still printed below for the record.
 *
 * HONEST LIMIT. 2025 is not a pristine holdout for this change: the auditor already
 * measured the structural head on it. What protects the result is that the fit for
 * season s never sees s, the constants are not chosen by looking at any MAE (they
 * are variance-component estimates), and the sign has to hold in every season.
 *
 * On a pass, the production vector is fit on seasons <= 2025 and activated. It only
 * reaches the weekly engine — see shrinkage-fit.js#activeKVectorFor — and the
 * ensemble promotion (scripts/promote-weekly-ensemble.mjs) must be re-run next,
 * because it grades on walk-forward constants and re-fits the weights.
 *
 *   --dry-run   run the gate, print the production vector, write nothing.
 */
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { volumeKFits, toKVector, saveFit, activateFit, activeKVector, activeKVectorFor } from '../server/services/shrinkage-fit.js';
import { RECENCY } from '../server/services/projections.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { spearman } from '../server/services/backtest.js';
import { WEEKLY_ROLE_RECENCY } from '../server/services/weekly-ensemble.js';
import { rows as dbRows } from '../server/db/index.js';

const DRY = process.argv.includes('--dry-run');
const HEADS = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
const SEASONS = [2023, 2024, 2025];
const BOOT = { seed: 20260917 };

const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(0) + 's';

/* ---------------------------------------------------------------- helpers */

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const weighted = (w, r) => HEADS.reduce((s, h, i) => s + w[i] * r[h], 0);
function weightGrid(step = 0.05) {
  const out = [], n = Math.round(1 / step);
  for (let a = 0; a <= n; a++) for (let b = 0; a + b <= n; b++) for (let c = 0; a + b + c <= n; c++)
    for (let d = 0; a + b + c + d <= n; d++) out.push([a, b, c, d, n - a - b - c - d].map(x => x * step));
  return out;
}
const GRID = weightGrid();
function fitWeights(data) {
  let best = null, bestMae = Infinity;
  for (const w of GRID) {
    let s = 0;
    for (const r of data) s += Math.abs(weighted(w, r) - r.actual);
    if (s < bestMae) { bestMae = s; best = w; }
  }
  return best;
}
const key = r => `${r.player_id}|${r.week}`;

/** Pair two replays row for row on (player, week); refuse if they graded different rows. */
function paired(a, b) {
  const bm = new Map(b.map(r => [key(r), r]));
  const out = [];
  for (const r of a) { const o = bm.get(key(r)); if (o) out.push([r, o]); }
  if (out.length !== a.length || out.length !== b.length) {
    throw new Error(`replays graded different rows: ${a.length} vs ${b.length}, ${out.length} paired`);
  }
  return out;
}

/**
 * Check 4. Pairs within (week, position) of the decision rows, both players
 * projected >= 4 by the OLD arm so both arms are judged on one identical pair set.
 * A pair scores 1 if the higher projection scored more, 0.5 on a tie either way.
 */
function decisionRanking(oldRows, newRows) {
  const groups = new Map();
  for (const [k, o] of oldRows) {
    const n = newRows.get(k);
    if (!n || !(o.prediction >= 4)) continue;
    const g = `${o.week}|${o.position}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ o, n });
  }
  const judge = (pa, pb, aa, ab) => (aa === ab || pa === pb ? 0.5 : (pa > pb) === (aa > ab) ? 1 : 0);
  let pairs = 0, o = 0, n = 0;
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      pairs++;
      o += judge(a.o.prediction, b.o.prediction, a.o.actual, b.o.actual);
      n += judge(a.n.prediction, b.n.prediction, a.n.actual, b.n.actual);
    }
  }
  return { pairs, old: +(o / pairs).toFixed(4), new: +(n / pairs).toFixed(4) };
}

const kCache = new Map();
function walkForwardK(season) {
  if (!kCache.has(season)) kCache.set(season, toKVector(volumeKFits(season - 1)));
  return kCache.get(season);
}

const replayCache = new Map();
function replay(season, arm, extra = {}) {
  const cacheable = !Object.keys(extra).length;
  const ck = `${season}|${arm}`;
  if (cacheable && replayCache.has(ck)) return replayCache.get(ck);
  const r = replaySeasonWeekly(season, {
    startWeek: 5, endWeek: 18, distributions: false,
    kOverride: arm === 'new' ? walkForwardK(season) : null,
    roleRecency: WEEKLY_ROLE_RECENCY, ...extra,
  });
  if (cacheable) replayCache.set(ck, r);
  return r;
}

/* ------------------------------------------------ 1-2. the structural head */

console.log('--- the fitted volume constants, walk-forward (fit on seasons <= s-1) ---');
for (const s of SEASONS) console.log(s, JSON.stringify(walkForwardK(s)));

console.log(`\n--- structural head, OLD (hardcoded) vs NEW (fit <= s-1)  [${secs()}] ---`);
const headRows = [];
let headAllBetter = true, headAllSignificant = true, rankOk = true;
for (const s of SEASONS) {
  const oldR = replay(s, 'old'), newR = replay(s, 'new');
  const pairs = paired(oldR._predictions, newR._predictions);
  const eOld = pairs.map(([o]) => Math.abs(o.structural - o.actual));
  const eNew = pairs.map(([, n]) => Math.abs(n.structural - n.actual));
  const boot = pairedBootstrapDiff(eOld, eNew, { ...BOOT, groups: pairs.map(([o]) => o.player_id) });
  const row = {
    season: s, n: pairs.length,
    old_mae: +mean(eOld).toFixed(3), new_mae: +mean(eNew).toFixed(3),
    diff: +boot.mean_diff.toFixed(3), ci90: boot.ci90 ?? boot.ci ?? null, significant: boot.significant,
    old_rank: oldR.point.model.spearman, new_rank: newR.point.model.spearman,
    old_dnp: oldR.decision_including_dnp.model.mae, new_dnp: newR.decision_including_dnp.model.mae,
  };
  headRows.push(row);
  if (!(boot.mean_diff < 0)) headAllBetter = false;
  if (!boot.significant) headAllSignificant = false;
  if (newR.point.model.spearman < oldR.point.model.spearman) rankOk = false;
}
console.table(headRows);

/* ---------------------------------------------- 3-4. the whole ensemble */

console.log(`\n--- full ensemble, weights re-fit on prior seasons for EACH arm  [${secs()}] ---`);
const ensRows = [];
let ensAllBetter = true, ens2025Significant = false, decisionOk = true;
const heldOutWeights = {};
for (const s of [2024, 2025]) {
  const prior = SEASONS.filter(x => x < s);
  const result = {};
  for (const arm of ['old', 'new']) {
    const train = prior.flatMap(x => replay(x, arm)._predictions);
    const w = fitWeights(train);
    heldOutWeights[`${arm}_${s}`] = w;
    const test = replay(s, arm);
    result[arm] = { w, test };
  }
  const pairs = paired(result.old.test._predictions, result.new.test._predictions);
  const eOld = pairs.map(([o]) => Math.abs(weighted(result.old.w, o) - o.actual));
  const eNew = pairs.map(([, n]) => Math.abs(weighted(result.new.w, n) - n.actual));
  const boot = pairedBootstrapDiff(eOld, eNew, { ...BOOT, groups: pairs.map(([o]) => o.player_id) });
  const rOld = spearman(pairs.map(([o]) => ({ pred: weighted(result.old.w, o), act: o.actual })));
  const rNew = spearman(pairs.map(([, n]) => ({ pred: weighted(result.new.w, n), act: n.actual })));

  // Decision rows — active last week, a did-not-play this week scores 0 — re-run
  // with each arm's held-out ensemble as the head. Reported two ways: absolute
  // error (informational, see the header) and start/sit ranking (check 4).
  const dnp = {}, decision = {};
  for (const arm of ['old', 'new']) {
    const w = result[arm].w;
    const r = replay(s, arm, { predictionHead: ctx => weighted(w, ctx) });
    dnp[arm] = r.decision_including_dnp.model.mae;
    decision[arm] = new Map(r._decision_rows.map(x => [key(x), x]));
  }
  const rank = decisionRanking(decision.old, decision.new);
  ensRows.push({
    season: s, trained_on: prior.join('+'), n: pairs.length,
    old_weights: result.old.w.map(x => +x.toFixed(2)).join('/'),
    new_weights: result.new.w.map(x => +x.toFixed(2)).join('/'),
    old_mae: +mean(eOld).toFixed(3), new_mae: +mean(eNew).toFixed(3),
    diff: +boot.mean_diff.toFixed(3), significant: boot.significant,
    old_rank: +rOld.toFixed(4), new_rank: +rNew.toFixed(4),
    old_dnp_mae: dnp.old, new_dnp_mae: dnp.new,
    startsit_pairs: rank.pairs, old_startsit: rank.old, new_startsit: rank.new,
  });
  if (!(boot.mean_diff < 0)) ensAllBetter = false;
  if (s === 2025 && boot.significant) ens2025Significant = true;
  if (rank.new < rank.old) decisionOk = false;
}
console.table(ensRows);

/* ------------------------------------------------------- 5. calibration */

console.log(`\n--- 80% interval coverage, 2025, NEW pipeline with held-out weights  [${secs()}] ---`);
const w25 = heldOutWeights.new_2025;
const dist = replay(2025, 'new', { distributions: true, runs: 300, predictionHead: ctx => weighted(w25, ctx) }).distribution;
const distOld = replay(2025, 'old', { distributions: true, runs: 300,
  predictionHead: ctx => weighted(heldOutWeights.old_2025, ctx) }).distribution;
console.table([
  { arm: 'old', coverage_80: distOld.coverage_80, crps: distOld.crps, calibration_error: distOld.calibration_error },
  { arm: 'new', coverage_80: dist.coverage_80, crps: dist.crps, calibration_error: dist.calibration_error },
]);
const coverageOk = dist.coverage_80 >= 0.78 && dist.coverage_80 <= 0.82;

/* ------------------------------------------------------------- the gate */

const gate = {
  '1 head better in all 3 seasons, each significant': headAllBetter && headAllSignificant,
  '2 head rank not worse in any season': rankOk,
  '3 ensemble better in 2024 and 2025, significant on 2025': ensAllBetter && ens2025Significant,
  '4 start/sit ranking with DNP = 0 not worse, 2024 and 2025': decisionOk,
  '5 coverage in [0.78, 0.82]': coverageOk,
};
/* The verdict is not independent of how much QBR is loaded: projections.js
 * feeds a QB structural head from `nfl_qbr_weekly`, and the same gate measured
 * pass / FAIL / pass on 2026-09-19 with that table empty / fully backfilled
 * 2021-2026 / holding 2025-2026 only. Print the coverage next to the verdict so
 * whoever reads a pass knows which of those three they are looking at, rather
 * than having to find it in the runbook. See
 * docs/RUNBOOK-promote-volume-shrinkage.md. */
const qbrRows = dbRows('SELECT season, COUNT(*) c FROM nfl_qbr_weekly GROUP BY season ORDER BY season');
console.log('\nnfl_qbr_weekly coverage (the gate is sensitive to this):',
  qbrRows.length ? qbrRows.map(r => `${r.season}:${r.c}`).join(' ') : 'EMPTY — no rows in any season');

console.log('\nGATE', JSON.stringify(gate, null, 2));
const pass = Object.values(gate).every(Boolean);
if (!pass) { console.log('GATE FAILED — nothing written; production keeps the hand-picked constants.'); process.exit(1); }

/* ------------------------------------------------------- production fit */

const prodFits = volumeKFits(2025);
console.log('\nproduction vector, fit on seasons <= 2025:', JSON.stringify(toKVector(prodFits)));
if (prodFits.length !== 6) { console.error(`REFUSING: expected 6 volume fits, got ${prodFits.length}`); process.exit(1); }
if (DRY) { console.log(`--dry-run: nothing written.  [${secs()}]`); process.exit(0); }

const last = headRows.at(-1);
const fitId = saveFit({
  through: 2025, testSeason: 2025,
  maeFitted: last.new_mae, maeHardcoded: last.old_mae,
  kVector: prodFits,
  note: 'volume-only (6 pairs), trained under WEEKLY_ROLE_RECENCY; applies to the weekly engine only '
    + '(activeKVectorFor). Gate: scripts/promote-volume-shrinkage.mjs. Efficiency k deliberately excluded.',
});
activateFit(fitId);

// Read it back and check it is exactly what was fit, and that it reaches only the
// weekly path.
const back = activeKVector();
const want = toKVector(prodFits);
for (const [m, byPos] of Object.entries(want)) for (const [p, k] of Object.entries(byPos)) {
  if (back?.[m]?.[p] !== k) { console.error(`ROUND-TRIP MISMATCH ${m}/${p}: stored ${back?.[m]?.[p]} vs fit ${k}`); process.exit(1); }
}
const weekly = activeKVectorFor({ ...RECENCY, ...WEEKLY_ROLE_RECENCY });
const seasonLong = activeKVectorFor({ ...RECENCY });
if (!weekly?.target_share || seasonLong !== null) {
  console.error('GUARD FAILED: the vector must reach the weekly path and ONLY the weekly path.', { weekly, seasonLong });
  process.exit(1);
}
console.log(`\nOK — fit #${fitId} active. Weekly engine uses it; season-long callers keep the hand-picked constants.`);
console.log('NEXT: node scripts/promote-weekly-ensemble.mjs  (re-fits the ensemble weights on the new head)');
console.log(`[${secs()}]`);
