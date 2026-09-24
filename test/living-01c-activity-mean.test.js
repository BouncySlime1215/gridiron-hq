/**
 * LIVING-01c: the activity-adjusted team mean in the season sim (R&D r25 IDEA-046).
 *
 *  L1 shifts are league-centred on the two existing signals, clamped to the cap, and a
 *     team with no value (or too few weeks) gets a 0 term with the reason
 *  L2 unfitted coefficients: on, but inert, and the payload says why
 *  L3 flag off (unset, or forced false) is the frozen sim byte-for-byte: no
 *     activity_mean key and identical odds
 *  L4 on, a team whose manager adds more gets a higher weekly mean, and that moves
 *     the title (deterministic fixture: T2 overtakes T1)
 *  L5 GRIDIRON_ACTIVITY_MEAN=1 and preview mode both turn it on; only preview labels it
 *
 * Fixture: test/league-rules-bracket-sim.test.js's deterministic 6-team league
 * (T1 100, T6 90, T2 80, T3 70, T4 60, T5 50 every week; weeks 1-2 carried in).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-living01c-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '3';
delete process.env.GRIDIRON_ACTIVITY_MEAN;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (911, 'HOM', 'Home Team', 'AFC', 'East'), (912, 'AWY', 'Away Team', 'NFC', 'West')`);
for (let w = 1; w <= 6; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 911, ?, 'AWY', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 912, ?, 'HOM', 0)`, w);
}

const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realCorrelation = await import('../server/services/correlation.js');
const realContingency = await import('../server/services/contingency.js');

const STRENGTH = { 1: 100, 2: 80, 3: 70, 4: 60, 5: 50, 6: 90 };
const assets = new Map();
const projMap = new Map();
for (let t = 1; t <= 6; t++) {
  const id = 500 + t;
  assets.set(id, { id, name: `QB ${t}`, position: 'QB', team_abbr: t % 2 ? 'HOM' : 'AWY', espn_id: 8000 + t,
    available: true, current_week_ppg: 10, adj_ppg: 10, ppg: 10, ros_ppg: 10 });
  projMap.set(id, { params: { pid: id, strength: STRENGTH[t] }, volume: { target_share: null } });
}
mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n) => Array.from({ length: n }, () => params.strength)
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/correlation.js', {
  namedExports: { ...realCorrelation, correlatedSampler: (_p, samples) => () => samples.map(s => s[0]) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
const { simulateSeason } = await import('../server/services/season-sim.js?living01c');
const { activityShifts, activityMeanOn, ACTIVITY_MEAN_FIT, ACTIVITY_MEAN_ENV } =
  await import('../server/services/activity-team-mean.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const FIT = Object.freeze({ fitted: true, per_add_per_week: 12, per_dead_start: -3, cap: 30, min_weeks: 2,
  source: 'test' });

function insertLeague(id) {
  const played = { 1: [[1, 5, 150, 100], [2, 6, 140, 20], [3, 4, 120, 100]],
    2: [[1, 6, 150, 20], [2, 5, 140, 100], [4, 3, 110, 90]] };
  const schedule = [];
  for (const [w, games] of Object.entries(played)) {
    for (const [h, a, hp, ap] of games) {
      schedule.push({ matchupPeriodId: Number(w), winner: hp > ap ? 'HOME' : 'AWAY',
        home: { teamId: h, totalPoints: hp }, away: { teamId: a, totalPoints: ap } });
    }
  }
  for (const [h, a] of [[1, 6], [2, 5], [3, 4]]) {
    schedule.push({ matchupPeriodId: 3, winner: 'UNDECIDED', home: { teamId: h }, away: { teamId: a } });
  }
  const payload = {
    teams: [1, 2, 3, 4, 5, 6].map(t => ({ id: t, divisionId: 0,
      roster: { entries: [{ lineupSlotId: 0,
        playerPoolEntry: { player: { id: 8000 + t, fullName: `QB ${t}`, defaultPositionId: 1 } } }] } })),
    schedule,
    settings: { scheduleSettings: { matchupPeriodCount: 3, matchupPeriodLength: 1, playoffTeamCount: 6,
      playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: 6 }] } },
  };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
       payload, current_week, payload_season) VALUES (?, 'espn', ?, 2026, 'Living', '1', 6, 1, ?, ?, 3, 2026)`,
  id, `living-${id}`, JSON.stringify(['QB']), JSON.stringify(payload));
  // T2 adds 3 a week, everyone else 1; nobody left a dead starter in.
  for (let t = 1; t <= 6; t++) {
    run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source) VALUES (?, ?, 'tx_adds_per_week', ?, 2, 'tx')`,
      id, String(t), t === 2 ? 3 : 1);
    run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source) VALUES (?, ?, 'lineup_dead_starts_last_week', 0, 1, 'roster')`,
      id, String(t));
  }
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}
const LG = insertLeague(851);
const odds = (sim, id, key) => sim.teams.find(t => String(t.roster_id) === id)[key];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const bag = entries => new Map(entries.map(([id, metrics, samples]) => [id, { metrics, samples }]));

test('L1: league-centred shifts on the existing signals, clamped, missing values are a 0 term', () => {
  const s = activityShifts(bag([
    ['1', { tx_adds_per_week: 1, lineup_dead_starts_last_week: 0 }, { tx_adds_per_week: 5 }],
    ['2', { tx_adds_per_week: 3, lineup_dead_starts_last_week: 2 }, { tx_adds_per_week: 5 }],
    ['3', { tx_adds_per_week: 2 }, { tx_adds_per_week: 5 }],
    ['4', { tx_adds_per_week: 9 }, { tx_adds_per_week: 1 }], // below min_weeks: withheld
  ]), ['1', '2', '3', '4'], { ...FIT, cap: 10, min_weeks: 4 });
  assert.equal(s.applied, true);
  // adds mean over teams 1-3 = 2; dead mean over teams 1-2 = 1.
  assert.equal(s.shifts.get('1'), 12 * (1 - 2) + -3 * (0 - 1)); // -9
  assert.equal(s.shifts.get('2'), 12 * (3 - 2) + -3 * (2 - 1)); // 9, under the cap
  assert.equal(s.shifts.get('3'), 0, 'adds at the mean, no dead-start value: 0');
  assert.equal(s.shifts.get('4'), 0, 'adds rate on 1 week is below min_weeks: withheld');
  const t4 = s.teams.find(t => t.roster_id === '4');
  assert.deepEqual(t4.missing, ['tx_adds_per_week', 'lineup_dead_starts_last_week']);
  assert.match(t4.missing_reason, /league mean/);
  const big = activityShifts(bag([['1', { tx_adds_per_week: 0 }, { tx_adds_per_week: 5 }],
    ['2', { tx_adds_per_week: 10 }, { tx_adds_per_week: 5 }]]), ['1', '2'], { ...FIT, cap: 10 });
  assert.equal(big.shifts.get('2'), 10, 'clamped to +cap');
  assert.equal(big.shifts.get('1'), -10, 'clamped to -cap');
  assert.equal(big.teams.find(t => t.roster_id === '2').capped, true);
});

test('L2: unfitted coefficients leave it inert with the reason, and the shipped fit says whether it is fitted', () => {
  const s = activityShifts(bag([['1', { tx_adds_per_week: 5 }, { tx_adds_per_week: 5 }]]), ['1'],
    { ...FIT, fitted: false });
  assert.equal(s.applied, false);
  assert.match(s.reason, /not fitted/);
  assert.equal(s.shifts.size, 0);
  assert.equal(typeof ACTIVITY_MEAN_FIT.fitted, 'boolean');
  if (!ACTIVITY_MEAN_FIT.fitted) {
    const sim = simulateSeason(LG, { runs: 3, fromWeek: 3, activityMean: true });
    assert.equal(sim.activity_mean.applied, false);
    assert.match(sim.activity_mean.reason, /not fitted/);
    assert.equal(odds(sim, '1', 'title_odds'), 1, 'inert: the frozen result');
  } else {
    assert.ok(Number.isFinite(ACTIVITY_MEAN_FIT.per_add_per_week) && Number.isFinite(ACTIVITY_MEAN_FIT.per_dead_start));
  }
});

test('L3: off is the frozen sim exactly', () => {
  const unset = withEnv({ [ACTIVITY_MEAN_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null },
    () => simulateSeason(LG, { runs: 3, fromWeek: 3 }));
  const forcedOff = withEnv({ [ACTIVITY_MEAN_ENV]: '1' },
    () => simulateSeason(LG, { runs: 3, fromWeek: 3, activityMean: false }));
  assert.equal('activity_mean' in unset, false);
  assert.deepEqual(forcedOff, unset);
  assert.equal(odds(unset, '1', 'title_odds'), 1, 'control: the best scorer wins the title');
});

test('L4: on, the team that adds more gets a higher weekly mean and takes the title', () => {
  const sim = simulateSeason(LG, { runs: 3, fromWeek: 3, activityMean: { fit: FIT } });
  assert.ifError(sim.error);
  const shift = id => sim.activity_mean.teams.find(t => t.roster_id === id).shift;
  // adds mean = (3 + 5) / 6 = 4/3: T2 +20, the rest -4.
  assert.equal(shift('2'), 20);
  assert.equal(shift('1'), -4);
  assert.equal(sim.activity_mean.applied, true);
  assert.equal(odds(sim, '2', 'title_odds'), 1, 'T2 (80 + 20) now outscores T1 (100 - 4)');
  assert.equal(odds(sim, '1', 'title_odds'), 0);
  const off = simulateSeason(LG, { runs: 3, fromWeek: 3, activityMean: false });
  assert.ok(odds(sim, '2', 'expected_points') > odds(off, '2', 'expected_points'));
});

test('L5: the site flag and preview mode both turn it on; only preview labels the payload', () => {
  withEnv({ [ACTIVITY_MEAN_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    assert.deepEqual(activityMeanOn(), { on: false, preview: false });
  });
  withEnv({ [ACTIVITY_MEAN_ENV]: '1', GRIDIRON_PREVIEW_UNCONFIRMED: null }, () => {
    assert.deepEqual(activityMeanOn(), { on: true, preview: false });
    const sim = simulateSeason(LG, { runs: 3, fromWeek: 3 });
    assert.equal(sim.activity_mean.on, true);
    assert.equal(sim.activity_mean.preview, undefined);
  });
  withEnv({ [ACTIVITY_MEAN_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => {
    assert.deepEqual(activityMeanOn(), { on: true, preview: true });
    const sim = simulateSeason(LG, { runs: 3, fromWeek: 3 });
    assert.equal(sim.activity_mean.preview, true);
    assert.match(sim.activity_mean.preview_reason, /LIVING-01c/);
  });
});
