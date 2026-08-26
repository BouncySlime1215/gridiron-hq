import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-reconcile-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'reconcile.sqlite');

const { db, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { syncLiveDraft, normalizeAuthoritativeSnapshot } = await import('../server/services/espn-draft.js');

const originalFetch = global.fetch;
let payload;
let fetchCalls;

function slot(number, playerId = -1, teamId = number % 2 ? 11 : 22, keeper = false) {
  return { overallPickNumber: number, playerId, teamId, keeper };
}

function snapshot(picks, overrides = {}) {
  const filled = new Map(picks.map(pick => [pick.overallPickNumber, pick]));
  return {
    id: 4242, seasonId: 2026,
    settings: { size: 2, draftSettings: { numberOfRounds: 2, pickOrder: [11, 22] } },
    teams: [{ id: 11 }, { id: 22 }],
    draftDetail: {
      inProgress: true, drafted: false,
      picks: [1, 2, 3, 4].map(number => filled.get(number) ?? slot(number))
    },
    ...overrides
  };
}

function board(draftId = 100) {
  return rows(`SELECT dp.pick_number, p.espn_id AS player_id, dp.espn_team_id,
    dp.team_slot, dp.keeper, dp.source FROM draft_picks dp
    JOIN players p ON p.id=dp.player_id WHERE dp.draft_id=? ORDER BY dp.pick_number`, draftId)
    .map(pick => ({ ...pick, espn_team_id: Number(pick.espn_team_id) }));
}

before(() => {
  db.prepare(`INSERT INTO users(id,subject,display_name) VALUES (1,'reconcile','Reconcile')`).run();
  db.prepare(`INSERT INTO leagues(id,platform,league_id,season,name,espn_s2,swid,team_count)
    VALUES (90,'espn','4242',2026,'Reconcile League','secret','{owner}',2)`).run();
  for (const [id, espnId] of [[201, 1001], [202, 1002], [203, 1003], [204, 1004]]) {
    db.prepare(`INSERT INTO players(id,name,position,espn_id,fantasy_relevant)
      VALUES (?,?, 'WR', ?, 1)`).run(id, `Player ${espnId}`, espnId);
  }
});

beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fail_espn_reconcile;
    DELETE FROM draft_picks; DELETE FROM drafts;`);
  db.prepare(`INSERT INTO drafts(id,name,type,team_count,rounds,my_slot,status,league_row_id,
    espn_league_id,season,pick_order)
    VALUES (100,'ESPN live','live',2,2,1,'active',90,'4242',2026,
      '{"order":["11","22"],"team_names":{"11":"One","22":"Two"}}')`).run();
  payload = snapshot([slot(1, 1001, 11)]);
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => structuredClone(payload) };
  };
});

after(() => {
  global.fetch = originalFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('one reconciliation exactly applies corrections, removals, renumbering, traded rosters, keepers, and out-of-order input', async () => {
  payload = snapshot([slot(1, 1001, 11), slot(2, 1002, 22), slot(3, 1003, 11)]);
  await syncLiveDraft(100);

  payload = snapshot([
    slot(2, 1004, 11, true), // replacement assigned to a traded recipient
    slot(1, 1002, 22) // player 1002 moved from pick 2 to pick 1
  ]);
  const result = await syncLiveDraft(100);
  assert.deepEqual(result.changed_picks, [1, 2, 3]);
  assert.deepEqual(board(), [
    { pick_number: 1, player_id: 1002, espn_team_id: 22, team_slot: 2, keeper: 0, source: 'espn' },
    { pick_number: 2, player_id: 1004, espn_team_id: 11, team_slot: 1, keeper: 1, source: 'espn' }
  ]);
  assert.equal(row('SELECT espn_snapshot_pick_count n FROM drafts WHERE id=100').n, 2);
});

test('wrong local roster assignment is repaired even when the snapshot hash is unchanged', async () => {
  const first = await syncLiveDraft(100);
  db.prepare(`UPDATE draft_picks SET team_slot=2, espn_team_id=22 WHERE draft_id=100`).run();
  const repaired = await syncLiveDraft(100);
  assert.deepEqual(board(), [
    { pick_number: 1, player_id: 1001, espn_team_id: 11, team_slot: 1, keeper: 0, source: 'espn' }
  ]);
  assert.equal(repaired.board_revision, first.board_revision + 1);
});

test('three identical snapshots are idempotent with no row or board revision churn', async () => {
  const first = await syncLiveDraft(100);
  const before = board();
  const pickRow = row('SELECT id,created_at FROM draft_picks WHERE draft_id=100');
  const second = await syncLiveDraft(100);
  const third = await syncLiveDraft(100);
  assert.equal(second.idempotent, true);
  assert.equal(third.idempotent, true);
  assert.equal(first.board_revision, second.board_revision);
  assert.equal(second.board_revision, third.board_revision);
  assert.deepEqual(board(), before);
  assert.deepEqual(row('SELECT id,created_at FROM draft_picks WHERE draft_id=100'), pickRow);
});

test('malformed and inconsistent snapshots preserve the prior valid board with zero mutations', async () => {
  await syncLiveDraft(100);
  const beforeBoard = board();
  const beforeDraft = row('SELECT status,last_synced_at,espn_snapshot_hash,espn_board_revision FROM drafts WHERE id=100');
  const invalid = [
    { id: 4242, seasonId: 2026, settings: {}, teams: [], draftDetail: {} },
    snapshot([slot(1, 1001, 99)]),
    snapshot([slot(1, 1001, 11), slot(2, 1001, 22)]),
    snapshot([slot(1, 1001, 11), slot(3, 1002, 11)]),
    { ...snapshot([slot(1, 1001, 11)]), draftDetail: { inProgress: true, drafted: false,
      picks: [slot(1, 1001, 11), slot(2)] } },
    { ...snapshot([slot(1, 1001, 11)]), settings: { draftSettings: { numberOfRounds: 2, pickOrder: [11, 11] } } }
  ];
  for (const candidate of invalid) {
    payload = candidate;
    await assert.rejects(() => syncLiveDraft(100), error => error.code === 'ESPN_INVALID_SNAPSHOT');
    assert.deepEqual(board(), beforeBoard);
    assert.deepEqual(row('SELECT status,last_synced_at,espn_snapshot_hash,espn_board_revision FROM drafts WHERE id=100'), beforeDraft);
  }
});

test('an injected database failure rolls back picks, player mappings, and draft metadata', async () => {
  await syncLiveDraft(100);
  const beforeBoard = board();
  const beforeDraft = row('SELECT status,last_synced_at,espn_snapshot_hash,espn_snapshot_pick_count,espn_board_revision FROM drafts WHERE id=100');
  payload = snapshot([slot(1, 1002, 22), slot(2, 1003, 11)]);
  db.exec(`CREATE TRIGGER fail_espn_reconcile BEFORE INSERT ON draft_picks
    WHEN NEW.draft_id=100 BEGIN SELECT RAISE(ABORT, 'injected reconciliation failure'); END;`);
  await assert.rejects(() => syncLiveDraft(100), /injected reconciliation failure/);
  assert.deepEqual(board(), beforeBoard);
  assert.deepEqual(row('SELECT status,last_synced_at,espn_snapshot_hash,espn_snapshot_pick_count,espn_board_revision FROM drafts WHERE id=100'), beforeDraft);
});

test('concurrent sync callers share one serialized fetch and reconciliation result', async () => {
  let release;
  global.fetch = () => {
    fetchCalls += 1;
    return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => structuredClone(payload) }); });
  };
  const calls = [syncLiveDraft(100), syncLiveDraft(100), syncLiveDraft(100), syncLiveDraft(100)];
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all(calls);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(results.slice(1), [results[0], results[0], results[0]]);
  assert.equal(row('SELECT COUNT(*) n FROM draft_picks WHERE draft_id=100').n, 1);
});

test('pure snapshot normalization rejects duplicate pick numbers before database access', () => {
  const candidate = snapshot([slot(1, 1001, 11)]);
  candidate.draftDetail.picks[1].overallPickNumber = 1;
  assert.throws(() => normalizeAuthoritativeSnapshot(candidate, { team_count: 2, rounds: 2 }),
    error => error.code === 'ESPN_INVALID_SNAPSHOT');
});
