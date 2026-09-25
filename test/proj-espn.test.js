/**
 * PROJ-ESPN (#446): the served weekly projection is frozen pre-kickoff ESPN, ours is a shadow,
 * and the weekly ranges are ESPN + calibrated positional residual quantiles.
 *
 *   (1) served = frozen ESPN: the latest capture before his kickoff, the league's own scoring
 *       when captured, a late row never; blend.week is the same number (no lift on top)
 *   (2) stale capture -> 'unknown' with a reason, null served number, a broken
 *       number_health `espn_projection_stale` row, Start/Sit shows null (no fallback)
 *   (3) GRIDIRON_PROJ_ESPN=0 -> ours
 *   (4) the shadow log is written, and freezes at kickoff
 *   (5) ranges: >= 78% p10-p90 coverage on a replay of real 2026-W2 team-weeks with the shipped k
 *   (6) the Tuesday refit rule changes k only outside [72%, 88%]
 *
 * player-week-engine.js is mocked (as in asset-universe-bye-week-range.test.js): "ours" is a
 * fixed made-up number, so every served difference comes from the source switch.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-proj-espn-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '6';
process.env.GRIDIRON_PROJ_ESPN = '1';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const wrParams = targets => ({
  position: 'WR', attempts: 0, carries: 0, targets, dispersion: 10,
  ypa: 7, pass_td_rate: 0.045, int_rate: 0.025, ypc: 4.2, rush_td_rate: 0.03,
  catch_rate: 0.68, ypt: 8, rec_td_rate: 0.05
});
const OURS = { ppg: 20, params: wrParams(8), ensemble_shift: 0, volume: { target_share: 0.2 } };
const realWeekEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realWeekEngine,
    buildPlayerWeekEngine: () => new Map([[901, { ...OURS }], [902, { ...OURS }], [903, { ...OURS }]]),
    playerWeekDistribution: () => ({ p10: 8, p90: 32, mean: 20, boom_rate: 0.2, bust_rate: 0.1 })
  }
});

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const te = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');
const espn = await import('../server/services/espn-week-projection.js');
const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
const { evaluateSnapshot } = await import('../server/services/number-audit.js');
const cal = await import('../server/services/range-calibration.js');
const { residuals, playerWeekRange } = await import('../server/services/range-residuals.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* -------------------------------------------------------------- fixture */

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (1, 'AAA', 'Alpha', 'AFC', 'East'), (2, 'BBB', 'Beta', 'NFC', 'West')`);
for (let w = 1; w <= 14; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 1, ?, 'BBB', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 2, ?, 'AAA', 0)`, w);
}
run(`INSERT INTO players (id, name, position, team_id, espn_id) VALUES (901, 'P901', 'WR', 1, 5901)`);
run(`INSERT INTO players (id, name, position, team_id, espn_id) VALUES (902, 'P902', 'WR', 2, 5902)`);
run(`INSERT INTO players (id, name, position, team_id, espn_id) VALUES (903, 'P903', 'WR', 2, 5903)`);

const DAY = 86400e3;
const iso = ms => new Date(ms).toISOString();
const NOW = Date.now();
const KICK = iso(NOW + 2 * DAY);      // week 6 kickoff, still ahead
let seq = 0;
function capture({ key = 'ppr', at, rows: list, week = 6, kickoffAt = KICK }) {
  const id = `c${seq++}`;
  run(`INSERT INTO espn_weekly_projection_captures (capture_id, season, week, scoring_key, window_key, captured_at,
         source_url_hash, n_rows, status) VALUES (?, 2026, ?, ?, 'test', ?, 'h', ?, 'ok')`, id, week, key, at, list.length);
  for (const [espnId, pts, late = 0] of list) {
    run(`INSERT INTO espn_weekly_projection_snapshots (season, week, player_id, espn_id, position, pro_team, projected_pts,
           scoring_key, captured_at, kickoff_at, late, window_key, capture_id, source_url_hash)
         VALUES (2026, ?, NULL, ?, 'WR', 'AAA', ?, ?, ?, ?, ?, 'test', ?, 'h')`, week, espnId, pts, key, at, kickoffAt, late, id);
  }
}
const lg = () => ({ id: 1, team_count: 10, ppr: 1, best_ball: 0, league_type: null, payload: null });
const universe = () => te.assetUniverse(lg(), deriveFormat(lg()).formatKey);

