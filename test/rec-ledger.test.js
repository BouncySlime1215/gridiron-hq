/**
 * The recommendation ledger (GR-01): record(), the grader at each horizon, and
 * the scheduler entry that runs it.
 *
 * Realised points come from `player_week_usage` scored by the league's own
 * rules (`actuals()` in backtest.js, `scoreLine`/`scoringFor` in scoring.js),
 * the same producer every backtest already uses. The fixture league carries no
 * ESPN scoring settings, so it scores on the PPR fallback: 0.1 a rushing yard,
 * 1 a reception. Numbers below are chosen so each expected score is exact.
 *
 * Every name below is made up. No league, manager or player in it is real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rec-ledger-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, row, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const ledger = await import('../server/services/rec-ledger.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026;
run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id)
     VALUES (61, 'espn', 'espn-ledger-61', ?, 'L61', ?, 6, '1')`, SEASON, JSON.stringify({ teams: [] }));
/** The league's own clock (leagues.current_week, ESPN currentMatchupPeriod). Every call below is for week 3. */
const clock = week => run('UPDATE leagues SET current_week = ? WHERE id = 61', week);
clock(3);
for (const [id, name, pos] of [[9101, 'Alpha Back', 'RB'], [9102, 'Beta Back', 'RB'],
  [9103, 'Gamma Back', 'RB'], [9104, 'Delta Back', 'RB'], [9105, 'Echo Back', 'RB'], [9106, 'Fox Back', 'RB']]) {
  run('INSERT INTO players (id, name, position) VALUES (?,?,?)', id, name, pos);
}
/** One weekly line worth exactly `pts` PPR points: rushing yards only. */
const usage = (playerId, week, pts) => run(
  `INSERT INTO player_week_usage (player_id, season, week, position, rushing_yards) VALUES (?,?,?,?,?)`,
  playerId, SEASON, week, 'RB', pts * 10);

const ledgerRows = (where = '1=1', ...p) => rows(
  `SELECT id, league_id, kind, disposition, season, week, horizon, inputs_hash, predicted_json,
          baseline_call_json, graded_at, outcome_json, score
   FROM rec_ledger WHERE ${where} ORDER BY kind, horizon, id`, ...p);

const tradeRec = (over = {}) => ({
  league_id: 61, kind: 'trade', season: SEASON, week: 3, source: 'find',
  inputs: { partner_id: '2', give: [9103], get: [9104] },
  predicted: { give: [{ id: 9103 }], get: [{ id: 9104 }], ppg_delta: 1.2 },
  baseline_call: { call: 'no_trade', keep: [9103] },
  ...over,
});
const lineupRec = {
  league_id: 61, kind: 'lineup', season: SEASON, week: 3, source: 'lineup',
  inputs: { starters: [['RB', 9101]], objective: 'mean' },
  predicted: { starters: [{ slot: 'RB', id: 9101, week_points: 14 }] },
  baseline_call: { call: 'bench_alternative', alternatives: [{ slot: 'RB', id: 9102, week_points: 12 }] },
};
const waiverRec = {
  league_id: 61, kind: 'waiver', season: SEASON, week: 3, source: 'waivers',
  inputs: { add: 9105, drop: 9106 },
  predicted: { add: { id: 9105, projected_ppg: 8 }, drop: { id: 9106 }, upgrade: 2.1 },
  baseline_call: { call: 'no_move', keep: [9106] },
};

// ------------------------------------------------------------------ record()
test('record() writes one row per horizon: a trade at +2 and +5 weeks, a lineup at +1', () => {
  const t = ledger.record(tradeRec());
  assert.equal(t.state, 'recorded');
  assert.equal(t.inserted, 2);
  const l = ledger.record(lineupRec);
  assert.equal(l.inserted, 1);
  const trade = ledgerRows(`kind = 'trade'`);
  assert.deepEqual(trade.map(r => r.horizon), [2, 5]);
  for (const r of trade) {
    assert.equal(r.league_id, 61);
    assert.equal(r.disposition, 'shown');
    assert.match(r.inputs_hash, /^[0-9a-f]{64}$/);
    assert.equal(r.graded_at, null);
    assert.equal(r.score, null);
    assert.deepEqual(JSON.parse(r.predicted_json).get, [{ id: 9104 }]);
    assert.equal(JSON.parse(r.baseline_call_json).call, 'no_trade');
  }
  assert.deepEqual(ledgerRows(`kind = 'lineup'`).map(r => r.horizon), [1]);
});

