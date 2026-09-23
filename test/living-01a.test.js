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
 *   5. the producer is default-off, writes through its private writer with a
 *      reason_chain, cites only events at or before as_of, and a re-run is a no-op.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-living01a-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
delete process.env.GRIDIRON_LIVING01A_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { db, run, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const m = await import('../server/services/engine/activity-model.js');
const { appendEvents } = await import('../server/services/engine/events.js');
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

/* -------------------------------------------------------------- producer */
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (81, 'espn', 'liv-81', 2026, 'Fixture', '1', 4, 1, '{}', '2026-09-18 01:00:00')`);
db.exec(`CREATE TABLE IF NOT EXISTS manager_signals (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  roster_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  n INTEGER,
  source TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, roster_id, metric))`);
for (const [team, dead] of [['1', 0], ['2', 2], ['3', 0]]) {
  run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source) VALUES (81, ?, 'lineup_dead_starts_last_week', ?, 9, 'roster')`, team, dead);
}
const tx = (key, asOf, period, team) => ({ event_type: 'espn.transaction', as_of: asOf, league_id: 81, team_id: String(team),
  source: 'fixture-living', source_key: key,
  payload: { season: 2026, type: 'FREEAGENT', status: 'EXECUTED', scoring_period: period, items: [{ type: 'ADD', to_team_id: team }] } });
const { events: added } = appendEvents([
  tx('a1', '2026-09-09T12:00:00Z', 1, 1), tx('a2', '2026-09-16T12:00:00Z', 2, 1), tx('a3', '2026-09-16T13:00:00Z', 2, 1),
  tx('b1', '2026-09-09T12:00:00Z', 1, 2),
  tx('late', '2026-09-30T12:00:00Z', 2, 3), // stamped after the cutoff: must not be read
]);
const idOf = key => added.find(e => e.source_key === key).id;

test('the producer is default-off and writes nothing', async () => {
  const r = await m.produceActivityStates({ leagueId: 81, season: 2026, through: 2, asOf: '2026-09-20T00:00:00Z' });
  assert.match(r.off, /GRIDIRON_LIVING01A_ENABLED/);
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_state WHERE field = 'activity.manager'`).n, 0);
});

test('with the flag on it writes one row per manager, with its reason chain, as of the cutoff', async () => {
  process.env.GRIDIRON_LIVING01A_ENABLED = '1';
  try {
    const r = await m.produceActivityStates({ leagueId: 81, season: 2026, through: 2, asOf: '2026-09-20T00:00:00Z', weeksLeft: 12 });
    assert.equal(r.off, null);
    assert.deepEqual(r.teams.map(t => t.team), ['1', '2', '3']);
    assert.equal(r.written, 3);
    const got = rows(`SELECT entity_id, value, reason_chain, event_ids, producer, producer_version, league_id
                      FROM engine_state WHERE field = 'activity.manager' ORDER BY entity_id`)
      .map(x => ({ ...x, value: JSON.parse(x.value), reason_chain: JSON.parse(x.reason_chain), event_ids: JSON.parse(x.event_ids) }));
    assert.deepEqual(got.map(x => x.entity_id), ['81:1', '81:2', '81:3']);
    for (const x of got) {
      assert.equal(x.producer, 'activity');
      assert.equal(x.producer_version, m.MODEL_VERSION);
      assert.equal(x.league_id, 81);
      assert.ok(m.STATES.includes(x.value.state));
      assert.ok(x.reason_chain.contributions.length >= 2);
      assert.equal(x.value.preview, undefined, 'on through its own flag, not preview');
    }
    const [t1, t2, t3] = got;
    assert.deepEqual(t1.event_ids.sort(), [idOf('a1'), idOf('a2'), idOf('a3')].sort());
    assert.equal(t1.value.rates.adds_per_week.raw, 1.5);
    assert.ok(!t3.event_ids.includes(idOf('late')), 'an event after as_of leaked in');
    assert.equal(t3.value.rates.adds_per_week.raw, 0, 'a manager with no adds is zero, not unknown');
    assert.equal(t2.value.rates.lineup_error_rate.raw, 1, "#203's dead starts are read, not recounted");
    assert.ok(t3.reason_chain.contributions.some(c => /0 adds in 2 weeks/.test(c.text)));
    assert.ok(t1.value.probs.engaged > t3.value.probs.engaged);
    const again = await m.produceActivityStates({ leagueId: 81, season: 2026, through: 2, asOf: '2026-09-20T00:00:00Z' });
    assert.equal(again.written, 0);
    assert.equal(again.skipped, 3, 'a re-run at the same as_of must be a no-op');
  } finally {
    delete process.env.GRIDIRON_LIVING01A_ENABLED;
  }
});

test('the preview switch turns it on only where PREVIEW-01 is built, and labels it', async () => {
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try {
    const gate = await m.activityEnabled();
    const built = fs.existsSync(path.join(root, 'server/services/preview-mode.js'));
    assert.deepEqual(gate, built ? { on: true, preview: true } : { on: false, preview: false });
    if (built) {
      const r = await m.produceActivityStates({ leagueId: 81, season: 2026, through: 2, asOf: '2026-09-21T00:00:00Z' });
      assert.equal(r.written, 3);
      const v = JSON.parse(row(`SELECT value FROM engine_state WHERE field = 'activity.manager' AND as_of = '2026-09-21T00:00:00.000Z' LIMIT 1`).value);
      assert.equal(v.preview, true);
      assert.match(v.preview_reason, /default-off/);
    }
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
  assert.equal(Object.values(m).some(v => v && typeof v === 'object' && v.field === 'activity.manager'), false);
});
