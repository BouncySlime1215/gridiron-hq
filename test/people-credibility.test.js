/**
 * CRED-01: per-manager credibility (server/services/people/credibility.js).
 *
 * Synthetic league only: no names, no chat text. Checks the four things the
 * weights stand on: the follow-through counts (a port of the PEOPLE-LAB method),
 * the as-of cut (nothing after the cut is read), the status/weight rules
 * (quiet = unknown, never neutral; a per-manager split; a zero-hit cell is not
 * "proven"), and the as-of reader over the stored table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

process.env.SCHEDULER_DISABLED = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-cred-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const cred = await import('../server/services/people/credibility.js');

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const DAY = 86_400_000;
const T0 = Date.parse('2026-08-01T00:00:00Z');
const at = d => new Date(T0 + d * DAY).toISOString();

/** A league of 3 rosters x 10 players (ids r*100 + i), drafted at day 0. */
function draftRows() {
  const items = [];
  for (const team of [1, 2, 3]) for (let i = 0; i < 10; i++) items.push({ type: 'DRAFT', playerId: team * 100 + i, toTeamId: team });
  return [{ type: 'DRAFT', status: 'EXECUTED', proposed_at: at(0), processed_at: null, team_id: null, tx_id: 'd', related_tx_id: null, items_json: JSON.stringify(items) }];
}
const trade = (id, d, pairs) => ({
  type: 'TRADE_ACCEPT', status: 'EXECUTED', proposed_at: at(d), processed_at: at(d), team_id: pairs[0][1], tx_id: id, related_tx_id: null,
  items_json: JSON.stringify(pairs.map(([playerId, fromTeamId, toTeamId]) => ({ type: 'TRADE', playerId, fromTeamId, toTeamId }))),
});
const addDrop = (id, d, add, drop, team) => ({
  type: 'FREEAGENT', status: 'EXECUTED', proposed_at: at(d), processed_at: at(d), team_id: team, tx_id: id, related_tx_id: null,
  items_json: JSON.stringify([{ type: 'ADD', playerId: add, toTeamId: team }, { type: 'DROP', playerId: drop, fromTeamId: team }]),
});

test('actions: the draft, a trade and an add/drop replay to the right rosters, as of any time', () => {
  const a = cred.buildActions([...draftRows(), trade('t1', 5, [[201, 2, 1], [101, 1, 2]]), addDrop('f1', 6, 999, 102, 1), trade('t1dup', 5, [[101, 1, 2], [201, 2, 1]])]);
  assert.equal(a.moves.filter(m => m.kind === 'trade').length, 2, 'the duplicate accept is not replayed twice');
  const before = cred.rosterAt(a.moves, T0 + 4 * DAY);
  assert.ok(before.get(1).has(101) && !before.get(1).has(201));
  const after = cred.rosterAt(a.moves, T0 + 7 * DAY);
  assert.ok(after.get(1).has(201) && after.get(1).has(999) && !after.get(1).has(101) && !after.get(1).has(102));
  assert.equal(a.leagueStart, T0);
  assert.equal(a.dataEnd, T0 + 6 * DAY);
});

test('WANT_PLAYER: acquiring the named player inside the window is a hit, against every other player on another roster', () => {
  const a = cred.buildActions([...draftRows(), trade('t1', 3, [[201, 2, 1], [101, 1, 2]]), addDrop('f1', 30, 999, 109, 3)]);
  const s = [{ spk: 1, t: T0 + 1 * DAY, type: 'WANT_PLAYER', players: [201] }];
  const { counts } = cred.followThrough(s, a, { windowsDays: [7] });
  const [hits, n, bh, bn] = counts.WANT_PLAYER[7].groups.get(1);
  assert.equal(hits, 1); assert.equal(n, 1);
  assert.equal(bn, 20, 'baseline = the 20 players on the other two rosters');
  assert.equal(bh, 0, "the named player's own hit is left out of the baseline numerator");
});

test('as-of: an action after the cut is not a hit, and a window that ends after the cut is not graded', () => {
  const rows = [...draftRows(), trade('t1', 10, [[201, 2, 1], [101, 1, 2]]), addDrop('f1', 40, 999, 109, 3)];
  const a = cred.buildActions(rows);
  const s = [{ spk: 1, t: T0 + 5 * DAY, type: 'WANT_PLAYER', players: [201] }];
  const full = cred.followThrough(s, a, { windowsDays: [7] });
  assert.equal(full.counts.WANT_PLAYER[7].groups.get(1)[0], 1, 'with the whole record the acquisition on day 10 is a hit');
  const cut = cred.followThrough(s, a, { windowsDays: [7], asOf: T0 + 9 * DAY });
  assert.equal(cut.counts.WANT_PLAYER[7].n, 0, 'as of day 9 the day-5 statement still has an open window: not graded');
  assert.ok(cut.asOf <= T0 + 9 * DAY, 'the run is stamped at or before the cut');
});

