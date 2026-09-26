/**
 * SELL-HIGH FILTER (batch D item 12): TD rate above expected TD rate by > 1pp flags a sell-high
 * candidate on Nick's roster. A label, weight 0; shadow behind GRIDIRON_SELL_HIGH, graded weekly.
 *
 * Fixtures only: made-up players, ids and numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { sellHighFlag, sellHighSummary, sellHighEnabled, gradeSellHigh, opportunitiesOf,
  SELL_HIGH_ENV, SELL_HIGH_RULE, SELL_HIGH_PASS_BAR } = await import('../server/services/campaign/sell-high.js');
const { readTdWeeks, readSellHighInputs } = await import('../server/services/campaign/sell-high-inputs.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

/** n weeks of identical rows: tds and xtd per week, opportunities per week. */
const weeks = (n, { tds, xtd, opp, from = 1 }) =>
  Array.from({ length: n }, (_, i) => ({ week: from + i, tds, xtd, opportunities: opp }));

test('flag is off by default; only "1" turns it on', () => {
  assert.equal(SELL_HIGH_ENV, 'GRIDIRON_SELL_HIGH');
  assert.equal(sellHighEnabled({}), false);
  assert.equal(sellHighEnabled({ GRIDIRON_SELL_HIGH: '0' }), false);
  assert.equal(sellHighEnabled({ GRIDIRON_SELL_HIGH: 'on' }), false);
  assert.equal(sellHighEnabled({ GRIDIRON_SELL_HIGH: '1' }), true);
});

test('rule: TD rate above expected by more than 1pp flags; exactly 1pp does not', () => {
  // 4 weeks x 10 opportunities = 40; 2 TDs vs 1.2 expected -> 5.0% vs 3.0% = +2pp.
  const hot = sellHighFlag({ player: 7, position: 'WR', rows: weeks(4, { tds: 0.5, xtd: 0.3, opp: 10 }) });
  assert.equal(hot.status, 'flagged');
  assert.equal(hot.gap, 0.02);
  assert.match(hot.basis, /TD rate 5\.0pp vs expected 3\.0pp on 40 opportunities/);
  assert.match(hot.basis, /weight 0/);
  // 2 TDs vs 1.6 expected on 40 -> exactly +1pp: not above the bar.
  const edge = sellHighFlag({ player: 7, position: 'WR', rows: weeks(4, { tds: 0.5, xtd: 0.4, opp: 10 }) });
  assert.equal(edge.status, 'not_flagged');
  const cold = sellHighFlag({ player: 7, position: 'RB', rows: weeks(4, { tds: 0, xtd: 0.5, opp: 15 }) });
  assert.equal(cold.status, 'not_flagged');
  assert.ok(cold.gap < 0);
});

test('rule: too few games, too few opportunities, or a non-skill position is unrated, with the reason', () => {
  const oneGame = sellHighFlag({ player: 1, position: 'WR', rows: weeks(1, { tds: 2, xtd: 0.2, opp: 30 }) });
  assert.equal(oneGame.status, 'unrated');
  assert.match(oneGame.basis, /1 games/);
  const thin = sellHighFlag({ player: 1, position: 'TE', rows: weeks(3, { tds: 1, xtd: 0.1, opp: 5 }) });
  assert.equal(thin.status, 'unrated');
  assert.match(thin.basis, /15 opportunities, fewer than 20/);
  assert.equal(sellHighFlag({ player: 1, position: 'K', rows: weeks(4, { tds: 1, xtd: 0, opp: 10 }) }).status, 'unrated');
});

test('rule: a week with no expected-TD read is dropped whole (one denominator for both rates)', () => {
  const rows = [...weeks(3, { tds: 0, xtd: 0.3, opp: 10 }), { week: 4, tds: 3, xtd: null, opportunities: 10 }];
  const f = sellHighFlag({ player: 1, position: 'WR', rows });
  assert.equal(f.opportunities, 30);
  assert.equal(f.status, 'not_flagged', 'the 3 TDs in the unread week never count');
});

test('opportunities: QB pass attempts + carries; skill players carries + targets', () => {
  assert.equal(opportunitiesOf('QB', { attempts: 30, carries: 4, targets: 1 }), 34);
  assert.equal(opportunitiesOf('WR', { attempts: 1, carries: 2, targets: 8 }), 10);
  assert.equal(opportunitiesOf('RB', { carries: null, targets: 3 }), 3);
});

test('weight 0: the flag never reads value, price or projection fields', () => {
  const base = { player: 1, position: 'WR', rows: weeks(4, { tds: 0.5, xtd: 0.3, opp: 10 }) };
  const a = sellHighFlag(base);
  const b = sellHighFlag({ ...base, value: 9999, fc_value: 1, projection: 40, price: 0 });
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(SELL_HIGH_RULE), true);
  assert.equal(Object.isFrozen(SELL_HIGH_PASS_BAR), true);
  assert.match(SELL_HIGH_RULE.basis, /GUESS/);
});

