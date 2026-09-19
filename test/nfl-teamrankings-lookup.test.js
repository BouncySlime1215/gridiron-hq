/**
 * Tests for nfl-teamrankings-lookup.js -- the seam between
 * `scripts/export-teamrankings-features.mjs` (precomputed offline against the
 * read-only fantasy-football-dashboard research database) and the JS
 * ensemble's synchronous predict() loop.
 *
 * Isolation is the point of the first assertion: `test/offline-guard.mjs`
 * defaults `GRIDIRON_TEAMRANKINGS_LOOKUP` to a path that does not exist, so no
 * test can read the real export unless it points at a file of its own. These
 * tests point at scratch files and never touch
 * `server/data/research/teamrankings-lookup.json`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-teamrankings-lookup-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const mod = await import('../server/services/nfl-teamrankings-lookup.js');

function useLookup(name, payload) {
  const file = path.join(scratch, name);
  if (payload !== null) fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  process.env.GRIDIRON_TEAMRANKINGS_LOOKUP = file;
  mod.clearTeamrankingsLookupCache();
  return file;
}

test('the suite-wide default points at nothing, so a test cannot read the real export by accident', () => {
  // offline-guard.mjs sets this before any test file loads; a suite run
  // without that preload would fail here rather than silently reading real
  // research data into a synthetic fixture.
  assert.ok(process.env.GRIDIRON_TEAMRANKINGS_LOOKUP,
    'GRIDIRON_TEAMRANKINGS_LOOKUP must be set for the whole test run');
  assert.ok(!process.env.GRIDIRON_TEAMRANKINGS_LOOKUP.includes(path.join('server', 'data', 'research')),
    'the default must not be the real export path');
});

test('a well-formed lookup answers exact keys and null for everything else', () => {
  useLookup('ok.json', {
    schema: 'nfl-teamrankings-lookup-v1',
    min_season: 2015, through_season: 2026, games: 4,
    entries_with_rating: 2,
    entries: [
      { season: 2024, week: 3, home: 'KC', away: 'BAL', rating_diff: 4.5 },
      { season: 2024, week: 3, home: 'SF', away: 'SEA', rating_diff: -2.25 },
    ],
  });
  assert.equal(mod.teamrankingsRatingDiff(2024, 3, 'KC'), 4.5);
  assert.equal(mod.teamrankingsRatingDiff(2024, 3, 'SF'), -2.25);
  assert.equal(mod.teamrankingsRatingDiff(2024, 3, 'DAL'), null,
    'a game with no lookup entry must answer null, never a guessed number');
  assert.equal(mod.teamrankingsRatingDiff(1999, 1, 'KC'), null);
  const { meta } = mod.loadTeamrankingsLookup();
  assert.equal(meta.games, 4);
  assert.equal(meta.entries_with_rating, 2);
});

test('an entry explicitly carrying rating_diff: null is skipped rather than cached as a real zero', () => {
  useLookup('null-entry.json', {
    schema: 'nfl-teamrankings-lookup-v1', games: 1, entries_with_rating: 0,
    entries: [{ season: 2024, week: 1, home: 'KC', away: 'BAL', rating_diff: null }],
  });
  assert.equal(mod.teamrankingsRatingDiff(2024, 1, 'KC'), null);
});

test('a missing lookup file abstains everywhere rather than throwing', () => {
  useLookup('does-not-exist.json', null);
  assert.doesNotThrow(() => mod.teamrankingsRatingDiff(2024, 3, 'KC'));
  assert.equal(mod.teamrankingsRatingDiff(2024, 3, 'KC'), null);
  assert.equal(mod.loadTeamrankingsLookup().meta, null);
});

test('a corrupt lookup file abstains everywhere rather than throwing', () => {
  useLookup('corrupt.json', 'not valid json{{{');
  assert.doesNotThrow(() => mod.teamrankingsRatingDiff(2024, 3, 'KC'));
  assert.equal(mod.teamrankingsRatingDiff(2024, 3, 'KC'), null);
  assert.equal(mod.loadTeamrankingsLookup().meta, null);
});

test('the cache is keyed to a load, and clearing it re-reads the current path', () => {
  useLookup('first.json', { schema: 'nfl-teamrankings-lookup-v1', games: 1, entries_with_rating: 1,
    entries: [{ season: 2024, week: 1, home: 'KC', away: 'BAL', rating_diff: 4 }] });
  assert.equal(mod.teamrankingsRatingDiff(2024, 1, 'KC'), 4);
  useLookup('second.json', { schema: 'nfl-teamrankings-lookup-v1', games: 1, entries_with_rating: 1,
    entries: [{ season: 2024, week: 1, home: 'KC', away: 'BAL', rating_diff: -4 }] });
  assert.equal(mod.teamrankingsRatingDiff(2024, 1, 'KC'), -4);
});

test('lookupPath() reflects the env override, and clearing the cache does not require re-setting it', () => {
  const file = useLookup('path-check.json', {
    schema: 'nfl-teamrankings-lookup-v1', games: 0, entries_with_rating: 0, entries: [],
  });
  assert.equal(mod.lookupPath(), file);
});
