/**
 * EA-07 — one world per NFL week (BROKEN-NUMBERS rows B and C; folds RL-17-3, row A).
 *
 * Contract, with GRIDIRON_ONE_WORLD on:
 *   B. The My team twin (/simulate -> oneWorldTitleOdds), the playoff odds behind the
 *      trade horizon (myPlayoffOdds), the Title tab (titleOddsTrades) and the
 *      TradeCard (tradeImpact with the league world) start from ONE title.odds row
 *      per snapshot: the same numbers, the same world id.
 *   C. A player-week's range is the one world's pool: worldRange's p10/p90 are the
 *      draws the title-odds copula indexes at u = 0.1/0.9, the trade card's pool
 *      (worldPoolFor, what trade-engine.js draws) is the identical array, and the
 *      ceiling lineup ranks on the same pool means.
 *   The world is the NFL week's (keyedSeed('world', season, week)): a re-sync with
 *   the same rosters does not re-roll it; a new NFL week does.
 *   Off (the default): nothing changes.
 *
 * Fixture: RL-17-3's (RL-19-2's four-team league over three NFL games, real copula,
 * a sampler whose mean is ppg x the volume multiplier).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ea07-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_ONE_WORLD;
delete process.env.GRIDIRON_RL17_3_ENABLED;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF']];
let nflId = 940;
for (const [h, a] of NFL) {
  const hid = nflId++, aid = nflId++;
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East'), (?, ?, ?, 'NFC', 'West')`,
    hid, h, `${h} team`, aid, a, `${a} team`);
  for (let w = 1; w <= 6; w++) {
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 1)`, hid, w, a);
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 0)`, aid, w, h);
  }
}

const { random, keyedSeed } = await import('../server/services/stats-util.js');
const { scoringFor } = await import('../server/services/scoring.js');
const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realContingency = await import('../server/services/contingency.js');
const realLineupBrain = await import('../server/services/lineup-brain.js');

const NFL_TEAMS = NFL.flat();
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR'];
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();
function addPlayer(id, position, nflTeam, ros, last) {
  assets.set(id, { id, name: `P${id}`, position, team_abbr: nflTeam, espn_id: 9000 + id,
    available: true, current_week_ppg: ros, adj_ppg: ros, ppg: last, ros_ppg: ros });
  projMap.set(id, { ppg: last, params: { pid: id, mu: last }, volume: { target_share: null } });
}
let pid = 100, k = 0;
for (let t = 1; t <= 4; t++) {
  const ids = [];
  LAYOUT.forEach((pos, i) => {
    const id = pid++;
    const ros = (pos === 'QB' ? 17 : 8) + ((k * 7) % 11) * 0.9;
    const last = Math.max(1, ros + [5, -4, 1, -5, 3, -2, 4, 0, -3, 2][k % 10]);
    k++;
    addPlayer(id, pos, NFL_TEAMS[(t + i * 2) % 6], ros, last);
    ids.push(id);
  });
  teamPlayers.set(t, ids);
}

const P = (t, i) => teamPlayers.get(t)[i];
// The finder's shortlist, as findTrades would hand it to the Title tab.
const DEALS = [
  { myTeamId: 1, theirTeamId: 2, iGive: [P(1, 1)], iGet: [P(2, 2)] },
  { myTeamId: 1, theirTeamId: 3, iGive: [P(1, 1), P(1, 3)], iGet: [P(3, 4)] }
];
const asFound = d => ({
  partner: `T${d.theirTeamId}`, partner_id: String(d.theirTeamId),
  i_give: d.iGive.map(id => ({ ...assets.get(id), value: id })),
  i_get: d.iGet.map(id => ({ ...assets.get(id), value: id })),
  me: { ppg_delta: 1, value_delta: 0 }, fairness: 0.5
});

mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine, assetUniverse: () => assets,
    findTrades: () => ({ deals: DEALS.map(asFound) })
  }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n, _scoring, mult = 1, activeProbability = 1) => {
      const m = typeof mult === 'object' ? mult.pass : mult;
      return Array.from({ length: n }, () => (random() > activeProbability ? 0 : params.mu * m * (0.2 + 1.6 * random())));
    }
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
mock.module('../server/services/lineup-brain.js', {
  namedExports: { ...realLineupBrain, irOnRoster: () => new Map() }
});

// Fresh instances of the modules under test, each importing the mocks above and
// each other (trade-engine.js was already loaded unmocked to spread its exports).
const sim = await import('../server/services/season-sim.js?ea07');
mock.module('../server/services/season-sim.js', { namedExports: { ...sim } });
const leagueWorldMod = await import('../server/services/league-world.js?ea07');
mock.module('../server/services/league-world.js', { namedExports: { ...leagueWorldMod } });
const { titleOddsTrades } = await import('../server/services/title-odds-trades.js?ea07');
const { myPlayoffOdds } = await import('../server/services/trade-engine.js?ea07');
const { ceilingLineup } = await import('../server/services/ceiling-lineup.js?ea07');
const { lineupMoments, SPREAD_SCALE } = await import('../server/services/lineup-posture.js');
const { rangeFromPool, oneWorldSeed, ONE_WORLD_ENV } = await import('../server/services/one-world.js');
const { tradeImpact, tradeImpactSeed, worldPoolFor } = sim;
const { leagueWorld, oneWorldTitleOdds, worldRange, clearLeagueWorlds, ONE_WORLD_RUNS } = leagueWorldMod;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

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
     payload, current_week, payload_season, fetched_at) VALUES (4, 'espn', 'ea07', 2026, 'One world', '1', 4, 1, ?, ?, 2, 2026, '2026-09-24T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 4').get();

const withEnv = (vars, fn) => {
  const prior = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  const set = (key, v) => { if (v == null) delete process.env[key]; else process.env[key] = v; };
  for (const [key, v] of Object.entries(vars)) set(key, v);
  try { return fn(); } finally { for (const [key, v] of Object.entries(prior)) set(key, v); }
};
const on = fn => withEnv({ [ONE_WORLD_ENV]: '1' }, fn);
const titleOf = (res, id = '1') => res.teams.find(t => t.roster_id === id);

test('EA-07 off (default): the per-sync seed and the result shape are unchanged', () => {
  const lg = league();
  assert.equal(tradeImpactSeed(lg), keyedSeed('trade-impact', lg.id, lg.fetched_at));
  const res = tradeImpact(lg, { ...DEALS[0], runs: 200 });
  assert.ifError(res.error);
  assert.equal(res.world_id, undefined, 'no one-world field while off');
  assert.equal(res.projection_basis, undefined, 'and no RL-17-3 basis');
});

test('EA-07 RED (row B): twin, playoff odds, Title tab and TradeCard read one title.odds per snapshot', () => {
  on(() => {
    clearLeagueWorlds();
    const lg = league();
    const twin = oneWorldTitleOdds(lg);
    assert.ifError(twin.error);
    assert.equal(twin.runs, ONE_WORLD_RUNS);
    assert.equal(twin.projection_basis, 'ros', 'the one world reads proj.ros (RL-17-3 folded)');
    assert.equal(twin.one_world.world_id, oneWorldSeed(2026, 2));
    assert.equal(twin.per_run, undefined, 'per-run arrays stay in memory, not in the response');
    const mine = titleOf(twin);

    // TradeCard: one deal, on the league world.
    const card = tradeImpact(lg, { ...DEALS[0], runs: ONE_WORLD_RUNS, world: leagueWorld(lg) });
    assert.equal(card.world_reused, true);
    assert.equal(card.world_id, twin.one_world.world_id);
    assert.equal(card.me.title_before, mine.title_odds);
    assert.equal(card.me.playoff_before, mine.playoff_odds);
    assert.equal(card.them.title_before, titleOf(twin, '2').title_odds);

    // Title tab: every shortlisted deal starts from the same row.
    const tab = titleOddsTrades(lg.id, { shortlist: 2, requireMutual: false });
    assert.ifError(tab.error);
    assert.equal(tab.simulated, 2);
    assert.equal(tab.title_now, mine.title_odds);
    assert.equal(tab.one_world.snapshot_id, twin.one_world.snapshot_id);
    for (const d of tab.deals) assert.equal(d.title_before, mine.title_odds);

    // The playoff odds the trade horizon is built on.
    const horizon = myPlayoffOdds(lg, '1');
    assert.equal(horizon.value, +mine.playoff_odds.toFixed(2));
    assert.match(horizon.source, new RegExp(twin.one_world.snapshot_id));

    // The TradeCard route called without a world still lands on the same numbers
    // (its default seed is the week's world), just without reuse.
    const cold = tradeImpact(lg, { ...DEALS[0], runs: ONE_WORLD_RUNS });
    assert.deepEqual(cold.me, card.me);
    assert.equal(cold.world_reused, false);

    assert.equal(leagueWorld(lg), leagueWorld(lg), 'built once per snapshot');
  });
});

test('EA-07: the world is the NFL week\'s; a re-sync does not re-roll it, a new week does', () => {
  on(() => {
    clearLeagueWorlds();
    const a = oneWorldTitleOdds(league());
    run('UPDATE leagues SET fetched_at = ? WHERE id = 4', '2026-09-24T09:30:00Z');
    try {
      const b = oneWorldTitleOdds(league());
      assert.notEqual(b.one_world.snapshot_id, a.one_world.snapshot_id, 'a sync is a new snapshot');
      assert.equal(b.one_world.world_id, a.one_world.world_id, 'but the same world');
      assert.deepEqual(b.teams, a.teams, 'same rosters, same world: the same title odds');
      const c = withEnv({ NFL_WEEK: '3' }, () => oneWorldTitleOdds(league()));
      assert.equal(c.one_world.world_id, oneWorldSeed(2026, 3));
      assert.notEqual(c.one_world.world_id, a.one_world.world_id);
    } finally { run('UPDATE leagues SET fetched_at = ? WHERE id = 4', '2026-09-24T08:00:00Z'); }
  });
  // Control: off, a sync re-rolls the seed.
  const lg = league();
  assert.notEqual(tradeImpactSeed(lg), tradeImpactSeed({ ...lg, fetched_at: 'later' }));
});

test('EA-07 RED (row C): range.week is the world pool the title odds index; the card draws the same pool', () => {
  on(() => {
    clearLeagueWorlds();
    const lg = league();
    const world = leagueWorld(lg);
    let checked = 0;
    for (const week of world.prep.simWeeks) {
      const wd = world.prep.weekData.get(week);
      for (const id of wd.ids) {
        const pool = wd.pools.get(id);
        const range = worldRange(lg, assets.get(id), week);
        const n = pool.length;
        assert.equal(range.p10, +pool[Math.floor(0.1 * n)].toFixed(2), `P${id} w${week} p10`);
        assert.equal(range.p90, +pool[Math.floor(0.9 * n)].toFixed(2), `P${id} w${week} p90`);
        assert.equal(range.mean, +wd.expected.get(id).toFixed(2), 'the mean the sim sets lineups on');
        // trade-engine.js's path: no world build, same address and inputs.
        const card = worldPoolFor(assets.get(id), week, { scoring: scoringFor(lg), proj: projMap });
        assert.deepEqual(card, pool, `P${id} w${week}: the card's pool is the world's pool`);
        checked++;
      }
    }
    assert.ok(checked >= 40, `checked ${checked} player-weeks`);
  });
});

test('EA-07 (row C): the ceiling lineup ranks on the world pool means; lineup posture spreads come from the world SD', () => {
  on(() => {
    clearLeagueWorlds();
    const lg = league();
    const res = ceilingLineup(lg.id, { teamId: '1', week: 2, trials: 300 });
    assert.ifError(res.error);
    assert.equal(res.one_world.world_id, oneWorldSeed(2026, 2));
    for (const slot of res.lineup) {
      const p = [...assets.values()].find(a => a.name === slot.player);
      assert.equal(slot.mean_points, +worldRange(lg, p, 2).mean.toFixed(2), `${slot.player}`);
    }
  });
  // lineupMoments: a player's world SD replaces the positional CV spread.
  const withSd = lineupMoments([{ position: 'WR', week_points: 10, week_sd: 4 }]);
  assert.equal(withSd.sd, 4 * SPREAD_SCALE);
  const cv = lineupMoments([{ position: 'WR', week_points: 10 }]);
  assert.equal(cv.sd, 10 * 0.63 * SPREAD_SCALE, 'without it, the positional CV as before');
});

test('EA-07 + RL-19-2: under the one world the fast rescore equals the two full runs', () => {
  for (const deal of DEALS) {
    const args = { ...deal, runs: 200 };
    const oldPath = withEnv({ [ONE_WORLD_ENV]: '1', GRIDIRON_FAST_RESCORE: '0' }, () => tradeImpact(league(), args));
    const fast = withEnv({ [ONE_WORLD_ENV]: '1', GRIDIRON_FAST_RESCORE: null }, () => tradeImpact(league(), args));
    assert.ifError(oldPath.error);
    const { world_reused: _a, ...o } = oldPath;
    const { world_reused: _b, ...f } = fast;
    assert.deepEqual(f, o, `give ${deal.iGive} get ${deal.iGet}`);
  }
});

test('EA-07: preview mode turns it on and labels it; an explicit 0 wins', () => {
  withEnv({ [ONE_WORLD_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => {
    clearLeagueWorlds();
    const res = oneWorldTitleOdds(league());
    assert.equal(res.preview, true);
    assert.match(res.preview_reason, /EA-07/);
  });
  withEnv({ [ONE_WORLD_ENV]: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => {
    const lg = league();
    assert.equal(tradeImpactSeed(lg), keyedSeed('trade-impact', lg.id, lg.fetched_at));
  });
  assert.equal(rangeFromPool([]), null);
});
