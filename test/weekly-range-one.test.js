/**
 * WEEKLY-RANGE-ONE: one producer for "a lineup's weekly range" (lineup-week-range.js).
 *
 * The number audit's `weekly_range` check was broken on league 4: four samplers (the
 * trade card's normal approximation, the title-odds sim's pools, the ceiling lineup's
 * own copula, and a floor the audit derived from the Start/Sit posture's P(win) SD)
 * gave one lineup-week floors 33.5 pts apart. Now every surface reads p10 / p50 / p90
 * of the lineup total over the league world's runs.
 *
 *   (a) every surface returns identical p10/p50/p90 for the same lineup-week;
 *   (b) the weekly_range check passes on this fixture, where the old values fail it;
 *   (c) no second sampler: no other server module computes a lineup-week percentile.
 *
 * Fixture: EA-07's (a four-team league over three NFL games plus one team on bye in
 * week 2, the real copula, a sampler whose mean is ppg x the volume multiplier).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weekly-range-one-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_ONE_WORLD;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// Three NFL games every week 1-6, and GGG/HHH who play every week except week 2 (bye).
const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF'], ['GGG', 'HHH']];
let nflId = 960;
for (const [h, a] of NFL) {
  const hid = nflId++, aid = nflId++;
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East'), (?, ?, ?, 'NFC', 'West')`,
    hid, h, `${h} team`, aid, a, `${a} team`);
  for (let w = 1; w <= 6; w++) {
    if (h === 'GGG' && w === 2) continue;
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 1)`, hid, w, a);
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 0)`, aid, w, h);
  }
}

const { random } = await import('../server/services/stats-util.js');
const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realContingency = await import('../server/services/contingency.js');
const realLineupBrain = await import('../server/services/lineup-brain.js');
const { LINEUP_WEEK } = realTradeEngine;

const WEEK = 2;
const NFL_TEAMS = NFL.slice(0, 3).flat();
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR'];
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();
const lineupWeek = { league_id: 4, week: WEEK };
function addPlayer(id, position, nflTeam, ppg) {
  assets.set(id, { id, name: `P${id}`, position, team_abbr: nflTeam, espn_id: 9000 + id, available: true,
    current_week_ppg: ppg, adj_ppg: ppg, ppg, ros_ppg: ppg, [LINEUP_WEEK]: lineupWeek });
  projMap.set(id, { ppg, params: { pid: id, mu: ppg }, volume: { target_share: null } });
}
let pid = 100, k = 0;
for (let t = 1; t <= 4; t++) {
  const ids = [];
  LAYOUT.forEach((pos, i) => {
    const id = pid++;
    addPlayer(id, pos, NFL_TEAMS[(t + i * 2) % 6], (pos === 'QB' ? 17 : 8) + ((k++ * 7) % 11) * 0.9);
    ids.push(id);
  });
  teamPlayers.set(t, ids);
}
// Team 1 also rosters a WR on the week-2 bye team, the best WR on paper.
const BYE_WR = pid++;
addPlayer(BYE_WR, 'WR', 'GGG', 25);
// As the asset universe marks a bye: no points this week.
Object.assign(assets.get(BYE_WR), { current_week_ppg: 0, bye_this_week: true });
teamPlayers.get(1).push(BYE_WR);
// A low-volume WR who plays week 2 (team 1's depth), and team 2's WR who plays, for
// the trade that fills the bye hole.
const DEPTH_WR = pid++;
addPlayer(DEPTH_WR, 'WR', 'CCC', 3);
teamPlayers.get(1).push(DEPTH_WR);
const PLAYS_WR = pid++;
addPlayer(PLAYS_WR, 'WR', 'AAA', 12);
teamPlayers.get(2).push(PLAYS_WR);

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
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

// Fresh instances that see the mocks, each re-pointed for the next (EA-07's recipe).
const sim = await import('../server/services/season-sim.js?wr1');
mock.module('../server/services/season-sim.js', { namedExports: { ...sim } });
const leagueWorldMod = await import('../server/services/league-world.js?wr1');
mock.module('../server/services/league-world.js', { namedExports: { ...leagueWorldMod } });
const producer = await import('../server/services/lineup-week-range.js?wr1');
mock.module('../server/services/lineup-week-range.js', { namedExports: { ...producer } });
const te = await import('../server/services/trade-engine.js?wr1');
const { ceilingLineup } = await import('../server/services/ceiling-lineup.js?wr1');
const { lineupPosture } = await import('../server/services/lineup-posture.js?wr1');
const { evaluateSnapshot, TOLERANCES } = await import('../server/services/number-audit.js');
const { leagueWorld, clearLeagueWorlds } = leagueWorldMod;
const { leagueLineupWeekRange, lineupWeekRange, WEEKLY_RANGE_PERCENTILES } = producer;

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
     payload, current_week, payload_season, fetched_at) VALUES (4, 'espn', 'wr1', 2026, 'Weekly range', '1', 4, 1, ?, ?, 2, 2026, '2026-09-24T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 4').get();
const byName = new Map([...assets.values()].map(a => [a.name, a]));
const idsOfNames = names => names.map(n => byName.get(n).id);
const triple = r => ({ floor: r.floor, median: r.median, ceiling: r.ceiling });

/* ------------------------------------------------------------------ (a) */

