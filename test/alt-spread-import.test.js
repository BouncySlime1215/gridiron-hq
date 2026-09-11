/**
 * Alternate-spread capture import.
 *
 * The properties worth defending here are not "does it insert a row". They are:
 *
 *   - a malformed capture is REFUSED, with a reason specific enough to fix,
 *     rather than partially written;
 *   - a team name resolves through this repo's franchise map and never through
 *     the scraper's three-letter key, which means a different team for two
 *     franchises and collides for two more;
 *   - the four week-1 games whose UTC kickoff date is a day after their Eastern
 *     `gameday` still join, because the join is on the team pair;
 *   - the parlay arithmetic matches hand computation, including the sign
 *     convention that turns a 0.96 profit multiple into -104 and not "+96";
 *   - re-importing the same capture writes nothing;
 *   - and nothing on this path can put an alt price into
 *     `nfl_teaser_price_ledger`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-alt-spread-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'alt-spread.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();

const {
  ALT_SPREAD_CAPTURE_SCHEMA, ALT_SPREAD_PROVENANCE, ALT_SPREAD_LEDGER_MARKER,
  ALT_SPREAD_CAPTURE_CONTRACT, AltSpreadCaptureError,
  altParlayEquivalent, altLegTeaserEquivalence, eventKeyFor, resolveScheduledGame,
  scraperAbbr, scraperAbbreviationAudit, validateAltSpreadCapture, importAltSpreadCapture,
  altTeaserEquivalentBoard, assertNoAltPricesInTeaserLedger
} = await import('../server/services/alt-spread-import.js');
const { __test: bookFeeds } = await import('../server/services/book-feeds.js');
const { CROSS_BOTH_LINES } = await import('../server/betting/nfl/strategy/teaser-leg-rates.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ----------------------------------------------------------------- fixture */

// The eight franchises the fixtures use, spelled exactly as nfl_teams spells
// them, plus the two whose scraper codes collide with a DIFFERENT team's real
// code here (Arizona -> CAR, Kansas City -> CHI) so the audit has both halves
// of each collision to find.
const TEAMS = [
  [1, 'DAL', 'Dallas Cowboys'], [2, 'NYG', 'New York Giants'],
  [3, 'NE', 'New England Patriots'], [4, 'SEA', 'Seattle Seahawks'],
  [5, 'DEN', 'Denver Broncos'], [6, 'KC', 'Kansas City Chiefs'],
  [7, 'SF', 'San Francisco 49ers'], [8, 'LAR', 'Los Angeles Rams'],
  [9, 'ARI', 'Arizona Cardinals'], [10, 'CAR', 'Carolina Panthers'],
  [11, 'CHI', 'Chicago Bears'], [12, 'CLE', 'Cleveland Browns']
];
for (const [id, abbr, name] of TEAMS) {
  db.prepare(`INSERT OR REPLACE INTO nfl_teams (id, abbr, name, conference, division)
    VALUES (?,?,?,'NFC','East')`).run(id, abbr, name);
}

/**
 * Week 1 of 2026, exactly as `game_lines` holds it on the live database for the
 * games these tests use. Times are EASTERN wall clock, which is the whole
 * point: the four 8pm-or-later games carry a UTC date one day later than their
 * `gameday`, and that is the offset the team-pair join has to survive.
 */
const SCHEDULE = [
  // [home, away, gameday (ET), gametime (ET), expected event key]
  ['SEA', 'NE', '2026-09-09', '20:20', 'nfl:2026-09-10:NE@SEA'],
  ['LAR', 'SF', '2026-09-10', '20:35', 'nfl:2026-09-11:SF@LAR'],
  ['NYG', 'DAL', '2026-09-13', '20:20', 'nfl:2026-09-14:DAL@NYG'],
  ['KC', 'DEN', '2026-09-14', '20:15', 'nfl:2026-09-15:DEN@KC'],
  // A same-date control, so a passing test is not just "everything is +1 day".
  ['CAR', 'CHI', '2026-09-13', '13:00', 'nfl:2026-09-13:CHI@CAR']
];
for (const [home, away, gameday, gametime] of SCHEDULE) {
  db.prepare(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,gametime,spread,spread_odds)
    VALUES (2026,1,?,?,1,?,?,-3.5,-110)`).run(home, away, gameday, gametime);
  db.prepare(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,gametime,spread,spread_odds)
    VALUES (2026,1,?,?,0,?,?,3.5,-110)`).run(away, home, gameday, gametime);
}

const NOW = new Date('2026-09-11T18:00:00.000Z');

