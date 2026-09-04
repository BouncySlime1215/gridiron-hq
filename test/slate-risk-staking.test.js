import test from 'node:test';
import assert from 'node:assert/strict';
import { safeStakeFor, slateRiskCheck, estimateBetCorrelation } from '../server/services/staking.js';

/**
 * Regression coverage for the correlation-aware portfolio risk control added
 * to staking.js. Two things must both be true:
 *   1. It is provably inert with every gate closed — the app's actual state
 *      today — so no correlation math can turn a zero-edge bet into a
 *      nonzero stake.
 *   2. When bets DO have stake (a hypothetical gates-open scenario, exercised
 *      the same way the existing "safe stake sizing" test in
 *      model-integrity.test.js already does), a slate of genuinely correlated
 *      bets is measured as riskier than an equivalent slate of independent
 *      bets carrying the exact same total stake.
 */

test('zero-edge floor holds even with a large correlated openBets slate', () => {
  // Ten bets that would be maximally correlated if they were live (same game,
  // repeated) — but none of them has passed calibration, so every one of them
  // must still be blocked at exactly zero, with the correlation math never
  // even changing the reason.
  const correlatedOpenBets = Array.from({ length: 10 }, () => ({
    stake_fraction: 0.02, team: 'KC', opponent: 'BUF', model_probability: 0.6
  }));
  const blocked = safeStakeFor({
    winProb: 0.62, americanOdds: -110, bankroll: 1000,
    calibrationPassed: false, forwardSettled: 20, uncertaintyWidth: 18,
    openBets: correlatedOpenBets
  });
  assert.equal(blocked.execution_eligible, false);
  assert.equal(blocked.stake, 0);
  assert.equal(blocked.stake_fraction, 0);
  assert.ok(blocked.blockers.includes('cover calibration has not beaten the market out of sample'));

  // Same slate, but now every single-bet gate passes. The correlated slate
  // (all ten bets on the identical KC@BUF game) sums to well over the 8%
  // portfolio cap once correlation is accounted for, so the candidate must
  // still be blocked — but for the PORTFOLIO reason, not manufactured edge.
  const stillBlocked = safeStakeFor({
    winProb: 0.62, americanOdds: -110, bankroll: 1000,
    calibrationPassed: true, forwardSettled: 250, uncertaintyWidth: 18,
    openBets: correlatedOpenBets
  });
  assert.equal(stillBlocked.execution_eligible, false);
  assert.equal(stillBlocked.stake, 0);
  assert.ok(stillBlocked.blockers.some(b => b.includes('weekly portfolio exposure cap is already reached')));
});

test('safeStakeFor without openBets is byte-for-byte unchanged (backward compatible)', () => {
  const eligible = safeStakeFor({
    winProb: 0.62, americanOdds: -110, bankroll: 1000,
    calibrationPassed: true, forwardSettled: 250, uncertaintyWidth: 18, openPortfolioFraction: 0.07
  });
  assert.equal(eligible.execution_eligible, true);
  assert.ok(eligible.stake_fraction <= 0.01);
  assert.ok(eligible.portfolio_fraction_after <= 0.08);
  assert.equal(eligible.slate_risk, null);
});

test('estimateBetCorrelation: same game scores high, unrelated games score zero', () => {
  const a = { team: 'KC', opponent: 'BUF' };
  const b = { team: 'BUF', opponent: 'KC' }; // mirror of the same matchup
  const c = { team: 'DAL', opponent: 'PHI' };
  assert.ok(estimateBetCorrelation(a, b) > 0.5, 'two legs on the same game should be strongly correlated');
  assert.equal(estimateBetCorrelation(a, c), 0, 'two unrelated games share no factor');
});

