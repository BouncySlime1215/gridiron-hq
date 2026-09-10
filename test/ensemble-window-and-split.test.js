/**
 * Codex corrections C04 and C07 — the two chronology defects in the ensemble.
 *
 * C04: "Opponent strength mixes obsolete schedules with recent statistics."
 * `scheduleFaced` consumed every game in history while `featureAggregates`
 * spans only the current season's earlier weeks plus the immediately previous
 * one. Opponent EXPOSURE therefore ran over a decade while opponent QUALITY ran
 * over two seasons. The audit measured the cost: adding 2016 schedule rows
 * moved the isolated 2024 component from -23.400 to +16.714 with the 2024
 * features completely unchanged.
 *
 * C07: "The residual split does not isolate the entire fitted pipeline."
 * `Math.floor(length * 0.7)` cuts at a row index, which lands inside a Sunday
 * slate roughly six times out of seven. Games in one week share a week of
 * common information, so a score block holding half of a week whose other half
 * trained the slope is not out of fold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ensemble-window-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const TEAMS = ['KC', 'BAL', 'BUF', 'CIN', 'SF', 'SEA', 'DAL', 'PHI'];
db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES ${
  TEAMS.map((t, i) => `(${i + 1},'${t}','${t} Team','AFC','West')`).join(',')}`);

/** One completed game, both rows, with a posted spread and a final score. */
let gameSeq = 0;
function game({ season, week, home, away, homeScore, awayScore, spread = -3 }) {
  gameSeq++;
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,gametime)
       VALUES (?,?,?,?,1,?,44,?,?,?,?)`,
  season, week, home, away, spread, homeScore, awayScore, `${season}-09-${String((week % 28) + 1).padStart(2, '0')}`, '13:00');
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,gametime)
       VALUES (?,?,?,?,0,?,44,?,?,?,?)`,
  season, week, away, home, -spread, awayScore, homeScore, `${season}-09-${String((week % 28) + 1).padStart(2, '0')}`, '13:00');
}

const { __testables } = await import('../server/services/nfl-ensemble.js');
const ensemble = await import('../server/services/nfl-ensemble.js');

/* ------------------------------------------------------------------ C04 */

test('C04: an OBSOLETE season\'s schedule cannot change a current forecast', async () => {
  // Two seasons of current-window games, then a decade-old season added later.
  for (let week = 1; week <= 6; week++) {
    game({ season: 2025, week, home: TEAMS[week % 8], away: TEAMS[(week + 3) % 8],
      homeScore: 24, awayScore: 17 });
    game({ season: 2026, week, home: TEAMS[(week + 1) % 8], away: TEAMS[(week + 4) % 8],
      homeScore: 20, awayScore: 23 });
  }
  const hist = db.prepare(`SELECT season, week, team AS home, opponent AS away
    FROM game_lines WHERE home = 1`).all();

  const before = ensemble.__testables.scheduleFaced(hist, { season: 2026, week: 7 });
  const beforeCounts = Object.fromEntries([...before].map(([t, o]) => [t, o.length]));

  // Now the obsolete rows arrive. They describe real games, ten years earlier.
  const withObsolete = [...hist];
  for (let week = 1; week <= 17; week++) {
    withObsolete.push({ season: 2016, week, home: TEAMS[week % 8], away: TEAMS[(week + 5) % 8] });
  }
  const after = ensemble.__testables.scheduleFaced(withObsolete, { season: 2026, week: 7 });
  const afterCounts = Object.fromEntries([...after].map(([t, o]) => [t, o.length]));

  assert.deepEqual(afterCounts, beforeCounts,
    'a 2016 opponent is not 2026 exposure, and cannot be priced with 2026 efficiency');
});

test('C04: an ELIGIBLE schedule change DOES move the exposure', () => {
  const hist = db.prepare(`SELECT season, week, team AS home, opponent AS away
    FROM game_lines WHERE home = 1`).all();
  const before = ensemble.__testables.scheduleFaced(hist, { season: 2026, week: 7 });
  const withEligible = [...hist, { season: 2026, week: 6, home: 'KC', away: 'PHI' }];
  const after = ensemble.__testables.scheduleFaced(withEligible, { season: 2026, week: 7 });

  assert.equal((after.get('KC') ?? []).length, (before.get('KC') ?? []).length + 1,
    'a real game inside the window is real exposure');
  assert.ok((after.get('KC') ?? []).includes('PHI'));
});

