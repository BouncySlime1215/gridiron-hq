/**
 * STARTUP HEALTH (plan item 56): trade cards are refused (503 + plain banner) while the rules module,
 * the FantasyCalc value reader or the season trade ledger fails to load. Made-up ids and values only.
 *
 * Pre-registered bar (PR body): B1 flag off = pass-through, nothing probed; B2 every fault in each of the
 * three checks fails closed on every card route; B3 healthy = pass-through; B4 non-card routes never
 * blocked; B5 banner carries no dev text; B6 probe < 200 ms on the fixture; B7 a fixed input serves
 * again after RETRY_MS without a restart; B8 every card mount in server/index.js carries the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-startup-health-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_WARROOM_PLANS = path.join(temp, 'plans.json');
delete process.env.GRIDIRON_WARROOM_OBJECTIVES;

const dbMod = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { db, run, row, rows } = dbMod;
const SH = await import('../server/services/startup-health.js');
const NG = await import('../server/services/campaign/never-give.js');
const FC = await import('../server/services/fc-value.js');
const TM = await import('../server/services/campaign/trade-memory.js');

const DB = { row, rows };
const L = 4, ME = '5';

/* ------------------------------------------------------------ fixture */
for (const [id, name] of [[101, 'Alpha Test'], [102, 'Bravo Test'], [103, 'Charlie Test']]) {
  run('INSERT INTO players (id, name, position, espn_id) VALUES (?, ?, ?, ?)', id, name, 'WR', 7000 + id);
}
const seedFc = () => {
  run(`DELETE FROM player_metrics WHERE source = 'fc_value'`);
  for (const [id, v] of [[101, 4000], [102, 3500], [103, 3000]]) run(`INSERT INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, id, v);
};
seedFc();
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count, my_team_id, espn_s2, swid, connection_status)
     VALUES (?, 'espn', 'sh-4', 2026, 'Test League', '{"teams":[]}', 10, ?, 'x', 'y', 'connected')`, L, ME);
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`;
const seedLedger = (items = [{ playerId: 7101, fromTeamId: 5, toTeamId: 2 }, { playerId: 7102, fromTeamId: 2, toTeamId: 5 }]) => {
  db.exec('DROP TABLE IF EXISTS league_transactions_raw');
  db.exec(LEDGER_DDL);
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, 2026, 'tx1', 'TRADE_ACCEPT', 'EXECUTED', 'PROCESS', '2026-09-10T12:00:00Z', ?, 'now', 'now')`, L, JSON.stringify(items));
};
seedLedger();

const realLoaders = () => ({ rules: async () => NG, fc_value: async () => FC, trade_ledger: async () => TM });
const throwing = msg => async () => { throw new Error(msg); };
const byName = r => Object.fromEntries(r.checks.map(c => [c.name, c]));

/* ------------------------------------------------------------ the rules self-test */

test('rules self-test passes on the real rules module', () => {
  assert.equal(SH.rulesSelfTest(NG), null);
});

test('rules self-test catches a module that lost a pin or a rule', () => {
  const pinless = { ...NG, PINNED_NEVER_GIVE: Object.freeze(['160', '277']) };
  assert.match(SH.rulesSelfTest(pinless), /pin 80/);
  const noGet = { ...NG, PINNED_NEVER_GET: Object.freeze([]) };
  assert.match(SH.rulesSelfTest(noGet), /290/);
  const lets = { ...NG, ruleVerdict: () => ({ ok: true, reasons: [] }) };
  assert.match(SH.rulesSelfTest(lets), /gives 160/);
  // A verdict that forgot the overpay cap only.
  const noCap = { ...NG, ruleVerdict: (r, t) => { const v = NG.ruleVerdict(r, t); const reasons = v.reasons.filter(x => x !== 'overpay'); return { ...v, reasons, ok: reasons.length === 0 }; } };
  assert.match(SH.rulesSelfTest(noCap), /overpays/);
  const refusesAll = { ...NG, ruleVerdict: () => ({ ok: false, reasons: ['never_give', 'never_get', 'sold_this_season', 'below_blue_chip', 'unscored', 'no_fc_value', 'overpay'] }) };
  assert.match(SH.rulesSelfTest(refusesAll), /clean even swap/);
  assert.match(SH.rulesSelfTest({ ...NG, soldThisSeason: undefined }), /soldThisSeason/);
});

/* ------------------------------------------------------------ the probe */

test('B3/B6: healthy fixture probes ok, fast, with no banner', async () => {
  const t0 = performance.now();
  const r = await SH.probeTradeSafety({ db: DB, loaders: realLoaders() });
  const ms = performance.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(r.checks.map(c => c.name), [...SH.CHECKS]);
  assert.equal(r.banner, null);
  assert.ok(ms < 200, `probe took ${ms.toFixed(1)} ms`);
});

test('B3: the default loaders (the real module files) probe ok', async () => {
  const r = await SH.probeTradeSafety({ db: DB });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
});

