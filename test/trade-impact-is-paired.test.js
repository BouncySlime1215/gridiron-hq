/**
 * `season-sim.js#tradeImpact` — the claim on its own payload, run for real.
 *
 * Nothing in the suite ran this function end to end. That is why a served-field
 * sweep over it survived: a mutation can only be caught by a test that reaches
 * the field, and the only test naming `tradeImpact` (test/trade-verify.test.js)
 * does not execute a simulation.
 *
 * The property worth pinning is the one the function advertises on its own
 * payload as `paired_simulation: true`. `tradeImpact` runs the league twice
 * under COMMON RANDOM NUMBERS — the same seed, so the same simulated football
 * worlds — and takes the difference. Without that pairing, the numbers it
 * reports are the trade's effect plus Monte Carlo noise, and at any run count a
 * manager can afford to wait for, the noise is the larger of the two.
 *
 * The test for it is a trade of nothing. Give no players, get no players, and
 * every delta must be EXACTLY zero — not small, zero. A seed that diverges
 * between the two runs, a projection rebuild between them, or any unpaired
 * source of randomness makes a null trade look like it changed the season, and
 * this is the only assertion that can tell the difference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-impact-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { tradeImpact } = await import('../server/services/season-sim.js');
const { assetUniverse, loadRosters } = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

await runMigrations();
seedIfEmpty();

// Every team plays every week: without an NFL game a player scores nothing, and
// a league of zeroes makes every delta zero for the wrong reason. The slate is
// cached per process, so this lands before the first simulation.
for (let w = 1; w <= 17; w++) {
  run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
       SELECT 2026, id, ?, abbr, 1 FROM nfl_teams`, w);
}

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ fixture */

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const pool = (position, n) => rows(`SELECT p.id, p.name, p.position, t.abbr AS team_abbr
  FROM players p JOIN nfl_teams t ON t.id = p.team_id
  WHERE p.position = ? AND p.fantasy_relevant = 1 ORDER BY p.id LIMIT ?`, position, n);

/**
 * A 2025 usage log, because that is what the projection model actually reads.
 *
 * `buildProjections` builds from `player_week_usage` — per-week opportunity and
 * production — and not from `player_season_stats`. Seed only season totals and
 * `history()` returns nothing, `buildProjections` returns an empty Map, every
 * player scores zero in every simulated week, and the league becomes a set of
 * scoreless ties. That is what the first version of this fixture did, and it is
 * why its title odds came out 1.0 and 0.0 with nothing in between.
 *
 * Each player gets seventeen weeks at a strength scaled from his rank within his
 * position, so projections differ player to player the way they do in a real
 * league, while the roster construction below keeps every TEAM's total equal.
 */
function seedUsage(players, season = 2025) {
  const byPos = new Map();
  for (const p of players) (byPos.get(p.position) ?? byPos.set(p.position, []).get(p.position)).push(p);
  const ins = `INSERT OR REPLACE INTO player_week_usage
    (player_id, season, week, team, opponent, position, attempts, carries, targets, receptions,
     target_share, passing_yards, rushing_yards, receiving_yards, passing_tds, rushing_tds,
     receiving_tds, interceptions, fumbles_lost, first_downs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  for (const [pos, list] of byPos) {
    list.forEach((p, i) => {
      // 1.25 down to 0.75 across the position's ranks: a real spread, and small
      // enough that a balanced set of ranks really is a balanced roster.
      const s = 1.25 - (0.5 * i) / Math.max(1, list.length - 1);
      for (let week = 1; week <= 17; week++) {
        const v = pos === 'QB'
          ? { att: 32 * s, car: 3, tgt: 0, rec: 0, share: 0, pyd: 245 * s, ryd: 12, cyd: 0, ptd: 1.6 * s, rtd: 0.15, ctd: 0 }
          : pos === 'RB'
            ? { att: 0, car: 15 * s, tgt: 4 * s, rec: 3 * s, share: 0.09 * s, pyd: 0, ryd: 66 * s, cyd: 24 * s, ptd: 0, rtd: 0.5 * s, ctd: 0.12 * s }
            : pos === 'WR'
              ? { att: 0, car: 0.3, tgt: 8 * s, rec: 5.4 * s, share: 0.22 * s, pyd: 0, ryd: 2, cyd: 70 * s, ptd: 0, rtd: 0.02, ctd: 0.45 * s }
              : { att: 0, car: 0, tgt: 5 * s, rec: 3.8 * s, share: 0.14 * s, pyd: 0, ryd: 0, cyd: 42 * s, ptd: 0, rtd: 0, ctd: 0.3 * s };
        run(ins, p.id, season, week, p.team_abbr ?? 'MID', 'OPP', pos,
          v.att, v.car, v.tgt, v.rec, v.share, v.pyd, v.ryd, v.cyd, v.ptd, v.rtd, v.ctd, 0.3, 0.05, 12 * s);
      }
    });
  }
}

const { formatKey } = deriveFormat({
  team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
  roster_positions: JSON.stringify(SLOTS)
});

function seedMarket(players) {
  const now = new Date().toISOString();
  players.forEach((p, i) => {
    const proj = 320 - i * 4;
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2025, 'actual', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`,
    p.id, proj, now);
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`,
    p.id, proj, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value`,
    formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
}

