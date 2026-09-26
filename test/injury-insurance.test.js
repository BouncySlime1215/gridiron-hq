/**
 * INJURY INSURANCE (batch D item 27): a handcuff for each of Nick's Blue chips, priced as an explicit
 * option beside the served trade. Shadow behind GRIDIRON_INJURY_INSURANCE; moves no served number.
 *
 * Fixtures only: made-up players, ids and numbers (80 and 290 appear only as the pinned rule ids).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { priceInsurance, insuranceSummary, insuranceEnabled, gradeInsurance, weeksLeft,
  INSURANCE_ENV, INSURANCE_RULE, INSURANCE_PASS_BAR, REFUSE_REASONS } = await import('../server/services/campaign/injury-insurance.js');
const { handcuffsByStarter, servedTrade, readGradeGames, pprPoints } = await import('../server/services/campaign/injury-insurance-inputs.js');
const { bestLineup } = await import('../server/services/trade-engine.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const lineupPoints = ps => bestLineup(ps, SLOTS, 'ros_ppg').points;
const P = (id, position, ros_ppg, score, fc) => ({ id, position, ros_ppg, score, fc });

// Nick: an RB Blue chip (901), a WR Blue chip (903), a QB Blue chip with no backup (905).
const ROSTER = [P(901, 'RB', 18, 90, 6000), P(902, 'RB', 12, 70, 3000), P(903, 'WR', 14, 85, 5000), P(904, 'WR', 10, 60, 2500),
  P(905, 'QB', 20, 88, 5500), P(906, 'TE', 8, 50, 2000), P(907, 'RB', 5, 40, 900), P(908, 'WR', 4, 35, 700), P(80, 'RB', 3, 60, 100)];
const pass = { passes: true, games_observed: 3, opportunity_without: 16, reason: 'ok' };
const cuff = (id, extra = {}) => ({ id, position: 'RB', ros_ppg: 3, points_without: 14, owner: null, workload_test: pass, ...extra });
const FC = new Map([...ROSTER.map(p => [p.id, p.fc]), [950, 800], [951, 800], [952, 800], [290, 800], [960, 4000]]);

const base = (over = {}) => ({
  roster: ROSTER.map(({ id, position, ros_ppg }) => ({ id, position, ros_ppg })),
  lineupPoints,
  scoreOf: id => { const p = ROSTER.find(x => x.id === Number(id)); return p ? { score: p.score, label: null } : null; },
  valueOf: id => FC.get(Number(id)) ?? null,
  missRateOf: id => ({ 901: 0.2, 903: 0.1 })[id] ?? null,
  handcuffs: new Map([['901', [cuff(950), cuff(951, { owner: '2' }), cuff(952, { workload_test: { passes: false, reason: 'averaged 5 opportunities' } }),
    cuff(290), cuff(953)]]]),
  untouchable: new Set(), sold: new Set(), week: 4,
  trade: { give: [904], get: [{ id: 960, position: 'WR', ros_ppg: 16 }], p_complete: 0.5 },
  ...over,
});

test('flag is off by default; only "1" turns it on', () => {
  assert.equal(INSURANCE_ENV, 'GRIDIRON_INJURY_INSURANCE');
  assert.equal(insuranceEnabled({}), false);
  assert.equal(insuranceEnabled({ GRIDIRON_INJURY_INSURANCE: 'on' }), false);
  assert.equal(insuranceEnabled({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), false, 'the preview switch never turns it on');
  assert.equal(insuranceEnabled({ GRIDIRON_INJURY_INSURANCE: '1' }), true);
});

test('weeks left runs through the fantasy final, this week included', () => {
  assert.equal(INSURANCE_RULE.last_week, 17);
  assert.equal(weeksLeft(4), 14);
  assert.equal(weeksLeft(17), 1);
  assert.equal(weeksLeft(18), 0);
  assert.equal(weeksLeft(null), 0);
});

test('prices the wire handcuff by hand: at risk, won back, drop cost, and vs the trade', () => {
  const r = priceInsurance(base());
  assert.equal(r.status, 'ok');
  assert.equal(r.lane, 'shadow');
  assert.equal(r.weeks_left, 14);
  assert.equal(r.full_strength_points, 87);
  const rb = r.chips.find(c => c.player === '901');
  // Without 901 the lineup is 63 (24 lost); 20% of 14 weeks at 24 = 67.2 at risk.
  assert.equal(rb.cost_per_missed_week, 24);
  assert.equal(rb.at_risk_points, 67.2);
  assert.equal(rb.status, 'insurable');
  // 950 plays at 14 in the missed weeks: 83 vs 63 = 20 back; the dropped 908 never started (cost 0).
  assert.deepEqual(rb.best, { kind: 'wire_handcuff', handcuff: '950', drop: '908', recovered_per_missed_week: 20,
    drop_cost_per_week: 0, insured_points: 56, workload: { games: 3, opportunities: 16 } });
  // The trade: +6 a week (16 for 10 at WR) x 0.5 x 14 = 42; insurance 56 is worth more, and they do not compete.
  assert.deepEqual(r.trade, { status: 'ok', give: ['904'], get: ['960'], points_per_week: 6, p_complete: 0.5, expected_points: 42 });
  assert.deepEqual(rb.vs_trade, { insured_points: 56, trade_points: 42, better: 'insure', drop_in_trade: false });
});

test("Nick's rules: rostered, pinned never-get, workload failers and unpriced handcuffs are refused, never priced", () => {
  const rb = priceInsurance(base()).chips.find(c => c.player === '901');
  const why = Object.fromEntries(rb.refused.map(x => [x.handcuff, x.reason]));
  assert.deepEqual(why, { 951: 'rostered', 952: 'workload_test', 290: 'never_get', 953: 'no_fc_value' });
  assert.deepEqual(rb.options.map(o => o.handcuff), ['950']);
  for (const x of rb.refused) assert.ok(REFUSE_REASONS.includes(x.reason));
  assert.match(rb.refused.find(x => x.handcuff === '952').detail, /averaged 5/);
});

test('no buy-backs: a handcuff Nick sold this season is never an option', () => {
  const rb = priceInsurance(base({ sold: new Set(['950']) })).chips.find(c => c.player === '901');
  assert.equal(rb.status, 'no_option');
  assert.equal(rb.refused.find(x => x.handcuff === '950').reason, 'never_get');
});

test('the drop is never 160 / 80 / 277, an untouchable or a Blue chip, and never worth more than the handcuff', () => {
  // 908 untouchable: the only other drop at or below 950's value (800) is 80, which is protected.
  const r = priceInsurance(base({ untouchable: new Set(['908']) }));
  const rb = r.chips.find(c => c.player === '901');
  assert.equal(rb.status, 'no_option');
  assert.equal(rb.refused.find(x => x.handcuff === '950').reason, 'no_drop');
  // Over every run in this file, no option ever drops a pinned or Blue chip id.
  for (const over of [{}, { untouchable: new Set(['908']) }, { valueOf: id => (Number(id) === 950 ? 99999 : FC.get(Number(id)) ?? null) }]) {
    for (const c of priceInsurance(base(over)).chips) {
      for (const o of c.options) {
        assert.ok(!['160', '80', '277', '901', '903', '905'].includes(o.drop), `dropped ${o.drop}`);
        assert.ok((FC.get(Number(o.drop)) ?? Infinity) <= (over.valueOf ?? (id => FC.get(Number(id))))(o.handcuff));
      }
    }
  }
});

test('only Blue chip starters are insured; no board or no miss rate fails closed with the reason', () => {
  const r = priceInsurance(base());
  assert.deepEqual(r.chips.map(c => c.player).sort(), ['901', '903', '905'], '902 (70) and 80 are not Blue chips');
  assert.equal(r.chips.find(c => c.player === '903').status, 'no_option');
  const qb = r.chips.find(c => c.player === '905');
  assert.equal(qb.status, 'no_miss_rate');
  assert.equal(qb.at_risk_points, null);
  const off = priceInsurance(base({ scoreOf: null }));
  assert.equal(off.status, 'no_board');
  assert.deepEqual(off.chips, []);
  assert.equal(priceInsurance(base({ week: 18 })).status, 'season_over');
});

test('when the drop is one of the trade gives, the read says they compete', () => {
  const r = priceInsurance(base({ trade: { give: [908], get: [{ id: 960, position: 'WR', ros_ppg: 16 }], p_complete: 1 } }));
  const rb = r.chips.find(c => c.player === '901');
  assert.equal(rb.vs_trade.drop_in_trade, true);
  assert.equal(rb.vs_trade.better, 'trade', 'the trade (+11 a week, p 1, 154 points) outranks 56 here');
  const none = priceInsurance(base({ trade: null }));
  assert.equal(none.trade.status, 'none');
  assert.equal(none.chips.find(c => c.player === '901').vs_trade.better, 'insure');
});

test('summary counts the chips', () => {
  const s = insuranceSummary(priceInsurance(base()));
  assert.deepEqual(s.counts, { chips: 3, insurable: 1, no_option: 1, no_miss_rate: 1, better_than_trade: 1 });
});

test('inputs: handcuffs turned round per starter, the workload test run on that starter alone', () => {
  const entries = [{ player_id: 950, position: 'RB', paths: [
    { starter_id: 901, points_without: 14, opportunity_without: 16, games_observed: 3 },
    { starter_id: 999, points_without: 4, opportunity_without: 5, games_observed: 4 }] }];
  const m = handcuffsByStarter(entries, { playerOf: () => ({ position: 'RB', ros_ppg: 3 }), ownerOf: () => null });
  assert.equal(m.get('901')[0].workload_test.passes, true);
  assert.equal(m.get('999')[0].workload_test.passes, false, 'a thin path does not borrow the other path');
  assert.equal(m.get('901')[0].points_without, 14);
  const only = handcuffsByStarter(entries, { starters: [901] });
  assert.deepEqual([...only.keys()], ['901']);
});

test("inputs: the served move is Nick's net side; a flip piece given later is not held", () => {
  const t = servedTrade({ p_complete: 0.3, steps: [{ give: ['1'], get: ['5'] }, { give: ['5', '2'], get: ['9'] }] }, id => ({ position: 'WR', ros_ppg: Number(id) }));
  assert.deepEqual(t.give, ['1', '2']);
  assert.deepEqual(t.get.map(g => g.id), ['9']);
  assert.equal(t.p_complete, 0.3);
  assert.equal(servedTrade(null), null);
});

test('grade: pre-registered bar, held-out games, deterministic bootstrap', () => {
  assert.deepEqual({ ...INSURANCE_PASS_BAR }, { version: 1, min_games: 30, ratio_low: 0.75, ratio_high: 1.25, ci_low: 0.6, ci_high: 1.5,
    min_lift: 1.5, min_fail_games: 10 });
  const good = [...Array.from({ length: 40 }, (_, i) => ({ predicted: 12, realized: 10 + (i % 5), passes: true })),
    ...Array.from({ length: 12 }, () => ({ predicted: 5, realized: 4, passes: false }))];
  const g = gradeInsurance(good);
  assert.equal(g.verdict, 'pass');
  assert.equal(g.checks.B2_ratio.value, 1);
  assert.deepEqual(gradeInsurance(good), g, 'same input, same grade');
  const thin = gradeInsurance(good.slice(0, 20));
  assert.equal(thin.verdict, 'insufficient');
  const over = gradeInsurance(good.map(x => (x.passes ? { ...x, realized: x.realized / 2 } : x)));
  assert.equal(over.verdict, 'fail');
  assert.equal(over.checks.B2_ratio.pass, false);
});

test('grade reader: a missed game is a week his team played and he did not; the backup scores 0 with no row', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE player_week_usage (player_id INTEGER, season INTEGER, week INTEGER, team TEXT, passing_yards REAL, passing_tds REAL,
    rushing_yards REAL, rushing_tds REAL, receptions REAL, receiving_yards REAL, receiving_tds REAL)`);
  const ins = db.prepare('INSERT INTO player_week_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  // Starter 1 plays weeks 1-2 and misses 3-4; backup 2 runs for 100 yards and a TD in week 3, no row in week 4.
  for (const w of [1, 2]) ins.run(1, 2025, w, 'AAA', 0, 0, 80, 1, 2, 10, 0);
  for (const w of [1, 2, 3]) ins.run(2, 2025, w, 'AAA', 0, 0, w === 3 ? 100 : 10, w === 3 ? 1 : 0, 0, 0, 0);
  ins.run(3, 2025, 4, 'AAA', 0, 0, 0, 0, 5, 50, 0);           // a teammate shows week 4 was played
  const rowsOf = (sql, ...a) => db.prepare(sql).all(...a);
  const entries = [{ player_id: 2, position: 'RB', paths: [{ starter_id: 1, points_without: 12, opportunity_without: 15, games_observed: 3 }] }];
  const games = readGradeGames({ rows: rowsOf }, { season: 2025, entries });
  assert.deepEqual(games.map(g => [g.week, g.realized, g.passes]), [[3, 16, true], [4, 0, true]]);
  assert.equal(pprPoints({ rushing_yards: 100, rushing_tds: 1 }), 16);
});

const AS_OF = '2026-09-28T12:00:00.000Z';
const produce = adapter => buildPlansFile([{ id: 99, load: async () => ({ adapter }) }], { generated_at: AS_OF, clock: () => 0 });

test('producer: flag off (no adapter.injuryInsurance) -> no injury_insurance key at all', async () => {
  const [l] = (await produce(makeAdapter())).leagues;
  assert.equal(l.error ?? null, null);
  assert.equal('injury_insurance' in l._run.inputs, false);
});

test('producer: flag on -> only _run.inputs.injury_insurance is added; no served number moves', async () => {
  const off = (await produce(makeAdapter())).leagues[0];
  let calls = 0;
  const injuryInsurance = async () => {
    calls++;
    const b = base({ trade: undefined });
    delete b.trade;
    return b;
  };
  const on = (await produce(Object.assign(makeAdapter(), { injuryInsurance }))).leagues[0];
  assert.equal(calls, 1);
  const ii = on._run.inputs.injury_insurance;
  assert.equal(ii.lane, 'shadow');
  assert.equal(ii.status, 'ok');
  assert.equal(ii.trade.status, 'ok', 'the served move is read from the plan');
  assert.equal(ii.counts.insurable, 1);
  const strip = e => { const c = structuredClone(e); delete c._run; return c; };
  assert.deepEqual(strip(on), strip(off), 'shadow: no served number moves');
  delete on._run.inputs.injury_insurance;
  assert.deepEqual(on._run, off._run);
});

test('producer: a failing read is recorded with its reason, never a dead league entry', async () => {
  const injuryInsurance = async () => { throw new Error('no such table: player_week_usage'); };
  const [l] = (await produce(Object.assign(makeAdapter(), { injuryInsurance }))).leagues;
  assert.equal(l.error ?? null, null);
  assert.deepEqual(l._run.inputs.injury_insurance, { lane: 'shadow', status: 'error', reason: 'no such table: player_week_usage' });
});
