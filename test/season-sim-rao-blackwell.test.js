/**
 * RB-TITLE (R&D r50 IDEA-088, RL-50-1): Rao-Blackwellised title odds.
 *
 * With GRIDIRON_RB_TITLE on (or preview), each run's title value is
 * P(wins the fixed bracket | that run's field, seeds and team offsets) from the pairwise
 * round win probabilities of the call's own runs, instead of one sampled champion.
 * Same expectation, less run-to-run noise. Off, the sim is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rb-title-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const S = await import('../server/services/season-sim.js');
const { keyedSeed, keyedNormal } = await import('../server/services/stats-util.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const ON = { on: true, preview: false }, OFF = { on: false, preview: false };

test('flag: default off, 1 on, preview turns it on, 0 vetoes preview', () => {
  withEnv({ [S.RB_TITLE_ENV]: null, [PREVIEW_ENV]: null }, () => assert.deepEqual(S.rbTitleFlag(), OFF));
  withEnv({ [S.RB_TITLE_ENV]: '1', [PREVIEW_ENV]: null }, () => assert.deepEqual(S.rbTitleFlag(), ON));
  withEnv({ [S.RB_TITLE_ENV]: null, [PREVIEW_ENV]: '1' }, () => assert.deepEqual(S.rbTitleFlag(), { on: true, preview: true }));
  withEnv({ [S.RB_TITLE_ENV]: '0', [PREVIEW_ENV]: '1' }, () => assert.deepEqual(S.rbTitleFlag(), OFF));
});

test('titleProbs walks the fixed bracket, byes included', () => {
  const { titleProbs } = S.__rbTest;
  const coin = () => 0.5;
  const eight = titleProbs([0, 1, 2, 3, 4, 5, 6, 7], 3, coin);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(eight.get(i) - 1 / 8) < 1e-12);
  // 6-team field in a 3-round bracket: seeds 1 and 2 have byes, so they need two wins.
  const six = titleProbs([10, 11, 12, 13, 14, 15], 3, coin);
  assert.ok(Math.abs(six.get(10) - 0.25) < 1e-12 && Math.abs(six.get(11) - 0.25) < 1e-12);
  for (const id of [12, 13, 14, 15]) assert.ok(Math.abs(six.get(id) - 0.125) < 1e-12);
  // Better seed always wins: the 1 seed is champion with certainty.
  const chalk = titleProbs([10, 11, 12, 13, 14, 15], 3, (r, a, b, better) => (better ? 1 : 0));
  assert.equal(chalk.get(10), 1);
  assert.equal([...chalk.values()].reduce((s, v) => s + v, 0), 1);
});

test('pairwiseRounds: strict wins, ties to the better seed, offset threshold', () => {
  const { pairwiseRounds } = S.__rbTest;
  // 4 runs, 1 round; team 0 scores [10, 20, 30, 40], team 1 [10, 10, 35, 30].
  const beat = pairwiseRounds([new Float64Array([10, 20, 30, 40]), new Float64Array([10, 10, 35, 30])], 4);
  assert.equal(beat(0, 0, 1, 0, false), 2 / 4); // wins runs 2 and 4, loses 3, tie in 1 to team 1
  assert.equal(beat(0, 0, 1, 0, true), 3 / 4);
  assert.equal(beat(0, 1, 0, 0, false), 1 / 4);
  assert.equal(beat(0, 1, 0, 0, true), 2 / 4);
  // The two sides always sum to 1.
  for (const t of [-7, 0, 5, 10]) {
    assert.equal(beat(0, 0, 1, t, true) + beat(0, 1, 0, -t, false), 1);
    assert.equal(beat(0, 0, 1, t, false) + beat(0, 1, 0, -t, true), 1);
  }
  // Team 0 must win by more than 10 (differences are 0, 10, -5, 10): never.
  assert.equal(beat(0, 0, 1, 10, false), 0);
  assert.equal(beat(0, 0, 1, 10, true), 2 / 4);
});

/** A 6-team, 4-week league with a 4-team bracket over two one-week rounds. */
function prepFor({ sd = 0, reseed = false, rb = OFF } = {}) {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const teams = ids.map(id => ({ roster_id: id, owner: `o${id}`, players: [] }));
  const sched = new Map([1, 2, 3, 4].map(w => [w, [['1', '2'], ['3', '4'], ['5', '6']].map(([a, b]) =>
    (w % 2 ? [a, b] : [a, String(7 - Number(a))]))]));
  return {
    teams,
    prep: {
      lg: { payload: '{}' }, fromWeek: 1, sched, weeks: [1, 2, 3, 4], bracketWeeks: [[5], [6, 7]], playoffTeams: 4,
      medianGame: false, world: 99, teamMeanSd: sd, rbTitleFlag: rb,
      rules: { schedule: { playoff_weeks: [[5], [6, 7]], reseed }, seeding: { tiebreaker: 'TOTAL_POINTS_SCORED' } }
    }
  };
}
const noisy = (t, run, week) => 100 + 3 * Number(t.roster_id) + 25 * keyedNormal(keyedSeed('rb-test', t.roster_id, week), run);

