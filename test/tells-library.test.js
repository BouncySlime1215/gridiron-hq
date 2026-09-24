// TELLS-01a: the JS tell library (server/services/tells/library.js) and refitTells
// (server/services/tells/refit.js). Spec RED tests 1, 2 and 5:
//   (1) as-of safety: an event 1 second after asOf changes no tell;
//   (2) library value == Python value on a 3-team synthetic fixture, for every template
//       (golden file written by `scripts/rnd/tells-factory.py --golden`);
//   (5) refitTells is idempotent and writes 0 rows.
// The fixture is synthetic: no real league, roster, player ids or names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  computeAllTells, computeTells, survivingTellIds, TELL_IDS, TELL_EVENT_TYPES, LIBRARY_VERSION,
} from '../server/services/tells/library.js';
import { refitTells, tellsEnabled } from '../server/services/tells/refit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(readFileSync(path.join(root, 'test/fixtures/tells-golden-fixture.json'), 'utf8'));
const golden = JSON.parse(readFileSync(path.join(root, 'test/fixtures/tells-golden-values.json'), 'utf8'));
const screen = JSON.parse(readFileSync(path.join(root, 'server/data/tells-screen.json'), 'utf8'));

const CUR = fx.current.lg;
const PREV = { leagueId: fx.previous.lg, playoffWeekStart: fx.previous.playoff_week_start };
// A team-week becomes final on the Tuesday after its week's Thursday start.
const weekFinal = (season, week) => new Date(Date.UTC(season, 8, 3 + 7 * (week - 1) + 5, 12)).toISOString();
const seasonOf = lg => (lg === CUR ? 2024 : 2023);

function toEvents(f) {
  return [
    ...f.transactions.map((t, i) => ({
      id: i + 1, event_type: TELL_EVENT_TYPES.transaction, as_of: new Date(t.ms).toISOString(), league_id: t.lg,
      team_id: null, payload: { week: t.week, type: t.type, status: t.status, roster_ids: t.roster_ids, adds: t.adds,
        drops: t.drops, bid: t.bid ?? null, picks: t.picks, latency_ms: t.lat_ms ?? null },
    })),
    ...f.team_weeks.map((w, i) => ({
      id: 100000 + i, event_type: TELL_EVENT_TYPES.teamWeek, as_of: weekFinal(seasonOf(w.lg), w.week), league_id: w.lg,
      team_id: String(w.roster), payload: { week: w.week, points: w.points, opp: w.opp, starters: w.starters,
        players: w.players },
    })),
  ];
}
const EVENTS = toEvents(fx);
const END = '2025-06-01T00:00:00.000Z';
const opts = asOf => ({ asOf, leagueId: CUR, previous: PREV, positions: fx.positions });
const close = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

test('golden: the library equals the Python generator for every template on the 3-team fixture', () => {
  assert.equal(golden.generator, LIBRARY_VERSION, 'golden file written by another generator version');
  assert.equal(Object.keys(golden.teams).length, 3);
  const got = computeAllTells(EVENTS, opts(END));
  assert.deepEqual([...got.keys()].map(String).sort(), Object.keys(golden.teams).sort());
  const ids = new Set(TELL_IDS);
  let compared = 0; let defined = 0;
  const templatesDefined = new Set();
  for (const [rid, py] of Object.entries(golden.teams)) {
    const js = got.get(Number(rid));
    for (const [id, v] of Object.entries(py)) {
      assert.ok(ids.has(id), `Python tell ${id} is not in the library's TELL_IDS`);
      assert.ok(close(js[id], v), `roster ${rid} ${id}: js ${js[id]} vs python ${v}`);
      compared += 1;
      if (v !== null) { defined += 1; templatesDefined.add(id.split('|').slice(0, 2).join('|')); }
    }
    // A column the generator does not produce for this league (family absent in a window) is undefined in JS too.
    for (const id of TELL_IDS) if (!(id in py)) assert.equal(js[id], null, `roster ${rid} ${id} defined only in JS`);
  }
  assert.equal(compared, 3 * Object.keys(golden.teams['1']).length);
  assert.ok(defined >= 2200, `only ${defined} defined values compared`);
  // every stat of every family kind is exercised with a real number somewhere
  const stats = new Set([...templatesDefined].map(t => `${t.split('|')[0].split(':')[0]}|${t.split('|')[1]}`));
  for (const s of ['ADD_FA|rate', 'CLAIM_WON|bid', 'CLAIM_ALL|prem', 'CLAIM_FAIL|loglat', 'CLAIM_WON|lastlat',
    'DROP|burst', 'TRADE|medhour', 'ADD_ANY|afterloss', 'LINEUP|lu_changed', 'LINEUP|lu_kdef_stream', 'LINEUP|lu_empty',
    'TRADESHAPE|picks', 'DROPTEN|tenure', 'DROPTEN|origshare', 'PREV|n_start_trade', 'PREV|win_pct']) {
    assert.ok(stats.has(s), `no defined golden value for ${s}`);
  }
});

test('the library covers the whole screen: every candidate and every surviving tell id', () => {
  const armA = new Set(screen.tells.filter(t => t.arm === 'A').map(t => t.id));
  const libA = new Set(TELL_IDS.filter(id => !id.startsWith('PREV|')));
  assert.deepEqual([...armA].sort(), [...libA].sort());
  const armB = new Set(screen.tells.filter(t => t.arm === 'B').map(t => t.id));
  assert.deepEqual([...armB].sort(), TELL_IDS.filter(id => id.startsWith('PREV|')).sort());
  const surv = survivingTellIds(screen);
  assert.ok(surv.length > 0 && surv.every(id => TELL_IDS.includes(id)));
  assert.ok(surv.every(id => !id.startsWith('PREV|')), 'arm B is lead: it must not be served by default');
});

