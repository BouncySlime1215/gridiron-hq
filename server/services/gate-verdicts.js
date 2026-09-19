/**
 * Ship rules of two pre-registered gates, as pure functions the scripts call and the
 * tests pin (test/gate-verdicts.test.js). Moving them here changes no rule: each body
 * is the expression its script evaluated inline. Gate texts and recorded runs:
 * docs/tdd/week2-numbers.tdd.md.
 */

/** 80% coverage band of the weekly distribution gate (scripts/fit-weekly-coverage.mjs). */
export const COVERAGE_BAND = Object.freeze([0.78, 0.82]);

/**
 * scripts/fit-weekly-coverage.mjs, G1-G3 on the validation season:
 *   G1 coverage_80 inside the band (inclusive);
 *   G2 calibration error strictly lower than the baseline's;
 *   G3 CRPS not worse: NOT (significant AND mean_diff > 0) in the player-clustered
 *      paired bootstrap of CRPS (candidate minus baseline).
 */
export function coverageGateVerdict({ coverage80, calibrationError, baseCalibrationError, crpsBoot, band = COVERAGE_BAND }) {
  const g1 = coverage80 >= band[0] && coverage80 <= band[1];
  const g2 = calibrationError < baseCalibrationError;
  const g3 = !(crpsBoot.significant && crpsBoot.mean_diff > 0);
  return { g1, g2, g3, pass: g1 && g2 && g3 };
}

/**
 * scripts/fit-posture-calibration.mjs SHIP rule on the validation season: the shipped
 * parameters beat the current rule (B0) on log loss AND 10-bin calibration error, and
 * the week-clustered bootstrap of the log-loss difference (winner minus B0) has its
 * whole 90% interval below 0.
 */
export function postureGateVerdict({ logLoss, baseLogLoss, ece, baseEce, boot }) {
  const pass1 = logLoss < baseLogLoss;
  const pass2 = ece < baseEce;
  const pass3 = !boot.error && boot.ci90[1] < 0;
  return { log_loss_beats_B0: pass1, ece_beats_B0: pass2, bootstrap_significant: pass3, SHIP: pass1 && pass2 && pass3 };
}
