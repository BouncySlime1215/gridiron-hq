/**
 * FC-SNAP (RL-3-1 + RL-4-3): FantasyCalc's market price must refresh on a timer, keep a
 * day-by-day history, join on the ids FantasyCalc sends before any name, stop serving
 * rows FantasyCalc no longer returns, say how old it is, and credit FantasyCalc.com.
 *
 * On origin/main 89f69b3b:
 *   - `syncDynastyValues` (server/routes/aggregates.js:130) upserts `dynasty_values`
 *     (ON CONFLICT DO UPDATE, :149-155), so every sync destroys the previous price and
 *     C12's forward FantasyCalc test has nothing to grade.
 *   - No scheduled job calls it; the price is whatever the last button press fetched.
 *   - The join reads Sleeper id then name, never FantasyCalc's `espnId`; a name shared
 *     with a historical row (Marvin Harrison Jr. vs Marvin Harrison) is dropped from
 *     the lookup, so that player keeps a Week-0 price forever.
 *   - A player FantasyCalc stops returning keeps his last price forever.
 *   - The freshness registry never looks at `dynasty_values`, and the trade cache stamps
 *     it on `player_id`, which an in-place re-sync never changes.
 *   - The client names FantasyCalc and never links FantasyCalc.com, which its terms ask for.
 *
 * Every FantasyCalc call here is a mocked `fetch`: no network, nothing paid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-fc-snap-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
delete process.env.NFL_WEEK;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const requireFromTest = createRequire(import.meta.url);

const { db, run, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { syncDynastyValues } = await import('../server/routes/aggregates.js');
const scheduler = await import('../server/services/scheduler.js');
const registry = await import('../server/services/source-registry.js');
const freshness = await import('../server/services/data-freshness.js');
const te = await import('../server/services/trade-engine.js');
const { fingerprint } = await import('../server/services/compute-cache.js');
const { deriveFormat } = await import('../server/services/format.js');
const express = (await import('express')).default;

/** A module that does not exist yet is an assertion failure, not a crash of the whole file. */
async function optionalImport(specifier) {
  try { return await import(specifier); } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  }
}
const history = await optionalImport('../server/services/dynasty-value-history.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');

/* ---------------------------------------------------------------- fixture */
run(`INSERT INTO users (id, subject, display_name) VALUES (1, 'fc-snap', 'fc-snap')`);
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (91, 'espn', 'fc-91', 2026, 'Fixture', '1', 10, 1, ?, '2026-09-18 01:00:00')`,
JSON.stringify({ teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] }));
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (91, 1, 'commissioner')`);
const lg = () => row('SELECT * FROM leagues WHERE id = 91');
const FMT = deriveFormat(lg()).formatKey; // rd_sf1_t10_ppr1

const P = {
  MHJ: 9001, MARVIN_OLD: 9002, SLEEPER_KEYED: 9003, SLEEPER_OLD: 9004,
  DROPPED: 9005, STEADY: 9006, ID_MATCH: 9008, NAME_MATCH: 9009
};
const seedPlayer = (id, name, position, espn, sleeper) =>
  run('INSERT INTO players (id, name, position, espn_id, sleeper_id) VALUES (?,?,?,?,?)', id, name, position, espn, sleeper);
// Marvin Harrison Jr. has no sleeper_id locally and his name key collides with a
// retired Marvin Harrison, exactly the R4 case (espn 4432708).
seedPlayer(P.MHJ, 'Marvin Harrison Jr.', 'WR', '4432708', null);
seedPlayer(P.MARVIN_OLD, 'Marvin Harrison', 'WR', '939', null);
// The RL-4-3 RED 2 case: Sleeper id set, name collides with an unrelated historical row.
seedPlayer(P.SLEEPER_KEYED, 'Keyed Runner Jr.', 'RB', null, '5555');
seedPlayer(P.SLEEPER_OLD, 'Keyed Runner', 'RB', null, null);
seedPlayer(P.DROPPED, 'Dropped Tightend', 'TE', '777', null);
seedPlayer(P.STEADY, 'Steady Star', 'WR', '888', null);
// FantasyCalc's espnId points at ID_MATCH; its name spells NAME_MATCH's name.
seedPlayer(P.ID_MATCH, 'Idmatch Receiver', 'WR', '999', null);
seedPlayer(P.NAME_MATCH, 'Namematch Receiver', 'WR', '12345', null);

