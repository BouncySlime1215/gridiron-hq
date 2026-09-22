/**
 * Snap share on a depth chart is OFFENSIVE snap share, and a defender has none.
 *
 * `depth-chart.js` reads `player_week_snaps.offense_pct` and puts it beside the
 * rank, on the stated reasoning that snap share is the measurement that settles
 * an argument with a listing (depth-chart-source-freshness.test.js says so in
 * as many words). That reasoning holds for an offensive player and collapses
 * for a defensive one: a linebacker who played all 60 defensive snaps has an
 * `offense_pct` of 0, so the column that is supposed to settle the argument
 * reports the team's best defender as having done nothing.
 *
 * This is the same shape as the bug found in `who-plays.js` — every defender
 * scored 0.0000 from a raw `AVG(offense_pct)` — but it is NOT the same bug and
 * is not inherited from that file. This module never calls it, takes a single
 * season+week row rather than an average, and already keeps null distinct from
 * zero at line 111. The defect that remains is narrower: the number it reports
 * does not describe the player it is reported against.
 *
 * Nothing renders `snap_share` today, so this is not yet a visible lie — it is
 * a served-but-unrendered field, and the panel being built on top of it is
 * exactly what would make it visible. Fixing it before that, rather than after,
 * is the point.
 *
 * The rule: a real zero, an unmeasured player, and a player the measurement does
 * not apply to are three different facts and must not collapse into one number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-depth-defender-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { run, db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { teamDepthChart } = await import('../server/services/depth-chart.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const SEASON = 2026, WEEK = 2, TEAM = 'KC';
run(`INSERT INTO nfl_teams (abbr, name, conference, division) VALUES (?, 'Kansas City', 'AFC', 'West')`, TEAM);

// A receiver who played most offensive snaps, a linebacker who played every
// defensive snap (and so zero offensive ones), and a guard nobody measured.
const PLAYERS = [
  [1, 'Star Receiver', 'WR', '00-0000001'],
  [2, 'Star Linebacker', 'LB', '00-0000002'],
  [3, 'Unmeasured Guard', 'G', '00-0000003']
];
for (const [id, name, pos, gsis] of PLAYERS) {
  run(`INSERT INTO players (id, name, position, gsis_id, fantasy_relevant) VALUES (?,?,?,?,1)`,
    id, name, pos, gsis);
}
for (const [id, name, pos, gsis] of PLAYERS) {
  run(`INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb, pos_rank, captured)
       VALUES (?,?,?,?,?,?,1,'2026-09-19T12:00:00Z')`, SEASON, WEEK, TEAM, gsis, name, pos);
}
// The receiver and the linebacker both have snap rows. The guard has none.
run(`INSERT INTO player_week_snaps (season, week, player_id, offense_pct) VALUES (?,?,1,0.88)`, SEASON, WEEK);
run(`INSERT INTO player_week_snaps (season, week, player_id, offense_pct) VALUES (?,?,2,0)`, SEASON, WEEK);

const chart = () => teamDepthChart(TEAM, { season: SEASON, week: WEEK, currentSeason: SEASON });
const find = name => chart().positions.flatMap(p => p.players).find(p => p.name === name);

test('an offensive player keeps his measured snap share', () => {
  const wr = find('Star Receiver');
  assert.equal(wr.snap_share, 0.88);
  assert.equal(wr.snap_share_basis, 'offensive_snaps',
    'the measured share does not say which snaps it counted');
});

test('a defender is not reported as having played no snaps', () => {
  const lb = find('Star Linebacker');
  assert.notEqual(lb.snap_share, 0,
    'a linebacker who played every defensive snap is being reported at 0 offensive snaps as if it described him');
  assert.equal(lb.snap_share, null);
  assert.equal(lb.snap_share_basis, 'not_applicable_to_this_position',
    'nothing says why the defender has no share rather than a zero one');
});

test('an unmeasured player stays distinct from a measured zero', () => {
  const g = find('Unmeasured Guard');
  assert.equal(g.snap_share, null);
  assert.equal(g.snap_share_basis, 'not_measured',
    'an offensive player with no snap row reads the same as one the stat cannot describe');
});

test('the three states are genuinely distinguishable from each other', () => {
  const bases = ['Star Receiver', 'Star Linebacker', 'Unmeasured Guard'].map(n => find(n).snap_share_basis);
  assert.equal(new Set(bases).size, 3,
    'two of the three snap-share situations report the same basis, so a reader cannot tell them apart');
});
