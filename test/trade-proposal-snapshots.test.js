/**
 * OFFER-SNAPSHOT: the terms of every ESPN trade offer, kept from the moment it
 * is first seen, and every decision linked back to them.
 *
 * WHY. 38 of 82 decided trade offers in the ESPN leagues have no proposal row,
 * so the players and prices offered are unknown and the acceptance model cannot
 * learn which terms get a yes. A decision row (accept / decline / veto / close)
 * names its proposal only through `related_tx_id`; when the proposal itself was
 * never stored, or was stored with no items, the decision was dropped by
 * `settleObservedOutcomes` with a free-text skip that nothing kept.
 *
 * Gates (docs/tdd/2026-09-24-offer-snapshot.tdd.md):
 *  S1 a pending TRADE_PROPOSAL is captured once, with its full items, and a
 *     later sighting (even one whose items came back empty) never rewrites them.
 *  S2 a later decline links to the captured proposal via related_tx_id, and the
 *     snapshot keeps its terms and records the resolution.
 *  S3 a decision whose proposal is absent is stored as link_state
 *     'proposal_missing' with a TYPED reason, never dropped.
 *  S4 backfill: proposals already in league_transactions_raw with items become
 *     snapshots marked 'raw_backfill', so old decisions link too.
 *  S5 the focus league's trades are polled between ticks of the refresh loop,
 *     on their own cadence, never inside the web server.
 * Every row here is a fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offer-snapshot-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const {
  captureProposalSnapshots, linkTradeOutcomes, MISSING_REASONS,
} = await import('../server/services/trade-proposal-snapshots.js');
const LOOP = await import('../scripts/refresh-live-data.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------- fixtures */

// Same DDL and the same upsert as scripts/collect-league-transactions.mjs, so
// the fixture loses items exactly the way the real collector would.
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);

const iso = ms => (ms ? new Date(ms).toISOString() : null);
function collect(leagueId, season, txs, now) {
  for (const t of txs) {
    run(`INSERT INTO league_transactions_raw VALUES
      (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@processed_at,@team_id,@member_id,
       @related_tx_id,@scoring_period,@bid_amount,@is_pending,@items_json,@raw_json,@first_seen_at,@last_seen_at)
      ON CONFLICT(league_id, season, tx_id) DO UPDATE SET
        status=excluded.status, processed_at=COALESCE(excluded.processed_at, processed_at),
        is_pending=excluded.is_pending, items_json=excluded.items_json, raw_json=excluded.raw_json,
        last_seen_at=excluded.last_seen_at`, {
      league_id: leagueId, season, tx_id: String(t.id), type: t.type ?? null, status: t.status ?? null,
      execution_type: t.executionType ?? null, proposed_at: iso(t.proposedDate), processed_at: iso(t.processDate),
      team_id: t.teamId ?? null, member_id: null, related_tx_id: t.relatedTransactionId ?? null,
      scoring_period: t.scoringPeriodId ?? null, bid_amount: null, is_pending: t.isPending ? 1 : 0,
      items_json: JSON.stringify(t.items ?? []), raw_json: JSON.stringify(t), first_seen_at: now, last_seen_at: now,
    });
  }
  return captureProposalSnapshots(leagueId, season, txs, now);
}

const T0 = Date.parse('2026-09-20T15:00:00Z');
const offerItems = [
  { playerId: 101, type: 'TRADE', fromTeamId: 3, toTeamId: 7 },
  { playerId: 202, type: 'TRADE', fromTeamId: 7, toTeamId: 3 },
];
const pending = {
  id: 'p-1', type: 'TRADE_PROPOSAL', status: 'PENDING', executionType: 'EXECUTE', isPending: true,
  teamId: 3, proposedDate: T0, scoringPeriodId: 3, items: offerItems,
};
const snap = (leagueId, season, id) => row(
  `SELECT * FROM trade_proposal_snapshots WHERE league_id = ? AND season = ? AND proposal_tx_id = ?`,
  leagueId, season, id);