/** A game block. `main` is the AWAY line, as every parser in live_odds.py reports it. */
function gameBlock({ away, home, kickoff, main, altPlus6 = null, altMinus6 = null, ...rest }) {
  const alt = {};
  if (altPlus6) {
    // away_plus6 and home_minus6 are the two sides of ONE number.
    alt.away_plus6 = { line: main.line + 6, price: altPlus6.away };
    alt.home_minus6 = { line: -(main.line + 6), price: altPlus6.home };
  }
  if (altMinus6) {
    alt.away_minus6 = { line: main.line - 6, price: altMinus6.away };
    alt.home_plus6 = { line: -(main.line - 6), price: altMinus6.home };
  }
  return { away_team: away, home_team: home, kickoff, main: { away: main }, alt_six: alt, ...rest };
}

function capture({ books, capturedAt = '2026-09-11T17:59:00Z', ...rest } = {}) {
  return {
    schema: ALT_SPREAD_CAPTURE_SCHEMA,
    captured_at: capturedAt,
    source: 'live_odds.py',
    source_version: 'test-fixture',
    provenance: ALT_SPREAD_PROVENANCE,
    books,
    ...rest
  };
}

/** DAL -7.5 at NYG: away teases to -1.5, home teases to +13.5. Both sides quoted. */
const DAL_AT_NYG = gameBlock({
  away: 'Dallas Cowboys', home: 'New York Giants', kickoff: '2026-09-14T00:20:00Z',
  main: { line: -7.5, price: -110 },
  altPlus6: { away: -260, home: 210 },     // away -1.5 / home +1.5
  altMinus6: { away: 260, home: -320 }     // away -13.5 / home +13.5
});

/** NE +2.5 at SEA: the AWAY dog is the cross-both leg here, teasing to +8.5. */
const NE_AT_SEA = gameBlock({
  away: 'New England Patriots', home: 'Seattle Seahawks', kickoff: '2026-09-10T00:20:00Z',
  main: { line: 2.5, price: -105 },
  altPlus6: { away: -240, home: 195 }      // away +8.5 / home -8.5
});

const clearImports = () => {
  // Both tables are append-only by trigger; a test fixture drops them wholesale
  // instead, which is what a temp database is for.
  db.exec('DROP TRIGGER IF EXISTS nfl_alt_spread_quotes_no_delete');
  db.exec('DROP TRIGGER IF EXISTS nfl_alt_spread_captures_no_delete');
  db.exec('DELETE FROM nfl_alt_spread_quotes');
  db.exec('DELETE FROM nfl_alt_spread_captures');
  db.exec(`CREATE TRIGGER IF NOT EXISTS nfl_alt_spread_quotes_no_delete
    BEFORE DELETE ON nfl_alt_spread_quotes BEGIN SELECT RAISE(ABORT, 'append-only'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS nfl_alt_spread_captures_no_delete
    BEFORE DELETE ON nfl_alt_spread_captures BEGIN SELECT RAISE(ABORT, 'append-only'); END`);
};

/* =================================================================== */
/* The scraper's team codes                                            */
/* =================================================================== */

test('the scraper\'s _abbr is a nickname code and is not this repo\'s team code', () => {
  // Reproduced from live_odds.py: last word, first three characters, upper.
  assert.equal(scraperAbbr('Dallas Cowboys'), 'COW');
  assert.equal(scraperAbbr('Seattle Seahawks'), 'SEA');
  assert.equal(scraperAbbr('San Francisco 49ers'), '49E');

  const audit = scraperAbbreviationAudit();
  // Seattle is the only franchise whose nickname prefix happens to be its code.
  assert.deepEqual(audit.matching, ['SEA']);
  assert.equal(audit.mismatched, TEAMS.length - 1);

  // The dangerous class: a scraper code that IS some other franchise's real
  // code in this database. It resolves, and it resolves to the wrong team.
  const aliased = Object.fromEntries(audit.aliases_another_franchise.map(a => [a.repo_abbr, a.scraper_abbr]));
  assert.equal(aliased.ARI, 'CAR', 'Cardinals -> CAR, which is Carolina here');
  assert.equal(aliased.KC, 'CHI', 'Chiefs -> CHI, which is Chicago here');

  // And two franchises that collide with each other inside the scraper itself.
  const collision = audit.internal_collisions.find(c => c.scraper_abbr === 'BRO');
  assert.deepEqual(collision?.franchises.sort(), ['CLE', 'DEN'], 'Browns and Broncos both become BRO');
});

