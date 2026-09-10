#!/usr/bin/env node
/**
 * FanDuel line scraper — print (or capture) FanDuel's NFL board.
 *
 *   node scripts/fanduel-lines.mjs             # table of every game: spread, total, moneyline
 *   node scripts/fanduel-lines.mjs --json      # raw quote rows (the shape book-feeds.js writes)
 *   node scripts/fanduel-lines.mjs --csv       # one row per quote, for a spreadsheet
 *   node scripts/fanduel-lines.mjs --capture   # also write the snapshot into nfl_line_snapshots + quote tape
 *   FANDUEL_STATE=pa node scripts/fanduel-lines.mjs
 *
 * Same fetch and parser the scheduler's hourly nfl_book_feeds_slow job uses
 * (server/services/book-feeds.js, provider `fanduel`), so what prints here is
 * exactly what the shopping board, sharp board and steam detector will see.
 */
import '../server/db/index.js';
import { captureBookFeeds, __test } from '../server/services/book-feeds.js';

const args = new Set(process.argv.slice(2));
const state = process.env.FANDUEL_STATE || 'nj';
const url = `https://sbapi.${state}.sportsbook.fanduel.com/api/content-managed-page` +
  '?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York';

const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
if (!res.ok) { console.error(`FanDuel HTTP ${res.status}`); process.exit(1); }
const quotes = __test.parseFanduel(await res.json());
const fmt = n => n == null ? '' : n > 0 ? `+${n}` : String(n);

if (args.has('--json')) {
  console.log(JSON.stringify(quotes, null, 2));
} else if (args.has('--csv')) {
  console.log('commence_time,away,home,market,side,line,price');
  for (const q of quotes) console.log([q.commence_time, q.away, q.home, q.market, q.side, q.line ?? '', q.price].join(','));
} else {
  const games = new Map();
  for (const q of quotes) {
    const key = `${q.commence_time}|${q.away}@${q.home}`;
    const g = games.get(key) ?? { commence: q.commence_time, away: q.away, home: q.home };
    if (q.market === 'spreads' && q.side === q.home) { g.spread = q.line; g.spreadPrice = q.price; }
    if (q.market === 'spreads' && q.side === q.away) g.spreadAwayPrice = q.price;
    if (q.market === 'totals' && q.side === 'Over') { g.total = q.line; g.overPrice = q.price; }
    if (q.market === 'totals' && q.side === 'Under') g.underPrice = q.price;
    if (q.market === 'h2h' && q.side === q.home) g.mlHome = q.price;
    if (q.market === 'h2h' && q.side === q.away) g.mlAway = q.price;
    games.set(key, g);
  }
  const rows = [...games.values()].sort((a, b) => a.commence.localeCompare(b.commence));
  console.log(`FanDuel NFL board (${state}) — ${rows.length} games, ${quotes.length} quotes, ${new Date().toISOString()}\n`);
  console.log('Kickoff (UTC)      Game       Home spread     Total               Moneyline (away / home)');
  for (const g of rows) {
    const kick = String(g.commence).slice(0, 16).replace('T', ' ');
    const game = `${g.away}@${g.home}`.padEnd(10);
    const spread = `${g.home} ${fmt(g.spread)} (${fmt(g.spreadPrice)}/${fmt(g.spreadAwayPrice)})`.padEnd(24);
    const total = `${g.total ?? ''} (o${fmt(g.overPrice)}/u${fmt(g.underPrice)})`.padEnd(20);
    console.log(`${kick}   ${game} ${spread}${total}${fmt(g.mlAway)} / ${fmt(g.mlHome)}`);
  }
}

if (args.has('--capture')) {
  const out = await captureBookFeeds({ providers: ['fanduel'] });
  console.error(`\ncaptured: ${out.quotes} quotes across ${out.events} events -> nfl_line_snapshots (provider free:fanduel)` +
    (out.errors ? ` errors: ${JSON.stringify(out.errors)}` : ''));
}