const FAULTS = [
  ['rules module fails to import', 'rules', { rules: throwing('SyntaxError: boom') }, null],
  ['rules module lost the 160 pin', 'rules', { rules: async () => ({ ...NG, PINNED_NEVER_GIVE: ['80', '277'] }) }, null],
  ['fc-value reader fails to import', 'fc_value', { fc_value: throwing('Cannot find module') }, null],
  ['fc-value reader missing its export', 'fc_value', { fc_value: async () => ({}) }, null],
  ['fc_value rows empty', 'fc_value', {}, () => run(`DELETE FROM player_metrics WHERE source = 'fc_value'`)],
  ['fc read throws', 'fc_value', { fc_value: async () => ({ fcValues: () => { throw new Error('disk I/O error'); } }) }, null],
  ['trade ledger module fails to import', 'trade_ledger', { trade_ledger: throwing('Cannot find module') }, null],
  ['trade ledger table absent', 'trade_ledger', {}, () => db.exec('DROP TABLE IF EXISTS league_transactions_raw')],
  ['executed trades none of which read', 'trade_ledger', {}, () => seedLedger([{ playerId: 99999, fromTeamId: 5, toTeamId: 2 }])],
];

for (const [why, check, over, mutate] of FAULTS) {
  test(`B2: ${why} -> ${check} fails, banner says so`, async () => {
    mutate?.();
    try {
      const r = await SH.probeTradeSafety({ db: DB, loaders: { ...realLoaders(), ...over } });
      assert.equal(r.ok, false);
      assert.equal(byName(r)[check].ok, false);
      assert.ok(byName(r)[check].reason, 'a reason is kept for the log');
      assert.ok(r.banner.includes(SH.BANNER_LINES[check]), r.banner);
      assert.ok(r.banner.includes(SH.BANNER_TAIL));
    } finally { seedFc(); seedLedger(); }
  });
}

test('B2: a rules module that fails to import also fails the ledger check (its reader lives there)', async () => {
  const r = await SH.probeTradeSafety({ db: DB, loaders: { ...realLoaders(), rules: throwing('boom') } });
  assert.equal(byName(r).trade_ledger.ok, false);
});

test('B5: the banner never carries dev text or a raw reason', async () => {
  run(`DELETE FROM player_metrics WHERE source = 'fc_value'`);
  db.exec('DROP TABLE IF EXISTS league_transactions_raw');
  try {
    const r = await SH.probeTradeSafety({ db: DB, loaders: { ...realLoaders(), rules: throwing('SyntaxError at /srv/app/server/services/campaign/never-give.js:12') } });
    const view = SH.publicView(r);
    const text = JSON.stringify(view);
    for (const bad of [/\.m?js/, /\/srv|\/home|\/Users/, /player_metrics|league_transactions|sqlite/, /SyntaxError|Error:/, /never-give|fc-value|trade-memory/, /GRIDIRON_/]) {
      assert.doesNotMatch(text, bad);
    }
    assert.equal(view.status, 'fail_closed');
    assert.deepEqual(view.checks.map(c => c.ok), [false, false, false]);
    for (const c of view.checks) assert.deepEqual(Object.keys(c).sort(), ['name', 'ok']);
  } finally { seedFc(); seedLedger(); }
});

test('ledger: no league marked as Nick\'s -> nothing to check, the ledger check passes', async () => {
  const noMarked = { row: dbMod.row, rows: (sql, ...p) => (/FROM leagues/.test(sql) ? [] : dbMod.rows(sql, ...p)) };
  const r = await SH.probeTradeSafety({ db: noMarked, loaders: realLoaders() });
  assert.equal(byName(r).trade_ledger.ok, true);
});

/* ------------------------------------------------------------ the gate */

const CARD = ['/api/trades/4/war-room', '/api/trades/4/find', '/api/trades/4/find/sequences', '/api/trades/4/proposals',
  '/api/trades/4/offer?give=1', '/api/trades/4/offer-many', '/api/trades/4/post-draft-plan', '/api/trades/4/brain/plan',
  '/api/trades/4/brain/sell-high', '/api/trades/4/title-trades', '/api/trades/4/news-edge', '/api/tradelab/4/analysis',
  '/api/tradelab/4/partners', '/api/tradelab/4/pitch', '/api/edge/trade', '/api/execution-slate/recommend',
  '/api/execution-slate/opportunities', '/api/warroom/4/negotiations', '/api/warroom/4/negotiations/7/reply', '/api/warroom/4/aj'];
const NOT_CARD = ['/api/trades/4/lineup', '/api/trades/4/waivers', '/api/trades/4/player/101', '/api/trades/4/rosters',
  '/api/trades/4/served-numbers', '/api/warroom/layout', '/api/warroom/4/action-log', '/api/warroom/4/requests',
  '/api/edge/vor', '/api/tradelab/trending', '/api/health', '/api/trades/4/find-anything'];

test('isCardRoute: every card route matches, no other route does', () => {
  for (const p of CARD) assert.equal(SH.isCardRoute(p), true, p);
  for (const p of NOT_CARD) assert.equal(SH.isCardRoute(p), false, p);
});