test('teamResolver does NOT reliably refuse a scraper code — two of them resolve to the wrong team', async () => {
  // This is the finding the structural guard exists for. A bare code does not
  // fail loudly; it goes through the resolver's last-resort containment and
  // comes back as a franchise. For Arizona and Kansas City it comes back as a
  // DIFFERENT franchise, with nothing downstream to notice.
  const { teamResolver } = await import('../server/services/team-codes.js');
  const resolve = teamResolver();
  assert.equal(resolve('COW')?.abbr, 'DAL', 'right team, by luck');
  assert.equal(resolve('49E')?.abbr, 'SF', 'right team, by luck');
  assert.equal(resolve('CAR')?.abbr, 'CAR',
    'Carolina — but CAR is the scraper\'s code for ARIZONA. Silently the wrong game.');
  assert.equal(resolve('CHI')?.abbr, 'CHI',
    'Chicago — but CHI is the scraper\'s code for KANSAS CITY. Silently the wrong game.');
  assert.equal(resolve('BRO'), null, 'Browns/Broncos is at least ambiguous enough to refuse');
});

test('a bare team code is refused before the resolver ever sees it', () => {
  for (const [away, home] of [['COW', 'GIA'], ['CAR', 'CHI']]) {
    const payload = capture({ books: [{ book: 'fanduel', games: [gameBlock({
      away, home, kickoff: '2026-09-14T00:20:00Z',
      main: { line: -7.5, price: -110 }, altPlus6: { away: -260, home: 210 }
    })] }] });
    assert.throws(() => importAltSpreadCapture(payload, { now: NOW }), error => {
      assert.ok(error instanceof AltSpreadCaptureError);
      assert.match(error.errors.join('\n'), /is a bare team code/);
      assert.match(error.errors.join('\n'), /resolve here to a DIFFERENT franchise/);
      return true;
    });
  }
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_alt_spread_quotes')[0].n, 0, 'nothing written');
});

test('a name naming two different franchises is refused, not resolved to one of them', () => {
  // The premise this test was originally written on was wrong, and the truth is
  // worse. "Cleveland Broncos" does not fail to resolve — teamResolver()
  // matches the nickname, ignores the city, and returns DENVER. Left alone,
  // a capture that mislabelled a team would import a real price against a
  // franchise that never played the game. Refusing it is the point.
  const payload = capture({ books: [{ book: 'fanduel', games: [gameBlock({
    away: 'Cleveland Broncos', home: 'New York Giants', kickoff: '2026-09-14T00:20:00Z',
    main: { line: -7.5, price: -110 }, altPlus6: { away: -260, home: 210 }
  })] }] });
  assert.throws(() => importAltSpreadCapture(payload, { now: NOW }),
    error => {
      const text = error.errors.join('\n');
      assert.match(text, /resolved to DEN/);
      assert.match(text, /"cleveland" belongs to CLE/);
      return true;
    });
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_alt_spread_quotes')[0].n, 0, 'nothing written');
});

test('a name that resolves to nothing at all is refused too', () => {
  const payload = capture({ books: [{ book: 'fanduel', games: [gameBlock({
    away: 'Nonsense Unicorns', home: 'New York Giants', kickoff: '2026-09-14T00:20:00Z',
    main: { line: -7.5, price: -110 }, altPlus6: { away: -260, home: 210 }
  })] }] });
  assert.throws(() => importAltSpreadCapture(payload, { now: NOW }),
    error => { assert.match(error.errors.join('\n'), /does not resolve to a franchise/); return true; });
});

test('an internally consistent name still resolves, including book shorthand', async () => {
  const { contradictingToken } = await import('../server/services/alt-spread-import.js');
  const { teamResolver } = await import('../server/services/team-codes.js');
  const resolve = teamResolver();
  // Shared tokens must not contradict: "New" and "York" belong to two
  // franchises each, so they identify nothing and are ignored.
  // Drawn from whatever the fixture actually seeded, so this cannot fail for
  // the unrelated reason that a franchise is missing from the temp database.
  const seeded = rows('SELECT abbr, name FROM nfl_teams ORDER BY abbr');
  assert.ok(seeded.length >= 4, 'the fixture seeded franchises to check');
  for (const { abbr, name } of seeded) {
    const team = resolve(name);
    assert.ok(team, `${name} resolves`);
    assert.equal(team.abbr, abbr, `${name} resolves to itself`);
    assert.equal(contradictingToken(name, team), null, `${name} is internally consistent`);
  }
  // And a nickname on its own, with no city to contradict, still passes.
  const first = seeded[0];
  const nickname = first.name.split(' ').at(-1);
  const viaNickname = resolve(nickname);
  if (viaNickname) assert.equal(contradictingToken(nickname, viaNickname), null,
    `bare nickname "${nickname}" is not treated as a contradiction`);
});

/* =================================================================== */
/* Keying and the UTC/ET date offset                                   */
/* =================================================================== */