const link = (leagueId, season, id) => row(
  `SELECT * FROM trade_outcome_links WHERE league_id = ? AND season = ? AND outcome_tx_id = ?`,
  leagueId, season, id);

/* --------------------------------------------------------------- S1 */

test('S1: a pending proposal is captured once, with its full items, marked pending', () => {
  const r = collect(4, 2026, [pending], '2026-09-20T15:01:00Z');
  assert.equal(r.captured, 1);
  const s = snap(4, 2026, 'p-1');
  assert.ok(s, 'the pending proposal has a snapshot');
  assert.deepEqual(JSON.parse(s.items_json), offerItems);
  assert.equal(s.captured_from, 'pending');
  assert.equal(s.proposer_team_id, 3);
  assert.equal(s.captured_at, '2026-09-20T15:01:00Z');
  assert.equal(s.proposed_at, iso(T0));

  // A second sighting while still pending writes nothing new.
  const again = collect(4, 2026, [pending], '2026-09-20T15:04:00Z');
  assert.equal(again.captured, 0);
  assert.equal(rows(`SELECT COUNT(*) n FROM trade_proposal_snapshots WHERE league_id = 4`)[0].n, 1);
  assert.equal(snap(4, 2026, 'p-1').last_seen_at, '2026-09-20T15:04:00Z');
});

/* --------------------------------------------------------------- S2 */

test('S2: a later decline links to the captured proposal, and the terms survive an empty re-read', () => {
  // ESPN hands the resolved proposal back with no items; the raw upsert
  // overwrites its items_json with []. The snapshot must not follow it.
  const resolved = { ...pending, status: 'CANCELED', isPending: false, items: [] };
  const decline = {
    id: 'd-1', type: 'TRADE_DECLINE', status: 'EXECUTED', executionType: 'EXECUTE', isPending: false,
    teamId: 7, relatedTransactionId: 'p-1', proposedDate: T0 + 3_600_000, items: [],
  };
  collect(4, 2026, [resolved, decline], '2026-09-20T16:05:00Z');
  assert.equal(row(`SELECT items_json FROM league_transactions_raw WHERE tx_id = 'p-1'`).items_json, '[]',
    'precondition: the raw row lost its items, which is the failure being fixed');

  const result = linkTradeOutcomes(4, 2026, '2026-09-20T16:05:00Z');
  assert.equal(result.linked, 1);
  assert.equal(result.missing, 0);

  const l = link(4, 2026, 'd-1');
  assert.equal(l.link_state, 'linked');
  assert.equal(l.proposal_tx_id, 'p-1');
  assert.equal(l.resolution, 'declined');
  assert.equal(l.missing_reason, null);

  const s = snap(4, 2026, 'p-1');
  assert.deepEqual(JSON.parse(s.items_json), offerItems, 'the offered players are still known');
  assert.equal(s.captured_from, 'pending', 'the first sighting still names how it was captured');
  assert.equal(s.resolution, 'declined');
  assert.equal(s.resolution_tx_id, 'd-1');
  assert.equal(s.resolved_at, iso(T0 + 3_600_000));
});

test('S2b: an accept outranks the proposer-side close record, and a veto outranks the accept', () => {
  const p = { ...pending, id: 'p-2' };
  collect(4, 2026, [p], '2026-09-21T10:00:00Z');
  collect(4, 2026, [
    { id: 'c-2', type: 'TRADE_PROPOSAL', status: 'CANCELED', executionType: 'CANCEL', teamId: 3,
      relatedTransactionId: 'p-2', proposedDate: T0 + 10, items: [] },
    { id: 'a-2', type: 'TRADE_ACCEPT', status: 'EXECUTED', executionType: 'EXECUTE', teamId: 7,
      relatedTransactionId: 'p-2', proposedDate: T0 + 20, items: [] },
  ], '2026-09-21T11:00:00Z');
  linkTradeOutcomes(4, 2026, '2026-09-21T11:00:00Z');
  assert.equal(snap(4, 2026, 'p-2').resolution, 'accepted');
  assert.equal(link(4, 2026, 'c-2').resolution, 'closed');

  collect(4, 2026, [{ id: 'v-2', type: 'TRADE_VETO', status: 'EXECUTED', executionType: 'EXECUTE',
    teamId: 5, relatedTransactionId: 'p-2', proposedDate: T0 + 30, items: [] }], '2026-09-21T12:00:00Z');
  linkTradeOutcomes(4, 2026, '2026-09-21T12:00:00Z');
  assert.equal(snap(4, 2026, 'p-2').resolution, 'vetoed');
  assert.equal(link(4, 2026, 'v-2').link_state, 'linked');
});

