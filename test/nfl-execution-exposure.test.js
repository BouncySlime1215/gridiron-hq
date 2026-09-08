import test from 'node:test';
import assert from 'node:assert/strict';

const { checkExposureBudget, correlatedSlateShockLoss, DEFAULT_EXPOSURE_BUDGET } =
  await import('../server/services/nfl-execution-exposure.js');

test('an empty book allows a normal-sized bet', () => {
  const result = checkExposureBudget({ openExposures: [], candidate: { event_key: 'g1', stake_units: 1 } });
  assert.equal(result.allowed, true);
  assert.equal(result.game_units_after, 1);
});

test('a bet that would push a single game over its cap is refused', () => {
  const openExposures = [{ event_key: 'g1', participant: null, stake_units: 2.5 }];
  const result = checkExposureBudget({ openExposures, candidate: { event_key: 'g1', stake_units: 1 } });
  assert.equal(result.allowed, false);
  assert.match(result.reasons[0], /game exposure/);
});

test('a bet on a different game is unaffected by another game\'s exposure', () => {
  const openExposures = [{ event_key: 'g1', participant: null, stake_units: 2.9 }];
  const result = checkExposureBudget({ openExposures, candidate: { event_key: 'g2', stake_units: 1 } });
  assert.equal(result.allowed, true);
});

test('a participant (player prop) cap is enforced independently of the game cap', () => {
  const openExposures = [
    { event_key: 'g1', participant: 'mahomes|pass_yds', stake_units: 1.5 },
    { event_key: 'g2', participant: null, stake_units: 0.5 }
  ];
  const result = checkExposureBudget({
    openExposures, candidate: { event_key: 'g3', participant: 'mahomes|pass_yds', stake_units: 1 }
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /participant exposure/);
});

test('team-level bets (no participant) never trip the participant cap', () => {
  const openExposures = [{ event_key: 'g1', participant: null, stake_units: 10 }].filter(() => false);
  const result = checkExposureBudget({ openExposures: [], candidate: { event_key: 'g4', participant: null, stake_units: 1 } });
  assert.equal(result.participant_units_after, null);
});

test('the aggregate total cap blocks even a small bet once the book is already full', () => {
  const openExposures = Array.from({ length: 8 }, (_, i) => ({ event_key: `g${i}`, stake_units: 1 }));
  const result = checkExposureBudget({ openExposures, candidate: { event_key: 'g9', stake_units: 0.5 } });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /total open exposure/);
});

test('checkExposureBudget requires a positive candidate stake', () => {
  assert.throws(() => checkExposureBudget({ openExposures: [], candidate: { event_key: 'g1', stake_units: 0 } }));
});

test('correlatedSlateShockLoss: a correlated slate\'s worst case grows toward the total staked', () => {
  const correlated = correlatedSlateShockLoss([
    { event_key: 'g1', stake_units: 1, shock_factor: 'shared_weather' },
    { event_key: 'g2', stake_units: 1, shock_factor: 'shared_weather' },
    { event_key: 'g3', stake_units: 1, shock_factor: 'shared_weather' }
  ]);
  assert.equal(correlated.total_staked, 3);
  assert.equal(correlated.worst_shared_shock_loss, 3);
  assert.equal(correlated.worst_case_share_of_book, 1);
});

test('correlatedSlateShockLoss: an independent slate\'s worst case is bounded by its largest single position', () => {
  const independent = correlatedSlateShockLoss([
    { event_key: 'g1', stake_units: 1, shock_factor: 'g1_only' },
    { event_key: 'g2', stake_units: 1, shock_factor: 'g2_only' },
    { event_key: 'g3', stake_units: 1, shock_factor: 'g3_only' }
  ]);
  assert.equal(independent.total_staked, 3);
  assert.equal(independent.worst_shared_shock_loss, 1);
  assert.ok(independent.worst_case_share_of_book < 1);
});

test('correlatedSlateShockLoss is deterministic when no shock_factor is supplied at all', () => {
  const positions = [{ event_key: 'g1', stake_units: 1 }, { event_key: 'g2', stake_units: 2 }];
  const first = correlatedSlateShockLoss(positions);
  const second = correlatedSlateShockLoss(positions);
  assert.deepEqual(first, second);
  assert.equal(first.worst_shared_shock_loss, 2); // each position is its own group; the largest wins
});

test('DEFAULT_EXPOSURE_BUDGET is exported so callers do not have to guess the current caps', () => {
  assert.equal(typeof DEFAULT_EXPOSURE_BUDGET.max_units_per_game, 'number');
  assert.equal(typeof DEFAULT_EXPOSURE_BUDGET.max_units_per_participant, 'number');
  assert.equal(typeof DEFAULT_EXPOSURE_BUDGET.max_units_total, 'number');
});
