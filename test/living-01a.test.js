/**
 * LIVING-01a: per-manager engagement state + activity rates, the engine producer
 * 'activity' (field activity.manager).
 *
 * Pins:
 *   1. the filter is as-of: a week's prediction uses only earlier weeks, and an
 *      UNKNOWN week (null) is not read as a zero week;
 *   2. quiet weeks move a manager toward drifting / checked out, and P(no more adds)
 *      is higher for a checked-out manager (the checkout score);
 *   3. EM recovers the add rates of data simulated from the served constants;
 *   4. weekly adds/trades from engine events use #203's definitions (executed ADD
 *      items to toTeamId; processed trades to every party) and name absence;
 *   5. EA-01 (spine v2, ENGINE-ARCHITECTURE §11.5): the producer reads engine_events
 *      only (manager.signal, not the manager_signals table); dead starts are as-of per
 *      period; a week without collector coverage reads adds = null; it always writes,
 *      the model in lane shadow, and a default read serves none; (as_of, version, lane)
 *      is idempotent; probs_sum_1 passes on every row; the declaration carries
 *      VERSIONS, inputs, checks and the params_hash of FITTED_PARAMS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-living01a-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';
delete process.env.GRIDIRON_LIVING01A_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { db, run, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const m = await import('../server/services/engine/activity-model.js');
const { appendEvents } = await import('../server/services/engine/events.js');
const { getState } = await import('../server/services/engine/state.js');
const registry = await import('../server/services/engine/registry.js');

const P = m.FITTED_PARAMS;
const wk = (adds, err = null) => ({ adds, err, byeFrac: 0 });

/* ------------------------------------------------------------ the filter */
test('the filter is as-of and an unknown week is not a zero week', () => {
  const base = [wk(3, 0), wk(2, 0), wk(0, 0), wk(0, 1)];
  const a = m.filterSeason(P, base);
  const b = m.filterSeason(P, [...base.slice(0, 3), wk(7, 0)]);
  // Week 4's prediction cannot depend on week 4.
  assert.deepEqual(a.weeks[3].prior, b.weeks[3].prior);
  assert.equal(a.weeks[3].errProb, b.weeks[3].errProb);
  // Unknown (null) and zero give different states: null carries no evidence.
  const unknown = m.filterSeason(P, [wk(null), wk(null)]).final.post;
  const zero = m.filterSeason(P, [wk(0), wk(0)]).final.post;
  assert.notDeepEqual(unknown, zero);
  assert.ok(zero[2] > unknown[2], 'two known zero-add weeks should raise P(checked out) above no information');
  assert.ok(zero[0] < unknown[0], 'and lower P(engaged)');
  assert.ok(Math.abs(unknown.reduce((x, y) => x + y, 0) - 1) < 1e-9);
});

test('quiet weeks move a manager out of engaged; a checked-out manager is likelier to never add again', () => {
  const busy = m.filterSeason(P, [wk(3, 0), wk(2, 0), wk(3, 0), wk(2, 0)]);
  const quiet = m.filterSeason(P, [wk(3, 0), wk(2, 0), wk(0, 1), wk(0, 1)]);
  assert.equal(busy.final.post.indexOf(Math.max(...busy.final.post)), 0, 'busy manager should be engaged');
  assert.ok(quiet.final.post[0] < busy.final.post[0]);
  assert.ok(quiet.final.post[2] > busy.final.post[2]);
  const pBusy = m.pNoMoreAdds(P, busy.final.nextPrior, busy.final.rho, 7);
  const pQuiet = m.pNoMoreAdds(P, quiet.final.nextPrior, quiet.final.rho, 7);
  assert.ok(pQuiet > pBusy, `P(no more adds) quiet ${pQuiet} should exceed busy ${pBusy}`);
  assert.ok(pBusy >= 0 && pQuiet <= 1);
});

