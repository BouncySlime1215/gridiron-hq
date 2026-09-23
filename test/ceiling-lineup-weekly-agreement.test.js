/**
 * The property, not the argument: the ceiling lineup and the weekly engine
 * build the SAME projection for the same player-week.
 *
 * `test/ceiling-lineup-recency.test.js` pins the configuration that is passed.
 * That is necessary and not sufficient — a configuration can be passed and
 * still produce a different answer, and what a reader of the My Team ceiling
 * tab is entitled to is that the player it prices is the player Start/Sit
 * prices. So this file runs the REAL `buildProjections` on a real fixture and
 * compares the distribution parameters themselves.
 *
 * ## What "the same projection" can honestly mean here
 *
 * Not the weekly engine's `ppg`. The engine blends its structural projection
 * with season-to-date, last-3, last-1 and median through the weekly ensemble
 * (`player-week-engine.js`, `weekly-ensemble.js`), and the ceiling lineup does
 * not — it samples outcome distributions from the structural projection
 * directly, because a ceiling is a question about a distribution's right tail
 * and the ensemble emits a point. Asserting those two numbers are equal would
 * be asserting something that is false by design.
 *
 * What IS shared, and what the bug broke, is the layer underneath: the
 * structural projection `buildProjections` returns for a given (player, season,
 * week). The weekly engine calls it `structural`; the ceiling lineup samples
 * `pr.params` out of it. Before the fix those were two different objects for
 * the same player-week, because they were built under two different volume
 * memories. After it they are one object. That is the property pinned here.
 *
 * ## The fixture has to be able to tell the difference
 *
 * A player whose usage is identical under both recencies proves nothing, so the
 * fixture gives every player a LAST-SEASON role that differs sharply from his
 * role this season. Under `RECENCY` (seasonDecay 0.35) a 2025 game counts seven
 * times more than under `WEEKLY_ROLE_RECENCY` (0.05), so the two configurations
 * land on visibly different volume. The first test is the control that proves
 * exactly this before anything else is asserted: if the two configurations ever
 * stop disagreeing on this fixture, every other assertion in this file is
 * vacuous and the control says so rather than going green.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ceiling-agreement-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '5';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const SEASON = 2026;
const WEEK = 5;

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (901, 'HOM', 'Home Team', 'AFC', 'East'), (902, 'AWY', 'Away Team', 'NFC', 'West')`);
for (let w = 1; w <= 17; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 901, ?, 'AWY', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 902, ?, 'HOM', 0)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2025, 901, ?, 'AWY', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2025, 902, ?, 'HOM', 0)`, w);
}

const ROSTER = ['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };

const usage = db.prepare(`INSERT INTO player_week_usage
  (player_id, season, week, team, opponent, position, targets, carries, attempts,
   receptions, receiving_yards, rushing_yards, passing_yards,
   receiving_tds, rushing_tds, passing_tds, target_share, wopr)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

/**
 * One player, with a loud role change between seasons.
 *
 * `heavy` is his 2025 workload and `light` his 2026 workload so far. The gap is
 * what the two recencies weight differently, and it is what makes this fixture
 * able to fail.
 */
function seed(id, position, team, opponent, heavy, light) {
  run(`INSERT INTO players (id, name, position, team_id, gsis_id)
       VALUES (?, ?, ?, ?, ?)`,
  id, `${team} ${position} ${id}`, position, team === 'HOM' ? 901 : 902, `00-00${10000 + id}`);
  for (let w = 1; w <= 17; w++) {
    usage.run(id, 2025, w, team, opponent, position,
      heavy.targets, heavy.carries, heavy.attempts, heavy.receptions,
      heavy.rec_yards, heavy.rush_yards, heavy.pass_yards, 0, 0, 0,
      heavy.target_share, heavy.wopr);
  }
  for (let w = 1; w <= WEEK - 1; w++) {
    usage.run(id, 2026, w, team, opponent, position,
      light.targets, light.carries, light.attempts, light.receptions,
      light.rec_yards, light.rush_yards, light.pass_yards, 0, 0, 0,
      light.target_share, light.wopr);
  }
}

const line = o => ({ targets: 0, carries: 0, attempts: 0, receptions: 0, rec_yards: 0,
  rush_yards: 0, pass_yards: 0, target_share: 0, wopr: 0, ...o });

let nextId = 1;
const mine = [];
const theirs = [];
for (const [i, position] of ROSTER.entries()) {
  for (const side of [mine, theirs]) {
    const id = nextId++;
    const team = (side === mine ? i : i + 1) % 2 ? 'AWY' : 'HOM';
    const opponent = team === 'HOM' ? 'AWY' : 'HOM';
    // The role reversal: a heavy 2025 and a light 2026, or the other way round,
    // alternating so the disagreement is not all in one direction.
    const big = line(position === 'QB'
      ? { attempts: 38, pass_yards: 290 }
      : { targets: 11, carries: position === 'RB' ? 17 : 0, receptions: 8,
        rec_yards: 95, rush_yards: position === 'RB' ? 78 : 0, target_share: 0.27, wopr: 0.68 });
    const small = line(position === 'QB'
      ? { attempts: 19, pass_yards: 120 }
      : { targets: 2, carries: position === 'RB' ? 3 : 0, receptions: 1,
        rec_yards: 9, rush_yards: position === 'RB' ? 11 : 0, target_share: 0.05, wopr: 0.11 });
    const [heavy, light] = id % 2 ? [big, small] : [small, big];
    seed(id, position, team, opponent, heavy, light);
    side.push({ id, name: `${team} ${position} ${id}`, position, team_abbr: team,
      espn_id: 7000 + id, available: true,
      current_week_ppg: 10, adj_ppg: 10, ppg: 10, ros_ppg: 10 });
  }
}

