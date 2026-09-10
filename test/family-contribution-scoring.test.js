/**
 * Codex correction C16: "The new family report overstates what it tested."
 *
 * Two defects with numbers attached, both reproduced before this file existed:
 *
 *   1. `featureContracts()` dropped `challenger_only`, so the report concluded
 *      every family had ZERO challengers while nine challenger-only components
 *      are registered. A report that cannot see nine of its own inputs is not
 *      measuring what it claims to.
 *
 *   2. Both scoring paths discarded pushes from the denominator and then
 *      scored the UNCONDITIONAL win probability against the decided binary
 *      label. The plan states the consequence exactly: "a 0.45 win / 0.10 push
 *      / 0.45 loss forecast on a decided win gets about 0.303 rather than the
 *      proper conditional 0.25."
 *
 * The second one has a direction that matters: the penalty scales with how
 * much push mass a model predicts, so a model that gets key numbers RIGHT
 * scored WORSE than one that ignored them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-family-scoring-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const { featureContracts } = await import('../server/services/nfl-ensemble.js');
const { spreadProperScores } = await import('../server/services/nfl-family-contribution.js');

test('C16: all nine challenger-only components are recoverable from the registry', () => {
  const contracts = featureContracts();
  const challengers = contracts.filter(c => c.challenger_only);
  assert.equal(challengers.length, 9,
    'the review counts nine challenger-only components; a report that sees zero is broken');

  // And they are attributed to the right families, matching the review's own
  // inventory: Efficiency carries eight, roster availability one.
  const byFamily = {};
  for (const c of contracts) {
    byFamily[c.family] ??= { registered: 0, challengers: 0 };
    byFamily[c.family].registered++;
    if (c.challenger_only) byFamily[c.family].challengers++;
  }
  assert.equal(byFamily.Efficiency.challengers, 8);
  assert.equal(byFamily.Efficiency.registered, 17);
  assert.equal(byFamily['Roster availability'].challengers, 1);
  assert.equal(byFamily['Rating systems'].challengers, 0);
  assert.equal(contracts.length, 31, 'the registry holds 31 components in total');
});

test('C16: every component still carries its family data contract', () => {
  // Adding challenger_only must not have displaced what was already there.
  for (const c of featureContracts()) {
    assert.ok(c.source, `${c.id} lost its declared source`);
    assert.ok(c.availability, `${c.id} lost its availability rule`);
    assert.ok(c.cutoff_rule, `${c.id} lost its cutoff rule`);
    assert.ok(c.missing_policy, `${c.id} lost its missing-data policy`);
  }
});

test('C16: the conditional Brier fixture equals exactly 0.25', () => {
  // The plan's own worked example.
  const scores = spreadProperScores({ homeCoverProbability: 0.45, pushProbability: 0.10, homeMargin: 7 });
  assert.ok(Math.abs(scores.conditional - 0.25) < 1e-9,
    `conditional Brier must be 0.25, got ${scores.conditional}`);
  assert.ok(Math.abs(scores.legacy_unconditional_vs_decided - 0.3025) < 1e-9,
    'and the old number is preserved so an earlier report can be reconciled');
});

test('C16: the three-state Brier includes pushes', () => {
  // Decided win: (0.45-1)^2 + (0.10-0)^2 + (0.45-0)^2 = 0.3025 + 0.01 + 0.2025.
  const decided = spreadProperScores({ homeCoverProbability: 0.45, pushProbability: 0.10, homeMargin: 7 });
  assert.ok(Math.abs(decided.three_state - 0.515) < 1e-9, `got ${decided.three_state}`);

  // A pushed game has no conditional cover question, but the three-state score
  // still grades the whole distribution -- which is the only way a forecast
  // that claimed push mass can ever be rewarded for it.
  const pushed = spreadProperScores({ homeCoverProbability: 0.45, pushProbability: 0.10, homeMargin: 0 });
  assert.equal(pushed.conditional, null);
  assert.equal(pushed.pushed, true);
  assert.ok(Math.abs(pushed.three_state - 1.215) < 1e-9, `got ${pushed.three_state}`);
});

test('C16: predicting push mass correctly no longer makes a model look worse', () => {
  // Two models with the SAME conditional cover call (0.5 either way) but
  // different push beliefs. Under the old score the one that predicted pushes
  // was punished for it; under the conditional score they tie, which is right,
  // because they made the identical cover call.
  const ignoresPushes = spreadProperScores({ homeCoverProbability: 0.5, pushProbability: 0, homeMargin: 7 });
  const predictsPushes = spreadProperScores({ homeCoverProbability: 0.45, pushProbability: 0.10, homeMargin: 7 });

  assert.ok(Math.abs(ignoresPushes.conditional - predictsPushes.conditional) < 1e-9,
    'the same cover call scores the same, whatever push mass sits beside it');
  assert.ok(predictsPushes.legacy_unconditional_vs_decided > ignoresPushes.legacy_unconditional_vs_decided,
    'and the OLD score really did punish the model that predicted pushes');
});

test('C16: a perfect conditional call scores zero, a certain wrong one scores one', () => {
  const perfect = spreadProperScores({ homeCoverProbability: 0.9, pushProbability: 0.1, homeMargin: 7 });
  assert.ok(Math.abs(perfect.conditional - 0) < 1e-9, 'p=1 conditional on decided, and it covered');

  const certainWrong = spreadProperScores({ homeCoverProbability: 0.9, pushProbability: 0.1, homeMargin: -7 });
  assert.ok(Math.abs(certainWrong.conditional - 1) < 1e-9);
});

test('C16: a missing forecast scores nothing rather than defaulting to a number', () => {
  assert.equal(spreadProperScores({ homeCoverProbability: null, homeMargin: 7 }), null);
  assert.equal(spreadProperScores({ homeCoverProbability: 0.5, homeMargin: null }), null);
});
