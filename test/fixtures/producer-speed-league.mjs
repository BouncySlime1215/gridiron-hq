/**
 * PRODUCER-FAST: a made-up ESPN league at producer scale, on the REAL season
 * simulator and the REAL campaign adapter (scripts/campaign/league-adapter.mjs).
 * No real data: teams 1..N, players "P<id>", invented projections.
 *
 * The same RL-19-2 recipe (test/rl-19-2-fast-rescore.test.js): projections and
 * outcome pools are mocked, the copula, the lineups, the seeding and the bracket
 * are the real code. Mocks must be installed before the adapter loads the
 * services, so the caller runs this module (and nothing that imports
 * season-sim.js) first, under --experimental-test-module-mocks, with
 * GRIDIRON_DB_PATH pointing at a fresh file.
 *
 *   setupLeague({ teams, perTeam, regularWeeks, currentWeek, playoffTeams, kdst }) -> { leagueId, svc, buildAdapter }
 *   kdst: each team also rosters a K and a D/ST and the lineup starts both (SIM-KDST); their
 *   ESPN weekly projections are in the payload.
 */
import { mock } from 'node:test';

const POS_LAYOUT = ['QB', 'QB', 'RB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'RB', 'WR'];
const ESPN_POS = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };
const MU = { QB: 18, RB: 10, WR: 10, TE: 7, K: 8, DEF: 7 };