test('the event key is byte-identical to book-feeds.js\'s', () => {
  // Duplicated in alt-spread-import.js so it carries no dependency on a feed
  // module's private export. This is the assertion that keeps them in step.
  for (const [commence, away, home] of [
    ['2026-09-14T00:20:00Z', 'DAL', 'NYG'],
    ['2026-09-13T17:00:00.000Z', 'CHI', 'CAR'],
    [null, 'A', 'B']
  ]) {
    assert.equal(eventKeyFor(commence, away, home), bookFeeds.eventKey(commence, away, home));
  }
});

test('a game is joined on the team pair, so the four UTC-date-offset games still match', () => {
  for (const [home, away, gameday, gametime, expectedKey] of SCHEDULE) {
    // The book reports a kickoff a minute off, as they routinely do.
    const reported = new Date(Date.parse(expectedKey.slice(4, 14) + 'T00:00:00Z')).toISOString();
    const resolved = resolveScheduledGame({ away, home, kickoff: reported });
    assert.equal(resolved.matched, true, `${away}@${home} must match on the team pair`);
    assert.equal(resolved.season, 2026);
    assert.equal(resolved.week, 1);
    assert.equal(eventKeyFor(resolved.kickoff, away, home), expectedKey,
      `${away}@${home} gameday ${gameday} ${gametime} ET keys to ${expectedKey}`);
  }

  // The offset itself, stated rather than implied: four of these five games
  // carry a UTC date one day after their Eastern gameday.
  const offset = SCHEDULE.filter(([, , gameday, , key]) => key.slice(4, 14) !== gameday);
  assert.equal(offset.length, 4);
  assert.deepEqual(offset.map(s => s[1]).sort(), ['DAL', 'DEN', 'NE', 'SF']);
});

test('an imported quote carries both keys, because they disagree on exactly those games', () => {
  clearImports();
  importAltSpreadCapture(capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG] }] }), { now: NOW });
  const quote = rows(`SELECT * FROM nfl_alt_spread_quotes LIMIT 1`)[0];
  // book-feeds.js keys on the UTC date; nfl-contract-key.js keys on the
  // Eastern one, precisely to avoid this game landing on the 14th.
  assert.equal(quote.event_key, 'nfl:2026-09-14:DAL@NYG');
  assert.equal(quote.contract_event_key, 'nfl|2026-09-13|DAL@NYG');
  assert.equal(quote.schedule_source, 'game_lines_team_pair');
  assert.equal(quote.season, 2026);
});

test('a game with no scheduled counterpart is keyed off the book and says so', () => {
  clearImports();
  const unscheduled = gameBlock({
    away: 'Arizona Cardinals', home: 'Carolina Panthers', kickoff: '2026-11-22T18:00:00Z',
    main: { line: -7, price: -110 }, altPlus6: { away: -255, home: 205 }
  });
  const result = importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [unscheduled] }] }), { now: NOW });
  assert.equal(result.captures[0].unscheduled_games.length, 1);
  const quote = rows(`SELECT * FROM nfl_alt_spread_quotes WHERE away_team='ARI' LIMIT 1`)[0];
  assert.equal(quote.schedule_source, 'book_reported');
  assert.equal(quote.season, null, 'no season is invented for a game that is not on the schedule');
});

/* =================================================================== */
/* Validation                                                          */
/* =================================================================== */

test('the envelope is refused whole, before any game is looked at', () => {
  const cases = [
    [{ ...capture({ books: [] }), schema: 'something.else' }, /schema: expected/],
    [capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG] }], capturedAt: 'yesterday' }), /captured_at: expected an ISO/],
    [{ ...capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG] }] }), provenance: 'teaser_price' }, /provenance: expected "direct_book_scrape"/],
    [{ ...capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG] }] }), source: '' }, /source: expected a non-empty string/],
    [capture({ books: [] }), /books: expected a non-empty array/]
  ];
  for (const [payload, pattern] of cases) {
    assert.throws(() => validateAltSpreadCapture(payload, { now: NOW }), error => {
      assert.ok(error instanceof AltSpreadCaptureError);
      assert.match(error.errors.join('\n'), pattern);
      return true;
    });
  }
  assert.throws(() => validateAltSpreadCapture([], { now: NOW }), /must be a JSON object/);
});

test('a capture stamped in the future is not an observation', () => {
  const payload = capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG] }],
    capturedAt: '2026-09-12T18:00:00Z' });
  assert.throws(() => validateAltSpreadCapture(payload, { now: NOW }),
    error => { assert.match(error.errors.join('\n'), /is in the future relative to/); return true; });
});

test('a torn alt pair is refused — one side alone is a price on a number that was never paired', () => {
  // find_pair() returns both sides or neither, so one side alone means
  // something between the book and here dropped a leg.
  const game = structuredClone(DAL_AT_NYG);
  delete game.alt_six.home_minus6;
  assert.throws(() => importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [game] }] }), { now: NOW }),
  error => {
    assert.match(error.errors.join('\n'), /'away_plus6' and 'home_minus6' are the two sides of one number/);
    return true;
  });
});

