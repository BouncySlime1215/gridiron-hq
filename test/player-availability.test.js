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

/* ---------------------------------------------------------------------------
 * 2026-09-18: the season-ending flag was a story-level co-occurrence test —
 * any story containing a player's full name AND a severe phrase ANYWHERE.
 * Every case below is a real false positive (or a true case that must survive)
 * from the live 2026 week-2 news feed. A season-ending flag sets
 * available=false, which zeroes the player's rest-of-season value and removes
 * him from every lineup, so a false positive told Nick to drop Patrick Mahomes.
 * ------------------------------------------------------------------------- */

const { newsSeverityFor } = await import('../server/services/player-availability.js');

function story(headline, body, when = "datetime('now')") {
  run(`INSERT INTO news_items (headline, body, date, published_at) VALUES (?, ?, ${when}, ${when})`, headline, body);
}

test('returning from a past torn ACL is not a season-ending injury, and a teammate in the same story is not flagged', () => {
  roster(101, 'Patrick Mahomes');
  roster(102, 'Kenneth Walker III');
  story("Mahomes lead Chiefs' win vs. Broncos",
    'Quarterback Patrick Mahomes, making his return from a torn ACL, and running back Kenneth Walker III combined for three touchdowns.');
  const flagged = seasonEndingEspnIds();
  assert.equal(flagged.has(101), false, 'Mahomes is back from an old injury, not out for the season');
  assert.equal(flagged.has(102), false, 'Walker only shares the story');
});

test('two players in one sentence: only the one ruled out for the season is flagged', () => {
  roster(103, "De'Zhaun Stribling");
  roster(104, 'Jake Tonges');
  story('Injury update',
    "De'Zhaun Stribling injured his ankle and is expected to miss about 10 weeks, while tight end Jake Tonges has been ruled out for the season.");
  const flagged = seasonEndingEspnIds();
  assert.equal(flagged.has(103), false, 'about 10 weeks is multi-week, not season-ending');
  assert.equal(flagged.has(104), true, 'Tonges is ruled out for the season');
});

test('a release in the next sentence does not attach to the player in the previous one', () => {
  roster(105, 'Zach Charbonnet');
  roster(106, 'Trevon Diggs');
  story('Seahawks moves',
    "Zach Charbonnet was placed on the PUP list, meaning he will miss at least Seattle's first four games. Meanwhile, the team released cornerback Trevon Diggs.");
  const flagged = seasonEndingEspnIds();
  assert.equal(flagged.has(105), false, 'PUP / four games is not season-ending');
  assert.equal(flagged.has(106), true, 'Diggs was released');
});

test('injured reserve with a stated return window is multi-week; season-ending IR is still flagged', () => {
  roster(107, 'Tank Dell');
  roster(108, 'Keyron Crawford');
  story('Texans place Tank Dell on IR', 'Tank Dell was placed on injured reserve Sunday as the WR will be out at least 4 weeks.');
  story('Raiders place DE Keyron Crawford (ankle) on season-ending IR', 'Las Vegas Raiders rookie Keyron Crawford is done for the year.');
  const flagged = seasonEndingEspnIds();
  assert.equal(flagged.has(107), false, 'four weeks on IR is not the season');
  assert.equal(flagged.has(108), true, 'season-ending IR');
});

test('a player named after the cut, not as its object, is not the one released', () => {
  roster(109, 'Tyler Loop');
  roster(110, 'Jake Moody');
  // No possessive: "Tyler Loop's" does not normalise to his full name, which made the
  // first draft of this test pass on the old code for the wrong reason.
  story('Ravens cut kicker Moody', 'The Ravens cut kicker Jake Moody after rookie Tyler Loop won the job.');
  const flagged = seasonEndingEspnIds();
  assert.equal(flagged.has(109), false, 'Loop won the job');
  assert.equal(flagged.has(110), true, 'Moody was cut');
});

test('ESPN listing a player ACTIVE on an NFL team after the story overrides a stale or misattributed severe story', () => {
  roster(111, 'Stale Example');
  story('Stale Example out for season', 'Stale Example suffered a season-ending injury.', "datetime('now','-3 days')");
  const payload = JSON.stringify({ teams: [{ id: 1, roster: { entries: [
    { lineupSlotId: 0, playerPoolEntry: { player: { id: 111, fullName: 'Stale Example', injuryStatus: 'ACTIVE', proTeamId: 12 } } },
  ] } }] });
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, fetched_at) VALUES ('espn', '999', 2026, 'fixture', ?, datetime('now'))`, payload);
  assert.equal(seasonEndingEspnIds().has(111), false, 'ESPN is fresher than the story and says he is active');
});

test('newsSeverityFor classifies per player, not per story', () => {
  const t = 'Quarterback Patrick Mahomes, making his return from a torn ACL, and running back Kenneth Walker III combined for three touchdowns.';
  assert.equal(newsSeverityFor(t, 'Patrick Mahomes'), null);
  assert.equal(newsSeverityFor(t, 'Kenneth Walker III'), null);
  assert.equal(newsSeverityFor('Released WR Noah Brown.', 'Noah Brown'), 'released');
  assert.equal(newsSeverityFor('Sources: AJ Brown to have season-ending surgery', 'A.J. Brown'), 'season_ending');
  assert.equal(newsSeverityFor('Waived LBs Liam Anderson, Jack Dingle, Eli Neal.', 'Jack Dingle'), 'released');
});
