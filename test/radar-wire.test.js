/**
 * RADAR-WIRE (ONE-PLAN s5 night 8): every flip row says "why now" behind GRIDIRON_RADAR_WIRE
 * (default off). Pre-registration: docs/tdd/radar-wire.tdd.md.
 *   1. byte-diff: flag off vs on differs only in `why_now` paths;
 *   2. one RADAR-GRADE ledger row with as_of per served flip row;
 *   3. honest inputs: "news dead", O1 radar absent, trend with < 7 days of history = watch;
 *   4. priority: validated cell > fc_trend30 > none; 48 h negative news -> check_first.
 * Made-up four-team league (test/fixtures/campaign-league.mjs); no DB, no simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');
const { validatePlans } = await import('../server/services/campaign/plans-schema.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const W = await import('../server/services/campaign/why-now.js');

const AS_OF = '2026-09-24T00:00:00.000Z';
const NOW = Date.parse(AS_OF);
const HOUR = 3600e3, DAY = 24 * HOUR;

/** The adapter reads RADAR-WIRE adds, on top of the fixture league. */
const withReads = (a, { trends = {}, historyDays = 10, news = {}, newsAlive = true, opp = null } = {}) => Object.assign(a, {
  fcTrendOf: id => trends[String(id)] ?? null,
  fcHistoryDays: () => historyDays,
  newsOf: id => news[String(id)] ?? [],
  newsAlive: () => newsAlive,
  ...(opp ? { opportunityOf: id => opp[String(id)] ?? null } : {}),
});

const produce = async (env, reads = {}, ledger = null) => {
  const a = withReads(makeAdapter(), reads);
  const file = await buildPlansFile([{ id: 99, load: async () => ({ adapter: a }) }],
    { generated_at: AS_OF, clock: () => 0, env, ...(ledger ? { radarLedger: ledger } : {}) });
  return file;
};

