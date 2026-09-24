/**
 * "Where this price comes from" — the valuation map, on the surface that shows it.
 *
 * counterparty-pricing.js has built a per-manager, per-player valuation map since
 * 2026-09-18 with full provenance on every factor, and NOTHING in the running app
 * read it: `valuationMap` had no importer anywhere in server/, client/ or
 * scripts/. It was kept rather than deleted because it is the harness that
 * produced this layer's only measured ablation, and it is wired here rather than
 * rebuilt.
 *
 * The route is the existing per-player Trade Lab detail,
 * GET /api/trades/:leagueId/player/:id (client/src/pages/TradeLab.tsx:639). No new
 * route, no new model, no new weight.
 *
 * Guarantees:
 *  V1 the panel is on the response at all;
 *  V2 a league with no manager signals says WHICH absence it is, rather than
 *     returning an empty panel — the same honest-degradation rule the signals
 *     route already follows;
 *  V3 no Map or Set reaches the client as `{}`: `managers` is an array;
 *  V4 every factor names a source and carries its `as_of`, and a source too
 *     small to fire is reported inert WITH ITS REASON rather than dropped;
 *  V5 the ablation is MEASURED — `their_value_without` comes from re-running the
 *     valuation with that source suppressed, not from arithmetic on its effect;
 *  V6 it is a read, not a price: the panel carries no field the deal score reads,
 *     and the per-player clamp it reports is PLAYER_VALUATION_CAP, never the
 *     ±10% deal clamp at trade-engine.js perceptionFactorFor.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ServerResponse } from 'node:http';
import { Readable, PassThrough } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-valuation-panel-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
// The private chat corpus is never opened by this test: point it at a path that
// does not exist, which is also the deployed app's state.
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'absent-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
// Side-effect imports: several tables the trade engine reads are created at
// import time by other route files (the same wiring server/index.js relies on).
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { default: tradesRouter } = await import('../server/routes/trades.js');
const { PLAYER_VALUATION_CAP } = await import('../server/services/counterparty-pricing.js');

await runMigrations();
seedIfEmpty();

const app = express();
app.use(express.json());
app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'request failed' }));

const TOKEN = 'valuation-panel-token';
db.prepare(`INSERT OR IGNORE INTO users(id,subject,display_name) VALUES (882,'vp-user','VP User')`).run();
db.prepare(`INSERT OR REPLACE INTO auth_sessions(user_id,token_hash,expires_at) VALUES (882,?,datetime('now','+1 day'))`)
  .run(hashSessionToken(TOKEN));

after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

async function request(url) {
  const req = new Readable({ read() { this.push(null); } });
  req.url = url; req.method = 'GET'; req.headers = { authorization: `Bearer ${TOKEN}` };
  req.socket = new PassThrough(); req.connection = req.socket;
  return new Promise((resolve, reject) => {
    const res = new ServerResponse(req); const chunks = [];
    res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    };
    app.handle(req, res, reject);
  });
}

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const entry = (player, fakeId) =>
  ({ playerPoolEntry: { player: { id: fakeId, fullName: player.name, defaultPositionId: POS_ID[player.position] } } });

const espnPlayers = (position, n) =>
  rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT ?`,
    position, n);

function rosterPair() {
  const qb = espnPlayers('QB', 2), rb = espnPlayers('RB', 6), wr = espnPlayers('WR', 6), te = espnPlayers('TE', 2);
  const mine = [...qb.slice(0, 1), ...rb.slice(0, 3), ...wr.slice(0, 3), ...te.slice(0, 1)];
  const theirs = [...qb.slice(1, 2), ...rb.slice(3, 6), ...wr.slice(3, 6), ...te.slice(1, 2)];
  let fakeId = 910000;
  const withEntries = list => list.map(p => entry(p, fakeId++));
  return {
    theirs,
    payload: {
      teams: [
        { id: 1, name: 'My Team', roster: { entries: withEntries(mine) } },
        { id: 2, name: 'Rival Team', roster: { entries: withEntries(theirs) } },
      ],
      settings: { name: 'VP League' },
    },
  };
}

function insertLeague(id, payload) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'VP League', ?, 10, '1', ?, 'x', 'y', 'connected')`,
    id, `espn-${id}`, JSON.stringify(payload),
    JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 882, 'commissioner')`, id);
}

/* ------------------------------------------------------------------ V1, V2 */

