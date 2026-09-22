/**
 * Auditor-verified defect (2026-09-22): shrinkage-fit.js's efficiency specs
 * (ypt, catch_rate, rec_td_rate, ypc, rush_td_rate, ypa, pass_td_rate,
 * int_rate) are built by efficiencyObservations() with `weight: opp` --
 * the raw opportunity count, with no recency applied at all. `effW`
 * (efficiencyWeightFor(through), built at shrinkage-fit.js:322) is computed
 * and never passed anywhere; a whole-repo grep for `efficiencyWeightFor` or
 * `effW` returns only its own definition and that dead assignment.
 *
 * This matters because production's own efficiency denominator is NOT a raw
 * opportunity count either: projections.js accumulates `a.targets += w *
 * (u.targets ?? 0)` under RECENCY (a season-old game counts 0.35x), and that
 * weighted sum is exactly the `n` passed to pickK() for ypt/catch_rate (and
 * a.carries/a.attempts likewise for ypc/ypa). A k fit against raw opp counts
 * is optimal for evidence units production never actually uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-shrinkage-efficiency-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { buildFitSpecs } = await import('../server/services/shrinkage-fit.js');
const { RECENCY } = await import('../server/services/projections.js');
const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insertPlayer = (id, name, position, espnId) => run(
  `INSERT INTO players (id, name, position, espn_id, fantasy_relevant) VALUES (?,?,?,?,1)`,
  id, name, position, espnId);

const insertWeek = (playerId, season, week, team, targets) => run(
  `INSERT INTO player_week_usage
   (player_id, season, week, team, opponent, position, targets, receptions, receiving_yards, receiving_tds,
    attempts, passing_yards, passing_tds, interceptions, carries, rushing_yards, rushing_tds)
   VALUES (?,?,?,?, 'OPP', 'WR', ?, 6, 80, 0.5, 0,0,0,0,0,0,0)`,
  playerId, season, week, team, targets);

const insertShareWeek = (playerId, season, week, team, targetShare) => run(
  `INSERT INTO player_week_usage
   (player_id, season, week, team, opponent, position, targets, target_share, receptions, receiving_yards, receiving_tds,
    attempts, passing_yards, passing_tds, interceptions, carries, rushing_yards, rushing_tds)
   VALUES (?,?,?,?, 'OPP', 'WR', 5, ?, 3, 40, 0.3, 0,0,0,0,0,0,0)`,
  playerId, season, week, team, targetShare);

// Two WR players, identical weekly target counts (10/week, 8 weeks), one
// entirely in the cutoff season (back=0), one entirely one season earlier
// (back=1). Under RECENCY (seasonDecay 0.35), a correctly-weighted fitter
// must weight the back=1 player's rows at 0.35x the back=0 player's.
insertPlayer(1, 'Current Season WR', 'WR', 9101);
insertPlayer(2, 'Prior Season WR', 'WR', 9102);
// Same season as player 1, double the weekly opportunity count -- isolates
// the opp-scaling half of the fix from the recency half, so a mutation that
// drops one factor and keeps only the other cannot pass both assertions.
insertPlayer(3, 'Current Season WR, Double Targets', 'WR', 9103);
for (let w = 1; w <= 8; w++) {
  insertWeek(1, 2024, w, 'AAA', 10);
  insertWeek(2, 2023, w, 'BBB', 10);
  insertWeek(3, 2024, w, 'CCC', 20);
}

test('the ypt spec weights a prior-season row by RECENCY.seasonDecay, not by raw opportunity count alone', () => {
  const specs = buildFitSpecs(2024); // roleRecency only affects the volume specs; irrelevant here
  const ypt = specs.find(s => s.metric === 'ypt' && s.position === 'WR');
  assert.ok(ypt, 'expected a WR ypt spec');

  const weightOf = group => ypt.observations.filter(o => o.group === group).reduce((s, o) => s + o.weight, 0);
  const currentSeasonWeight = weightOf(1);
  const priorSeasonWeight = weightOf(2);
  const doubleOppWeight = weightOf(3);

  assert.ok(currentSeasonWeight > 0 && priorSeasonWeight > 0 && doubleOppWeight > 0,
    'all three players must contribute observations');

  // Both players 1 and 2 have identical raw opportunity totals (10 targets x
  // 8 weeks = 80), so an unweighted fitter (the bug) reports these as EQUAL.
  // A correctly recency-weighted fitter must report the prior-season total
  // at RECENCY.seasonDecay (0.35x) of the current-season total.
  const seasonRatio = priorSeasonWeight / currentSeasonWeight;
  assert.ok(Math.abs(seasonRatio - RECENCY.seasonDecay) < 1e-9,
    `expected prior-season weight to be current-season weight x RECENCY.seasonDecay (${RECENCY.seasonDecay}), ` +
    `got ratio ${seasonRatio} (current=${currentSeasonWeight}, prior=${priorSeasonWeight})`);

  // Player 3 shares player 1's season but doubles the weekly opportunity
  // count, so its weight must be exactly double player 1's -- catches a
  // mutation that keeps the recency factor but drops the opp multiplier
  // (which the season-ratio assertion above cannot see, since dropping opp
  // leaves the season ratio unchanged).
  const oppRatio = doubleOppWeight / currentSeasonWeight;
  assert.ok(Math.abs(oppRatio - 2) < 1e-9,
    `expected double the weekly opportunity count to double the weight, got ratio ${oppRatio}`);
});

// Plan 07 §2.3 RED test 4: roleW already reaches the volume specs correctly
// (WEEKLY_ROLE_RECENCY overlaid on RECENCY -> seasonDecay 0.05, not 0.35).
// This pins that a future one-line edit to this fix's plumbing cannot widen
// `effW` (plain RECENCY, seasonDecay 0.35) into a volume call site by
// mistake -- if it did, this ratio would silently jump from 0.05 to 0.35.
insertPlayer(4, 'Current Season Share WR', 'WR', 9104);
insertPlayer(5, 'Prior Season Share WR', 'WR', 9105);
for (let w = 1; w <= 8; w++) {
  insertShareWeek(4, 2024, w, 'AAA', 0.2);
  insertShareWeek(5, 2023, w, 'BBB', 0.2);
}

test('the volume side (target_share) still weights by WEEKLY_ROLE_RECENCY.seasonDecay, unmoved by the efficiency-side fix', () => {
  const specs = buildFitSpecs(2024);
  const share = specs.find(s => s.metric === 'target_share' && s.position === 'ALL');
  assert.ok(share, 'expected a target_share spec');

  const weightOf = group => share.observations.filter(o => o.group === group).reduce((s, o) => s + o.weight, 0);
  const currentSeasonWeight = weightOf(4);
  const priorSeasonWeight = weightOf(5);
  assert.ok(currentSeasonWeight > 0 && priorSeasonWeight > 0, 'both players must contribute observations');

  const seasonRatio = priorSeasonWeight / currentSeasonWeight;
  assert.ok(Math.abs(seasonRatio - WEEKLY_ROLE_RECENCY.seasonDecay) < 1e-9,
    `expected the volume spec's prior-season ratio to stay at WEEKLY_ROLE_RECENCY.seasonDecay ` +
    `(${WEEKLY_ROLE_RECENCY.seasonDecay}), got ${seasonRatio} -- this is RECENCY.seasonDecay (${RECENCY.seasonDecay}) ` +
    `if effW has leaked into a volume call site`);
});