const entry = (name, position, value, { espnId = null, sleeperId = null, trend = 0 } = {}) => ({
  player: { id: value, name, position, espnId, sleeperId, maybeAge: 25 },
  value, redraftValue: value, trend30Day: trend, positionRank: 1
});
const PULL_1 = [
  entry('Marvin Harrison Jr', 'WR', 715, { espnId: '4432708', sleeperId: '11628' }),
  entry('Keyed Runner', 'RB', 1200, { sleeperId: '5555' }),
  entry('Dropped Tightend', 'TE', 300, { espnId: '777' }),
  entry('Steady Star', 'WR', 5000, { espnId: '888' }),
  entry('Namematch Receiver', 'WR', 2100, { espnId: '999' })
];
// A day later: prices moved and Dropped Tightend is gone from FantasyCalc's list.
const PULL_2 = [
  entry('Marvin Harrison Jr', 'WR', 690, { espnId: '4432708', sleeperId: '11628' }),
  entry('Keyed Runner', 'RB', 1250, { sleeperId: '5555' }),
  entry('Steady Star', 'WR', 5100, { espnId: '888' }),
  entry('Namematch Receiver', 'WR', 2000, { espnId: '999' })
];

/* ------------------------------------------------------------ fetch mock */
const realFetch = globalThis.fetch;
const external = [];
let payload = PULL_1;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  external.push(u);
  return { ok: true, status: 200, json: async () => structuredClone(payload) };
};

/* ------------------------------------------------------------ HTTP (reader) */
const app = express();
app.use((req, _res, next) => { req.auth = { userId: 1 }; next(); });
app.use('/api/trades', tradesRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/trades`;

test.after(() => {
  globalThis.fetch = realFetch;
  server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

const T0 = new Date('2026-09-20T12:00:00Z');
const T1 = new Date('2026-09-21T12:00:00Z'); // 24 h later
const stamp = d => d.toISOString().replace('T', ' ').slice(0, 19);
const current = id => row('SELECT * FROM dynasty_values WHERE format_key = ? AND player_id = ?', FMT, id);
const historyRows = id => {
  const t = row(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='dynasty_value_history'`);
  assert.ok(t, 'no dynasty_value_history table: every sync still destroys the previous price');
  return rows('SELECT * FROM dynasty_value_history WHERE format_key = ? AND player_id = ? ORDER BY captured_on', FMT, id);
};

/* ======================================================= 1. history */
test('two syncs 24h apart leave 2 history rows and 1 current row; a same-day re-sync adds none', async () => {
  payload = PULL_1;
  await syncDynastyValues({ now: T0 });
  payload = PULL_2;
  await syncDynastyValues({ now: T1 });

  const cur = rows('SELECT * FROM dynasty_values WHERE format_key = ? AND player_id = ?', FMT, P.STEADY);
  assert.equal(cur.length, 1, 'the current store must stay one row per player per format');
  assert.equal(cur[0].value, 5100, 'the current row carries the latest pull');
  assert.equal(cur[0].fetched_at, stamp(T1));

  const h = historyRows(P.STEADY);
  assert.equal(h.length, 2, 'one history row per day the price was fetched');
  assert.deepEqual(h.map(r => [r.captured_on, r.value]), [['2026-09-20', 5000], ['2026-09-21', 5100]],
    'the first day keeps its own price: history is append-only');

  payload = PULL_2.map(e => ({ ...e, value: e.value + 1 }));
  await syncDynastyValues({ now: new Date('2026-09-21T13:00:00Z') });
  const again = historyRows(P.STEADY);
  assert.equal(again.length, 2, 'a second pull on the same day is not a new observation');
  assert.equal(again[1].value, 5100, 'the day\'s first capture is never overwritten');
  payload = PULL_2;
  await syncDynastyValues({ now: T1 });
});

/* ======================================================= 2. join */
test('the join resolves by FantasyCalc\'s ESPN id before any name (Marvin Harrison Jr.)', () => {
  assert.equal(current(P.MHJ)?.value, 690, 'Marvin Harrison Jr. has no price: the name collision dropped him');
  assert.equal(current(P.MARVIN_OLD), undefined, 'the historical namesake must not receive his price');
});

test('the join resolves by Sleeper id before the name fallback (RL-4-3 RED 2)', () => {
  assert.equal(current(P.SLEEPER_KEYED)?.value, 1250);
  assert.equal(current(P.SLEEPER_OLD), undefined);
});

test('an ESPN id beats a name that spells a different player', () => {
  assert.equal(current(P.ID_MATCH)?.value, 2000, 'the price follows the id FantasyCalc sent');
  assert.equal(current(P.NAME_MATCH), undefined, 'the name fallback must not win over an id match');
});

/* ======================================================= 3. retirement */
test('a player FantasyCalc stops returning is retired, keeps his last price on file, and is not served', () => {
  const r = current(P.DROPPED);
  assert.ok(r, 'the row is kept, not deleted');
  assert.equal(r.value, 300, 'the last price stays on file for audit');
  assert.equal(r.retired_at, stamp(T1), 'retired by the pull that no longer returned him');
  assert.equal(current(P.STEADY).retired_at, null);
  assert.ok(history, 'server/services/dynasty-value-history.js does not exist');
  const served = history.currentMarket(FMT);
  assert.ok(served instanceof Map);
  assert.equal(served.has(P.DROPPED), false, 'a retired price must not reach a trade card');
  assert.equal(served.get(P.STEADY)?.value, 5100);
});

