import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-replay-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const {
  replayDelayedExecution, replayDelayLadder, timelineFromFrozenRows, replayFromFrozenDataset,
  timelineFromQuoteTape, DEFAULT_DELAY_LADDER_SECONDS, DEFAULT_MAX_STALENESS_SECONDS,
  AVAILABILITY_POLICY_VERSION
} = await import('../server/services/nfl-execution-replay.js');
const { ingestQuoteSnapshot } = await import('../server/services/nfl-quote-tape.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

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
  assert.equal(first.market_status_source, 'frozen_dataset_no_status_history',
    'a frozen-dataset replay must disclose that it cannot represent a genuine disappearance');
});

test('the default staleness policy is a real number, never Infinity, and is disclosed on every result', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:00:00Z', delaySeconds: 30 });
  assert.equal(result.outcome, 'filled_as_decided');
  assert.ok(Number.isFinite(DEFAULT_MAX_STALENESS_SECONDS), 'the default must be a finite number, not Infinity');
  assert.equal(result.availability_assumptions.policy_version, AVAILABILITY_POLICY_VERSION);
  assert.equal(result.availability_assumptions.max_staleness_seconds, DEFAULT_MAX_STALENESS_SECONDS);
  assert.equal(result.availability_assumptions.max_staleness_is_default, true);
  assert.equal(result.availability_assumptions.book_limit_modeled, false,
    'no book limit has ever been observed in this project — this must say so, not silently imply unconstrained');
});

test('decision_stale_unknown: the only quote at or before the decision instant is already too old to trust', () => {
  const timeline = [quote('2026-09-10T10:00:00Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:35:00Z', delaySeconds: 30,
    maxStalenessSeconds: 900 });
  assert.equal(result.outcome, 'decision_stale_unknown');
  assert.equal(result.obtained_stake_units, 0);
  assert.equal(result.last_known_price, -110);
  assert.ok(result.staleness_seconds > 900);
});

test('an unchanged but directly refreshed quote is current, not stale — staleness measures our last look, not the last price change', () => {
  // Every successful poll writes its own sample even when the price did not
  // move (see timelineFromQuoteTape below for the real-table equivalent).
  // Three identical-price samples, 10 minutes apart, span 20 minutes total —
  // well past a short trust window measured from the FIRST sample, but each
  // individual gap is well inside it.
  const timeline = [quote('2026-09-10T10:00:00Z', -110), quote('2026-09-10T10:10:00Z', -110),
    quote('2026-09-10T10:20:00Z', -110)];
  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:00:00Z', delaySeconds: 1200,
    maxStalenessSeconds: 700 });
  assert.equal(result.outcome, 'filled_as_decided', 'the repeated confirmation at 10:20 must count as current');
  assert.equal(result.obtained_price, -110);
});

test('timelineFromQuoteTape: an unchanged price polled again is a new confirming sample, not a dedup no-op', () => {
  const payload = (snapshotAt, price) => ([{ id: 'espn-refresh-1', commence_time: '2026-09-11T00:20:00Z',
    home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'spreads', last_update: snapshotAt,
      outcomes: [{ name: 'Kansas City Chiefs', point: -3.5, price }, { name: 'Baltimore Ravens', point: 3.5, price: -110 }] }] }] }]);
  ingestQuoteSnapshot(payload('2026-09-10T11:00:00Z', -110), { requestedAt: '2026-09-10T11:00:05Z', sourceRef: 'refresh_test_1' });
  ingestQuoteSnapshot(payload('2026-09-10T11:05:00Z', -110), { requestedAt: '2026-09-10T11:05:05Z', sourceRef: 'refresh_test_2' });
  const timeline = timelineFromQuoteTape({ providerEventId: 'espn-refresh-1', market: 'spreads', sideKey: 'home', book: 'draftkings' });
  assert.equal(timeline.length, 2, 'two successful polls must produce two samples even though the price never changed');
  assert.equal(timeline[0].price, -110);
  assert.equal(timeline[1].price, -110);
});

test('timelineFromQuoteTape: a sibling side reported at a batch where this exact side is absent is genuine removal', () => {
  const payload = (snapshotAt, includeHome) => ([{ id: 'espn-removed-1', commence_time: '2026-09-11T00:20:00Z',
    home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'spreads', last_update: snapshotAt,
      outcomes: [
        ...(includeHome ? [{ name: 'Kansas City Chiefs', point: -3.5, price: -110 }] : []),
        { name: 'Baltimore Ravens', point: 3.5, price: -110 }
      ] }] }] }]);
  // Batch 1: both sides quoted. Batch 2: the book still reports (the away side
  // is right there in the same batch) but home is gone — real evidence of
  // removal, not silence, because the book was demonstrably reachable at that
  // instant and chose not to include this exact side.
  ingestQuoteSnapshot(payload('2026-09-10T12:00:00Z', true), { requestedAt: '2026-09-10T12:00:05Z', sourceRef: 'removed_test_1' });
  ingestQuoteSnapshot(payload('2026-09-10T12:06:00Z', false), { requestedAt: '2026-09-10T12:06:05Z', sourceRef: 'removed_test_2' });
  const timeline = timelineFromQuoteTape({ providerEventId: 'espn-removed-1', market: 'spreads', sideKey: 'home', book: 'draftkings' });
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].type, 'quote');
  assert.equal(timeline[1].type, 'removed', 'the sibling side proves the book responded and dropped this exact side');

  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T12:00:05Z', delaySeconds: 600 });
  assert.equal(result.outcome, 'disappeared');
});

test('timelineFromQuoteTape: ordinary silence for this book (no sibling evidence at all) is never synthesized into a sample', () => {
  const payload = (snapshotAt) => ([{ id: 'espn-silent-1', commence_time: '2026-09-11T00:20:00Z',
    home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'spreads', last_update: snapshotAt,
      outcomes: [{ name: 'Kansas City Chiefs', point: -3.5, price: -110 }, { name: 'Baltimore Ravens', point: 3.5, price: -110 }] }] }] }]);
  // Only one batch is ever ingested for this event — there is no second batch
  // at all, from this book or any other, so there is nothing to compare
  // against. A later decision/execution instant sees only silence, which must
  // resolve through the staleness check (stale_unknown), never a fabricated
  // 'removed' sample invented from an absent batch.
  ingestQuoteSnapshot(payload('2026-09-10T13:00:00Z'), { requestedAt: '2026-09-10T13:00:05Z', sourceRef: 'silent_test_1' });
  const timeline = timelineFromQuoteTape({ providerEventId: 'espn-silent-1', market: 'spreads', sideKey: 'home', book: 'draftkings' });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].type, 'quote');

  const result = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T13:00:05Z', delaySeconds: 3600, maxStalenessSeconds: 900 });
  assert.equal(result.outcome, 'stale_unknown', 'unexplained silence is unknown availability, never a confirmed removal');
});