test('(a) the producer: p10/p50/p90 of the lineup total over the world runs, read at floor(q x n)', () => {
  clearLeagueWorlds();
  const lg = league();
  const world = leagueWorld(lg);
  assert.ifError(world.fail);
  assert.deepEqual(WEEKLY_RANGE_PERCENTILES, { floor: 0.1, median: 0.5, ceiling: 0.9 });
  const ids = teamPlayers.get(1).slice(0, 4);
  const wd = world.draws.get(WEEK);
  const totals = wd.byRun.map(d => ids.reduce((s, id) => s + (d.get(id) ?? 0), 0)).sort((a, b) => a - b);
  const at = q => +totals[Math.floor(q * totals.length)].toFixed(1);
  const r = lineupWeekRange(world, ids, WEEK);
  assert.equal(r.runs, world.runs);
  assert.deepEqual(triple(r), { floor: at(0.1), median: at(0.5), ceiling: at(0.9) });
  assert.ok(r.floor < r.median && r.median < r.ceiling, 'a real spread');
});

test('(a) every surface returns identical p10/p50/p90 for the same lineup-week', () => {
  clearLeagueWorlds();
  const lg = league();
  const world = leagueWorld(lg);
  const slots = te.lineupSlots(lg);
  const mine = world.prep.teams.find(t => t.roster_id === '1');

  // The title-odds sim's own lineup this week (pool means decide).
  const simIds = sim.lineupStarters(mine.players, slots, world.draws.get(WEEK).expected).map(p => p.id);
  const one = triple(leagueLineupWeekRange(lg, simIds, WEEK));
  assert.ok(one.floor != null, 'control: the producer answered');

  // Trade card / My team: lineupSpread over the same starters.
  const card = te.lineupSpread({ slots: simIds.map(id => ({ player: assets.get(id) })) });
  assert.deepEqual(triple(card), one, 'trade card ' + JSON.stringify(card));

  // Ceiling lineup: its highest-mean lineup is the sim's lineup, scored by the producer.
  const ceil = ceilingLineup(4, { teamId: '1', week: WEEK, objective: 'mean' });
  assert.ifError(ceil.error);
  const ceilIds = idsOfNames(ceil.versus_highest_mean.lineup.map(x => x.player));
  assert.deepEqual(new Set(ceilIds), new Set(simIds), 'control: the ceiling lineup starts the sim\'s lineup');
  assert.deepEqual(triple(ceil.versus_highest_mean.distribution), one, 'ceiling lineup');

  // Start/Sit posture: its served range is the producer's for its own starters.
  const posture = lineupPosture(lg, { myTeamId: '1', week: WEEK });
  const postureIds = idsOfNames(posture.lineup.map(x => x.player));
  assert.deepEqual(triple(posture.weekly_range), triple(leagueLineupWeekRange(lg, postureIds, WEEK)), 'posture');
  if (new Set(postureIds).size === simIds.length && postureIds.every(id => simIds.includes(id))) {
    assert.deepEqual(triple(posture.weekly_range), one, 'posture, same lineup');
  }
  assert.ok(Number.isFinite(posture.my_sd), 'the P(win) spread is still served, separately');
});

test('(a) a starter on bye adds 0 in every run; a trade that fills the hole gets the credit on the card', () => {
  clearLeagueWorlds();
  const lg = league();
  const world = leagueWorld(lg);
  assert.equal(world.draws.get(WEEK).expected.has(BYE_WR), false, 'control: the bye WR has no draw in week 2');
  const withBye = leagueLineupWeekRange(lg, [BYE_WR], WEEK);
  assert.deepEqual(triple(withBye), { floor: 0, median: 0, ceiling: 0 });
  assert.equal(withBye.coverage, 0);

  // evaluate(): floor_delta / ceiling_delta are the producer's after - before, computed when read.
  const me = { roster_id: '1', owner: 'T1', players: [assets.get(BYE_WR), assets.get(DEPTH_WR)] };
  const them = { roster_id: '2', owner: 'T2', players: [assets.get(PLAYS_WR)] };
  const ev = te.evaluate({ team: me, gives: [] }, { team: them, gives: [assets.get(PLAYS_WR)] }, ['WR']);
  // This week the bye WR sits: before, the depth WR starts; after, the incoming WR.
  const before = leagueLineupWeekRange(lg, [DEPTH_WR], WEEK);
  const after = leagueLineupWeekRange(lg, [PLAYS_WR], WEEK);
  assert.ok(after.ceiling > before.ceiling, 'control: the incoming WR is the better week');
  assert.equal(ev.me.ceiling_delta, +(after.ceiling - before.ceiling).toFixed(1));
  assert.equal(ev.me.floor_delta, +(after.floor - before.floor).toFixed(1));
  assert.ok(ev.me.ceiling_delta > 0, 'filling the bye hole raises the weekly ceiling');
});