/* -------------------------------------------------------------- (1) */

test('(1) served = the latest frozen ESPN capture before kickoff, league scoring first; blend.week is the same number', () => {
  capture({ key: 'ppr', at: iso(NOW - 3 * DAY), rows: [[5901, 11.0], [5902, 7.0]] });
  capture({ key: 'ppr', at: iso(NOW - 1 * DAY), rows: [[5901, 12.5], [5902, 8.25]] });
  // A late row (captured at/after kickoff) never qualifies, however new.
  capture({ key: 'ppr', at: iso(NOW - 0.5 * DAY), rows: [[5902, 99, 1]] });
  const u = universe();
  const a = u.get(901), b = u.get(902), c = u.get(903);
  assert.equal(a.current_week_ppg, 12.5);
  assert.equal(a.blend_week, 12.5, 'blend.week carries no betting-line lift on top of ESPN');
  assert.equal(a.week_projection.source, 'espn_frozen');
  assert.equal(a.week_projection.scoring_key, 'ppr');
  assert.equal(b.current_week_ppg, 8.25, 'the late 99 is ignored');
  // Ours (20 x chance to play) is never served, only shadowed.
  assert.notEqual(a.current_week_ppg, a[te.WEEK_SHADOW].ours);
  assert.equal(a[te.WEEK_SHADOW].espn, 12.5);
  assert.ok(!JSON.stringify(a).includes('"ours"'), 'the shadow never reaches a response');
  // No ESPN row for him: unknown, null, never ours.
  assert.equal(c.current_week_ppg, null);
  assert.equal(c.week_projection.status, 'unknown');
  assert.match(c.week_projection.reason, /no projection/);
  // The per-player range is ESPN + k x residual quantiles.
  const k = cal.currentK().k;
  assert.deepEqual([a.floor, a.ceiling], [playerWeekRange(12.5, 'WR', k).p10, playerWeekRange(12.5, 'WR', k).p90]);
  assert.equal(a.range_source, 'espn_calibrated');
});

test('(1b) the league\'s own scoring capture wins over PPR when that week has one', () => {
  assert.equal(espn.scoringKeyFor(1, 2026, 6), 'ppr');
  capture({ key: 'league:1', at: iso(NOW - 1 * DAY), rows: [[5901, 14.75]] });
  assert.equal(espn.scoringKeyFor(1, 2026, 6), 'league:1');
  const w = espn.espnWeekProjections({ season: 2026, week: 6, leagueRowId: 1 });
  assert.equal(w.byEspnId.get(5901).pts, 14.75);
  assert.equal(universe().get(901).current_week_ppg, 14.75);
});

test('(1c) after kickoff only a capture from before it counts', () => {
  const past = iso(NOW - 2 * DAY);
  capture({ week: 5, at: iso(NOW - 4 * DAY), rows: [[5901, 9.5]], kickoffAt: past });
  capture({ week: 5, at: iso(NOW - 1 * DAY), rows: [[5901, 30, 1]], kickoffAt: past });
  const w = espn.espnWeekProjections({ season: 2026, week: 5 });
  assert.equal(w.status, 'ok');
  assert.equal(w.byEspnId.get(5901).pts, 9.5);
});

/* -------------------------------------------------------------- (2) */

