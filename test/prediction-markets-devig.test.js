import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// FIX #19. `exchangeVsBook` used to build its "book probability" by pushing the
// ESPN reference SPREAD through normCdf(-spread/14.16). Its own docstring called
// that an approximation of a no-vig moneyline, and it is not even the same
// quantity a Kalshi contract pays on. Where both sides of a book moneyline are
// stored, that pair is now de-vigged with Shin's method from nfl-devig.js — a
// quoted fair price rather than a modelled one — and the spread conversion is
// kept only as a labelled fallback for games with no two-sided moneyline.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pm-devig-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { shinDevig } = await import('../server/services/nfl-devig.js');
const pm = await import('../server/services/prediction-markets.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const NOW = '2026-09-20T12:00:00.000Z';

function kalshiQuote(away, home, subject, yes) {
  run(`INSERT INTO prediction_market_quotes
       (captured_at, venue, ticker, title, team, event_key, yes_price, no_price,
        open_interest, volume, close_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  NOW, 'kalshi', `KXNFLGAME-26SEP21${away}${home}-${subject}`, `${away} at ${home}`,
  subject, `${away}@${home}`, yes, 1 - yes, 900, 5000, null);
}

function moneyline(away, home, book, awayPrice, homePrice, at = NOW) {
  const eventId = `nfl:2026-09-21:${away}@${home}`;
  for (const [side, price] of [[away, awayPrice], [home, homePrice]]) {
    run(`INSERT INTO nfl_line_snapshots
         (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
    at, eventId, '2026-09-21T17:00:00Z', home, away, book, 'h2h', side, null, price);
  }
}

function espnSpread(away, home, homeSpread) {
  run(`INSERT INTO espn_line_moves
       (observed_at, season, week, event_id, home_team, away_team, commence_time,
        home_spread, total, first_sighting)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
  NOW, 2026, 3, `espn-${away}${home}`, home, away, '2026-09-21T17:00:00Z', homeSpread, 44.5, 1);
}

test('a game with a two-sided book moneyline is priced by Shin de-vig, not the spread curve', () => {
  // NYG at LAR. A heavy home favourite, which is exactly the shape where the
  // de-vig method matters and where the spread conversion is least trustworthy.
  kalshiQuote('NYG', 'LAR', 'LAR', 0.80);
  moneyline('NYG', 'LAR', 'pinnacle', +330, -420);
  espnSpread('NYG', 'LAR', -8.5);

  const out = pm.exchangeVsBook({ minGap: 0 });
  const lar = out.divergences.find(d => d.ticker.endsWith('-LAR'));

  assert.ok(lar, 'the LAR contract should be compared');
  assert.equal(lar.book_method, 'shin_devig_moneyline');
  assert.equal(lar.book_source, 'pinnacle');
  assert.equal(out.devigged_from_quoted_moneyline, 1);
  assert.equal(out.approximated_from_spread, 0);

  // The reported book probability is the real Shin number for LAR's side.
  const fair = shinDevig(+330, -420);
  assert.ok(Math.abs(lar.book_probability - fair.probB) < 1e-4,
    `expected the Shin fair price ${fair.probB}, got ${lar.book_probability}`);

  // And it is genuinely a different number from the old normal-CDF path, so the
  // swap changes the answer rather than dressing up the same one.
  const old = 0.5 * (1 + erf(8.5 / 14.16 / Math.SQRT2));
  assert.ok(Math.abs(lar.book_probability - old) > 0.01,
    'the de-vigged moneyline should differ materially from the spread approximation');
});

test('the two sides of one game de-vig to a pair that sums to one', () => {
  kalshiQuote('NYG', 'LAR', 'NYG', 0.20);
  const out = pm.exchangeVsBook({ minGap: 0 });
  const lar = out.divergences.find(d => d.ticker.endsWith('-LAR'));
  const nyg = out.divergences.find(d => d.ticker.endsWith('-NYG'));
  assert.ok(nyg && lar);
  assert.equal(nyg.book_method, 'shin_devig_moneyline');
  assert.ok(Math.abs(nyg.book_probability + lar.book_probability - 1) < 1e-9,
    'a de-vigged pair must sum to exactly one');
});

test('the tightest two-sided market wins when several books are stored', () => {
  kalshiQuote('DAL', 'PHI', 'PHI', 0.62);
  moneyline('DAL', 'PHI', 'betrivers', +190, -240);   // ~5.0% hold
  moneyline('DAL', 'PHI', 'pinnacle', +185, -205);    // ~2.0% hold
  espnSpread('DAL', 'PHI', -4.5);

  const out = pm.exchangeVsBook({ minGap: 0 });
  const phi = out.divergences.find(d => d.ticker.endsWith('-PHI'));
  assert.equal(phi.book_source, 'pinnacle', 'the lowest-overround pair should be chosen');
  assert.ok(phi.book_hold < 0.03);
  assert.ok(phi.shin_z >= 0 && phi.shin_z < 1, 'the fitted insider fraction should be reported');
});

test('a game with no two-sided moneyline falls back to the spread curve, and says so', () => {
  kalshiQuote('KC', 'BUF', 'BUF', 0.55);
  espnSpread('KC', 'BUF', -2.5);

  const out = pm.exchangeVsBook({ minGap: 0 });
  const buf = out.divergences.find(d => d.ticker.endsWith('-BUF'));
  assert.ok(buf);
  assert.equal(buf.book_method, 'spread_normal_approx');
  assert.equal(buf.book_source, 'espn_line_moves');
  assert.equal(buf.book_hold, null);
  assert.ok(out.approximated_from_spread >= 1);
});

test('a one-sided moneyline quote is not de-vigged from half a market', () => {
  kalshiQuote('MIA', 'NYJ', 'NYJ', 0.58);
  espnSpread('MIA', 'NYJ', -3.5);
  // Only the home side stored: a half-quote carries no margin information.
  run(`INSERT INTO nfl_line_snapshots
       (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
  NOW, 'nfl:2026-09-21:MIA@NYJ', '2026-09-21T17:00:00Z', 'NYJ', 'MIA',
  'pinnacle', 'h2h', 'NYJ', null, -175);

  const out = pm.exchangeVsBook({ minGap: 0 });
  const nyj = out.divergences.find(d => d.ticker.endsWith('-NYJ'));
  assert.equal(nyj.book_method, 'spread_normal_approx',
    'half a market must not be de-vigged as though it were a pair');
});

test('bookMoneylineNoVig is exported and keyed the way Kalshi tickers are', () => {
  const map = pm.bookMoneylineNoVig();
  assert.ok(map.has('NYG@LAR'));
  assert.ok(map.has('DAL@PHI'));
  const g = map.get('NYG@LAR');
  assert.ok(Math.abs([...g.probByTeam.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
    a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  return s * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}