test('shrunk rates sit between the population rate and the raw rate', () => {
  const r = m.shrunkRate(0, 2, 1.25, 8);
  assert.ok(r < 1.25 && r > 0);
  assert.equal(m.shrunkRate(5, 0, 1.25, 8), (1.25 * 8 + 5) / 8);
  assert.ok(Math.abs(m.shrunkRate(1000, 1000, 1.25, 8) - 1) < 0.01);
});

test('EM recovers the add rates of data simulated from the served constants', () => {
  let s = 7;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = p => { const u = rnd(); let c = 0; for (let i = 0; i < p.length; i++) { c += p[i]; if (u < c) return i; } return p.length - 1; };
  const pois = mu => { const L = Math.exp(-mu); let k = 0; let p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const truth = { ...P, alpha: 1e9 };
  const seasons = [];
  for (let n = 0; n < 1500; n++) {
    let st = pick(truth.pi);
    const weeks = [];
    for (let t = 0; t < 14; t++) {
      weeks.push({ adds: pois(truth.lam[st]), err: rnd() < m.errorProb(truth, st, 0) ? 1 : 0, byeFrac: 0 });
      st = pick(truth.A[st]);
    }
    seasons.push(weeks);
  }
  const fit = m.fitParams(seasons, m.initialParams({ popAddRate: 1.25, popErr: 0.25, alpha: 1e9, useBye: false }),
    { iterations: 60 });
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(fit.lam[i] - truth.lam[i]) / truth.lam[i] < 0.15, `lam[${i}] ${fit.lam[i]} vs ${truth.lam[i]}`);
  }
  assert.ok(fit.lam[2] < 0.1, `checked-out add rate ${fit.lam[2]} should be near zero`);
  assert.ok(fit.A[2][2] > 0.9, 'checked out should stay near-absorbing');
});

/* ---------------------------------------------------- #203's definitions */
const ev = (id, payload) => ({ id, payload: { season: 2026, ...payload } });
test('weekly adds and trades use #203 definitions and name absence', () => {
  const events = [
    ev(1, { type: 'WAIVER', status: 'EXECUTED', scoring_period: 1, items: [{ type: 'ADD', to_team_id: 3 }, { type: 'DROP', from_team_id: 3 }] }),
    ev(2, { type: 'FREEAGENT', status: 'EXECUTED', scoring_period: 2, items: [{ type: 'ADD', to_team_id: 3 }, { type: 'ADD', to_team_id: 3 }] }),
    ev(3, { type: 'WAIVER', status: 'PENDING', scoring_period: 2, items: [{ type: 'ADD', to_team_id: 4 }] }),
    ev(4, { type: 'WAIVER', status: 'CANCELED', scoring_period: 2, items: [{ type: 'ADD', to_team_id: 4 }] }),
    ev(5, { type: 'TRADE_ACCEPT', execution_type: 'PROCESS', status: 'EXECUTED', scoring_period: 2,
      items: [{ type: 'TRADE', from_team_id: 3, to_team_id: 5 }, { type: 'TRADE', from_team_id: 5, to_team_id: 3 }] }),
    ev(6, { type: 'TRADE_ACCEPT', execution_type: 'EXECUTE', status: 'EXECUTED', scoring_period: 2,
      items: [{ type: 'TRADE', from_team_id: 6, to_team_id: 7 }] }),
    ev(7, { type: 'FREEAGENT', status: 'EXECUTED', scoring_period: 3, items: [{ type: 'ADD', to_team_id: 3 }] }),
    { id: 8, payload: { season: 2025, type: 'FREEAGENT', status: 'EXECUTED', scoring_period: 1, items: [{ type: 'ADD', to_team_id: 9 }] } },
  ];
  const a = m.weeklyActivityFromEvents(events, 2026, 2);
  assert.equal(a.collected, true);
  assert.equal(a.adds.get('3').get(1).n, 1);
  assert.equal(a.adds.get('3').get(2).n, 2, 'ADD items are counted, not rows');
  assert.deepEqual(a.adds.get('3').get(2).ids, [2]);
  assert.equal(a.adds.get('3').get(3), undefined, 'a week after `through` is not read');
  assert.equal(a.adds.has('4'), false, 'pending and canceled claims are not adds');
  assert.equal(a.adds.has('9'), false, 'another season is not read');
  assert.equal(a.trades.get('3').get(2).n, 1);
  assert.equal(a.trades.get('5').get(2).n, 1);
  assert.equal(a.trades.has('6'), false, 'only the PROCESS row completes a trade');
  assert.equal(m.weeklyActivityFromEvents([], 2026, 2).collected, false);
});