test('(2) a stale capture hard-fails: unknown with a reason, null served, broken health row, no Start/Sit fallback', () => {
  capture({ week: 7, at: iso(NOW - 8 * DAY), rows: [[5901, 13]], kickoffAt: iso(NOW + 5 * DAY) });
  const w = espn.espnWeekProjections({ season: 2026, week: 7 });
  assert.equal(w.status, 'unknown');
  assert.match(w.reason, /8\.0 days old \(limit 7\)/);
  assert.equal(w.byEspnId.size, 0, 'nothing stale is served');
  const served = espn.servedWeekFor({ position: 'WR', espn_id: 5901 }, w, { ours: 20 });
  assert.deepEqual([served.value, served.status], [null, 'unknown']);
  // Start/Sit prints unknown, not a fallback number.
  const ss = startSitWeekPoints({ current_week_ppg: null, adj_ppg: 15, week_projection: { status: 'unknown', reason: w.reason } }, 2026, 7);
  assert.equal(ss.week_points, null);
  // number_health
  const h = espn.espnProjectionHealth({ season: 2026, week: 7 });
  assert.equal(h.status, 'unknown');
  const row = evaluateSnapshot({ espn_projection: h, range_coverage: { n: 0 } }).find(r => r.check_id === 'espn_projection_stale');
  assert.equal(row.status, 'broken');
  assert.match(row.detail, /days old/);
  // No capture at all is the same hard fail.
  assert.equal(espn.espnWeekProjections({ season: 2026, week: 9 }).status, 'unknown');
  assert.equal(evaluateSnapshot({ espn_projection: espn.espnProjectionHealth({ season: 2026, week: 6 }) })
    .find(r => r.check_id === 'espn_projection_stale').status, 'ok');
});

test('(2b) the stale week reaches the served universe: every skill player unknown, horizon on ROS only', () => {
  process.env.NFL_WEEK = '7';
  try {
    const a = universe().get(901);
    assert.equal(a.current_week_ppg, null);
    assert.equal(a.week_projection.status, 'unknown');
    assert.equal(a.blend_week, undefined);
    assert.equal(a.adj_ppg, a.ros_ppg, 'an unknown week leaves the horizon on the rest-of-season rate');
  } finally { process.env.NFL_WEEK = '6'; }
});

/* -------------------------------------------------------------- (3) */

test('(3) GRIDIRON_PROJ_ESPN=0 serves ours', () => {
  const shadowOurs = universe().get(901)[te.WEEK_SHADOW].ours;
  process.env.GRIDIRON_PROJ_ESPN = '0';
  try {
    const a = universe().get(901);
    assert.equal(a.current_week_ppg, shadowOurs);
    assert.equal(a.week_projection, undefined);
    assert.equal(a[te.WEEK_SHADOW], undefined);
    assert.equal(espn.projEspnFlag().on, false);
  } finally { process.env.GRIDIRON_PROJ_ESPN = '1'; }
  assert.equal(universe().get(901).current_week_ppg, 14.75);
});

/* -------------------------------------------------------------- (4) */

test('(4) the shadow log is written per player-week and freezes at kickoff', () => {
  const u = universe();
  const entries = [...u.values()].filter(a => a[te.WEEK_SHADOW]).map(a => ({ player_id: a.id, ...a[te.WEEK_SHADOW] }));
  const n = espn.logWeeklyShadow({ season: 2026, week: 6, scoringKey: 'league:1', entries });
  assert.ok(n >= 2);
  const r = db.prepare('SELECT * FROM weekly_projection_shadow WHERE player_id = 901').get();
  assert.equal(r.espn, 14.75);
  assert.equal(r.ours, u.get(901)[te.WEEK_SHADOW].ours);
  assert.equal(r.served, 'espn_frozen');
  // After kickoff a later write does not move the pre-kickoff pair.
  espn.logWeeklyShadow({ season: 2026, week: 6, scoringKey: 'league:1', now: NOW + 3 * DAY,
    entries: [{ player_id: 901, ours: 1, espn: 1, captured_at: null, kickoff_at: KICK, served: 'espn_frozen' }] });
  assert.equal(db.prepare('SELECT espn FROM weekly_projection_shadow WHERE player_id = 901').get().espn, 14.75);
});

/* -------------------------------------------------------------- (5) */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'proj-espn-teamweeks.json'), 'utf8'));