/** A db with the { row, rows } shape of server/db/index.js over an in-memory sqlite. */
function makeDb({ tables = ['players', 'player_week_usage', 'nfl_ffopportunity_weekly'] } = {}) {
  const raw = new DatabaseSync(':memory:');
  const ddl = {
    players: `CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, position TEXT, gsis_id TEXT)`,
    player_week_usage: `CREATE TABLE player_week_usage (player_id INTEGER, season INTEGER, week INTEGER, position TEXT,
      attempts REAL, carries REAL, targets REAL, passing_tds REAL, rushing_tds REAL, receiving_tds REAL,
      PRIMARY KEY (player_id, season, week))`,
    nfl_ffopportunity_weekly: `CREATE TABLE nfl_ffopportunity_weekly (season INTEGER, week INTEGER, player_gsis_id TEXT,
      expected_touchdowns REAL, PRIMARY KEY (season, week, player_gsis_id))`,
  };
  for (const t of tables) raw.exec(ddl[t]);
  return {
    rows: (sql, ...p) => raw.prepare(sql).all(...p),
    row: (sql, ...p) => raw.prepare(sql).get(...p),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
  };
}

function seed(db) {
  db.run(`INSERT INTO players VALUES (1, 'Made Up One', 'WR', 'G1'), (2, 'Made Up Two', 'QB', 'G2'), (3, 'Made Up Three', 'RB', 'G3')`);
  for (const w of [1, 2, 3, 4]) {
    // WR: 10 opportunities a week, a TD every other week vs 0.3 expected.
    db.run(`INSERT INTO player_week_usage VALUES (1, 2026, ?, 'WR', 0, 2, 8, 0, 0, ?)`, w, w % 2);
    db.run(`INSERT INTO nfl_ffopportunity_weekly VALUES (2026, ?, 'G1', 0.3)`, w);
    // QB: 30 attempts + 5 carries, 2 TDs vs 2 expected.
    db.run(`INSERT INTO player_week_usage VALUES (2, 2026, ?, 'QB', 30, 5, 0, 2, 0, 0)`, w);
    db.run(`INSERT INTO nfl_ffopportunity_weekly VALUES (2026, ?, 'G2', 2)`, w);
  }
  // Week 4 is the as-of week: a huge WR week that must never be read before it is final.
  db.run(`UPDATE player_week_usage SET receiving_tds = 5 WHERE player_id = 1 AND week = 4`);
  db.run(`INSERT INTO player_week_usage VALUES (1, 2025, 17, 'WR', 0, 0, 10, 0, 0, 5)`);
}

test('reader: the lookback weeks strictly before this week; week N and last season never read', () => {
  const db = makeDb(); seed(db);
  const r = readSellHighInputs(db, { season: 2026, week: 4, ids: [1, 2] });
  assert.equal(r.as_of_week, 4);
  assert.deepEqual(r.players.get(1).rows.map(x => x.week), [1, 2, 3]);
  assert.equal(r.players.get(1).rows.reduce((s, x) => s + x.tds, 0), 2);
  assert.equal(r.players.get(2).rows[0].opportunities, 35);
  assert.equal(r.sources.usage.status, 'ok');
  // WR: 2 TDs on 30 opportunities (6.7%) vs 0.9 expected (3.0%): flagged. QB: 6 vs 6: not.
  const s = sellHighSummary(r);
  assert.equal(s.flags.find(f => f.player === 1).status, 'flagged');
  assert.equal(s.flags.find(f => f.player === 2).status, 'not_flagged');
});

test('reader: an asked-for id with no usage row is unrated, never dropped', () => {
  const db = makeDb(); seed(db);
  const s = sellHighSummary(readSellHighInputs(db, { season: 2026, week: 4, ids: [1, 3] }));
  assert.equal(s.flags.length, 2);
  assert.equal(s.flags.find(f => f.player === 3).status, 'unrated');
});

test('reader: absent tables are reported per source, not thrown and not an empty ok', () => {
  const db = makeDb({ tables: ['players', 'player_week_usage'] });
  const r = readTdWeeks(db, { season: 2026, ids: [1] });
  assert.equal(r.sources.ffopportunity.status, 'table_absent');
  assert.equal(r.players.size, 0);
});

test('summary: shadow, weight 0, ungraded, ids and counts only (no names)', () => {
  const db = makeDb(); seed(db);
  const s = sellHighSummary(readSellHighInputs(db, { season: 2026, week: 4, ids: [1, 2, 3] }));
  assert.equal(s.lane, 'shadow');
  assert.equal(s.weight, 0);
  assert.equal(s.grade.status, 'ungraded');
  assert.deepEqual(s.counts, { flagged: 1, not_flagged: 1, unrated: 1, untouchable: 0 });
  assert.doesNotMatch(JSON.stringify(s), /Made Up/);
});

