#!/usr/bin/env node
/**
 * Auditor §R25/R36 measurement: how much of control's pooled MAE win over
 * shipped is level (centring) vs. information (genuine predictive shape).
 *
 * Pre-registered method: docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-PREREGISTRATION.md
 *
 * R37 rider: this grades the replay predictor, whose equivalence to
 * production's is unestablished (Explorer is separately checking whether
 * the replay's `structural` input is production's own code or a
 * reimplementation).
 *
 * shipped  = WEEKLY_ENSEMBLE_WEIGHTS (the live frozen per-position fallback)
 * control  = fit-1's flat vector, applied uniformly across positions, never
 *            promoted to any epoch
 *
 * Bias/m0 split: 2023 only (R36 change 1 -- median of 2023 residuals, not
 * mean; also the R7 multiplicative form, m0 = prediction-weighted median of
 * actual/pred on 2023).
 * Test seasons: 2024 (the figure being decomposed -- in-sample for control,
 * since fit-1 was fit on pooled 2023-2025), plus 2021 and 2022 (R36 change 2
 * -- out-of-sample for both arms, the clean comparison).
 */
process.env.SCHEDULER_DISABLED = '1';

const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
const { weeklyEnsemblePrediction, WEEKLY_ENSEMBLE_WEIGHTS } = await import('../server/services/weekly-ensemble.js');
const { decomposeArm } = await import('../server/services/level-information-decomposition.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');

const CONTROL_WEIGHTS = Object.freeze({
  QB: [0.20, 0.40, 0.15, 0.05, 0.20],
  RB: [0.20, 0.40, 0.15, 0.05, 0.20],
  WR: [0.20, 0.40, 0.15, 0.05, 0.20],
  TE: [0.20, 0.40, 0.15, 0.05, 0.20]
});
const controlHead = context => weeklyEnsemblePrediction(context, CONTROL_WEIGHTS);

function extractArms(rows) {
  return {
    playerIds: rows.map(r => r.player_id),
    shipped: { pred: rows.map(r => r.candidate_heads.active_champion), act: rows.map(r => r.actual) },
    control: { pred: rows.map(r => r.prediction), act: rows.map(r => r.actual) }
  };
}

console.log('Running bias/m0 split: 2023 (distributions off) ...');
const biasRun = replaySeasonWeekly(2023, { predictionHead: controlHead, distributions: false });
const bias = extractArms(biasRun._predictions);
console.log(`  2023 graded player-weeks: ${bias.playerIds.length}`);

const report = { bias_season: 2023, bias_n: bias.playerIds.length, seasons: {} };
const seasonRuns = {};

