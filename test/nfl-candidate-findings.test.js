/**
 * Phase 3 of the 2026-09-09 learning-pipeline plan: the missing middle
 * between "the diagnostic tool found something" and "a human can safely act
 * on it." Every property here is a structural safeguard against leakage and
 * overfitting across YEARS of this search running automatically, not just
 * within one run (Phase 0 already handles within-run multiple comparisons):
 *
 *   - a season can never change role for a given finding (the hard
 *     invariant a UNIQUE constraint enforces at the database level)
 *   - a segment needs two INDEPENDENT single-season discoveries before it
 *     is even registered as a candidate
 *   - the holdout state machine requires 3 non-overlapping passing seasons,
 *     and a single failure is immediately, automatically disqualifying
 *   - only a human-invoked function can ever promote a finding to
 *     production authority
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-candidate-findings-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { promoteFindingToShrink, rejectFinding, candidateFindingsStatus, nextHoldoutState, runCandidateFindingsForSeasonEnd,
  registerManuallyObservedFinding, promotedFindingVeto, __test } =
  await import('../server/services/nfl-candidate-findings.js');
const { recordDiscoveryFlag, assertSeasonRoleAvailable } = __test;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const segment = (dimension, name, winRate = 0.4) => ({ dimension, segment: name, win_rate: winRate });

test('a single discovery flag registers pending_confirmation, not discovered', () => {
  const result = recordDiscoveryFlag(segment('divisional', 'divisional'), 2021);
  assert.equal(result.action, 'first_flag');
  assert.equal(result.state, 'pending_confirmation');
});

test('a second, INDEPENDENT (different-season) flag promotes to discovered and freezes the rule', () => {
  recordDiscoveryFlag(segment('wind', 'windy (15+ mph)'), 2021);
  const second = recordDiscoveryFlag(segment('wind', 'windy (15+ mph)'), 2022);
  assert.equal(second.action, 'independently_reconfirmed');
  assert.equal(second.state, 'discovered');
  assert.deepEqual(second.discovery_seasons, [2021, 2022]);

  const status = candidateFindingsStatus().find(f => f.segment_key === 'wind|windy (15+ mph)');
  assert.equal(status.state, 'discovered');
  assert.ok(status.rule_definition_hash, 'the rule predicate must be frozen the moment discovery completes');
});

test('re-flagging the SAME season is a no-op, not a second confirmation', () => {
  recordDiscoveryFlag(segment('rest', 'short week'), 2021);
  const duplicate = recordDiscoveryFlag(segment('rest', 'short week'), 2021);
  assert.equal(duplicate.action, 'duplicate_flag_same_season');
  assert.equal(duplicate.state, 'pending_confirmation', 'must NOT advance to discovered off the same season flagged twice');
});

test('a finding already past discovery ignores further discovery flags rather than re-processing them', () => {
  recordDiscoveryFlag(segment('temperature', 'freezing'), 2021);
  recordDiscoveryFlag(segment('temperature', 'freezing'), 2022); // -> discovered
  const third = recordDiscoveryFlag(segment('temperature', 'freezing'), 2023);
  assert.equal(third.action, 'already_past_discovery');
});

test('Rule 1 (hard invariant): a season already used as discovery cannot later be used as holdout, and vice versa', () => {
  recordDiscoveryFlag(segment('spread size', 'big spread (7+)'), 2021);
  const finding = recordDiscoveryFlag(segment('spread size', 'big spread (7+)'), 2022);
  assert.throws(() => assertSeasonRoleAvailable(finding.finding_id, 2021, 'holdout'),
    /already used as 'discovery'/, 'a discovery season must never be reusable as holdout for the same finding');
  assert.throws(() => assertSeasonRoleAvailable(finding.finding_id, 2022, 'holdout'), /already used as 'discovery'/);
  // A genuinely new season is fine for either role.
  assert.doesNotThrow(() => assertSeasonRoleAvailable(finding.finding_id, 2023, 'holdout'));
});

test('nextHoldoutState: 3 non-overlapping passes with zero failures reaches flagged_for_review', () => {
  const rows = [{ season: 2023, holdout_passed: 1 }, { season: 2024, holdout_passed: 1 }, { season: 2025, holdout_passed: 1 }];
  assert.equal(nextHoldoutState('validating', rows), 'flagged_for_review');
});

test('nextHoldoutState: fewer than 3 passes stays in validating', () => {
  const rows = [{ season: 2023, holdout_passed: 1 }, { season: 2024, holdout_passed: 1 }];
  assert.equal(nextHoldoutState('discovered', rows), 'validating');
});

test('nextHoldoutState: a single failure rejects immediately, even alongside otherwise-passing seasons', () => {
  const rows = [{ season: 2023, holdout_passed: 1 }, { season: 2024, holdout_passed: 0 }, { season: 2025, holdout_passed: 1 }];
  assert.equal(nextHoldoutState('validating', rows), 'rejected',
    'a finding must not get to cherry-pick good years while a bad one is ignored');
});

test('promoteFindingToShrink requires flagged_for_review and an explicit actor — the one human-only gate', () => {
  recordDiscoveryFlag(segment('model agreement', 'models scatter'), 2021);
  const found = recordDiscoveryFlag(segment('model agreement', 'models scatter'), 2022);
  assert.throws(() => promoteFindingToShrink(found.finding_id, { actor: 'nick' }), /can only be promoted from 'flagged_for_review'/,
    'a merely-discovered finding (no holdout confirmations yet) must not be promotable');
  assert.throws(() => promoteFindingToShrink(999999, { actor: 'nick' }), /not found/);
  // Force the state to flagged_for_review directly (bypassing the expensive
  // real holdout replay, which is exercised separately) to prove the actor
  // requirement specifically.
  db.prepare(`UPDATE nfl_candidate_findings SET state='flagged_for_review' WHERE id=?`).run(found.finding_id);
  assert.throws(() => promoteFindingToShrink(found.finding_id, {}), /requires an explicit actor/,
    'promotion must never be callable without a named human actor, so it can never be invoked from an automatic path by accident');
  const promoted = promoteFindingToShrink(found.finding_id, { actor: 'nick', reason: 'confirmed real' });
  assert.equal(promoted.state, 'promoted');
  assert.equal(promoted.resolved_by, 'nick');
});

test('rejectFinding also requires an explicit actor', () => {
  recordDiscoveryFlag(segment('edge size', 'large edge (4+)'), 2021);
  const found = recordDiscoveryFlag(segment('edge size', 'large edge (4+)'), 2022);
  assert.throws(() => rejectFinding(found.finding_id, {}), /requires an explicit actor/);
  const rejected = rejectFinding(found.finding_id, { actor: 'nick', reason: 'looks spurious' });
  assert.equal(rejected.state, 'rejected');
});

test('runCandidateFindingsForSeasonEnd defers rather than runs while a blind audit is in progress', () => {
  db.prepare(`INSERT INTO nfl_blind_audit_runs (created_at, label, spec_hash, spec_json, code_hash, data_hash, status, next_ordinal)
    VALUES (datetime('now'), 'test', 'h1', '{}', 'c1', 'd1', 'running', 0)`).run();
  const result = runCandidateFindingsForSeasonEnd(2099); // season is fictional; should never get far enough to matter
  assert.equal(result.skipped, true);
  assert.match(result.reason, /blind audit run.*in progress/);
});

test('registerManuallyObservedFinding locks in every observed season as discovery, permanently', () => {
  const found = registerManuallyObservedFinding(
    segment('spread_x_timing', 'big spread (7+) + late (wk14+)', 0.292),
    [2021, 2022, 2023, 2024, 2025]
  );
  assert.equal(found.state, 'discovered');
  assert.deepEqual(found.discovery_seasons, [2021, 2022, 2023, 2024, 2025]);

  const status = candidateFindingsStatus().find(f => f.id === found.finding_id);
  assert.equal(status.direction, 'weak');
  assert.ok(status.rule_definition_hash, 'the rule must be frozen immediately, same as an algorithmically discovered finding');
  assert.ok(status.discovery_note?.includes('Manually observed'));

  // Rule 1 still applies: none of the observed seasons can later be reused as holdout.
  assert.throws(() => assertSeasonRoleAvailable(found.finding_id, 2023, 'holdout'), /already used as 'discovery'/);
  // A genuinely new season (one nobody looked at when proposing this) is fine.
  assert.doesNotThrow(() => assertSeasonRoleAvailable(found.finding_id, 2026, 'holdout'));
});

test('registerManuallyObservedFinding refuses to re-register the same segment twice', () => {
  // A segment_key/name not touched by any earlier test in this file — reusing
  // one that already exists would collide with unrelated prior test state in
  // this shared database, not exercise the guard this test is actually for.
  registerManuallyObservedFinding(segment('rest', 'off a bye', 0.4), [2021]);
  assert.throws(() => registerManuallyObservedFinding(segment('rest', 'off a bye', 0.4), [2022]), /already exists/);
});

test('promotedFindingVeto is a guaranteed no-op with zero promoted findings', () => {
  const bet = { season: 2026, week: 3, home: 'ZZZ', away: 'YYY', market: 'spread',
    side: 'ZZZ', line: -10, edge: 5, disagreement: 2 };
  const result = promotedFindingVeto(bet);
  assert.equal(result.vetoed, false);
});

test('promotedFindingVeto fires once (and only once) a finding is actually promoted', () => {
  const found = registerManuallyObservedFinding(segment('edge size', 'small edge (<4)', 0.4), [2021, 2022]);
  // Force through the holdout requirement directly (the real path is exercised
  // in the holdout-state-machine tests above) so this test is about the veto
  // consumer, not re-proving the state machine.
  db.prepare(`UPDATE nfl_candidate_findings SET state='flagged_for_review' WHERE id=?`).run(found.finding_id);
  const stillNotPromoted = promotedFindingVeto({ season: 2026, week: 3, home: 'AAA', away: 'BBB',
    market: 'spread', side: 'AAA', line: -1, edge: 1, disagreement: 2 });
  assert.equal(stillNotPromoted.vetoed, false, 'flagged_for_review alone must not veto anything -- only promoted does');

  promoteFindingToShrink(found.finding_id, { actor: 'nick', reason: 'test promotion' });
  // This bet's edge (1) is < 4, matching the promoted 'small edge (<4)' segment.
  const matching = promotedFindingVeto({ season: 2026, week: 3, home: 'AAA', away: 'BBB',
    market: 'spread', side: 'AAA', line: -1, edge: 1, disagreement: 2 });
  assert.equal(matching.vetoed, true);
  assert.equal(matching.segment_key, 'edge size|small edge (<4)');

  // A bet that does NOT match the promoted segment (large edge) must not be vetoed.
  const nonMatching = promotedFindingVeto({ season: 2026, week: 3, home: 'AAA', away: 'BBB',
    market: 'spread', side: 'AAA', line: -1, edge: 9, disagreement: 2 });
  assert.equal(nonMatching.vetoed, false, 'the veto must be scoped to exactly the promoted segment, not every bet');
});