test('(5) the shipped k covers >= 78% of real 2026-W2 team-weeks on a replay (target 80%)', () => {
  const shipped = residuals().k;
  assert.equal(FIXTURE.k, shipped.value, 'the fixture is the set the shipped k was fitted on');
  const c = cal.coverageAt(FIXTURE.team_weeks, shipped.value);
  assert.equal(c.n, 46);
  assert.ok(c.coverage >= 0.78, `coverage ${c.coverage}`);
  // Control: the unscaled residuals (k = 1) under-cover, which is why k exists.
  assert.ok(cal.coverageAt(FIXTURE.team_weeks, 1).coverage < 0.72);
  // And the fit itself lands on a k that reaches the target.
  const f = cal.fitK(FIXTURE.team_weeks);
  assert.ok(f.coverage >= 0.8 && Math.abs(f.k - shipped.value) <= 0.1, JSON.stringify(f));
});

test('(5b) the k is stored with its fit date', () => {
  const k = cal.currentK();
  assert.match(k.fit_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(k.k > 0);
});

/* -------------------------------------------------------------- (6) */

test('(6) the refit rule: change k only outside [72%, 88%]', () => {
  assert.equal(cal.refitDecision(0.719), 'refit');
  assert.equal(cal.refitDecision(0.72), 'kept');
  assert.equal(cal.refitDecision(0.80), 'kept');
  assert.equal(cal.refitDecision(0.88), 'kept');
  assert.equal(cal.refitDecision(0.881), 'refit');
  assert.equal(cal.refitDecision(null), 'skipped');
});

test('(6b) runRangeCalibration on a Tuesday: keeps k inside the band, refits outside it, logs coverage', () => {
  // Four finished weeks, one league, two teams, two starters each, frozen league:2 captures.
  for (let w = 1; w <= 4; w++) {
    run(`INSERT INTO game_lines (season, week, team, gameday, gametime, team_score, fetched_at)
         VALUES (2026, ?, 'AAA', '2026-09-10', '20:15', 21, '2026-09-11')`, w);
  }
  const kick = '2026-09-11T00:15:00.000Z';
  const pts = { 5901: 15, 5902: 10 };
  for (let w = 1; w <= 4; w++) {
    capture({ key: 'league:2', week: w, at: '2026-09-08T16:00:00.000Z', kickoffAt: kick, rows: [[5901, pts[5901]], [5902, pts[5902]]] });
  }
  const insertStarters = actualFor => {
    db.exec('DELETE FROM league_roster_snapshots WHERE league_id = 2');
    for (let w = 1; w <= 4; w++) {
      for (const team of [1, 2]) {
        for (const [espnId, pos] of [[5901, 'WR'], [5902, 'WR']]) {
          run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id,
                 player_name, position, lineup_slot_id, is_starter, projected_points, actual_points, source, first_seen_at, changed_at)
               VALUES (2, 2026, ?, ?, ?, NULL, 'x', ?, 4, 1, NULL, ?, 'final', '2026-09-08', '2026-09-08')`,
          w, team, espnId, pos, actualFor(w, team) / 2);
        }
      }
    }
  };
  // 6 of 8 team-weeks at the median, 2 far outside: 75%, inside the band -> kept.
  insertStarters((w, team) => (w <= 1 ? 1000 : 25));
  const tuesday = Date.parse('2026-10-06T16:00:00Z'); // a Tuesday, 12:00 ET
  const before = cal.currentK();
  const kept = cal.runRangeCalibration({ now: tuesday, season: 2026 });
  assert.equal(kept.decision, 'kept');
  const r1 = db.prepare('SELECT * FROM range_calibration ORDER BY id DESC LIMIT 1').get();
  assert.equal(r1.decision, 'kept');
  assert.equal(r1.k, before.k);
  assert.equal(r1.coverage_before, 0.75);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM range_coverage_log WHERE league_id = 2').get().n === 4);
  // Same Tuesday again: no second fit row.
  cal.runRangeCalibration({ now: tuesday + 3600e3, season: 2026 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM range_calibration').get().n, 1);
  // Every team-week far outside: 0% -> refit (a new k row with the fit date).
  insertStarters(() => 1000);
  const refit = cal.runRangeCalibration({ now: tuesday + 7 * DAY, season: 2026 });
  assert.equal(refit.decision, 'refit');
  const r2 = db.prepare('SELECT * FROM range_calibration ORDER BY id DESC LIMIT 1').get();
  assert.equal(r2.decision, 'refit');
  assert.equal(r2.fit_date, '2026-10-13');
  assert.equal(cal.currentK().k, r2.k);
  // A non-Tuesday never fits.
  assert.equal(cal.runRangeCalibration({ now: tuesday + 8 * DAY, season: 2026 }).decision, null);
  // number_health reads the log.
  const tc = cal.trailingCoverage({ leagueId: 2 });
  const row = evaluateSnapshot({ range_coverage: tc }).find(x => x.check_id === 'range_coverage');
  assert.equal(row.status, 'ok', 'the log was written at 75% (inside the band) and is first-write-wins');
  assert.match(row.detail, /held 75%/);
});


/* -------------------------------------------------------------- (7) */

test('(7) the one range producer: ESPN-centred, ranked on the world\'s own draws, unknown week -> error', async () => {
  const wr = await import('../server/services/lineup-week-range.js');
  const runs = 400;
  // Two skill starters with world columns (one strictly increasing in the run, one decreasing)
  // and a K with a fixed projection.
  const index = new Map([[901, 0], [902, 1]]);
  const byRun = Array.from({ length: runs }, (_, r) => ({ index, vals: Float64Array.from([r, runs - r]) }));
  const assets = new Map([
    [901, { id: 901, position: 'WR', current_week_ppg: 12.5, week_projection: { status: 'ok' } }],
    [902, { id: 902, position: 'WR', current_week_ppg: 8, week_projection: { status: 'ok' } }],
  ]);
  const k = 1.5;
  assets.context = { week: 6, week_projection: { source: 'espn_frozen', status: 'ok', range_k: { k } } };
  const world = { runs, key: { seed: 7 }, prep: { assets },
    draws: new Map([[6, { byRun, expected: new Map([[901, 30], [902, 30]]), kdst: new Map([[950, 9]]) }]]) };
  const t = wr.lineupWeekTotals(world, [901, 902, 950], 6);
  assert.equal(t.basis, 'espn_calibrated');
  assert.equal(t.covered, 3);
  // Run r ranks 901 at u = (r + 0.5) / runs and 902 at 1 - u: the world's ordering is kept.
  const { playerDraw } = await import('../server/services/range-residuals.js');
  for (const r of [0, 123, 399]) {
    const u = (r + 0.5) / runs;
    const want = 9 + playerDraw(12.5, 'WR', u, k) + playerDraw(8, 'WR', 1 - u, k);
    assert.ok(Math.abs(t.totals[r] - want) < 1e-9, `run ${r}: ${t.totals[r]} vs ${want}`);
  }
  const range = wr.lineupWeekRange(world, [901, 902, 950], 6);
  assert.equal(range.k, k);
  assert.match(range.method, /served ESPN mean/);
  assert.ok(range.floor <= range.median && range.median <= range.ceiling);
  // The means the ceiling lineup sets lineups on are the served ESPN numbers.
  assert.deepEqual([...wr.worldWeekMeans(world, 6)], [[901, 12.5], [902, 8]]);
  // Another week keeps the world (ESPN captures only the served week).
  world.draws.set(7, world.draws.get(6));
  assert.equal(wr.lineupWeekTotals(world, [901], 7).basis, undefined);
  // An unknown served week is an error, never the world's own centres.
  assets.context.week_projection = { source: 'espn_frozen', status: 'unknown', reason: 'stale' };
  assert.match(wr.lineupWeekRange(world, [901], 6).error, /unknown: stale/);
});
