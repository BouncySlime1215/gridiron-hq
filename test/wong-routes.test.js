/**
 * The Wong teaser desk's HTTP contract.
 *
 * Driven through a real Express app on an ephemeral port, against a seeded
 * temp database, because the thing under test is the ROUTER: its statuses, its
 * field names and the shapes a client is being written against right now.
 *
 * The board fixture is synthetic. The measured history is NOT: `game_lines` is
 * seeded with the real 1999-2024 counts for -7.0, -7.5, +2.5, -8.5 and -6.5
 * from the owner's database, so the ranking assertions below are made against
 * the same numbers the live board ranks on rather than against invented ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-wong-routes-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'wong.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
// Only the one migration that owns the execution ledger. The full chain is not
// needed here and would couple this suite to every other migration in flight.
const { up: createExecutionLedger } = await import('../server/migrations/012_teaser_execution_ledger.js');
createExecutionLedger(db);

const wong = await import('../server/routes/wong.js');
const { default: wongRouter, captureRunners, seasonModuleSource, SEASON_MODULE_PATH } = wong;

const app = express();
app.use(express.json());
app.use('/api/betting/wong', wongRouter);
// The application's own error handler, verbatim from server/index.js.
app.use((err, req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500)
  .json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const get = url => fetch(base + url);
const post = (url, body) => fetch(base + url,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const put = (url, body) => fetch(base + url,
  { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------- the fixture */

/**
 * The real measured record of five posted lines, 1999-2024, reproduced as
 * `game_lines` rows.
 *
 *     -7.0  n=472  346 wins, 12 pushes  ->  346/460 = 75.22% of decided
 *     -7.5  n=275  206 wins,  0 pushes  ->  206/275 = 74.91%
 *     +2.5  n=492  374 wins,  0 pushes  ->  374/492 = 76.02%
 *     -8.5  n= 93   68 wins,  0 pushes  ->   68/ 93 = 73.12%
 *     -6.5  n=331  235 wins,  0 pushes  ->  235/331 = 71.00%   (does not cross 7)
 *
 * A leg posted at `line` and teased six points resolves on `margin + line + 6`,
 * so each outcome is produced by choosing a margin: a comfortable +10 for the
 * wins, 0 (or a big loss, for the dog line) for the losses, and for -7.0 the
 * one margin that pushes it, exactly 1.
 */
const HISTORY = [
  { line: -7, wins: 346, pushes: 12, losses: 114, winMargin: 10, pushMargin: 1, lossMargin: 0 },
  { line: -7.5, wins: 206, pushes: 0, losses: 69, winMargin: 10, lossMargin: 0 },
  { line: 2.5, wins: 374, pushes: 0, losses: 118, winMargin: 0, lossMargin: -20 },
  { line: -8.5, wins: 68, pushes: 0, losses: 25, winMargin: 10, lossMargin: 0 },
  { line: -6.5, wins: 235, pushes: 0, losses: 96, winMargin: 10, lossMargin: 0 },
];

function seedHistory() {
  db.exec('DELETE FROM game_lines');
  const insert = db.prepare(`INSERT OR REPLACE INTO game_lines
    (season, week, team, opponent, spread, team_score, opp_score) VALUES (?,?,?,?,?,?,?)`);
  let n = 0;
  db.exec('BEGIN');
  for (const cell of HISTORY) {
    const margins = [
      ...Array(cell.wins).fill(cell.winMargin),
      ...Array(cell.pushes).fill(cell.pushMargin ?? 0),
      ...Array(cell.losses).fill(cell.lossMargin),
    ];
    for (const margin of margins) {
      insert.run(2000 + (n % 20), 1 + (n % 17), `T${n}`, `O${n}`, cell.line, 30 + margin, 30);
      n++;
    }
  }
  db.exec('COMMIT');
}

const NOW = new Date();
const KICK = new Date(NOW.getTime() + 3 * 86400000).toISOString();
const LATER = new Date(NOW.getTime() + 4 * 86400000).toISOString();