test('V1/V2: a league with no manager signals gets a panel that says which absence it is', async () => {
  const { payload, theirs } = rosterPair();
  insertLeague(201, payload);
  const res = await request(`/api/trades/201/player/${theirs[0].id}`);
  assert.equal(res.status, 200);
  const vm = res.body.valuation_map;
  assert.ok(vm, 'the player detail carries valuation_map');
  assert.equal(vm.available, false);
  assert.ok(typeof vm.reason === 'string' && vm.reason.length > 20,
    'an unbuilt layer says which absence it is, in a sentence');
  assert.deepEqual(vm.managers, [], 'an absent panel is an empty list, never an empty object');
});

/* -------------------------------------------------------- V3, V4, V5, V6 */

function seedSentiment(leagueId, playerName) {
  // manager_player_view is the in-database half of the chat read: it survives on
  // the deployed app while the corpus itself does not. One row is enough for
  // chat_sentiment (min_n 1) and is what a league with signals but no corpus has.
  // sentiment is 0..4 with 2 neutral; 3.4 is real praise, which is what makes a
  // factor fire at all.
  run(`INSERT INTO manager_player_view(league_id, roster_id, player_name, sentiment, n, last_mention, source)
       VALUES (?, '2', ?, 3.4, 4, '2026-09-18T00:00:00Z', 'chat')`, leagueId, playerName.toLowerCase());
}

test('V3/V4/V5/V6: the panel prices the player per manager, with provenance and a measured ablation', async () => {
  const { payload, theirs } = rosterPair();
  insertLeague(202, payload);
  const target = theirs[0];
  seedSentiment(202, target.name);

  const res = await request(`/api/trades/202/player/${target.id}`);
  assert.equal(res.status, 200);
  const vm = res.body.valuation_map;
  assert.equal(vm.available, true, vm.reason ?? 'the layer should be built');

  // V3
  assert.ok(Array.isArray(vm.managers), 'managers is an array, not a serialised Map');
  assert.ok(Array.isArray(vm.sources_used));
  assert.ok(Array.isArray(vm.sources_absent));
  assert.ok(vm.managers.length >= 1);
  assert.ok(!vm.managers.some(m => String(m.roster_id) === String(vm.my_roster_id)),
    'Nick is never his own counterparty');

  const rival = vm.managers.find(m => String(m.roster_id) === '2');
  assert.ok(rival, 'the rival who owns him is in the panel');
  const v = rival.valuation;
  assert.ok(v, 'each manager carries this player\'s valuation');
  for (const k of ['our_value', 'their_value', 'multiplier', 'capped', 'owns', 'factors', 'inert']) {
    assert.ok(k in v, `the valuation carries ${k}`);
  }
  assert.equal(v.owns, true, 'he owns him, and owning is a different question from buying');

  // V4
  assert.ok(v.factors.length >= 1, 'the seeded chat read fires at least one factor');
  for (const f of v.factors) {
    assert.ok(typeof f.source === 'string' && f.source, 'every factor names its source');
    assert.ok('as_of' in f, 'every factor carries its as_of, even when null');
    assert.ok(typeof f.why === 'string' && f.why, 'every factor says why in words');
  }
  assert.ok(v.inert.length >= 1,
    'this fixture has no archetype build, so luck_self_view is under its min_n and must be reported inert');
  for (const i of v.inert) {
    assert.ok(typeof i.source === 'string' && i.source);
    assert.ok(typeof i.reason === 'string' && i.reason,
      'a source too small to fire is reported with its reason, not dropped');
  }
  for (const a of vm.sources_absent) {
    assert.ok(typeof a.reason === 'string' && a.reason, 'an absent source says which absence it is');
  }

  // V5 — the ablation is a re-run, not arithmetic
  assert.ok(Array.isArray(rival.ablation));
  assert.deepEqual(rival.ablation.map(a => a.source).sort(), v.factors.map(f => f.source).sort(),
    'the ablation covers exactly the sources that fired for this player');
  for (const a of rival.ablation) {
    assert.ok(Number.isFinite(a.their_value_without));
    assert.ok(Math.abs((v.their_value - a.their_value_without) - a.delta) < 1e-6,
      'delta is their_value minus the re-run without that source');
    assert.ok(Number.isFinite(a.multiplier_without));
    assert.ok(Math.abs((v.multiplier - a.multiplier_without) - a.multiplier_delta) < 1e-6,
      'multiplier_delta is the multiplier minus the re-run without that source');
    assert.ok(Math.abs(a.multiplier_delta) > 0,
      'suppressing a source that fired really moves the multiplier');
  }

  // The reason the multiplier is reported at all. This fixture's player has no
  // projection, so our_value is 0 and every VALUE delta is 0 however hard the
  // sources pull -- a panel carrying the value alone would say "this source does
  // nothing" about two sources doing plenty. Pinned so the field is not tidied
  // away as a duplicate of `delta`.
  if (v.our_value === 0) {
    assert.ok(rival.ablation.every(a => a.delta === 0),
      'an unpriced player has no value movement to show');
    assert.ok(rival.ablation.some(a => a.multiplier_delta !== 0),
      'and the multiplier is where the ablation is visible for him');
  }

  // V6 — the clamp reported here is the per-player one, and nothing else
  assert.ok(v.multiplier <= 1 + PLAYER_VALUATION_CAP + 1e-9);
  assert.ok(v.multiplier >= 1 - PLAYER_VALUATION_CAP - 1e-9);
  for (const k of ['deal_score', 'perception_factor', 'score_delta']) {
    assert.ok(!(k in vm), `the panel carries no ${k}: it is a read of the sources, not an input to the deal score`);
  }
});

