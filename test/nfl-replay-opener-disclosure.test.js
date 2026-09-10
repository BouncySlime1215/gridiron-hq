/**
 * Codex audit finding M07 / main plan section 3 task 4 (2026-09-10): a
 * single opener-comparison field previously called its output "Same picks"
 * even when the diagnostic actually RESELECTED which side to bet using the
 * opener edge -- which disagrees with the closing-line selector's actual
 * pick whenever the market moved enough to flip the preferred side (23 of
 * 153 run-27 spreads, 22 of 48 totals). Two honestly distinct diagnostics
 * replace it: a same-side regrade (the actual pick, graded at the opener)
 * and a side-reselected counterfactual (a different selection policy
 * entirely). Neither is an executable opening-time strategy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  spreadOpenerSideReselectedCounterfactual, spreadSameSideOpenerRegrade,
  totalOpenerSideReselectedCounterfactual, totalSameSideOpenerRegrade,
  sameSideOpenerRegradeSummary, openerSideReselectedCounterfactualSummary
} = await import('../server/services/nfl-replay.js');

test('same-side regrade NEVER changes the selected side, even when the opener edge would flip it', () => {
  // Closing selector backed HOME (closeBackHome = true). The opener number
  // is set so that, if re-derived from scratch, the model would prefer AWAY
  // (projectedMargin 1 vs openMarketMargin -(-6)=6 -> edge = 1-6 = -5 < 0).
  const r = spreadSameSideOpenerRegrade(/* openSpread */ -6, /* closeBackHome */ true, /* actualMargin */ 3);
  assert.equal(r.side, 'home', 'the regrade must keep the ORIGINAL side no matter what the opener implies');
  assert.equal(r.result, 'Lost'); // home actualMargin 3, openSpread -6 -> 3 + (-6) = -3 < 0, does not cover -6
});

test('same-side regrade math: home covers the OPENER exactly like the closing-line grade would, just with the opener number', () => {
  // Home favored by 6 at the opener (-6). Home wins by 9 -> covers (9-6=3>0).
  const won = spreadSameSideOpenerRegrade(-6, true, 9);
  assert.equal(won.result, 'Won');
  // Home favored by 6 at the opener. Home wins by only 3 -> does not cover (3-6=-3<0).
  const lost = spreadSameSideOpenerRegrade(-6, true, 3);
  assert.equal(lost.result, 'Lost');
  // Away side selected (closeBackHome=false): away covers when actualMargin + openSpread < 0.
  const awayWon = spreadSameSideOpenerRegrade(-6, false, -1); // home won by only 1 despite -6 favorite -> away covers
  assert.equal(awayWon.result, 'Won');
  // Push: actualMargin cancels the opener line exactly.
  const push = spreadSameSideOpenerRegrade(-6, true, 6);
  assert.equal(push.result, 'Push');
  // No stored opener -> not available, never a fabricated grade.
  assert.equal(spreadSameSideOpenerRegrade(null, true, 6).available, false);
});

test('side-reselected counterfactual correctly flags when it disagrees with the actual selected side', () => {
  // Model projects home margin +1. Opener has home favored by 6 (-6 spread
  // -> openMarketMargin = 6). openEdge = 1 - 6 = -5 -> reselects AWAY.
  // The close-selected side was HOME (closeBackHome = true) -> this differs.
  const flip = spreadOpenerSideReselectedCounterfactual(-6, 1, 3, true);
  assert.equal(flip.side, 'away');
  assert.equal(flip.differs_from_close_selected_side, true);

  // Model projects home margin +8 against the same -6 opener: openEdge = 8-6=2>0 -> home, matches close selection.
  const noFlip = spreadOpenerSideReselectedCounterfactual(-6, 8, 3, true);
  assert.equal(noFlip.side, 'home');
  assert.equal(noFlip.differs_from_close_selected_side, false);
});

test('total counterparts follow the identical same-side-fixed vs side-reselected distinction', () => {
  const sameSide = totalSameSideOpenerRegrade(44, /* closeOver */ true, 50);
  assert.equal(sameSide.side, 'Over');
  assert.equal(sameSide.result, 'Won');

  // Model projects total 40 (Under) against an opener of 44 -> reselects Under,
  // but the close selector actually took Over -> must flag the disagreement.
  const reselected = totalOpenerSideReselectedCounterfactual(44, 40, 50, /* closeOver */ true);
  assert.equal(reselected.side, 'Under');
  assert.equal(reselected.differs_from_close_selected_side, true);
});

test('the two summaries never claim "Same picks" and only the reselected one reports flips', () => {
  const bets = [
    { same_side_opener_regrade: { available: true, result: 'Won' },
      opener_side_reselected_counterfactual: { available: true, result: 'Won', differs_from_close_selected_side: false } },
    { same_side_opener_regrade: { available: true, result: 'Lost' },
      opener_side_reselected_counterfactual: { available: true, result: 'Lost', differs_from_close_selected_side: true } },
    { same_side_opener_regrade: { available: false }, opener_side_reselected_counterfactual: { available: false } }
  ];
  const same = sameSideOpenerRegradeSummary(bets);
  const reselected = openerSideReselectedCounterfactualSummary(bets);

  assert.ok(!/same picks/i.test(same.note), 'the same-side summary must not claim these were reselected as "same picks" (that claim never held once sides could differ)');
  assert.ok(!('picks_that_flip_side_at_open' in same), 'flip counting belongs only to the reselected-side summary, which is the only one that can ever reselect a side');
  assert.equal(same.bets, 2);
  assert.equal(same.wins, 1);
  assert.equal(same.losses, 1);

  assert.equal(reselected.picks_that_flip_side_at_open, 1);
  assert.ok(/DIFFERENT selection/.test(reselected.note), 'the reselected summary must disclose that it is a different selection policy, not the same bets');
});