test('managerState: the reason chain says why, and absence is typed', () => {
  const quiet = m.managerState([{ ...wk(2, 0), addIds: [11] }, { ...wk(0), addIds: [] }, { ...wk(0), addIds: [] }], { trades: 1, weeksLeft: 10 });
  const texts = quiet.reasonChain.contributions.map(c => c.text);
  assert.ok(texts.some(t => /0 adds in 2 weeks/.test(t)), texts.join(' | '));
  assert.ok(texts.filter(t => /week \d/.test(t)).every(t => t.startsWith(`${quiet.value.state}:`)), 'each week names the state it moved');
  assert.ok(quiet.value.p_no_more_adds > 0 && quiet.value.p_no_more_adds < 1);
  assert.equal(quiet.value.rates.lineup_error_rate.weeks, 1);
  const none = m.managerState([{ adds: null, err: null, addIds: [] }, { adds: null, err: null, addIds: [] }]);
  assert.equal(none.value.rates.adds_per_week.value, null);
  assert.match(none.value.rates.adds_per_week.absence, /unknown/);
  assert.equal(none.value.rates.lineup_error_rate.value, null);
  assert.ok(none.reasonChain.contributions.some(c => /lineup errors unknown/.test(c.text)));
});

test('managerState: adds_per_week.value is his own rate shrunk to the population', () => {
  const P = m.FITTED_PARAMS;
  const zero = m.managerState(Array.from({ length: 8 }, () => wk(0)));
  const three = m.managerState(Array.from({ length: 8 }, () => wk(3)));
  const expect0 = m.shrunkRate(0, 8, P.popAddRate, P.alpha);
  const expect3 = m.shrunkRate(24, 8, P.popAddRate, P.alpha);
  assert.equal(zero.value.rates.adds_per_week.value, +expect0.toFixed(4));
  assert.equal(three.value.rates.adds_per_week.value, +expect3.toFixed(4));
  assert.ok(Math.abs(expect0 - 0.625) < 1e-3 && Math.abs(expect3 - 2.125) < 1e-3);
  // Shrinkage sits between his raw rate and the population rate, never beyond either.
  for (const r of [zero, three]) {
    const { value, raw } = r.value.rates.adds_per_week;
    assert.ok(value >= Math.min(raw, P.popAddRate) && value <= Math.max(raw, P.popAddRate), `${value} vs raw ${raw}`);
  }
});

test('managerState: probabilities sum to exactly 1 and the chain is v2 (prob space, not additive)', () => {
  for (const weeks of [[wk(3, 0), wk(2, 0)], [wk(0, 1), wk(0, 1), wk(0, 1)], [wk(null), wk(1, null)], [wk(1, 0)]]) {
    const r = m.managerState(weeks);
    const sum = Object.values(r.value.probs).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) <= 1e-9, `probs sum to ${sum}`);
    assert.equal(r.reasonChain.space, 'prob');
    assert.equal(r.reasonChain.additive, false);
    assert.equal(typeof r.reasonChain.baseline.value, 'number');
    assert.ok(r.reasonChain.contributions.filter(c => /week \d/.test(c.text)).every(c => c.kind === 'event'));
  }
  const pop = m.populationState();
  assert.ok(Math.abs(Object.values(pop.value.probs).reduce((a, b) => a + b, 0) - 1) <= 1e-9);
});