test('both trade readers take the market from currentMarket, the one reader that skips retired rows', () => {
  for (const f of ['server/routes/tradelab.js', 'server/services/trade-engine.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /FROM dynasty_values WHERE format_key = \?/,
      `${f} still reads dynasty_values directly, so it serves retired prices`);
    assert.match(src, /currentMarket\(formatKey\)/, `${f} does not read currentMarket(formatKey)`);
  }
});

test('a player who comes back is un-retired; an empty pull retires nobody', async () => {
  payload = PULL_1;
  await syncDynastyValues({ now: new Date('2026-09-22T12:00:00Z') });
  assert.equal(current(P.DROPPED).retired_at, null, 'back in the pull, back in service');
  assert.equal(current(P.DROPPED).value, 300);

  payload = [];
  const res = await syncDynastyValues({ now: new Date('2026-09-23T12:00:00Z') });
  assert.equal(row('SELECT COUNT(*) AS n FROM dynasty_values WHERE format_key = ? AND retired_at IS NOT NULL', FMT).n, 0,
    'a pull that matched nobody is a broken pull, not a list of retirements');
  assert.ok(res.formats.find(f => f.formatKey === FMT)?.error, 'the empty pull is reported as an error for that format');
});

test('only the documented /values/current endpoint is ever called', () => {
  assert.ok(external.length > 0, 'control: the mock saw the syncs');
  const off = external.filter(u => !u.startsWith('https://api.fantasycalc.com/values/current?'));
  assert.deepEqual(off, [], 'FantasyCalc forbids calling any undocumented endpoint');
});

/* ======================================================= 4. timer */
test('fantasycalc_dynasty is a daily scheduled job, not a manual source', () => {
  const job = scheduler.JOBS.fantasycalc_dynasty;
  assert.ok(job, 'no scheduled job refreshes FantasyCalc: the price is whatever the last button press fetched');
  assert.equal(job.maxAgeMinutes, 24 * 60, 'FantasyCalc asks for at most one pull a day');
  assert.notEqual(job.tier, 'heavy', 'the heavy tier only runs behind an opt-in flag');
  const listed = registry.allSources().filter(s => s.source === 'fantasycalc_dynasty');
  assert.equal(listed.length, 1, 'listed once (allSources() does not dedupe MANUAL_SOURCES and JOBS)');
  assert.equal(listed[0].scheduled, true);
});

test('the scheduled run refreshes a price older than 24 hours (RL-4-3 RED 1)', async () => {
  payload = PULL_2;
  run(`UPDATE dynasty_values SET fetched_at = '2026-09-01 00:00:00' WHERE format_key = ?`, FMT);
  run(`DELETE FROM sync_log WHERE job = 'fantasycalc_dynasty'`);
  const res = await scheduler.runIfStale('fantasycalc_dynasty', { offThread: false });
  assert.equal(res.error, undefined, `the job failed: ${res.error}`);
  assert.notEqual(res.skipped, true, 'a never-run job must be due');
  assert.equal(scheduler.lastRun('fantasycalc_dynasty')?.last_status, 'ok', 'the run is logged as ok');
  const ageMin = row(`SELECT (julianday('now') - julianday(fetched_at)) * 1440 AS m FROM dynasty_values
                      WHERE format_key = ? AND player_id = ?`, FMT, P.STEADY).m;
  assert.ok(ageMin < 5, `fetched_at was not refreshed (age ${ageMin} min)`);
});

/* ======================================================= 5. freshness + cache */
test('dynasty_values is in the freshness registry and reads stale after 24 hours', () => {
  const entryFor = freshness.servedTablesRegistry().find(e => e.table === 'dynasty_values');
  assert.ok(entryFor, 'the freshness registry never looks at dynasty_values');
  assert.equal(freshness.servedTablesRegistry()[0].table, 'player_week_usage', 'the acceptance entry stays first');
  const ctx = { currentSeason: 2026, currentWeek: 3, database: db };
  assert.equal(freshness.tableFreshness(entryFor, ctx).status, 'fresh', 'just synced');
  run(`UPDATE dynasty_values SET fetched_at = '2026-09-01 00:00:00'`);
  assert.equal(freshness.tableFreshness(entryFor, ctx).status, 'stale', 'three weeks old must read stale');
});

