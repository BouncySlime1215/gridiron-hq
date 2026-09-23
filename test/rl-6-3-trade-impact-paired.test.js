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
let lastScoring = null;                 // the scoring tradeImpact built projections with
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
// Free agents who never start (project ~0), in the busiest game: the claim case
// CE-09's odds ladder needs to be paired. FA has the highest id; FA_LOW sorts
// BEFORE every rostered player, so without a shared player universe he would
// shift the copula rows of everyone in his game (skeptic's case, 2026-09-23).
const FA = 999, FA_LOW = 50;
addPlayer(FA, 'RB', NFL_TEAMS[(1 + 1 * 2) % 6], 0.01);
addPlayer(FA_LOW, 'RB', NFL_TEAMS[(1 + 1 * 2) % 6], 0.01);

mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    // The Title-impact tab's shortlist: one fixed deal, team 1's RB for team 2's WR.
    findTrades: () => ({ deals: [{ partner: 'T2', partner_id: '2', fairness: 'fair', me: { ppg_delta: 1 },
      i_give: [{ id: teamPlayers.get(1)[1], name: 'G', position: 'RB', value: 1 }],
      i_get: [{ id: teamPlayers.get(2)[2], name: 'R', position: 'WR', value: 1 }] }] })
  }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: (opts = {}) => { lastScoring = opts.scoring ?? null; return projMap; },
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
const simModule = await import('../server/services/season-sim.js?rl63');
const { simulateSeason, tradeImpact } = simModule;
// trade-engine.js imports season-sim.js, so the plain season-sim instance was
// loaded (unmocked) by the `realTradeEngine` import above. Point the Title-impact
// tab at the mocked instance, or its deals are simulated on empty projections
// (every team scores 0, team 1 wins every run, every delta and SE is 0).
mock.module('../server/services/season-sim.js', { namedExports: { ...simModule } });
const { withRandomSeed } = await import('../server/services/stats-util.js');
const { contradictionBar, judgeTradeVerdict } = await import('../server/services/trade-verify.js');
const { mutualTitleGain, summariseTitleTrades, titleOddsTrades } = await import('../server/services/title-odds-trades.js?rl63');

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
const sim = (seed, overrides = null, universe = null) => withRandomSeed(seed,
  () => simulateSeason(league(), { runs: RUNS, fromWeek: 2, overrides, universe }));
const assertSameOdds = (after, base, what) => {
  for (const [a, b] of shape(after).map((row, i) => [row, shape(base)[i]])) {
    for (let k = 1; k < a.length; k++) {
      assert.ok(Math.abs(a[k] - b[k]) <= 1e-9, `team ${a[0]} field ${k}: ${b[k]} -> ${a[k]} ${what}`);
    }
  }
};

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

