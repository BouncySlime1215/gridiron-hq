/**
 * Regression coverage for the missing NFL totals calibration gate.
 *
 * A parallel audit found that nfl-market.js's totals model is staked live by
 * nfl-props.js's topTotals()/ensureTotalPicks() with NO calibration gate at
 * all — unlike spread, which is blocked from staking until
 * calibratedCoverProbability() proves an out-of-sample edge over the no-vig
 * market. ensureTotalPicks() previously hardcoded `units_staked` to 1 for
 * every one of its top-5 weekly total picks, regardless of any evidence the
 * model actually beats the market.
 *
 * A real walk-forward audit of the totals model against real historical
 * game_lines data (2010-2025, n=4317 settled non-push totals with real
 * priced odds, ratings/bias fit only on strictly earlier seasons) found:
 *   - no market-weight blend beats the no-vig market (any_lambda_beats_market
 *     === false), and the sweep is monotone toward the market at every
 *     shrinkage level;
 *   - the claimed edge does not significantly predict the actual over/under
 *     outcome (edge_slope_z ≈ -1.04, not significant, wrong-signed);
 *   - forward_gate_passed === false.
 * That result is not reproduced here (it depends on the real, gitignored
 * local data.sqlite, not present in every environment) — this file instead
 * proves the calibration module's core contract on fully synthetic, seeded
 * data: when the outcome is constructed to be independent of the model's
 * predicted total (the same "no real edge" shape the real audit found), the
 * walk-forward gate must stay closed rather than manufacture a false edge,
 * and no total pick may carry a nonzero stake until it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-total-calibration-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
await import('../server/services/gamescript.js'); // migrates game_lines' odds/total columns
const { withRandomSeed, randn, random } = await import('../server/services/stats-util.js');
const { clearNflMarketCache } = await import('../server/services/nfl-market.js');
const { buildTotalCalibration, latestTotalCalibration, calibratedTotalProbability } =
  await import('../server/services/nfl-total-calibration.js');
const { topTotals, ensureTotalPicks } = await import('../server/services/nfl-props.js');

/**
 * Seeds enough settled history for nfl-market.js's ratings model to fit
 * (needs >= 500 completed games) with TRUE random noise, not a deterministic
 * formula: every game's score is an independent random draw with no team
 * skill difference at all, and the total line is set to the real final total
 * plus or minus a coin-flip point — a well-set, unbeatable market by
 * construction. A rating system fit to pure noise can only ever chase noise;
 * there is no real, repeatable relationship for it to find between its own
 * predicted total and which side of a random line actually won. That is
 * real, engineered ground truth for "no edge" — not merely a deterministic
 * pattern a model might spuriously fit — matching the shape the real audit
 * found against actual historical data.
 */
function seedHistory({ throughSeason, seed = 42 }) {
  withRandomSeed(seed, () => {
    const insert = db.prepare(`INSERT INTO game_lines
      (season, week, team, opponent, home, spread, total, total_over_odds, total_under_odds,
       team_score, opp_score, rest_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, -110, -110, ?, ?, 7)
      ON CONFLICT(season, week, team) DO UPDATE SET
        opponent=excluded.opponent, home=excluded.home, spread=excluded.spread, total=excluded.total,
        total_over_odds=excluded.total_over_odds, total_under_odds=excluded.total_under_odds,
        team_score=excluded.team_score, opp_score=excluded.opp_score`);
    // Two independent team pairs per week (instead of one) so a season reaches
    // nfl-market.js's >=500-game training floor in far fewer seasons, leaving
    // enough seasons to actually walk-forward evaluate.
    const pairs = [['ZAA', 'ZBB'], ['ZCC', 'ZDD']];
    for (let season = 1999; season <= throughSeason; season++) {
      for (let week = 1; week <= 18; week++) {
        for (const [teamA, teamB] of pairs) {
          const home = week % 2 ? teamA : teamB, away = home === teamA ? teamB : teamA;
          const hs = Math.max(0, Math.round(22 + randn() * 7));
          const as = Math.max(0, Math.round(20 + randn() * 7));
          const actualTotal = hs + as;
          const line = actualTotal + (random() < 0.5 ? -1 : 1); // never a push, pure noise
          const homeSpread = -(1 + week % 7);
          insert.run(season, week, home, away, 1, homeSpread, line, hs, as);
          insert.run(season, week, away, home, 0, -homeSpread, line, as, hs);
        }
      }
    }
  });
}

