import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The QB structural head takes a small, gated nudge from trailing ESPN QBR
// (server/services/projections.js's QBR_SIGNAL). These tests are about the
// wiring and the safety rails, not the fitted constant itself (that is
// validated out of sample by scripts/analyze-qbr-fantasy-signal.mjs):
//   - a QB whose trailing QBR sits above league average should project a
//     little higher than the same QB with an average trailing QBR, and a
//     below-average QBR should project a little lower;
//   - a QB with no qualifying trailing QBR read (no rows, or too few plays to
//     qualify) gets zero adjustment rather than a crash or a fabricated read;
//   - the signal never touches a non-QB position;
//   - it never reads QBR from the target week itself or later (no lookahead);
//   - the feature is toggleable so a backtest can grade with/without it.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-qbr-signal-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/nfl-pbp.js'); // side effect: creates nfl_player_week_features, joined by history()
const { buildProjections, QBR_SIGNAL } = await import('../server/services/projections.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insertPlayer = (id, name, position, espnId) => run(
  `INSERT INTO players (id, name, position, espn_id, fantasy_relevant) VALUES (?,?,?,?,1)`,
  id, name, position, espnId);

const insertUsage = (playerId, season, week, team, opts = {}) => run(
  `INSERT INTO player_week_usage
   (player_id, season, week, team, opponent, position, attempts, passing_yards, passing_tds, interceptions,
    carries, rushing_yards, rushing_tds, targets, receptions, receiving_yards, receiving_tds)
   VALUES (?,?,?,?, 'OPP', ?, ?, ?, ?, ?, 0,0,0,0,0,0,0)`,
  playerId, season, week, team, opts.position ?? 'QB',
  opts.attempts ?? 32, opts.passYds ?? 260, opts.passTd ?? 1.6, opts.ints ?? 0.7);

const insertQbr = (season, week, team, espnId, name, total) => run(
  `INSERT INTO nfl_qbr_weekly
   (season,week,team,player_id,name,opponent,qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack,qualified,fetched_at)
   VALUES (?,?,?,?,?,'OPP',?,0,35,0,?,0,1,datetime('now'))`,
  season, week, team, String(espnId), name, total, total);

// Two otherwise-identical QBs (same team volume, same passing stat line every
// week), differing only in trailing QBR: HIGH trails well above league
// average (53.26), LOW trails well below it.
insertPlayer(1, 'High QBR', 'QB', 9001);
insertPlayer(2, 'Low QBR', 'QB', 9002);
insertPlayer(3, 'No QBR History', 'QB', 9003);
for (let w = 1; w <= 8; w++) {
  insertUsage(1, 2023, w, 'AAA');
  insertUsage(2, 2023, w, 'BBB');
  insertUsage(3, 2023, w, 'CCC');
  insertQbr(2023, w, 'AAA', 9001, 'High QBR', 85);
  insertQbr(2023, w, 'BBB', 9002, 'Low QBR', 20);
  // No QBR rows at all for player 3 -- simulates a player the sync never covered.
}
// A QBR row that lands exactly on the target week (2023 W9) must never be
// read when projecting week 9 -- it is same-week evidence, not prior evidence.
insertQbr(2023, 9, 'AAA', 9001, 'High QBR', 99);

test('a QB well above league-average trailing QBR gets a small positive nudge', () => {
  const withSignal = buildProjections({ through: 2023, throughWeek: 8 });
  const p = withSignal.get(1);
  assert.equal(p.position, 'QB');
  assert.ok(p.qbr_read, 'expected a qualifying trailing QBR read');
  assert.ok(p.qbr_read.qbr > 80, 'trailing QBR should reflect the 85s fed in, not the week-9 99');
  assert.ok(p.qbr_adjustment > 0, `expected a positive adjustment, got ${p.qbr_adjustment}`);
  assert.equal(+(p.structural_ppg_pre_qbr + p.qbr_adjustment).toFixed(2), p.ppg);
});

test('a QB well below league-average trailing QBR gets a small negative nudge', () => {
  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(2);
  assert.ok(p.qbr_read.qbr < 25);
  assert.ok(p.qbr_adjustment < 0, `expected a negative adjustment, got ${p.qbr_adjustment}`);
});

test('no qualifying QBR history means zero adjustment, not a crash or a fabricated read', () => {
  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(3);
  assert.equal(p.qbr_read, null);
  assert.equal(p.qbr_adjustment, 0);
  assert.equal(p.ppg, p.structural_ppg_pre_qbr);
});

test('the QBR read never includes the target week itself (no lookahead)', () => {
  // Projecting week 9 off weeks 1-8: the week-9 QBR=99 row must not appear.
  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(1);
  assert.equal(p.qbr_read.qbr, 85, 'the week-9 QBR=99 row is same-week evidence and must be excluded');
});

test('the signal never adjusts a non-QB position', () => {
  insertPlayer(4, 'Some WR', 'WR', 9004);
  for (let w = 1; w <= 8; w++) {
    run(`INSERT INTO player_week_usage
      (player_id, season, week, team, opponent, position, targets, receptions, receiving_yards, receiving_tds,
       attempts, passing_yards, passing_tds, interceptions, carries, rushing_yards, rushing_tds)
      VALUES (?,?,?,?,'OPP','WR',7,5,60,0.4, 0,0,0,0,0,0,0)`, 4, 2023, w, 'DDD');
  }
  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(4);
  assert.equal(p.qbr_adjustment, 0);
  assert.equal(p.qbr_read, null);
});

test('the feature is toggleable off, for backtests that need to grade with/without it', () => {
  const off = buildProjections({ through: 2023, throughWeek: 8, qbrSignal: { ...QBR_SIGNAL, enabled: false } }).get(1);
  assert.equal(off.qbr_adjustment, 0);
  assert.equal(off.ppg, off.structural_ppg_pre_qbr);
});
