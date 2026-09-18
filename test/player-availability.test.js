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

test('progressive verb forms count as a release ("is also releasing punter X")', () => {
  assert.equal(newsSeverityFor('A source confirmed to ESPN that the team is also releasing punter Mitch Wishnowsky.', 'Mitch Wishnowsky'), 'released');
  assert.equal(newsSeverityFor('The Jets are waiving WR Example Player.', 'Example Player'), 'released');
});

test('the player a release makes room for is the signing, not the one released', () => {
  const t = "The Cowboys named Sam Howell as the team's backup QB after waiving Joe Milton III on Monday to make room for free agent RB Emari Demercado.";
  assert.equal(newsSeverityFor(t, 'Emari Demercado'), null);
  assert.equal(newsSeverityFor(t, 'Joe Milton III'), 'released');
  assert.equal(newsSeverityFor('The Bears released WR Old Guy and signed WR New Guy.', 'New Guy'), null);
  assert.equal(newsSeverityFor('The Bears released WR Old Guy and signed WR New Guy.', 'Old Guy'), 'released');
});

test('passive releases, past-season injuries, abbreviations and one-word names', () => {
  assert.equal(newsSeverityFor('Veteran WR Some Receiver was released by the team on Tuesday.', 'Some Receiver'), 'released');
  assert.equal(newsSeverityFor('Some Runner tore his ACL last season and is fully cleared.', 'Some Runner'), null);
  assert.equal(newsSeverityFor('Some Runner tore his ACL in practice and will miss the rest of the season.', 'Some Runner'), 'season_ending');
  // "Jr." and initials must not end a sentence and strand the name from its verb.
  assert.equal(newsSeverityFor('Released WR Marvin Harrison Jr. on Monday.', 'Marvin Harrison Jr.'), 'released');
  assert.equal(newsSeverityFor('Released RB J.K. Dobbins vs. the cap.', 'J.K. Dobbins'), 'released');
  assert.equal(newsSeverityFor('Released WR Someone.', 'Someone'), null, 'a one-word name cannot be attributed');
  assert.equal(newsSeverityFor('', 'Noah Brown'), null);
});

test('ESPN only overrides the news when it is newer, says available, and has him on an NFL team', () => {
  const league = (id, status, proTeamId, fetched) => run(
    `INSERT INTO leagues (platform, league_id, season, name, payload, fetched_at) VALUES ('espn', ?, 2026, 'fixture', ?, ${fetched})`,
    String(9000 + id), JSON.stringify({ teams: [{ id: 1, roster: { entries: [
      { lineupSlotId: 0, playerPoolEntry: { player: { id, fullName: `Case ${id}`, injuryStatus: status, proTeamId } } }] } }] }));
  roster(201, 'Case Out'); roster(202, 'Case Stale'); roster(203, 'Case Freeagent');
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, fetched_at) VALUES ('espn', '8999', 2026, 'bad', '{not json', datetime('now'))`);
  story('Case Out out for season', 'Case Out suffered a season-ending injury.', "datetime('now','-2 days')");
  story('Case Stale out for season', 'Case Stale suffered a season-ending injury.', "datetime('now')");
  story('Released LB Case Freeagent', 'Released LB Case Freeagent.', "datetime('now','-2 days')");
  league(201, 'INJURY_RESERVE', 12, "datetime('now')");     // ESPN agrees he is out
  league(202, 'ACTIVE', 12, "datetime('now','-5 days')");    // ESPN is older than the story
  league(203, 'ACTIVE', 0, "datetime('now')");               // ESPN: no NFL team
  const flagged = seasonEndingEspnIds();
  assert.equal(flagged.has(201), true, 'ESPN confirms');
  assert.equal(flagged.has(202), true, 'a stale ESPN sync does not override fresh news');
  assert.equal(flagged.has(203), true, 'a free agent is still released');
});

test('the newest ESPN sync wins when a player appears in several leagues; malformed entries are skipped', () => {
  roster(301, 'Case Multi');
  story('Case Multi out for season', 'Case Multi suffered a season-ending injury.', "datetime('now','-2 days')");
  const payload = (status, extra = []) => JSON.stringify({ teams: [{ id: 1, roster: { entries: [
    ...extra, { lineupSlotId: 0, playerPoolEntry: { player: { id: 301, fullName: 'Case Multi', injuryStatus: status, proTeamId: 3 } } }] } }, { id: 2 }] });
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, fetched_at) VALUES ('espn','9301',2026,'a',?,datetime('now','-1 hours'))`,
    payload('OUT', [{ lineupSlotId: 20, playerPoolEntry: {} }]));
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, fetched_at) VALUES ('espn','9302',2026,'b',?,datetime('now'))`,
    payload(undefined));   // no injuryStatus at all = healthy on ESPN
  run(`INSERT INTO leagues (platform, league_id, season, name, payload, fetched_at) VALUES ('espn','9303',2026,'c',?,datetime('now','-3 hours'))`,
    payload('INJURY_RESERVE'));
  assert.equal(seasonEndingEspnIds().has(301), false, 'the newest sync (healthy) overrides the older OUT rows');
  assert.equal(textMentionsFullName('anything', ''), false);
});
