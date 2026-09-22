import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The structural head shrinks every player's target share toward a prior
// (projections.js, the `targetSharePrior` in buildProjections). These tests are
// about WHICH prior, not about the shrinkage constant beside it:
//
//   - a receiver and a running back with identical thin evidence must not be
//     pulled toward the same number, because their positions do not share a
//     target share — WR ~0.13, TE ~0.10, RB ~0.065 on 2021-2024 nflverse rows;
//   - the prior must be measured over every week with a known share, INCLUDING
//     weeks the player saw no targets, because that is the estimand it shrinks
//     toward (`a.tgtShare / a.tgtShareW` counts a zero week);
//   - the legacy single constant stays reachable, so a backtest can grade the
//     two on identical inputs the way `kOverride: null` does for the k vector.
//
// The fitted values themselves are graded out of sample against held-out 2025;
// this file pins the wiring and the estimand.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-target-share-prior-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/nfl-pbp.js'); // side effect: creates nfl_player_week_features, joined by history()
const { buildProjections } = await import('../server/services/projections.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const TEAM = 'AAA';
const PASS_ATT = 35;
const RUSH_ATT = 25;

const insertPlayer = (id, name, position) => run(
  'INSERT INTO players (id, name, position, fantasy_relevant) VALUES (?,?,?,1)', id, name, position);

const insertUsage = (playerId, season, week, position, opts = {}) => run(
  `INSERT INTO player_week_usage
   (player_id, season, week, team, opponent, position, attempts, passing_yards, passing_tds,
    interceptions, carries, rushing_yards, rushing_tds, targets, receptions, receiving_yards,
    receiving_tds, target_share)
   VALUES (?,?,?,?,'OPP',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  playerId, season, week, TEAM, position,
  opts.attempts ?? 0, opts.passYds ?? 0, opts.passTd ?? 0, opts.ints ?? 0,
  opts.carries ?? 0, opts.rushYds ?? 0, opts.rushTd ?? 0,
  opts.targets ?? 0, opts.receptions ?? 0, opts.recYds ?? 0, opts.recTd ?? 0,
  opts.targetShare ?? null);

// One quarterback carries the team's pass volume so `teamVolume` has something
// to divide by; his own target share is irrelevant and stays null.
insertPlayer(1, 'Team QB', 'QB');
for (let w = 1; w <= 8; w++) {
  insertUsage(1, 2023, w, 'QB', { attempts: PASS_ATT, passYds: 250, passTd: 1.5, ints: 0.6 });
}

// A population thick enough to establish a per-position mean, with the three
// positions deliberately far apart.
const POPULATION = [
  { pos: 'WR', share: 0.13, from: 100 },
  { pos: 'RB', share: 0.065, from: 200 }
];
for (const { pos, share, from } of POPULATION) {
  for (let i = 0; i < 20; i++) {
    const id = from + i;
    insertPlayer(id, `${pos} ${i}`, pos);
    for (let w = 1; w <= 8; w++) {
      insertUsage(id, 2023, w, pos, {
        targets: share * PASS_ATT, receptions: share * PASS_ATT * 0.65,
        recYds: share * PASS_ATT * 7.5, targetShare: share,
        carries: pos === 'RB' ? RUSH_ATT / 20 : 0,
        rushYds: pos === 'RB' ? (RUSH_ATT / 20) * 4.3 : 0
      });
    }
  }
}

// Tight ends: half their weeks are zero-target. The mean INCLUDING those weeks
// is 0.10; excluding them it is 0.20. Which one the prior uses is observable.
for (let i = 0; i < 20; i++) {
  const id = 300 + i;
  insertPlayer(id, `TE ${i}`, 'TE');
  for (let w = 1; w <= 8; w++) {
    const quiet = w % 2 === 0;
    insertUsage(id, 2023, w, 'TE', {
      targets: quiet ? 0 : 0.20 * PASS_ATT,
      receptions: quiet ? 0 : 0.20 * PASS_ATT * 0.65,
      recYds: quiet ? 0 : 0.20 * PASS_ATT * 7.5,
      targetShare: quiet ? 0 : 0.20
    });
  }
}

// The three players under test: one week of evidence each, identical observed
// share. Everything that could separate them other than position is equal.
const THIN_OBSERVED = 0.09;
for (const [id, pos] of [[9001, 'WR'], [9002, 'RB'], [9003, 'TE']]) {
  insertPlayer(id, `Thin ${pos}`, pos);
  insertUsage(id, 2023, 8, pos, {
    targets: THIN_OBSERVED * PASS_ATT, receptions: THIN_OBSERVED * PASS_ATT * 0.65,
    recYds: THIN_OBSERVED * PASS_ATT * 7.5, targetShare: THIN_OBSERVED
  });
}

const shareOf = (projections, id) => projections.get(id).volume.target_share;
const reportedPrior = (projections, id) => projections.get(id).role_prior.target_share;

test('a thin receiver and a thin back are not shrunk toward the same share', () => {
  const p = buildProjections({ through: 2023, kOverride: null });
  const wr = shareOf(p, 9001);
  const rb = shareOf(p, 9002);
  assert.ok(wr > rb, `expected the receiver above the back, got WR ${wr} vs RB ${rb}`);
  // One week of evidence against K.share = 6 puts six sevenths of the weight on
  // the prior, so the gap is most of the gap between the two positional means.
  const expectedGap = (6 / 7) * (0.13 - 0.065);
  assert.ok(Math.abs((wr - rb) - expectedGap) < 0.01,
    `expected a gap near ${expectedGap.toFixed(4)}, got ${(wr - rb).toFixed(4)}`);
});

test('the projection reports the prior it actually used', () => {
  // `role_prior` is served to callers; a fixed 0.06 there while the head shrinks
  // toward something else would be a second, silent copy of the constant.
  const p = buildProjections({ through: 2023, kOverride: null });
  const wr = reportedPrior(p, 9001);
  const rb = reportedPrior(p, 9002);
  assert.ok(Math.abs(wr - 0.13) < 0.01, `expected the receiver prior near 0.13, got ${wr}`);
  assert.ok(Math.abs(rb - 0.065) < 0.01, `expected the back prior near 0.065, got ${rb}`);
});

test('the prior counts weeks with no targets, because the estimand does', () => {
  const p = buildProjections({ through: 2023, kOverride: null });
  const te = shareOf(p, 9003);
  // TEs average 0.10 over every week and 0.20 over their busy weeks only. A thin
  // TE observed at 0.09 lands near the former; the latter would drag him to ~0.19.
  assert.ok(te < 0.12, `expected the tight end near the all-weeks mean, got ${te}`);
  assert.ok(te > 0.07, `expected the tight end above his own thin observation, got ${te}`);
});

test('the legacy single prior stays reachable for a backtest', () => {
  const p = buildProjections({ through: 2023, kOverride: null, sharePrior: 'legacy' });
  const wr = shareOf(p, 9001);
  const rb = shareOf(p, 9002);
  const te = shareOf(p, 9003);
  assert.ok(Math.abs(wr - rb) < 1e-9 && Math.abs(wr - te) < 1e-9,
    `legacy arm must shrink all three toward one number, got ${wr}, ${rb}, ${te}`);
  const legacy = (1 * THIN_OBSERVED + 6 * 0.06) / 7;
  assert.ok(Math.abs(wr - legacy) < 0.005,
    `expected the legacy constant ${legacy.toFixed(4)}, got ${wr.toFixed(4)}`);
});
