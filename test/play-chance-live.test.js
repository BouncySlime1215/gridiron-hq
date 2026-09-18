/**
 * Chance to play, live week: the week's designation dominates the role prior
 * (contingency.js, play-chance-live).
 *
 * The bug: the role layer (49174d4) reads only the NFL injury report. ESPN's
 * current designation, which is what the league itself shows, never reached
 * it. On the 2026-W2 sync:
 *   - Zach Charbonnet (ESPN OUT, league 3 bench) was priced 0.805 to play and
 *     would have been ~0.9+ with role rates on file;
 *   - A.J. Brown (ESPN INJURED RESERVE) read 0.959 with role rates;
 *   - four ESPN-Questionable players with no NFL game status yet (mid-week)
 *     would have been started on the healthy-starter role cell.
 * The designation (the more severe of the NFL game status and ESPN's current
 * status, ESPN only for the live ESPN scoring period) now picks the cell; the
 * role (tier, games missed) and the team's dialect for that designation refine it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-play-chance-live-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
// Namespace import: a missing export fails its own test, not the whole file.
const C = await import('../server/services/contingency.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------ weekDesignation */

test('ESPN OUT, INJURED RESERVE and SUSPENSION with no NFL report are an out designation from ESPN', () => {
  for (const status of ['OUT', 'INJURY_RESERVE', 'SUSPENSION']) {
    const d = C.weekDesignation({ report: null, espnStatus: status, team: 'SEA' });
    assert.equal(d.designation, 'out', status);
    assert.equal(d.source, 'espn', status);
    assert.equal(C.normReportStatus(d.report.report_status), 'out', status);
    assert.match(d.report.report_status, /ESPN/, 'the label says where the designation came from');
    assert.equal(d.report.team, 'SEA', 'the team dialect needs a team');
  }
});

test('ESPN QUESTIONABLE on a mid-week NFL practice row keeps the NFL practice status', () => {
  const report = { team: 'NO', report_status: '', practice_status: 'Limited Participation in Practice' };
  const d = C.weekDesignation({ report, espnStatus: 'QUESTIONABLE', team: 'NO' });
  assert.equal(d.designation, 'questionable');
  assert.equal(d.source, 'espn');
  assert.equal(C.normReportStatus(d.report.report_status), 'questionable');
  assert.equal(d.report.practice_status, 'Limited Participation in Practice');
  assert.equal(d.report.team, 'NO');
});

test('the more severe designation wins, whichever source it comes from', () => {
  const nflOut = C.weekDesignation({ report: { team: 'X', report_status: 'Out', practice_status: '' }, espnStatus: 'ACTIVE' });
  assert.equal(nflOut.designation, 'out');
  assert.equal(nflOut.source, 'nfl');
  assert.equal(nflOut.report.report_status, 'Out', 'an NFL designation is passed through untouched');

  const upgraded = C.weekDesignation({ report: { team: 'X', report_status: 'Questionable', practice_status: 'Limited' }, espnStatus: 'OUT' });
  assert.equal(upgraded.designation, 'out');
  assert.equal(upgraded.source, 'espn');
  assert.equal(upgraded.report.practice_status, 'Limited');

  const nflDoubtful = C.weekDesignation({ report: { team: 'X', report_status: 'Doubtful', practice_status: '' }, espnStatus: 'QUESTIONABLE' });
  assert.equal(nflDoubtful.designation, 'doubtful');
  assert.equal(nflDoubtful.source, 'nfl');
});

test('ESPN DAY_TO_DAY is a questionable designation; ACTIVE, PROBABLE and no status are none', () => {
  const dtd = C.weekDesignation({ report: null, espnStatus: 'DAY_TO_DAY', team: 'GB' });
  assert.equal(dtd.designation, 'questionable');
  assert.equal(C.normReportStatus(dtd.report.report_status), 'questionable');
  for (const status of ['ACTIVE', 'PROBABLE', 'NORMAL', null, undefined, '']) {
    const d = C.weekDesignation({ report: null, espnStatus: status, team: 'GB' });
    assert.equal(d.report, null, String(status));
    assert.equal(d.designation, null, String(status));
  }
  const practiceOnly = { team: 'GB', report_status: '', practice_status: 'Full Participation in Practice' };
  const kept = C.weekDesignation({ report: practiceOnly, espnStatus: 'ACTIVE' });
  assert.equal(kept.report, practiceOnly);
  assert.equal(kept.designation, null);
});

/* ------------------------------------------- weeklyAvailability, live week */

const player = (id, name, position, gsis, espn) =>
  run('INSERT INTO players (id, name, position, gsis_id, espn_id) VALUES (?,?,?,?,?)', id, name, position, gsis, espn);
const appear = (id, season, week, team, position, pct) => {
  run(`INSERT INTO player_week_usage (player_id, season, week, team, position, targets, carries, attempts)
       VALUES (?,?,?,?,?,5,0,0)`, id, season, week, team, position);
  run('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)',
    id, season, week, Math.max(1, Math.round(pct * 65)), pct);
};