function snapshot(eventId, home, away, side, line, { minutesAgo = 20, book = 'draftkings',
  commence = KICK, price = -110 } = {}) {
  db.prepare(`INSERT OR REPLACE INTO nfl_line_snapshots
    (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price, provider)
    VALUES (?,?,?,?,?,?,'spreads',?,?,?, 'free:rotowire')`).run(
    new Date(NOW.getTime() - minutesAgo * 60000).toISOString(),
    eventId, commence, home, away, book, side, line, price);
}

let batchSeq = 0;
function tapeQuote(eventId, home, away, side, line, { minutesAgo = 10, book = 'pinnacle',
  commence = KICK, price = -110 } = {}) {
  const at = new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
  const batchId = `batch-${batchSeq++}`;
  db.prepare(`INSERT INTO nfl_quote_batches
    (batch_id, provider, requested_at, snapshot_at, mode, markets, source_ref, events, quotes,
     raw_hash, tape_version, created_at) VALUES (?,?,?,?, 'test','spreads','test',1,1,'h','v1',?)`)
    .run(batchId, 'test', at, at, at);
  db.prepare(`INSERT INTO nfl_quote_tape
    (quote_id, batch_id, provider, provider_event_id, commence_time, snapshot_at, bookmaker_key,
     market, period, side_key, side_name, home_team, away_team, line, american_price,
     implied_probability, raw_json, tape_version, created_at)
    VALUES (?,?, 'test', ?,?,?,?, 'spreads','full_game', ?,?,?,?,?,?, 0.5, '{}', 'v1', ?)`).run(
    `q-${batchSeq}-${eventId}-${side}`, batchId, eventId, commence, at, book,
    side.toLowerCase().replace(/\W/g, ''), side, home, away, line, price, at);
}

/** A full two-sided game, so the mirror check passes. */
function game(eventId, home, away, homeLine, opts = {}) {
  const write = opts.book && ['pinnacle', 'fanduel'].includes(opts.book) ? tapeQuote : snapshot;
  write(eventId, home, away, home, homeLine, opts);
  write(eventId, home, away, away, -homeLine, opts);
}

function recordPrice(americanPrice, { book = 'draftkings', hoursAgo = 1, reachable = 1 } = {}) {
  db.prepare(`INSERT OR REPLACE INTO nfl_teaser_price_ledger
    (captured_at, book, teaser_points, legs, american_price, different_games_required, push_rule, reachable)
    VALUES (?,?,6,2,?,1,'push_removes_leg_reduces_to_single',?)`).run(
    new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(), book, americanPrice, reachable);
}

/**
 * The quote tape is deliberately append-only — migration 032 puts no-update
 * and no-delete triggers on it ("quote tape is immutable"), because a capture
 * is evidence about what a book was charging at an instant and evidence is not
 * edited. So the tape is never cleared here either; re-seeding writes a newer
 * quote, and `bookSpreadBoard` ranks per (event, side) on the capture clock,
 * so the newest row is the one that shows up.
 */
const clearBoard = () => {
  db.exec('DELETE FROM nfl_line_snapshots');
  db.exec('DELETE FROM nfl_teaser_price_ledger');
};

const JAX = 'nfl:2026-09-13:CLE@JAX';
const NYJ = 'nfl:2026-09-13:NYJ@TEN';

/**
 * The board the ranking tests are made against.
 *
 *   JAX game — DraftKings -7.0, FanDuel -7.5, Pinnacle -7.5. All three cross
 *              both key numbers; DK's is the measured best and the only one
 *              outside the classic window.
 *   NYJ game — DraftKings has the Jets +1.5 (qualifies), Pinnacle has them
 *              +3.5 (does not), FanDuel does not list the game at all.
 */
