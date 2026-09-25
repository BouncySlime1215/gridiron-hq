/**
 * BITEMPORAL (ONE-PLAN 4d night 7 + 4b row 12): two clocks on the inputs that
 * feed decisions, and the carried-in standings checked against ESPN's own record.
 *
 * 1. `nfl_injuries.available_at` — when THIS machine first held the row's current
 *    value (availability time). `modified_at` stays the source's own claim (event
 *    time) and is never overwritten with ours: upstream dropped `date_modified` for
 *    2025-26, and filling it with a capture instant would turn "unknown" into a
 *    fake source stamp. An unchanged re-sync keeps the earlier stamp; a changed
 *    report moves it; a legacy row with no stamp gets the capture instant, which is
 *    an upper bound on when we held it (late, never early), so a point-in-time read
 *    gated on it can only under-use a row, never read one it did not yet have.
 *
 * 2. `reconcileStandings` — season-sim carries a real record into the sim by
 *    re-deriving it from `payload.schedule`. ESPN publishes the official record on
 *    `payload.teams[].record.overall`. The check compares the two per roster id and
 *    says which differ. Shadow only: it adds a field under a flag and moves no number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-bitemporal-inputs-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const realFetch = globalThis.fetch;
let nextCsv = '';
globalThis.fetch = async url => {
  if (!String(url).includes('injuries_')) return realFetch(url);
  return { ok: true, body: new Response(nextCsv).body };
};

const { db, rows, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { syncInjuries } = await import('../server/services/nfl-advanced.js');
const { weekKeyedTableMutationRisk } = await import('../server/services/nfl-bitemporal.js');
const { reconcileStandings, standingsCheckField, STANDINGS_RECONCILE_ENV } =
  await import('../server/services/standings-reconcile.js');
const { __test: sim } = await import('../server/services/season-sim.js');

test.after(() => {
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const HEADER = 'season,week,gsis_id,team,full_name,position,report_status,practice_status,'
  + 'report_primary_injury,practice_primary_injury,date_modified,game_type\n';
const injuryRow = (o = {}) => {
  const r = { season: 2026, week: 3, gsis_id: '00-0000001', team: 'HOU', full_name: 'Test Player',
    position: 'WR', report_status: 'Questionable', practice_status: 'Limited', report_primary_injury: 'Hamstring',
    practice_primary_injury: 'Hamstring', date_modified: '', game_type: 'REG', ...o };
  return [r.season, r.week, r.gsis_id, r.team, r.full_name, r.position, r.report_status, r.practice_status,
    r.report_primary_injury, r.practice_primary_injury, r.date_modified, r.game_type].join(',');
};
const csv = (...lines) => HEADER + lines.join('\n') + '\n';
const injury = gsis => rows(`SELECT modified_at, available_at, report_status FROM nfl_injuries WHERE gsis_id=?`, gsis)[0];

// ---------------------------------------------------------------- injuries

test('migration adds available_at to nfl_injuries', () => {
  const cols = rows('PRAGMA table_info(nfl_injuries)').map(c => c.name);
  assert.ok(cols.includes('available_at'), `columns: ${cols.join(',')}`);
  assert.ok(cols.includes('modified_at'), 'the source event clock is still there');
});

test('a new row is stamped with the capture instant; the source clock stays NULL when the source gave none', async () => {
  const before = new Date().toISOString();
  nextCsv = csv(injuryRow({ gsis_id: '00-0000101' }));
  await syncInjuries([2026]);
  const after = new Date().toISOString();
  const r = injury('00-0000101');
  assert.ok(r.available_at >= before && r.available_at <= after, `available_at ${r.available_at}`);
  assert.equal(r.modified_at, null, 'no date_modified upstream: event time stays unknown, never our clock');
});

test('an unchanged re-sync keeps the first availability stamp', async () => {
  nextCsv = csv(injuryRow({ gsis_id: '00-0000102' }));
  await syncInjuries([2026]);
  const first = injury('00-0000102').available_at;
  await new Promise(r => setTimeout(r, 5));
  await syncInjuries([2026]);
  assert.equal(injury('00-0000102').available_at, first,
    'asking again is not learning again: the row was available from the first capture');
});

test('a changed report moves the availability stamp to the capture that first held it', async () => {
  nextCsv = csv(injuryRow({ gsis_id: '00-0000103', report_status: 'Questionable' }));
  await syncInjuries([2026]);
  const first = injury('00-0000103').available_at;
  await new Promise(r => setTimeout(r, 5));
  nextCsv = csv(injuryRow({ gsis_id: '00-0000103', report_status: 'Out' }));
  await syncInjuries([2026]);
  const r = injury('00-0000103');
  assert.equal(r.report_status, 'Out');
  assert.ok(r.available_at > first, `${r.available_at} should be after ${first}`);
});

test('a legacy row with no stamp gets the capture instant (late, never early)', async () => {
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status,
       practice_status, injury, modified_at) VALUES (2026, 3, '00-0000104', 'HOU', 'Legacy', 'WR',
       'Questionable', 'Limited', 'Hamstring', NULL)`);
  assert.equal(injury('00-0000104').available_at, null);
  const before = new Date().toISOString();
  nextCsv = csv(injuryRow({ gsis_id: '00-0000104', full_name: 'Legacy' }));
  await syncInjuries([2026]);
  assert.ok(injury('00-0000104').available_at >= before);
});

test('the source date_modified is kept as the event clock, unchanged by the availability stamp', async () => {
  nextCsv = csv(injuryRow({ gsis_id: '00-0000105', date_modified: '2026-09-23T20:00:00Z' }));
  await syncInjuries([2026]);
  const r = injury('00-0000105');
  assert.equal(r.modified_at, '2026-09-23T20:00:00Z');
  assert.notEqual(r.available_at, r.modified_at);
});

test('weekKeyedTableMutationRisk reports availability-clock coverage per injury season', () => {
  run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status,
       practice_status, injury, modified_at) VALUES (2025, 9, '00-0000201', 'HOU', 'Old', 'WR', 'Out', NULL, NULL, NULL)`);
  const out = weekKeyedTableMutationRisk();
  const s2026 = out.tables.nfl_injuries.find(s => s.season === 2026);
  const s2025 = out.tables.nfl_injuries.find(s => s.season === 2025);
  assert.equal(s2026.available_stamped, s2026.rows, 'every 2026 row the loader touched is stamped');
  assert.equal(s2025.available_stamped, 0);
  assert.equal(s2025.verdict, 'no_timestamp_evidence', 'the old verdict still reads the source clock only');
});

// ---------------------------------------------------------------- standings

/** Six-team ESPN league, three completed weeks; team 1 is 3-0. */
function espnLeague({ official = null, median = false, platform = 'espn' } = {}) {
  const games = [
    [1, 1, 2, 120, 100], [1, 3, 4, 90, 95], [1, 5, 6, 110, 110],
    [2, 1, 3, 130, 80], [2, 2, 5, 100, 101], [2, 4, 6, 70, 99],
    [3, 1, 4, 115, 114], [3, 2, 6, 88, 120], [3, 3, 5, 105, 90],
    [4, 1, 5, 0, 0], [4, 2, 3, 0, 0], [4, 4, 6, 0, 0] // week 4 unplayed
  ];
  const schedule = games.map(([w, h, a, hp, ap]) => ({
    matchupPeriodId: w, home: { teamId: h, totalPoints: hp }, away: { teamId: a, totalPoints: ap } }));
  const teams = [1, 2, 3, 4, 5, 6].map(id => {
    const rec = official?.[id] ?? derivedOfficial(games, id);
    return { id, record: { overall: rec } };
  });
  return { platform, season: 2026, payload: JSON.stringify({ schedule, teams }), median };
}
function derivedOfficial(games, id) {
  let wins = 0, losses = 0, ties = 0, pointsFor = 0;
  for (const [w, h, a, hp, ap] of games) {
    if (w >= 4) continue;
    if (h !== id && a !== id) continue;
    const mine = h === id ? hp : ap, theirs = h === id ? ap : hp;
    pointsFor += mine;
    if (mine > theirs) wins++; else if (mine < theirs) losses++; else ties++;
  }
  return { wins, losses, ties, pointsFor };
}
const teamList = [1, 2, 3, 4, 5, 6].map(id => ({ roster_id: String(id) }));
const derive = (lg, fromWeek) => sim.initialRecords(lg, teamList, fromWeek, false);