test('own-player talk: SHOP followed by that player leaving is a hit; the rest of his roster is the base', () => {
  const a = cred.buildActions([...draftRows(), trade('t1', 2, [[101, 1, 2], [201, 2, 1]]), addDrop('f1', 40, 999, 109, 3)]);
  const s = [{ spk: 1, t: T0 + 1 * DAY, type: 'SHOP', players: [101] }, { spk: 1, t: T0 + 1 * DAY, type: 'SHOP', players: [205] }];
  const g = cred.followThrough(s, a, { windowsDays: [7] }).counts.SHOP[7];
  assert.equal(g.n, 1, 'a player he does not own is not his own-player talk');
  assert.deepEqual(g.groups.get(1), [1, 1, 0, 9]);
});

test('binomial two-sided p matches known values', () => {
  const p0 = cred.binomialTwoSided(0, 31, 0.14);
  assert.ok(p0 >= 0.86 ** 31 && p0 < 0.05, '0 of 31 at a 14% base is a real miss (the lab\'s 0.0x SHOP roster)');
  assert.equal(cred.binomialTwoSided(5, 10, 0.5), 1);
  assert.ok(cred.binomialTwoSided(10, 11, 0.47) < 0.01);
});

test('status: quiet is unknown (null weight), a lone strong manager is a split, a zero-hit cell is not proven', () => {
  const groups = new Map([[1, [0, 31, 140, 1000]], [2, [10, 11, 470, 1000]], [3, [1, 2, 200, 1000]]]);
  const rows = cred.shrinkGroup('SHOP', 7, { n: 44, groups }, [1, 2, 3, 4]);
  const by = Object.fromEntries(rows.map(r => [r.roster_id, r]));
  assert.equal(by['4'].status, 'unknown'); assert.equal(by['4'].weight, null);
  assert.equal(by['1'].status, 'manager_split'); assert.ok(by['1'].weight < 0.5, 'his shop talk is discounted');
  assert.equal(by['2'].status, 'manager_split'); assert.ok(by['2'].weight > 1.3, 'his shop talk is credible');
  assert.equal(by['3'].status, 'noise'); assert.equal(by['3'].weight, 1);
  assert.ok(by['2'].weight < by['2'].lift_raw, 'shrunk toward the league');

  const zero = new Map([[1, [0, 4, 10, 100]], [2, [0, 4, 10, 100]], [3, [0, 3, 10, 100]]]);
  const league = cred.shrinkGroup('HYPE_OWN', 21, { n: 11, groups: zero }, [1, 2, 3]).find(r => r.roster_id === '*');
  assert.deepEqual([league.league_ci_lo, league.league_ci_hi], [0, 0]);
  assert.equal(league.status, 'noise', '0 of 11 against a 10% base is not proof of anything');
});

test('proven: a pooled lift that clears the bar weights every talking manager by his shrunk lift', () => {
  const groups = new Map([[1, [8, 38, 55, 5306]], [2, [3, 7, 44, 1009]], [3, [2, 6, 10, 846]], [4, [1, 3, 2, 400]]]);
  const rows = cred.shrinkGroup('WANT_PLAYER', 7, { n: 54, groups }, [1, 2, 3, 4, 5]);
  const league = rows.find(r => r.roster_id === '*');
  assert.equal(league.status, 'proven');
  assert.ok(league.league_ci_lo > 1);
  for (const r of rows.filter(x => ['1', '2', '3', '4'].includes(x.roster_id))) { assert.equal(r.status, 'proven'); assert.ok(r.weight > 1); }
  assert.equal(rows.find(r => r.roster_id === '5').weight, null);
});

test('stored runs are read as of a cut: a backtest at T never sees the later run', () => {
  const mk = (asOf, w) => ({ as_of: asOf, method_version: cred.METHOD_VERSION, rows: [{
    roster_id: '2', stmt_type: 'SHOP', window_days: 7, outcome: 'left_roster', n_statements: 11, status: 'manager_split', weight: w,
  }] });
  cred.storeCredibility(db, 4, mk('2026-09-10T00:00:00Z', 1.5));
  cred.storeCredibility(db, 4, mk('2026-09-20T00:00:00Z', 1.8));
  cred.storeCredibility(db, 4, mk('2026-09-20T00:00:00Z', 1.9)); // same run again: an upsert, not a second row
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people_credibility WHERE league_id = 4').get().n, 2);
  const latest = cred.readCredibility(db, 4);
  assert.equal(latest.as_of, '2026-09-20T00:00:00Z');
  assert.equal(cred.statementWeight(latest, 2, 'SHOP'), 1.9);
  const then = cred.readCredibility(db, 4, { asOf: '2026-09-15T00:00:00Z' });
  assert.equal(cred.statementWeight(then, 2, 'SHOP'), 1.5);
  assert.equal(cred.statementWeight(then, 9, 'SHOP'), null, 'a roster with no row is unknown');
  assert.equal(cred.readCredibility(db, 4, { asOf: '2026-09-01T00:00:00Z' }), null);
});

