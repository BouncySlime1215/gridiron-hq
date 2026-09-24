/**
 * RL-19-3 — a 1-for-1 that raises BOTH teams' title odds is not dropped for
 * failing the lineup-points gate.
 *
 * findTrades' points gate (me.ppg_delta >= 0.4, and bothImprove for the mutual
 * class) is lineup points this week. Title odds are the season simulated to the
 * end. The two can disagree, and when they did the deal vanished without a
 * trace. With GRIDIRON_TITLE_MUTUAL_ENABLED=1 (or preview mode) the gate stays
 * exactly as it was and such deals come back as their own class,
 * `title_mutual`, scored on the same paired-seed tradeImpact every other
 * title-odds surface uses (fast rescore, one world per search).
 *
 * Fixture: RL-19-2's shape (four ESPN teams over three NFL games, real copula,
 * outcome pools off the real global stream). Slots QB/RB/WR, no flex. Team 1 is
 * weak at RB and has a spare WR; team 2 is weak at WR and has a spare RB. On the
 * finder's week rate (adj_ppg) each spare looks worse than the other side's
 * starter, so the swap moves neither lineup (0.0 both sides: fails both gates).
 * In the season sim (projection mu) each spare is a big upgrade, so both teams
 * gain at teams 3 and 4's expense. The test proves that premise with tradeImpact
 * directly before it asks findTrades anything.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rl193-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
delete process.env.GRIDIRON_TITLE_MUTUAL_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// Three NFL games every week 1-6: AAA-BBB, CCC-DDD, EEE-FFF.
const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF']];
let nflId = 960;
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
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();
let pid = 300;
/** adj: the finder's week rate. mu: the season sim's projection. */
function addPlayer(team, position, adj, mu, value) {
  const id = pid++;
  const i = teamPlayers.get(team)?.length ?? 0;
  assets.set(id, { id, name: `P${id}`, position, team_abbr: NFL_TEAMS[(team + i * 2) % 6], espn_id: 9000 + id,
    available: true, current_week_ppg: adj, adj_ppg: adj, ppg: adj, ros_ppg: adj, value, proj: adj * 17 });
  projMap.set(id, { params: { pid: id, mu }, volume: { target_share: position === 'WR' ? 0.2 : null } });
  teamPlayers.set(team, [...(teamPlayers.get(team) ?? []), id]);
  return id;
}
addPlayer(1, 'QB', 18, 18, 3000);
addPlayer(1, 'RB', 9, 5, 2000);
addPlayer(1, 'WR', 15, 15, 3000);
const SPARE_WR = addPlayer(1, 'WR', 4, 14, 2000);   // team 1's spare: looks like a scrub this week
addPlayer(2, 'QB', 18, 18, 3000);
addPlayer(2, 'WR', 9, 5, 2000);
addPlayer(2, 'RB', 15, 15, 3000);
const SPARE_RB = addPlayer(2, 'RB', 4, 14, 2000);   // team 2's spare
for (const t of [3, 4]) {
  addPlayer(t, 'QB', 18, 18, 3000);
  addPlayer(t, 'RB', 11, 11, 2500);
  addPlayer(t, 'WR', 11, 11, 2500);
  addPlayer(t, 'RB', 6, 6, 1000);
  addPlayer(t, 'WR', 6, 6, 1000);
}

// season-sim reads rosters through trade-engine's assetUniverse; findTrades is
// handed the same map (assetsOverride), so both engines see one league.
mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n) => Array.from({ length: n }, () => Math.max(0, params.mu * (0.2 + 1.6 * random())))
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
// analyzeLeague reads the real player tables, which hold none of these players,
// so every position would read "thin" and red-flag every swap. Hand it the
// fixture's own needs: team 1 is short at RB with a spare WR, team 2 the reverse.
const { default: tradelabRouter, ...realTradelab } = await import('../server/routes/tradelab.js');
const need = (roster_id, short, spare) => ({ roster_id, needs: short ? [{ position: short }] : [],
  surplus: spare ? [{ position: spare }] : [], window: 'contend' });
mock.module('../server/routes/tradelab.js', {
  defaultExport: tradelabRouter,
  namedExports: { ...realTradelab,
    analyzeLeague: () => ({ teams: [need(1, 'RB', 'WR'), need(2, 'WR', 'RB'), need(3), need(4)] }) }
});
const simModule = await import('../server/services/season-sim.js?rl193');
mock.module('../server/services/season-sim.js', { namedExports: { ...simModule } });
// A fresh trade-engine instance whose season-sim import is the mocked one.
const { findTrades } = await import('../server/services/trade-engine.js?rl193');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Week 1 played; weeks 2-3 regular season; a 2-team final in week 4. */
function payload() {
  const g = (w, h, a, hp, ap) => ({ matchupPeriodId: w, winner: hp == null ? 'UNDECIDED' : hp > ap ? 'HOME' : 'AWAY',
    home: { teamId: h, totalPoints: hp ?? undefined }, away: { teamId: a, totalPoints: ap ?? undefined } });
  return {
    teams: [1, 2, 3, 4].map(t => ({ id: t, name: `Team ${t}`, divisionId: 0,
      roster: { entries: teamPlayers.get(t).map(id => ({ lineupSlotId: 20,
        playerPoolEntry: { player: { id: 9000 + id, fullName: `P${id}`,
          defaultPositionId: { QB: 1, RB: 2, WR: 3 }[assets.get(id).position] } } })) } })),
    schedule: [g(1, 1, 2, 90, 90.5), g(1, 3, 4, 95, 94), g(2, 1, 3), g(2, 2, 4), g(3, 1, 4), g(3, 2, 3)],
    settings: { scheduleSettings: { matchupPeriodCount: 3, matchupPeriodLength: 1, playoffTeamCount: 2,
      playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: 4 }] } }
  };
}
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
     payload, current_week, payload_season, fetched_at) VALUES (1931, 'espn', 'rl193', 2026, 'TM', '1', 4, 1, ?, ?, 2, 2026, '2026-09-24T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 1931').get();