test('the derived record matches ESPN\'s official record: status match, no mismatches', () => {
  const lg = espnLeague();
  const out = reconcileStandings(lg, derive(lg, 4), { fromWeek: 4 });
  assert.equal(out.status, 'match');
  assert.equal(out.teams_checked, 6);
  assert.deepEqual(out.mismatches, []);
  assert.equal(out.weeks_compared, 3);
});

test('a team whose official record differs is named by roster id with both sides', () => {
  const official = { 1: { wins: 2, losses: 1, ties: 0, pointsFor: 365 } }; // ESPN says 2-1 (e.g. a stat correction)
  const lg = espnLeague({ official });
  const out = reconcileStandings(lg, derive(lg, 4), { fromWeek: 4 });
  assert.equal(out.status, 'mismatch');
  assert.equal(out.mismatches.length, 1);
  const m = out.mismatches[0];
  assert.equal(m.roster_id, '1');
  assert.equal(m.derived_w, 3); assert.equal(m.official_w, 2);
  assert.equal(m.derived_pf, 365); assert.equal(m.official_pf, 365);
});

test('a points-for difference alone is a mismatch too', () => {
  const official = { 2: { wins: 0, losses: 3, ties: 0, pointsFor: 290 } };
  const lg = espnLeague({ official });
  const out = reconcileStandings(lg, derive(lg, 4), { fromWeek: 4 });
  assert.equal(out.status, 'mismatch');
  assert.equal(out.mismatches[0].roster_id, '2');
  assert.equal(out.mismatches[0].pf_diff, 288 - 290);
});