/** A season of made-up players: hot for weeks 1-4, then either regressing or staying hot. */
function population({ n, regress, controls = 120 }) {
  const players = new Map();
  for (let i = 0; i < n; i++) {
    const after = regress(i) ? { tds: 0.3, xtd: 0.3, opp: 10 } : { tds: 0.6, xtd: 0.3, opp: 10 };
    players.set(i + 1, { position: 'WR', rows: [...weeks(4, { tds: 0.6, xtd: 0.3, opp: 10 }), ...weeks(8, { ...after, from: 5 })] });
  }
  for (let i = 0; i < controls; i++) {
    players.set(1000 + i, { position: 'RB', rows: weeks(12, { tds: 0.3, xtd: 0.3, opp: 12 }) });
  }
  return players;
}

test('grader: one flag per player-season (the first week it fires), graded on the weeks after', () => {
  const g = gradeSellHigh(new Map([[2024, population({ n: 3, regress: () => true, controls: 0 })]]), { asOfWeeks: [5, 6, 7] });
  assert.equal(g.n, 3, 'overlapping windows never count one surge twice');
  assert.ok(g.flags.every(f => f.week === 5 && f.hit));
  assert.equal(g.status, 'not_enough_data');
  assert.match(g.reason, /n 3 flags \(needs 40\)/);
});

test('grader: surges that halve pass the pre-registered bar; surges that persist fail it', () => {
  const regressing = gradeSellHigh(new Map([[2024, population({ n: 50, regress: i => i % 10 !== 0 })]]));
  assert.equal(regressing.n, 50);
  assert.equal(regressing.hit_rate, 0.9);
  assert.ok(regressing.lift < 0);
  assert.equal(regressing.status, 'pass');
  assert.deepEqual(regressing.by_week.map(w => w.week), [5]);

  const sticky = gradeSellHigh(new Map([[2024, population({ n: 50, regress: i => i % 2 === 0 })]]));
  assert.equal(sticky.hit_rate, 0.5);
  assert.equal(sticky.status, 'fail');
  assert.match(sticky.reason, /hit rate 0\.5 < 0\.7/);
});

test("Nick's rule: an untouchable is never a sell-high candidate (pinned 160 / 80 / 277 and the adapter's set)", () => {
  const hot = { position: 'WR', rows: weeks(4, { tds: 1, xtd: 0.2, opp: 10 }) };
  const inputs = { players: new Map([160, 80, 277, 44, 45].map(id => [id, { player: id, ...hot }])) };
  const s = sellHighSummary(inputs, { untouchable: new Set(['44']) });
  assert.deepEqual(s.counts, { flagged: 1, not_flagged: 0, unrated: 0, untouchable: 4 });
  assert.deepEqual(s.flags.filter(f => f.status === 'flagged').map(f => f.player), [45]);
  for (const id of [160, 80, 277, 44]) {
    const f = s.flags.find(x => x.player === id);
    assert.equal(f.status, 'untouchable');
    assert.match(f.basis, /never a sell candidate/);
  }
});

const AS_OF = '2026-09-28T12:00:00.000Z';
const produce = adapter => buildPlansFile([{ id: 99, load: async () => ({ adapter }) }], { generated_at: AS_OF, clock: () => 0 });

test('producer: flag off (no adapter.sellHigh) -> no sell_high key at all', async () => {
  const [l] = (await produce(makeAdapter())).leagues;
  assert.equal(l.error ?? null, null);
  assert.equal('sell_high' in l._run.inputs, false);
});

test('producer: flag on -> only _run.inputs.sell_high is added; no served number moves', async () => {
  const off = (await produce(makeAdapter())).leagues[0];
  let calls = 0;
  const sellHigh = () => {
    calls++;
    return { as_of_week: 4, sources: { usage: { status: 'ok' } },
      players: new Map([[5, { player: 5, position: 'WR', rows: weeks(4, { tds: 1, xtd: 0.2, opp: 10 }) }]]) };
  };
  const on = (await produce(Object.assign(makeAdapter(), { sellHigh }))).leagues[0];
  assert.equal(calls, 1);
  assert.equal(on._run.inputs.sell_high.lane, 'shadow');
  assert.equal(on._run.inputs.sell_high.counts.flagged, 1);
  const strip = e => { const c = structuredClone(e); delete c._run; return c; };
  assert.deepEqual(strip(on), strip(off), 'shadow: no served number moves');
  delete on._run.inputs.sell_high;
  assert.deepEqual(on._run, off._run);
});