/* ------------------------------------------------------------------ (b) */

// The four samplers as the audit read them on league 4's 2026-09-24 snapshot (W3),
// before this change: title-odds sim floor 75.0 vs a posture-SD "floor" of 41.5.
const BEFORE = [
  { id: 'trade_card', label: 'Trade card', pages: ['Trade cards'], floor: 60, median: 92, ceiling: 124 },
  { id: 'season_sim', label: 'Title odds simulator', pages: ['My team (title odds)'], floor: 75.05, median: 106.26, ceiling: 142.3 },
  { id: 'ceiling_lineup', label: 'Ceiling lineup', pages: ['My team (ceiling lineup)'], floor: 61.89, median: 92.3, ceiling: 129 },
  { id: 'lineup_posture', label: 'Start/Sit posture', pages: ['Start/Sit'], floor: 41.51, median: 93.8, ceiling: 146.09 }
];
const weeklyRow = ranges => evaluateSnapshot({ my_team_id: '1', weekly_ranges: ranges }).find(r => r.check_id === 'weekly_range');

test('(b) the weekly_range check: broken on the old four samplers, ok on the one producer', () => {
  const before = weeklyRow(BEFORE);
  assert.equal(before.status, 'broken');
  assert.match(before.detail, /Title odds simulator says 75\.0, Start\/Sit posture says 41\.5/);

  clearLeagueWorlds();
  const lg = league();
  const world = leagueWorld(lg);
  const mine = world.prep.teams.find(t => t.roster_id === '1');
  const slots = te.lineupSlots(lg);
  // The four entries exactly as number-audit.js#collectLeagueSnapshot reads them.
  const s = te.lineupSpread(te.bestLineup(mine.players.map(p => assets.get(p.id)), slots, 'current_week_ppg'));
  const simIds = sim.lineupStarters(mine.players, slots, producer.worldWeekMeans(world, WEEK)).map(p => p.id);
  const c = ceilingLineup(4, { teamId: '1', week: WEEK, objective: 'mean' });
  const p = lineupPosture(lg, { myTeamId: '1', week: WEEK });
  const after = [
    { ...BEFORE[0], ...triple(s) },
    { ...BEFORE[1], ...triple(lineupWeekRange(world, simIds, WEEK)) },
    { ...BEFORE[2], ...triple(c.versus_highest_mean.distribution) },
    { ...BEFORE[3], ...triple(p.weekly_range) }
  ];
  for (const r of after) assert.ok(Number.isFinite(r.floor), `${r.id} answered`);
  const row = weeklyRow(after);
  assert.equal(row.status, 'ok', row.detail);
  const floors = after.map(r => r.floor);
  assert.ok(Math.max(...floors) - Math.min(...floors) <= TOLERANCES.range_pts);
});

/* ------------------------------------------------------------------ (c) */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? serverFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
const SOURCES = serverFiles(path.join(ROOT, 'server')).map(f => ({
  file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
}));
const PRODUCER = 'server/services/lineup-week-range.js';

test('(c) no second sampler: only the producer sums a lineup over the world runs', () => {
  // Per-run draws (`byRun`) are read by the world that makes them and the one producer.
  const readers = SOURCES.filter(s => /\bbyRun\b/.test(s.text)).map(s => s.file).sort();
  assert.deepEqual(readers, [PRODUCER, 'server/services/season-sim.js']);
  // A copula of its own is how the ceiling lineup used to draw a second world.
  const samplers = SOURCES.filter(s => /correlatedSampler\s*\(/.test(s.text)).map(s => s.file).sort();
  assert.deepEqual(samplers, ['server/services/correlation.js', 'server/services/season-sim.js']);
});

test('(c) no second sampler: no module turns a lineup mean and SD into a floor or ceiling', () => {
  // The trade card's normal approximation (mean -/+ 1.2816 sd) and the audit's posture
  // "floor" were both this shape. A z for the 90th percentile in a file about lineups fails.
  const z = SOURCES.filter(s => s.file !== PRODUCER && /\b1\.28\d*\b/.test(s.text) && /lineup/i.test(s.text));
  assert.deepEqual(z.map(s => s.file), []);
  // The audit reads each page's served range; it computes no quantile of its own.
  const audit = SOURCES.find(s => s.file === 'server/services/number-audit.js');
  assert.doesNotMatch(audit.text, /quantile\s*\(|1\.28/);
});

test('(c) every weekly-range surface reads the one producer', () => {
  for (const file of ['server/services/trade-engine.js', 'server/services/ceiling-lineup.js',
    'server/services/lineup-posture.js', 'server/services/number-audit.js']) {
    const src = SOURCES.find(s => s.file === file);
    assert.match(src.text, /lineup-week-range\.js/, `${file} imports the producer`);
  }
});