/** Drive the gate as express would: -> 'next' or { status, body }. */
async function drive(gate, url) {
  let out = null;
  const res = { status(s) { this._s = s; return this; }, json(b) { out = { status: this._s ?? 200, body: b }; } };
  let nexted = false;
  await gate({ originalUrl: url, url }, res, () => { nexted = true; });
  return nexted ? 'next' : out;
}

const counting = loaders => {
  const calls = { n: 0 };
  const wrapped = Object.fromEntries(Object.entries(loaders).map(([k, f]) => [k, async () => { calls.n++; return f(); }]));
  return { calls, wrapped };
};

test('B1: flag off -> every route passes through and nothing is probed, even when broken', async () => {
  const { calls, wrapped } = counting({ ...realLoaders(), rules: throwing('boom') });
  const ts = SH.createTradeSafety({ db: DB, loaders: wrapped, env: {}, log: {} });
  for (const p of [...CARD, ...NOT_CARD]) assert.equal(await drive(ts.gate, p), 'next', p);
  assert.equal(calls.n, 0);
  assert.deepEqual(await ts.status(), { enabled: false });
});

test('B2/B4: flag on and broken -> every card route 503 fail_closed, other routes pass', async () => {
  const ts = SH.createTradeSafety({ db: DB, loaders: { ...realLoaders(), fc_value: throwing('boom') }, env: { GRIDIRON_STARTUP_HEALTH: '1' }, log: {} });
  for (const p of CARD) {
    const r = await drive(ts.gate, p);
    assert.equal(r.status, 503, p);
    assert.equal(r.body.status, 'fail_closed');
    assert.ok(r.body.banner.includes(SH.BANNER_LINES.fc_value));
  }
  for (const p of NOT_CARD) assert.equal(await drive(ts.gate, p), 'next', p);
  const s = await ts.status();
  assert.equal(s.status, 'fail_closed');
});

test('B3: flag on and healthy -> card routes pass through; probe runs once', async () => {
  const { calls, wrapped } = counting(realLoaders());
  const ts = SH.createTradeSafety({ db: DB, loaders: wrapped, env: { GRIDIRON_STARTUP_HEALTH: '1' }, log: {} });
  await ts.probe();
  for (const p of CARD) assert.equal(await drive(ts.gate, p), 'next', p);
  assert.equal(calls.n, 3);
  assert.equal((await ts.status()).status, 'ok');
});

test('B7: fixed input serves again after RETRY_MS, not before', async () => {
  let now = 1_000_000;
  let broken = true;
  const loaders = { ...realLoaders(), trade_ledger: async () => { if (broken) throw new Error('boom'); return TM; } };
  const ts = SH.createTradeSafety({ db: DB, loaders, env: { GRIDIRON_STARTUP_HEALTH: '1' }, clock: () => now, log: {} });
  await ts.probe();
  assert.equal((await drive(ts.gate, CARD[0])).status, 503);
  broken = false;
  now += SH.RETRY_MS - 1;
  assert.equal((await drive(ts.gate, CARD[0])).status, 503, 'no re-probe inside the retry window');
  now += 1;
  assert.equal(await drive(ts.gate, CARD[0]), 'next');
});

test('the gate logs the raw reason server-side', async () => {
  const lines = [];
  const ts = SH.createTradeSafety({ db: DB, loaders: { ...realLoaders(), rules: throwing('boom-xyz') }, env: { GRIDIRON_STARTUP_HEALTH: '1' }, log: { error: l => lines.push(l) } });
  await ts.probe();
  assert.ok(lines.some(l => l.includes('rules failed') && l.includes('boom-xyz')), lines.join('\n'));
});

test('B2: through express, a broken probe answers 503 before the router runs', async () => {
  const ts = SH.createTradeSafety({ db: DB, loaders: { ...realLoaders(), rules: throwing('boom') }, env: { GRIDIRON_STARTUP_HEALTH: '1' }, log: {} });
  const app = express();
  let reached = 0;
  const router = express.Router();
  router.get('/:leagueId/war-room', (_q, s) => { reached++; s.json({ card: true }); });
  router.get('/:leagueId/lineup', (_q, s) => s.json({ lineup: true }));
  app.use('/api/trades', ts.gate, router);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const card = await fetch(`${base}/api/trades/4/war-room`);
    assert.equal(card.status, 503);
    assert.equal((await card.json()).status, 'fail_closed');
    assert.equal(reached, 0);
    const lineup = await fetch(`${base}/api/trades/4/lineup`);
    assert.equal(lineup.status, 200);
  } finally { server.close(); }
});

test('B8: the gate is mounted once, ahead of every trade-card router, and the banner route is authenticated', () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const gateAt = src.indexOf('app.use(tradeSafety.gate);');
  assert.ok(gateAt > 0, 'gate mounted');
  assert.equal(src.split('app.use(tradeSafety.gate);').length, 2, 'mounted exactly once');
  for (const mount of ['/api/edge', '/api/tradelab', '/api/trades', '/api/execution-slate', '/api/warroom']) {
    const at = src.indexOf(`app.use('${mount}'`);
    assert.ok(at > gateAt, `${mount} is mounted after the gate`);
  }
  assert.match(src, /app\.get\('\/api\/trade-safety', \.\.\.legacyAuthenticated/);
});
