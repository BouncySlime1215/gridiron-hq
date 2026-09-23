/**
 * RL-6-3 (CE-09) — tradeImpact is a paired experiment again.
 *
 * `tradeImpact` seeded both arms the same, but `simulateSeason` handed the one
 * global random stream out in roster-array order, and a trade rebuilds both
 * rosters as `kept + received`. From the first moved slot on, every player in
 * the league (uninvolved teams included) got different random football in the
 * "after" arm, so the title-odds delta was mostly Monte Carlo noise.
 *
 * Fixture: four fantasy teams of five players spread over three NFL games, so
 * the copula has real same-game blocks. Projections, availability and game
 * script are mocked; the outcome pool is drawn from the REAL global random
 * stream (stats-util `random`), and the REAL correlatedSampler is used, so the
 * test sees exactly the two places draws were handed out by position.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rl63-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// Three NFL games every week 1-6: AAA-BBB, CCC-DDD, EEE-FFF.
const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF']];
let nflId = 930;
for (const [h, a] of NFL) {
  const hid = nflId++, aid = nflId++;
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East'), (?, ?, ?, 'NFC', 'West')`,
    hid, h, `${h} team`, aid, a, `${a} team`);
  for (let w = 1; w <= 6; w++) {
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 1)`, hid, w, a);
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 0)`, aid, w, h);
  }
}

const { random } = await import('../server/services/stats-util.js');
const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realContingency = await import('../server/services/contingency.js');

const NFL_TEAMS = NFL.flat();
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR'];
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();          // fantasy team -> asset ids, in payload order
function addPlayer(id, position, nflTeam, mu) {
  assets.set(id, { id, name: `P${id}`, position, team_abbr: nflTeam, espn_id: 9000 + id,
    available: true, current_week_ppg: mu, adj_ppg: mu, ppg: mu, ros_ppg: mu });
  projMap.set(id, { params: { pid: id, mu }, volume: { target_share: position === 'WR' ? 0.2 : null } });
}
let pid = 100;
for (let t = 1; t <= 4; t++) {
  const ids = [];
  LAYOUT.forEach((pos, i) => {
    const id = pid++;
    // Spread each team over the three games so same-game copula blocks mix teams.
    addPlayer(id, pos, NFL_TEAMS[(t + i * 2) % 6], pos === 'QB' ? 18 : (i % 2 ? 12 : 9) + t * 0.3);
    ids.push(id);
  });
  teamPlayers.set(t, ids);
}
// A free agent who never starts (projects ~0), in the busiest game, with the
// highest id: the claim case CE-09's odds ladder needs to be paired.
const FA = 999;
addPlayer(FA, 'RB', NFL_TEAMS[(1 + 1 * 2) % 6], 0.01);

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    // Outcomes come off the real global stream, so WHO consumes which draw matters.
    sampleWeeks: (params, n) => Array.from({ length: n }, () => Math.max(0, params.mu * (0.2 + 1.6 * random())))
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
const { simulateSeason, tradeImpact } = await import('../server/services/season-sim.js?rl63');
const { withRandomSeed } = await import('../server/services/stats-util.js');
const { contradictionBar } = await import('../server/services/trade-verify.js');
const { summariseTitleTrades } = await import('../server/services/title-odds-trades.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Week 1 played; weeks 2-3 regular season; a 2-team final in week 4. */
function payload() {
  const g = (w, h, a, hp, ap) => ({ matchupPeriodId: w, winner: hp == null ? 'UNDECIDED' : hp > ap ? 'HOME' : 'AWAY',
    home: { teamId: h, totalPoints: hp ?? undefined }, away: { teamId: a, totalPoints: ap ?? undefined } });
  return {
    teams: [1, 2, 3, 4].map(t => ({ id: t, divisionId: 0,
      roster: { entries: teamPlayers.get(t).map(id => ({ lineupSlotId: 20,
        playerPoolEntry: { player: { id: 9000 + id, fullName: `P${id}`,
          defaultPositionId: { QB: 1, RB: 2, WR: 3 }[assets.get(id).position] } } })) } })),
    schedule: [g(1, 1, 2, 100, 90), g(1, 3, 4, 95, 99), g(2, 1, 3), g(2, 2, 4), g(3, 1, 4), g(3, 2, 3)],
    settings: { scheduleSettings: { matchupPeriodCount: 3, matchupPeriodLength: 1, playoffTeamCount: 2,
      playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: 4 }] } }
  };
}
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
     payload, current_week, payload_season, fetched_at) VALUES (631, 'espn', 'rl63', 2026, 'CRN', '1', 4, 1, ?, ?, 2, 2026, '2026-09-23T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 631').get();

const RUNS = 400;
const shape = sim => sim.teams.map(t => [t.roster_id, t.title_odds, t.playoff_odds, t.expected_wins, t.expected_points])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const sim = (seed, overrides = null) => withRandomSeed(seed,
  () => simulateSeason(league(), { runs: RUNS, fromWeek: 2, overrides }));

test('RL-6-3: a roster-order-only permutation leaves every team\'s odds exactly unchanged', () => {
  const base = sim(11);
  assert.ifError(base.error);
  const reversed = new Map([...teamPlayers].map(([t, ids]) => [String(t), [...ids].reverse()]));
  assert.deepEqual(shape(sim(11, reversed)), shape(base),
    'same players on the same teams, only listed in a different order, must be the same simulated season');

  // Known-nonzero control: a real roster change (swap the two teams' QBs) moves the odds.
  const [q1, q2] = [teamPlayers.get(1)[0], teamPlayers.get(4)[0]];
  const swapped = new Map([
    ['1', [q2, ...teamPlayers.get(1).slice(1)]], ['4', [q1, ...teamPlayers.get(4).slice(1)]]]);
  assert.notDeepEqual(shape(sim(11, swapped)), shape(base), 'control: a real change must move something');
});

