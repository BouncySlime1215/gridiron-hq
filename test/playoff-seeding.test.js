/**
 * PLAYOFF-SEEDING (plan items 47 + 48): seed values, win targets and must-win weeks off the
 * season sim's own runs (server/services/playoff-path.js via season-sim.js#playSeasons).
 * Pass bar B1-B5: docs/tdd/PLAYOFF-SEEDING-PREREG.md. Made-up leagues only (roster ids 1-10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-playoff-seeding-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const { __test } = await import('../server/services/season-sim.js');
const { playoffPathMode, playoffPathFor, byeSeedCount, PLAYOFF_PATH_ENV, MUST_WIN_MIN_LEVERAGE, MUST_WIN_SE, MUST_WIN_VS_MEDIAN } =
  await import('../server/services/playoff-path.js');
const { planLeague } = await import('../server/services/campaign/planner.js');
const { toEntry } = await import('../server/services/campaign/view.js');
const { normaliseObjective } = await import('../server/services/campaign/objectives.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------ a made-up league */

// Deterministic normal draws keyed by (team, run, week).
function hash(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) { h ^= x >>> 0; h = Math.imul(h, 16777619) >>> 0; h ^= h >>> 13; h = Math.imul(h, 2654435761) >>> 0; }
  return (h >>> 0) / 4294967296;
}
const normal = (...k) => {
  const u = Math.max(1e-12, hash(...k, 1)), v = hash(...k, 2);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** 10 teams, weeks 1-14 round-robin (circle method), 6-team fixed bracket in weeks 15-17 (2 byes). */
function league({ strength = {}, reseed = false, fromWeek = 1 } = {}) {
  const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const sched = new Map();
  for (let w = 1; w <= 14; w++) {
    const r = (w - 1) % 9, rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + r) % 9)])];
    sched.set(w, Array.from({ length: 5 }, (_, i) => [rot[i], rot[9 - i]]));
  }
  const rules = {
    schedule: { playoff_weeks: [[15], [16], [17]], reseed, playoff_teams: 6 },
    seeding: { tiebreaker: 'TOTAL_POINTS_SCORED', division_winners_first: false },
    median_game: false, source: 'test', unknown: []
  };
  const points = (t, run, week) => 100 + (strength[t.roster_id] ?? 0) + 20 * normal(Number(t.roster_id), run, week);
  // Weeks before fromWeek are carried in as ESPN-shaped results (run 99999's draws), like a real payload.
  const schedule = [...sched].filter(([w]) => w < fromWeek).flatMap(([w, games]) => games.map(([a, b]) => ({
    matchupPeriodId: w, home: { teamId: Number(a), totalPoints: points({ roster_id: a }, 99999, w) },
    away: { teamId: Number(b), totalPoints: points({ roster_id: b }, 99999, w) } })));
  const prep = {
    lg: { id: 1, platform: 'espn', payload: JSON.stringify({ schedule }) }, rules, fromWeek, sched, weeks: [...sched.keys()].filter(w => w >= fromWeek), bracketWeeks: rules.schedule.playoff_weeks,
    playoffTeams: 6, medianGame: false, teamMeanSd: 0, world: 7, rbTitle: 'off'
  };
  const teams = ids.map(id => ({ roster_id: id, owner: `team ${id}`, players: [] }));
  return { prep, teams, points, ids };
}

const play = (L, runs, opts) => __test.playSeasons(L.prep, L.teams, runs, false, L.points, opts);

/* ------------------------------------------------------------ flag */

test('flag: off unless GRIDIRON_PLAYOFF_SEEDING is shadow or 1; preview never turns it on', () => {
  assert.equal(PLAYOFF_PATH_ENV, 'GRIDIRON_PLAYOFF_SEEDING');
  assert.equal(playoffPathMode({}), 'off');
  assert.equal(playoffPathMode({ GRIDIRON_PLAYOFF_SEEDING: '0' }), 'off');
  assert.equal(playoffPathMode({ GRIDIRON_PREVIEW_UNCONFIRMED: '1' }), 'off');
  assert.equal(playoffPathMode({ GRIDIRON_PLAYOFF_SEEDING: 'shadow' }), 'shadow');
  assert.equal(playoffPathMode({ GRIDIRON_PLAYOFF_SEEDING: '1' }), 'shadow');
});

test('byeSeedCount: slots past the field are byes for the top seeds', () => {
  assert.equal(byeSeedCount(6, 3), 2);
  assert.equal(byeSeedCount(4, 2), 0);
  assert.equal(byeSeedCount(8, 3), 0);
  assert.equal(byeSeedCount(5, 3), 3);
});

/* ------------------------------------------------------------ B5 off is off */

