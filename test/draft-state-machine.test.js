import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Same isolated-DB pattern as the other test files: point GRIDIRON_DB_PATH at a
// throwaway file before anything imports server/db/index.js.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-draft-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const {
  makePick, undoLastPick, redoLastUndo, correctLastPick, setPaused,
  getQueue, setQueue, firstAvailableFromQueue, autoPickOverdueDrafts,
  DraftValidationError, DraftConflictError
} = await import('../server/draft/store.js');
const { totalPicks } = await import('../server/draft/engine.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

await runMigrations();
seedIfEmpty();

function makeDraft({ team_count = 4, rounds = 3, my_slot = 1, order_type = 'snake', roster_positions = null } = {}) {
  run(`INSERT INTO drafts (name, type, team_count, rounds, my_slot, pick_seconds, order_type, roster_positions)
       VALUES ('t', 'mock', ?, ?, ?, 90, ?, ?)`,
    team_count, rounds, my_slot, order_type, roster_positions ? JSON.stringify(roster_positions) : null);
  return row('SELECT * FROM drafts WHERE id = last_insert_rowid()');
}

function draftablePlayers(n) {
  return rows('SELECT id FROM players WHERE fantasy_relevant = 1 LIMIT ?', n).map(p => p.id);
}

/* --------------------------------------------------------------- basic pick */

test('makePick inserts the pick, bumps revision, and advances the clock', () => {
  const draft = makeDraft();
  const [p1] = draftablePlayers(1);
  const before = draft.revision;
  const { pick, draft: after } = makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  assert.equal(pick.pick_number, 1);
  assert.equal(pick.team_slot, 1);
  assert.equal(after.revision, before + 1);
  assert.ok(after.turn_deadline, 'a durable server-owned deadline should be set for the next pick');
});

/* ---------------------------------------------------------- duplicate picks */

test('a duplicate pick of the same player is rejected, not silently accepted twice', () => {
  const draft = makeDraft();
  const [p1] = draftablePlayers(1);
  makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  assert.throws(
    () => makePick({ draftId: draft.id, playerId: p1 }),
    DraftValidationError
  );
  const count = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ? AND player_id = ?', draft.id, p1).n;
  assert.equal(count, 1, 'the player must only be drafted once');
});

/* ---------------------------------- "concurrent" picks: two racing requests */

test('two requests racing for the same player both starting from the same board: only one wins', () => {
  const draft = makeDraft();
  const [p1] = draftablePlayers(1);
  // Simulates two browser tabs that both read the board at revision R and
  // both fire a pick for the same player before either response comes back.
  const first = makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  assert.equal(first.replayed, false);
  assert.throws(
    () => makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision }),
    // the second request's expectedRevision is now stale, since the first
    // request already advanced the draft
    DraftConflictError
  );
});

/* -------------------------------------------------------------- stale picks */

test('a stale expected_revision is rejected even for a different, still-available player', () => {
  const draft = makeDraft();
  const [p1, p2] = draftablePlayers(2);
  const staleRevision = draft.revision;
  makePick({ draftId: draft.id, playerId: p1, expectedRevision: staleRevision });
  assert.throws(
    () => makePick({ draftId: draft.id, playerId: p2, expectedRevision: staleRevision }),
    DraftConflictError,
    'the client had not seen pick 1 yet, so its request must be rejected as stale, not silently applied'
  );
});

/* ------------------------------------------------------------- idempotency */

test('retrying the same pick with the same idempotency key replays the original result', () => {
  const draft = makeDraft();
  const [p1] = draftablePlayers(1);
  const key = 'client-generated-uuid-1';
  const first = makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision, idempotencyKey: key });
  const retry = makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision, idempotencyKey: key });
  assert.equal(retry.replayed, true);
  assert.equal(retry.pick.id, first.pick.id);
  const count = row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n;
  assert.equal(count, 1, 'a retried request must never create a second pick');
});

/* -------------------------------------------------- draft-complete rejection */

test('a pick submitted after the draft is complete is rejected', () => {
  const draft = makeDraft({ team_count: 2, rounds: 1 });
  const [p1, p2, p3] = draftablePlayers(3);
  const r1 = makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  const r2 = makePick({ draftId: draft.id, playerId: p2, expectedRevision: r1.draft.revision });
  assert.equal(r2.draft.status, 'completed');
  assert.equal(r2.draft.turn_deadline, null);
  assert.throws(() => makePick({ draftId: draft.id, playerId: p3 }), DraftValidationError);
});

/* ----------------------------------------------------------- undo and redo */

test('undo removes the last pick and redo restores exactly it', () => {
  const draft = makeDraft();
  const [p1] = draftablePlayers(1);
  const { pick } = makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });

  const { undone, draft: afterUndo } = undoLastPick({ draftId: draft.id });
  assert.equal(undone.player_id, p1);
  assert.equal(row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n, 0);

  const { redone, draft: afterRedo } = redoLastUndo({ draftId: draft.id });
  assert.equal(redone.player_id, p1);
  assert.equal(row('SELECT COUNT(*) AS n FROM draft_picks WHERE draft_id = ?', draft.id).n, 1);
  const restored = row('SELECT * FROM draft_picks WHERE draft_id = ?', draft.id);
  assert.equal(restored.pick_number, pick.pick_number);
  assert.equal(restored.team_slot, pick.team_slot);
});