test('RL-6-3: a bench free agent who never starts changes nothing, for any team, to 1e-9', () => {
  const base = sim(12);
  const claim = new Map([['4', [...teamPlayers.get(4), FA]]]);
  const after = sim(12, claim);
  for (const [a, b] of shape(after).map((row, i) => [row, shape(base)[i]])) {
    for (let k = 1; k < a.length; k++) {
      assert.ok(Math.abs(a[k] - b[k]) <= 1e-9, `team ${a[0]} field ${k}: ${b[k]} -> ${a[k]} after a benched claim`);
    }
  }
});

test('RL-6-3: tradeImpact publishes a paired standard error below the unpaired one', () => {
  const [give, get] = [teamPlayers.get(1)[1], teamPlayers.get(2)[2]];
  const impact = tradeImpact(league(), { myTeamId: 1, theirTeamId: 2, iGive: [give], iGet: [get], runs: RUNS, seed: 5 });
  assert.ifError(impact.error);
  for (const side of [impact.me, impact.them]) {
    assert.equal(typeof side.title_delta_se, 'number', 'title_delta_se is published');
    assert.equal(typeof side.playoff_delta_se, 'number', 'playoff_delta_se is published');
    const unpaired = Math.sqrt((side.title_before * (1 - side.title_before) + side.title_after * (1 - side.title_after)) / RUNS);
    assert.ok(side.title_delta_se < unpaired,
      `paired SE ${side.title_delta_se} must be below the unpaired binomial SE ${unpaired.toFixed(4)}`);
    assert.equal(side.title_delta_clears_noise, Math.abs(side.title_delta) > 2 * side.title_delta_se);
  }
});

test('RL-6-3: seed-to-seed spread of the delta is below that of two independent runs', () => {
  const [give, get] = [teamPlayers.get(1)[1], teamPlayers.get(2)[2]];
  const trade = new Map([
    ['1', [...teamPlayers.get(1).filter(id => id !== give), get]],
    ['2', [...teamPlayers.get(2).filter(id => id !== get), give]]]);
  const me = s => s.teams.find(t => t.roster_id === '1').title_odds;
  const paired = [], unpaired = [];
  for (let s = 1; s <= 8; s++) {
    paired.push(tradeImpact(league(), { myTeamId: 1, theirTeamId: 2, iGive: [give], iGet: [get], runs: RUNS, seed: s }).me.title_delta);
    unpaired.push(me(sim(1000 + s, trade)) - me(sim(s)));
  }
  const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  assert.ok(sd(paired) < sd(unpaired), `paired sd ${sd(paired).toFixed(4)} vs unpaired ${sd(unpaired).toFixed(4)}`);
});

test('RL-6-3: with no seed, one deal on one league state gives one answer', () => {
  const args = { myTeamId: 1, theirTeamId: 2, iGive: [teamPlayers.get(1)[1]], iGet: [teamPlayers.get(2)[2]], runs: 200 };
  const a = tradeImpact(league(), args), b = tradeImpact(league(), args);
  assert.equal(a.seed, b.seed, 'the default seed follows the league state, not the clock');
  assert.deepEqual(a.me, b.me);
  const resynced = { ...league(), fetched_at: '2026-09-23T09:00:00Z' };
  assert.notEqual(tradeImpact(resynced, args).seed, a.seed, 'control: a re-sync gives a new seed');
});

test('RL-6-3: the sense-check bar uses the published paired SE when there is one', () => {
  assert.equal(contradictionBar(1200, undefined, 0.02).noise_bar, 0.04, '2 x the published SE');
  assert.equal(contradictionBar(1200, undefined, 0.002).required, 0.01, 'the material floor still binds');
  // Control: with no SE the measured constant is used, as before.
  assert.equal(contradictionBar(1200).noise_bar, +(2 * 0.0155 * Math.sqrt(600 / 1200)).toFixed(4));
});

test('RL-6-3: Title-impact banners fire only on deltas that clear the noise', () => {
  const deal = (title_delta, se, ppg_delta, partner) => ({ partner, ppg_delta, title_delta,
    title_delta_se: se, title_delta_clears_noise: Math.abs(title_delta) > 2 * se });
  // Every deal adds points and "lowers" title odds, but one is inside the noise.
  const noisy = summariseTitleTrades([deal(-0.03, 0.005, 2, 'A'), deal(-0.004, 0.005, 1, 'B')]);
  assert.equal(noisy.every_deal_helps_points_hurts_title, false, 'a delta inside 2 SE is not a "lowers"');
  // Control: both clear the noise -> the banner fires.
  const real = summariseTitleTrades([deal(-0.03, 0.005, 2, 'A'), deal(-0.02, 0.005, 1, 'B')]);
  assert.equal(real.every_deal_helps_points_hurts_title, true);
  // "Points is the one to ignore" needs a title pick that is itself real.
  const pick = summariseTitleTrades([deal(0.004, 0.005, 1, 'A'), deal(-0.001, 0.005, 3, 'B')]);
  assert.equal(pick.objectives_disagree, false, 'a title "pick" inside the noise is not a disagreement');
});
