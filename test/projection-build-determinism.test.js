/**
 * Whether rebuilding the projection set would "introduce noise".
 *
 * `tradeImpact` builds the projection set ONCE and hands the same object to both runs, and the
 * comment beside it said rebuilding "would introduce noise that has nothing to do with the
 * trade". Feature audit's mutation on that line was INERT -- rebuilding between the runs changed
 * no test -- which is a claim about the code, not about the test: if `buildProjections` draws no
 * random numbers, there is no noise to introduce and the stated reason is wrong even though the
 * shared build is right.
 *
 * Model audit traced it one level (no `random()` in `buildProjections` or its eleven direct
 * callees; the one `random()` in projections.js is inside `sampleWeeks`, which this path does not
 * reach) and did not trace the transitive closure. So the check here is empirical rather than
 * structural: build twice and compare, and check the shared generator for consumed draws. A
 * transitive call through any depth of helper would show up in both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-projection-determinism-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/nfl-pbp.js');   // creates nfl_player_week_features
const { buildProjections } = await import('../server/services/projections.js');
const { random, withRandomSeed } = await import('../server/services/stats-util.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insertPlayer = (id, name, position) => run(
  `INSERT INTO players (id, name, position, fantasy_relevant) VALUES (?,?,?,1)`, id, name, position);

const insertUsage = (playerId, season, week, team, position, o = {}) => run(
  `INSERT INTO player_week_usage
   (player_id, season, week, team, opponent, position, attempts, passing_yards, passing_tds,
    interceptions, carries, rushing_yards, rushing_tds, targets, receptions, receiving_yards,
    receiving_tds)
   VALUES (?,?,?,?, 'OPP', ?, ?,?,?,?,?,?,?,?,?,?,?)`,
  playerId, season, week, team, position,
  o.attempts ?? 0, o.passYds ?? 0, o.passTd ?? 0, o.ints ?? 0,
  o.carries ?? 0, o.rushYds ?? 0, o.rushTd ?? 0,
  o.targets ?? 0, o.rec ?? 0, o.recYds ?? 0, o.recTd ?? 0);

// A small but real league: four positions, two teams, seventeen weeks, with the week-to-week
// variation the shrinkage and recency paths actually read. Enough that a build has work to do --
// a fixture that produced an empty projection set would make every assertion below vacuous.
insertPlayer(1, 'A Quarterback', 'QB');
insertPlayer(2, 'A Running Back', 'RB');
insertPlayer(3, 'A Receiver', 'WR');
insertPlayer(4, 'A Tight End', 'TE');
insertPlayer(5, 'Another Receiver', 'WR');
for (let w = 1; w <= 17; w++) {
  const j = (w % 5) - 2;                      // -2..2, so nothing is a flat line
  insertUsage(1, 2025, w, 'AAA', 'QB', { attempts: 30 + j, passYds: 255 + 12 * j, passTd: 1.7, ints: 0.6 });
  insertUsage(2, 2025, w, 'AAA', 'RB', { carries: 17 + j, rushYds: 74 + 9 * j, rushTd: 0.5, targets: 3, rec: 2, recYds: 16 });
  insertUsage(3, 2025, w, 'AAA', 'WR', { targets: 9 + j, rec: 6, recYds: 82 + 11 * j, recTd: 0.5 });
  insertUsage(4, 2025, w, 'BBB', 'TE', { targets: 5 + j, rec: 4, recYds: 41 + 6 * j, recTd: 0.3 });
  insertUsage(5, 2025, w, 'BBB', 'WR', { targets: 7 - j, rec: 5, recYds: 68 - 8 * j, recTd: 0.4 });
}

const ARGS = { through: 2025, scoring: { rec: 1 } };
const serialise = m => JSON.stringify(
  [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

test('the fixture gives a build something to do, or nothing below means anything', () => {
  const built = buildProjections(ARGS);
  assert.ok(built.size >= 5, `expected every fixture player projected, got ${built.size}`);
  for (const [id, p] of built) {
    assert.equal(p.player_id, id);
    assert.equal(p.evidence_games, 17, `player ${id} was built from all seventeen weeks`);
    assert.ok(p.role_prior, `player ${id} carries a fitted role prior, so real arithmetic ran`);
  }
  // Distinct payloads, so the comparison below cannot pass on five identical rows.
  const shapes = new Set([...built.values()].map(p => JSON.stringify(p.role_prior)));
  assert.ok(shapes.size > 1, `the players project differently from each other (${shapes.size} shapes)`);
});

test('two builds with identical arguments are byte-identical', () => {
  const a = serialise(buildProjections(ARGS));
  const b = serialise(buildProjections(ARGS));
  assert.equal(a, b, 'a rebuild produces the same projection set, so it introduces no noise');
  assert.ok(a.length > 500, `and the comparison is over a real payload (${a.length} chars)`);
});

test('a build consumes no random draws, which is why a rebuild could not introduce noise', () => {
  // The direct statement, and the one that survives a helper being added at any depth: if the
  // build touched the shared generator, the draws after it would differ from the draws without
  // it under the same seed.
  const withoutBuild = withRandomSeed(7, () => [random(), random(), random()]);
  const afterBuild = withRandomSeed(7, () => { buildProjections(ARGS); return [random(), random(), random()]; });
  assert.deepEqual(afterBuild, withoutBuild,
    'buildProjections must not advance the shared generator');
  assert.ok(new Set(withoutBuild).size === 3, 'and the generator really is producing draws');
});

test('the comment beside the shared build gives a reason that is true', () => {
  // The reason matters because it is what a future reader decides by. "Rebuilding would introduce
  // noise" invites someone who measures no noise to conclude the shared build is pointless; the
  // real reasons are that it is wasted work and that sharing it holds even if a future change
  // does introduce a draw.
  const src = fs.readFileSync('server/services/season-sim.js', 'utf8');
  assert.equal(/rebuilding would introduce noise/i.test(src), false,
    'the noise claim is measured false by the tests above');
  const shared = src.slice(src.indexOf('One projection build shared by both runs'));
  assert.match(shared.slice(0, 700), /deterministic/i,
    'the comment states what was measured');
});