test('off: no title_estimator field and 0/1 per-run titles (old payload)', () => {
  const { prep, teams } = prepFor();
  const out = S.__test.playSeasons(prep, teams, 300, true, noisy);
  assert.equal(out.title_estimator, undefined);
  for (const r of out.per_run.values()) assert.ok(r.title instanceof Uint8Array);
});

test('on: per-run P(title) sums to 1 per run and the odds sum to 1', () => {
  const { prep, teams } = prepFor({ rb: ON });
  const out = S.__test.playSeasons(prep, teams, 400, true, noisy);
  assert.equal(out.title_estimator, 'rao_blackwell');
  for (let run = 0; run < 400; run++) {
    let s = 0;
    for (const r of out.per_run.values()) { assert.ok(r.title[run] >= 0 && r.title[run] <= 1); s += r.title[run]; }
    assert.ok(Math.abs(s - 1) < 1e-9, `run ${run} sums to ${s}`);
  }
  const sum = out.teams.reduce((s, t) => s + t.title_odds, 0);
  assert.ok(Math.abs(sum - 1) < 1e-3, `odds sum ${sum}`);
  for (const t of out.teams) assert.ok(t.title_odds_95[0] <= t.title_odds && t.title_odds <= t.title_odds_95[1]);
  // Playoff and finals odds are the sampled ones, unchanged.
  const off = S.__test.playSeasons(prepFor().prep, teams, 400, true, noisy);
  for (const t of out.teams) {
    const o = off.teams.find(x => x.roster_id === t.roster_id);
    assert.equal(t.playoff_odds, o.playoff_odds);
    assert.equal(t.finals_odds, o.finals_odds);
  }
});

test('on: same expectation as the sampled bracket, with and without team offsets', () => {
  for (const sd of [0, 8]) {
    const runs = 6000;
    const { teams } = prepFor();
    const off = S.__test.playSeasons(prepFor({ sd }).prep, teams, runs, true, noisy);
    const on = S.__test.playSeasons(prepFor({ sd, rb: ON }).prep, teams, runs, true, noisy);
    for (const id of ['1', '2', '3', '4', '5', '6']) {
      const a = off.per_run.get(id).title, b = on.per_run.get(id).title;
      let s = 0, q = 0;
      for (let i = 0; i < runs; i++) { const d = b[i] - a[i]; s += d; q += d * d; }
      const m = s / runs, se = Math.sqrt(Math.max(0, q / runs - m * m) / runs);
      assert.ok(Math.abs(m) < 4 * se + 1e-3, `sd ${sd} team ${id}: bias ${m} se ${se}`);
    }
  }
});

test('on: lower run-to-run variance than the sampled bracket', () => {
  const runs = 3000;
  const { teams } = prepFor();
  const off = S.__test.playSeasons(prepFor().prep, teams, runs, true, noisy);
  const on = S.__test.playSeasons(prepFor({ rb: ON }).prep, teams, runs, true, noisy);
  const variance = a => { let s = 0, q = 0; for (const v of a) { s += v; q += v * v; } const m = s / a.length; return q / a.length - m * m; };
  for (const id of ['1', '2', '3', '4', '5', '6']) {
    const vOff = variance(off.per_run.get(id).title), vOn = variance(on.per_run.get(id).title);
    if (vOff > 0) assert.ok(vOn < vOff, `team ${id}: ${vOn} vs ${vOff}`);
  }
});

test('on: a deterministic season gives the strongest team the title with certainty', () => {
  const { prep, teams } = prepFor({ rb: ON });
  const out = S.__test.playSeasons(prep, teams, 50, false, t => 100 + Number(t.roster_id));
  assert.equal(out.teams.find(t => t.roster_id === '6').title_odds, 1);
});

test('on with a re-seeded bracket: falls back to the sampled champion and says so', () => {
  const { prep, teams } = prepFor({ reseed: true, rb: ON });
  const out = S.__test.playSeasons(prep, teams, 200, true, noisy);
  assert.equal(out.title_estimator, 'sampled');
  assert.match(out.title_estimator_reason, /re-seeded/);
  for (const r of out.per_run.values()) assert.ok(r.title instanceof Uint8Array);
});

test('preview: the payload carries preview fields', () => {
  const { prep, teams } = prepFor({ rb: { on: true, preview: true } });
  const out = S.__test.playSeasons(prep, teams, 100, false, noisy);
  assert.equal(out.preview, true);
  assert.match(out.preview_reason, /RB-TITLE/);
});
