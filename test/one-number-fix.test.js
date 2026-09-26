/**
 * ONE-NUMBER-FIX: the two broken number_audit checks, fixed at the root (one producer each).
 *
 *   weekly_range (league 2, week 3: Trade card 138.9 vs Start/Sit posture 123.6). Every surface
 *   read the one range producer, but over different lineups: the posture held a starter ESPN had
 *   locked (his Thursday game was over) and scored him 0, the trade card / My team / ceiling
 *   lineup benched him for a healthy player. Pinned here:
 *     - settled-points.js: a starter whose game is final scores ESPN's actual; in progress or
 *       not started, he does not
 *     - lineup-week-range.js: a settled starter adds his actual to every run
 *     - trade-engine.js#thisWeekLineup: a locked starter keeps his slot even with no week
 *       projection; a locked bench player cannot come in
 *   title_odds_paths (league 5: My team vs Trade Lab title impact). My team's /simulate ran its
 *   own unseeded simulateSeason when the one-world flag was off, beside the Title tab's world.
 *   Pinned here: the twin, the TradeCard, the sense-check, the Title tab and the finder's horizon
 *   all read the league world, and the audit reads what those pages serve.
 * Made-up players and teams only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-one-number-fix-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '3';
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_PROJ_ESPN;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
const { settledWeekPoints, FINAL_AFTER_HOURS } = await import('../server/services/settled-points.js');
const { lineupWeekTotals, lineupWeekRange } = await import('../server/services/lineup-week-range.js');
const { thisWeekLineup } = await import('../server/services/trade-engine.js');

// Three NFL teams: THU played Thursday, SUN plays Sunday, LIVE kicked off an hour ago.
const NOW = Date.parse('2026-09-26T07:00:00Z');
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (991, 'THU', 'Thu team', 'AFC', 'East'),
     (992, 'SUN', 'Sun team', 'NFC', 'West'), (993, 'LIV', 'Live team', 'AFC', 'West')`);
run(`INSERT INTO game_lines (season, week, team, gameday, gametime) VALUES (2026, 3, 'THU', '2026-09-24', '20:15'),
     (2026, 3, 'SUN', '2026-09-27', '13:00'), (2026, 3, 'LIV', '2026-09-26', '02:00')`);
const P = [
  [9101, 'Thursday Back', 'RB', 991, 7101], [9102, 'Sunday Back', 'RB', 992, 7102], [9103, 'Live Receiver', 'WR', 993, 7103],
  [9104, 'Bench Thursday', 'RB', 991, 7104], [9105, 'Sunday Receiver', 'WR', 992, 7105]
];
for (const [id, name, pos, team, espn] of P) run('INSERT INTO players (id, name, position, team_id, espn_id) VALUES (?, ?, ?, ?, ?)', id, name, pos, team, espn);

const stat = (week, actual, proj) => [{ scoringPeriodId: week, statSourceId: 0, statSplitTypeId: 1, appliedTotal: actual },
  { scoringPeriodId: week, statSourceId: 1, statSplitTypeId: 1, appliedTotal: proj }];
const entry = (espn, slot, stats = [], locked = false) => ({ lineupSlotId: slot,
  playerPoolEntry: { lineupLocked: locked, player: { id: espn, fullName: `p${espn}`, stats } } });
const payload = { teams: [{ id: 1, roster: { entries: [
  entry(7101, 2, stat(3, 35.3, 19.5), true),       // RB, Thursday, final, locked in his RB slot
  entry(7102, 2),                                 // RB, Sunday
  entry(7103, 4, stat(3, 8.1, 14), true),          // WR, kicked off an hour ago: in progress
  entry(7104, 20, stat(3, 22, 9), true),           // Thursday, final, locked on the BENCH
  entry(7105, 4)                                  // WR, Sunday
] } }] };
const LG = { id: 77, platform: 'espn', season: 2026, my_team_id: '1', payload: JSON.stringify(payload) };

test('settled points: a finished game is its actual; in progress or not started is not settled', () => {
  const s = settledWeekPoints(LG, 3, { now: NOW });
  assert.equal(s.get(9101), 35.3, 'Thursday starter, game final');
  assert.equal(s.get(9104), 22, 'Thursday bench player, game final');
  assert.equal(s.has(9103), false, `kicked off under ${FINAL_AFTER_HOURS} h ago: not final`);
  assert.equal(s.has(9102), false, 'not played yet');
  assert.equal(settledWeekPoints(LG, 4, { now: NOW }).size, 0, 'a later week has nothing settled');
});

test('the one range producer: a settled starter adds his actual to every run, and says so', () => {
  const vals = [[10, 1], [20, 2], [30, 3], [40, 4]];
  const world = { runs: 4, key: { seed: 1 }, draws: new Map([[3, { kdst: new Map(),
    byRun: vals.map(v => ({ index: new Map([[9102, 0], [9105, 1]]), vals: v })) }]]) };
  const plain = lineupWeekTotals(world, [9102, 9101], 3);
  const withSettled = lineupWeekTotals(world, [9102, 9101], 3, { settled: new Map([[9101, 35.3]]) });
  assert.deepEqual([...plain.totals], [10, 20, 30, 40], 'without it the finished starter scored 0 (the league 2 bug)');
  assert.deepEqual([...withSettled.totals].map(x => +x.toFixed(1)), [45.3, 55.3, 65.3, 75.3]);
  assert.equal(withSettled.settled, 1);
  assert.equal(lineupWeekRange(world, [9102, 9101], 3, { settled: new Map([[9101, 35.3]]) }).settled_starters, 1);
});

test('THE lineup this week: a locked starter keeps his slot with no week projection; a locked bench player stays out', () => {
  const players = [
    { id: 9101, name: 'Thursday Back', position: 'RB', espn_id: 7101, team_abbr: 'THU', current_week_ppg: null },
    { id: 9102, name: 'Sunday Back', position: 'RB', espn_id: 7102, team_abbr: 'SUN', current_week_ppg: 12 },
    { id: 9103, name: 'Live Receiver', position: 'WR', espn_id: 7103, team_abbr: 'LIV', current_week_ppg: 14 },
    { id: 9104, name: 'Bench Thursday', position: 'RB', espn_id: 7104, team_abbr: 'THU', current_week_ppg: 30 },
    { id: 9105, name: 'Sunday Receiver', position: 'WR', espn_id: 7105, team_abbr: 'SUN', current_week_ppg: 9 }
  ];
  const line = thisWeekLineup(LG, '1', players, ['RB', 'RB', 'WR', 'WR'], 'current_week_ppg', { now: NOW });
  const starters = line.slots.map(s => s.player?.id).sort();
  assert.deepEqual(starters, [9101, 9102, 9103, 9105], 'the locked Thursday starter is held; the locked bench back cannot come in');
  assert.ok(line.pinned.includes(9101));
});

test('title odds: one producer on every page, and the audit reads what the pages serve', () => {
  const src = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const route = src('server/routes/model.js');
  const simulate = route.slice(route.indexOf("r.get('/:leagueId/simulate'"), route.indexOf("r.post('/:leagueId/trade-impact'"));
  assert.match(simulate, /oneWorldTitleOdds\(lg/);
  assert.doesNotMatch(simulate, /simulateSeason\(/, 'My team never runs its own simulation again');
  const impact = route.slice(route.indexOf("r.post('/:leagueId/trade-impact'"));
  assert.match(impact.slice(0, 1500), /world: leagueWorld\(lg\)/);
  assert.doesNotMatch(impact.slice(0, 1500), /oneWorldFlag\(\)\.on/);
  assert.match(src('server/services/title-odds-trades.js'), /const shared = leagueWorld\(lg\);/);
  const engine = src('server/services/trade-engine.js');
  const horizon = engine.slice(engine.indexOf('export function myPlayoffOdds'), engine.indexOf('/** Resolve the odds the horizon is built on'));
  assert.match(horizon, /leagueWorld\(lg\)/);
  assert.doesNotMatch(horizon, /simulateSeason\(/);
  const audit = src('server/services/number-audit.js');
  assert.match(audit, /leagueWorldMod\.oneWorldTitleOdds\(lg\)/, 'the audit reads the twin\'s producer');
  assert.match(audit, /leagueWorldMod\.leagueWorld\(lg\)/, 'and the Title tab\'s world');
  assert.doesNotMatch(audit, /sim\.simulateSeason\(lg, \{ runs: 1500/, 'not an unseeded simulation no page serves');
  assert.match(audit, /te\.thisWeekLineup\(lg, me, mine\.players/, 'the trade card range the page serves');
});