/* --------------------------------------------------------------- S3 */

test('S3: a decision with no captured proposal is typed proposal_missing, not dropped', () => {
  collect(4, 2026, [
    { id: 'd-9', type: 'TRADE_DECLINE', status: 'EXECUTED', executionType: 'EXECUTE', teamId: 7,
      relatedTransactionId: 'p-never', proposedDate: T0, items: [] },
    { id: 'd-10', type: 'TRADE_DECLINE', status: 'EXECUTED', executionType: 'EXECUTE', teamId: 7,
      proposedDate: T0, items: [] },
  ], '2026-09-22T09:00:00Z');
  // A proposal row that exists but whose items were already empty when first stored.
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, team_id,
         is_pending, items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (4, 2026, 'p-empty', 'TRADE_PROPOSAL', 'CANCELED', 'EXECUTE', 3, 0, '[]', '{}', 'x', 'x')`);
  collect(4, 2026, [{ id: 'a-11', type: 'TRADE_ACCEPT', status: 'EXECUTED', executionType: 'EXECUTE',
    teamId: 7, relatedTransactionId: 'p-empty', proposedDate: T0, items: [] }], '2026-09-22T09:00:00Z');

  const r = linkTradeOutcomes(4, 2026, '2026-09-22T09:00:00Z');
  assert.ok(r.missing >= 3);
  assert.equal(link(4, 2026, 'd-9').link_state, 'proposal_missing');
  assert.equal(link(4, 2026, 'd-9').missing_reason, 'proposal_never_captured');
  assert.equal(link(4, 2026, 'd-9').related_tx_id, 'p-never');
  assert.equal(link(4, 2026, 'd-10').missing_reason, 'no_related_tx_id');
  assert.equal(link(4, 2026, 'a-11').missing_reason, 'proposal_items_empty');
  assert.equal(r.byReason.proposal_never_captured, 1);
  assert.deepEqual([...MISSING_REASONS].sort(),
    ['no_related_tx_id', 'proposal_items_empty', 'proposal_never_captured']);

  // The schema refuses an untyped miss and a linked row that carries a reason.
  assert.throws(() => run(`INSERT INTO trade_outcome_links (league_id, season, outcome_tx_id, outcome_type,
      resolution, link_state, missing_reason, recorded_at, updated_at)
      VALUES (4, 2026, 'bad', 'TRADE_DECLINE', 'declined', 'proposal_missing', NULL, 'x', 'x')`), /CHECK/);
  assert.throws(() => run(`INSERT INTO trade_outcome_links (league_id, season, outcome_tx_id, outcome_type,
      resolution, link_state, missing_reason, recorded_at, updated_at)
      VALUES (4, 2026, 'bad', 'TRADE_DECLINE', 'declined', 'linked', 'no_related_tx_id', 'x', 'x')`), /CHECK/);
});

test('S3b: re-linking is idempotent, and a miss becomes linked once its proposal arrives', () => {
  const before = rows(`SELECT COUNT(*) n FROM trade_outcome_links`)[0].n;
  linkTradeOutcomes(4, 2026, '2026-09-22T10:00:00Z');
  assert.equal(rows(`SELECT COUNT(*) n FROM trade_outcome_links`)[0].n, before, 'no duplicate links');

  collect(4, 2026, [{ ...pending, id: 'p-never', isPending: false, status: 'CANCELED' }], '2026-09-22T11:00:00Z');
  linkTradeOutcomes(4, 2026, '2026-09-22T11:00:00Z');
  const l = link(4, 2026, 'd-9');
  assert.equal(l.link_state, 'linked');
  assert.equal(l.missing_reason, null);
  assert.equal(snap(4, 2026, 'p-never').captured_from, 'resolved',
    'first seen already resolved: the terms are ESPN\'s, but not a pending-time capture');
});

/* --------------------------------------------------------------- S4 */

test('S4: backfill turns raw proposal rows with items into raw_backfill snapshots and links their decisions', () => {
  const items = JSON.stringify(offerItems);
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, team_id,
         proposed_at, is_pending, items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (2, 2026, 'old-p', 'TRADE_PROPOSAL', 'CANCELED', 'EXECUTE', 3, '2026-09-15T00:00:00Z', 0, ?, '{}', 'x', 'x'),
              (2, 2026, 'old-d', 'TRADE_DECLINE', 'EXECUTED', 'EXECUTE', 7, '2026-09-15T02:00:00Z', 0, '[]', '{}', 'x', 'x')`,
  items);
  run(`UPDATE league_transactions_raw SET related_tx_id = 'old-p' WHERE league_id = 2 AND tx_id = 'old-d'`);
  const r = linkTradeOutcomes(2, 2026, '2026-09-24T00:00:00Z');
  assert.equal(r.backfilled, 1);
  assert.equal(snap(2, 2026, 'old-p').captured_from, 'raw_backfill');
  assert.equal(link(2, 2026, 'old-d').link_state, 'linked');
  // Other leagues' rows are untouched by a league-2 run.
  assert.equal(rows(`SELECT COUNT(*) n FROM trade_outcome_links WHERE league_id = 2`)[0].n, 1);
});