test('totals calibration gate stays closed when the model has no real edge over the market', () => {
  seedHistory({ throughSeason: 2028 });
  clearNflMarketCache();
  const result = buildTotalCalibration({ seasonsBack: 16 });
  assert.ok(result, 'calibration should still be built and stored even when it finds nothing to stake');
  const m = result.metrics;
  assert.ok(m.walk_forward_n > 400, `expected a real walk-forward sample, got ${m.walk_forward_n}`);
  // The engineered ground truth here has outcome independent of the model's
  // edge by construction. `any_lambda_beats_market` is a soft diagnostic that
  // can flip true on a small sample from pure Brier-score noise even with no
  // real edge (real production data showed it false at n=4317; this synthetic
  // run is far smaller) — the actual production gate is `edge_predicts_totals`
  // plus `forward_gate_passed`, which must not be fooled by that noise.
  assert.equal(m.walk_forward_edge_predicts_totals, false,
    'claimed edge must not be judged predictive when the outcome does not depend on the model');
  assert.equal(m.forward_gate_passed, false,
    'the forward gate must stay closed when the model has no demonstrated edge');
});

test('calibratedTotalProbability abstains (returns null) until the gate has actually passed', () => {
  seedHistory({ throughSeason: 2028 });
  clearNflMarketCache();
  buildTotalCalibration({ seasonsBack: 10 });
  const calibrated = calibratedTotalProbability({ season: 2029, marketProbability: 0.5, edgePoints: 5 });
  assert.equal(calibrated.probability, null,
    'a probability must never be served from a calibration whose forward gate has not passed');
  assert.ok(calibrated.calibration, 'the (failed) calibration record should still be surfaced for audit');
  assert.equal(calibrated.calibration.metrics.forward_gate_passed, false);
});

test('a total pick with no proven calibration carries zero stake, not a hardcoded 1 unit', async () => {
  seedHistory({ throughSeason: 2028 });
  clearNflMarketCache();
  // No calibration has been built at all for this run — latestTotalCalibration
  // has nothing to find, so every pick must abstain from staking.
  const season = 2029, week = 3;
  run(`INSERT INTO game_lines
      (season, week, team, opponent, home, spread, total, total_over_odds, total_under_odds, rest_days)
      VALUES (?,?,?,?,1,-3,44,-110,-110,7)`, season, week, 'ZAA', 'ZBB');
  run(`INSERT INTO game_lines
      (season, week, team, opponent, home, spread, total, total_over_odds, total_under_odds, rest_days)
      VALUES (?,?,?,?,0,3,44,-110,-110,7)`, season, week, 'ZBB', 'ZAA');

  const board = await topTotals(season, week, 5);
  assert.ok(Array.isArray(board) && board.length >= 1, 'expected a priced total board row');
  for (const b of board) {
    assert.equal(b.calibration_eligible, false, 'no calibration exists yet, so nothing is eligible to stake');
    assert.equal(b.calibrated_probability, null);
  }

  const picks = await ensureTotalPicks(season, week, 5);
  assert.ok(picks.length >= 1, 'expected at least one locked-in total pick');
  for (const p of picks) {
    assert.equal(Number(p.calibration_eligible), 0, 'pick must be recorded as calibration-ineligible');
    assert.equal(p.units_staked, 0,
      'a total pick with no demonstrated edge over the market must stake zero units, not the old hardcoded 1');
  }
});