const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realCorrelation = await import('../server/services/correlation.js');
const realContingency = await import('../server/services/contingency.js');

const assets = new Map([...mine, ...theirs].map(a => [a.id, a]));
/** The projection maps the ceiling lineup actually consumed, in call order. */
const consumed = [];

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
// Calls STRAIGHT THROUGH to the real buildProjections and records what came
// back. The point of this file is the value, not the argument: if the ceiling
// lineup asks for a different configuration, the recorded map differs and the
// comparison below fails. `namedExports`, not `exports` — see
// test/nfl-news-events.test.js:29.
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: (args) => {
      const out = realProjections.buildProjections(args);
      consumed.push(out);
      return out;
    }
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/correlation.js', {
  namedExports: {
    ...realCorrelation,
    correlatedSampler: (_players, samples) => () => samples.map(s => s[Math.floor(s.length / 2)])
  }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});

const { ceilingLineup } = await import('../server/services/ceiling-lineup.js');
const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
const { buildProjections } = realProjections;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const entry = a => ({ lineupSlotId: 20,
  playerPoolEntry: { player: { id: a.espn_id, fullName: a.name, defaultPositionId: POS_ID[a.position] } } });
const payload = {
  teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(entry) } },
    { id: 2, name: 'Theirs', roster: { entries: theirs.map(entry) } }],
  schedule: [5, 6].map(w => ({ matchupPeriodId: w, home: { teamId: 1 }, away: { teamId: 2 } })),
  settings: { scheduleSettings: { matchupPeriodCount: 6, playoffTeamCount: 2 } }
};
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
     VALUES (801, 'espn', 'ceiling-agreement', 2026, 'Ceiling agreement', '1', 10, 1, ?, ?)`,
JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']), JSON.stringify(payload));

/**
 * The structural projection the WEEKLY ENGINE builds for this player-week,
 * assembled the way `player-week-engine.js:271-274` assembles it. This is the
 * thing the ceiling lineup has to match.
 */
const weeklyStructural = () => buildProjections({
  through: SEASON, throughWeek: WEEK - 1, roleRecency: WEEKLY_ROLE_RECENCY
});

/** The same call with the recency omitted: what the ceiling lineup used to do. */
const seasonLongStructural = () => buildProjections({ through: SEASON, throughWeek: WEEK - 1 });

const paramsOf = (map, id) => map.get(id)?.params ?? null;

test('CONTROL: the two configurations really do disagree on this fixture', () => {
  // Without this, every assertion below could pass on a fixture where volume
  // memory makes no difference, and the file would be measuring nothing.
  const weekly = weeklyStructural();
  const seasonLong = seasonLongStructural();
  assert.ok(weekly.size > 0, 'the weekly configuration produced no projections at all');
  assert.ok(seasonLong.size > 0, 'the season-long configuration produced no projections at all');

  const differing = [...weekly.keys()].filter(id => {
    const a = paramsOf(weekly, id), b = paramsOf(seasonLong, id);
    return a && b && JSON.stringify(a) !== JSON.stringify(b);
  });
  assert.ok(differing.length > 0,
    'the weekly and season-long recencies produce identical projections for every player '
    + 'in this fixture, so nothing below can fail and the fixture needs a louder role change');
});

test('the ceiling lineup consumes the weekly engine\'s structural projection, player for player', () => {
  consumed.length = 0;
  const out = ceilingLineup(801, { week: WEEK, season: SEASON, trials: 50 });
  assert.ok(!out?.error, `the ceiling lineup did not run: ${out?.error}`);
  assert.equal(consumed.length, 1,
    `the spy recorded ${consumed.length} projection builds, so it is not watching the one `
    + 'this test is about');

  const used = consumed[0];
  const weekly = weeklyStructural();
  const checked = [];
  for (const p of mine) {
    const mineParams = paramsOf(used, p.id);
    const theirParams = paramsOf(weekly, p.id);
    if (mineParams == null && theirParams == null) continue;
    assert.deepEqual(mineParams, theirParams,
      `${p.name} is priced differently by the ceiling lineup than by the weekly engine for `
      + `${SEASON} week ${WEEK} — the same player, the same week, two answers`);
    checked.push(p.id);
  }
  assert.ok(checked.length >= 4,
    `only ${checked.length} of this roster's players had a projection on either side, which is `
    + 'too few for the comparison to mean anything');
});

test('and it is NOT the season-long projection, which is the one it used to consume', () => {
  // The teeth. The assertion above would also pass if the two configurations
  // happened to agree; this one fails if the ceiling lineup is still on the old
  // one, and together they say it moved to the right place rather than merely
  // to a place.
  consumed.length = 0;
  ceilingLineup(801, { week: WEEK, season: SEASON, trials: 50 });
  const used = consumed[0];
  const seasonLong = seasonLongStructural();

  const same = [...seasonLong.keys()].filter(id => {
    const a = paramsOf(used, id), b = paramsOf(seasonLong, id);
    return a && b && JSON.stringify(a) === JSON.stringify(b);
  });
  const total = [...seasonLong.keys()].filter(id => paramsOf(used, id) && paramsOf(seasonLong, id)).length;
  assert.ok(same.length < total,
    'every projection the ceiling lineup consumed is identical to the season-long build, so '
    + 'it is still accumulating volume evidence under the wrong memory');
});