test('the trade cache sees an in-place re-sync (stamp is fetched_at, not player_id)', async () => {
  const dv = te.ASSET_INPUT_TABLES.find(t => typeof t === 'object' && t.table === 'dynasty_values');
  assert.equal(dv?.stamp, 'fetched_at');
  const before = fingerprint(te.ASSET_INPUT_TABLES);
  payload = PULL_2;
  await syncDynastyValues({ now: new Date() });
  assert.notEqual(fingerprint(te.ASSET_INPUT_TABLES), before, 'a re-sync left the cache fingerprint unchanged');
});

/* ======================================================= 6. reader route */
test('GET /api/trades/:leagueId/market-history/:playerId serves the history and the market age', async () => {
  const res = await fetch(`${base}/91/market-history/${P.STEADY}`);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.format_key, FMT);
  assert.equal(body.player_id, P.STEADY);
  assert.ok(body.history.length >= 2, 'the route returns every stored day');
  assert.deepEqual(body.history.slice(0, 2).map(h => [h.captured_on, h.value]),
    [['2026-09-20', 5000], ['2026-09-21', 5100]]);
  assert.equal(body.market_as_of?.source_url, 'https://fantasycalc.com');
  assert.ok(body.market_as_of?.fetched_at, 'the route says when the market was fetched');
});

test('GET /api/trades/:leagueId/rosters carries market_as_of for the Trade Lab line', async () => {
  const res = await fetch(`${base}/91/rosters`);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.market_as_of?.format_key, FMT);
  assert.ok(['fresh', 'stale'].includes(body.market_as_of?.state));
  assert.equal(typeof body.market_as_of?.age_hours, 'number');
});

test('marketAsOf says which absence it is when a format was never fetched', () => {
  assert.ok(history, 'server/services/dynasty-value-history.js does not exist');
  const none = history.marketAsOf('dyn_sf2_t16_ppr0');
  assert.equal(none.state, 'empty');
  assert.equal(none.fetched_at, null);
  assert.equal(none.age_hours, null);
});

/* ======================================================= 7. attribution */
async function loadTsx(file, stubs = {}) {
  const { outputText } = ts.transpileModule(read(file), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  });
  const specifiers = {
    react: pathToFileURL(requireFromTest.resolve('react')).href,
    'react/jsx-runtime': pathToFileURL(requireFromTest.resolve('react/jsx-runtime')).href,
    ...stubs
  };
  const code = outputText.replace(/from (['"])([^'"]+)\1/g, (whole, _q, spec) =>
    spec in specifiers ? `from '${specifiers[spec]}'` : whole);
  const out = path.join(temp, `${path.basename(file, '.tsx')}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

test('the data credit line under every page links FantasyCalc.com', async () => {
  const stub = path.join(temp, 'api-stub.mjs');
  fs.writeFileSync(stub, 'export function useApi() { return { data: null, error: null, loading: false }; }\n');
  const banner = await loadTsx('client/src/components/DataFreshnessBanner.tsx', { '../api': pathToFileURL(stub).href });
  const html = renderToStaticMarkup(React.createElement(banner.DataCredit));
  assert.match(html, /<a [^>]*href="https:\/\/fantasycalc\.com"[^>]*>FantasyCalc\.com<\/a>/,
    'FantasyCalc\'s terms ask for a visible link to FantasyCalc.com; the credit line has none');
});

test('the Trade Lab market line says how old the price is and links FantasyCalc.com', async () => {
  const exists = fs.existsSync(path.join(root, 'client/src/components/MarketAsOf.tsx'));
  assert.ok(exists, 'client/src/components/MarketAsOf.tsx does not exist');
  const { default: MarketAsOf } = await loadTsx('client/src/components/MarketAsOf.tsx');
  const fresh = renderToStaticMarkup(React.createElement(MarketAsOf, {
    asOf: { format_key: FMT, fetched_at: '2026-09-21 12:00:00', age_hours: 3, state: 'fresh',
      source_url: 'https://fantasycalc.com', stale_after_hours: 24 }
  }));
  assert.match(fresh, /[Mm]arket as of/);
  assert.match(fresh, /Sep 21/);
  assert.match(fresh, /href="https:\/\/fantasycalc\.com"/);
  const stale = renderToStaticMarkup(React.createElement(MarketAsOf, {
    asOf: { format_key: FMT, fetched_at: '2026-09-17 12:00:00', age_hours: 99, state: 'stale',
      source_url: 'https://fantasycalc.com', stale_after_hours: 24 }
  }));
  assert.match(stale, /4 days old/, 'a stale price says how stale');
  const empty = renderToStaticMarkup(React.createElement(MarketAsOf, {
    asOf: { format_key: FMT, fetched_at: null, age_hours: null, state: 'empty', source_url: 'https://fantasycalc.com' }
  }));
  assert.match(empty, /not been fetched/, 'no price on file says so rather than showing a date');
  // Wired on the page, not just existing.
  assert.match(read('client/src/pages/TradeLab.tsx'), /<MarketAsOf asOf=\{rosters\?\.market_as_of\}/);
});