test('labels: speaker and time come from the chat DB by id; other-league and duplicate labels are dropped', () => {
  const chat = new DatabaseSync(':memory:');
  chat.exec(`CREATE TABLE messages (msg_id INTEGER, name TEXT, is_from_me INTEGER, ts_utc TEXT, is_tapback INTEGER, text TEXT)`);
  const ins = chat.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(1, 'a', 0, '2026-08-02T10:00:00', 0, 'x'); ins.run(2, 'b', 0, '2026-08-02T11:00:00', 0, 'x');
  ins.run(3, null, 1, '2026-08-02T12:00:00', 0, 'x'); ins.run(4, 'zz', 0, '2026-08-02T13:00:00', 0, 'x');
  const recs = [
    { msg_id: 1, type: 'WANT_PLAYER', players: [201], league_ref: 'unclear' },
    { msg_id: 1, type: 'WANT_PLAYER', players: [201], league_ref: 'unclear' },
    { msg_id: 2, type: 'SHOP', players: [205], league_ref: 'other' },
    { msg_id: 3, type: 'SHOP', players: [101], league_ref: 'L4' },
    { msg_id: 4, type: 'SHOP', players: [101], league_ref: 'L4' },
    { msg_id: 99, type: 'SHOP', players: [101], league_ref: 'L4' },
  ];
  const s = cred.statementsFromLabels(recs, chat, (name, me) => (me ? 5 : ({ a: 1, b: 2 })[name] ?? null));
  assert.deepEqual(s.map(x => [x.spk, x.type]), [[1, 'WANT_PLAYER'], [5, 'SHOP']]);
  assert.equal(s[0].t, Date.parse('2026-08-02T10:00:00Z'));
  assert.ok(!('text' in s[0]), 'no message text travels with a statement');
});

test('computeCredibility: one row per type x window for the league and every roster, stamped with the data cut', () => {
  const a = cred.buildActions([...draftRows(), trade('t1', 3, [[201, 2, 1], [101, 1, 2]]), addDrop('f1', 60, 999, 109, 3)]);
  const s = [{ spk: 1, t: T0 + 1 * DAY, type: 'WANT_PLAYER', players: [201] }, { spk: 5, t: T0 + 1 * DAY, type: 'WANT_PLAYER', players: [202] }];
  const run = cred.computeCredibility(s, a, { rosters: [1, 2, 3], excludeSpeakers: [5] });
  const types = Object.keys(cred.STATEMENT_TYPES).length;
  assert.equal(run.rows.length, types * cred.WINDOWS_DAYS.length * 4);
  assert.equal(run.as_of, new Date(T0 + 60 * DAY).toISOString().slice(0, 19) + 'Z');
  const want = run.rows.find(r => r.stmt_type === 'WANT_PLAYER' && r.window_days === 7 && r.roster_id === '*');
  assert.equal(want.league_n, 1, "Nick's own statements are not graded");
  assert.equal(run.rows.find(r => r.stmt_type === 'WANT_PLAYER' && r.window_days === 7 && r.roster_id === '2').status, 'unknown');
});

test('PULSE-01 adapter: a graded manager gives {lift, n}; unknown gives null so PULSE falls back to its priors', () => {
  const c = { as_of: '2026-09-20T00:00:00Z', rosters: {
    1: { SHOP: { 7: { status: 'manager_split', weight: 0.33, n_statements: 31 } } },
    2: { SHOP: { 7: { status: 'noise', weight: 1, n_statements: 3 } }, WANT_PLAYER: { 7: { status: 'unknown', weight: null, n_statements: 0 } } },
  } };
  const f = cred.pulseCredibility(c);
  assert.deepEqual({ lift: f(1, 'SHOP').lift, n: f(1, 'SHOP').n }, { lift: 0.33, n: 31 });
  assert.equal(f(2, 'SHOP').lift, 1, 'noise moves nothing, and is not credible');
  assert.equal(f(2, 'WANT_PLAYER'), null);
  assert.equal(f(3, 'SHOP'), null);
  assert.equal(f(1, 'HYPE'), null, 'bare HYPE is ambiguous (own vs other player)');
  assert.equal(cred.pulseCredibility(null)(1, 'SHOP'), null);
});