/** Round-robin fixtures for six teams over `weeks` matchup periods. */
function schedule(weeks) {
  const out = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= weeks; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      out.push({ matchupPeriodId: w, home: { teamId: rot[i] }, away: { teamId: rot[5 - i] } });
    }
  }
  return out;
}

let fakeId = 500000;
/**
 * Six rosters of identical total strength.
 *
 * THE FIRST VERSION OF THIS FIXTURE WAS DEGENERATE AND THE TESTS PASSED ANYWAY.
 * It snaked three rounds of RBs and WRs across six teams, which does not balance
 * — the index sums came out 23 + i and 28 − i — so team 1 won the title in
 * 100% of runs and team 2 in 0%. Every delta was zero because the season was
 * never in doubt, and the null-trade test therefore proved nothing about
 * pairing. A probe of the payload is what showed it: `title_before: 1`.
 *
 * Four rounds balance where three do not: i + (11 − i) + (12 + i) + (23 − i) is
 * 46 for every i. With a linear projection spread, equal index sums mean equal
 * rosters, so no team is favoured and the title is genuinely uncertain — which
 * is the only state in which a zero delta says anything. The non-degeneracy
 * guard below asserts it rather than trusting this paragraph.
 */
function buildLeague(id) {
  const qb = pool('QB', 12), rb = pool('RB', 24), wr = pool('WR', 24), te = pool('TE', 12);
  const all = [...qb, ...rb, ...wr, ...te];
  seedMarket(all);
  seedUsage(all);
  const teams = [];
  for (let i = 0; i < 6; i++) {
    const roster = [
      qb[i], qb[11 - i],                                   // sum 11
      rb[i], rb[11 - i], rb[12 + i], rb[23 - i],            // sum 46
      wr[i], wr[11 - i], wr[12 + i], wr[23 - i],            // sum 46
      te[i], te[11 - i]                                     // sum 11
    ].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`,
      roster: { entries: roster.map(p => ({ playerPoolEntry: { player: {
        id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } });
  }
  const payload = {
    teams,
    schedule: schedule(14),
    settings: { name: 'Impact League',
      scheduleSettings: { matchupPeriodCount: 14, playoffMatchupPeriodLength: 1,
        playoffTeamCount: 4, matchupPeriodLength: 1 } }
  };
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'Impact League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
  id, `espn-impact-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS));
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

const LG = buildLeague(801);
const RUNS = 150;

/* -------------------------------------------------------------------- tests */

