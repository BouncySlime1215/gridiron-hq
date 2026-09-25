/**
 * TELLS-01b clone feed, FIX-268-8: the `prior_trades` feature lives in the ONE counterpart
 * model (server/services/people/counterpart.js, RULINGS 2), read from producer 'tells'
 * (`tells.prior_trades`) on the hub. counterparty-pricing.js no longer has it.
 *
 *  (3) without the hub read the model is today's byte-for-byte; the feature is inert with
 *      a reason when the count is absent, and moves nothing with the flag off. Default-off:
 *      TELLS-01a arm B (`PREV|any_trade`) is a lead, so PRE (d) is unmet. P(accept) never moves.
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
const cp = await import('../server/services/people/counterpart.js');
const hub = await import('../server/services/people/hub-read.js');
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

backfill.backfillStream('tells_transactions', { database: db });
await producer.runTellsProducer({ database: db, asOf: new Date(Date.UTC(SEASON, 9, 20)).toISOString(),
  leagues: [{ leagueId: 81, season: SEASON }, { leagueId: 82, season: SEASON }] });

const AS_OF = new Date(Date.UTC(SEASON, 9, 21)).toISOString();
const NOW = Date.parse(AS_OF);
// Team 1 is Nick's (my_team_id): the hub reads it as `self`, so his counterparties are 2-4.
const TEAMS = ['2', '3', '4'];
const OFF = { on: false, preview: false };
const ON = { on: true, preview: false };
const models = async (id, priorFlag, { withPrior = true } = {}) => cp.buildCounterparts({ profiles: new Map(), players: new Map(),
  now: NOW, teams: TEAMS, ...(withPrior ? { priorTrades: await hub.hubTellsPriorTrades(id, { asOf: AS_OF }), priorFlag } : {}) });
const BASE = { p: 0.4, basis: 'activity' };
const responds = (m, team) => cp.respondsAdjust(BASE, m.get(team), [], { baseAnchor: 0.55 });

test('the pricing layer has no prior_trades term any more: one counterpart producer (RULINGS 2)', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../server/services/counterparty-pricing.js'), 'utf8');
  assert.doesNotMatch(src, /prior_trades|PRIOR_TRADES|tells\./);
});

test('RED (3a): default-off - reported on the model with what it would do, moves nothing', async () => {
  const m = await models(81, OFF);
  const f = m.get('2').prior_trades;
  assert.equal(f.applied, false);
  assert.equal(f.relative, null);
  assert.ok(f.would_relative > 0);
  assert.match(f.basis, /default-off.*lead/);
  assert.equal(f.n, 1);
  const bare = await models(81, OFF, { withPrior: false });
  for (const t of TEAMS) assert.deepEqual(responds(m, t), responds(bare, t), `team ${t}`);
});

test('RED (3b): without the hub read the model is today\'s byte-for-byte, with no prior_trades key', async () => {
  const bare = await models(81, null, { withPrior: false });
  const off = await models(81, OFF);
  for (const t of TEAMS) {
    assert.equal(bare.get(t).prior_trades, undefined);
    assert.equal('prior_trades' in cp.publicModel(bare.get(t)), false);
    const { prior_trades: _, ...rest } = cp.publicModel(off.get(t));
    assert.equal(JSON.stringify(cp.publicModel(bare.get(t))), JSON.stringify(rest), `team ${t}`);
  }
});

test('RED (3c): on, a manager who traded last season reads more likely to respond, capped; P(accept) never moves', async () => {
  const m = await models(81, ON);
  const traded = m.get('2').prior_trades;
  const idle = m.get('3').prior_trades;
  assert.ok(traded.relative > 0 && idle.relative < 0);
  assert.ok(Math.abs(traded.relative) <= cp.PRIOR_TRADES_CAP);
  assert.match(traded.basis, /1 trade in 2025 \(league_transactions\)/);
  assert.equal(traded.tell, 'PREV|any_trade');
  const r1 = responds(m, '2'); const r3 = responds(m, '3');
  assert.ok(r1.p > r3.p);
  assert.equal(r1.features.find(f => f.feature === 'prior_trades').effect, 'multiplier');
  const adapter = { managers: new Map(TEAMS.map(t => [t, {}])), priceStep: () => ({ p: 0.3 }) };
  assert.equal(cp.withCounterparts(adapter, m).priceStep('2', [], []).p, 0.3, 'never a P(accept) input');
});

test('RED (3d): with no stored count the feature is inert with its reason, flag on or off', async () => {
  for (const flag of [ON, OFF]) {
    const m = await models(82, flag);
    for (const t of TEAMS) {
      const f = m.get(t).prior_trades;
      assert.equal(f.relative, null);
      assert.match(f.basis, /^inert: no 2025 ESPN counter and no 2025 transactions/);
    }
  }
  const none = await models(99, ON);
  assert.match(none.get('2').prior_trades.basis, /^inert: no tells\.prior_trades rows on the hub/);
});

test('the hub round-trip keeps the feature: publicModel -> modelFromValue', async () => {
  const m = await models(81, ON);
  const back = hub.modelFromValue(cp.publicModel(m.get('2')));
  assert.deepEqual(back.prior_trades, m.get('2').prior_trades);
});

test('the flag and preview mode: GRIDIRON_TELLS_PRIOR_TRADES=1 applies it; preview applies it labelled; =0 vetoes preview', async () => {
  const prevPreview = process.env[PREVIEW_ENV];
  try {
    assert.deepEqual(cp.priorTradesFlag({ [cp.PRIOR_TRADES_FLAG]: '1' }), ON);
    delete process.env[PREVIEW_ENV];
    assert.equal(cp.priorTradesFlag({}).on, false);
    process.env[PREVIEW_ENV] = '1';
    const flag = cp.priorTradesFlag({});
    assert.equal(flag.preview, true);
    assert.equal(cp.priorTradesFlag({ [cp.PRIOR_TRADES_FLAG]: '0' }).on, false);
    const f = (await models(81, flag)).get('2').prior_trades;
    assert.ok(f.relative > 0);
    assert.equal(f.preview, true);
    assert.match(f.basis, /^Preview \(unconfirmed forward\)/);
  } finally {
    if (prevPreview == null) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = prevPreview;
  }
});
