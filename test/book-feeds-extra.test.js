import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The Rotowire and sportsbookreview feeds, parsed against real payloads
// captured on 2026-09-02 (trimmed to two games each) so a shape change
// upstream fails here before it silently empties the snapshot table.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-book-feeds-extra-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.FREE_BOOK_FEEDS = '1';
process.env.NFL_WEEK = '1';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
const { clearTeamResolverCache } = await import('../server/services/team-codes.js');
const feeds = await import('../server/services/book-feeds-extra.js');

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const TEAMS = [['SEA', 'Seattle Seahawks'], ['NE', 'New England Patriots'], ['LAR', 'Los Angeles Rams'], ['SF', 'San Francisco 49ers']];
TEAMS.forEach(([abbr, name], i) => run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (?,?,?,'AFC','West')`, 100 + i, abbr, name));
clearTeamResolverCache();

test('Rotowire Eastern kickoffs land on the UTC date the other feeds key by', () => {
  assert.equal(feeds.easternToIso('2026-09-09 20:20:00'), '2026-09-10T00:20:00.000Z', 'EDT is UTC-4');
  assert.equal(feeds.easternToIso('2026-12-13 13:00:00'), '2026-12-13T18:00:00.000Z', 'EST is UTC-5');
  assert.equal(feeds.easternToIso('nonsense'), null);
});

test('Rotowire table yields per-book spreads, totals and moneylines with prices, Circa included', () => {
  const quotes = feeds.parseRotowire(fixture('rotowire-nfl.json'), { week: 1 });
  const seaNe = quotes.filter(q => q.home === 'SEA' && q.away === 'NE');
  assert.ok(seaNe.length >= 30, `expected many book quotes, got ${seaNe.length}`);
  assert.ok(seaNe.every(q => q.commence_time === '2026-09-10T00:20:00.000Z'));
  const books = new Set(seaNe.map(q => q.book));
  assert.ok(books.has('circa') && books.has('draftkings') && books.has('betmgm') && books.has('caesars'), [...books].join(','));
  assert.ok(!books.has('best') && !books.has('mgm') && !books.has('circasports'), 'prefixes are mapped to book keys');
  const circaHome = seaNe.find(q => q.book === 'circa' && q.market === 'spreads' && q.side === 'SEA');
  const circaAway = seaNe.find(q => q.book === 'circa' && q.market === 'spreads' && q.side === 'NE');
  assert.equal(circaHome.line, -3.5);
  assert.equal(circaAway.line, 3.5);
  assert.ok(Number.isInteger(circaHome.price) && circaHome.price < 0, 'the spread carries its price');
  const over = seaNe.find(q => q.book === 'circa' && q.market === 'totals' && q.side === 'Over');
  const under = seaNe.find(q => q.book === 'circa' && q.market === 'totals' && q.side === 'Under');
  assert.equal(over.line, 44);
  assert.equal(under.line, 44);
  assert.ok(Number.isInteger(over.price) && Number.isInteger(under.price));
  const dkOver = seaNe.find(q => q.book === 'draftkings' && q.market === 'totals' && q.side === 'Over');
  const dkUnder = seaNe.find(q => q.book === 'draftkings' && q.market === 'totals' && q.side === 'Under');
  assert.equal(dkOver.price, -105, 'the away row carries the Over price');
  assert.equal(dkUnder.price, -115, 'the home row carries the Under price');
  const ml = seaNe.filter(q => q.market === 'h2h' && q.book === 'circa');
  assert.equal(ml.length, 2);
  assert.ok(ml.find(q => q.side === 'SEA').price < 0 && ml.find(q => q.side === 'NE').price > 0);
  assert.ok(quotes.every(q => q.book_updated_at === null && q.week === 1));
  // A book Rotowire lists but has no numbers for (Hard Rock in this capture) produces no rows, not nulls.
  assert.equal(seaNe.filter(q => q.book === 'hardrock').length, 0);
  assert.ok(quotes.some(q => q.home === 'LAR' && q.away === 'SF'), 'the second game resolves too');
});

test('SBR point-spread document yields current lines per book and carries each opener', () => {
  const quotes = feeds.parseSbr(fixture('sbr-pointspread.json'), 'pointspread');
  const seaNe = quotes.filter(q => q.home === 'SEA' && q.away === 'NE');
  assert.equal(seaNe.length, 16, 'eight books, two sides each');
  const books = new Set(seaNe.map(q => q.book));
  for (const b of ['betmgm', 'bet365', 'draftkings', 'fanduel', 'fanatics', 'betrivers', 'caesars', 'hardrock']) assert.ok(books.has(b), b);
  assert.ok(seaNe.every(q => q.market === 'spreads' && q.commence_time === '2026-09-10T00:20:00.000Z' && q.book_updated_at === null));
  const mgm = seaNe.find(q => q.book === 'betmgm' && q.side === 'SEA');
  assert.equal(mgm.line, -3.5);
  assert.equal(mgm.price, -110);
  assert.deepEqual(mgm.opening, { line: -4.5, price: -105 });
  assert.equal(seaNe.find(q => q.book === 'betmgm' && q.side === 'NE').line, 3.5);
  assert.ok(quotes.some(q => q.home === 'LAR' && q.away === 'SF'), 'SBR spells the Rams "LA"; the resolver maps it');
  assert.throws(() => feeds.parseSbr({}, 'first-half'), /oddsType/);
});

test('the SBR build id is read from __NEXT_DATA__', () => {
  assert.equal(feeds.sbrBuildId('<script id="__NEXT_DATA__" type="application/json">{"props":{},"buildId":"abc_123","page":"/"}</script>'), 'abc_123');
  assert.equal(feeds.sbrBuildId('<html></html>'), null);
});

test('a capture writes both providers under canonical event ids, with Circa present and openers reported', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  const sbrHtml = '<html><script id="__NEXT_DATA__" type="application/json">{"buildId":"TESTBUILD123"}</script></html>';
  globalThis.fetch = async url => {
    const u = String(url);
    seen.push(u);
    if (u.includes('rotowire')) return { ok: true, status: 200, json: async () => fixture('rotowire-nfl.json') };
    if (u.includes('sportsbookreview.com/betting-odds/nfl-football/') && !u.includes('_next')) {
      return { ok: true, status: 200, text: async () => sbrHtml };
    }
    if (u.includes('/_next/data/TESTBUILD123/')) {
      // Only the point-spread fixture is saved; totals and money-line come back empty.
      const body = u.includes('pointspread') ? fixture('sbr-pointspread.json') : { pageProps: { oddsTables: [] } };
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  try {
    const out = await feeds.captureExtraBookFeeds();
    assert.equal(out.errors, undefined, JSON.stringify(out.errors));
    assert.ok(seen.some(u => u.includes('nfl-games.php?week=1')), 'Rotowire is asked for the current week');
    assert.equal(out.events, 2);
    assert.ok(out.quotes > 60, `quotes written: ${out.quotes}`);
    assert.ok(out.book_keys.includes('circa') && out.book_keys.includes('bet365'));
    assert.ok(out.by_book.circa >= 12, JSON.stringify(out.by_book));
    const stored = rows(`SELECT provider, COUNT(*) n FROM nfl_line_snapshots WHERE event_id LIKE 'nfl:%' GROUP BY provider ORDER BY provider`);
    assert.deepEqual(stored.map(r => r.provider), ['free:rotowire', 'free:sbr']);
    const circa = rows(`SELECT event_id, side, line, price, book_updated_at FROM nfl_line_snapshots
      WHERE book='circa' AND market='spreads' ORDER BY event_id, side`);
    assert.deepEqual([...new Set(circa.map(r => r.event_id))], ['nfl:2026-09-10:NE@SEA', 'nfl:2026-09-11:SF@LAR']);
    assert.ok(circa.every(r => r.book_updated_at === null && Number.isInteger(r.price)));
    assert.equal(circa.find(r => r.side === 'Seattle Seahawks').line, -3.5, 'sides are stored as full team names');
    // Books both feeds carry are kept once per capture (the table keys on book, not provider):
    // Rotowire wins them, SBR contributes the books Rotowire lacks.
    const spreads = rows(`SELECT book, side, provider FROM nfl_line_snapshots WHERE event_id='nfl:2026-09-10:NE@SEA' AND market='spreads' ORDER BY book, side`);
    assert.equal(spreads.length, 22, '11 books x 2 sides: 9 with numbers on Rotowire plus bet365 and Hard Rock from SBR');
    assert.equal(new Set(spreads.map(r => `${r.book}|${r.side}`)).size, 22, 'one row per book and side');
    assert.deepEqual([...new Set(spreads.filter(r => r.provider === 'free:sbr').map(r => r.book))].sort(), ['bet365', 'hardrock']);
    assert.equal(spreads.find(r => r.book === 'draftkings').provider, 'free:rotowire');
    assert.equal(out.deduped, 2 * 2 * 6 * 1, 'six overlapping books x two sides x two games, spreads only in this fixture');
    const merged = feeds.mergeExtraQuotes({
      sbr: [{ home: 'SEA', away: 'NE', commence_time: '2026-09-10T00:20:00.000Z', book: 'draftkings', market: 'spreads', side: 'SEA', line: -3.5, price: -105 }],
      rotowire: [{ home: 'SEA', away: 'NE', commence_time: '2026-09-10T00:20:00.000Z', book: 'draftkings', market: 'spreads', side: 'SEA', line: -3.5, price: -110 }]
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].provider, 'rotowire');
    assert.ok(out.openers.length >= 32 && out.openers.every(o => /^nfl:2026-09-1[01]:/.test(o.event_id) && o.market === 'spreads'));
    const opener = out.openers.find(o => o.book === 'betmgm' && o.side === 'SEA' && o.event_id === 'nfl:2026-09-10:NE@SEA');
    assert.deepEqual(opener, { event_id: 'nfl:2026-09-10:NE@SEA', book: 'betmgm', market: 'spreads', side: 'SEA', line: -4.5, price: -105 });
    assert.equal(rows(`SELECT COUNT(*) n FROM nfl_line_snapshots WHERE line=-4.5 AND book='betmgm'`)[0].n, 0, 'openers are not written');
    // The quote tape is never touched: its module is not even imported, so the table does not exist here.
    assert.equal(rows(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='nfl_quote_tape'`)[0].n, 0, 'the quote tape is left alone');
    // A second capture in the same instant is idempotent (ON CONFLICT DO NOTHING).
    const again = await feeds.captureExtraBookFeeds({ providers: ['rotowire'] });
    assert.equal(again.errors, undefined);
    assert.ok(again.providers.rotowire > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the kill switch is honoured per provider list and status reads back what was written', async () => {
  const status = feeds.extraBookFeedStatus();
  assert.equal(status.enabled, true);
  assert.deepEqual(status.providers, ['rotowire', 'sbr']);
  assert.ok(status.by_provider.find(p => p.provider === 'free:rotowire')?.quotes > 0);
  assert.ok(status.circa_recent.length >= 1);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const out = await feeds.captureExtraBookFeeds({ providers: ['sbr'] });
    assert.deepEqual(out.errors, { sbr: 'offline' });
    assert.equal(out.quotes, 0);
    assert.equal(out.providers.sbr, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