// Team AAA, 2025 weeks 1-5; week 6 is the live ESPN scoring period. Every one of
// these is a healthy-looking starter by role (0.9 snaps, played week 5).
const ROSTER = [
  [921, 'AAA Healthy', 'aaa-h', 7001, 'ACTIVE'],
  [922, 'AAA EspnOut', 'aaa-o', 7002, 'OUT'],
  [923, 'AAA EspnQ', 'aaa-q', 7003, 'QUESTIONABLE'],
  [924, 'AAA EspnQPractice', 'aaa-p', 7004, 'QUESTIONABLE'],
  [925, 'AAA EspnIR', 'aaa-r', 7005, 'INJURY_RESERVE'],
  [926, 'AAA NflOut', 'aaa-n', 7006, 'ACTIVE']
];
for (const [id, name, gsis, espn] of ROSTER) {
  player(id, name, 'WR', gsis, espn);
  for (let w = 1; w <= 5; w++) appear(id, 2025, w, 'AAA', 'WR', 0.9);
}
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury)
     VALUES (2025, 6, 'aaa-p', 'AAA', 'AAA EspnQPractice', 'WR', '', 'Limited Participation in Practice', 'Ankle')`);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury)
     VALUES (2025, 6, 'aaa-n', 'AAA', 'AAA NflOut', 'WR', 'Out', 'Did Not Participate In Practice', 'Knee')`);

const payload = {
  seasonId: 2025, scoringPeriodId: 6,
  teams: [{ id: 1, roster: { entries: ROSTER.map(([, name, , espn, status]) => ({
    lineupSlotId: 20, playerPoolEntry: { player: { id: espn, fullName: name, injuryStatus: status, proTeamId: 1 } }
  })) } }]
};
run(`INSERT INTO leagues (platform, league_id, season, name, my_team_id, payload, fetched_at)
     VALUES ('espn', 'test-1', 2025, 'Test league', '1', ?, datetime('now'))`, JSON.stringify(payload));

