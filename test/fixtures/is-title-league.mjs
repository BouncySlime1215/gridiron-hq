/**
 * IS-TITLE fixture: a made-up eight-team ESPN league with one long-shot team.
 *
 * No real data: players P<id>, NFL teams AAA..HHH, invented means. Team 1 is the
 * target (the "Nick" slot), built weaker than the rest so its plain title odds sit
 * in the 0.1-1% band the unit is about. Outcome pools are right-skewed (a floor of
 * 0.35 x mean plus an exponential tail) and come off the real global stream under
 * the sim's own keyed seeds; the copula, lineups, seeding and bracket are the real
 * season-sim code.
 *
 * Shape: week 1 played; weeks 2-9 regular season; a 4-team fixed bracket in
 * weeks 10-11. Slots QB, RB, RB, WR, WR, FLEX from seven players a team.
 *
 * Call setupIsTitleLeague() at the top of a test file, before anything imports
 * season-sim.js: it points the DB at a temp file, mocks the projection inputs and
 * returns the mocked season-sim instance.
 */
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEAGUE_ID = 4801;
export const TARGET = '1';
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'RB'];
const NFL = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];

/** Round-robin pairs for 8 teams, one list per round (circle method). */
function roundRobin(ids) {
  const n = ids.length, rounds = [];
  const arr = [...ids];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) pairs.push([arr[i], arr[n - 1 - i]]);
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop());
  }
  return rounds;
}

export async function setupIsTitleLeague({ targetScale = 0.82, tag = 'is-title' } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `gridiron-${tag}-`));
  process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
  process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
  process.env.SCHEDULER_DISABLED = '1';
  process.env.NFL_WEEK = '2';

  const { db, run } = await import('../../server/db/index.js');
  const { runMigrations } = await import('../../server/db/migrate.js');
  await runMigrations();

  // Four NFL games every week 1-11.
  const nflRounds = roundRobin(NFL);
  NFL.forEach((abbr, i) => run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East')`,
    960 + i, abbr, `${abbr} team`));
  for (let w = 1; w <= 11; w++) {
    for (const [h, a] of nflRounds[(w - 1) % nflRounds.length]) {
      run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 1)`, 960 + NFL.indexOf(h), w, a);
      run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 0)`, 960 + NFL.indexOf(a), w, h);
    }
  }

  const { random } = await import('../../server/services/stats-util.js');
  const realTradeEngine = await import('../../server/services/trade-engine.js');
  const realProjections = await import('../../server/services/projections.js');
  const realGamescript = await import('../../server/services/gamescript.js');
  const realContingency = await import('../../server/services/contingency.js');

  const assets = new Map(), projMap = new Map(), teamPlayers = new Map();
  const BASE = { QB: 18, RB: 11, WR: 11 };
  let pid = 100;
  for (let t = 1; t <= 8; t++) {
    const ids = [];
    LAYOUT.forEach((pos, i) => {
      const id = pid++;
      // Bench players (index 5, 6) project lower; team strength rises gently with t.
      const depth = i >= 5 ? 0.6 : 1;
      const strength = t === Number(TARGET) ? targetScale : 1 + (t - 5) * 0.015;
      const mu = +(BASE[pos] * depth * strength).toFixed(3);
      assets.set(id, { id, name: `P${id}`, position: pos, team_abbr: NFL[(t + i * 3) % 8], espn_id: 9000 + id,
        available: true, current_week_ppg: mu, adj_ppg: mu, ppg: mu, ros_ppg: mu, value: Math.round(mu * 300) });
      projMap.set(id, { params: { pid: id, mu }, volume: { target_share: pos === 'WR' ? 0.2 : null } });
      ids.push(id);
    });
    teamPlayers.set(t, ids);
  }

  mock.module('../../server/services/trade-engine.js', {
    namedExports: { ...realTradeEngine, assetUniverse: () => assets }
  });
  mock.module('../../server/services/projections.js', {
    namedExports: {
      ...realProjections,
      buildProjections: () => projMap,
      // Right-skewed: 0.35 x mean floor plus an exponential tail of mean 0.65 x mean.
      sampleWeeks: (params, n) => Array.from({ length: n },
        () => params.mu * (0.35 + 0.65 * -Math.log(1 - random() * 0.999999)))
    }
  });
  mock.module('../../server/services/gamescript.js', {
    namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
  });
  mock.module('../../server/services/contingency.js', {
    namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
  });
  const sim = await import(`../../server/services/season-sim.js?${tag}`);

  const fantasyRounds = roundRobin([1, 2, 3, 4, 5, 6, 7, 8]);
  const schedule = [];
  for (let w = 1; w <= 9; w++) {
    for (const [h, a] of fantasyRounds[(w - 1) % fantasyRounds.length]) {
      const played = w === 1;
      const hp = played ? 100 + h : undefined, ap = played ? 100 + a : undefined;
      schedule.push({ matchupPeriodId: w, winner: played ? (hp > ap ? 'HOME' : 'AWAY') : 'UNDECIDED',
        home: { teamId: h, totalPoints: hp }, away: { teamId: a, totalPoints: ap } });
    }
  }
  const payload = {
    teams: [...teamPlayers.keys()].map(t => ({ id: t, divisionId: 0,
      roster: { entries: teamPlayers.get(t).map(id => ({ lineupSlotId: 20,
        playerPoolEntry: { player: { id: 9000 + id, fullName: `P${id}`,
          defaultPositionId: { QB: 1, RB: 2, WR: 3 }[assets.get(id).position] } } })) } })),
    schedule,
    settings: { scheduleSettings: { matchupPeriodCount: 9, matchupPeriodLength: 1, playoffTeamCount: 4,
      playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: 8 }] } }
  };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
       payload, current_week, payload_season, fetched_at) VALUES (?, 'espn', 'istitle', 2026, 'IST', ?, 8, 1, ?, ?, 2, 2026, '2026-09-24T08:00:00Z')`,
  LEAGUE_ID, TARGET, JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'FLEX']), JSON.stringify(payload));
  const league = () => db.prepare('SELECT * FROM leagues WHERE id = ?').get(LEAGUE_ID);
  const cleanup = () => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); };
  return { sim, league, teamPlayers, assets, cleanup };
}