/** Every JSON path where a and b differ. */
const diffPaths = (a, b, p = '$', out = []) => {
  if (a === b) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${p}.${k}`, out);
    return out;
  }
  out.push(p);
  return out;
};

const validated = (n = 412) => ({
  opportunity_events: [{ type: 'teammate_out', label: 'Same-position teammate out', direction: 'up', effect: 2.1,
    unit: 'carries + targets per game', n, ci: [1.2, 3.0], passes_gate: true, status: 'validated', evidence: 'x' }],
  net_validated_change: { value: 2.1, unit: 'carries + targets per game', events: 1 },
});
const watchOnly = () => ({
  opportunity_events: [{ type: 'backup_qb', label: 'Backup QB starts', direction: 'down', effect: -0.4,
    unit: 'targets per game', n: 474, ci: [-1.1, 0.3], passes_gate: false, status: 'watch', evidence: 'x' }],
  net_validated_change: { value: 0, unit: 'targets per game', events: 0 },
});
const badNews = hoursAgo => ({ signal_type: 'availability', status: 'out', unavailable_probability: 0.9, role_delta: null,
  published_at: new Date(NOW - hoursAgo * HOUR).toISOString() });

test('flag: =1 on, =0 off and vetoes preview, unset follows preview, default off', () => {
  assert.equal(W.radarWireFlag({}), 'off');
  assert.equal(W.radarWireFlag({ [W.RADAR_WIRE_ENV]: '1' }), 'on');
  const prev = process.env[PREVIEW_ENV];
  process.env[PREVIEW_ENV] = '1';
  try {
    assert.equal(W.radarWireFlag({}), 'preview');
    assert.equal(W.radarWireFlag({ [W.RADAR_WIRE_ENV]: '0' }), 'off');
  } finally {
    if (prev === undefined) delete process.env[PREVIEW_ENV]; else process.env[PREVIEW_ENV] = prev;
  }
});

test('1. byte-diff: flag off vs on differs only in why_now paths, and both files validate', async () => {
  const reads = { trends: { 11: { value: 4200, trend30: 700 } } };
  const off = await produce({}, reads);
  const on = await produce({ [W.RADAR_WIRE_ENV]: '1' }, reads);
  assert.ok(validatePlans(on).ok, JSON.stringify(validatePlans(on).errors?.slice(0, 3)));
  const paths = diffPaths(off, on);
  assert.ok(paths.length > 0, 'the flag served something');
  assert.deepEqual(paths.filter(p => !p.includes('why_now')), []);
  assert.equal(JSON.stringify(off).includes('why_now'), false, 'flag off writes no why_now');
});

test('1b. flip legs, prices, players and every deck move are identical with the flag on', async () => {
  const reads = { trends: { 11: { value: 4200, trend30: -900 } }, news: { 21: [badNews(3)] } };
  const off = (await produce({}, reads)).leagues[0];
  const on = (await produce({ [W.RADAR_WIRE_ENV]: '1' }, reads)).leagues[0];
  const strip = rows => rows.map(({ why_now, ...r }) => r);
  assert.deepEqual(strip(on.flip_map.value), off.flip_map.value);
  for (const k of ['next_move', 'alternatives', 'targets', 'risk_modes', 'partners']) assert.deepEqual(on[k], off[k], k);
});

test('2. ledger: one row with as_of per served flip row', async () => {
  const ledger = [];
  const on = (await produce({ [W.RADAR_WIRE_ENV]: '1' }, { trends: { 11: { value: 4200, trend30: 700 } } }, ledger)).leagues[0];
  const served = on.flip_map.value.filter(r => r.why_now);
  assert.equal(served.length, on.flip_map.value.length);
  assert.equal(ledger.length, served.length);
  for (const r of ledger) {
    assert.equal(r.as_of, AS_OF);
    assert.equal(r.league, '99');
    assert.equal(r.grade_after, new Date(NOW + W.GRADE_AFTER_DAYS * DAY).toISOString());
  }
  const row = ledger.find(r => r.player === '11');
  assert.equal(row.value_at, 4200);
  assert.equal(row.direction, 'up');
});

test('2b. flag off: no ledger rows', async () => {
  const ledger = [];
  await produce({}, {}, ledger);
  assert.equal(ledger.length, 0);
});

test('3a. news with no signal in 48 h prints "news dead" and never raises check_first', () => {
  const w = W.whyNowOf({ radar: 'not_merged', trend: null, historyDays: 10, news: [badNews(2)], newsAlive: false });
  assert.equal(w.sources.news, 'dead');
  assert.notEqual(w.status, 'check_first');
  assert.match(w.text, /news dead/);
});

test('3b. no O1 radar on this build is printed, not hidden', () => {
  const w = W.whyNowOf({ radar: 'not_merged', trend: null, historyDays: 10, news: [], newsAlive: true });
  assert.equal(w.sources.radar, 'not_merged');
  assert.equal(w.status, 'none');
  assert.match(w.text, /O1 radar not on this build/);
});

test('3c. fc_trend30 with < 7 days of value history is a watch label, never act', () => {
  const trend = { value: 5000, trend30: 1000 };
  const young = W.whyNowOf({ radar: 'off', trend, historyDays: 1, news: [], newsAlive: true });
  assert.equal(young.kind, 'fc_trend');
  assert.equal(young.status, 'watch');
  assert.equal(young.sources.trend, 'label_only');
  const grown = W.whyNowOf({ radar: 'off', trend, historyDays: 7, news: [], newsAlive: true });
  assert.equal(grown.status, 'act');
  assert.equal(grown.direction, 'up');
  assert.match(grown.text, /\+25%/);
});

test('4a. priority: a validated cell beats fc_trend30 and carries n and CI', () => {
  const w = W.whyNowOf({ radar: 'on', opp: validated(412), trend: { value: 5000, trend30: -1000 }, historyDays: 10, news: [], newsAlive: true });
  assert.equal(w.kind, 'validated_cell');
  assert.equal(w.status, 'act');
  assert.equal(w.n, 412);
  assert.deepEqual(w.ci, [1.2, 3.0]);
  assert.equal(w.direction, 'up');
  assert.match(w.text, /n 412/);
});

test('4b. a watch-only cell is watch; a trend under 10% is no reason', () => {
  const w = W.whyNowOf({ radar: 'on', opp: watchOnly(), trend: { value: 5000, trend30: 200 }, historyDays: 10, news: [], newsAlive: true });
  assert.equal(w.kind, 'watch_cell');
  assert.equal(w.status, 'watch');
  assert.equal(w.sources.trend, 'small');
  const none = W.whyNowOf({ radar: 'on', opp: null, trend: { value: 5000, trend30: 200 }, historyDays: 10, news: [], newsAlive: true });
  assert.equal(none.status, 'none');
  assert.equal(none.direction, null);
});

test('4c. negative news inside 48 h overrides to check_first; older news does not', () => {
  const base = { radar: 'on', opp: validated(), trend: null, historyDays: 10, newsAlive: true, now: NOW };
  const hot = W.whyNowOf({ ...base, news: [badNews(5)] });
  assert.equal(hot.status, 'check_first');
  assert.equal(hot.check_first, true);
  assert.equal(hot.direction, 'down');
  assert.equal(hot.sources.news, 'contradiction');
  const stale = W.whyNowOf({ ...base, news: [badNews(60)] });
  assert.equal(stale.status, 'act');
  const role = W.whyNowOf({ ...base, news: [{ signal_type: 'role', role_delta: -0.3, published_at: new Date(NOW - HOUR).toISOString() }] });
  assert.equal(role.status, 'check_first');
  const up = W.whyNowOf({ ...base, news: [{ signal_type: 'role', role_delta: 0.3, published_at: new Date(NOW - HOUR).toISOString() }] });
  assert.equal(up.status, 'act');
});

test('4d. served through the producer: validated cell and check_first reach the plans file', async () => {
  const on = (await produce({ [W.RADAR_WIRE_ENV]: '1' }, { opp: { 11: validated() }, news: { 21: [badNews(3)] } })).leagues[0];
  const r11 = on.flip_map.value.find(r => r.player === '11');
  const r21 = on.flip_map.value.find(r => r.player === '21');
  assert.equal(r11.why_now.kind, 'validated_cell');
  assert.equal(r21.why_now.status, 'check_first');
  assert.equal(on._run.inputs.why_now.flag, 'on');
});

test('RADAR-GRADE: rows grade once at +14 days against the same-week base rate', () => {
  const as_of = new Date(NOW - 15 * DAY).toISOString();
  const rows = [
    { as_of, league: '4', player: '1', buy_from: '2', sell_to: '3', direction: 'up', value_at: 100 },
    { as_of, league: '4', player: '2', buy_from: '2', sell_to: '3', direction: null, value_at: 100 },
    { as_of: new Date(NOW - 3 * DAY).toISOString(), league: '4', player: '3', buy_from: '2', sell_to: '3', direction: 'up', value_at: 100 },
  ];
  const valueNow = id => ({ 1: 120, 2: 80, 3: 150 })[id];
  const g = W.gradeLedger(rows, { valueNow, now: NOW });
  assert.equal(g.graded.length, 2, 'only rows at least 14 days old');
  const hit = g.graded.find(r => r.player === '1');
  assert.equal(hit.move, 'up');
  assert.equal(hit.hit, true);
  assert.equal(hit.base, 0.5, 'one of the two same-week players moved up');
  assert.equal(g.summary.status, 'not_enough_data');
  const again = W.gradeLedger([...rows, ...g.graded], { valueNow, now: NOW });
  assert.equal(again.graded.length, 0, 'a graded row is never graded twice');
});

test('RADAR-GRADE: the weekly gate passes only with a CI lower bound above 0 on >= 20 rows', () => {
  const rows = [];
  for (let w = 0; w < 4; w++) for (let i = 0; i < 10; i++) {
    rows.push({ type: 'grade', as_of: new Date(NOW - (30 + 7 * w) * DAY).toISOString(), week: w, player: `${w}-${i}`,
      direction: i < 6 ? 'up' : null, move: i < 5 ? 'up' : 'down', hit: i < 6 ? i < 5 : null, base: 0.5 });
  }
  const s = W.gateSummary(rows);
  assert.equal(s.n, 24);
  assert.equal(s.status, 'passing');
  assert.ok(s.ci[0] > 0);
  const coin = rows.map(r => (r.direction ? { ...r, hit: Number(r.player.split('-')[1]) % 2 === 0 } : r));
  assert.notEqual(W.gateSummary(coin).status, 'passing');
});