test('redo is unavailable once a new pick supersedes the undo', () => {
  const draft = makeDraft();
  const [p1, p2] = draftablePlayers(2);
  makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  undoLastPick({ draftId: draft.id });
  makePick({ draftId: draft.id, playerId: p2 });
  assert.throws(() => redoLastUndo({ draftId: draft.id }), DraftValidationError);
});

/* ------------------------------------------------------------- correction */

test('commissioner correction swaps the last picks player without touching earlier picks', () => {
  const draft = makeDraft();
  const [p1, p2, p3] = draftablePlayers(3);
  makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  const { pick: pick2 } = makePick({ draftId: draft.id, playerId: p2 });
  const { corrected } = correctLastPick({ draftId: draft.id, playerId: p3 });
  assert.equal(corrected.pick_number, pick2.pick_number);
  assert.equal(corrected.player_id, p3);
  const stillThere = row('SELECT * FROM draft_picks WHERE draft_id = ? AND player_id = ?', draft.id, p1);
  assert.ok(stillThere, 'the earlier pick must be untouched by a correction to the later one');
});

/* ------------------------------------------------------------------ queue */

test('queue persists server-side and auto-pick prefers the first still-available queued player', () => {
  const draft = makeDraft({ team_count: 2, rounds: 3, my_slot: 2 });
  const [p1, p2, p3] = draftablePlayers(3);
  setQueue({ draftId: draft.id, teamSlot: 2, playerIds: [p1, p2, p3] });
  assert.deepEqual(getQueue(draft.id, 2).map(q => q.player_id), [p1, p2, p3]);

  // p1 gets taken by someone else before slot 2's turn comes up.
  makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision, source: 'cpu' });
  assert.equal(firstAvailableFromQueue(draft.id, 2), p2, 'the queue should skip a player who was drafted elsewhere');
});

test('a player is dropped from every queue the moment they are drafted', () => {
  const draft = makeDraft({ team_count: 2, rounds: 3 });
  const [p1] = draftablePlayers(1);
  setQueue({ draftId: draft.id, teamSlot: 1, playerIds: [p1] });
  setQueue({ draftId: draft.id, teamSlot: 2, playerIds: [p1] });
  makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  assert.equal(getQueue(draft.id, 1).length, 0);
  assert.equal(getQueue(draft.id, 2).length, 0);
});

/* ------------------------------------------------------ pause/resume clock */

test('pausing clears the deadline; resuming restarts it', () => {
  const draft = makeDraft();
  const [p1] = draftablePlayers(1);
  const { draft: afterPick } = makePick({ draftId: draft.id, playerId: p1, expectedRevision: draft.revision });
  assert.ok(afterPick.turn_deadline);
  const paused = setPaused({ draftId: draft.id, paused: true });
  assert.equal(paused.paused, 1);
  assert.equal(paused.turn_deadline, null, 'a paused draft must not have a live server-owned deadline');
  const resumed = setPaused({ draftId: draft.id, paused: false });
  assert.equal(resumed.paused, 0);
  assert.ok(resumed.turn_deadline, 'resuming should restart the clock');
});

/* --------------------------------------------------- durable overdue clock */

test('autoPickOverdueDrafts picks up a draft whose deadline already passed (simulating a server restart)', () => {
  const draft = makeDraft({ team_count: 2, rounds: 2 });
  const [p1, p2] = draftablePlayers(2);
  // Force the deadline into the past, as if the server was down through it.
  run(`UPDATE drafts SET turn_deadline = datetime('now', '-1 hour') WHERE id = ?`, draft.id);
  const results = autoPickOverdueDrafts({ chooseFallback: () => p1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].pick.player_id, p1);
});

/* -------------------------------------------------------- full simulation */

test('a full 6-team, 4-round snake draft completes with every pick unique and correctly ordered', () => {
  const teamCount = 6, roundsN = 4;
  const draft = makeDraft({ team_count: teamCount, rounds: roundsN, order_type: 'snake' });
  const pool = draftablePlayers(teamCount * roundsN);
  assert.equal(pool.length, teamCount * roundsN, 'fixture needs enough draftable players');

  let current = draft;
  for (let i = 0; i < pool.length; i++) {
    const { draft: next } = makePick({ draftId: draft.id, playerId: pool[i], expectedRevision: current.revision });
    current = next;
  }

  assert.equal(current.status, 'completed');
  assert.equal(current.revision, draft.revision + pool.length);
  const allPicks = rows('SELECT * FROM draft_picks WHERE draft_id = ? ORDER BY pick_number', draft.id);
  assert.equal(allPicks.length, totalPicks(draft));
  assert.equal(new Set(allPicks.map(p => p.player_id)).size, allPicks.length, 'every player drafted exactly once');
  assert.deepEqual(allPicks.map(p => p.pick_number), Array.from({ length: allPicks.length }, (_, i) => i + 1));

  // Round 1 ascending, round 2 descending — verify the snake order actually held.
  const round1Slots = allPicks.slice(0, teamCount).map(p => p.team_slot);
  const round2Slots = allPicks.slice(teamCount, teamCount * 2).map(p => p.team_slot);
  assert.deepEqual(round1Slots, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(round2Slots, [6, 5, 4, 3, 2, 1]);
});
