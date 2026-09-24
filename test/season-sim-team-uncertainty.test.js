/**
 * AVAIL-HORIZON-2 change B: the season sim's team-mean uncertainty term.
 *
 * The sim's pools are fixed per sync, so a team's rest-of-season mean was treated as
 * known exactly (TITLE-ZERO over-confidence; E3-ESPN slope 0.41). With GRIDIRON_AVAIL_HORIZON
 * on, each run draws one strength offset per team, Normal(0, TEAM_MEAN_SD) points per
 * week, added to every week that team plays. Off, the sim is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-team-mean-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const S = await import('../server/services/season-sim.js');
const R = await import('../server/services/availability-return.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the SD is the pre-registered 8 and only the flag turns it on', () => {
  assert.equal(S.TEAM_MEAN_SD, 8);
  withEnv({ [R.AVAIL_HORIZON_ENV]: null, [PREVIEW_ENV]: null }, () => assert.equal(S.teamMeanSd(), 0));
  withEnv({ [R.AVAIL_HORIZON_ENV]: '1', [PREVIEW_ENV]: null }, () => assert.equal(S.teamMeanSd(), 8));
  withEnv({ [R.AVAIL_HORIZON_ENV]: '0', [PREVIEW_ENV]: '1' }, () => assert.equal(S.teamMeanSd(), 0));
  withEnv({ [R.AVAIL_HORIZON_ENV]: null, [PREVIEW_ENV]: '1' }, () =>
    assert.equal(S.teamMeanSd(), R.AVAIL_HORIZON_IN_PREVIEW ? 8 : 0, 'preview follows AVAIL_HORIZON_IN_PREVIEW'));
});

test('offsets are keyed by (world, team, run): repeatable, mean ~0, SD ~8', () => {
  const { teamOffsets } = S.__test;
  const ids = ['1', '2', '3', '4'];
  assert.deepEqual([...teamOffsets(7, ids, 3, 8)], [...teamOffsets(7, ids, 3, 8)]);
  assert.notDeepEqual([...teamOffsets(7, ids, 3, 8)], [...teamOffsets(7, ids, 4, 8)]);
  assert.notDeepEqual([...teamOffsets(7, ids, 3, 8)], [...teamOffsets(8, ids, 3, 8)]);
  // A team's offset does not depend on who else is in the league (paired trade arms).
  assert.equal(teamOffsets(7, ['2'], 3, 8).get('2'), teamOffsets(7, ids, 3, 8).get('2'));
  let s = 0, q = 0, n = 0;
  for (let run = 0; run < 4000; run++) for (const v of teamOffsets(11, ids, run, 8).values()) { s += v; q += v * v; n++; }
  const mean = s / n, sd = Math.sqrt(q / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.3, `mean ${mean}`);
  assert.ok(Math.abs(sd - 8) < 0.3, `sd ${sd}`);
});

/** A 6-team, 4-week league with a 4-team bracket; team i scores 100 + i every week. */
function prepFor(sd) {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const teams = ids.map(id => ({ roster_id: id, owner: `o${id}`, players: [] }));
  const sched = new Map([1, 2, 3, 4].map(w => [w, [['1', '2'], ['3', '4'], ['5', '6']].map(([a, b]) =>
    (w % 2 ? [a, b] : [a, String(7 - Number(a))]))]));
  return {
    teams,
    prep: {
      lg: { payload: '{}' }, fromWeek: 1, sched, weeks: [1, 2, 3, 4], bracketWeeks: [[5], [6]], playoffTeams: 4,
      medianGame: false, world: 99, teamMeanSd: sd,
      rules: { schedule: { playoff_weeks: [[5], [6]], reseed: false }, seeding: { tiebreaker: 'TOTAL_POINTS_SCORED' } }
    }
  };
}
const fixed = t => 100 + Number(t.roster_id);

test('off (sd 0): the season is deterministic and the strongest team always wins', () => {
  const { prep, teams } = prepFor(0);
  const out = S.__test.playSeasons(prep, teams, 200, false, (t) => fixed(t));
  const top = out.teams.find(t => t.roster_id === '6');
  assert.equal(top.title_odds, 1);
  assert.equal(out.team_mean_sd, undefined);
});

test('on: longshots get title and playoff chances, odds still sum to 1 and to the playoff spots', () => {
  const { prep, teams } = prepFor(8);
  const out = S.__test.playSeasons(prep, teams, 2000, false, (t) => fixed(t));
  const sum = k => out.teams.reduce((s, t) => s + t[k], 0);
  assert.ok(Math.abs(sum('title_odds') - 1) < 1e-3, `title sum ${sum('title_odds')}`);
  assert.ok(Math.abs(sum('playoff_odds') - 4) < 1e-3, `playoff sum ${sum('playoff_odds')}`);
  const worst = out.teams.find(t => t.roster_id === '1');
  assert.ok(worst.title_odds > 0 && worst.title_odds < out.teams.find(t => t.roster_id === '6').title_odds);
  // Mean-zero offsets: expected points stay near 4 x (100 + i).
  for (const t of out.teams) {
    assert.ok(Math.abs(t.expected_points - 4 * (100 + Number(t.roster_id))) < 2, `${t.roster_id} ${t.expected_points}`);
  }
});

test('one offset per team per run: the same run gives the same offset in every week', () => {
  const { prep, teams } = prepFor(8);
  const seen = new Map();
  const { teamOffsets } = S.__test;
  S.__test.playSeasons(prep, teams, 3, false, (t, run, week) => {
    seen.set(`${t.roster_id}|${run}|${week}`, true);
    return 0;
  });
  const out = S.__test.playSeasons(prep, teams, 1, false, () => 0);
  const off = teamOffsets(99, teams.map(t => t.roster_id), 0, 8);
  for (const t of out.teams) {
    // Zero raw points: a team's season total is exactly 4 weeks of its one offset.
    assert.ok(Math.abs(t.expected_points - +(4 * off.get(t.roster_id)).toFixed(1)) < 0.06, t.roster_id);
  }
  assert.ok(seen.size > 0);
});