/** Deterministic xorshift for the invented projections (never Math.random). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

export async function setupLeague({ teams = 10, perTeam = 16, regularWeeks = 14, currentWeek = 4, playoffTeams = 6,
  leagueId = 4, seed = 7, kdst = false } = {}) {
  const r = rng(seed);
  const { db, run } = await import('../../server/db/index.js');
  const { runMigrations } = await import('../../server/db/migrate.js');
  await runMigrations();
  // Made by scripts/collect-league-transactions.mjs, not a migration; the adapter reads it.
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (league_id INTEGER NOT NULL, season INTEGER NOT NULL,
    tx_id TEXT NOT NULL, type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT, team_id INTEGER,
    member_id TEXT, related_tx_id TEXT, scoring_period INTEGER, bid_amount REAL, is_pending INTEGER, items_json TEXT,
    raw_json TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (league_id, season, tx_id))`);

  // 16 NFL teams, 8 games every week 1-18 (a rotating round robin).
  const NFL = Array.from({ length: 16 }, (_, i) => `N${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`);
  NFL.forEach((abbr, i) => run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East')`,
    700 + i, abbr, `${abbr} team`));
  for (let w = 1; w <= 18; w++) {
    const rot = [NFL[0], ...NFL.slice(1).map((_, i) => NFL[1 + ((i + w) % 15)])];
    for (let g = 0; g < 8; g++) {
      const h = rot[g], a = rot[15 - g];
      const date = new Date(Date.UTC(2026, 8, 10 + (w - 1) * 7)).toISOString().slice(0, 10);
      run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home, date) VALUES (2026, ?, ?, ?, 1, ?)`, 700 + NFL.indexOf(h), w, a, date);
      run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home, date) VALUES (2026, ?, ?, ?, 0, ?)`, 700 + NFL.indexOf(a), w, h, date);
    }
  }

  const assets = new Map(), projMap = new Map(), teamPlayers = new Map(), kdstStats = new Map();
  let pid = 100;
  for (let t = 1; t <= teams; t++) {
    const ids = [];
    [...POS_LAYOUT.slice(0, perTeam), ...(kdst ? ['K', 'DEF'] : [])].forEach((pos, i) => {
      const id = pid++;
      const mu = MU[pos] * (0.55 + 0.9 * r()) * (i < 2 || pos === 'TE' ? 1 : 1 - i * 0.01);
      assets.set(id, { id, name: `P${id}`, position: pos, team_abbr: NFL[(t * 3 + i * 5) % 16], espn_id: 50000 + id,
        available: true, current_week_ppg: mu, adj_ppg: mu, ppg: mu, ros_ppg: mu, value: Math.round(mu * 150) });
      if (pos === 'K' || pos === 'DEF') {
        // SIM-KDST reads these from the payload: an ESPN weekly projection per week, and a season one.
        kdstStats.set(id, [{ statSourceId: 1, seasonId: 2026, statSplitTypeId: 0, scoringPeriodId: 0, appliedAverage: mu },
          ...Array.from({ length: 18 }, (_, k) => ({ statSourceId: 1, seasonId: 2026, statSplitTypeId: 1, scoringPeriodId: k + 1,
            appliedTotal: Math.round(mu * (0.6 + 0.8 * r()) * 100) / 100 }))]);
      } else projMap.set(id, { params: { pid: id, mu }, volume: { target_share: pos === 'WR' ? 0.2 : null } });
      ids.push(id);
    });
    teamPlayers.set(t, ids);
  }

  const realTradeEngine = await import('../../server/services/trade-engine.js');
  const realProjections = await import('../../server/services/projections.js');
  const realGamescript = await import('../../server/services/gamescript.js');
  const realContingency = await import('../../server/services/contingency.js');
  const { random } = await import('../../server/services/stats-util.js');
  mock.module('../../server/services/trade-engine.js', { namedExports: { ...realTradeEngine, assetUniverse: () => assets } });
  mock.module('../../server/services/projections.js', { namedExports: { ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n) => Array.from({ length: n }, () => Math.max(0, params.mu * (0.2 + 1.6 * random()))) } });
  mock.module('../../server/services/gamescript.js', { namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) } });
  mock.module('../../server/services/contingency.js', { namedExports: { ...realContingency, weeklyAvailability: () => new Map() } });

  // Round-robin fantasy schedule; weeks before currentWeek played with invented scores.
  const ids = Array.from({ length: teams }, (_, i) => i + 1);
  const schedule = [];
  for (let w = 1; w <= regularWeeks; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w) % (teams - 1))])];
    for (let g = 0; g < teams / 2; g++) {
      const h = rot[g], a = rot[teams - 1 - g];
      const played = w < currentWeek;
      const hp = played ? 90 + Math.round(r() * 40) : null, ap = played ? 90 + Math.round(r() * 40) : null;
      schedule.push({ matchupPeriodId: w, winner: !played ? 'UNDECIDED' : hp > ap ? 'HOME' : 'AWAY',
        home: { teamId: h, totalPoints: hp ?? undefined }, away: { teamId: a, totalPoints: ap ?? undefined } });
    }
  }
  const payload = {
    teams: ids.map(t => ({ id: t, divisionId: 0, name: `Team ${t}`,
      roster: { entries: teamPlayers.get(t).map(id => ({ lineupSlotId: 20,
        playerPoolEntry: { player: { id: 50000 + id, fullName: `P${id}`, defaultPositionId: ESPN_POS[assets.get(id).position],
          ...(kdstStats.has(id) ? { stats: kdstStats.get(id) } : {}) } } })) } })),
    schedule,
    settings: { scheduleSettings: { matchupPeriodCount: regularWeeks, matchupPeriodLength: 1, playoffTeamCount: playoffTeams,
      playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: teams }] } },
  };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
       payload, current_week, payload_season, fetched_at) VALUES (?, 'espn', 'speed', 2026, 'Speed', '1', ?, 1, ?, ?, ?, 2026, '2026-09-24T08:00:00Z')`,
  leagueId, teams, JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', ...(kdst ? ['K', 'D/ST'] : []), 'BE', 'BE']),
  JSON.stringify(payload), currentWeek);

  // FC-VALUE (integration-8): the planner prices Nick's rules on FantasyCalc value (player_metrics 'fc_value',
  // server/services/fc-value.js). Made-up prices equal to each asset's value, so the fixture plans as before.
  // The asset universe is mocked (no players rows), so the foreign key is off for these rows only.
  db.exec('PRAGMA foreign_keys = OFF');
  for (const [id, a] of assets) run(`INSERT OR REPLACE INTO player_metrics (player_id, source, value) VALUES (?, 'fc_value', ?)`, id, a.value);
  db.exec('PRAGMA foreign_keys = ON');

  // A fresh season-sim instance that sees the mocks (the plain one was loaded, unmocked, by
  // the trade-engine import above), then point everything else at it (RL-19-2's recipe).
  const sim = await import('../../server/services/season-sim.js?producer-speed');
  mock.module('../../server/services/season-sim.js', { namedExports: { ...sim } });
  const { loadServices, buildAdapter } = await import('../../scripts/campaign/league-adapter.mjs');
  const svc = { ...(await loadServices()), sim };
  return { db, leagueId, svc, buildAdapter: (opts = {}) => buildAdapter(svc, leagueId, { finder: false, now: Date.UTC(2026, 9, 1), ...opts }) };
}