test('V2b: two different absences give two different sentences, and neither is a crash', async () => {
  const { payload, theirs } = rosterPair();
  insertLeague(203, payload);
  // This league HAS a manager layer, so "nothing to show" here cannot be the
  // unbuilt-layer answer. The rule the whole panel rests on is that an absence
  // says which absence it is; two absences that read alike are one absence.
  seedSentiment(203, theirs[0].name);

  const unpriced = (await request('/api/trades/203/player/99999999')).body.valuation_map;
  const unbuilt = (await request(`/api/trades/201/player/${theirs[0].id}`)).body.valuation_map;

  assert.ok(unpriced, 'the panel is present even when it has nothing to say');
  assert.equal(unpriced.available, false);
  assert.ok(typeof unpriced.reason === 'string' && unpriced.reason.length > 20);
  assert.deepEqual(unpriced.managers, []);

  assert.equal(unbuilt.available, false);
  assert.notEqual(unpriced.reason, unbuilt.reason,
    'a player this model never priced and a league whose layer was never built are different absences');

  // A player nobody priced is not a broken layer. The route reports a thrown
  // fault rather than swallowing it, which is right -- but reporting a KNOWN
  // absence as a fault would be the panel lying about its own provenance.
  assert.ok(!/failed to build/.test(unpriced.reason),
    'an unpriced player is answered by the panel, not by its error handler');
});