test('record() is idempotent: the same call on a page refresh adds no row', () => {
  const again = ledger.record(tradeRec());
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, 2);
  assert.equal(ledgerRows(`kind = 'trade'`).length, 2);
});

test('record() keys on the inputs: a different package hashes differently', () => {
  const a = ledger.inputsHash(tradeRec());
  const b = ledger.inputsHash(tradeRec({ inputs: { partner_id: '2', give: [9103], get: [9102] } }));
  const c = ledger.inputsHash(tradeRec({ predicted: { note: 'predictions are not inputs' } }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(a, c);
  // Key order inside the inputs is not a different call.
  assert.equal(ledger.inputsHash(tradeRec({ inputs: { get: [9104], give: [9103], partner_id: '2' } })), a);
});

test('record() refuses an unknown kind and a call with no week, and says why instead of throwing', () => {
  const bad = ledger.record({ ...lineupRec, kind: 'draft' });
  assert.equal(bad.state, 'invalid');
  assert.match(bad.reason, /kind/);
  const noWeek = ledger.record({ ...lineupRec, week: null, inputs: { x: 1 } });
  assert.equal(noWeek.state, 'no_week');
  assert.equal(ledgerRows(`kind = 'draft'`).length, 0);
  assert.equal(ledgerRows(`week IS NULL`).length, 0);
});

test('record() accepts a list, and a considered-not-shown row is kept apart from a shown one', () => {
  const out = ledger.record([
    tradeRec({ disposition: 'considered_not_shown', inputs: { partner_id: '3', give: [9101], get: [9106] },
      predicted: { give: [{ id: 9101 }], get: [{ id: 9106 }], failed: ['horizon_gain'] } }),
  ]);
  assert.equal(out.inserted, 2);
  assert.equal(ledgerRows(`disposition = 'considered_not_shown'`).length, 2);
  assert.equal(ledgerRows(`kind = 'trade' AND disposition = 'shown'`).length, 2);
});

test('a write that fails returns state error and leaves no partial row, instead of throwing into the page', () => {
  const before = ledgerRows().length;
  const warn = console.warn; const warned = [];
  console.warn = m => warned.push(String(m));
  try {
    const out = ledger.record({ ...tradeRec(), inputs: { bad: 1 }, predicted: { n: 10n } });
    assert.equal(out.state, 'error');
    assert.equal(out.inserted, 0);
  } finally { console.warn = warn; }
  assert.equal(ledgerRows().length, before);
  assert.match(warned.join('\n'), /rec-ledger/);
});

// ------------------------------------------------------------------ grader
test('the grader scores nothing before the weeks it needs have been played', () => {
  ledger.record(waiverRec);
  const out = ledger.gradeDue();
  assert.equal(out.graded, 0);
  assert.ok(out.pending >= 6, `expected every row pending, got ${JSON.stringify(out)}`);
  assert.equal(ledgerRows('graded_at IS NOT NULL').length, 0);
});

test('a Thursday line alone does not make week 3 played: the league clock still says week 3', () => {
  // Only the benched alternative has played (a Thursday game). The nflverse
  // usage writer has no completed-week filter, so a row can exist mid-week.
  usage(9102, 3, 5);
  const out = ledger.gradeDue();
  assert.equal(out.graded, 0, JSON.stringify(out));
  assert.equal(ledgerRows('graded_at IS NOT NULL').length, 0);
});

test('weekIsOver: a past season is over; the current week is not, including week 1', () => {
  assert.equal(ledger.weekIsOver({ season: 2026, current_week: 1 }, 2026, 1), false);
  assert.equal(ledger.weekIsOver({ season: 2026, current_week: 2 }, 2026, 1), true);
  assert.equal(ledger.weekIsOver({ season: 2026, current_week: 3 }, 2025, 17), true);
  assert.equal(ledger.weekIsOver({ season: 2025, current_week: 18 }, 2026, 1), false);
});

test('at +1 week the lineup call is graded against the benched alternative; trades wait', () => {
  clock(4);
  usage(9101, 3, 20);
  usage(9103, 3, 10); usage(9104, 3, 7);
  usage(9105, 3, 9); // 9106 did not play week 3: zero, not missing
  const out = ledger.gradeDue();
  assert.equal(out.graded, 1);
  const [l] = ledgerRows(`kind = 'lineup'`);
  assert.ok(l.graded_at);
  assert.equal(l.score, 15);
  const o = JSON.parse(l.outcome_json);
  assert.deepEqual(o.weeks, [3]);
  assert.equal(o.slots_won, 1);
  assert.equal(o.slots_lost, 0);
  assert.equal(o.called_points, 20);
  assert.equal(o.baseline_points, 5);
  assert.equal(ledgerRows(`kind = 'trade' AND graded_at IS NOT NULL`).length, 0);
});

test('at +2 weeks the trade and waiver calls are graded; the +5 rows stay open', () => {
  clock(5);
  usage(9103, 4, 6); usage(9104, 4, 12);
  usage(9105, 4, 3); usage(9106, 4, 4);
  usage(9101, 4, 1);
  const out = ledger.gradeDue();
  // shown trade h2, considered trade h2, waiver h2
  assert.equal(out.graded, 3);
  const [shown2] = ledgerRows(`kind = 'trade' AND disposition = 'shown' AND horizon = 2`);
  // got 9104: 7 + 12 = 19; gave 9103: 10 + 6 = 16
  assert.equal(shown2.score, 3);
  const so = JSON.parse(shown2.outcome_json);
  assert.deepEqual(so.weeks, [3, 4]);
  assert.equal(so.called_points, 19);
  assert.equal(so.baseline_points, 16);
  const [considered2] = ledgerRows(`kind = 'trade' AND disposition = 'considered_not_shown' AND horizon = 2`);
  // got 9106: 0 + 4 = 4; gave 9101: 20 + 1 = 21
  assert.equal(considered2.score, -17);
  const [w2] = ledgerRows(`kind = 'waiver' AND horizon = 2`);
  // added 9105: 9 + 3 = 12; dropped 9106: 0 + 4 = 4
  assert.equal(w2.score, 8);
  assert.equal(ledgerRows(`horizon = 5 AND graded_at IS NOT NULL`).length, 0);
});

test('at +5 weeks the trade is graded over weeks 3-7, and a second pass grades nothing twice', () => {
  clock(8);
  for (const w of [5, 6, 7]) { usage(9103, w, 2); usage(9104, w, 4); usage(9101, w, 1); usage(9105, w, 1); }
  const out = ledger.gradeDue();
  assert.equal(out.graded, 3);
  const [shown5] = ledgerRows(`kind = 'trade' AND disposition = 'shown' AND horizon = 5`);
  // got 9104: 7 + 12 + 12 = 31; gave 9103: 10 + 6 + 6 = 22
  assert.equal(shown5.score, 9);
  assert.deepEqual(JSON.parse(shown5.outcome_json).weeks, [3, 4, 5, 6, 7]);
  const [w5] = ledgerRows(`kind = 'waiver' AND horizon = 5`);
  // added 9105: 9 + 3 + 3 = 15; dropped 9106: 4
  assert.equal(w5.score, 11);
  assert.equal(ledger.gradeDue().graded, 0);
  assert.equal(ledgerRows('graded_at IS NULL').length, 0);
});

test('a week with no usage rows at all is not a played week, so a gap holds the grade', () => {
  ledger.record({ ...lineupRec, week: 9, inputs: { starters: [['RB', 9101]], objective: 'mean', w: 9 } });
  clock(11);
  usage(9101, 10, 5); // week 10 exists, week 9 does not
  assert.equal(ledger.gradeDue().graded, 0);
  assert.equal(ledgerRows(`kind = 'lineup' AND week = 9 AND graded_at IS NULL`).length, 1);
});

test('two slots with the same label (RB, RB) each pair with their own starter', () => {
  // bestLineup (trade-engine.js) pushes one { slot, player } per roster slot, so
  // a normal lineup has two 'RB' calls, and lineup-brain gives both the same
  // best benched back as `over`.
  ledger.record({ ...lineupRec, week: 12,
    inputs: { starters: [['RB', 9101], ['RB', 9103]], objective: 'mean' },
    predicted: { starters: [{ slot: 'RB', id: 9101 }, { slot: 'RB', id: 9103 }] },
    baseline_call: { call: 'bench_alternative',
      alternatives: [{ slot: 'RB', id: 9102 }, { slot: 'RB', id: 9102 }] } });
  clock(13);
  usage(9101, 12, 10); usage(9103, 12, 20); usage(9102, 12, 5);
  const out = ledger.gradeDue();
  assert.equal(out.graded, 1, JSON.stringify(out));
  const [l] = ledgerRows(`kind = 'lineup' AND week = 12`);
  const o = JSON.parse(l.outcome_json);
  assert.equal(o.slots_graded, 2);
  assert.deepEqual(o.slots.map(x => x.starter), [9101, 9103]);
  // (10 - 5) + (20 - 5) = 20; pairing both with the first RB would give 10.
  assert.equal(o.called_points, 30);
  assert.equal(o.baseline_points, 10);
  assert.equal(l.score, 20);
});

// ------------------------------------------------------------------ scheduler
test('the scheduler carries a grader job that runs gradeDue off the request thread', async () => {
  const { JOBS } = await import('../server/services/scheduler.js');
  const job = JOBS.rec_ledger_grade;
  assert.ok(job, 'JOBS.rec_ledger_grade must exist');
  assert.equal(job.offThread, true);
  usage(9101, 9, 30); usage(9102, 9, 1);
  const out = await job.run();
  assert.equal(out.graded, 1);
  const [l9] = ledgerRows(`kind = 'lineup' AND week = 9`);
  assert.equal(l9.score, 29);
});

// ------------------------------------------------------------------ migration 071 rollback
// The gate's full run found 071 had no down(): every test that walks the schema back
// (model-registry-persistence, migration-027-populated-upgrade) died on it. The ledger
// is frozen evidence, so down() refuses while rows exist and only drops an empty table.
// Rollback is last-in-first-out, and main has migrations numbered after 071 (073,
// FC-SNAP #170), so walk those back first; runMigrations() re-applies them.
async function unwindTo(name) {
  const { rollbackMigration } = await import('../server/db/migrate.js');
  const { LEGACY_SCHEMA_MIGRATION } = await import('../server/db/index.js');
  const latest = () => row('SELECT name FROM schema_migrations WHERE name <> ? ORDER BY rowid DESC LIMIT 1',
    LEGACY_SCHEMA_MIGRATION)?.name;
  for (let guard = 0; latest() && latest() !== name; guard++) {
    // A runaway-loop guard, not a claim about how many migrations follow 071: 20 was
    // exactly reached when 106 landed (E-XGB), which failed this test on a new file alone.
    assert.ok(guard < 200 && latest() > name, `cannot unwind to ${name}: latest is ${latest()}`);
    await rollbackMigration(latest());
  }
  assert.equal(latest(), name);
}

test('071 down() refuses while the ledger holds rows, and names the row count', async () => {
  const { rollbackMigration } = await import('../server/db/migrate.js');
  const n = row('SELECT COUNT(*) AS n FROM rec_ledger').n;
  assert.ok(n > 0, 'fixture ledger is populated by the tests above');
  await unwindTo('071_rec_ledger');
  await assert.rejects(rollbackMigration('071_rec_ledger'), new RegExp(`rollback refused: ${n} rec_ledger row`));
  assert.equal(row('SELECT COUNT(*) AS n FROM rec_ledger').n, n, 'a refused rollback deletes nothing');
  assert.ok(row(`SELECT 1 AS ok FROM schema_migrations WHERE name = '071_rec_ledger'`), 'still recorded as applied');
});

test('071 down() on an empty ledger drops the table and both indexes, and up() restores them', async () => {
  const { rollbackMigration } = await import('../server/db/migrate.js');
  run('DELETE FROM rec_ledger');
  await unwindTo('071_rec_ledger');
  assert.equal(await rollbackMigration('071_rec_ledger'), '071_rec_ledger');
  for (const name of ['rec_ledger', 'idx_rec_ledger_identity', 'idx_rec_ledger_ungraded']) {
    assert.equal(row('SELECT name FROM sqlite_master WHERE name = ?', name), undefined, `${name} dropped`);
  }
  await runMigrations();
  for (const name of ['rec_ledger', 'idx_rec_ledger_identity', 'idx_rec_ledger_ungraded']) {
    assert.ok(row('SELECT name FROM sqlite_master WHERE name = ?', name), `${name} restored`);
  }
});