function seedBoard() {
  clearBoard();
  recordPrice(100, { book: 'draftkings' });
  game(JAX, 'Jacksonville Jaguars', 'Cleveland Browns', -7, { book: 'draftkings' });
  game(JAX, 'Jacksonville Jaguars', 'Cleveland Browns', -7.5, { book: 'fanduel' });
  game(JAX, 'Jacksonville Jaguars', 'Cleveland Browns', -7.5, { book: 'pinnacle' });
  game(NYJ, 'Tennessee Titans', 'New York Jets', -1.5, { book: 'draftkings', commence: LATER });
  game(NYJ, 'Tennessee Titans', 'New York Jets', -3.5, { book: 'pinnacle', commence: LATER });
}

seedHistory();

/* ------------------------------------------------------------------ tests */

test('the measured history the ranking depends on reproduces the real rates', async () => {
  const { teasedLegRate, clearRateCache } = await import('../server/betting/nfl/strategy/teaser-leg-rates.js');
  clearRateCache();
  assert.equal(+(teasedLegRate(-7).rate_of_decided * 100).toFixed(2), 75.22);
  assert.equal(+(teasedLegRate(-7.5).rate_of_decided * 100).toFixed(2), 74.91);
  assert.equal(+(teasedLegRate(2.5).rate_of_decided * 100).toFixed(2), 76.02);
  assert.equal(+(teasedLegRate(-8.5).rate_of_decided * 100).toFixed(2), 73.12);
  assert.equal(+(teasedLegRate(-6.5).rate_of_decided * 100).toFixed(2), 71.00);
  assert.equal(teasedLegRate(-7).pushes, 12, '-7 is one of the four lines that can push');
  assert.equal(teasedLegRate(-7.5).pushes, 0, 'a half point cannot push');
});

test('GET /board answers in the shape the client is written against', async () => {
  seedBoard();
  const res = await get('/api/betting/wong/board?books=draftkings,fanduel,pinnacle');
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.generated_at, 'generated_at');
  assert.deepEqual(body.books.map(book => book.book), ['draftkings', 'fanduel', 'pinnacle']);
  for (const book of body.books) {
    for (const field of ['book', 'provenance', 'source', 'captured_at', 'age_minutes',
      'games_on_board', 'qualifying_legs', 'stale_legs', 'price', 'candidates', 'blocked_reasons']) {
      assert.ok(field in book, `books[].${field} is missing`);
    }
    assert.ok(Array.isArray(book.candidates));
    assert.ok(Array.isArray(book.blocked_reasons));
  }

  // Provenance is a real difference in evidentiary weight and is carried, not
  // flattened: DraftKings is a second-hand hourly scrape, Pinnacle is the tape.
  const byBook = Object.fromEntries(body.books.map(book => [book.book, book]));
  assert.equal(byBook.draftkings.provenance, 'second_hand_aggregator');
  assert.equal(byBook.draftkings.source, 'nfl_line_snapshots');
  assert.equal(byBook.pinnacle.provenance, 'first_hand_tape');
  assert.equal(byBook.pinnacle.source, 'nfl_quote_tape');
  assert.equal(byBook.fanduel.source, 'nfl_quote_tape');
  assert.ok(byBook.draftkings.age_minutes > 0);

  assert.equal(body.comparison.length, 2);
  for (const game of body.comparison) {
    for (const field of ['event_id', 'home_team', 'away_team', 'commence_time', 'by_book', 'best']) {
      assert.ok(field in game, `comparison[].${field} is missing`);
    }
    for (const entry of game.by_book) {
      for (const field of ['book', 'line', 'side', 'price', 'qualifies', 'measured_rate',
        'provenance', 'age_minutes']) {
        assert.ok(field in entry, `comparison[].by_book[].${field} is missing`);
      }
    }
  }

  // DraftKings has both games and both are legal legs, so it has one pair.
  assert.equal(byBook.draftkings.qualifying_legs, 2);
  assert.equal(byBook.draftkings.candidates.length, 1);
  const [candidate] = byBook.draftkings.candidates;
  assert.notEqual(candidate.legs[0].event_id, candidate.legs[1].event_id);
  for (const leg of candidate.legs) {
    assert.equal(leg.provenance, 'second_hand_aggregator');
    assert.ok(Number.isFinite(leg.age_minutes));
  }
});

