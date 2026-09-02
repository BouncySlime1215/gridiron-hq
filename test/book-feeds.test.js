import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The free multi-book feeds, parsed against real payloads captured on
// 2026-09-02 (trimmed to two games each) so a shape change upstream fails
// here before it silently empties the snapshot table.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-book-feeds-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.FREE_BOOK_FEEDS = '1';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
const feeds = await import('../server/services/book-feeds.js');

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const TEAMS = [['SEA', 'Seattle Seahawks'], ['NE', 'New England Patriots'], ['LAR', 'Los Angeles Rams'],
  ['SF', 'San Francisco 49ers'], ['PIT', 'Pittsburgh Steelers'], ['ATL', 'Atlanta Falcons'],
  ['NYG', 'New York Giants'], ['DAL', 'Dallas Cowboys'], ['WAS', 'Washington Commanders'], ['PHI', 'Philadelphia Eagles']];
TEAMS.forEach(([abbr, name], i) => run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (?,?,?,'AFC','West')`, 100 + i, abbr, name));
feeds.clearTeamResolverCache();

test('the team resolver handles every feed spelling', () => {
  const r = feeds.teamResolver();
  assert.equal(r('Seattle Seahawks')?.abbr, 'SEA');
  assert.equal(r('SEA Seahawks')?.abbr, 'SEA', 'Kambi: abbreviation plus nickname');
  assert.equal(r('NE')?.abbr, 'NE', 'OddsTrader: abbreviation');
  assert.equal(r('Seattle')?.abbr, 'SEA', 'OddsTrader: city');
  assert.equal(r('NY Giants')?.abbr, 'NYG', 'Kambi: NY prefix resolves by nickname');
  assert.equal(r('WSH')?.abbr, 'WAS', 'ESPN spelling');
  assert.equal(r('LA')?.abbr, 'LAR', 'nflverse spelling');
  assert.equal(r('Nonexistent FC'), null);
});

test('Bovada coupon parses spreads, totals and moneylines for the whole game', () => {
  const quotes = feeds.__test.parseBovada(fixture('bovada-nfl.json'));
  const seaNe = quotes.filter(q => q.home === 'SEA' && q.away === 'NE');
  assert.ok(seaNe.length >= 6, `expected six full-game quotes, got ${seaNe.length}`);
  const homeSpread = seaNe.find(q => q.market === 'spreads' && q.side === 'SEA');
  assert.equal(homeSpread.line, -3.5);
  assert.equal(homeSpread.price, -115);
  assert.equal(homeSpread.book, 'bovada');
  const over = seaNe.find(q => q.market === 'totals' && q.side === 'Over');
  assert.equal(over.line, 44);
  assert.equal(seaNe.find(q => q.market === 'h2h' && q.side === 'NE').price, 160);
  assert.ok(seaNe.every(q => q.commence_time === '2026-09-10T00:20:00.000Z'));
});

test('Kambi converts thousandth-point lines and keeps the per-outcome change stamp', () => {
  const quotes = feeds.__test.parseKambi(fixture('kambi-nfl.json'));
  const seaNe = quotes.filter(q => q.home === 'SEA' && q.away === 'NE');
  assert.ok(seaNe.length >= 6);
  const spread = seaNe.find(q => q.market === 'spreads' && q.side === 'SEA');
  assert.equal(spread.line, -3.5, '-3500 thousandths is -3.5');
  assert.equal(spread.price, -109);
  assert.equal(spread.book, 'betrivers');
  assert.equal(spread.book_updated_at, '2026-08-31T13:32:34Z');
  const total = seaNe.find(q => q.market === 'totals' && q.side === 'Over');
  assert.equal(total.line, 44.5);
  assert.equal(seaNe.find(q => q.market === 'h2h' && q.side === 'NE').price, 160);
});

test('Pinnacle guest feed yields the full-game straight markets only', () => {
  const quotes = feeds.__test.parsePinnacle(fixture('pinnacle-matchups.json'), fixture('pinnacle-markets.json'));
  const larSf = quotes.filter(q => q.home === 'LAR' && q.away === 'SF');
  assert.ok(larSf.length >= 6, `expected six quotes for LAR/SF, got ${larSf.length}`);
  assert.ok(larSf.every(q => q.book === 'pinnacle'));
  const spread = larSf.find(q => q.market === 'spreads' && q.side === 'LAR');
  assert.equal(spread.line, -3.5);
  assert.equal(spread.price, -108);
  assert.equal(larSf.find(q => q.market === 'totals' && q.side === 'Under').line, 48);
  // Alternates and team totals are not full-game straight quotes.
  assert.equal(larSf.filter(q => q.market === 'spreads').length, 2);
});

test('OddsTrader aggregator maps its provider ids to book keys and keeps the change timestamp', () => {
  const quotes = feeds.__test.parseOddstrader(fixture('oddstrader-nfl.json'));
  const seaNe = quotes.filter(q => q.home === 'SEA' && q.away === 'NE');
  assert.ok(seaNe.length > 20, `expected many books, got ${seaNe.length}`);
  const books = new Set(seaNe.map(q => q.book));
  assert.ok(books.has('pinnacle') && books.has('bovada') && books.has('lowvig'), [...books].join(','));
  assert.ok(!books.has(undefined) && ![...books].some(b => /^unknown/.test(b)));
  const spread = seaNe.find(q => q.market === 'spreads' && q.book === 'betonlineag' && q.side === 'SEA');
  assert.equal(spread.line, -3.5);
  assert.equal(spread.price, -106);
  assert.match(spread.book_updated_at, /^2026-08-/);
  const over = seaNe.find(q => q.market === 'totals' && q.side === 'Over');
  assert.ok(over && Number.isFinite(over.line));
});

test('the merge keys the same game identically across feeds and keeps the more direct book copy', () => {
  const merged = feeds.mergeQuotes({
    oddstrader: [{ home: 'SEA', away: 'NE', commence_time: '2026-09-10T00:20:00Z', book: 'pinnacle', market: 'spreads', side: 'SEA', line: -3.5, price: -110 }],
    pinnacle: [{ home: 'SEA', away: 'NE', commence_time: '2026-09-10T00:20:00.000Z', book: 'pinnacle', market: 'spreads', side: 'SEA', line: -3.5, price: -108 }],
    bovada: [{ home: 'SEA', away: 'NE', commence_time: '2026-09-10T00:20:00.000Z', book: 'bovada', market: 'spreads', side: 'SEA', line: -3.5, price: -115 }]
  });
  assert.equal(merged.length, 2, 'pinnacle appears once, bovada once');
  assert.equal(merged.find(q => q.book === 'pinnacle').provider, 'pinnacle', 'the direct feed wins');
  assert.equal(merged.find(q => q.book === 'pinnacle').price, -108);
  assert.equal(feeds.__test.eventKey('2026-09-10T00:20:00Z', 'NE', 'SEA'), 'nfl:2026-09-10:NE@SEA');
});

test('a capture writes one simultaneous quote set into nfl_line_snapshots and the quote tape', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    const body = u.includes('bovada') ? fixture('bovada-nfl.json')
      : u.includes('kambi') ? fixture('kambi-nfl.json')
        : u.includes('matchups') ? fixture('pinnacle-matchups.json')
          : u.includes('markets/straight') ? fixture('pinnacle-markets.json')
            : fixture('oddstrader-nfl.json');
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const out = await feeds.captureBookFeeds();
    assert.equal(out.errors, undefined, JSON.stringify(out.errors));
    assert.ok(out.quotes > 30, `quotes written: ${out.quotes}`);
    assert.ok(out.book_keys.includes('pinnacle') && out.book_keys.includes('betrivers') && out.book_keys.includes('bovada'));
    const stored = rows(`SELECT provider, COUNT(*) n FROM nfl_line_snapshots WHERE event_id LIKE 'nfl:%' GROUP BY provider`);
    assert.ok(stored.length >= 3, JSON.stringify(stored));
    const seaSpread = rows(`SELECT book, side, line, price, book_updated_at FROM nfl_line_snapshots
      WHERE event_id='nfl:2026-09-10:NE@SEA' AND market='spreads' AND side='Seattle Seahawks' ORDER BY book`);
    assert.ok(seaSpread.length >= 3, 'several books quote the home spread under the canonical event id');
    assert.ok(seaSpread.every(q => q.line === -3.5));
    const tape = rows(`SELECT COUNT(*) n FROM nfl_quote_tape WHERE provider='free-book-feeds'`)[0].n;
    assert.ok(tape > 30, `quote tape rows: ${tape}`);
    assert.equal(out.tape.events, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