const withEnv = (vars, fn) => {
  const prior = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prior)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
};
const search = (opts = {}) => findTrades(league(), { myTeamId: '1', requireMutual: true, limit: 50,
  counterparty: false, assetsOverride: assets, playoffOdds: 0.5, playoffOddsSource: 'fixture', ...opts });
const isSwap = d => d.i_give.length === 1 && d.i_get.length === 1
  && d.i_give[0].id === SPARE_WR && d.i_get[0].id === SPARE_RB && d.partner_id === '2';

test('RL-19-3 premise: the spare-for-spare swap raises both title odds past 2 SE (paired seeds)', () => {
  const impact = simModule.tradeImpact(league(), { myTeamId: 1, theirTeamId: 2, iGive: [SPARE_WR], iGet: [SPARE_RB] });
  assert.ifError(impact.error);
  for (const side of [impact.me, impact.them]) {
    assert.ok(side.title_delta > 0, `${side.roster_id} gains title odds (${side.title_delta})`);
    assert.equal(side.title_delta_clears_noise, true,
      `${side.roster_id}: ${side.title_delta} > ${simModule.TRADE_DELTA_NOISE_SE} x ${side.title_delta_se}`);
  }
});

test('RL-19-3 premise: the points gate drops the swap (flag off, either mutual setting)', () => {
  const strict = withEnv({ GRIDIRON_TITLE_MUTUAL_ENABLED: null }, () => search());
  const loose = withEnv({ GRIDIRON_TITLE_MUTUAL_ENABLED: null }, () => search({ requireMutual: false }));
  assert.ifError(strict.error);
  assert.ok(!strict.deals.some(isSwap) && !loose.deals.some(isSwap), 'no points class holds it');
  assert.equal(strict.title_mutual?.status ?? 'off', 'off', 'flag off: no title-odds stage ran');
  assert.ok(!(strict.title_mutual?.deals ?? []).length, 'flag off: nothing new is surfaced');
});

test('RL-19-3: findTrades(requireMutual) returns the swap tagged title_mutual, beside the points class', () => {
  const out = withEnv({ GRIDIRON_TITLE_MUTUAL_ENABLED: '1' }, () => search());
  assert.ifError(out.error);
  assert.equal(out.title_mutual.status, 'on');
  const hit = out.title_mutual.deals.find(isSwap);
  assert.ok(hit, `title_mutual holds the swap (got ${out.title_mutual.deals.length} deals, `
    + `${out.title_mutual.simulated} simulated of ${out.title_mutual.considered})`);
  assert.equal(hit.title_mutual, true);
  assert.equal(hit.mutual, false, 'it is NOT a points-mutual deal');
  assert.ok(hit.me.ppg_delta < 0.4, 'the points gate itself is unchanged');
  assert.ok(hit.title.me.title_delta_clears_noise && hit.title.them.title_delta_clears_noise);
  assert.ok(hit.title.me.title_delta > 0 && hit.title.them.title_delta > 0);
  assert.ok(!out.deals.some(isSwap), 'the points-mutual list is not changed');
  assert.ok(out.deals.every(d => !d.title_mutual), 'the two classes stay distinct');
  // Same number as every other title-odds surface (one seed, one run count).
  const direct = simModule.tradeImpact(league(), { myTeamId: 1, theirTeamId: 2, iGive: [SPARE_WR], iGet: [SPARE_RB] });
  assert.equal(hit.title.me.title_delta, direct.me.title_delta);
  assert.equal(hit.title.them.title_delta, direct.them.title_delta);
});

test('RL-19-3: preview mode turns the class on and says so', () => {
  const out = withEnv({ GRIDIRON_TITLE_MUTUAL_ENABLED: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => search());
  assert.ifError(out.error);
  assert.equal(out.title_mutual.status, 'on');
  assert.equal(out.title_mutual.preview, true);
  assert.ok(out.title_mutual.deals.some(isSwap));
});

test('RL-19-3: requireMutual=false never runs the title stage', () => {
  const loose = withEnv({ GRIDIRON_TITLE_MUTUAL_ENABLED: '1' }, () => search({ requireMutual: false }));
  assert.equal(loose.title_mutual.status, 'off');
  assert.ok(!loose.deals.some(d => d.title_mutual));
});
