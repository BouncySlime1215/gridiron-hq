import test from 'node:test';
import assert from 'node:assert/strict';

const {
  replayDelayedExecution, replayDelayLadder, timelineFromFrozenRows, replayFromFrozenDataset,
  DEFAULT_DELAY_LADDER_SECONDS
} = await import('../server/services/nfl-execution-replay.js');

const quote = (snapshot_at, price, line = -3.5) => ({ snapshot_at, type: 'quote', price, line });

test('filled_as_decided: nothing moved between decision and execution', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110), quote('2026-09-10T10:10:00Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 30 });
  assert.equal(result.outcome, 'filled_as_decided');
  assert.equal(result.obtained_price, -110);
  assert.equal(result.obtained_stake_units, 1);
});

test('repriced: the book still quotes it, but at a different number by execution time', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110), quote('2026-09-10T10:05:20Z', -120)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 30 });
  assert.equal(result.outcome, 'repriced');
  assert.equal(result.decision_price, -110);
  assert.equal(result.obtained_price, -120);
  assert.ok(result.breakeven_slippage_bps > 0, 'the required win rate should have gotten worse');
});

test('disappeared: the book no longer quotes this exact contract by execution time', () => {
  const timeline = [
    quote('2026-09-10T10:00:00Z', -110),
    { snapshot_at: '2026-09-10T10:05:10Z', type: 'removed' }
  ];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 30 });
  assert.equal(result.outcome, 'disappeared');
  assert.equal(result.obtained_price, null);
  assert.equal(result.obtained_stake_units, 0);
});

test('suspended: the market was explicitly suspended by execution time', () => {
  const timeline = [
    quote('2026-09-10T10:00:00Z', -110),
    { snapshot_at: '2026-09-10T10:05:15Z', type: 'suspended' }
  ];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 30 });
  assert.equal(result.outcome, 'suspended');
  assert.equal(result.obtained_stake_units, 0);
});

test('no_decision_quote: nothing was quoted at or before the decision instant at all', () => {
  const timeline = [quote('2026-09-10T10:10:00Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 30 });
  assert.equal(result.outcome, 'no_decision_quote');
});

test('capped: a fill would be available, but the requested stake exceeds a modeled book limit', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110), quote('2026-09-10T10:05:20Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 30,
    requestedStakeUnits: 5, bookLimitUnits: 2 });
  assert.equal(result.outcome, 'capped');
  assert.equal(result.obtained_stake_units, 2);
  assert.equal(result.capped, true);
});

test('stale_unknown: the last confirmed quote is older than the trust window at execution time', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:00:00Z', delaySeconds: 1200,
    maxStalenessSeconds: 900 });
  assert.equal(result.outcome, 'stale_unknown');
  assert.equal(result.obtained_stake_units, 0);
  assert.equal(result.last_known_price, -110);
});

test('a decision replayed inside the staleness window is unaffected by it', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:00:00Z', delaySeconds: 60,
    maxStalenessSeconds: 900 });
  assert.equal(result.outcome, 'filled_as_decided');
});

test('replayDelayLadder runs the plan\'s own delay set: 5s, 30s, 2m, 10m', () => {
  assert.deepEqual(DEFAULT_DELAY_LADDER_SECONDS, [5, 30, 120, 600]);
  const timeline = [quote('2026-09-10T10:00:00Z', -110), quote('2026-09-10T10:12:00Z', -130)];
  const results = replayDelayLadder({ timeline, decisionAt: '2026-09-10T10:05:00Z' });
  assert.equal(results.length, 4);
  // Shorter delays should see the same, unchanged price; the 10-minute delay crosses the repriced quote.
  assert.equal(results[0].outcome, 'filled_as_decided');
  assert.equal(results[3].outcome, 'repriced');
});

test('determinism: identical inputs produce a byte-identical result, every time', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110), quote('2026-09-10T10:05:20Z', -120),
    quote('2026-09-10T10:09:00Z', -115)];
  const args = { timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 120, requestedStakeUnits: 2 };
  const first = replayDelayedExecution(args);
  const second = replayDelayedExecution(args);
  const third = replayDelayedExecution({ ...args, timeline: [...timeline] }); // fresh array, same content
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

test('timelineFromFrozenRows only pulls the exact contract and book requested', () => {
  const frozenRows = [
    { contract_key: 'A', book: 'draftkings', snapshot_at: '2026-09-10T10:00:00Z', price: -110, line: -3.5 },
    { contract_key: 'A', book: 'fanduel', snapshot_at: '2026-09-10T10:00:00Z', price: -105, line: -3.5 },
    { contract_key: 'B', book: 'draftkings', snapshot_at: '2026-09-10T10:00:00Z', price: -200, line: -7 }
  ];
  const timeline = timelineFromFrozenRows(frozenRows, { contractKey: 'A', book: 'draftkings' });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].price, -110);
});

test('replayFromFrozenDataset is re-creatable: same frozen rows and decision reproduce the same result', () => {
  const frozenRows = [
    { contract_key: 'nfl|2026-09-10|BAL@KC|spreads|full_game|-|home|-3.5|ot_included|margin_vs_line',
      book: 'draftkings', snapshot_at: '2026-09-10T10:00:00Z', price: -110, line: -3.5 },
    { contract_key: 'nfl|2026-09-10|BAL@KC|spreads|full_game|-|home|-3.5|ot_included|margin_vs_line',
      book: 'draftkings', snapshot_at: '2026-09-10T10:06:00Z', price: -125, line: -3.5 }
  ];
  const args = { frozenRows, contractKey: frozenRows[0].contract_key, book: 'draftkings',
    decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 120 };
  const first = replayFromFrozenDataset(args);
  const second = replayFromFrozenDataset(args);
  assert.deepEqual(first, second);
  assert.equal(first.outcome, 'repriced');
  assert.equal(first.obtained_price, -125);
});