/* ------------------------------------------------------ coverage (pure) */
test('RED: a 4-day transactions collector gap makes that week UNKNOWN, not zero', () => {
  // 2026: week 1 = [Sep 8, Sep 15) ET, week 2 = [Sep 15, Sep 22) ET.
  assert.deepEqual(m.nflWeekWindow(2026, 1), { start: '2026-09-08T04:00:00.000Z', end: '2026-09-15T04:00:00.000Z' });
  const run = at => ({ as_of: at, payload: { job: 'league_transactions', status: 'ok' } });
  const daily = (from, to) => {
    const out = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push(run(new Date(t).toISOString()));
    return out;
  };
  const cutoff = '2026-09-23T00:00:00.000Z';
  const full = daily('2026-09-07T12:00:00Z', '2026-09-22T12:00:00Z');
  assert.deepEqual([...m.coveredWeeks(full, 2026, 2, cutoff)], [1, 2]);
  // Runs stop Sep 16 12:00 and resume Sep 20 12:00: a 4-day gap inside week 2.
  const gap = full.filter(e => !(e.as_of > '2026-09-16T12:00:00.000Z' && e.as_of < '2026-09-20T12:00:00.000Z'));
  assert.deepEqual([...m.coveredWeeks(gap, 2026, 2, cutoff)], [1]);
  // A 3-day gap is still covered (ESPN returns the last ~3 days).
  const three = full.filter(e => !(e.as_of > '2026-09-16T12:00:00.000Z' && e.as_of < '2026-09-19T12:00:00.000Z'));
  assert.deepEqual([...m.coveredWeeks(three, 2026, 2, cutoff)], [1, 2]);
  // A failed or skipped run is not coverage; another job is not coverage.
  const failed = full.map(e => (e.as_of.startsWith('2026-09-17') || e.as_of.startsWith('2026-09-18')
    || e.as_of.startsWith('2026-09-19') ? { ...e, payload: { ...e.payload, status: 'error' } } : e));
  assert.deepEqual([...m.coveredWeeks(failed, 2026, 2, cutoff)], [1]);
  assert.deepEqual([...m.coveredWeeks(full.map(e => ({ ...e, payload: { ...e.payload, job: 'nfl_lines' } })), 2026, 2, cutoff)], []);
  // No coverage at all: every week unknown.
  assert.deepEqual([...m.coveredWeeks([], 2026, 2, cutoff)], []);
});

test('dead starts: the signal for period p is week p-1, the latest at or before the cutoff wins', () => {
  const sig = (id, team, period, value) => ({ id, team_id: team, payload: { metric: m.DEAD_START_METRIC, scoring_period: period, value } });
  const d = m.deadStartsFromSignals([sig(1, '2', 2, 1), sig(2, '2', 2, 0), sig(3, '2', 3, 2), sig(4, '3', 4, 5),
    { id: 5, team_id: '3', payload: { metric: 'tx_waiver_moves', scoring_period: 2, value: 9 } }], 2);
  assert.deepEqual(d.get('2').get(1), { dead: 0, id: 2 });
  assert.deepEqual(d.get('2').get(2), { dead: 2, id: 3 });
  assert.equal(d.get('3'), undefined, 'a week after `through` and another metric are not read');
});

