import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern as test/fantasy-workflows.test.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-reconcile-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, row, run } = await import('../server/db/index.js');
// espn-draft.js's import-time migration adds drafts.espn_league_id/season/etc and
// draft_picks.espn_team_id/keeper — import it for that side effect, same pattern as
// test/espn-connect.test.js importing claude.js for app_settings.
await import('../server/services/espn-draft.js');
const { reconcileDraftBoard, openQuarantine, correctionHistory } = await import('../server/services/draft-reconcile.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- setup */

function makePlayer(name) {
  run(`INSERT INTO players (name, position, fantasy_relevant) VALUES (?, 'WR', 1)`, name);
  return row('SELECT last_insert_rowid() AS id').id;
}

function makeDraft() {
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, status, espn_league_id, season)
       VALUES ('test live draft', 'live', 4, 3, 1, 'active', '999', 2026)`);
  return row('SELECT last_insert_rowid() AS id').id;
}

// A minimal, realistic 4-team pick order and player pool for every test below.
const SLOT_OF = new Map([[10, 1], [20, 2], [30, 3], [40, 4]]);

test('a fresh reconciliation inserts every resolvable pick exactly once', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Player One'), p2 = makePlayer('Player Two');
  const idMap = new Map([[101, p1], [102, p2]]);
  const made = [
    { overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false },
    { overallPickNumber: 2, playerId: 102, teamId: 20, keeper: false },
  ];
  const result = reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-1');
  assert.deepEqual(result.added, [1, 2]);
  assert.equal(result.corrected.length, 0);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId).length, 2);
});

test('replaying an identical snapshot produces zero mutations and zero new audit rows', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Player One');
  const idMap = new Map([[101, p1]]);
  const made = [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }];

  const first = reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-1');
  assert.deepEqual(first.added, [1]);
  const auditCountAfterFirst = correctionHistory(draftId).length;

  const second = reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-2');
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.corrected, []);
  assert.deepEqual(second.removed, []);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId).length, 1);
  assert.equal(correctionHistory(draftId).length, auditCountAfterFirst, 'no new audit rows on identical replay');
});

test('a pick renumbered by ESPN moves instead of duplicating, and is audited', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Player One');
  const idMap = new Map([[101, p1]]);

  reconcileDraftBoard(draftId, [{ overallPickNumber: 3, playerId: 101, teamId: 10, keeper: false }], idMap, SLOT_OF, 'snap-1');
  assert.equal(row('SELECT pick_number FROM draft_picks WHERE player_id=?', p1).pick_number, 3);

  const result = reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], idMap, SLOT_OF, 'snap-2');
  assert.deepEqual(result.corrected, [1]);
  const picks = rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId);
  assert.equal(picks.length, 1, 'renumber must not leave a duplicate row');
  assert.equal(picks[0].pick_number, 1);

  const audit = correctionHistory(draftId);
  assert.equal(audit.filter(a => a.reason === 'renumbered').length, 1);
});

test('a corrected player at the same pick number updates in place and is audited', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Wrong Player'), p2 = makePlayer('Right Player');
  const idMap = new Map([[101, p1], [102, p2]]);

  reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], idMap, SLOT_OF, 'snap-1');
  const result = reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 102, teamId: 10, keeper: false }], idMap, SLOT_OF, 'snap-2');

  assert.deepEqual(result.corrected, [1]);
  const pick = row('SELECT * FROM draft_picks WHERE draft_id=? AND pick_number=1', draftId);
  assert.equal(pick.player_id, p2);
  const audit = correctionHistory(draftId);
  const entry = audit.find(a => a.reason === 'corrected');
  assert.ok(entry, 'a correction audit row must exist');
  assert.equal(JSON.parse(entry.previous_state).player_id, p1);
  assert.equal(JSON.parse(entry.corrected_state).player_id, p2);
});

test('a team correction (traded pick ownership) at the same pick number is audited', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Player One');
  const idMap = new Map([[101, p1]]);

  reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], idMap, SLOT_OF, 'snap-1');
  const result = reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 20, keeper: false }], idMap, SLOT_OF, 'snap-2');

  assert.deepEqual(result.corrected, [1]);
  const pick = row('SELECT * FROM draft_picks WHERE draft_id=? AND pick_number=1', draftId);
  assert.equal(pick.team_slot, 2);
  assert.equal(pick.espn_team_id, 20);
});

test('an unmapped ESPN team is quarantined, never assigned a guessed slot', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Player One');
  const idMap = new Map([[101, p1]]);

  const result = reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 999, keeper: false }], idMap, SLOT_OF, 'snap-1');
  assert.equal(result.added.length, 0);
  assert.equal(result.quarantined.length, 1);
  assert.match(result.quarantined[0].reason, /not in pick order/);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId).length, 0, 'no fabricated pick row');
  const q = openQuarantine(draftId);
  assert.equal(q.length, 1);
  assert.equal(q[0].espn_team_id, 999);
});

test('an unresolved player is quarantined, never assigned a fabricated position', () => {
  const draftId = makeDraft();
  const idMap = new Map(); // nothing resolves

  const result = reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 555, teamId: 10, keeper: false }], idMap, SLOT_OF, 'snap-1');
  assert.equal(result.quarantined.length, 1);
  assert.match(result.quarantined[0].reason, /could not be resolved/);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId).length, 0);
  assert.equal(rows('SELECT * FROM players WHERE name LIKE ?', '%555%').length, 0, 'must not fabricate a placeholder player row');
});

test('a later-resolved quarantined pick clears from quarantine and is mirrored', () => {
  const draftId = makeDraft();
  const idMap1 = new Map();
  reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 555, teamId: 10, keeper: false }], idMap1, SLOT_OF, 'snap-1');
  assert.equal(openQuarantine(draftId).length, 1);

  const p1 = makePlayer('Now Resolvable');
  const idMap2 = new Map([[555, p1]]);
  const result = reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 555, teamId: 10, keeper: false }], idMap2, SLOT_OF, 'snap-2');

  assert.deepEqual(result.added, [1]);
  assert.equal(openQuarantine(draftId).length, 0, 'resolved entry must clear from open quarantine');
});

test('repeated attempts on an unresolved pick accumulate attempt_count instead of duplicating quarantine rows', () => {
  const draftId = makeDraft();
  const idMap = new Map();
  const made = [{ overallPickNumber: 1, playerId: 555, teamId: 10, keeper: false }];
  reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-1');
  reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-2');
  reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-3');

  const q = openQuarantine(draftId);
  assert.equal(q.length, 1, 'must not create a new row per attempt');
  assert.equal(q[0].attempt_count, 3);
});

test('a stale local pick that ESPN no longer reports is removed and audited', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Player One');
  const idMap = new Map([[101, p1]]);
  reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], idMap, SLOT_OF, 'snap-1');

  const result = reconcileDraftBoard(draftId, [], idMap, SLOT_OF, 'snap-2');
  assert.deepEqual(result.removed, [1]);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId).length, 0);
  assert.ok(correctionHistory(draftId).some(a => a.reason === 'removed-stale'));
});

test('a keeper pick is mirrored with its keeper flag set', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Keeper Player');
  const idMap = new Map([[101, p1]]);
  reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: true }], idMap, SLOT_OF, 'snap-1');
  const pick = row('SELECT * FROM draft_picks WHERE draft_id=? AND pick_number=1', draftId);
  assert.equal(pick.keeper, 1);
});

test('two different drafts stay fully isolated from each other', () => {
  const draftA = makeDraft(), draftB = makeDraft();
  const p1 = makePlayer('Shared Name Not Player'); // distinct player rows, but exercising cross-draft isolation
  const p2 = makePlayer('Other Player');
  reconcileDraftBoard(draftA, [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], new Map([[101, p1]]), SLOT_OF, 'snap-1');
  reconcileDraftBoard(draftB, [{ overallPickNumber: 1, playerId: 102, teamId: 10, keeper: false }], new Map([[102, p2]]), SLOT_OF, 'snap-1');

  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftA).length, 1);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftB).length, 1);
  assert.equal(row('SELECT * FROM draft_picks WHERE draft_id=?', draftA).player_id, p1);
  assert.equal(row('SELECT * FROM draft_picks WHERE draft_id=?', draftB).player_id, p2);
});

test('the same player renumbered within one snapshot is handled as a graceful move, not a crash', () => {
  // One player claiming two different pick numbers inside a single ESPN response is
  // unusual, but the engine treats the second sighting as a renumber of the first
  // (via the byPlayer map, kept live across the whole pass) rather than attempting a
  // second INSERT that would collide with UNIQUE(draft_id, player_id).
  const draftId = makeDraft();
  const p1 = makePlayer('Renumbered Within Snapshot');
  const idMap = new Map([[101, p1]]);
  const made = [
    { overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false },
    { overallPickNumber: 2, playerId: 101, teamId: 10, keeper: false },
  ];
  assert.doesNotThrow(() => reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-1'));
  const picks = rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId);
  assert.equal(picks.length, 1, 'must end with exactly one row for this player, not two');
  assert.equal(picks[0].pick_number, 2, 'the later sighting in the snapshot wins');
});

test('a genuine SQL-level failure mid-reconciliation rolls back the entire transaction, not just the failing write', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Established Player');
  const idMap1 = new Map([[101, p1]]);
  reconcileDraftBoard(draftId, [{ overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false }], idMap1, SLOT_OF, 'snap-1');
  const before = row('SELECT * FROM draft_picks WHERE draft_id=? AND pick_number=1', draftId);
  assert.equal(before.espn_team_id, 10);

  const p2 = makePlayer('New Player');
  const idMap2 = new Map([[101, p1], [102, p2]]);
  const made = [
    { overallPickNumber: 1, playerId: 101, teamId: 20, keeper: false }, // a real, valid correction that WOULD apply
    { overallPickNumber: null, playerId: 102, teamId: 10, keeper: false }, // forces a real NOT NULL constraint failure
  ];
  assert.throws(() => reconcileDraftBoard(draftId, made, idMap2, SLOT_OF, 'snap-2'), /NOT NULL/i);

  const after = row('SELECT * FROM draft_picks WHERE draft_id=? AND pick_number=1', draftId);
  assert.equal(after.espn_team_id, 10, 'the valid correction earlier in the same transaction must NOT have stuck around after the later write failed');
  assert.equal(correctionHistory(draftId).length, 0, 'no audit row for the correction that got rolled back');
});

test('the exact same pick repeated twice in one snapshot (a redundant ESPN entry) is a harmless no-op', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('Player One');
  const idMap = new Map([[101, p1]]);
  const made = [
    { overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false },
    { overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false },
  ];
  const result = reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-1');
  assert.deepEqual(result.added, [1]);
  assert.equal(rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId).length, 1);
});

test('two different players claiming the same pick number in one snapshot are quarantined, not guessed', () => {
  const draftId = makeDraft();
  const p1 = makePlayer('First Claimant'), p2 = makePlayer('Second Claimant');
  const idMap = new Map([[101, p1], [102, p2]]);
  const made = [
    { overallPickNumber: 1, playerId: 101, teamId: 10, keeper: false },
    { overallPickNumber: 1, playerId: 102, teamId: 10, keeper: false },
  ];
  const result = reconcileDraftBoard(draftId, made, idMap, SLOT_OF, 'snap-1');
  assert.deepEqual(result.added, [1]);
  assert.equal(result.quarantined.length, 1);
  assert.match(result.quarantined[0].reason, /duplicate pick number/);
  const picks = rows('SELECT * FROM draft_picks WHERE draft_id=?', draftId);
  assert.equal(picks.length, 1, 'only the first claimant should be mirrored, never both');
});