test('S4b: the linker says which absence it is when the raw table has never been created', () => {
  db.exec('ALTER TABLE league_transactions_raw RENAME TO ltr_hidden');
  try {
    const r = linkTradeOutcomes(4, 2026, 'x');
    assert.equal(r.state, 'raw_table_absent');
  } finally {
    db.exec('ALTER TABLE ltr_hidden RENAME TO league_transactions_raw');
  }
});

/* --------------------------------------------------------------- S5 */

test('S5: the focus-league poll spawns the collector for that league only', () => {
  const calls = [];
  const lines = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: 'league 4 X: 3 in window, 1 new, 90 stored\ntransactions: seen 3, new 1, failed 0\n', stderr: '' };
  };
  LOOP.focusTradesPoll({ leagueId: 4, spawn, log: l => lines.push(l) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args,
    ['--env-file-if-exists=.env', 'scripts/collect-league-transactions.mjs', '--league', '4']);
  assert.match(lines[0], /league_tx_focus\s+ok/);
});

test('S5b: the poller fires on its own cadence between ticks, and 0 turns it off', () => {
  let now = 0;
  const fired = [];
  const poller = LOOP.createFocusPoller({ leagueId: 4, pollSeconds: 180, clock: () => now,
    poll: o => fired.push(o.leagueId) });
  poller.maybePoll();                     // the tick itself just captured; not due yet
  assert.equal(fired.length, 0);
  now = 179_000; poller.maybePoll();
  assert.equal(fired.length, 0);
  now = 180_000; poller.maybePoll();
  assert.deepEqual(fired, [4]);
  now = 200_000; poller.maybePoll();
  assert.equal(fired.length, 1);
  poller.tickRan(); now = 300_000; poller.maybePoll();
  assert.equal(fired.length, 1, 'a full tick resets the clock: it already polled every league');

  const off = LOOP.createFocusPoller({ leagueId: 4, pollSeconds: 0, clock: () => 1e12, poll: () => fired.push('x') });
  off.maybePoll();
  assert.equal(fired.length, 1);
  const none = LOOP.createFocusPoller({ leagueId: null, pollSeconds: 60, clock: () => 1e12, poll: () => fired.push('y') });
  none.maybePoll();
  assert.equal(fired.length, 1);
});
