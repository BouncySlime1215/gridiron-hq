import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-player-availability-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
// Side-effect import: roster_players is created ad-hoc at import time by
// nfldata.js, same "~40 files create tables on import" wiring the rest of the
// suite relies on (see test/post-draft-plan.test.js).
await import('../server/routes/nfldata.js');
const { seasonEndingEspnIds, textMentionsFullName } = await import('../server/services/player-availability.js');
await runMigrations();

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (1,'TST','Test Team','NFC','North')`);

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function roster(espnId, name) {
  run(`INSERT INTO roster_players (espn_id, name, team_id) VALUES (?,?,1)`, espnId, name);
}
function news(headline) {
  run(`INSERT INTO news_items (headline, date, published_at) VALUES (?, datetime('now'), datetime('now'))`, headline);
}

test('a roster cut naming one player does not flag every other player who shares that surname', () => {
  // The exact real-world case this bug produced: three real, healthy, active
  // players were reported as "out for the season or released" because someone
  // ELSE with the same last name genuinely was.
  roster(1, 'A.J. Brown');
  roster(2, 'Wan\'Dale Robinson');
  roster(3, 'Juwan Johnson');
  news('Released WR Noah Brown.');
  news('Waived LBs Nick Andersen, Devean Deal, Ts A.J. Someone, and Corey Robinson II.');
  news('Waived DBs Alex Cook, Alex Johnson, Nate Valcarcel.');

  const flagged = seasonEndingEspnIds();
  assert.equal(flagged.has(1), false, 'A.J. Brown must not be flagged for Noah Brown being released');
  assert.equal(flagged.has(2), false, "Wan'Dale Robinson must not be flagged for Corey Robinson II being waived");
  assert.equal(flagged.has(3), false, 'Juwan Johnson must not be flagged for Alex Johnson being waived');
});

test('a genuine full-name match still flags the right player', () => {
  roster(4, 'Noah Brown');
  news('Released WR Noah Brown.');
  assert.ok(seasonEndingEspnIds().has(4));
});

test('textMentionsFullName requires both first and last name, not last name alone', () => {
  assert.equal(textMentionsFullName('Released WR Noah Brown.', 'A.J. Brown'), false);
  assert.equal(textMentionsFullName('Released WR Noah Brown.', 'Noah Brown'), true);
  // Punctuation/suffix variants must still match, same convention as normalizePlayerName elsewhere.
  assert.equal(textMentionsFullName('Sources: AJ Brown to have season-ending surgery', 'A.J. Brown'), true);
});