db.exec(C.AVAILABILITY_RATES_DDL);
db.exec(C.AVAILABILITY_ROLE_RATES_DDL);
const now = new Date().toISOString();
for (const [scope, team, rs, ps, p, n] of [
  ['league', '', 'none', 'any', 0.8314, 3564],
  ['league', '', 'out', 'any', 0.004, 900],
  ['league', '', 'questionable', 'any', 0.58, 1841],
  ['league', '', 'questionable', 'limited', 0.60, 1173],
  ['team', 'AAA', 'questionable', 'any', 0.638, 40]
]) {
  run(`INSERT INTO nfl_availability_rates (scope,team,report_status,practice_status,p_active,n,raw_rate,shrunk,fitted_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, scope, team, rs, ps, p, n, p, scope === 'team' ? 1 : 0, now);
}
const config = JSON.stringify({ k: 10, byPosition: false, durabilityCap: false });
for (const [rs, ps, pos, tier, gap, p] of [
  ['noreport', '*', '*', '*', '*', 0.70], ['noreport', 'none', '*', '*', '*', 0.70],
  ['noreport', 'none', '*', 'starter', '*', 0.90], ['noreport', 'none', '*', 'starter', 'g0', 0.953],
  ['none', '*', '*', '*', '*', 0.85], ['none', 'limited', '*', '*', '*', 0.93],
  ['none', 'limited', '*', 'starter', 'g0', 0.97],
  ['out', '*', '*', '*', '*', 0.006],
  ['questionable', '*', '*', '*', '*', 0.58], ['questionable', 'none', '*', 'starter', 'g0', 0.66],
  ['questionable', 'limited', '*', '*', '*', 0.60],
  ['questionable', 'limited', '*', 'starter', '*', 0.72], ['questionable', 'limited', '*', 'starter', 'g0', 0.74]
]) {
  run(`INSERT INTO nfl_availability_role_rates
       (report_status,practice_status,position,tier,gap,p_active,n,raw_rate,config,fitted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, rs, ps, pos, tier, gap, p, 100, p, config, now);
}
C.resetAvailabilityCache();

const ratio = 0.638 / 0.58;

test('liveEspnStatuses is only read for the payloads\' current ESPN scoring period', () => {
  const live = C.liveEspnStatuses(2025, 6);
  assert.ok(live instanceof Map);
  assert.equal(live.get('7002')?.status, 'OUT');
  assert.equal(C.liveEspnStatuses(2025, 5), null, 'last week is history: no ESPN status');
  assert.equal(C.liveEspnStatuses(2024, 6), null);
});

test('a healthy starter with no designation keeps the role cell', () => {
  const a = C.weeklyAvailability(2025, 6).get(921);
  assert.equal(a.active_probability, 0.953);
  assert.equal(a.espn_status, 'ACTIVE');
  assert.equal(a.designation, null);
});

test('an ESPN-OUT starter is priced out this week, not at the starter role cell', () => {
  const a = C.weeklyAvailability(2025, 6).get(922);
  assert.ok(a.active_probability <= 0.05, `got ${a.active_probability}`);
  assert.equal(a.active_probability, 0.006);
  assert.equal(a.designation, 'out');
  assert.equal(a.designation_source, 'espn');
  assert.equal(a.espn_status, 'OUT');
  assert.match(a.report_status, /Out \(ESPN/);
  assert.match(a.source, /out/);
});

test('an ESPN injured-reserve player is priced out this week', () => {
  const a = C.weeklyAvailability(2025, 6).get(925);
  assert.ok(a.active_probability <= 0.05, `got ${a.active_probability}`);
  assert.equal(a.designation, 'out');
});

test('an ESPN-Questionable starter with no NFL row gets the questionable role cell times his team\'s dialect', () => {
  const a = C.weeklyAvailability(2025, 6).get(923);
  assert.equal(a.active_probability, +(0.66 * ratio).toFixed(3));
  assert.match(a.source, /questionable/);
  assert.doesNotMatch(a.source, /noreport/, 'never the role prior alone');
  assert.match(a.source, /AAA/);
});

test('an ESPN-Questionable starter on a mid-week practice row uses his NFL practice status', () => {
  const a = C.weeklyAvailability(2025, 6).get(924);
  assert.equal(a.active_probability, +(0.74 * ratio).toFixed(3));
  assert.match(a.source, /questionable\/limited/);
  assert.equal(a.practice_status, 'Limited Participation in Practice');
});

test('an NFL Out stays out when ESPN has not caught up', () => {
  const a = C.weeklyAvailability(2025, 6).get(926);
  assert.equal(a.active_probability, 0.006);
  assert.equal(a.designation, 'out');
  assert.equal(a.designation_source, 'nfl');
  assert.equal(a.report_status, 'Out');
});

test('outside the live ESPN period (a replay) ESPN is never read', () => {
  // Week 5 of the same season: no NFL rows; ESPN's current OUT must not leak back.
  const a = C.weeklyAvailability(2025, 5).get(922);
  assert.ok(a.active_probability > 0.5, `got ${a.active_probability}`);
  assert.equal(a.espn_status, null);
  assert.equal(a.designation, null);
});

test('a caller can switch ESPN off (the gate scripts grade the NFL report alone)', () => {
  const a = C.weeklyAvailability(2025, 6, { espn: false }).get(922);
  assert.equal(a.active_probability, 0.953);
  assert.equal(a.espn_status, null);
});

/* ------------------------------------------- designation x role gate (G2) */

function cellRows({ rs, tier, n, actual, pCur, pCand, pidBase }) {
  const out = [];
  const hits = Math.round(actual * n);
  for (let i = 0; i < n; i++) {
    out.push({ player_id: pidBase + (i % 25), y: i < hits ? 1 : 0, p_current: pCur, p_candidate: pCand, rs, tier });
  }
  return out;
}

test('designation x role gate: passes when every gated cell is non-inferior and calibrated', () => {
  const rows = [
    ...cellRows({ rs: 'noreport', tier: 'starter', n: 400, actual: 0.95, pCur: 0.75, pCand: 0.95, pidBase: 1 }),
    ...cellRows({ rs: 'questionable', tier: 'starter', n: 120, actual: 0.60, pCur: 0.62, pCand: 0.61, pidBase: 100 }),
    ...cellRows({ rs: 'out', tier: 'starter', n: 30, actual: 0.0, pCur: 0.5, pCand: 0.9, pidBase: 200 })
  ];
  const g = C.designationRoleGate(rows);
  assert.equal(g.pass, true, JSON.stringify(g.cells.filter(c => c.gated && !c.pass)));
  const out = g.cells.find(c => c.designation === 'out' && c.role === 'starter');
  assert.equal(out.gated, false, 'n < 50 is reported, not gated');
  assert.ok(g.cells.some(c => c.designation === 'questionable' && c.role === '*' && c.gated), 'pooled designation cells are gated too');
  for (const c of g.cells) assert.ok('ece_current' in c && 'ece_candidate' in c);
});

test('designation x role gate: a gated cell that is worse and miscalibrated fails the gate', () => {
  const rows = [
    ...cellRows({ rs: 'noreport', tier: 'starter', n: 400, actual: 0.95, pCur: 0.75, pCand: 0.95, pidBase: 1 }),
    ...cellRows({ rs: 'questionable', tier: 'starter', n: 120, actual: 0.60, pCur: 0.60, pCand: 0.95, pidBase: 100 })
  ];
  const g = C.designationRoleGate(rows);
  assert.equal(g.pass, false);
  const bad = g.cells.find(c => c.designation === 'questionable' && c.role === 'starter');
  assert.equal(bad.log_loss_pass, false);
  assert.equal(bad.calibration_pass, false);
});

test('designation x role gate: calibration passes when the candidate is no further from the truth than current', () => {
  const rows = cellRows({ rs: 'none', tier: 'rotation', n: 2000, actual: 0.80, pCur: 0.70, pCand: 0.72, pidBase: 1 });
  const g = C.designationRoleGate(rows);
  const cell = g.cells.find(c => c.designation === 'none' && c.role === 'rotation');
  assert.equal(cell.calibration_pass, true, 'bias 0.08 > tolerance, but better than current\'s 0.10');
  assert.equal(cell.log_loss_pass, true);
});