test('RL-6-3: a bench free agent who never starts changes nothing, for any team and any id, to 1e-9', () => {
  // Both arms simulate one shared player universe (the claimed player is in it),
  // which is the contract tradeImpact and CE-09's claim ladder use.
  for (const fa of [FA, FA_LOW]) {
    const base = sim(12, null, [fa]);
    const after = sim(12, new Map([['4', [...teamPlayers.get(4), fa]]]), [fa]);
    assertSameOdds(after, base, `after a benched claim of id ${fa}`);
  }
  // Known-nonzero control: WITHOUT the shared universe, the low-id claim moves an
  // uninvolved team (0.305 -> 0.3075 for team 1 on head 79a1b1ca), because he
  // enters the same-game copula block ahead of everyone else in it.
  const unshared = sim(12, new Map([['4', [...teamPlayers.get(4), FA_LOW]]]));
  assert.notDeepEqual(shape(unshared), shape(sim(12)), 'control: an unshared universe is not paired');
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

test('RL-6-3: the sense-check judge reads the impact\'s own paired SE (call site)', () => {
  const side = (d, se) => ({ roster_id: '1', owner: 'x', title_before: 0.2, title_after: 0.2 + d, title_delta: d,
    title_delta_se: se, playoff_before: 0.5, playoff_after: 0.5, playoff_delta: 0, wins_delta: 0 });
  const impact = { runs: 1200, seed: 1, paired_simulation: true, me: side(-0.015, 0.003), them: side(0.01, 0.003) };
  const j = judgeTradeVerdict(impact, 'sound');
  assert.equal(j.threshold.noise_bar, 0.006, 'noise bar is 2 x this deal\'s SE, not the 2.2pp constant');
  assert.equal(j.contradicted, true, 'a -1.5pp loss past a 1.0pp bar contradicts "sound"');
});

test('RL-6-3: the Title-impact tab shows the same numbers tradeImpact gives the card and the sense-check (call site)', () => {
  // 300 runs: on this fixture my delta clears the noise and theirs does not, so
  // a me/them swap of any field is visible.
  const out = titleOddsTrades(631, { teamId: '1', shortlist: 2, runs: 300 });
  assert.ifError(out.error);
  const d = out.deals[0];
  assert.ok(d, 'control: the fixture deal was simulated');
  // TradeCard (POST /model/:id/trade-impact) and the sense-check call tradeImpact
  // with no seed and no scoring: the defaults must be what this tab shows.
  const ref = tradeImpact(league(), { myTeamId: 1, theirTeamId: 2,
    iGive: d.i_give.map(p => p.id), iGet: d.i_get.map(p => p.id), runs: 300 });
  // Non-degenerate: team 1 is not a lock and the two sides' SEs differ, so a
  // me/them swap or a wrong seed cannot pass.
  assert.ok(ref.me.title_before > 0 && ref.me.title_before < 1, `team 1 title odds ${ref.me.title_before}`);
  assert.ok(ref.me.title_delta_se > 0 && ref.me.title_delta_se !== ref.them.title_delta_se,
    `me SE ${ref.me.title_delta_se} vs them SE ${ref.them.title_delta_se}`);
  assert.notEqual(ref.me.title_delta_clears_noise, ref.them.title_delta_clears_noise, 'fixture: the two flags differ');
  assert.equal(d.title_delta, ref.me.title_delta, 'one deal, one delta on every surface');
  assert.equal(d.title_delta_se, ref.me.title_delta_se);
  assert.equal(d.title_delta_clears_noise, ref.me.title_delta_clears_noise);
  assert.equal(d.playoff_delta, ref.me.playoff_delta);
  assert.equal(d.their_title_delta, ref.them.title_delta);
  assert.equal(d.their_title_delta_se, ref.them.title_delta_se);
  assert.equal(d.their_title_delta_clears_noise, ref.them.title_delta_clears_noise);
  assert.equal(d.mutual_title_gain, mutualTitleGain(ref.me, ref.them));
  assert.equal(out.no_deal_clears_noise, !out.deals.some(x => x.title_delta_clears_noise === true));
});

test('RL-6-3: mutual_title_gain needs BOTH sides up AND past the noise', () => {
  const up = { title_delta: 0.05, title_delta_clears_noise: true };
  const upNoisy = { title_delta: 0.05, title_delta_clears_noise: false };
  const down = { title_delta: -0.05, title_delta_clears_noise: true };
  assert.equal(mutualTitleGain(up, up), true);
  assert.equal(mutualTitleGain(up, upNoisy), false, 'their gain inside the noise');
  assert.equal(mutualTitleGain(upNoisy, up), false, 'my gain inside the noise');
  assert.equal(mutualTitleGain(up, down), false);
  assert.equal(mutualTitleGain(down, up), false);
});

test('RL-6-3: tradeImpact pairs a received free agent (claim) for any id', () => {
  // Team 4 picks up a never-starting free agent from nobody: team 2 is untouched,
  // so its delta must be exactly 0 and team 4's too (he never starts).
  for (const fa of [FA, FA_LOW]) {
    const impact = tradeImpact(league(), { myTeamId: 4, theirTeamId: 2, iGive: [], iGet: [fa], runs: RUNS, seed: 12 });
    assert.ifError(impact.error);
    for (const side of [impact.me, impact.them]) {
      assert.equal(side.title_delta, 0, `team ${side.roster_id} title delta after claiming id ${fa}`);
      assert.equal(side.playoff_delta, 0, `team ${side.roster_id} playoff delta after claiming id ${fa}`);
    }
  }
});

test('RL-6-3: one run count, one seed and the league\'s scoring behind every title-odds delta', async () => {
  // The tab's default run count is the card's and the sense-check's.
  const { TRADE_IMPACT_RUNS } = simModule;
  const { SENSE_CHECK_SIM_RUNS } = await import('../server/services/trade-verify.js');
  assert.equal(TRADE_IMPACT_RUNS, SENSE_CHECK_SIM_RUNS);
  const out = titleOddsTrades(631, { teamId: '1', shortlist: 1 });
  assert.ifError(out.error);
  assert.equal(out.runs_each, TRADE_IMPACT_RUNS, 'Title-impact tab default runs');

  // tradeImpact scores in the league's own format when the caller names none
  // (the Title-impact tab used to fall through to PPR in every league).
  const { scoringFor, PPR } = await import('../server/services/scoring.js');
  const standard = { ...league(), ppr: 0 };
  tradeImpact(standard, { myTeamId: 1, theirTeamId: 2, iGive: [teamPlayers.get(1)[1]], iGet: [teamPlayers.get(2)[2]], runs: 50 });
  assert.deepEqual(lastScoring, scoringFor(standard));
  assert.notDeepEqual(lastScoring, PPR, 'control: a 0-PPR league is not scored PPR');

  // Source pin (the routes are not mounted here): no caller hands tradeImpact
  // its own seed, so the tab, TradeCard and the sense-check share tradeImpactSeed(lg).
  for (const f of ['../server/routes/trades.js', '../server/services/title-odds-trades.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (let i = src.indexOf('tradeImpact('); i >= 0; i = src.indexOf('tradeImpact(', i + 1)) {
      const call = src.slice(i, src.indexOf('});', i));
      assert.doesNotMatch(call, /\bseed\s*:/, `${f}: tradeImpact called with its own seed`);
      assert.doesNotMatch(call, /\bscoring\s*:/, `${f}: tradeImpact called with its own scoring`);
    }
  }
});