/* -------------------------------------------------------------- producer */
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (81, 'espn', 'liv-81', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-18 01:00:00')`);
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (83, 'espn', 'liv-83', 2024, 'Fixture gap', '1', 4, 1, '{}', '2024-09-18 01:00:00')`);
const tx = (key, asOf, period, team, { league = 81, season = 2026 } = {}) => ({ event_type: 'espn.transaction', as_of: asOf,
  league_id: league, team_id: String(team), source: 'fixture-living', natural_key: key,
  payload: { season, type: 'FREEAGENT', status: 'EXECUTED', scoring_period: period, items: [{ type: 'ADD', to_team_id: team }] } });
const signal = (key, asOf, team, period, value) => ({ event_type: 'manager.signal', as_of: asOf, league_id: 81, team_id: team,
  source: 'fixture-signals', natural_key: key,
  payload: { signal_source: 'roster', metric: 'lineup_dead_starts_last_week', value, n: 9, scoring_period: period } });
const coverage = (from, to, skip = () => false) => {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) {
    const at = new Date(t).toISOString();
    if (skip(at)) continue;
    out.push({ event_type: 'source.coverage', as_of: at, source: 'fixture-coverage', natural_key: 'league_transactions',
      entities: [{ type: 'source', id: 'league_transactions', role: 'subject' }],
      payload: { job: 'league_transactions', last_run_at: at, status: 'ok', consecutive_failures: 0 } });
  }
  return out;
};
const { events: added } = appendEvents([
  tx('a1', '2026-09-09T12:00:00Z', 1, 1), tx('a2', '2026-09-16T12:00:00Z', 2, 1), tx('a3', '2026-09-16T13:00:00Z', 2, 1),
  tx('b1', '2026-09-09T12:00:00Z', 1, 2),
  tx('late', '2026-09-23T12:00:00Z', 2, 3), // stamped after the cutoff: must not be read
  // #203's dead starts: period 2 describes week 1, period 3 week 2.
  signal('s1-p2', '2026-09-15T10:00:00Z', '1', 2, 0), signal('s2-p2', '2026-09-15T10:00:00Z', '2', 2, 0),
  signal('s3-p2', '2026-09-15T10:00:00Z', '3', 2, 0),
  signal('s1-p3', '2026-09-22T10:00:00Z', '1', 3, 0), signal('s2-p3', '2026-09-22T10:00:00Z', '2', 3, 2),
  signal('s3-p3', '2026-09-22T10:00:00Z', '3', 3, 0),
  ...coverage('2026-09-07T12:00:00Z', '2026-09-22T12:00:00Z'),
  // 2024 league with a 4-day collector gap inside week 2 ([Sep 10, Sep 17) ET).
  tx('g1', '2024-09-05T12:00:00Z', 1, 1, { league: 83, season: 2024 }),
  tx('g2', '2024-09-12T12:00:00Z', 2, 1, { league: 83, season: 2024 }),
  ...coverage('2024-09-02T12:00:00Z', '2024-09-18T12:00:00Z', at => at > '2024-09-11T12:00:00.000Z' && at < '2024-09-15T12:00:00.000Z'),
]);
const idOf = key => added.find(e => e.natural_key === key).id;
const CUT = '2026-09-22T12:00:00Z';
const managerRows = (extra = '') => rows(`SELECT entity_id, value, reason_chain, event_ids, producer, producer_version, lane,
    league_id, health, as_of FROM engine_state WHERE field = 'activity.manager' ${extra} ORDER BY entity_id, id`)
  .map(x => ({ ...x, value: JSON.parse(x.value), reason_chain: JSON.parse(x.reason_chain), event_ids: JSON.parse(x.event_ids),
    health: JSON.parse(x.health) }));

test('RED: dead starts are as-of — a later dead start leaves week t unknown (err = null)', async () => {
  // At Sep 20 the period-3 signal (week 2, stamped Sep 22) is in the future.
  const early = await m.activityInputs({ leagueId: 81, season: 2026, through: 2, asOf: '2026-09-20T00:00:00Z' });
  assert.equal(early.weeksByTeam.get('2')[1].err, null, 'a dead start stamped after the cutoff leaked into week 2');
  assert.equal(early.weeksByTeam.get('2')[0].err, 0, 'week 1 comes from the period-2 signal');
  const late = await m.activityInputs({ leagueId: 81, season: 2026, through: 2, asOf: CUT });
  assert.equal(late.weeksByTeam.get('2')[1].err, 1);
  assert.deepEqual(late.weeksByTeam.get('2')[1].errIds, [idOf('s2-p3')]);
});

test('RED: a 4-day collector gap reads adds = null for that week, not 0', async () => {
  const r = await m.activityInputs({ leagueId: 83, season: 2024, through: 2, asOf: '2024-09-20T00:00:00Z' });
  assert.deepEqual([...r.covered], [1]);
  const w = r.weeksByTeam.get('1');
  assert.equal(w[0].adds, 1);
  assert.equal(w[1].adds, null, 'an uncovered week must be unknown even though an add event exists');
  assert.deepEqual(w[1].addIds, [], 'an unknown week cites nothing');
});

test('RED: with the flag off it computes and writes shadow rows; a default read serves none', async () => {
  assert.equal(process.env.GRIDIRON_LIVING01A_ENABLED, undefined);
  const r = await m.produceActivityStates({ leagueId: 81, season: 2026, through: 2, asOf: CUT, weeksLeft: 12 });
  assert.equal(r.lane, 'shadow');
  assert.equal(r.written, 3);
  assert.deepEqual(r.population, { written: true, lane: 'live' });
  const got = managerRows();
  assert.deepEqual(got.map(x => x.entity_id), ['81:1', '81:2', '81:3']);
  for (const x of got) {
    assert.equal(x.lane, 'shadow');
    assert.equal(x.producer, 'activity');
    assert.equal(x.producer_version, m.MODEL_VERSION);
    assert.equal(x.league_id, 81);
    assert.ok(m.STATES.includes(x.value.state));
    assert.equal(x.reason_chain.v, 2);
    assert.equal(x.reason_chain.space, 'prob');
    assert.equal(x.value.preview, undefined, 'the flag is display-only: never in the row');
  }
  for (const team of ['1', '2', '3']) {
    assert.equal(getState('league_team', `81:${team}`, 'activity.manager', { asOf: CUT, leagueId: 81 }), null,
      'a default (live) read served a shadow row');
    assert.ok(getState('league_team', `81:${team}`, 'activity.manager', { asOf: CUT, leagueId: 81, lane: 'shadow' }));
  }
  const view = await m.readActivityManager({ leagueId: 81, team: '1', asOf: CUT });
  assert.equal(view.status, 'fallback', 'flag off: the reader serves the population fallback');
  assert.equal(view.row.field, 'activity.population');
});

test('the shadow rows read events only, as of the cutoff, and cite their own events', () => {
  const [t1, t2, t3] = managerRows();
  assert.deepEqual(t1.event_ids.sort((a, b) => a - b),
    [idOf('a1'), idOf('a2'), idOf('a3'), idOf('s1-p2'), idOf('s1-p3')].sort((a, b) => a - b));
  assert.equal(t1.value.rates.adds_per_week.raw, 1.5);
  assert.ok(!t3.event_ids.includes(idOf('late')), 'an event after as_of leaked in');
  assert.equal(t3.value.rates.adds_per_week.raw, 0, 'a covered week with no adds is zero, not unknown');
  assert.equal(t2.value.rates.lineup_error_rate.raw, 1, "#203's dead starts are read from manager.signal events");
  assert.equal(t2.value.rates.lineup_error_rate.weeks, 2);
  assert.ok(t3.reason_chain.contributions.some(c => /0 adds in 2 weeks/.test(c.text)));
  assert.ok(t1.value.probs.engaged > t3.value.probs.engaged);
});

test('RED: probs_sum_1 passes on every row', () => {
  const all = rows(`SELECT field, value, health FROM engine_state WHERE producer = 'activity'`);
  assert.ok(all.length >= 4);
  for (const x of all) {
    const h = JSON.parse(x.health);
    assert.equal(h.status, 'ok', `${x.field}: ${JSON.stringify(h.checks)}`);
    const c = h.checks.find(k => k.id === 'probs_sum_1');
    assert.ok(c?.passed, `${x.field} probs_sum_1 did not run or failed`);
  }
});

test('RED: (as_of, version, lane) idempotency — a re-run writes nothing and each key has one row', async () => {
  const before = row(`SELECT COUNT(*) AS n FROM engine_state WHERE producer = 'activity'`).n;
  const again = await m.produceActivityStates({ leagueId: 81, season: 2026, through: 2, asOf: CUT, weeksLeft: 12 });
  assert.equal(again.written, 0);
  assert.equal(again.unchanged + again.skipped, 3, 'a re-run at the same as_of must be a no-op');
  assert.equal(again.population.written, false);
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_state WHERE producer = 'activity'`).n, before);
  const dup = rows(`SELECT entity_id, field, as_of, producer_version, lane, COUNT(*) AS n FROM engine_state
      WHERE producer = 'activity' GROUP BY entity_id, field, as_of, producer_version, lane HAVING n > 1`);
  assert.deepEqual(dup, []);
});