test('it runs at all, and the payload says what it did', () => {
  const out = tradeImpact(LG, { myTeamId: '1', theirTeamId: '2', iGive: [], iGet: [], runs: RUNS, seed: 7 });
  assert.ok(!out.error, out.error);
  assert.equal(out.paired_simulation, true);
  assert.equal(out.seed, 7, 'an explicit seed is used, not replaced by a random one');
  assert.equal(out.runs, RUNS);
  assert.equal(out.from_week, 1);
  for (const side of [out.me, out.them]) {
    for (const f of ['title_before', 'title_after', 'playoff_before', 'playoff_after']) {
      assert.equal(typeof side[f], 'number', `${f} must be a number`);
    }
  }
});

test('the fixture is not degenerate — the title is actually in doubt', () => {
  // The guard that makes every zero below meaningful. In a league where one
  // roster wins every run, title_before is 1, title_after is 1, and the delta is
  // 0 no matter what the function does with its seeds. That was the first
  // version of this fixture, and it passed.
  const out = tradeImpact(LG, { myTeamId: '1', theirTeamId: '2', iGive: [], iGet: [], runs: RUNS, seed: 3 });
  for (const side of [out.me, out.them]) {
    assert.ok(side.title_before > 0 && side.title_before < 1,
      `${side.owner} wins the title ${side.title_before} of the time — nothing is at stake, so no delta can mean anything`);
  }
});

test('THE PAIRING: a trade of nothing changes nothing, exactly', () => {
  // Not "close to zero". Zero. Under common random numbers the two runs play
  // the same seasons with the same rosters, so every difference must cancel
  // exactly. Any unpaired randomness — a second seed, a rebuilt projection set,
  // an ordering that depends on iteration — shows up here and nowhere else.
  const out = tradeImpact(LG, { myTeamId: '1', theirTeamId: '2', iGive: [], iGet: [], runs: RUNS, seed: 11 });
  for (const side of [out.me, out.them]) {
    assert.equal(side.title_delta, 0, `${side.owner ?? side.roster_id} title moved on a null trade`);
    assert.equal(side.playoff_delta, 0, 'playoff odds moved on a null trade');
    assert.equal(side.wins_delta, 0, 'expected wins moved on a null trade');
    assert.equal(side.title_after, side.title_before);
    assert.equal(side.playoff_after, side.playoff_before);
  }
});

test('the same seed gives the same answer twice; a different seed does not have to', () => {
  const a = tradeImpact(LG, { myTeamId: '1', theirTeamId: '2', iGive: [], iGet: [], runs: RUNS, seed: 23 });
  const b = tradeImpact(LG, { myTeamId: '1', theirTeamId: '2', iGive: [], iGet: [], runs: RUNS, seed: 23 });
  assert.deepEqual(a.me, b.me, 'the same seed must reproduce exactly');
  assert.deepEqual(a.them, b.them);
});

test('the overrides actually change the rosters: giving a starter away for nothing costs you', () => {
  // The other half of the null-trade test. A zero delta proves pairing only if a
  // real trade produces a non-zero one; otherwise both tests are satisfied by a
  // function that returns zero for everything.
  const { formatKey: fk } = deriveFormat(LG);
  const assets = assetUniverse(LG, fk);
  const teams = loadRosters(LG, assets);
  const mine = teams.find(t => String(t.roster_id) === '1');
  // The top four, not the top one: with twelve players behind seven slots, losing
  // a single starter costs only the gap to his replacement, which a 2-decimal
  // wins figure can round away. Four is unambiguous and still a trade a real
  // fixture can express.
  const best = [...mine.players].sort((a, b) => (b.adj_ppg ?? 0) - (a.adj_ppg ?? 0)).slice(0, 4);

  const out = tradeImpact(LG, {
    myTeamId: '1', theirTeamId: '2', iGive: best.map(p => p.id), iGet: [], runs: RUNS, seed: 31
  });
  assert.ok(!out.error, out.error);
  const names = best.map(p => p.name).join(', ');
  assert.ok(out.me.wins_delta < 0,
    `giving ${names} away for nothing must cost expected wins, got ${out.me.wins_delta}`);
  assert.ok(out.them.wins_delta > 0,
    `the team receiving them for nothing must gain, got ${out.them.wins_delta}`);
});
