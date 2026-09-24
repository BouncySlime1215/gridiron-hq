/**
 * TELLS-01b engine side: the spine adapters that give refitTells its input, producer
 * 'tells' (tells.card, tells.prior_trades, tells.checkout_risk), and the read-only,
 * members-only card route.
 *
 *  (1) one writer: only producer 'tells' writes tells.* (grep and runtime)
 *  (2) every card entry has n, outcome, q and as_of; a tell missing from the screen is
 *      `unproven`, never a neutral
 *  (4) no this-season tell id, card or checkout field reaches an acceptanceBand input
 *  (5) a card read as of a time before a new event does not change
 *  plus: the adapters, prior trades (ESPN counter first), the 403 for a non-member, and a
 *  route that computes nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-tells-producer-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_CHAT_DB_PATH = path.join(temp, 'no-chat.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const { db, row, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const backfill = await import('../server/services/engine/backfill.js');
const events = await import('../server/services/engine/events.js');
const registry = await import('../server/services/engine/registry.js');
const state = await import('../server/services/engine/state.js');
const producer = await import('../server/services/tells/producer.js');
const { loadScreen } = await import('../server/services/tells/refit.js');
const { computeAllTells } = await import('../server/services/tells/library.js');
const { teamCounterEvents } = await import('../server/services/league-history.js');
const { hashSessionToken } = await import('../server/platform/auth.js');
const { legacyAuthenticated } = await import('../server/platform/legacy-access.js');
const { default: tellsRouter } = await import('../server/routes/tells.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { NOT_RUN_REASON } = await import('../server/services/tells/card.js');
const express = (await import('express')).default;

const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const LG = 71;
const SEASON = 2026;
const iso = (day, hour = 12) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();

run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count)
     VALUES (?, 'espn', 'espn-tp-71', ?, 'TP', '{"teams":[]}', 4)`, LG, SEASON);
run(`INSERT INTO leagues (id, platform, league_id, season, name, payload, team_count)
     VALUES (72, 'espn', 'espn-tp-72', ?, 'TQ', '{"teams":[]}', 4)`, SEASON);

let n = 0;
function tx({ season = SEASON, type, status = 'EXECUTED', exec = 'PROCESS', team, period, items, day, related = null, id = null }) {
  n += 1;
  run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, execution_type, proposed_at,
       processed_at, team_id, related_tx_id, scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  LG, season, id ?? `tp-${n}`, type, status, exec, iso(day, 10), exec === 'EXECUTE' ? null : iso(day), team, related,
  period, items == null ? null : JSON.stringify(items), iso(day), iso(day));
  return id ?? `tp-${n}`;
}
const addItems = (team, p) => [{ type: 'ADD', fromTeamId: 0, toTeamId: team, playerId: p }, { type: 'DROP', fromTeamId: team, toTeamId: 0, playerId: p + 5000 }];

// 2025: one processed trade between teams 1 and 2 (the previous season's record).
tx({ season: 2025, type: 'TRADE_ACCEPT', team: 1, period: 5, day: -300,
  items: [{ type: 'TRADE', fromTeamId: 1, toTeamId: 2, playerId: 11 }, { type: 'TRADE', fromTeamId: 2, toTeamId: 1, playerId: 12 }] });
tx({ season: 2025, type: 'FREEAGENT', team: 4, period: 6, day: -290, items: addItems(4, 13) });
// 2026, weeks 1-3: pickups, a failed claim, and a few answered offers for the clone.
for (let w = 1; w <= 3; w += 1) for (const t of [1, 2, 3, 4]) tx({ type: 'FREEAGENT', team: t, period: w, day: w * 7, items: addItems(t, 100 * w + t) });
tx({ type: 'WAIVER', status: 'FAILED_INVALIDPLAYERSOURCE', team: 3, period: 2, day: 14, items: addItems(3, 999) });
for (let k = 0; k < 4; k += 1) {
  const p = tx({ type: 'TRADE_PROPOSAL', exec: 'EXECUTE', status: 'PENDING', team: 1, period: 2, day: 8 + k,
    items: [{ type: 'TRADE', fromTeamId: 1, toTeamId: 2 + (k % 3), playerId: 700 + k }] });
  tx({ type: k % 2 ? 'TRADE_ACCEPT' : 'TRADE_DECLINE', exec: 'EXECUTE', status: 'EXECUTED', team: 2 + (k % 3), period: 2, day: 9 + k, related: p });
}
for (let w = 1; w <= 3; w += 1) {
  for (const [a, b] of [[1, 2], [3, 4]]) {
    for (const [t, o] of [[a, b], [b, a]]) {
      run(`INSERT INTO league_week_scores (league_id, season, week, roster_id, points, opponent_roster_id, is_playoff, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`, LG, SEASON, w, String(t), 90 + t * w, String(o), iso(w * 7 + 2));
    }
  }
}

function account(subject, token) {
  run(`INSERT INTO users (subject, display_name) VALUES (?, ?)`, subject, subject);
  const id = row('SELECT last_insert_rowid() AS id').id;
  run(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (?,?,datetime('now','+1 day'))`, id, hashSessionToken(token));
  return id;
}
const member = account('member', 'member-token');
account('outsider', 'outsider-token');
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'member')`, LG, member);

const app = express();
app.use('/api/tells', ...legacyAuthenticated, tellsRouter);
app.use((err, _req, res, _next) => res.status(Number.isInteger(err.status) ? err.status : 500).json({ error: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/tells`;
const as = token => ({ headers: { Authorization: `Bearer ${token}` } });

test.after(() => { server.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const leagues = [{ leagueId: LG, season: SEASON }];
const T1 = iso(30);
const T2 = iso(31);

// ------------------------------------------------------------------ adapters
test('adapters: ESPN raw moves become league.transaction events in the tell library shape; a re-run appends nothing', () => {
  const first = backfill.backfillStream('tells_transactions', { database: db });
  assert.equal(first.table_state, 'present');
  const evs = events.getEvents({ asOf: iso(60), leagueId: LG, types: ['league.transaction'], limit: 1000 }, db);
  assert.equal(evs.length, first.inserted);
  const trade = evs.find(e => e.payload.type === 'trade');
  assert.deepEqual(trade.payload.roster_ids, [1, 2]);
  assert.equal(trade.payload.season, 2025);
  assert.deepEqual(trade.payload.adds, { 11: 2, 12: 1 });
  const failed = evs.find(e => e.payload.type === 'waiver');
  assert.equal(failed.payload.status, 'failed');
  assert.equal(failed.payload.latency_ms, null, 'ESPN has no claim latency: absent, never 0');
  assert.ok(!evs.some(e => e.payload.tx_id && /TRADE_PROPOSAL/.test(e.payload.type)), 'a proposal is not a move');
  assert.equal(backfill.backfillStream('tells_transactions', { database: db }).inserted, 0, 'compare-latest');
  // The spine's own espn.transaction stream keeps its own keys: no collision on the same table.
  const spine = backfill.backfillStream('transactions', { database: db });
  assert.ok(spine.inserted > 0);
  assert.equal(backfill.backfillStream('tells_transactions', { database: db }).inserted, 0);
});

test('adapters: league_week_scores become league.team_week events and refitTells\' library reads both', () => {
  const r = backfill.backfillStream('tells_team_weeks', { database: db });
  assert.equal(r.inserted, 12);
  const evs = events.getEvents({ asOf: iso(60), leagueId: LG, types: ['league.transaction', 'league.team_week'], limit: 1000 }, db);
  const week = evs.find(e => e.event_type === 'league.team_week');
  assert.equal(week.payload.lineup, 'no_final_snapshot', 'no final lineup captured: said so, not an empty lineup');
  const cur = evs.filter(e => e.payload.season === SEASON);
  const tells = computeAllTells(cur, { asOf: iso(60), leagueId: LG });
  assert.deepEqual([...tells.keys()].sort(), [1, 2, 3, 4], 'the library scores every roster from the adapted events');
});

test('saveTeams\' counter: transactionCounter.trades becomes a league.team_counter event; a team without one emits nothing', () => {
  const evs = teamCounterEvents({ id: LG }, 2025, { teams: [{ id: 3, transactionCounter: { trades: 2, acquisitions: 9, drops: 8 } }, { id: 4 }] },
    { capturedAt: iso(1) });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].payload.trades, 2);
  events.appendEvents(evs, { database: db });
});

// ------------------------------------------------------------------ producer
test('RED (1): only producer tells writes tells.* — by grep and at runtime', () => {
  const walk = dir => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : /\.(m?js)$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const files = [...walk('server'), ...walk('scripts')];
  const claims = files.filter(f => /field:\s*['"]tells\./.test(read(f)) || /registerField\(\s*['"]tells\./.test(read(f)));
  assert.deepEqual(claims, ['server/services/tells/producer.js']);
  assert.deepEqual(files.filter(f => /registerProducer\(\s*\{\s*name:\s*['"]tells['"]/.test(read(f))), ['server/services/tells/producer.js']);
  assert.throws(() => registry.registerProducer({ name: 'intruder', active: '1', versions: { 1: {} },
    fields: [{ field: 'tells.card', entityTypes: ['league'] }] }), /one producer tells/);
  assert.throws(() => state.writeState({ entityType: 'league', entityId: String(LG), leagueId: LG, field: 'tells.card',
    value: {}, asOf: T1, writer: { field: 'tells.card', producer: 'tells' }, producerVersion: '1',
    reasonChain: { contributions: [] } }, db), /one writer per field/);
});

test('RED (2): every card entry has n, outcome, q and as_of; a tell missing from the screen is unproven', async () => {
  const out = await producer.runTellsProducer({ database: db, asOf: T1, leagues, refitEnabled: true });
  assert.equal(out[0].league_id, LG);
  const card = state.getState('league', String(LG), 'tells.card', { asOf: T1, leagueId: LG }, db);
  assert.ok(card, 'the card is stored');
  assert.equal(card.producer, 'tells');
  assert.ok(card.value.managers.length >= 4);
  const entries = card.value.managers.flatMap(m => m.tells);
  assert.ok(entries.some(e => e.kind === 'screen') && entries.some(e => e.kind === 'clone'));
  for (const e of entries) {
    for (const k of ['n', 'outcome', 'q', 'as_of', 'verdict']) assert.ok(Object.hasOwn(e, k), `${e.id} lacks ${k}`);
    assert.equal(e.as_of, T1);
  }
  const screen = loadScreen();
  const byId = new Map(screen.tells.map(s => [s.id, s]));
  const missing = producer.screenEntry({ tell_id: 'NOT_A_TELL|x|w13', value: 0, shrunk: 0, n_weeks: 3, outcome: 'adds' }, byId, T1);
  assert.equal(missing.verdict, 'unproven');
  assert.equal(missing.status, 'unproven');
  assert.equal(missing.direction, 'unproven', 'never a neutral');
  assert.match(missing.reason, /not in the TELLS-01a screen/);
  // A clone feature is not a screen tell either: unproven until E1 passes.
  assert.ok(entries.filter(e => e.kind === 'clone').every(e => e.verdict === 'unproven'));
});

test('prior trades: the ESPN counter first, then last season\'s completed trades; checkout risk says why when absent', () => {
  const get = (team, field) => state.getState('league_team', `${LG}:${team}`, field, { asOf: T1, leagueId: LG }, db);
  assert.deepEqual([1, 2, 3, 4].map(t => [get(t, 'tells.prior_trades').value.trades, get(t, 'tells.prior_trades').value.source]),
    [[1, 'league_transactions'], [1, 'league_transactions'], [2, 'espn_transaction_counter'], [0, 'league_transactions']]);
  assert.equal(get(3, 'tells.prior_trades').value.verdict, 'lead');
  for (const t of [1, 2, 3, 4]) {
    const c = get(t, 'tells.checkout_risk');
    assert.ok(c, `checkout_risk row for team ${t}`);
    if (c.value == null) assert.ok(c.health.absence.reason.length > 10);
    else assert.ok(c.value.tells.every(x => x.outcome === 'checkout' && x.verdict === 'confirmed'));
  }
});

test('RED (5): a card read as of a time before a new event does not change', async () => {
  const before = state.getState('league', String(LG), 'tells.card', { asOf: T1, leagueId: LG }, db);
  tx({ type: 'FREEAGENT', team: 2, period: 4, day: 30, items: addItems(2, 4444) });
  run(`UPDATE league_transactions_raw SET processed_at = ? WHERE tx_id = ?`, iso(30, 18), `tp-${n}`);
  backfill.backfillStream('tells_transactions', { database: db });
  await producer.runTellsProducer({ database: db, asOf: T2, leagues, refitEnabled: true });
  const again = state.getState('league', String(LG), 'tells.card', { asOf: T1, leagueId: LG }, db);
  assert.equal(again.id, before.id);
  assert.deepEqual(again.value, before.value);
  const later = state.getState('league', String(LG), 'tells.card', { asOf: T2, leagueId: LG }, db);
  assert.equal(later.as_of, T2);
  // Re-running at the same as_of writes nothing new (write-on-change).
  const rerun = await producer.runTellsProducer({ database: db, asOf: T2, leagues, refitEnabled: true });
  assert.equal(rerun[0].rows_written, 0);
});

test('RED (4): no this-season tell, card or checkout field reaches an acceptanceBand input (grep)', () => {
  const thisSeason = loadScreen().tells.filter(t => !t.id.startsWith('PREV|')).map(t => t.id);
  for (const f of ['server/services/trade-acceptance.js', 'server/services/counterparty-pricing.js', 'server/services/trade-engine.js']) {
    const src = read(f);
    for (const id of thisSeason) assert.ok(!src.includes(id), `${f} names this-season tell ${id}`);
    assert.doesNotMatch(src, /tells\.card|tells\.checkout_risk|checkout_risk/, f);
    assert.doesNotMatch(src, /from ['"][^'"]*tells\//, `${f} imports a tells module`);
  }
  assert.deepEqual([...read('server/services/counterparty-pricing.js').matchAll(/'tells\.[a-z_]+'/g)].map(m => m[0]),
    ["'tells.prior_trades'"], 'the pricing layer reads the prior-trades count and nothing else of the tells');
});

// ------------------------------------------------------------------ route
test('route: a non-member gets 403; a member gets the stored card with its as_of; nothing is computed on the request', async () => {
  const prev = process.env[PREVIEW_ENV];
  process.env[PREVIEW_ENV] = '1';
  try {
    assert.equal((await fetch(`${base}/${LG}/card`, as('outsider-token'))).status, 403);
    assert.equal((await fetch(`${base}/${LG}/card`)).status, 401);
    const res = await fetch(`${base}/${LG}/card?as_of=${encodeURIComponent(T1)}`, as('member-token'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.preview, true);
    assert.equal(body.as_of, T1);
    assert.equal(body.card.league_id, LG);
    assert.ok(body.grade.clone);
    run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (?, ?, 'member')`, 72, member);
    const none = await (await fetch(`${base}/72/card`, as('member-token'))).json();
    assert.equal(none.card, null);
    assert.equal(none.reason, NOT_RUN_REASON);
  } finally {
    if (prev == null) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = prev;
  }
  for (const f of ['server/routes/tells.js', 'server/services/tells/card.js']) {
    assert.doesNotMatch(read(f), /from ['"][^'"]*(clone-features|producer|refit|library)(\.js)?['"]/, `${f} imports a compute module`);
    assert.doesNotMatch(read(f), /\b(refitTells|gradeClone|tellsCard|loadCloneContext|writeState)\(/, `${f} computes or writes`);
  }
});

test('as of the card: an offer answered after as_of is not graded (runs last: it writes an earlier card)', async () => {
  // Offers are proposed on days 8-11 at 10:00 and answered a day later. As of day 10 00:00 only
  // the first has an answer; the second was proposed but not yet decided.
  const early = iso(10, 0);
  await producer.runTellsProducer({ database: db, asOf: early, leagues, refitEnabled: false });
  const card = state.getState('league', String(LG), 'tells.card', { asOf: early, leagueId: LG }, db);
  assert.equal(card.as_of, early);
  assert.equal(card.value.grade.clone.n, 1);
  assert.match(card.value.screen.reason, /GRIDIRON_TELLS_ENABLED/);
});
