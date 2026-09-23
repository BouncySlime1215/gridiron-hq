/**
 * TM-09: the market-price table from real trades, its reader, and the route
 * that serves it (GET /api/trades/:leagueId/market/:playerId).
 *
 * The reader is tested on small fixture tables built here, so each rule
 * (cell lookup, fallback, bins, the pre-registered ship gate, the history
 * absences) is pinned by a case that fails if the rule goes. The committed
 * table itself is checked for the privacy and holdout rules it must keep:
 * aggregates only (n >= 3 per player-week, no league/roster/user keys) and no
 * 2025 season. The route is exercised as server/index.js mounts it.
 *
 * Every league, user and player name below is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-market-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const market = await import('../server/services/trade-market.js');

// All setup runs before the first test is declared: a hook or server created after
// the runner has started would close before the route cases reach it.
const table = market.loadMarketTable();

// ------------------------------------------------------------------ the route (setup)
const { default: tradesRouter } = await import('../server/routes/trades.js');
run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (8811, 'market-route-user', 'Reader')`);
run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at)
     VALUES (8811, ?, datetime('now','+1 day'))`, hashSessionToken('market-token'));
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, current_week)
     VALUES (61, 'espn', 'espn-market-61', 2026, 'L61', ?, 12, '1', 6)`, JSON.stringify({ teams: [], members: [] }));
run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (61, 8811, 'member')`);
// Guarded so the route cases still register (and fail on their own) when the reader returns nothing.
const known = table?.player_weeks?.[0] ?? { sleeper_id: 'none', pos: 'RB' };
const knownRows = (table?.player_weeks ?? []).filter(r => r.sleeper_id === known.sleeper_id).length;
run(`INSERT INTO players(id, name, position, sleeper_id) VALUES (70001, 'Known Player', ?, ?)`, known.pos, known.sleeper_id);
run(`INSERT INTO players(id, name, position, sleeper_id) VALUES (70002, 'No Sleeper Id', 'WR', NULL)`);

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const get = async url => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { authorization: 'Bearer market-token' } });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, body: isJson ? JSON.parse(text) : null, text };
};

const fixture = (over = {}) => ({
  meta: { unit: 'TM-09', forward_status: 'unconfirmed forward', holdout_season_read: false,
    units: 'points above replacement per game, league scoring', sign: 'hype = price - value' },
  results: { h1: { passed: true, mae_gain: 0.08 }, h2: { next4: { c: 0.26, c_ci: { lo: 0.22, hi: 0.30 },
    prereg_rule_c_below_1: true, placebo: { c_mean: 0.15, lo: 0.14, hi: 0.17, n_perm: 200 }, c_minus_placebo: 0.11,
    price_coef_given_value: { coef: 0.14, lo: 0.10, hi: 0.18 }, market_informative_beyond_value: true } } },
  position_price_to_value: { RB: 0.9, WR: 0.88 },
  cells: [
    { pos: 'RB', week_bin: '5-8', size_bin: '12', n: 100, price_to_value: 0.92, median_hype: -0.1 },
    { pos: 'RB', week_bin: '5-8', size_bin: 'le10', n: 60, price_to_value: 0.80, median_hype: -0.3 },
    { pos: 'WR', week_bin: '5-8', size_bin: '12', n: 12, price_to_value: null, median_hype: -0.2 },
  ],
  player_weeks: [
    { season: 2023, week: 7, sleeper_id: '9001', pos: 'RB', n: 4, price: 2.1, value: 2.5, hype: -0.4 },
    { season: 2022, week: 3, sleeper_id: '9001', pos: 'RB', n: 3, price: 3.0, value: 2.0, hype: 1.0 },
    { season: 2023, week: 2, sleeper_id: '9002', pos: 'WR', n: 5, price: 1.0, value: 1.0, hype: 0 },
  ],
  ...over,
});

// ------------------------------------------------------------------ bins
test('week and league-size bins match the pre-registered edges', () => {
  assert.equal(market.weekBin(4), '1-4');
  assert.equal(market.weekBin(5), '5-8');
  assert.equal(market.weekBin(12), '9-12');
  assert.equal(market.weekBin(13), '13+');
  assert.equal(market.sizeBin(10), 'le10');
  assert.equal(market.sizeBin(12), '12');
  assert.equal(market.sizeBin(13), '12');
  assert.equal(market.sizeBin(14), 'ge14');
});

// ------------------------------------------------------------------ premium
test('premium reads the position x week x size cell', () => {
  const p = market.marketPremium(fixture(), { pos: 'RB', week: 6, teams: 12 });
  assert.equal(p.available, true);
  assert.equal(p.price_to_value, 0.92);
  assert.equal(p.source, 'cell');
  assert.equal(p.n, 100);
});

test('premium keys on league size: a 12-team query skips the same position-week cell of another size', () => {
  assert.equal(market.marketPremium(fixture(), { pos: 'RB', week: 6, teams: 12 }).price_to_value, 0.92);
  const small = market.marketPremium(fixture(), { pos: 'RB', week: 6, teams: 10 });
  assert.equal(small.price_to_value, 0.80);
  assert.equal(small.size_bin, 'le10');
  assert.equal(small.source, 'cell');
});

test('a thin cell (price_to_value null) falls back to the position ratio and says so', () => {
  const p = market.marketPremium(fixture(), { pos: 'WR', week: 6, teams: 12 });
  assert.equal(p.available, true);
  assert.equal(p.price_to_value, 0.88);
  assert.equal(p.source, 'position');
});

test('a position with no ratio at all is unavailable, not 1.0', () => {
  const p = market.marketPremium(fixture(), { pos: 'K', week: 6, teams: 12 });
  assert.equal(p.available, false);
  assert.equal(p.price_to_value, null);
  assert.equal(p.reason, 'no_cell_or_position_ratio');
});

test('if H1 failed its pre-registered rule the premium is withheld with the reason', () => {
  const t = fixture({ results: { h1: { passed: false }, h2: {} } });
  const p = market.marketPremium(t, { pos: 'RB', week: 6, teams: 12 });
  assert.equal(p.available, false);
  assert.equal(p.price_to_value, null);
  assert.match(p.reason, /pre-registered/);
});

// ------------------------------------------------------------------ history
test('history returns that player-week rows, oldest first', () => {
  const h = market.playerMarketHistory(fixture(), '9001');
  assert.equal(h.available, true);
  assert.deepEqual(h.rows.map(r => [r.season, r.week]), [[2022, 3], [2023, 7]]);
});

test('history names which absence it found', () => {
  assert.equal(market.playerMarketHistory(fixture(), null).reason, 'no_sleeper_id');
  const none = market.playerMarketHistory(fixture(), '1');
  assert.equal(none.available, false);
  assert.equal(none.reason, 'no_player_week_with_n_ge_3');
  assert.deepEqual(none.rows, []);
});

// ------------------------------------------------------------------ the committed table
test('the committed table is aggregates only and never reads 2025', () => {
  assert.ok(table && Array.isArray(table.player_weeks) && table.player_weeks.length > 0, 'table has player-week rows');
  assert.equal(table.meta.holdout_season_read, false);
  const forbidden = ['lg', 'league_id', 'roster_id', 'ts_id', 'trade_id', 'username', 'owner', 'league_name', 'chain'];
  for (const r of table.player_weeks) {
    assert.ok(r.n >= 3, `player-week row with n=${r.n}`);
    assert.ok(r.season <= 2024, `season ${r.season} in the table`);
    for (const k of forbidden) assert.equal(k in r, false, `key ${k} in a player-week row`);
  }
  for (const c of table.cells) for (const k of forbidden) assert.equal(k in c, false, `key ${k} in a cell`);
});

test('every committed player-week row keeps the stated identity hype = price - value', () => {
  assert.match(table.meta.sign, /hype = price - value/);
  let bad = 0;
  for (const r of table.player_weeks) if (Math.abs(r.hype - (r.price - r.value)) > 0.0006) bad += 1;
  assert.equal(bad, 0, `${bad} of ${table.player_weeks.length} rows break hype = price - value`);
});

test('the committed table says its value curves were fit without 2025', () => {
  const fit = table.meta.value_curves_fit_seasons;
  assert.ok(Array.isArray(fit) && fit.length > 0, 'meta.value_curves_fit_seasons present');
  for (const s of fit) assert.ok(s <= 2024, `value curve fit season ${s}`);
});

test('the committed H2 result carries the shuffled-price placebo and the price coefficient given value', () => {
  const h = table.results.h2.next4;
  assert.equal('decay_confirmed' in h, false, 'decay_confirmed is not diagnostic and is not published');
  assert.ok(h.placebo && Number.isFinite(h.placebo.c_mean) && h.placebo.n_perm >= 200, 'placebo present');
  assert.ok(Math.abs(h.c_minus_placebo - (h.c - h.placebo.c_mean)) < 1e-6, 'c_minus_placebo = c - placebo mean');
  const b = h.price_coef_given_value;
  assert.ok(b && Number.isFinite(b.coef) && b.lo <= b.coef && b.coef <= b.hi, 'price coefficient with CI');
});

test('marketForPlayer labels the output unconfirmed forward and default-off', () => {
  const out = market.marketForPlayer({ player: { id: 1, name: 'Test Back', position: 'RB', sleeper_id: '9001' },
    week: 6, teams: 12 }, fixture());
  assert.equal(out.status, 'unconfirmed forward');
  assert.equal(out.default_off, true);
  assert.equal(out.premium.price_to_value, 0.92);
  assert.equal(out.history.rows.length, 2);
  assert.equal(out.hype_decay.c, 0.26);
  assert.equal(out.hype_decay.c_placebo, 0.15);
  assert.equal(out.hype_decay.price_coef_given_value.coef, 0.14);
  assert.equal('decay_confirmed' in out.hype_decay, false);
  assert.doesNotMatch(out.hype_decay.reading, /shows up in the next 4/);
});

test('marketForPlayer names every hype producer so the numbers are not mixed up', () => {
  const out = market.marketForPlayer({ player: { id: 1, name: 'Test Back', position: 'RB', sleeper_id: '9001' },
    week: 6, teams: 12 }, fixture());
  const where = out.other_hype_producers.map(p => p.where).join(' ');
  assert.match(where, /players\.js/);
  assert.match(where, /waiver-brain\.js/);
});

// ------------------------------------------------------------------ the route
test('GET /:leagueId/market/:playerId serves the committed table for a known player', async () => {
  const { status, body } = await get('/api/trades/61/market/70001');
  assert.equal(status, 200);
  assert.equal(body.player.sleeper_id, known.sleeper_id);
  assert.equal(body.week, 6);
  assert.equal(body.league_size, 12);
  assert.equal(body.status, 'unconfirmed forward');
  assert.equal(body.history.available, true);
  assert.equal(body.history.rows.length, knownRows);
  assert.equal(body.premium.week_bin, '5-8');
  assert.equal(body.premium.size_bin, '12');
  assert.equal(body.premium.pos, known.pos);
  assert.equal(body.premium.available, true);
  const cell = table.cells.find(c => c.pos === known.pos && c.week_bin === '5-8' && c.size_bin === '12');
  const want = cell?.price_to_value ?? table.position_price_to_value[known.pos];
  assert.ok(Number.isFinite(want), 'committed table has a ratio for the known position');
  assert.equal(body.premium.price_to_value, want);
});

test('the route says no_sleeper_id rather than an empty history', async () => {
  const { status, body } = await get('/api/trades/61/market/70002');
  assert.equal(status, 200);
  assert.equal(body.history.available, false);
  assert.equal(body.history.reason, 'no_sleeper_id');
});

test('an unknown player is a 404', async () => {
  const { status } = await get('/api/trades/61/market/79999');
  assert.equal(status, 404);
});