test('an official record from a different week is window_differs, not a false mismatch', () => {
  const lg = espnLeague();
  const out = reconcileStandings(lg, derive(lg, 3), { fromWeek: 3 }); // sim starts at week 3; ESPN has 3 games
  assert.equal(out.status, 'window_differs');
  assert.deepEqual(out.mismatches, []);
});

test('no official record in the payload says so', () => {
  const lg = espnLeague();
  const p = JSON.parse(lg.payload); p.teams = p.teams.map(t => ({ id: t.id }));
  lg.payload = JSON.stringify(p);
  assert.equal(reconcileStandings(lg, derive(lg, 4), { fromWeek: 4 }).status, 'no_official_record');
});

test('sleeper leagues and week 1 are not checked, and say why', () => {
  const s = espnLeague({ platform: 'sleeper' });
  assert.equal(reconcileStandings(s, new Map(), { fromWeek: 4 }).status, 'unsupported_platform');
  const lg = espnLeague();
  assert.equal(reconcileStandings(lg, derive(lg, 1), { fromWeek: 1 }).status, 'nothing_carried_in');
});

test('the season-sim field is absent by default and present only under the flag', () => {
  const lg = espnLeague();
  delete process.env[STANDINGS_RECONCILE_ENV];
  assert.deepEqual(standingsCheckField(lg, derive(lg, 4), 4, false), {});
  process.env[STANDINGS_RECONCILE_ENV] = '1';
  try {
    const f = standingsCheckField(lg, derive(lg, 4), 4, false);
    assert.equal(f.standings_check.status, 'match');
    assert.equal(f.standings_check.shadow, true);
  } finally { delete process.env[STANDINGS_RECONCILE_ENV]; }
});

test('season-sim spreads the field from the records it carries in (source guard)', () => {
  const src = fs.readFileSync(new URL('../server/services/season-sim.js', import.meta.url), 'utf8');
  assert.match(src, /standingsCheckField\(lg, startingRecords, fromWeek, medianGame\)/);
});