test('a non-mirrored pair is refused', () => {
  const game = structuredClone(DAL_AT_NYG);
  game.alt_six.home_minus6.line = 2.5;   // should be 1.5
  assert.throws(() => importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [game] }] }), { now: NOW }),
  error => { assert.match(error.errors.join('\n'), /are not the two sides of one number/); return true; });
});

test('a leg that moves the wrong way is refused rather than filed as a teaser leg', () => {
  const game = structuredClone(DAL_AT_NYG);
  // Claim `away_plus6` but hand it the -6 line. Left unchecked this records a
  // -13.5 quote as the leg a teaser produces from -7.5.
  game.alt_six.away_plus6.line = -13.5;
  game.alt_six.home_minus6.line = 13.5;
  assert.throws(() => importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [game] }] }), { now: NOW }),
  error => { assert.match(error.errors.join('\n'), /opposite direction from the \+6 this leg name asserts/); return true; });
});

test('malformed prices and lines are named specifically', () => {
  const bad = [
    [g => { g.alt_six.away_plus6.price = -110.5; }, /price: expected a signed integer/],
    [g => { g.alt_six.away_plus6.price = -50; }, /price: -50 is outside/],
    [g => { g.alt_six.away_plus6.line = -1.4; }, /is not on the half-point grid/],
    [g => { g.main.away.line = 250; }, /is outside -60\.\.60/],
    [g => { g.alt_six.away_plus6 = 'minus one and a half'; }, /expected an object of the shape \{ line, price \}/],
    [g => { g.alt_six.nonsense_leg = { line: 1, price: -110 }; }, /unknown leg name/]
  ];
  for (const [mutate, pattern] of bad) {
    const game = structuredClone(DAL_AT_NYG);
    mutate(game);
    assert.throws(() => importAltSpreadCapture(
      capture({ books: [{ book: 'fanduel', games: [game] }] }), { now: NOW }),
    error => { assert.match(error.errors.join('\n'), pattern); return true; });
  }
});

test('a home main line that does not mirror the away one is a torn capture', () => {
  const game = structuredClone(DAL_AT_NYG);
  game.main.home = { line: 7, price: -110 };  // away is -7.5
  assert.throws(() => importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [game] }] }), { now: NOW }),
  error => { assert.match(error.errors.join('\n'), /does not mirror the away line/); return true; });
});

