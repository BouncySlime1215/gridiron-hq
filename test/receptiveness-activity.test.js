/**
 * RL-11-1: what a manager has DONE this season enters trade receptiveness.
 *
 * Sleeper 2021-24 corpus (rnd/loop r11 package, validator re-derived): the top
 * quintile of adds per week completes a trade ~3x as often as the bottom one,
 * and "has already traded" adds on top (activity-only AUC 0.652 on 2024). A
 * starter left in who did not play marks a checked-out team (-11% relative,
 * league-week demeaned). Before this unit `tx_waiver_moves` was computed by
 * manager-signals.js and read by nothing, so two managers who differed only in
 * activity got the same receptiveness.
 *
 *  A1 two managers identical except activity get different receptiveness, and
 *     the factor says "chance he completes a trade", never acceptance
 *  A2 below five weeks the term is withheld: reported with its reason, no effect
 *  A3 a manager with zero adds reads 0 per week, not "missing"
 *  A4 a dead starter left in last week is a checked-out factor that lowers
 *     receptiveness; with no snap data for that week it is withheld, not "no"
 *  A0 default-off (it missed its pre-registered held-out bar): reported, not applied
 *  A5 both factors reach the Brain managers board as a list, not a run-on string
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-recept-activity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS nfl_snaps (
  season INTEGER, week INTEGER, player TEXT, team TEXT, position TEXT,
  offense_snaps INTEGER, offense_pct REAL, st_pct REAL, defense_snaps INTEGER, defense_pct REAL,
  PRIMARY KEY (season, week, player, team))`);
const signals = await import('../server/services/manager-signals.js');
const pricing = await import('../server/services/counterparty-pricing.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
const team = id => ({ id, name: `Team ${id}`, owners: [`{M${id}}`],
  record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 200, pointsAgainst: 200, streakType: 'WIN', streakLength: 1 } },
  roster: { entries: [] } });
function league(id, scoringPeriodId) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id, connection_status)
       VALUES (?, 'espn', ?, ?, ?, ?, 4, '1', 'connected')`,
  id, `espn-ra-${id}`, SEASON, `RA${id}`,
  JSON.stringify({ seasonId: SEASON, scoringPeriodId, teams: [1, 2, 3, 4].map(team), schedule: [] }));
}
let txn = 0;
function add(leagueId, teamId, period) {
  txn += 1;
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, team_id,
       scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'WAIVER', 'EXECUTED', 'PROCESS', ?, ?, ?, 'x', 'x')`,
  leagueId, SEASON, `ra-${txn}`, teamId, period,
  JSON.stringify([{ type: 'ADD', fromTeamId: 0, toTeamId: teamId, playerId: 9000 + txn },
    { type: 'DROP', fromTeamId: teamId, toTeamId: 0, playerId: 8000 + txn }]));
}
function starter(leagueId, period, teamId, espnId, name, points, position = 'WR') {
  run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id,
       player_name, position, lineup_slot_id, is_starter, actual_points, source, first_seen_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 4, 1, ?, 'final', 'x', 'x')`,
  leagueId, SEASON, period, teamId, espnId, name, position, points);
}
const snap = (week, player, offense) => run(`INSERT INTO nfl_snaps (season, week, player, team, position, offense_snaps)
  VALUES (?, ?, ?, 'XX', 'WR', ?)`, SEASON, week, player, offense);

// League 61: week 7 in progress, so six completed weeks, past the five-week gate.
// Rosters 2 and 3 are identical except that 2 added twelve players and 3 none.
league(61, 7);
for (let i = 0; i < 12; i += 1) add(61, 2, 1 + (i % 6));
add(61, 2, 7); // in the week still being played: not in the rate
for (let i = 0; i < 3; i += 1) add(61, 4, 2 + i);
add(61, 1, 3);
// Last week's final lineups (period 6). Roster 4 left in a starter who did not play.
for (const t of [1, 2, 3, 4]) starter(61, 6, t, 100 + t, `Active Guy ${t}`, 11.5);
starter(61, 6, 4, 200, 'Dead Starter', 0);
starter(61, 6, 3, 201, 'Zero But Played', 0);
for (const t of [1, 2, 3, 4]) snap(6, `Active Guy ${t}`, 50);
snap(6, 'Zero But Played', 40);

// League 62: week 4 in progress, three completed weeks: under the gate.
league(62, 4);
for (let i = 0; i < 9; i += 1) add(62, 2, 1 + (i % 3));
add(62, 4, 2);
// Last week's final lineup has a dead starter, but no nfl_snaps row exists for week 3 at all.
starter(62, 3, 4, 300, 'Dead Or Unknown', 0);

// A trade the league processed (both sides on the PROCESS row) and one it vetoed (CANCEL).
function trade(leagueId, id, status, execution, a, b, period) {
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, team_id,
       scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'TRADE_ACCEPT', ?, ?, ?, ?, ?, 'x', 'x')`,
  leagueId, SEASON, id, status, execution, a, period,
  JSON.stringify([{ type: 'TRADE', fromTeamId: a, toTeamId: b, playerId: 1 }, { type: 'TRADE', fromTeamId: b, toTeamId: a, playerId: 2 }]));
}
trade(61, 'ra-trade-ok', 'EXECUTED', 'PROCESS', 1, 4, 5);
trade(61, 'ra-trade-veto', 'CANCELED', 'CANCEL', 1, 2, 4);
trade(61, 'ra-trade-late', 'EXECUTED', 'PROCESS', 1, 3, 7);

// League 63: week 7 in progress. Rosters 2 and 3 are identical in adds (one a week); 2 completed a
// trade with 1 in period 6, the last completed week. Roster 4's zero-point starters did play, under
// spellings that differ between ESPN and nflverse.
league(63, 7);
for (const t of [2, 3]) for (let w = 1; w <= 6; w += 1) add(63, t, w);
trade(63, 'ra-trade-last-week', 'EXECUTED', 'PROCESS', 2, 1, 6);
starter(63, 6, 4, 400, 'DJ Moore', -0.1);
starter(63, 6, 4, 401, 'Aaron Jones Sr.', 0, 'RB');
snap(6, 'D.J. Moore', 23);
snap(6, 'Aaron Jones', 31);

signals.buildManagerSignals(61, { chat: null });
signals.buildManagerSignals(63, { chat: null });
signals.buildManagerSignals(62, { chat: null });

// The terms ship default-off (2024 held-out AUC 0.644 missed the pre-registered 0.645), so the
// behaviour tests turn them on explicitly and A0 pins the default.
const layerFor = (id, opts = {}) => pricing.counterpartyLayer(id,
  { season: SEASON, week: 7, rosterContext: new Map(), activity: true, ...opts });
const factor = (mp, source) => (mp.receptiveness_factors ?? []).find(f => f.source === source);

test('A0: by default the terms are reported with what they would do, and move nothing', () => {
  delete process.env[pricing.ACTIVITY_FLAG];
  const layer = layerFor(61, { activity: null });
  const busy = layer.get('2'), idle = layer.get('3');
  assert.equal(busy.receptiveness, idle.receptiveness);
  const f = factor(busy, 'trade_activity');
  assert.equal(f.effect, null);
  assert.ok(f.would_effect > 0);
  assert.match(f.why, /default-off.*unconfirmed forward/);
  assert.equal(factor(layer.get('4'), 'checked_out').effect, null);
  process.env[pricing.ACTIVITY_FLAG] = '1';
  try {
    const on = layerFor(61, { activity: null });
    assert.ok(on.get('2').receptiveness > on.get('3').receptiveness, 'the flag turns it on');
  } finally { delete process.env[pricing.ACTIVITY_FLAG]; }
});

test('A1: two managers identical except activity get different receptiveness', () => {
  const layer = layerFor(61);
  const busy = layer.get('2'), idle = layer.get('3');
  assert.ok(busy.receptiveness > idle.receptiveness,
    `busy ${busy.receptiveness} must read above idle ${idle.receptiveness}`);
  const f = factor(busy, 'trade_activity');
  assert.ok(f, 'the activity factor is reported');
  assert.ok(f.effect > 0 && factor(idle, 'trade_activity').effect < 0, 'above the league mean helps, below hurts');
  assert.match(f.label, /chance he completes a trade/i);
  assert.doesNotMatch(f.label, /accept/i);
  assert.equal(f.n, 6, 'n is the weeks the rate averages over');
});

test('A2: below the five-week gate the term is withheld, with its reason', () => {
  const layer = layerFor(62);
  const busy = layer.get('2'), idle = layer.get('3');
  assert.equal(busy.receptiveness, idle.receptiveness);
  const f = factor(busy, 'trade_activity');
  assert.ok(f, 'withheld is reported, not dropped');
  assert.equal(f.effect, null);
  assert.match(f.why, /3 of 5 weeks/);
});

test('A3: a manager with no adds reads zero per week, not missing', () => {
  const idle = signals.managerSignalsFor(61).get('3');
  assert.equal(idle.metrics.tx_adds_per_week, 0);
  assert.equal(idle.samples.tx_adds_per_week, 6);
  assert.equal(signals.managerSignalsFor(61).get('2').metrics.tx_adds_per_week, 2);
});

test('A3b: a processed trade counts for both sides; a vetoed one and one after the last completed week do not', () => {
  const sig = signals.managerSignalsFor(61);
  assert.equal(sig.get('4').metrics.tx_completed_trades, 1);
  assert.equal(sig.get('1').metrics.tx_completed_trades, 1);
  assert.equal(sig.get('2').metrics.tx_completed_trades, 0, 'vetoed');
  assert.equal(sig.get('3').metrics.tx_completed_trades, 0, 'period 7 is still in progress');
});

test('A4: a dead starter left in last week is a checked-out factor; unknown snaps withhold it', () => {
  const layer = layerFor(61);
  const out = factor(layer.get('4'), 'checked_out');
  assert.ok(out && out.effect < 0, 'checked out lowers receptiveness');
  assert.match(out.why, /did not play/);
  assert.equal(factor(layer.get('3'), 'checked_out'), undefined, 'zero points but played is not checked out');
  const unknown = factor(layerFor(62).get('4'), 'checked_out');
  assert.ok(unknown, 'reported');
  assert.equal(unknown.effect, null, 'no snap data for the week is unknown, not "no"');
});

test('A5: the Brain managers board lists receptiveness factors', () => {
  const src = fs.readFileSync(path.join(REPO, 'client/src/components/brain/ManagerBoard.tsx'), 'utf8');
  assert.match(src, /function ReceptivenessFactors/);
  assert.match(src, /<ReceptivenessFactors /);
});

test('A4b: the checked-out term moves the score, not just the factor list', () => {
  const on = layerFor(61).get('4');
  const without = layerFor(61, { zero: ['checked_out'] }).get('4');
  const out = factor(on, 'checked_out');
  assert.ok(on.receptiveness < without.receptiveness,
    `checked out ${on.receptiveness} must read below the same roster without the term ${without.receptiveness}`);
  assert.ok(out.effect < 0);
});

test('A6: "already traded" is half the activity term: equal adds, the one who traded reads higher', () => {
  const layer = layerFor(63);
  const traded = layer.get('2'), notYet = layer.get('3');
  assert.equal(signals.managerSignalsFor(63).get('2').metrics.tx_adds_per_week,
    signals.managerSignalsFor(63).get('3').metrics.tx_adds_per_week);
  assert.ok(traded.receptiveness > notYet.receptiveness,
    `traded ${traded.receptiveness} must read above not-yet ${notYet.receptiveness}`);
  assert.ok(factor(traded, 'trade_activity').effect > factor(notYet, 'trade_activity').effect);
});

test('A3c: a trade processed in the last completed week counts', () => {
  const sig = signals.managerSignalsFor(63);
  assert.equal(sig.get('2').metrics.tx_completed_trades, 1);
  assert.equal(sig.get('1').metrics.tx_completed_trades, 1);
});

test('A3d: tx_waiver_moves is the same add count as the rate, through the last completed week', () => {
  const busy = signals.managerSignalsFor(61).get('2');
  assert.equal(busy.metrics.tx_waiver_moves, 12, 'the add in the week still being played is not counted');
  assert.equal(busy.metrics.tx_waiver_moves, busy.metrics.tx_adds_per_week * busy.samples.tx_adds_per_week);
});

test('A7: a zero-point starter who played under another spelling is not checked out', () => {
  const sig = signals.managerSignalsFor(63).get('4');
  assert.equal(sig.metrics.lineup_dead_starts_last_week, 0, '"DJ Moore" played as "D.J. Moore", "Aaron Jones Sr." as "Aaron Jones"');
  assert.equal(factor(layerFor(63).get('4'), 'checked_out'), undefined);
});

// ---------------------------------------------------------------- PREVIEW-01
// PREVIEW_ENV is imported with the other modules at the top: a top-level await placed
// after test() calls lets Node 22 run test.after (db.close) before these tests.
function withPreview(value, fn) {
  const saved = process.env[PREVIEW_ENV];
  delete process.env[pricing.ACTIVITY_FLAG];
  if (value === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
}

test('PREVIEW-01 off (unset): the terms are withheld exactly as A0, no preview field', () => {
  withPreview(undefined, () => {
    const layer = layerFor(61, { activity: null });
    assert.equal(layer.get('2').receptiveness, layer.get('3').receptiveness);
    const f = factor(layer.get('2'), 'trade_activity');
    assert.equal(f.effect, null);
    assert.match(f.why, /^not applied \(default-off: 2024 held-out AUC 0\.644 missed its 0\.645 bar; unconfirmed forward\)/);
    assert.equal('preview' in f, false);
  });
});

test('PREVIEW-01 on: the terms move the score, each carries preview:true and its unconfirmed-forward reason', () => {
  withPreview('1', () => {
    const layer = layerFor(61, { activity: null });
    assert.ok(layer.get('2').receptiveness > layer.get('3').receptiveness, 'preview turns it on');
    const f = factor(layer.get('2'), 'trade_activity');
    assert.ok(f.effect > 0);
    assert.equal(f.preview, true);
    assert.equal(f.preview_reason, 'default-off: 2024 held-out AUC 0.644 missed its 0.645 bar; unconfirmed forward');
    assert.match(f.why, /^Preview \(unconfirmed forward\): /);
    // BROKEN-H: under preview the checked-out term is activity.manager's, never the dead-start
    // factor beside it. This fixture has no activity.manager row, so it is withheld with that reason.
    const cs = layer.get('4').receptiveness_factors.filter(x => x.source === 'checked_out');
    assert.equal(cs.length, 1, 'one checked-out signal');
    assert.equal(cs[0].engine?.field, 'activity.manager');
    assert.equal(cs[0].effect, null);
    assert.match(cs[0].why, /no activity\.manager row/);
  });
});

test('PREVIEW-01: an explicit activity:false still wins over the preview switch', () => {
  withPreview('1', () => {
    const f = factor(layerFor(61, { activity: false }).get('2'), 'trade_activity');
    assert.equal(f.effect, null);
    assert.equal('preview' in f, false);
  });
});

// The pages reach the terms only through the routes' own counterpartyLayer calls, so a
// call site that passed `activity: false` would switch preview off for the page while every
// direct-layer test above still passed (skeptic mutant MD, trades.js:397 and :965).
async function managersSignalsRoute(leagueId) {
  const express = (await import('express')).default;
  const { hashSessionToken } = await import('../server/platform/auth.js');
  const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
  const { default: tradesRouter } = await import('../server/routes/trades.js');
  run(`INSERT OR IGNORE INTO users(id, subject, display_name) VALUES (7761, 'recept-preview', 'Reader')`);
  run(`INSERT OR REPLACE INTO auth_sessions(user_id, token_hash, expires_at) VALUES (7761, ?, datetime('now','+1 day'))`,
    hashSessionToken('recept-preview-token'));
  run(`INSERT OR IGNORE INTO league_memberships(league_id, user_id, role) VALUES (?, 7761, 'member')`, leagueId);
  const app = express();
  app.use('/api/trades', ...legacyAuthenticated, tradesRouter);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/trades/${leagueId}/managers/signals`,
      { headers: { authorization: 'Bearer recept-preview-token' } });
    assert.equal(res.status, 200);
    return await res.json();
  } finally { server.close(); }
}
const routeFactor = (body, rid, source) =>
  (body.managers.find(m => m.roster_id === rid)?.receptiveness?.factors ?? []).find(f => f.source === source);

test('PREVIEW-01 on: GET /api/trades/:leagueId/managers/signals (ManagerRead) serves the applied terms with preview:true', async () => {
  const saved = process.env[PREVIEW_ENV];
  delete process.env[pricing.ACTIVITY_FLAG];
  process.env[PREVIEW_ENV] = '1';
  try {
    const body = await managersSignalsRoute(61);
    assert.equal(body.available, true, body.reason ?? '');
    const busy = body.managers.find(m => m.roster_id === '2').receptiveness;
    const idle = body.managers.find(m => m.roster_id === '3').receptiveness;
    assert.ok(busy.value > idle.value, 'preview moves receptiveness on the page');
    const f = routeFactor(body, '2', 'trade_activity');
    assert.ok(f.effect > 0);
    assert.equal(f.preview, true);
    assert.match(f.preview_reason, /unconfirmed forward/);
    // BROKEN-H: the page's checked-out term under preview is activity.manager's (withheld here: no row).
    const c = routeFactor(body, '4', 'checked_out');
    assert.equal(c.effect, null);
    assert.match(c.why, /no activity\.manager row/);
  } finally {
    if (saved === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = saved;
  }
});

test('PREVIEW-01 off (unset): the signals route withholds the terms, no preview field', async () => {
  const saved = process.env[PREVIEW_ENV];
  delete process.env[pricing.ACTIVITY_FLAG];
  delete process.env[PREVIEW_ENV];
  try {
    const body = await managersSignalsRoute(61);
    const busy = body.managers.find(m => m.roster_id === '2').receptiveness;
    const idle = body.managers.find(m => m.roster_id === '3').receptiveness;
    assert.equal(busy.value, idle.value);
    const f = routeFactor(body, '2', 'trade_activity');
    assert.equal(f.effect, null);
    assert.equal('preview' in f, false);
  } finally {
    if (saved !== undefined) process.env[PREVIEW_ENV] = saved;
  }
});
