/**
 * buildProjections attaching docs/spec/projection-range.md's section 5 serving
 * contract (range_lo/range_hi/range_coverage/range_basis/range_fitted_at/
 * range_n) from server/services/projection-range.js's persisted, active fit.
 *
 * "Absent beats invented" (spec section 5, already the rule
 * projectionRangeFor itself enforces): a player with no active fit, or whose
 * position/bin the active fit never saw 20+ rows for, gets nulls -- never a
 * fabricated band.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-projection-range-wiring-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/nfl-pbp.js'); // side effect: creates nfl_player_week_features, joined by history()
const { buildProjections } = await import('../server/services/projections.js');
const { fitProjectionRangeTable, projectionRangeFor, saveProjectionRangeFit, activateProjectionRangeFit,
  activeProjectionRangeTable } = await import('../server/services/projection-range.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const insertPlayer = (id, name, position, espnId) => run(
  `INSERT INTO players (id, name, position, espn_id, fantasy_relevant) VALUES (?,?,?,?,1)`,
  id, name, position, espnId);

const insertUsage = (playerId, season, week, team, opts = {}) => run(
  `INSERT INTO player_week_usage
   (player_id, season, week, team, opponent, position, targets, receptions, receiving_yards, receiving_tds,
    attempts, passing_yards, passing_tds, interceptions, carries, rushing_yards, rushing_tds)
   VALUES (?,?,?,?, 'OPP', 'WR', ?, ?, ?, ?, 0,0,0,0,0,0,0)`,
  playerId, season, week, team, opts.targets ?? 14, opts.receptions ?? 10, opts.recYds ?? 120, opts.recTd ?? 0.8);

insertPlayer(1, 'Fits The Table', 'WR', 9001);
insertPlayer(2, 'No Fit For This Position', 'TE', 9002);
for (let w = 1; w <= 8; w++) {
  insertUsage(1, 2023, w, 'AAA');
  run(`INSERT INTO player_week_usage
    (player_id, season, week, team, opponent, position, targets, receptions, receiving_yards, receiving_tds,
     attempts, passing_yards, passing_tds, interceptions, carries, rushing_yards, rushing_tds)
     VALUES (?,?,?,?, 'OPP', 'TE', 5, 3, 30, 0.2, 0,0,0,0,0,0,0)`, 2, 2023, w, 'BBB');
}

/** A real fitted WR-only table with a bin wide enough to cover any modest WR ppg. */
function fittedTable() {
  const history = Array.from({ length: 1200 }, (_, i) => ({ pos: 'WR', yhat: i % 100, y: Math.max(0, (i % 100) - 10) }));
  return fitProjectionRangeTable(history);
}

test('with no active fit, buildProjections leaves every range_ field null', () => {
  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(1);
  assert.equal(p.range_lo, null);
  assert.equal(p.range_hi, null);
  assert.equal(p.range_n, null);
  assert.equal(p.range_basis, null);
  assert.equal(p.range_coverage, null);
  assert.equal(p.range_fitted_at, null);
});

test('with an active fit covering the position, buildProjections attaches the real band', () => {
  const id = saveProjectionRangeFit({
    throughSeason: 2022, minHist: 1200, nRows: 1200, coverageOverall: 0.8021,
    coverageByPosition: { WR: { n: 8116, coverage: 0.8053 } }, table: fittedTable()
  });
  activateProjectionRangeFit(id);

  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(1);
  assert.equal(p.position, 'WR');
  // The exact band projectionRangeFor itself would produce for this player's
  // own ppg, against the identical (deterministic) fixture table -- not just
  // "some finite numbers", so this actually pins buildProjections is looking
  // the band up with the right (position, yhat) pair, not a stale or wrong one.
  const expected = projectionRangeFor(fittedTable(), 'WR', p.ppg);
  assert.equal(p.range_lo, +expected.lo.toFixed(2));
  assert.equal(p.range_hi, +expected.hi.toFixed(2));
  assert.equal(p.range_n, expected.n);
  assert.equal(p.range_basis, 'ppg');
  assert.equal(p.range_coverage, 0.8053, 'a position-specific coverage reading beats the overall figure when both exist');
  // Pinned against the active fit's OWN fitted_at, not just "truthy" -- a
  // field swap (e.g. reporting through_season instead) would also be
  // truthy and pass a weaker check.
  assert.equal(p.range_fitted_at, activeProjectionRangeTable().fitted_at);
});

test('the band is looked up against the QBR-adjusted ppg the player is actually served under, not the pre-adjustment structural figure', () => {
  const qbId = 10;
  insertPlayer(qbId, 'Big QBR QB', 'QB', 9010);
  for (let w = 1; w <= 8; w++) {
    run(`INSERT INTO player_week_usage
      (player_id, season, week, team, opponent, position, attempts, passing_yards, passing_tds, interceptions,
       carries, rushing_yards, rushing_tds, targets, receptions, receiving_yards, receiving_tds)
      VALUES (?,?,?,?, 'OPP', 'QB', 32, 260, 1.6, 0.7, 0,0,0,0,0,0,0)`, qbId, 2023, w, 'CCC');
    run(`INSERT INTO nfl_qbr_weekly
      (season,week,team,player_id,name,opponent,qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack,qualified,fetched_at)
      VALUES (?,?,?,?,?,'OPP',85,0,35,0,85,0,1,datetime('now'))`, 2023, w, 'CCC', String(9010), 'Big QBR QB');
  }
  // A QB-only table with a wide, fine-grained yhat range so even a small
  // ppg shift lands in a visibly different bin.
  const qbTable = fitProjectionRangeTable(
    Array.from({ length: 1200 }, (_, i) => ({ pos: 'QB', yhat: i, y: i })));
  const id = saveProjectionRangeFit({ throughSeason: 2022, minHist: 1200, nRows: 1200, table: qbTable });
  activateProjectionRangeFit(id);

  const withoutSignal = buildProjections({
    through: 2023, throughWeek: 8, qbrSignal: { enabled: false, k: 0, center: 53.26, window: 8 }
  }).get(qbId);
  // A deliberately huge k (real QBR_SIGNAL.k is 0.073) forces a large enough
  // adjustment that the two lookups cannot land in the same bin by accident.
  const withSignal = buildProjections({
    through: 2023, throughWeek: 8, qbrSignal: { enabled: true, k: 50, center: 53.26, window: 8 }
  }).get(qbId);

  assert.equal(withoutSignal.qbr_adjustment, 0);
  assert.ok(withSignal.qbr_adjustment > 500, `expected a huge adjustment to force a bin change, got ${withSignal.qbr_adjustment}`);
  assert.notEqual(withSignal.range_lo, withoutSignal.range_lo,
    'the band must move with the ppg the player is actually served under (post-QBR), not the pre-adjustment structural figure');
});

test('with an active fit that never saw this position, range fields stay null rather than borrowing another position\'s band', () => {
  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(2);
  assert.equal(p.position, 'TE');
  assert.equal(p.range_lo, null);
  assert.equal(p.range_hi, null);
  assert.equal(p.range_coverage, null);
});

test('falls back to the fit\'s overall coverage when no position-specific reading was recorded', () => {
  const id = saveProjectionRangeFit({
    throughSeason: 2022, minHist: 1200, nRows: 1200, coverageOverall: 0.79,
    coverageByPosition: null, table: fittedTable()
  });
  activateProjectionRangeFit(id);
  const p = buildProjections({ through: 2023, throughWeek: 8 }).get(1);
  assert.equal(p.range_coverage, 0.79);
});
