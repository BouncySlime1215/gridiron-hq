import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-seed-idem-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, row, rows, run } = await import('../server/db/index.js');
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

test('legacy duplicate seed rows do not create another duplicate on boot', () => {
  seedIfEmpty();
  const kicker = rows(`SELECT id,name,position,team_id,depth_rank,phase,fantasy_relevant
    FROM players WHERE position='K' AND team_id IS NOT NULL ORDER BY id LIMIT 1`)[0];
  assert.ok(kicker);
  run(`INSERT INTO players
    (name,position,team_id,depth_rank,slot_code,phase,fantasy_relevant)
    VALUES (?,?,?,?,NULL,?,?)`, kicker.name, kicker.position, kicker.team_id,
  kicker.depth_rank, kicker.phase, kicker.fantasy_relevant);
  run(`UPDATE players SET slot_code=NULL WHERE team_id=? AND position=? AND name=?`,
    kicker.team_id, kicker.position, kicker.name);
  const before = rows('SELECT id FROM players').length;
  seedIfEmpty();
  assert.equal(rows('SELECT id FROM players').length, before,
    'an ambiguous legacy duplicate group must reconcile in place instead of growing');
});

test('reseeding does not revert a user-edited team analysis write-up', () => {
  // server/routes/teams.js and server/routes/analysis.js let a user hand-edit
  // these columns. seedIfEmpty() used to run an ON CONFLICT(abbr) DO UPDATE on
  // every boot, which silently reverted the edit back to the hardcoded seed text.
  seedIfEmpty();
  const team = rows(`SELECT abbr, ol_analysis FROM nfl_teams ORDER BY abbr LIMIT 1`)[0];
  assert.ok(team);
  const edited = 'User-edited O-line write-up that must survive a reboot.';
  run(`UPDATE nfl_teams SET ol_analysis=? WHERE abbr=?`, edited, team.abbr);

  seedIfEmpty();
  seedIfEmpty();

  assert.equal(row('SELECT ol_analysis FROM nfl_teams WHERE abbr=?', team.abbr).ol_analysis, edited,
    'a live-edited team analysis column must not be reset by reseeding on the next boot');
});

test('reseeding does not revert a user re-rank of the default board', () => {
  // rankings.js lets a user reorder/re-tier "My 2026 Board" directly. seedIfEmpty()
  // used to run an ON CONFLICT(set_id, player_id) DO UPDATE on every boot, which
  // silently reset every rank/tier back to the hardcoded consensus order.
  seedIfEmpty();
  const setId = row(`SELECT id FROM ranking_sets WHERE name='My 2026 Board' AND scoring='PPR'`).id;
  const entry = rows('SELECT player_id, rank, tier FROM ranking_entries WHERE set_id=? ORDER BY rank LIMIT 1', setId)[0];
  assert.ok(entry);
  const newRank = entry.rank + 500;
  run(`UPDATE ranking_entries SET rank=?, tier=6 WHERE set_id=? AND player_id=?`, newRank, setId, entry.player_id);

  seedIfEmpty();
  seedIfEmpty();

  const after = row('SELECT rank, tier FROM ranking_entries WHERE set_id=? AND player_id=?', setId, entry.player_id);
  assert.equal(after.rank, newRank, 'a user re-rank must not be reset by reseeding on the next boot');
  assert.equal(after.tier, 6, 'a user re-tier must not be reset by reseeding on the next boot');
});