test('B5: without the option the sim output has no playoff_path and is otherwise identical', () => {
  const L = league();
  const off = play(L, 300);
  const on = play(L, 300, { playoffPath: true });
  assert.equal('playoff_path' in off, false);
  const { playoff_path, ...rest } = on;
  assert.ok(playoff_path);
  assert.deepEqual(rest, off);
});

/* ------------------------------------------------------------ B1 exactness, B2 monotone, B3 identity */

test('B1: equal teams, 6-team fixed bracket with 2 byes: title at seeds 1-2 = 1/4, seeds 3-6 = 1/8 (3 SE, 4,000 runs)', () => {
  const L = league();
  const out = play(L, 4000, { playoffPath: true });
  const pp = out.playoff_path;
  assert.equal(pp.bye_seeds, 2);
  for (const id of L.ids) {
    const t = pp.teams[id];
    for (const s of t.seeds) {
      const want = s.seed <= 2 ? 0.25 : 0.125;
      assert.ok(Math.abs(s.title_if_seed - want) <= 3 * s.title_if_seed_se,
        `team ${id} seed ${s.seed}: ${s.title_if_seed} vs ${want} (se ${s.title_if_seed_se})`);
      assert.equal(s.bye, s.seed <= 2);
    }
    // Finish probabilities sum to the playoff odds.
    const sum = t.seeds.reduce((a, s) => a + s.p_finish, 0);
    assert.ok(Math.abs(sum - t.spot.playoff_odds) < 1e-3, `team ${id}: ${sum} vs ${t.spot.playoff_odds}`);
    // The served playoff odds and the block's agree.
    assert.equal(t.spot.playoff_odds, out.teams.find(x => x.roster_id === id).playoff_odds);
    // A bye is worth 1/4 - 1/8 here.
    assert.ok(Math.abs(t.bye_value.title_gain - 0.125) <= 3 * t.bye_value.se, `team ${id} bye ${JSON.stringify(t.bye_value)}`);
  }
  // Every seed is held by exactly one team in every run.
  for (let k = 0; k < 6; k++) {
    const sum = L.ids.reduce((a, id) => a + pp.teams[id].seeds[k].p_finish, 0);
    assert.ok(Math.abs(sum - 1) < 1e-3, `seed ${k + 1} sums to ${sum}`);
  }
});

test('B2 + B3: forcing a win never lowers playoff odds in any run; the actual seed replays the served champion', () => {
  const L = league({ strength: { 1: 12, 2: 6, 9: -8 } });
  const pp = play(L, 1500, { playoffPath: true }).playoff_path;
  for (const id of L.ids) {
    assert.equal(pp.teams[id].checks.monotone_breaks, 0, `team ${id} monotone`);
    assert.equal(pp.teams[id].checks.identity_breaks, 0, `team ${id} identity`);
    for (const w of pp.teams[id].weeks) {
      assert.ok(w.leverage >= 0, `team ${id} week ${w.week}`);
      assert.ok(Math.abs(w.leverage - (w.playoff_if_win - w.playoff_if_loss)) < 1e-3);
    }
  }
  // The same holds on a re-seeded bracket.
  const rs = play(league({ reseed: true, strength: { 3: 10 } }), 600, { playoffPath: true }).playoff_path;
  for (const id of L.ids) assert.equal(rs.teams[id].checks.identity_breaks, 0, `reseed team ${id}`);
});

/* ------------------------------------------------------------ B4 precision, and the served shape */

test('B4: at 1,200 runs every playoff-level number carries an SE <= 0.015', () => {
  const L = league({ strength: { 1: 8 } });
  const pp = play(L, 1200, { playoffPath: true }).playoff_path;
  for (const id of L.ids) {
    const t = pp.teams[id];
    assert.ok(t.spot.playoff_odds_se != null && t.spot.playoff_odds_se <= 0.015);
    for (const s of t.seeds) { assert.ok(s.p_finish_se != null && s.p_finish_se <= 0.015); assert.ok(s.title_if_seed_se != null); }
    for (const w of t.weeks) { assert.ok(w.leverage_se != null && w.leverage_se <= 0.015, `lev se ${w.leverage_se}`); assert.ok(w.p_win_se <= 0.015); }
    for (const r of t.win_targets.table) assert.ok(r.p_playoffs_se != null);
  }
});