test('the comparison ranks by MEASURED rate, not by how deep in the window a number sits', async () => {
  seedBoard();
  const body = await (await get('/api/betting/wong/board?books=draftkings,fanduel,pinnacle')).json();
  const jax = body.comparison.find(game => game.event_id === JAX);

  // Every book has this game inside the qualifying window. Qualification
  // therefore separates nothing here, and if the ranking used it the answer
  // would be arbitrary.
  assert.ok(jax.by_book.every(entry => entry.qualifies === true));
  const lines = Object.fromEntries(jax.by_book.map(entry => [entry.book, entry.line]));
  assert.deepEqual(lines, { draftkings: -7, fanduel: -7.5, pinnacle: -7.5 });

  // The measured rates, and the ranking that follows from them.
  const rates = Object.fromEntries(jax.by_book.map(entry => [entry.book, entry.measured_rate]));
  assert.equal(+(rates.draftkings * 100).toFixed(2), 75.22);
  assert.equal(+(rates.fanduel * 100).toFixed(2), 74.91);
  assert.equal(jax.best.book, 'draftkings');
  assert.equal(jax.best.line, -7);
  assert.equal(jax.best.teased_to, -1);
  assert.match(jax.best.reason, /NOT the number deepest inside the classic window/);

  // The shop-in named explicitly: -7.0 -> -7.5 is the most common move
  // available and it is a measured downgrade.
  const move = jax.shop_moves.find(entry => entry.to_book === 'fanduel');
  assert.equal(move.from_line, -7);
  assert.equal(move.to_line, -7.5);
  assert.ok(move.rate_delta < 0, 'moving to -7.5 lowers the measured rate');
  assert.equal(+(move.rate_delta * 100).toFixed(2), -0.31);
  assert.equal(move.folklore_trap, true, '-7.5 is inside the classic window and -7.0 is not');
  assert.match(move.note, /75\.22% against -7\.5's 74\.91%/);
  assert.equal(jax.shop_in_downgrades, 2, 'both -7.5 books are downgrades from -7.0');

  // ...and the honest caveat travels with it: a 0.31pp gap on these two cells
  // is inside their combined standard error, so the instruction is "do not pay
  // half a point to move", not "-7.0 is measurably better".
  assert.equal(move.rate_delta_within_noise, true);
  assert.match(move.verdict, /inside the noise/);

  // The disagreement itself is surfaced, since that is the whole reason to
  // look at three books at once.
  assert.equal(jax.books_disagree, true);
  assert.equal(jax.line_spread, 0.5);
  assert.deepEqual(jax.lines_offered.map(line => line.line), [-7, -7.5]);
});

test('a book outside the window, and a book that does not list the game at all', async () => {
  seedBoard();
  const body = await (await get('/api/betting/wong/board?books=draftkings,fanduel,pinnacle')).json();
  const nyj = body.comparison.find(game => game.event_id === NYJ);

  assert.equal(nyj.anchor_side, 'New York Jets');
  const entries = Object.fromEntries(nyj.by_book.map(entry => [entry.book, entry]));

  assert.equal(entries.draftkings.line, 1.5);
  assert.equal(entries.draftkings.qualifies, true);
  assert.equal(entries.pinnacle.line, 3.5);
  assert.equal(entries.pinnacle.qualifies, false, '+3.5 buys 7 but only moves the push to 3');
  // A non-qualifying number still carries its measured rate rather than a
  // blank, so the comparison can say WHY it is not the answer.
  assert.equal(entries.fanduel.line, null);
  assert.match(entries.fanduel.missing_reason, /has no spread for this game/);
  assert.deepEqual(nyj.books_missing, ['fanduel']);

  assert.equal(nyj.best.book, 'draftkings');
  assert.equal(nyj.best.line, 1.5);
  assert.equal(nyj.books_qualifying, 1);
});

test('a stale quote is on the board, flagged, and not playable', async () => {
  clearBoard();
  recordPrice(100, { book: 'draftkings' });
  // Past the 120-minute budget for the hourly aggregator tier.
  game(JAX, 'Jacksonville Jaguars', 'Cleveland Browns', -7, { book: 'draftkings', minutesAgo: 400 });
  const body = await (await get('/api/betting/wong/board?books=draftkings')).json();
  const jax = body.comparison.find(game => game.event_id === JAX);
  const dk = jax.by_book.find(entry => entry.book === 'draftkings');

  assert.equal(dk.qualifies, true, 'the NUMBER still qualifies');
  assert.equal(dk.fresh, false);
  assert.equal(dk.playable, false, 'a qualifying number that is four hours old is a memory');
  assert.deepEqual(jax.books_stale, ['draftkings']);
  assert.equal(body.books[0].stale_legs, 1);
  assert.match(body.books[0].blocked_reasons.join(' '), /older than 120 minutes/);
});

/* ------------------------------------------------------- ticket validation */

const goodLegs = [
  { event_id: JAX, team: 'Jacksonville Jaguars', line: -7, teased_to: -1 },
  { event_id: NYJ, team: 'New York Jets', line: 1.5, teased_to: 7.5 },
];
const ticket = (overrides = {}) => ({
  book: 'draftkings', american_price: 100, stake_units: 1, mode: 'paper',
  legs: goodLegs, ...overrides,
});

test('POST /tickets refuses everything that is not this bet', async () => {
  seedBoard();

  const cases = [
    // Two family lines on one event. The family makes this impossible in
    // practice — a game's two sides can never both qualify — but it is also a
    // book rule and a schema constraint, so it is refused explicitly rather
    // than left to be impossible by luck.
    ['same game twice',
      ticket({ legs: [goodLegs[0], { event_id: JAX, team: 'Cleveland Browns', line: 2.5, teased_to: 8.5 }] }),
      /both legs are the same game/],
    // The real mirror of a -7 favourite is a +7 dog, which is not in the set.
    ['both sides of one game as they are actually posted',
      ticket({ legs: [goodLegs[0], { event_id: JAX, team: 'Cleveland Browns', line: 7, teased_to: 13 }] }),
      /does not cross both 3 and 7/],
    ['one leg', ticket({ legs: [goodLegs[0]] }), /exactly 2 legs; got 1/],
    ['three legs', ticket({ legs: [...goodLegs, { event_id: 'nfl:x', team: 'A', line: 2.5 }] }),
      /exactly 2 legs; got 3/],
    ['a line that does not cross both key numbers',
      ticket({ legs: [{ ...goodLegs[0], line: -6.5, teased_to: -0.5 }, goodLegs[1]] }),
      /does not cross both 3 and 7/],
    ['a line nobody posts', ticket({ legs: [{ ...goodLegs[0], line: -9, teased_to: -3 }, goodLegs[1]] }),
      /does not cross both 3 and 7/],
    ['zero stake', ticket({ stake_units: 0 }), /stake_units must be greater than 0/],
    ['negative stake', ticket({ stake_units: -2 }), /stake_units must be greater than 0/],
    ['a stake larger than the ladder allows', ticket({ stake_units: 50 }), /at most 5/],
    ['no mode', ticket({ mode: undefined }), /mode must be 'paper' or 'placed'/],
    ['a price that is not odds', ticket({ american_price: 5 }), /American odds/],
    ['a teased_to that is not the line plus six',
      ticket({ legs: [{ ...goodLegs[0], teased_to: 0 }, goodLegs[1]] }), /is not -7 plus 6 points/],
    ['a book with no readable lines', ticket({ book: 'some-corner-shop' }), /no known spread source/],
  ];

  for (const [label, body, expected] of cases) {
    const res = await post('/api/betting/wong/tickets', body);
    assert.equal(res.status, 400, `${label}: expected 400`);
    const json = await res.json();
    assert.match(json.error, expected, label);
    assert.ok(Array.isArray(json.errors), `${label}: every failed rule is reported, not just the first`);
  }

  assert.equal(db.prepare('SELECT COUNT(*) n FROM nfl_teaser_executions').get().n, 0,
    'nothing rejected reached the ledger');
});

test('POST /tickets records a legal ticket, and refuses the same one twice', async () => {
  seedBoard();
  const res = await post('/api/betting/wong/tickets', ticket({ mode: 'placed', stake_units: 2 }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.logged, true);
  assert.equal(body.mode, 'placed');
  assert.equal(body.book, 'draftkings');
  assert.equal(body.stake_units, 2);
  assert.equal(body.legs.length, 2);
  assert.equal(body.reduced_payout_verified, false);
  // The brief's "record via the existing recordTeaserExecution path" cannot
  // apply to DraftKings — see the comment on recordWongTicket. The response
  // says which path ran rather than leaving it to be inferred.
  assert.equal(body.recorded_via, 'wong desk direct write');
  assert.match(body.recorded_via_reason, /simultaneousQuotes/);
  // Priced off the pooled family rate, never off either leg's own line.
  const { familyRate } = await import('../server/betting/nfl/strategy/teaser-leg-rates.js');
  assert.equal(body.expected_leg_rate, +familyRate({ side: 'all' }).rate_of_decided.toFixed(4));
  assert.ok(body.expected_ev > 0, 'a +100 two-leg teaser on this family is worth taking');
  assert.equal(body.warnings, undefined, 'both legs were verifiable on the live desk board');

  const stored = db.prepare('SELECT * FROM nfl_teaser_executions WHERE id=?').get(body.execution_id);
  assert.equal(stored.status, 'open');
  assert.equal(stored.book, 'draftkings');
  const legs = db.prepare('SELECT * FROM nfl_teaser_execution_legs WHERE execution_id=? ORDER BY slot')
    .all(body.execution_id);
  assert.deepEqual(legs.map(leg => [leg.market_line, leg.teased_line]), [[-7, -1], [1.5, 7.5]]);
  assert.equal(legs[0].opponent, 'Cleveland Browns');

  const again = await post('/api/betting/wong/tickets', ticket({ mode: 'placed', stake_units: 2 }));
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already logged as placed/);
});

test('GET /tickets is the ledger, and season filters on the legs kicking off', async () => {
  const all = await (await get('/api/betting/wong/tickets')).json();
  assert.ok(all.summary.tickets >= 1);
  assert.equal(all.season, null);

  const inSeason = await (await get('/api/betting/wong/tickets?season=2026')).json();
  assert.equal(inSeason.season, 2026);
  assert.equal(inSeason.season_summary.tickets, inSeason.executions.length);
  assert.ok(inSeason.executions.length >= 1);

  const other = await (await get('/api/betting/wong/tickets?season=2019')).json();
  assert.equal(other.executions.length, 0);
  assert.equal(other.season_summary.tickets, 0);

  assert.equal((await get('/api/betting/wong/tickets?season=nope')).status, 400);
});

test('POST /tickets/:id/settle grades against the teased number', async () => {
  const ledger = await (await get('/api/betting/wong/tickets')).json();
  const open = ledger.executions.find(execution => execution.status === 'open');
  assert.ok(open, 'the ticket logged above is still open');

  const res = await post(`/api/betting/wong/tickets/${open.id}/settle`, {
    scores: [
      // JAX teased to -1: a 3-point win covers.
      { event_id: JAX, team_score: 24, opponent_score: 21 },
      // Jets teased to +7.5: losing by 3 covers.
      { event_id: NYJ, team_score: 17, opponent_score: 20 },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.settled, true);
  assert.equal(body.status, 'won');
  assert.ok(body.profit_units > 0);

  const missing = await post(`/api/betting/wong/tickets/${open.id}/settle`, { scores: [] });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /already|required for each leg/);
});

/* ------------------------------------------------------ the delegated four */

test('the four season endpoints 503 rather than stub when the module is not there yet', async () => {
  assert.equal(SEASON_MODULE_PATH, '../betting/nfl/strategy/teaser-season.js',
    'the default import path is the real module, not the fixture');
  const original = seasonModuleSource.path;
  seasonModuleSource.path = './definitely-not-written-yet.js';
  try {
    for (const [method, url] of [['get', '/api/betting/wong/settings'],
      ['put', '/api/betting/wong/settings'],
      ['get', '/api/betting/wong/season?season=2026'],
      ['get', '/api/betting/wong/combos?book=draftkings&maxTickets=4']]) {
      const res = method === 'put' ? await put(url, {}) : await get(url);
      assert.equal(res.status, 503, `${method.toUpperCase()} ${url}`);
      const body = await res.json();
      assert.equal(body.error, 'season module not available yet');
      assert.equal(body.module, 'server/betting/nfl/strategy/teaser-season.js');
    }
  } finally { seasonModuleSource.path = original; }
});

test('a season module that exists but is half-written is still a 503, not a wrong answer', async () => {
  const half = path.join(temp, 'half-season.js');
  fs.writeFileSync(half, 'export function wongSettings() { return { ok: true }; }\n');
  const original = seasonModuleSource.path;
  seasonModuleSource.path = `file://${half}`;
  try {
    assert.equal((await get('/api/betting/wong/settings')).status, 200);
    const res = await get('/api/betting/wong/combos?book=draftkings');
    assert.equal(res.status, 503);
    assert.match((await res.json()).detail, /does not export bestTicketSet/);
  } finally { seasonModuleSource.path = original; }
});

test('the four season endpoints delegate verbatim once the module lands', async () => {
  const fixture = path.join(temp, 'season-fixture.js');
  fs.writeFileSync(fixture, `
    export function wongSettings() { return { source: 'fixture', bankroll_units: 40 }; }
    export function saveWongSettings(body) { return { saved: true, got: body }; }
    export function wongSeason({ season }) { return { source: 'fixture', season }; }
    export function bestTicketSet({ book, maxTickets }) { return { source: 'fixture', book, maxTickets }; }
  `);
  const original = seasonModuleSource.path;
  seasonModuleSource.path = `file://${fixture}`;
  try {
    assert.deepEqual(await (await get('/api/betting/wong/settings')).json(),
      { source: 'fixture', bankroll_units: 40 });
    assert.deepEqual(await (await put('/api/betting/wong/settings', { bankroll_units: 12 })).json(),
      { saved: true, got: { bankroll_units: 12 } });
    assert.deepEqual(await (await get('/api/betting/wong/season?season=2026')).json(),
      { source: 'fixture', season: 2026 });
    assert.deepEqual(await (await get('/api/betting/wong/combos?book=draftkings&maxTickets=4')).json(),
      { source: 'fixture', book: 'draftkings', maxTickets: 4 });
    assert.equal((await get('/api/betting/wong/combos?maxTickets=999')).status, 400);
  } finally { seasonModuleSource.path = original; }
});

/* ------------------------------------------------------------- the refresh */

test('POST /refresh captures first, then re-scans', async () => {
  seedBoard();
  const original = { ...captureRunners };
  let ran = [];
  captureRunners.extra_book_feeds = async () => {
    ran.push('extra_book_feeds');
    // A capture that actually puts a new number on the board.
    snapshot(JAX, 'Jacksonville Jaguars', 'Cleveland Browns', 'Jacksonville Jaguars', -8.5,
      { minutesAgo: 0 });
    snapshot(JAX, 'Jacksonville Jaguars', 'Cleveland Browns', 'Cleveland Browns', 8.5,
      { minutesAgo: 0 });
    return { captured_at: new Date().toISOString(), events: 1, quotes: 2, book_keys: ['draftkings'] };
  };
  captureRunners.book_feeds = async () => {
    ran.push('book_feeds');
    return { captured_at: new Date().toISOString(), events: 1, quotes: 3, book_keys: ['pinnacle'] };
  };
  try {
    const res = await post('/api/betting/wong/refresh', { books: 'draftkings' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(ran.sort(), ['book_feeds', 'extra_book_feeds']);
    assert.ok(body.refreshed_at);
    assert.equal(typeof body.duration_ms, 'number');
    assert.deepEqual(body.captures.map(capture => [capture.source, capture.ok, capture.rows]).sort(),
      [['book_feeds', true, 3], ['extra_book_feeds', true, 2]]);
    assert.equal(body.stale, false);
    assert.equal(body.stale_reason, null);
    // The board that comes back is the RE-SCAN, not the one from before.
    const jax = body.board.comparison.find(game => game.event_id === JAX);
    assert.equal(jax.by_book.find(entry => entry.book === 'draftkings').line, -8.5);
  } finally { Object.assign(captureRunners, original); }
});

test('POST /refresh returns the stale board with a flag when a capture fails', async () => {
  seedBoard();
  const original = { ...captureRunners };
  captureRunners.extra_book_feeds = async () => { throw new Error('HTTP 429'); };
  captureRunners.book_feeds = async () => ({ skipped: true, reason: 'FREE_BOOK_FEEDS=0' });
  try {
    const res = await post('/api/betting/wong/refresh', { books: 'draftkings,fanduel,pinnacle' });
    // Not an error page. The operator asked "is this current?" and gets an
    // answer plus the board they already had.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stale, true);
    assert.match(body.stale_reason, /HTTP 429/);
    assert.match(body.stale_reason, /FREE_BOOK_FEEDS=0/);

    const captures = Object.fromEntries(body.captures.map(capture => [capture.source, capture]));
    assert.equal(captures.extra_book_feeds.ok, false);
    assert.equal(captures.extra_book_feeds.rows, 0);
    assert.equal(captures.extra_book_feeds.error, 'HTTP 429');
    assert.equal(captures.book_feeds.ok, false);
    assert.equal(captures.book_feeds.skipped, true);

    // ...and the board is a real board, flagged.
    assert.equal(body.board.stale, true);
    assert.equal(body.board.comparison.length, 2);
    assert.equal(body.board.books.length, 3);
    assert.equal(body.board.comparison.find(game => game.event_id === JAX).best.book, 'draftkings');
  } finally { Object.assign(captureRunners, original); }
});

test('a rate-limited provider inside an otherwise-successful capture is a warning, not a failure', async () => {
  seedBoard();
  const original = { ...captureRunners };
  captureRunners.extra_book_feeds = async () => ({ captured_at: new Date().toISOString(),
    events: 1, quotes: 4, book_keys: ['draftkings'],
    errors: { sbr: 'skipped: backing off 240s after a recent failure' } });
  captureRunners.book_feeds = async () => ({ captured_at: new Date().toISOString(),
    events: 0, quotes: 0, book_keys: [], errors: { pinnacle: 'HTTP 403' } });
  try {
    const body = await (await post('/api/betting/wong/refresh', {})).json();
    const captures = Object.fromEntries(body.captures.map(capture => [capture.source, capture]));
    assert.equal(captures.extra_book_feeds.ok, true, 'rows were written despite one provider backing off');
    assert.deepEqual(captures.extra_book_feeds.warnings, ['sbr: skipped: backing off 240s after a recent failure']);
    assert.equal(captures.book_feeds.ok, false);
    assert.match(captures.book_feeds.error, /pinnacle: HTTP 403/);
    assert.equal(body.stale, false, 'one capture wrote rows, so the board is not stale');
  } finally { Object.assign(captureRunners, original); }
});

test('an unknown book is reported, never silently dropped', async () => {
  seedBoard();
  const body = await (await get('/api/betting/wong/board?books=draftkings,nowhere-books')).json();
  assert.equal(body.books.length, 2);
  const unknown = body.books.find(book => book.book === 'nowherebooks');
  assert.match(unknown.error, /no known spread source/);
  assert.deepEqual(body.summary.books_unresolved, ['nowherebooks']);
});
