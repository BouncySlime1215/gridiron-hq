/**
 * TELLS-01b clone feed: the `prior_trades` receptiveness factor in
 * counterparty-pricing.js, read from producer 'tells' (`tells.prior_trades`).
 *
 *  (3) zero:['prior_trades'] gives today's receptiveness byte-for-byte; the factor is
 *      inert with a reason when the count is absent or the flag is off. Default-off:
 *      TELLS-01a arm B (`PREV|any_trade`) is a lead, so PRE (d) is unmet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-prior-trades-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const signals = await import('../server/services/manager-signals.js');
const pricing = await import('../server/services/counterparty-pricing.js');
const backfill = await import('../server/services/engine/backfill.js');
const producer = await import('../server/services/tells/producer.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const team = id => ({ id, name: `Team ${id}`, owners: [`{P${id}}`],
  record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 200, pointsAgainst: 200 } }, roster: { entries: [] } });
function league(id) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, connection_status)
       VALUES (?, 'espn', ?, ?, ?, ?, 4, '1', 'connected')`, id, `espn-pt-${id}`, SEASON, `PT${id}`,
  JSON.stringify({ seasonId: SEASON, scoringPeriodId: 7, teams: [1, 2, 3, 4].map(team), schedule: [] }));
}
let k = 0;
function raw(leagueId, season, type, teamId, period, items) {
  k += 1;
  const at = new Date(Date.UTC(season, 8, 1 + period * 7)).toISOString();
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, team_id,
       scoring_period, processed_at, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'EXECUTED', 'PROCESS', ?, ?, ?, ?, ?, ?)`,
  leagueId, season, `pt-${k}`, type, teamId, period, at, JSON.stringify(items), at, at);
}
const add = (lg, t, w) => raw(lg, SEASON, 'FREEAGENT', t, w, [{ type: 'ADD', fromTeamId: 0, toTeamId: t, playerId: 9000 + k }]);

// League 81: identical 2026 activity for every team; in 2025 teams 1 and 2 traded, 3 and 4 did not.
league(81);
for (const t of [1, 2, 3, 4]) for (let w = 1; w <= 6; w += 1) add(81, t, w);
raw(81, 2025, 'TRADE_ACCEPT', 1, 5, [{ type: 'TRADE', fromTeamId: 1, toTeamId: 2, playerId: 1 }, { type: 'TRADE', fromTeamId: 2, toTeamId: 1, playerId: 2 }]);
raw(81, 2025, 'FREEAGENT', 3, 4, [{ type: 'ADD', fromTeamId: 0, toTeamId: 3, playerId: 3 }]);
// League 82: no prior season in the log at all.
league(82);
for (const t of [1, 2, 3, 4]) for (let w = 1; w <= 6; w += 1) add(82, t, w);

signals.buildManagerSignals(81, { chat: null });
signals.buildManagerSignals(82, { chat: null });
backfill.backfillStream('tells_transactions', { database: db });
await producer.runTellsProducer({ database: db, asOf: new Date(Date.UTC(SEASON, 9, 20)).toISOString(),
  leagues: [{ leagueId: 81, season: SEASON }, { leagueId: 82, season: SEASON }] });

const layerFor = (id, opts = {}) => pricing.counterpartyLayer(id, { season: SEASON, week: 7, rosterContext: new Map(), ...opts });
const factor = (mp, source) => (mp.receptiveness_factors ?? []).find(f => f.source === source);
const withoutPrior = mp => JSON.stringify({ ...mp, receptiveness_factors: mp.receptiveness_factors.filter(f => f.source !== 'prior_trades') });

test('RED (3a): default-off — reported with what it would do, moves nothing', () => {
  delete process.env[pricing.PRIOR_TRADES_FLAG];
  const layer = layerFor(81);
  assert.equal(layer.get('1').receptiveness, layer.get('3').receptiveness);
  const f = factor(layer.get('1'), 'prior_trades');
  assert.equal(f.effect, null);
  assert.ok(f.would_effect > 0);
  assert.match(f.why, /default-off.*lead/);
  assert.equal(f.n, 1);
});

test('RED (3b): zero:[\'prior_trades\'] gives today\'s receptiveness byte-for-byte, and no factor entry', () => {
  for (const on of [false, true]) {
    const zeroed = layerFor(81, { zero: ['prior_trades'], priorTrades: on });
    const off = layerFor(81, { priorTrades: false });
    for (const id of ['1', '2', '3', '4']) {
      assert.equal(factor(zeroed.get(id), 'prior_trades'), undefined);
      assert.equal(JSON.stringify(zeroed.get(id)), withoutPrior(off.get(id)), `roster ${id}`);
    }
  }
});

test('RED (3c): on, a manager who traded last season reads more receptive, capped; the counter source is named', () => {
  const layer = layerFor(81, { priorTrades: true });
  const traded = factor(layer.get('1'), 'prior_trades');
  const idle = factor(layer.get('3'), 'prior_trades');
  assert.ok(traded.effect > 0 && idle.effect < 0);
  assert.ok(Math.abs(traded.effect) <= traded.cap);
  assert.ok(layer.get('1').receptiveness > layer.get('3').receptiveness);
  assert.match(traded.why, /1 trade in 2025 \(league_transactions\)/);
  assert.equal(traded.tell, 'PREV|any_trade');
});

test('RED (3d): with no stored count the factor is inert with its reason, flag on or off', () => {
  const on = layerFor(82, { priorTrades: true });
  const zeroed = layerFor(82, { zero: ['prior_trades'] });
  for (const id of ['1', '2', '3', '4']) {
    const f = factor(on.get(id), 'prior_trades');
    assert.equal(f.effect, null);
    assert.match(f.why, /^inert: no 2025 ESPN counter and no 2025 transactions/);
    assert.equal(on.get(id).receptiveness, zeroed.get(id).receptiveness);
  }
  const bare = pricing.priorTradesFactor(null, 0.5, 'engine_state is not built on this database');
  assert.equal(bare.effect, null);
  assert.match(bare.why, /engine_state is not built/);
});

test('the flag and preview mode: GRIDIRON_TELLS_PRIOR_TRADES=1 applies it; preview applies it labelled', () => {
  const prevPreview = process.env[PREVIEW_ENV];
  try {
    process.env[pricing.PRIOR_TRADES_FLAG] = '1';
    assert.ok(factor(layerFor(81).get('1'), 'prior_trades').effect > 0);
    assert.equal(factor(layerFor(81).get('1'), 'prior_trades').preview, undefined);
    delete process.env[pricing.PRIOR_TRADES_FLAG];
    process.env[PREVIEW_ENV] = '1';
    const f = factor(layerFor(81).get('1'), 'prior_trades');
    assert.ok(f.effect > 0);
    assert.equal(f.preview, true);
    assert.match(f.why, /^Preview \(unconfirmed forward\)/);
  } finally {
    delete process.env[pricing.PRIOR_TRADES_FLAG];
    if (prevPreview == null) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = prevPreview;
  }
});