test('C04: the previous season blends in, and a FUTURE week never does', () => {
  const hist = db.prepare(`SELECT season, week, team AS home, opponent AS away
    FROM game_lines WHERE home = 1`).all();
  const atWeek3 = ensemble.__testables.scheduleFaced(hist, { season: 2026, week: 3 });
  const atWeek7 = ensemble.__testables.scheduleFaced(hist, { season: 2026, week: 7 });

  const total = m => [...m.values()].reduce((s, o) => s + o.length, 0);
  assert.ok(total(atWeek3) > 0, 'the 2025 season blends into an early 2026 week');
  assert.ok(total(atWeek7) > total(atWeek3),
    'and more of 2026 becomes eligible as the season runs');

  // Nothing from a later week can appear at an earlier cutoff.
  const week1 = ensemble.__testables.scheduleFaced(hist, { season: 2026, week: 1 });
  const from2026 = hist.filter(g => g.season === 2026);
  assert.ok(from2026.length > 0);
  assert.equal(total(week1), total(ensemble.__testables.scheduleFaced(
    hist.filter(g => g.season === 2025), { season: 2026, week: 1 })),
  'a week-1 forecast sees only the previous season');
});

test('C04: repeat opponents are counted once per meeting, not deduplicated away', () => {
  const hist = [
    { season: 2026, week: 1, home: 'KC', away: 'BAL' },
    { season: 2026, week: 4, home: 'BAL', away: 'KC' }
  ];
  const faced = ensemble.__testables.scheduleFaced(hist, { season: 2026, week: 7 });
  assert.deepEqual(faced.get('KC'), ['BAL', 'BAL'],
    'playing a strong opponent twice is twice the exposure to them');
});

/* ------------------------------------------------------------------ C07 */

test('C07: the fit/score boundary never splits a week across both blocks', () => {
  // A week's worth of games at a time, exactly as the real sequence arrives.
  const weeks = [];
  for (let season of [2025, 2026]) {
    for (let week = 1; week <= 10; week++) {
      for (let g = 0; g < 8; g++) weeks.push(`${season}|${week}`);
    }
  }
  const split = ensemble.__testables.completeWeekSplit(weeks);

  assert.ok(split > 0 && split < weeks.length, 'both blocks must be non-empty');
  const fitWeeks = new Set(weeks.slice(0, split));
  const scoreWeeks = new Set(weeks.slice(split));
  const overlap = [...scoreWeeks].filter(w => fitWeeks.has(w));
  assert.deepEqual(overlap, [],
    'no week may train the slope and also grade it');

  // And the boundary really is where a week changes.
  assert.notEqual(weeks[split - 1], weeks[split]);
});

test('C07: the naive row split really did cut a week in half', () => {
  // Nine weeks of eight games: 72 rows, and 0.7 * 72 = 50.4 -> index 50, which
  // sits INSIDE week 7 (rows 48..55). Ten uniform weeks would have landed on a
  // boundary by arithmetic accident (0.7 * 10k is always a multiple of k),
  // which is exactly the kind of fixture that makes a broken split look fine.
  const weeks = [];
  for (let week = 1; week <= 9; week++) for (let g = 0; g < 8; g++) weeks.push(`2026|${week}`);
  const naive = Math.floor(weeks.length * 0.7);
  assert.equal(weeks[naive - 1], weeks[naive],
    'the old boundary fell inside a single week — this is the defect, preserved');

  const corrected = ensemble.__testables.completeWeekSplit(weeks);
  assert.notEqual(weeks[corrected - 1], weeks[corrected]);
});

test('C07: a sequence too short to split honestly returns no split at all', () => {
  assert.equal(ensemble.__testables.completeWeekSplit([]), 0);
  assert.equal(ensemble.__testables.completeWeekSplit(['2026|1']), 0);
  // Every row in one week: there is no boundary, and inventing one would put
  // half a week on each side, which is the defect.
  assert.equal(ensemble.__testables.completeWeekSplit(['2026|1', '2026|1', '2026|1']), 0);
});

test('C07: two weeks split into one fit week and one score week', () => {
  const weeks = ['2026|1', '2026|1', '2026|2', '2026|2'];
  const split = ensemble.__testables.completeWeekSplit(weeks);
  assert.equal(split, 2);
  assert.deepEqual(weeks.slice(0, split), ['2026|1', '2026|1']);
  assert.deepEqual(weeks.slice(split), ['2026|2', '2026|2']);
});
