import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-seed-idem-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, rows, run } = await import('../server/db/index.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { normalizePlayerName } = await import('../server/services/player-identity.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

function duplicateGroups() {
  const seen = new Map();
  for (const p of rows('SELECT id, name, position FROM players')) {
    const k = `${normalizePlayerName(p.name)}|${p.position}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1);
}

test('seeding repeatedly does not multiply players', () => {
  seedIfEmpty();
  const afterFirst = rows('SELECT id FROM players').length;
  assert.ok(afterFirst > 0, 'seed should create players');

  seedIfEmpty();
  seedIfEmpty();
  assert.equal(rows('SELECT id FROM players').length, afterFirst,
    'reseeding must reconcile in place, not insert again');
  assert.deepEqual(duplicateGroups(), []);
});

test('re-seeding after the ESPN sync clears slot_code does not duplicate players', () => {
  // This is the exact production cycle that produced 64 duplicate player groups and
  // split real draft picks across two ids for the same person:
  //   boot -> seed assigns slot_code
  //   POST /api/espn/sync-players -> "UPDATE players SET slot_code = NULL WHERE
  //      phase IN ('offense','special_teams')" before rebuilding depth charts
  //   next boot -> seed looks players up by (team_id, slot_code), finds nothing,
  //      and inserts a second row for every one of them.
  seedIfEmpty();
  const before = rows('SELECT id FROM players').length;

  run(`UPDATE players SET slot_code = NULL WHERE phase IN ('offense','special_teams')`);
  seedIfEmpty();

  assert.equal(rows('SELECT id FROM players').length, before,
    'players whose slot_code was cleared must be matched by identity, not re-inserted');
  assert.deepEqual(duplicateGroups(), [],
    'no duplicate name+position groups may appear after a sync-then-reseed cycle');
});

test('a player stored with a curly apostrophe is not duplicated by a straight-apostrophe seed entry', () => {
  seedIfEmpty();
  const before = rows('SELECT id FROM players').length;

  // Rename a seeded player to the curly-apostrophe spelling ESPN uses, clear its slot
  // (as the sync would), then reseed: the seed's straight-apostrophe entry must resolve
  // to this same row.
  const victim = rows(`SELECT id, name, team_id FROM players WHERE position='WR' AND slot_code IS NOT NULL LIMIT 1`)[0];
  if (victim) {
    run(`UPDATE players SET name=?, slot_code=NULL WHERE id=?`, victim.name.replace(/'/g, '’'), victim.id);
    seedIfEmpty();
    assert.equal(rows('SELECT id FROM players').length, before,
      'a punctuation-only spelling difference must not create a second player');
  }
});
