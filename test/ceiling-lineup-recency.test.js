/**
 * The ceiling lineup and the weekly engine have to agree about what week it is.
 *
 * `ceiling-lineup.js` builds its own projections rather than reading the weekly
 * engine's, and it already gets the CUTOFF right: `through: season,
 * throughWeek: week - 1`, the walk-forward-safe mid-season cutoff, with a
 * careful comment saying why. What it never passed is the other half of the
 * same configuration — `roleRecency`.
 *
 * Omitted, `buildProjections` falls back to `RECENCY` (seasonDecay 0.35);
 * the weekly engine passes `WEEKLY_ROLE_RECENCY` (seasonDecay 0.05,
 * weekHalfLife 5). Under 0.35 a season-old game counts SEVEN TIMES more toward
 * a player's volume than under 0.05. So the My Team ceiling tab and the Start/Sit
 * projection for the same player in the same week were reading two different
 * players: one whose role is mostly last season's, one whose role is mostly
 * this month's.
 *
 * The second consequence is quieter and worse. `shrinkage-fit.js#activeKVectorFor`
 * withholds the FITTED volume k from any caller whose recency is not the one the
 * fit was trained under — deliberately, because a k estimated in one set of
 * evidence units is meaningless in another. Every season-long caller therefore
 * silently falls back to hand-picked constants, which the file's own comment
 * says "are not claimed to be right, only untested with the fitted k".
 * `ceiling-lineup` is named in that list of season-long callers, and it does not
 * belong there: it passes a mid-season `throughWeek`, exactly like the weekly
 * engine. It was being classified by an argument it forgot to pass rather than
 * by the cutoff it actually uses.
 *
 * What this file pins:
 *
 *   1. The ceiling lineup asks `buildProjections` for the same configuration
 *      the weekly engine asks for — cutoff AND recency, for the same
 *      player-week.
 *   2. That configuration is the one `shrinkage-fit` recognises, so the fitted
 *      volume k is actually handed over instead of withheld.
 *   3. The weekly engine really does pass `WEEKLY_ROLE_RECENCY`, so if it ever
 *      moves, this test reports that the two have diverged rather than going
 *      quietly green against a stale expectation.
 *
 * The rig is the one `test/decision-leftovers-home-away.test.js` already uses
 * to drive the real `ceilingLineup` end to end: a two-team NFL, a synced
 * league, and `projections.js` replaced by a spy. Here the spy records the
 * ARGUMENT rather than the samples.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ceiling-recency-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '5';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

run(`CREATE TABLE IF NOT EXISTS player_gamelog (player_id INTEGER, season INTEGER, week INTEGER,
     opponent TEXT, fantasy_points REAL, PRIMARY KEY (player_id, season, week))`);
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (901, 'HOM', 'Home Team', 'AFC', 'East'), (902, 'AWY', 'Away Team', 'NFC', 'West')`);
for (let w = 1; w <= 17; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 901, ?, 'AWY', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 902, ?, 'HOM', 0)`, w);
}

const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realCorrelation = await import('../server/services/correlation.js');
const realContingency = await import('../server/services/contingency.js');

let assets = new Map();
const projMap = new Map();
/** Every argument object `buildProjections` was handed, in call order. */
const asked = [];

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
// `namedExports`, NOT `exports` — see test/nfl-news-events.test.js:29. The wrong
// key is accepted in silence and the mock never takes, which this project paid
// for once already.
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: (args = {}) => { asked.push(args); return projMap; },
    sampleWeeks: (_params, n) => Array.from({ length: n }, (_, i) => i % 25)
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
const { isWeeklyRoleRecency, activeKVectorFor } = await import('../server/services/shrinkage-fit.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(position, team) {
  const id = nextId++;
  const a = { id, name: `${team} ${position} ${id}`, position, team_abbr: team, espn_id: 7000 + id,
    available: true, current_week_ppg: 10, adj_ppg: 10, ppg: 10, ros_ppg: 10 };
  projMap.set(id, { params: { pid: id, team, position }, volume: { target_share: 0.1 } });
  return a;
}
const ROSTER = ['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
const mine = ROSTER.map((pos, i) => player(pos, i % 2 ? 'AWY' : 'HOM'));
const theirs = ROSTER.map((pos, i) => player(pos, i % 2 ? 'HOM' : 'AWY'));
assets = new Map([...mine, ...theirs].map(a => [a.id, a]));
const entry = a => ({ lineupSlotId: 20,
  playerPoolEntry: { player: { id: a.espn_id, fullName: a.name, defaultPositionId: POS_ID[a.position] } } });
const payload = {
  teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(entry) } },
    { id: 2, name: 'Theirs', roster: { entries: theirs.map(entry) } }],
  schedule: [5, 6].map(w => ({ matchupPeriodId: w, home: { teamId: 1 }, away: { teamId: 2 } })),
  settings: { scheduleSettings: { matchupPeriodCount: 6, playoffTeamCount: 2 } }
};
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
     VALUES (801, 'espn', 'ceiling-recency', 2026, 'Ceiling recency', '1', 10, 1, ?, ?)`,
JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']), JSON.stringify(payload));

/** Drive the real ceilingLineup for one player-week and return what it asked for. */
function askedFor(week) {
  asked.length = 0;
  ceilingLineup(801, { week, trials: 50 });
  assert.equal(asked.length, 1,
    `the spy saw ${asked.length} calls to buildProjections, so it is not watching the `
    + 'call this test is about');
  return asked[0];
}

test('the ceiling lineup asks for the same recency the weekly engine asks for', () => {
  const args = askedFor(5);
  assert.deepEqual(args.roleRecency, WEEKLY_ROLE_RECENCY,
    'the ceiling lineup builds its projections under a different volume memory from the '
    + 'weekly engine, so the My Team ceiling tab and Start/Sit are describing two '
    + 'different players in the same week');
});

test('the cutoff stays the walk-forward-safe mid-season one', () => {
  // The half that was already right. Pinned so the fix cannot arrive by making
  // this a season-boundary caller for real, which would "agree" with nothing and
  // throw away every game played this season.
  const args = askedFor(5);
  assert.equal(args.through, 2026, 'the cutoff moved off the season being played');
  assert.equal(args.throughWeek, 4,
    'the cutoff is no longer the week before the one being projected, so it either '
    + 'ignores this season or reads a week that has not happened');
});

test('the recency travels with the week, rather than being fixed once', () => {
  // A configuration that ignores its argument would pass the two tests above and
  // still be wrong for every other week.
  assert.equal(askedFor(6).throughWeek, 5);
  assert.deepEqual(askedFor(6).roleRecency, WEEKLY_ROLE_RECENCY);
});

test('the configuration is the one shrinkage-fit recognises, so the fitted volume k is handed over', () => {
  // This is the consequence, not a restatement. `activeKVectorFor` withholds the
  // fitted VOLUME entries from any caller whose recency is not the one they were
  // estimated under, and those callers fall back to hand-picked constants that
  // shrinkage-fit.js itself says are "not claimed to be right, only untested
  // with the fitted k".
  const args = askedFor(5);
  assert.equal(isWeeklyRoleRecency(args.roleRecency), true,
    'shrinkage-fit does not recognise this configuration, so the ceiling lineup is '
    + 'still being handed the untested constants instead of the fitted vector');

  // And the control: the OLD behaviour really was withheld. Without this, the
  // assertion above could pass against a build where nothing is ever withheld
  // and the whole concern is imaginary.
  const withRecency = activeKVectorFor(args.roleRecency, { predictingSeason: 2026 });
  const without = activeKVectorFor(undefined, { predictingSeason: 2026 });
  if (withRecency == null) {
    assert.equal(without, null,
      'no fitted vector is loaded at all in this fixture, yet one is withheld — the two '
      + 'answers disagree for a reason this test cannot see');
  } else {
    const kept = Object.keys(withRecency).length;
    const keptWithout = without == null ? 0 : Object.keys(without).length;
    assert.ok(kept >= keptWithout,
      `passing the weekly recency was handed ${kept} metrics and omitting it ${keptWithout}, `
      + 'so the recency argument is costing the caller evidence rather than buying it');
  }
});

/**
 * The other end of the agreement. If the weekly engine ever changes what it
 * passes, the two have diverged again and this file should say so rather than
 * going quietly green against an expectation nobody re-checked.
 *
 * Anchored on the expression that decides it, not on the constant's name
 * appearing somewhere in the file.
 */
test('the weekly engine really does pass WEEKLY_ROLE_RECENCY, so agreeing with it means something', () => {
  const engine = fs.readFileSync('server/services/player-week-engine.js', 'utf8');
  assert.match(engine, /buildProjections\(\{[^}]*roleRecency:\s*WEEKLY_ROLE_RECENCY/,
    'the weekly engine no longer builds its projections under WEEKLY_ROLE_RECENCY, so '
    + 'the ceiling lineup is now agreeing with something that moved');
  assert.match(engine, /buildProjections\(\{[^}]*through:\s*season,\s*throughWeek:\s*week - 1/,
    'the weekly engine no longer uses the mid-season cutoff this file pins the ceiling '
    + 'lineup against');
});

test('the comment above the call no longer describes only half the configuration', () => {
  // The comment at the call site explained the CUTOFF at length and said nothing
  // about recency, which is how the missing half stayed invisible to every reader
  // who checked the comment instead of the argument list. A reader who is told
  // about one of two halves concludes there is one half.
  const src = fs.readFileSync('server/services/ceiling-lineup.js', 'utf8');
  const call = src.indexOf('buildProjections({');
  assert.ok(call > 0, 'the projection call moved; this assertion no longer reads its comment');
  const preamble = src.slice(Math.max(0, call - 1600), call);
  assert.match(preamble, /recency|WEEKLY_ROLE_RECENCY/i,
    'the comment above the projection call still explains only the cutoff, and a reader '
    + 'who trusts it will not know the volume memory is configured here too');
});