test('as-of safety: an event 1 second after asOf changes no tell', () => {
  const asOf = '2024-10-10T12:00:00.000Z'; // mid week 6 of the fixture season
  const before = computeAllTells(EVENTS, opts(asOf));
  const later = new Date(Date.parse(asOf) + 1000).toISOString();
  const extra = [
    { event_type: TELL_EVENT_TYPES.transaction, as_of: later, league_id: CUR, payload: { week: 6, type: 'waiver',
      status: 'complete', roster_ids: [1], adds: { 101: 1 }, drops: { 102: 1 }, bid: 50, picks: 0, latency_ms: 1000 } },
    { event_type: TELL_EVENT_TYPES.transaction, as_of: later, league_id: CUR, payload: { week: 6, type: 'trade',
      status: 'complete', roster_ids: [1, 2], adds: { 103: 1, 104: 2 }, drops: { 103: 2, 104: 1 }, picks: 1 } },
    { event_type: TELL_EVENT_TYPES.teamWeek, as_of: later, league_id: CUR, team_id: '3', payload: { week: 5,
      points: 200, opp: null, starters: ['0', '0'], players: ['101'] } },
    { event_type: TELL_EVENT_TYPES.transaction, as_of: later, league_id: PREV.leagueId, payload: { week: 3,
      type: 'trade', status: 'complete', roster_ids: [2, 3], adds: { 105: 2 }, drops: { 105: 3 }, picks: 0 } },
  ];
  const after = computeAllTells([...EVENTS, ...extra], opts(asOf));
  assert.deepEqual(after, before);
  // and the same events stamped AT asOf do count (the cutoff is inclusive, not a no-op)
  const atCut = computeAllTells([...EVENTS, ...extra.map(e => ({ ...e, as_of: asOf }))], opts(asOf));
  assert.notDeepEqual(atCut, before);
  assert.throws(() => computeAllTells(EVENTS, { leagueId: CUR }), /asOf is required/);
});

test('computeTells returns only the requested (surviving) tells', () => {
  const ids = survivingTellIds(screen);
  const got = computeTells(EVENTS, { ...opts(END), ids });
  for (const vals of got.values()) assert.deepEqual(Object.keys(vals).sort(), [...ids].sort());
});

// ---- refitTells: a real node:sqlite database holding the events; count every row before and after.
function eventDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE engine_events (id INTEGER PRIMARY KEY, event_type TEXT NOT NULL, as_of TEXT NOT NULL,
    league_id INTEGER, team_id TEXT, payload TEXT NOT NULL);
    CREATE TABLE engine_state (id INTEGER PRIMARY KEY, entity_id TEXT, field TEXT, value TEXT, as_of TEXT)`);
  const ins = db.prepare('INSERT INTO engine_events (id, event_type, as_of, league_id, team_id, payload) VALUES (?,?,?,?,?,?)');
  for (const e of EVENTS) ins.run(e.id, e.event_type, e.as_of, e.league_id, e.team_id, JSON.stringify(e.payload));
  return db;
}
const counts = db => ['engine_events', 'engine_state'].map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);

test('refitTells is idempotent and writes 0 rows', async () => {
  const db = eventDb();
  const statements = [];
  const prepare = db.prepare.bind(db);
  const loadEvents = async ({ asOf, leagueId }) => {
    const sql = 'SELECT * FROM engine_events WHERE league_id = ? AND as_of <= ? ORDER BY as_of, id';
    statements.push(sql);
    return prepare(sql).all(leagueId, new Date(asOf).toISOString()).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  };
  const before = counts(db);
  const args = { asOf: '2024-10-20T00:00:00.000Z', leagues: [{ leagueId: CUR, previous: PREV }], loadEvents,
    positions: fx.positions, enabled: true };
  const a = await refitTells(args);
  const b = await refitTells(args);
  assert.deepEqual(b, a, 'a second refit at the same asOf returned something else');
  assert.deepEqual(counts(db), before, 'refitTells changed a table');
  assert.ok(statements.every(s => /^\s*SELECT/i.test(s)), 'refitTells issued a non-SELECT statement');
  const ids = survivingTellIds(screen);
  assert.equal(a.enabled, true);
  assert.equal(a.rows.length, 3 * ids.length);
  for (const r of a.rows) {
    assert.ok(ids.includes(r.tell_id));
    if (r.value != null && r.k_weeks != null) {
      const want = (r.n_weeks * r.value + r.k_weeks * r.prior_mean) / (r.n_weeks + r.k_weeks);
      assert.ok(Math.abs(r.shrunk - want) < 1e-5, `${r.tell_id} shrink`);
      if (r.k_weeks > 0) assert.ok(Math.abs(r.shrunk - r.prior_mean) <= Math.abs(r.value - r.prior_mean) + 1e-9);
    }
  }
  // walk-forward: a refit as of an earlier time only sees earlier weeks
  const early = await refitTells({ ...args, asOf: '2024-09-12T00:00:00.000Z' });
  const nEarly = early.rows.find(r => r.tell_id.endsWith('|w46'))?.n_weeks;
  assert.equal(nEarly, 0, 'weeks 4-6 observed before they were played');
});

test('refitTells is off by default: no flag, no reads, no rows', async () => {
  let reads = 0;
  const res = await refitTells({ asOf: END, leagues: [{ leagueId: CUR }], env: {}, loadEvents: async () => { reads += 1; return []; } });
  assert.deepEqual(res.rows, []);
  assert.equal(res.enabled, false);
  assert.equal(reads, 0);
  assert.equal(tellsEnabled({ GRIDIRON_TELLS_ENABLED: '1' }), true);
  assert.equal(tellsEnabled({}), false);
  await assert.rejects(() => refitTells({ leagues: [] }), /needs asOf/);
});