/* ---------------------------------------------------------------- PREVIEW-01 */
// The panel's layer is built by the route's own counterpartyLayer call (trades.js
// valuationPanel), so preview reaches this page only through that call. A call site that
// passed `activity: false` switched preview off here while every direct-layer test passed
// (skeptic mutant MD). League 204: week 7 in progress, the rival added twelve players in
// the six completed weeks and Nick none, so the activity term moves the rival's receptiveness.
test('PREVIEW-01: the valuation panel prices receptiveness with the preview terms on, and without them unset', async () => {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
  const { payload, theirs } = rosterPair();
  insertLeague(204, { ...payload, seasonId: 2026, scoringPeriodId: 7, schedule: [] });
  seedSentiment(204, theirs[0].name);
  for (let i = 0; i < 12; i += 1) {
    run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, team_id,
         scoring_period, items_json, first_seen_at, last_seen_at)
         VALUES (204, 2026, ?, 'WAIVER', 'EXECUTED', 'PROCESS', 2, ?, ?, 'x', 'x')`,
      `vp-${i}`, 1 + (i % 6), JSON.stringify([{ type: 'ADD', fromTeamId: 0, toTeamId: 2, playerId: 9100 + i }]));
  }
  const { buildManagerSignals } = await import('../server/services/manager-signals.js');
  const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
  const { ACTIVITY_FLAG } = await import('../server/services/counterparty-pricing.js');
  buildManagerSignals(204, { chat: null });
  const rivalReceptiveness = async value => {
    const saved = process.env[PREVIEW_ENV];
    delete process.env[ACTIVITY_FLAG];
    if (value === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = value;
    try {
      const vm = (await request(`/api/trades/204/player/${theirs[0].id}`)).body.valuation_map;
      assert.equal(vm.available, true, vm.reason ?? '');
      return vm.managers.find(m => String(m.roster_id) === '2').receptiveness;
    } finally {
      if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
    }
  };
  const off = await rivalReceptiveness(undefined);
  const on = await rivalReceptiveness('1');
  assert.ok(Number.isFinite(off) && Number.isFinite(on));
  assert.ok(on > off, `preview raises the busy rival's receptiveness on the panel (off ${off}, on ${on})`);
});

/**
 * BROKEN-F (docs/tdd/2026-09-24-broken-f-player-values.tdd.md): the panel's
 * per-manager number is a CLONE price, the deep dive's `value` a FantasyCalc
 * market price. Under the preview switch each says which; off, nothing changes.
 */
test('BROKEN-F: under preview the deep dive names its market value and the panel its clone price', async () => {
  const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
  const { payload, theirs } = rosterPair();
  insertLeague(211, payload);
  const target = theirs[0];
  seedSentiment(211, target.name);
  // Priced, so the clone's multiplier moves a real number: with our_value 0 the
  // two prices are both 0 and a swapped field would pass unseen.
  const { deriveFormat } = await import('../server/services/format.js');
  const lg211 = rows('SELECT * FROM leagues WHERE id = 211')[0];
  run(`INSERT OR REPLACE INTO dynasty_values (player_id, format_key, value, fetched_at) VALUES (?, ?, 5000, datetime('now'))`,
    target.id, deriveFormat(lg211).formatKey);
  const saved = process.env[PREVIEW_ENV];
  try {
    delete process.env[PREVIEW_ENV];
    const off = (await request(`/api/trades/211/player/${target.id}`)).body;
    for (const k of ['value_kind', 'value_label', 'preview']) {
      assert.ok(!(k in off), `switch off: the deep dive carries no ${k}`);
      assert.ok(!(k in off.valuation_map), `switch off: the panel carries no ${k}`);
    }
    assert.ok(off.valuation_map.managers.every(m => !('clone_price' in m)), 'switch off: no clone_price');

    process.env[PREVIEW_ENV] = '1';
    const on = (await request(`/api/trades/211/player/${target.id}`)).body;
    assert.equal(on.value_kind, 'market_value');
    assert.equal(on.value_label, 'Market value (FantasyCalc)');
    assert.equal(on.preview, true);
    const vm = on.valuation_map;
    assert.equal(vm.available, true, vm.reason ?? 'the layer should be built');
    assert.equal(vm.value_kind, 'clone_price');
    assert.equal(vm.value_label, 'Clone price');
    assert.ok(vm.managers.length >= 1);
    const rival = vm.managers.find(m => String(m.roster_id) === '2');
    assert.ok(rival && rival.market_value > 0 && rival.clone_price !== rival.market_value,
      `the rival's clone moves the price (market ${rival?.market_value}, clone ${rival?.clone_price})`);
    for (const m of vm.managers) {
      assert.equal(m.clone_price, m.valuation.their_value, 'clone_price IS their_value, not a re-pricing');
      assert.equal(m.market_value, m.valuation.our_value, 'market_value IS the price the clone starts from');
    }
  } finally {
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
});