test('the producer declares its versions, inputs, checks and params_hash', () => {
  assert.equal(m.VERSIONS.active, 'activity-population-1');
  assert.deepEqual([...m.VERSIONS.shadow], [m.MODEL_VERSION]);
  const p = registry.producerSpec('activity');
  assert.equal(p.active, m.VERSIONS.active);
  assert.deepEqual(p.shadow, [m.MODEL_VERSION]);
  assert.deepEqual(p.inputs.events, ['espn.transaction', 'manager.signal', 'source.coverage']);
  assert.deepEqual(p.inputs.fields, ['league.week', 'league.rules']);
  assert.equal(p.inputs.scope, 'league_team');
  assert.equal(p.inputs.schedule, 'tick');
  assert.equal(p.versions[m.MODEL_VERSION].training_window.source, 'Sleeper 2021-22');
  assert.equal(registry.laneFor('activity', m.MODEL_VERSION), 'shadow');
  const spec = registry.fieldSpec('activity.manager');
  assert.deepEqual([...spec.checks], ['probs_sum_1', 'no_nan']);
  assert.equal(spec.fallbackField, 'activity.population');
  assert.equal(spec.space, 'prob');
  assert.deepEqual([...spec.replaces], ['counterparty-pricing.js#checkedOutFactor']);
  assert.equal(registry.fieldSpec('activity.population').producer, 'activity');
  // params_hash is the hash of FITTED_PARAMS + the fit id: changing the fit changes the version's hash.
  const stable = v => (v === null || typeof v !== 'object' ? JSON.stringify(v ?? null)
    : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);
  const expect = crypto.createHash('sha256').update(stable({ params: m.FITTED_PARAMS, fit_id: m.FITTED_PARAMS.fit })).digest('hex');
  assert.equal(p.versions[m.MODEL_VERSION].params_hash, expect);
  const stored = row(`SELECT params_hash, status FROM engine_producers WHERE producer = 'activity' AND version = ?`, m.MODEL_VERSION);
  assert.deepEqual({ ...stored }, { params_hash: expect, status: 'shadow' });
});

