import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern as the rest of the suite.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-espn-draft-sync-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, row, run } = await import('../server/db/index.js');
// espnCookies() reads app_settings, created by claude.js's import-time db.exec().
await import('../server/services/claude.js');
const { ensureLiveDraft, syncLiveDraft } = await import('../server/services/espn-draft.js');
const { openQuarantine } = await import('../server/services/draft-reconcile.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const SEASON = 2026;
const PICK_ORDER = [10, 20, 30, 40];

// Each test gets its own league_id — leagues has UNIQUE(platform, league_id, season)
// and every test in this file shares one database.
let leagueCounter = 0;
function makeLeague() {
  leagueCounter += 1;
  const leagueId = String(5550000 + leagueCounter);
  run(`INSERT INTO leagues (platform, league_id, season, name, my_team_id, espn_s2, swid, team_count)
       VALUES ('espn', ?, ?, 'Test League', 10, 'fake-s2', 'fake-swid', 4)`, leagueId, SEASON);
  return row('SELECT last_insert_rowid() AS id').id;
}

function espnSnapshot({ picks = [], inProgress = true, drafted = false } = {}) {
  return {
    settings: {
      draftSettings: { pickOrder: PICK_ORDER, timePerSelection: 90, date: Date.UTC(2026, 7, 26) },
      rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6 } },
    },
    teams: PICK_ORDER.map(id => ({ id, name: `Team ${id}` })),
    draftDetail: { inProgress, drafted, picks },
  };
}

// Stub fetch to serve a mutable snapshot object so each test can change what "ESPN"
// returns between polls without re-stubbing.
function stubEspn(getSnapshot) {
  globalThis.fetch = async () => ({ ok: true, json: async () => getSnapshot() });
}

function knownPlayer(name, espnId) {
  run(`INSERT INTO players (name, position, fantasy_relevant, espn_id) VALUES (?, 'WR', 1, ?)`, name, espnId);
}

test('linking a league with no draft activity yet creates a draft with zero mirrored picks', async () => {
  const leagueRowId = makeLeague();
  stubEspn(() => espnSnapshot({ picks: [], inProgress: false }));
  const { draft_id, created } = await ensureLiveDraft(leagueRowId);
  assert.equal(created, true);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draft_id).length, 0);
});

test('linking the same league twice reuses the same draft instead of creating a duplicate', async () => {
  const leagueRowId = makeLeague();
  stubEspn(() => espnSnapshot({ picks: [] }));
  const first = await ensureLiveDraft(leagueRowId);
  const second = await ensureLiveDraft(leagueRowId);
  assert.equal(first.draft_id, second.draft_id);
  assert.equal(second.created, false);
});

test('a poll with new picks mirrors them and reports the authoritative next pick', async () => {
  const leagueRowId = makeLeague();
  knownPlayer('Player One', 101);
  stubEspn(() => espnSnapshot({ picks: [] }));
  const { draft_id } = await ensureLiveDraft(leagueRowId);

  stubEspn(() => espnSnapshot({ picks: [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }] }));
  const result = await syncLiveDraft(draft_id);
  assert.deepEqual(result.new_picks, [1]);
  assert.equal(result.picks_mirrored, 1);
  assert.equal(result.next_pick, 2, 'next pick must be ESPNs authoritative count + 1');
  assert.equal(result.desynced, false);
});

test('an unresolvable player is quarantined and surfaced as desynced, without crashing the poll', async () => {
  const leagueRowId = makeLeague();
  stubEspn(() => espnSnapshot({ picks: [] }));
  const { draft_id } = await ensureLiveDraft(leagueRowId);

  // playerId 9999 is not a known local player and (with fetch stubbed to always
  // return this same draft snapshot) never resolves via ESPN's player pool either.
  stubEspn(() => espnSnapshot({ picks: [{ overallPickNumber: 1, playerId: 9999, teamId: 10, keeper: false }] }));
  const result = await syncLiveDraft(draft_id);
  assert.equal(result.picks_mirrored, 0);
  assert.equal(result.desynced, true);
  assert.equal(result.unresolved_count, 1);
  assert.equal(openQuarantine(draft_id).length, 1);
  assert.equal(rows('SELECT * FROM players WHERE name LIKE ?', '%9999%').length, 0, 'must not fabricate a player row');
});

test('a transient empty ESPN response after picks already exist does not wipe the mirrored board', async () => {
  const leagueRowId = makeLeague();
  knownPlayer('Player One', 101);
  stubEspn(() => espnSnapshot({ picks: [] }));
  const { draft_id } = await ensureLiveDraft(leagueRowId);

  stubEspn(() => espnSnapshot({ picks: [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }] }));
  await syncLiveDraft(draft_id);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draft_id).length, 1);

  // Simulate a broken/incomplete ESPN response: draftDetail.picks comes back empty
  // even though the draft is still in progress and we already mirrored a real pick.
  stubEspn(() => espnSnapshot({ picks: [] }));
  const result = await syncLiveDraft(draft_id);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draft_id).length, 1,
    'the previously mirrored pick must survive a suspicious empty response');
  assert.equal(result.picks_mirrored, 1);
});

test('draft completion is reported and reflected in the drafts table status', async () => {
  const leagueRowId = makeLeague();
  knownPlayer('Player One', 101);
  stubEspn(() => espnSnapshot({ picks: [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], drafted: false }));
  const { draft_id } = await ensureLiveDraft(leagueRowId);
  await syncLiveDraft(draft_id);
  assert.equal(row('SELECT status FROM drafts WHERE id=?', draft_id).status, 'active');

  stubEspn(() => espnSnapshot({ picks: [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], drafted: true, inProgress: false }));
  const result = await syncLiveDraft(draft_id);
  assert.equal(result.espn_complete, true);
  assert.equal(row('SELECT status FROM drafts WHERE id=?', draft_id).status, 'complete');
});

test('concurrent syncs for the same draft do not race — only one poll is in flight at a time', async () => {
  const leagueRowId = makeLeague();
  knownPlayer('Player One', 101);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await new Promise(r => setTimeout(r, 20));
    return { ok: true, json: async () => espnSnapshot({ picks: [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }] }) };
  };
  const { draft_id } = await ensureLiveDraft(leagueRowId);
  fetchCalls = 0;
  const [a, b] = await Promise.all([syncLiveDraft(draft_id), syncLiveDraft(draft_id)]);
  assert.deepEqual(a, b, 'both callers must observe the same in-flight result, not two independent polls');
  assert.equal(fetchCalls, 1, 'only one ESPN request should have gone out for the overlapping calls');
});