for (const season of [2024, 2021, 2022]) {
  console.log(`Running test season ${season} (distributions off) ...`);
  const run = replaySeasonWeekly(season, { predictionHead: controlHead, distributions: false });
  const arms = extractArms(run._predictions);
  seasonRuns[season] = arms;
  const n = arms.playerIds.length;

  const shippedOut = decomposeArm({
    biasPredictions: bias.shipped.pred, biasActuals: bias.shipped.act,
    testPredictions: arms.shipped.pred, testActuals: arms.shipped.act
  });
  const controlOut = decomposeArm({
    biasPredictions: bias.control.pred, biasActuals: bias.control.act,
    testPredictions: arms.control.pred, testActuals: arms.control.act
  });

  const rawDelta = shippedOut.rawMae - controlOut.rawMae;
  const debiasedDelta = shippedOut.debiasedMae - controlOut.debiasedMae;
  const levelShare = rawDelta - debiasedDelta;
  const informationShare = debiasedDelta;

  const shippedRawAbsErr = arms.shipped.pred.map((p, i) => Math.abs(arms.shipped.act[i] - p));
  const controlRawAbsErr = arms.control.pred.map((p, i) => Math.abs(arms.control.act[i] - p));
  const shippedDebiasedAbsErr = arms.shipped.pred.map((p, i) => Math.abs(arms.shipped.act[i] - (p + shippedOut.medianBias)));
  const controlDebiasedAbsErr = arms.control.pred.map((p, i) => Math.abs(arms.control.act[i] - (p + controlOut.medianBias)));

  const rawBoot = pairedBootstrapDiff(shippedRawAbsErr, controlRawAbsErr, { groups: arms.playerIds });
  const debiasedBoot = pairedBootstrapDiff(shippedDebiasedAbsErr, controlDebiasedAbsErr, { groups: arms.playerIds });

  report.seasons[season] = {
    n, shipped: shippedOut, control: controlOut,
    raw_delta: rawDelta, debiased_delta: debiasedDelta,
    level_share: levelShare, information_share: informationShare,
    raw_bootstrap: rawBoot, debiased_bootstrap: debiasedBoot
  };

  console.log(`  season ${season}: n=${n} raw_delta=${rawDelta.toFixed(4)} debiased_delta=${debiasedDelta.toFixed(4)} level_share=${levelShare.toFixed(4)} information_share=${informationShare.toFixed(4)}`);
  console.log(`    shipped raw MAE=${shippedOut.rawMae.toFixed(4)} signedErr=${shippedOut.rawMeanSignedError.toFixed(4)} m0=${shippedOut.m0?.toFixed(4)} headroom=${shippedOut.headroom?.toFixed(4)}`);
  console.log(`    control raw MAE=${controlOut.rawMae.toFixed(4)} signedErr=${controlOut.rawMeanSignedError.toFixed(4)} m0=${controlOut.m0?.toFixed(4)} headroom=${controlOut.headroom?.toFixed(4)}`);
  console.log(`    raw bootstrap: mean_diff=${rawBoot.mean_diff?.toFixed(4)} ci90=[${rawBoot.ci90?.map(x => x.toFixed(4)).join(', ')}] significant=${rawBoot.significant}`);
  console.log(`    debiased bootstrap: mean_diff=${debiasedBoot.mean_diff?.toFixed(4)} ci90=[${debiasedBoot.ci90?.map(x => x.toFixed(4)).join(', ')}] significant=${debiasedBoot.significant}`);
}

// Auditor R46 item 2: the 2022 reversal must not depend on the shared 2023
// anchor. Re-debias 2022 against an adjacent season (2021) and against
// itself (in-sample, an upper bound on what centring can buy control).
console.log('\n=== R46: 2022 anchor sweep ===');
const test2022 = seasonRuns[2022];
for (const [label, anchorSeason] of [['2023 (main run)', 2023], ['2021 (adjacent)', 2021], ['2022 (in-sample upper bound)', 2022]]) {
  const anchor = anchorSeason === 2023 ? bias : seasonRuns[anchorSeason];
  const armOut = arm => decomposeArm({
    biasPredictions: anchor[arm].pred, biasActuals: anchor[arm].act,
    testPredictions: test2022[arm].pred, testActuals: test2022[arm].act
  });
  const s = armOut('shipped'), c = armOut('control');
  const debiasedDelta = s.debiasedMae - c.debiasedMae;
  const boot = pairedBootstrapDiff(
    test2022.shipped.pred.map((p, i) => Math.abs(test2022.shipped.act[i] - (p + s.medianBias))),
    test2022.control.pred.map((p, i) => Math.abs(test2022.control.act[i] - (p + c.medianBias))),
    { groups: test2022.playerIds }
  );
  report.anchor_sweep_2022 ??= {};
  report.anchor_sweep_2022[anchorSeason] = { shipped: s, control: c, debiased_delta: debiasedDelta, bootstrap: boot };
  console.log(`  anchored on ${label}: shipped debiasedMae=${s.debiasedMae.toFixed(4)} control debiasedMae=${c.debiasedMae.toFixed(4)} debiased_delta=${debiasedDelta.toFixed(4)} mean_diff=${boot.mean_diff?.toFixed(4)} ci90=[${boot.ci90?.map(x => x.toFixed(4)).join(', ')}] significant=${boot.significant}`);
}

console.log('\nR37 rider: this grades the replay predictor, whose equivalence to production\'s is unestablished.');
console.log('\nFULL JSON:');
console.log(JSON.stringify(report, null, 2));