test('a game with no alt legs is skipped and COUNTED, not silently dropped', () => {
  clearImports();
  // This is the normal shape of a real run: _fetch_fd_alts_spa returns
  // (None,)*8 when an event page fails, and coverage computed only from the
  // successes is always 100%.
  const noAlt = gameBlock({ away: 'Chicago Bears', home: 'Carolina Panthers',
    kickoff: '2026-09-13T17:00:00Z', main: { line: 3, price: -110 } });
  const result = importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG, noAlt] }] }), { now: NOW });
  assert.equal(result.games_without_alt, 1);
  assert.deepEqual(result.skipped_games,
    [{ book: 'fanduel', away: 'CHI', home: 'CAR', reason: 'no_alt_six_captured' }]);
  assert.equal(rows(`SELECT games_without_alt n FROM nfl_alt_spread_captures`)[0].n, 1);
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_alt_spread_quotes WHERE away_team='CHI'`)[0].n, 0);
});

test('allowPartial imports the sound games and still reports the rest', () => {
  clearImports();
  const broken = gameBlock({ away: 'NOT A TEAM', home: 'Seattle Seahawks',
    kickoff: '2026-09-10T00:20:00Z', main: { line: -3, price: -110 },
    altPlus6: { away: -250, home: 200 } });
  assert.throws(() => importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG, broken] }] }), { now: NOW }));
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_alt_spread_quotes')[0].n, 0,
    'the default refuses the whole capture — nothing partial is written');

  const result = importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG, broken] }] }),
    { now: NOW, allowPartial: true });
  assert.equal(result.captures[0].games, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0], /does not resolve to a franchise/);
});

/* =================================================================== */
/* What gets written                                                   */
/* =================================================================== */

test('a full capture writes the main row and four alt rows, with the move the book actually gave', () => {
  clearImports();
  const result = importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG] }] }), { now: NOW });
  assert.equal(result.captures[0].quotes, 5, 'one away main + four alt legs');

  const byKey = Object.fromEntries(rows(
    `SELECT side, market, requested_move, observed_move, line, price, main_line,
            crosses_both, teaser_equivalent_leg, main_line_derived
       FROM nfl_alt_spread_quotes ORDER BY id`).map(r => [`${r.side}:${r.market}:${r.requested_move}`, r]));

  assert.deepEqual(
    { ...byKey['away:main_spread:0'] },
    { side: 'away', market: 'main_spread', requested_move: 0, observed_move: null,
      line: -7.5, price: -110, main_line: -7.5, crosses_both: 0, teaser_equivalent_leg: 0,
      main_line_derived: 0 });

  // The away teaser leg: -7.5 is in the eight, moved exactly +6 to -1.5.
  const awayTease = byKey['away:alt_spread:6'];
  assert.equal(awayTease.line, -1.5);
  assert.equal(awayTease.price, -260);
  assert.equal(awayTease.observed_move, 6);
  assert.equal(awayTease.teaser_equivalent_leg, 1);
  assert.equal(awayTease.crosses_both, 1);

  // The HOME teaser leg lives in the Python's `_m6` fields. Its main line is
  // +7.5, which is not one of the eight, so it is not a teaser-equivalent leg
  // even though it is a real six-point move.
  const homeTease = byKey['home:alt_spread:6'];
  assert.equal(homeTease.main_line, 7.5);
  assert.equal(homeTease.line, 13.5);
  assert.equal(homeTease.observed_move, 6);
  assert.equal(homeTease.teaser_equivalent_leg, 0);
  assert.equal(homeTease.main_line_derived, 1, 'the home main LINE mirrors; its price was never quoted');

  // The anti-teaser directions cross nothing.
  assert.equal(byKey['away:alt_spread:-6'].crosses_both, 0);
  assert.equal(byKey['home:alt_spread:-6'].crosses_both, 0);
});

test('a 5.5-point substitution from find_pair() is recorded as 5.5, not as six', () => {
  clearImports();
  // find_pair() walks deltas of 0, +/-0.5, +/-1 and takes the first pair on the
  // board. A 5.5-point move is a different bet from a six-point teaser leg, and
  // the row has to say so.
  const slipped = {
    away_team: 'Dallas Cowboys', home_team: 'New York Giants', kickoff: '2026-09-14T00:20:00Z',
    main: { away: { line: -7.5, price: -110 } },
    alt_six: { away_plus6: { line: -2, price: -240 }, home_minus6: { line: 2, price: 195 } }
  };
  importAltSpreadCapture(capture({ books: [{ book: 'fanduel', games: [slipped] }] }), { now: NOW });
  const leg = rows(`SELECT * FROM nfl_alt_spread_quotes
    WHERE market='alt_spread' AND side='away' AND requested_move=6`)[0];
  assert.equal(leg.observed_move, 5.5);
  assert.equal(leg.teaser_equivalent_leg, 0, 'a 5.5-point move is not the leg a six-point teaser produces');
  // It does still cross both key numbers at the move it actually made — a real
  // fact about the bet, reported separately from the equivalence verdict.
  assert.equal(leg.crosses_both, 1);
});

test('a dog leg on the other half of the family is recognised too', () => {
  clearImports();
  importAltSpreadCapture(capture({ books: [{ book: 'fanduel', games: [NE_AT_SEA] }] }), { now: NOW });
  const leg = rows(`SELECT * FROM nfl_alt_spread_quotes
    WHERE market='alt_spread' AND side='away' AND requested_move=6`)[0];
  assert.equal(leg.main_line, 2.5);
  assert.equal(leg.line, 8.5);
  assert.equal(leg.teaser_equivalent_leg, 1);
  assert.equal(leg.event_key, 'nfl:2026-09-10:NE@SEA', 'the Thursday-night UTC offset survived the join');
});

/* =================================================================== */
/* Idempotency                                                         */
/* =================================================================== */

test('re-importing the same capture writes nothing and says so', () => {
  clearImports();
  const payload = capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG, NE_AT_SEA] }] });
  const first = importAltSpreadCapture(payload, { now: NOW });
  assert.equal(first.captures[0].already_imported, false);
  const written = rows('SELECT COUNT(*) n FROM nfl_alt_spread_quotes')[0].n;
  assert.equal(written, 8);

  const again = importAltSpreadCapture(payload, { now: new Date('2026-09-11T19:00:00Z') });
  assert.equal(again.captures[0].already_imported, true);
  assert.equal(again.imported_quotes, 0);
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_alt_spread_quotes')[0].n, written,
    'a second import of identical content adds no rows');
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_alt_spread_captures')[0].n, 1);

  // A capture with a DIFFERENT price is a different observation and is kept.
  const moved = structuredClone(payload);
  moved.captured_at = '2026-09-11T17:30:00Z';
  moved.books[0].games[0].alt_six.away_plus6.price = -255;
  const third = importAltSpreadCapture(moved, { now: NOW });
  assert.equal(third.captures[0].already_imported, false);
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_alt_spread_captures')[0].n, 2);
});

test('captures and quotes are append-only', () => {
  clearImports();
  importAltSpreadCapture(capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG] }] }), { now: NOW });
  assert.throws(() => db.exec(`UPDATE nfl_alt_spread_quotes SET price = -100`), /append-only/);
  assert.throws(() => db.exec(`UPDATE nfl_alt_spread_captures SET book = 'elsewhere'`), /append-only/);
});

/* =================================================================== */
/* The parlay arithmetic                                               */
/* =================================================================== */

test('altParlayEquivalent matches hand computation', () => {
  // -250 a side. decimal 1 + 100/250 = 1.4 each; 1.4 * 1.4 = 1.96; profit
  // multiple 0.96, i.e. 96 profit per 100 staked. In American notation a
  // multiple below 1 is a NEGATIVE price: -100/0.96 = -104.1666...
  const a = altParlayEquivalent({ legAPrice: -250, legBPrice: -250 });
  assert.ok(Math.abs(a.decimal - 1.96) < 1e-12);
  assert.ok(Math.abs(a.profit_multiple - 0.96) < 1e-12);
  assert.ok(Math.abs(a.profit_per_100 - 96) < 1e-9, 'this is the "+96" of the informal telling');
  assert.ok(Math.abs(a.american - (-100 / 0.96)) < 1e-9);
  assert.ok(Math.abs(a.american + 104.1666666667) < 1e-6);

  // Two even-money legs parlay to +300. Textbook.
  const b = altParlayEquivalent({ legAPrice: 100, legBPrice: 100 });
  assert.ok(Math.abs(b.decimal - 4) < 1e-12);
  assert.ok(Math.abs(b.profit_multiple - 3) < 1e-12);
  assert.ok(Math.abs(b.american - 300) < 1e-9);

  // Two -110 legs: 1.909090... squared = 3.644628..., multiple 2.644628,
  // American +264.4628... The standard two-team parlay at -110.
  const c = altParlayEquivalent({ legAPrice: -110, legBPrice: -110 });
  assert.ok(Math.abs(c.profit_multiple - ((1 + 100 / 110) ** 2 - 1)) < 1e-12);
  assert.ok(Math.abs(c.american - 264.4628099174) < 1e-6);

  // Asymmetric, to catch a symmetry-only implementation: -300 (1.3333) and
  // -150 (1.6667) -> 2.2222 decimal, multiple 1.2222, American +122.22.
  const d = altParlayEquivalent({ legAPrice: -300, legBPrice: -150 });
  assert.ok(Math.abs(d.decimal - (4 / 3) * (5 / 3)) < 1e-12);
  assert.ok(Math.abs(d.american - 122.2222222222) < 1e-6);

  // Deep favourites: exactly the region a six-point alt actually sits in.
  const e = altParlayEquivalent({ legAPrice: -450, legBPrice: -600 });
  assert.ok(Math.abs(e.decimal - (1 + 100 / 450) * (1 + 100 / 600)) < 1e-12);
  assert.ok(e.american < -100, 'a heavy parlay is still a negative American price');
});

test('altParlayEquivalent labels itself as not a teaser price', () => {
  const result = altParlayEquivalent({ legAPrice: -250, legBPrice: -250 });
  assert.equal(result.is_teaser_price, false);
  assert.equal(result.ledger_eligible, false);
  assert.equal(result.marker, ALT_SPREAD_LEDGER_MARKER);
  assert.match(result.caveat, /different products/);
});

test('altParlayEquivalent refuses inputs that are not real American prices', () => {
  assert.throws(() => altParlayEquivalent({ legAPrice: -110 }), TypeError);
  assert.throws(() => altParlayEquivalent({ legAPrice: -110.5, legBPrice: -110 }), TypeError);
  assert.throws(() => altParlayEquivalent({ legAPrice: 50, legBPrice: -110 }), RangeError);
  assert.throws(() => altParlayEquivalent({ legAPrice: 0, legBPrice: -110 }), RangeError);
});

/* =================================================================== */
/* Cross-both classification                                           */
/* =================================================================== */

test('every one of the eight cross-both numbers is recognised at a six-point move', () => {
  for (const line of CROSS_BOTH_LINES) {
    const verdict = altLegTeaserEquivalence({ mainLine: line, altLine: line + 6 });
    assert.equal(verdict.same_leg_a_teaser_produces, true, `${line} teased to ${line + 6}`);
    assert.equal(verdict.crosses_both_key_numbers, true);
    assert.equal(verdict.teaser_would_reach, line + 6);
  }
});

test('a main line outside the eight is reported as outside, not quietly accepted', () => {
  for (const line of [-9, -6.5, 1, 3.5, -3, 0.5]) {
    const verdict = altLegTeaserEquivalence({ mainLine: line, altLine: line + 6 });
    assert.equal(verdict.same_leg_a_teaser_produces, false, `${line} is not in the family`);
    assert.match(verdict.reason, /not one of the eight cross-both numbers/);
  }
});

test('a move that is not six is called out even from a cross-both main line', () => {
  const verdict = altLegTeaserEquivalence({ mainLine: -7.5, altLine: -1 });
  assert.equal(verdict.observed_move, 6.5);
  assert.equal(verdict.move_is_exactly_six, false);
  assert.equal(verdict.same_leg_a_teaser_produces, false);
  assert.match(verdict.reason, /moved 6\.5 points, not 6/);
  assert.equal(verdict.crosses_both_key_numbers, true, 'it does still cross both, at the move it made');
});

test('the equivalence board pairs teaser-equivalent legs across different games', () => {
  clearImports();
  importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG, NE_AT_SEA] }] }), { now: NOW });
  const board = altTeaserEquivalentBoard({ book: 'fanduel' });
  assert.equal(board.legs_count, 2, 'DAL -7.5 -> -1.5 and NE +2.5 -> +8.5');
  assert.equal(board.pair_count, 1);
  const pair = board.pairs[0];
  assert.notEqual(pair.legs[0].event_key, pair.legs[1].event_key, 'different games, same rule the teaser scan applies');
  const expected = altParlayEquivalent({ legAPrice: -260, legBPrice: -240 });
  assert.ok(Math.abs(pair.american - expected.american) < 1e-9);
  assert.equal(board.is_teaser_price, false);
});

/* =================================================================== */
/* The fence around nfl_teaser_price_ledger                            */
/* =================================================================== */

test('importing alt spreads writes nothing at all to nfl_teaser_price_ledger', () => {
  clearImports();
  db.exec('DELETE FROM nfl_teaser_price_ledger');
  importAltSpreadCapture(
    capture({ books: [{ book: 'fanduel', games: [DAL_AT_NYG, NE_AT_SEA] }] }), { now: NOW });
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_teaser_price_ledger')[0].n, 0);
  assert.equal(assertNoAltPricesInTeaserLedger().clean, true);

  // Structural, and the guarantee that actually holds: the module never names
  // the ledger table.
  const source = fs.readFileSync(
    new URL('../server/services/alt-spread-import.js', import.meta.url), 'utf8');
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/INSERT[\s\S]{0,80}nfl_teaser_price_ledger/i.test(executable),
    'no code path inserts into the teaser price ledger');
});

test('an alt-derived price cannot be filed as a teaser price, even honestly labelled', () => {
  db.exec('DELETE FROM nfl_teaser_price_ledger');
  const parlay = altParlayEquivalent({ legAPrice: -250, legBPrice: -250 });
  const insert = (book, notes) => db.prepare(`INSERT INTO nfl_teaser_price_ledger
    (captured_at, book, teaser_points, legs, american_price, reachable, notes)
    VALUES ('2026-09-11T18:00:00Z', ?, 6, 2, ?, 1, ?)`)
    .run(book, Math.round(parlay.american), notes);

  // The route a careful person would actually take: record the derived number
  // and say where it came from.
  assert.throws(() => insert('fanduel', `derived from ${ALT_SPREAD_LEDGER_MARKER} capture`),
    /not a teaser price/);
  assert.throws(() => insert('fanduel_alt_spread', 'two alt legs parlayed'), /not a teaser price/);
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_teaser_price_ledger')[0].n, 0);

  // And the guard is narrow: a real teaser price still records normally.
  db.prepare(`INSERT INTO nfl_teaser_price_ledger
    (captured_at, book, teaser_points, legs, american_price, reachable, notes)
    VALUES ('2026-09-11T18:00:00Z','draftkings',6,2,100,1,'typed off the bet slip')`).run();
  assert.equal(rows('SELECT COUNT(*) n FROM nfl_teaser_price_ledger')[0].n, 1);
  db.exec('DELETE FROM nfl_teaser_price_ledger');
});

/* =================================================================== */
/* The contract constant                                               */
/* =================================================================== */

test('the documented contract example is itself importable', () => {
  clearImports();
  // A contract nobody validated against is a comment. This one round-trips.
  const result = importAltSpreadCapture(
    { ...ALT_SPREAD_CAPTURE_CONTRACT.example, captured_at: '2026-09-11T17:00:00Z' }, { now: NOW });
  assert.equal(result.imported_quotes, 5);
  assert.equal(result.captures[0].teaser_equivalent_legs, 1);
  assert.equal(result.provenance, ALT_SPREAD_PROVENANCE);
});
