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

test('flag: only =1 turns it on; unset stays off under preview mode (integration-9 policy)', () => {
  assert.equal(W.radarWireFlag({}), 'off');
  assert.equal(W.radarWireFlag({ [W.RADAR_WIRE_ENV]: '1' }), 'on');
  const prev = process.env[PREVIEW_ENV];
  process.env[PREVIEW_ENV] = '1';
  try {
    assert.equal(W.radarWireFlag({}), 'off', 'preview mode never switches the label on');
    assert.equal(W.radarWireFlag({ [W.RADAR_WIRE_ENV]: '0' }), 'off');
    assert.equal(W.radarWireFlag({ [W.RADAR_WIRE_ENV]: '1' }), 'on');
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

test('appendRadarLedger: serve rows land with as_of; a second run 14 days later grades them once', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { appendRadarLedger } = await import('../scripts/campaign/produce-plans.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radar-ledger-')), 'radar-ledger.jsonl');
  const served = [{ type: 'serve', as_of: AS_OF, league: '4', player: '7', buy_from: '2', sell_to: '3', direction: 'up', value_at: 100 }];
  const first = appendRadarLedger(file, served, { valueNow: () => 130, now: NOW });
  assert.deepEqual([first.served, first.graded, first.bad], [1, 0, 0]);
  fs.appendFileSync(file, 'not json\n');
  const later = appendRadarLedger(file, [], { valueNow: () => 130, now: NOW + 15 * DAY });
  assert.deepEqual([later.graded, later.bad], [1, 1]);
  const again = appendRadarLedger(file, [], { valueNow: () => 130, now: NOW + 16 * DAY });
  assert.equal(again.graded, 0);
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.equal(rows.filter(r => r.type === 'grade').length, 1);
  assert.ok(rows.every(r => typeof r.as_of === 'string'));
});

test('radarReads: the trend from THIS league\'s format (dynasty_values), history days, 48 h news and news alive', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { radarReads } = await import('../scripts/campaign/league-adapter.mjs');
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE player_metrics (player_id INTEGER, source TEXT, value REAL, fetched_at TEXT, PRIMARY KEY (player_id, source));
    CREATE TABLE dynasty_value_history (format_key TEXT, player_id INTEGER, value INTEGER, captured_on TEXT);
    CREATE TABLE dynasty_values (format_key TEXT, player_id INTEGER, value INTEGER, redraft_value INTEGER, trend30 INTEGER,
      retired_at TEXT);
    -- League 1's format (what player_metrics holds) says +1000; this league's format 'f1' says -300.
    INSERT INTO dynasty_values VALUES ('f1', 7, 4900, 4800, -300, NULL), ('f1', 8, 3000, 2900, NULL, NULL),
      ('f2', 7, 5100, 5000, 1000, NULL);
    CREATE TABLE nfl_news_signals (player_id TEXT, signal_type TEXT, status TEXT, unavailable_probability REAL, role_delta REAL,
      published_at TEXT, created_at TEXT);
    INSERT INTO player_metrics VALUES (7, 'fc_value', 5000, ''), (7, 'fc_trend30', 1000, ''), (8, 'fc_value', 3000, '');
    INSERT INTO dynasty_value_history VALUES ('f1', 7, 1, '2026-09-23'), ('f1', 7, 1, '2026-09-24'), ('f2', 7, 1, '2026-09-20');`);
  const ins = raw.prepare('INSERT INTO nfl_news_signals VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('7', 'availability', 'out', 0.9, null, new Date(NOW - 5 * HOUR).toISOString(), '2026-09-23 20:00:00');
  ins.run('7', 'availability', 'out', 0.9, null, new Date(NOW - 80 * HOUR).toISOString(), '2026-09-20 20:00:00');
  const svc = { db: { row: (q, ...p) => raw.prepare(q).get(...p), rows: (q, ...p) => raw.prepare(q).all(...p) } };
  const r = radarReads(svc, { formatKey: 'f1' });
  assert.deepEqual(r.fcTrendOf(7), { value: 4800, trend30: -300 }, 'this format\'s redraft value and trend, not player_metrics\'');
  assert.equal(r.fcTrendOf(8), null, 'no trend row: no trend');
  assert.equal(r.fcFormatKey, 'f1');
  assert.deepEqual(radarReads(svc, { formatKey: 'f2' }).fcTrendOf(7), { value: 5000, trend30: 1000 });
  assert.equal(radarReads(svc, { formatKey: null }).fcTrendOf(7), null, 'no format: no trend (fail closed)');
  assert.equal(r.fcHistoryDays(), 2);
  assert.equal(r.newsOf(7, NOW).length, 1, 'only the 48 h window');
  assert.equal(r.newsAlive(NOW), true);
  assert.equal(r.newsAlive(NOW + 3 * DAY), false);
  const bare = radarReads({ db: { row: () => undefined, rows: () => [] } }, { formatKey: 'f1' });
  assert.deepEqual([bare.fcTrendOf(7), bare.fcHistoryDays(), bare.newsOf(7, NOW).length, bare.newsAlive(NOW)], [null, 0, 0, false]);
});

test('FlipMap prints the why-now line with its status word, and nothing when the flag is off', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { loadWarRoom, textOf } = await import('./helpers/warroom-tsx.mjs');
  const wr = await loadWarRoom();
  try {
    const { default: FlipMap } = await wr.mod('FlipMap');
    const gap = { status: 'ok', value: 0.05, source: 'sim.title', se: 0.01, clears_2se: true, unit: 'title_odds' };
    const price = { status: 'ok', value: 100, source: 'clone.price', unit: 'market_value' };
    const p = v => ({ status: 'ok', value: v, source: 'clone.accept', unit: 'probability', guess: true });
    const flip = { player: '1', buy_from: '3', sell_to: '4', spread: gap, price_a: price, price_b: price,
      legs: { give_a: '11', get_b: '21', p1: p(0.5), p2: p(0.4), p_both: p(0.2), nick_after: { status: 'ok', value: 0.01, source: 'sim.title', unit: 'title_odds' } } };
    const names = { 1: 'Player 1 (WR)', 11: 'Player 11 (RB)', 21: 'Player 21 (QB)' };
    const render = (f, big) => textOf(renderToStaticMarkup(React.createElement(FlipMap, { field: { status: 'ok', value: [f], source: 'sim.title' }, names, big })));
    const w = W.whyNowOf({ radar: 'not_merged', trend: null, news: [badNews(2)], newsAlive: true, now: NOW });
    for (const big of [true, false]) {
      assert.match(render({ ...flip, why_now: w }, big), /Check first: .*news in the last 48 h/);
      assert.doesNotMatch(render(flip, big), /Why now|Check first|Watch:/);
    }
  } finally { wr.cleanup(); }
});

test('RADAR-GRADE: a row is graded in its own league format (#405 finding 2)', () => {
  const as_of = new Date(NOW - 15 * DAY).toISOString();
  const rows = [
    { as_of, league: '4', player: '1', buy_from: '2', sell_to: '3', direction: 'up', value_at: 100, format_key: 't10' },
    { as_of, league: '1', player: '1', buy_from: '2', sell_to: '3', direction: 'up', value_at: 100, format_key: 't8' },
  ];
  const byFormat = { t10: 90, t8: 130 };
  const g = W.gradeLedger(rows, { valueNow: (id, r) => byFormat[r.format_key], now: NOW });
  assert.deepEqual(g.graded.map(r => [r.league, r.move]).sort(), [['1', 'up'], ['4', 'down']]);
});