test('slateRiskCheck: a correlated slate is measured riskier than an independent slate at the same total stake', () => {
  // Five bets, 2% each = 10% flat total either way. Correlated version: all
  // five are legs on the SAME two games (two different markets on each of two
  // matchups plus one shared-weather pair) so real money moves together;
  // independent version: five entirely unrelated games.
  const correlated = [
    { stake_fraction: 0.02, team: 'KC', opponent: 'BUF', model_probability: 0.58 },
    { stake_fraction: 0.02, team: 'BUF', opponent: 'KC', model_probability: 0.55 },
    { stake_fraction: 0.02, team: 'DAL', opponent: 'PHI', model_probability: 0.57 },
    { stake_fraction: 0.02, team: 'PHI', opponent: 'DAL', model_probability: 0.56 },
    { stake_fraction: 0.02, team: 'GB', opponent: 'CHI', weather_bucket: 'high_wind', model_probability: 0.6 }
  ];
  const independent = [
    { stake_fraction: 0.02, team: 'KC', opponent: 'BUF', model_probability: 0.58 },
    { stake_fraction: 0.02, team: 'SEA', opponent: 'ARI', model_probability: 0.55 },
    { stake_fraction: 0.02, team: 'DAL', opponent: 'NYG', model_probability: 0.57 },
    { stake_fraction: 0.02, team: 'MIA', opponent: 'NE', model_probability: 0.56 },
    { stake_fraction: 0.02, team: 'GB', opponent: 'CHI', model_probability: 0.6 }
  ];

  const correlatedRisk = slateRiskCheck(correlated);
  const independentRisk = slateRiskCheck(independent);

  // Today's code (a flat sum) would call these identical: both slates stake
  // exactly 10% total. The whole point of this fix is that they are NOT
  // equally risky.
  assert.equal(correlatedRisk.flat_fraction, independentRisk.flat_fraction, 'both slates stake the same flat total');
  assert.ok(
    correlatedRisk.correlated_risk_fraction > independentRisk.correlated_risk_fraction,
    `correlated slate risk (${correlatedRisk.correlated_risk_fraction}) should exceed independent slate risk (${independentRisk.correlated_risk_fraction})`
  );
  // A correlation-aware measure can never exceed the naive flat sum for any
  // valid correlation matrix (every off-diagonal entry is <= 1, so this is a
  // mathematical fact, not a design choice) — the flat sum is already the
  // maximally-conservative, perfectly-correlated case. What must hold is that
  // the correlated slate's measure sits closer to its own flat sum than the
  // independent slate's does, since less of its risk is genuinely diversified away.
  assert.ok(correlatedRisk.effective_open_fraction <= correlatedRisk.flat_fraction + 1e-9);
  assert.ok(independentRisk.effective_open_fraction <= independentRisk.flat_fraction + 1e-9);
  assert.ok(
    correlatedRisk.risk_amplification > independentRisk.risk_amplification,
    `correlated slate should retain a larger share of its flat-sum risk (${correlatedRisk.risk_amplification}) ` +
    `than the independent slate (${independentRisk.risk_amplification})`
  );

  // Drawdown probability — the Busseti/Ryu/Boyd chance-constraint proxy — should
  // also read higher for the slate that actually moves together.
  assert.ok(Number.isFinite(correlatedRisk.drawdown_probability));
  assert.ok(Number.isFinite(independentRisk.drawdown_probability));
  assert.ok(correlatedRisk.drawdown_probability >= independentRisk.drawdown_probability,
    `correlated drawdown probability (${correlatedRisk.drawdown_probability}) should be >= independent (${independentRisk.drawdown_probability})`);
});

test('slateRiskCheck never manufactures risk from bets that are not actually staked', () => {
  const allZero = [
    { stake_fraction: 0, team: 'KC', opponent: 'BUF' },
    { stake_fraction: 0, team: 'BUF', opponent: 'KC' }
  ];
  const result = slateRiskCheck(allZero);
  assert.equal(result.staked_bets, 0);
  assert.equal(result.flat_fraction, 0);
  assert.equal(result.effective_open_fraction, 0);
});