test('the flag and the preview switch show the shadow row (labelled), never change lanes', async () => {
  process.env.GRIDIRON_LIVING01A_ENABLED = '1';
  try {
    const view = await m.readActivityManager({ leagueId: 81, team: '1', asOf: CUT });
    assert.equal(view.status, 'preview');
    assert.equal(view.row.lane, 'shadow');
    assert.match(view.preview_reason, /shadow/);
    const r = await m.produceActivityStates({ leagueId: 81, season: 2026, through: 2, asOf: CUT });
    assert.equal(r.lane, 'shadow', 'the flag moved the lane');
  } finally {
    delete process.env.GRIDIRON_LIVING01A_ENABLED;
  }
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    const gate = await m.activityEnabled();
    const built = fs.existsSync(path.join(root, 'server/services/preview-mode.js'));
    assert.deepEqual(gate, built ? { on: true, preview: true } : { on: false, preview: false });
  } finally {
    delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  }
});

test('activity.manager has one producer and its writer never leaves the module', () => {
  assert.equal(registry.fieldSpec('activity.manager').producer, 'activity');
  assert.throws(() => registry.registerField('activity.manager', { producer: 'someone-else', version: '1' }), /activity/);
  assert.equal(registry.registerField('activity.manager', { producer: 'activity', version: m.MODEL_VERSION }), null);
  const src = fs.readFileSync(path.join(root, 'server/services/engine/activity-model.js'), 'utf8');
  assert.doesNotMatch(src, /export\s+(const|let|var)\s+\w*WRITER/);
  assert.doesNotMatch(src, /manager_signals/, 'the producer reads engine_events only, never the manager_signals table');
  assert.equal(Object.values(m).some(v => v && typeof v === 'object' && (v.field === 'activity.manager'
    || v['activity.manager'])), false);
});