test('win targets: the 50% target is the smallest well-sampled win total that reaches it; more wins needed never negative', () => {
  const L = league({ strength: { 1: 10 } });
  const t = play(L, 2000, { playoffPath: true }).playoff_path.teams['1'];
  const wt = t.win_targets;
  assert.equal(wt.current_wins, 0);
  assert.equal(wt.remaining_games, 14);
  assert.ok(Number.isFinite(wt.playoffs_50.wins));
  const row = wt.table.find(r => r.wins === wt.playoffs_50.wins);
  assert.ok(row.p_playoffs >= 0.5 && row.n >= 20);
  assert.ok(wt.table.filter(r => r.wins < row.wins && r.n >= 20).every(r => r.p_playoffs < 0.5));
  assert.ok(wt.playoffs_90.wins == null || wt.playoffs_90.wins >= wt.playoffs_50.wins);
  assert.equal(wt.playoffs_50.more_needed, wt.playoffs_50.wins);
  // The on-pace line reaches the 50% target by the last remaining week.
  assert.equal(t.weeks.at(-1).on_pace_wins, wt.playoffs_50.wins);
  assert.ok(t.weeks.every((w, i, a) => i === 0 || w.on_pace_wins >= a[i - 1].on_pace_wins));
});

test('must-win weeks follow the pre-registered rule; posture is a labelled guess from P(win)', () => {
  const L = league({ strength: { 1: 4 } });
  const t = play(L, 2000, { playoffPath: true }).playoff_path.teams['1'];
  const top3 = [...t.weeks].sort((a, b) => b.leverage - a.leverage).slice(0, 3).map(w => w.week);
  for (const w of t.weeks) {
    const want = top3.includes(w.week) && w.leverage >= MUST_WIN_MIN_LEVERAGE && w.leverage >= MUST_WIN_VS_MEDIAN * t.leverage_median
      && w.leverage - MUST_WIN_SE * w.leverage_se > 0;
    assert.equal(w.must_win, want, `week ${w.week}`);
    assert.equal(w.posture.guess, true);
    assert.equal(w.posture.mode, w.p_win >= 0.5 ? 'protect_floor' : 'chase_ceiling');
  }
  assert.deepEqual(t.must_win_weeks, t.weeks.filter(w => w.must_win).map(w => w.week));
});

/* ------------------------------------------------------------ wiring: world -> planner -> plans.json _run */

test('wiring: the planner copies Nick\'s block from the world base; plans.json carries it under _run.inputs.playoff_path', () => {
  const L = league();
  const pp = play(L, 200, { playoffPath: true }).playoff_path;
  const mine = playoffPathFor({ playoff_path: pp }, '1');
  assert.equal(mine.me, '1');
  assert.equal(mine.flag, 'shadow');
  assert.ok(Array.isArray(mine.seeds) && Array.isArray(mine.weeks));
  assert.equal(playoffPathFor({}, '1'), null);
  assert.equal(playoffPathFor(null, '1'), null);

  const adapter = makeAdapter();
  const world = adapter.world;
  adapter.world = s => ({ ...world(s), base: { playoff_path: pp } });
  const res = planLeague(adapter, { objective: normaliseObjective({}), skips: { player: new Map(), manager: new Map() }, previous: null });
  assert.equal(res.playoff_path.me, '1');
  const entry = toEntry(res, { names: adapter.names(), as_of: '2026-09-25T00:00:00Z' });
  assert.deepEqual(entry._run.inputs.playoff_path, res.playoff_path);

  // No base block (flag off): nothing is written.
  const plain = planLeague(makeAdapter(), { objective: normaliseObjective({}), skips: { player: new Map(), manager: new Map() }, previous: null });
  assert.equal(plain.playoff_path, null);
  assert.equal('playoff_path' in toEntry(plain, { as_of: '2026-09-25T00:00:00Z' })._run.inputs, false);
});

test('must-win: when every week matters about equally nothing is singled out; late in a season the record is carried in', () => {
  // Even teams from week 1: leverages are alike, so no week clears 1.25x the median.
  const even = play(league(), 2000, { playoffPath: true }).playoff_path.teams['1'];
  assert.deepEqual(even.must_win_weeks, []);
  assert.ok(even.leverage_median > 0);
  // From week 12: only weeks 12-14 are left, and the 11 carried-in games are the current record.
  const L = league({ strength: { 1: 0 }, fromWeek: 12 });
  const out = play(L, 3000, { playoffPath: true });
  const t = out.playoff_path.teams['1'];
  assert.deepEqual(t.weeks.map(w => w.week), [12, 13, 14]);
  assert.equal(t.win_targets.remaining_games, 3);
  const carried = L.ids.reduce((a, id) => a + out.playoff_path.teams[id].win_targets.current_wins, 0);
  assert.equal(carried, 5 * 11, 'every carried-in game gave one win');
  for (const w of t.weeks) assert.ok(w.leverage >= 0 && w.leverage_se != null);
  for (const id of L.ids) assert.equal(out.playoff_path.teams[id].checks.monotone_breaks, 0);
});
