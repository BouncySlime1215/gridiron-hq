import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// A temp database, same as every other db-touching test here: this module reads
// through server/db/index.js and must never touch the user's real league file.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-consensus-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db } = await import('../server/db/index.js');
const { resetPreseasonCache } = await import('../server/services/preseason-model.js');
const {
  SOURCE_IDS, HAND_SET_WEIGHTS, PANEL_SEASONS, TEST_SEASONS, FFC_ADP_SOURCE,
  sourceBoards, measureSourceErrors, fitInverseVarianceWeights, consensusOrder,
  consensusWeightsWalkForward, sourceHistoryCoverage, ffcAdpCoverage, __test
} = await import('../server/services/consensus-weights.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ---------------------------------------------------------------- fixture */

const POS_PLAN = [...Array(20).fill('QB'), ...Array(45).fill('RB'),
  ...Array(85).fill('WR'), ...Array(20).fill('TE')];
const TEAMS = Array.from({ length: 32 }, (_, i) => `T${String(i).padStart(2, '0')}`);
const SEASONS = [2021, 2022, 2023, 2024, 2025];

let seed = 424242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/**
 * A miniature two-source world where one source is deliberately NOISIER at one
 * position, so the inverse-variance fit has a real signal to find.
 *
 * FFC's board is the truth-ranking plus noise; at WR that noise is much larger
 * than the expert board's. Everywhere else the two are comparable. A correct
 * inverse-variance fit must therefore push weight AWAY from FFC at WR and leave
 * the other positions near the incumbent split.
 */
function seedDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_player_week_features (
      season INTEGER, week INTEGER, player_id TEXT, player_name TEXT, team TEXT,
      opponent TEXT, position TEXT, features TEXT);
    CREATE TABLE IF NOT EXISTS nfl_historical_adp (
      season INTEGER, source TEXT, player_key TEXT, name TEXT, position TEXT, team TEXT,
      ecr_rank REAL, ecr_std_dev REAL, scrape_date TEXT, fetched_at TEXT);
    CREATE TABLE IF NOT EXISTS nfl_ffopportunity_weekly (
      season INTEGER, week INTEGER, player_gsis_id TEXT, player_name TEXT, team TEXT,
      position TEXT, expected_fantasy_points REAL, actual_fantasy_points REAL);
    CREATE TABLE IF NOT EXISTS nfl_injuries (
      season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, full_name TEXT,
      position TEXT, report_status TEXT);
    CREATE TABLE IF NOT EXISTS nfl_roster_snapshots (
      captured_at TEXT, player_id INTEGER, espn_id INTEGER, gsis_id TEXT,
      player_name TEXT, position TEXT, team TEXT, status TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS nflverse_player_positions (
      gsis_id TEXT PRIMARY KEY, position TEXT, position_group TEXT, ngs_position TEXT,
      birth_date TEXT, rookie_season INTEGER, draft_year INTEGER, draft_round INTEGER,
      draft_pick INTEGER);
    CREATE TABLE IF NOT EXISTS espn_player_market (
      espn_id INTEGER, season INTEGER, adp REAL, ppr_rank INTEGER, season_proj REAL);
  `);

  const players = POS_PLAN.map((position, i) => ({
    rank: i + 1, position, gsis: `00-${String(7000 + i).padStart(7, '0')}`,
    espn_id: 700000 + i, name: `Skill ${i + 1}`, key: `skill ${i + 1}`, team: TEAMS[i % 32]
  }));

  const insPlayer = db.prepare('INSERT INTO players (name, position, espn_id, gsis_id) VALUES (?,?,?,?)');
  // nfl_depth's real schema (server/services/nfl-advanced.js) always exists now that
  // schema creation is centralized (server/migrations/000_legacy_schema.js) — it spells
  // the position column pos_abb, not position.
  const insDepth = db.prepare('INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb) VALUES (?,?,?,?,?,?)');
  const insBio = db.prepare(`INSERT INTO nflverse_player_positions
    (gsis_id, position, birth_date, rookie_season) VALUES (?,?,?,?)`);
  const insWeek = db.prepare(`INSERT INTO nfl_player_week_features
    (season, week, player_id, player_name, team, position, features) VALUES (?,?,?,?,?,?,?)`);
  // nfl_historical_adp's real schema (server/db/schema/core-and-fantasy.js) requires
  // scrape_date/fetched_at NOT NULL and always exists now that schema creation is
  // centralized (server/migrations/000_legacy_schema.js).
  const insAdp = db.prepare(`INSERT INTO nfl_historical_adp
    (season, source, player_key, name, position, team, ecr_rank, ecr_std_dev, scrape_date, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,'2025-01-01','2025-01-01T00:00:00.000Z')`);
  const insFfc = db.prepare(`INSERT INTO nfl_historical_ffc_adp
    (season, source, player_key, name, position, team, adp, adp_stdev, times_drafted,
     window_start, window_end, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const p of players) {
    insPlayer.run(p.name, p.position, p.espn_id, p.gsis);
    insDepth.run(2025, 1, p.team, p.gsis, p.name, p.position);
    insBio.run(p.gsis, p.position, '1996-04-01', 2019);
  }

  for (const season of SEASONS) {
    for (const p of players) {
      // The expert board: truth plus small noise, everywhere.
      const expert = p.rank + (rnd() - 0.5) * 6;
      // FFC: truth plus small noise, EXCEPT at WR where it is much noisier.
      const ffcNoise = p.position === 'WR' ? 60 : 6;
      const ffc = p.rank + (rnd() - 0.5) * ffcNoise;
      insAdp.run(season, 'dynastyprocess_fpecr', p.key, p.name, p.position, p.team, expert, 3);
      insFfc.run(season, FFC_ADP_SOURCE, p.key, p.name, p.position, p.team,
        Math.max(0.1, ffc), 1, 100, `${season}-08-25`, `${season}-09-01`, '2026-01-01');

      const level = 18 - p.rank * 0.07 + (rnd() - 0.5) * 3;
      const games = Math.max(4, Math.min(17, Math.round(17 - rnd() * 5)));
      for (let week = 1; week <= games; week++) {
        const perGame = Math.max(0.5, level + (rnd() - 0.5) * 4);
        insWeek.run(season, week, p.gsis, p.name, p.team, p.position, JSON.stringify({
          receptions: perGame / 3, receiving_yards: perGame * 5, receiving_tds: perGame / 60,
          targets: perGame / 2, carries: p.position === 'RB' ? perGame / 2 : 0,
          air_yards: perGame * 4, pass_attempts: p.position === 'QB' ? 30 : 0,
          passing_yards: p.position === 'QB' ? perGame * 10 : 0
        }));
      }
    }
  }
}
seedDatabase();
resetPreseasonCache();

/* ------------------------------------------------------- the honest finding */

test('the two live sources with no history are reported as unfittable, not silently fitted', () => {
  const coverage = sourceHistoryCoverage();
  const byId = Object.fromEntries(coverage.map(c => [c.source, c]));

  // This is the load-bearing fact behind docs/CONSENSUS_WEIGHTS.md: the source
  // carrying the hand-set 2x multiplier is the one whose error cannot be
  // measured at all.
  assert.equal(byId.espn_adp.live_weight, 2);
  assert.equal(byId.espn_adp.fittable, false);
  assert.equal(byId.espn_adp.historical_seasons, 0);
  assert.match(byId.espn_adp.reason, /overwritten on every sync/);

  assert.equal(byId.sleeper_rank.fittable, false);
  assert.equal(byId.sleeper_rank.historical_seasons, 0);

  assert.equal(byId.ffc_adp.fittable, true);
  assert.equal(byId.ffc_adp.historical_seasons, PANEL_SEASONS.length);
  assert.equal(byId.ffc_adp.reason, null);
});

test('the ingested FFC windows all close before their season starts', () => {
  const coverage = ffcAdpCoverage();
  assert.equal(coverage.length, PANEL_SEASONS.length);
  for (const c of coverage) {
    // A draft window running into the regular season would grade a board on
    // partly-known outcomes.
    assert.ok(c.window_end < `${c.season}-09-04`,
      `${c.season} ADP window must close before kickoff, got ${c.window_end}`);
    assert.ok(c.players > 0);
  }
});

/* ------------------------------------------------------------- the panel */

test('the panel is the intersection of both boards, and unmatched names are counted not guessed', () => {
  const { panel, unmatched, ffc_rows, board_rows } = sourceBoards(2023);
  assert.ok(panel.length > 100);
  assert.equal(unmatched, 0, 'every fixture name is on both boards');
  assert.ok(board_rows >= ffc_rows, 'the expert board is the deeper of the two');

  for (const e of panel) {
    for (const id of SOURCE_IDS) {
      assert.ok(Number.isFinite(e.ranks[id]), `${id} ordinal must exist for every panel row`);
      assert.ok(e.pos_ranks[id] >= 1);
    }
    // Ordinals are recomputed over the shared panel, exactly as computeConsensus
    // re-ranks each source over the players it has.
    assert.ok(e.ranks.expert_rank <= panel.length);
    assert.ok(e.ranks.ffc_adp <= panel.length);
  }
  const seen = new Set(panel.map(e => e.ranks.expert_rank));
  assert.equal(seen.size, panel.length, 'expert ordinals are a dense permutation');
});

test('an FFC name that lands on no board row is dropped and reported, never invented', () => {
  db.prepare(`INSERT INTO nfl_historical_ffc_adp
    (season, source, player_key, name, position, team, adp, adp_stdev, times_drafted,
     window_start, window_end, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(2023, FFC_ADP_SOURCE, 'nobody at all', 'Nobody At All', 'WR', 'T00', 55, 1, 10,
      '2023-08-30', '2023-09-01', '2026-01-01');
  resetPreseasonCache();
  const after = sourceBoards(2023);
  assert.equal(after.unmatched, 1);
  assert.ok(!after.panel.some(e => e.player_key === 'nobody at all'));
  db.prepare(`DELETE FROM nfl_historical_ffc_adp WHERE player_key = 'nobody at all'`).run();
  resetPreseasonCache();
});

/* --------------------------------------------------------------- the fit */

test('measured error is per source AND per position — pooling would hide a source that is bad at one spot', () => {
  const { errors } = measureSourceErrors([2021, 2022]);
  for (const id of SOURCE_IDS) {
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const cell = errors[id].by_position[pos];
      assert.ok(cell.n > 0, `${id}/${pos} must have rows`);
      assert.ok(cell.variance > 0);
      assert.ok(Math.abs(Math.sqrt(cell.variance) - cell.rmse) < 1e-6);
    }
  }
  // The fixture makes FFC much noisier at WR and comparable elsewhere. The
  // measurement has to see that, or the weights downstream mean nothing.
  const wrGap = errors.ffc_adp.by_position.WR.variance - errors.expert_rank.by_position.WR.variance;
  const rbGap = errors.ffc_adp.by_position.RB.variance - errors.expert_rank.by_position.RB.variance;
  assert.ok(wrGap > 0, 'the deliberately noisier WR source must measure as higher variance');
  assert.ok(wrGap > rbGap, 'the WR penalty must exceed the RB one, where both sources are alike');
});

test('weights move toward the lower-variance source, and stay inside the caps', () => {
  const { weights, hand_set_share } = fitInverseVarianceWeights([2021, 2022]);
  assert.ok(Math.abs(hand_set_share.expert_rank - 2 / 3) < 1e-9);

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const w = weights[pos];
    const total = SOURCE_IDS.reduce((s, id) => s + w[id], 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${pos} shares must sum to 1`);
    for (const id of SOURCE_IDS) {
      assert.ok(w[id] >= __test.MIN_SHARE - 1e-9 && w[id] <= __test.MAX_SHARE + 1e-9,
        `${pos}/${id} share ${w[id]} escaped the caps`);
    }
  }
  // WR is where FFC is measurably worse, so WR must give FFC less weight than
  // RB does, where the two sources are comparable.
  assert.ok(weights.WR.ffc_adp < weights.RB.ffc_adp,
    'the noisier source must be trusted less at the position where it is noisier');
});

test('a position with too few training rows is held at the hand-set weights rather than fitted on nothing', () => {
  const { weights } = fitInverseVarianceWeights([2021]);
  const thin = Object.entries(weights).filter(([, w]) => !w.fitted);
  for (const [, w] of thin) {
    assert.match(w.reason, /fewer than \d+ training rows|no measurable variance/);
    assert.ok(Math.abs(w.expert_rank - HAND_SET_WEIGHTS.expert_rank / 3) < 1e-9,
      'an unfittable position falls back to the incumbent split exactly');
  }
});

test('shrinkage keeps a thin fit close to the incumbent and lets a thick one move further', () => {
  const thin = fitInverseVarianceWeights([2021]).weights;
  const thick = fitInverseVarianceWeights([2021, 2022, 2023, 2024]).weights;
  assert.ok(thick.WR.fitted);
  assert.ok(thin.WR.lambda == null || thick.WR.lambda > thin.WR.lambda,
    'more training evidence must buy more authority');
  const hand = 2 / 3;
  if (thin.WR.fitted) {
    assert.ok(Math.abs(thick.WR.expert_rank - hand) >= Math.abs(thin.WR.expert_rank - hand),
      'the thicker fit is allowed to depart further from the hand-set weights');
  }
});

/* ----------------------------------------------------------- the ordering */

test('consensus is a weighted mean of the sources ordinals, and equal weights reduce to a plain average', () => {
  const { panel } = sourceBoards(2024);
  const equal = consensusOrder(panel, () => ({ expert_rank: 0.5, ffc_adp: 0.5 }));
  for (const e of equal.slice(0, 20)) {
    assert.ok(Math.abs(e.consensus - (e.ranks.expert_rank + e.ranks.ffc_adp) / 2) < 1e-9);
  }
  assert.deepEqual(equal.map(e => e.consensus_overall), equal.map((_, i) => i + 1));
  for (let i = 1; i < equal.length; i++) assert.ok(equal[i].consensus >= equal[i - 1].consensus);

  // Weighting one source to zero must reproduce that source's own order.
  const expertOnly = consensusOrder(panel, () => ({ expert_rank: 1, ffc_adp: 0 }));
  const byExpert = [...panel].sort((a, b) => a.ranks.expert_rank - b.ranks.expert_rank);
  assert.deepEqual(expertOnly.map(e => e.player_key), byExpert.map(e => e.player_key));
});

/* -------------------------------------------------------- the walk-forward */

test('the walk-forward never lets a test season into its own training set', () => {
  const out = consensusWeightsWalkForward({ iterations: 200 });
  assert.deepEqual(out.results.map(r => r.test_season), [...TEST_SEASONS]);
  for (const r of out.results) {
    if (r.skipped) continue;
    assert.ok(!r.train_seasons.includes(r.test_season));
    assert.ok(Math.max(...r.train_seasons) < r.test_season);
  }
});

test('the decision reads off the fixed-curve arm and states the >= 2 of 3 bar and the substitution', () => {
  const out = consensusWeightsWalkForward({ iterations: 200 });
  assert.match(out.bar, /fixed-curve/);
  assert.match(out.bar, />= 2 of 3/);
  assert.match(out.substitution, /ESPN and Sleeper have no historical coverage/);
  assert.equal(out.decision,
    out.seasons_significantly_better >= 2 ? 'replace hand-set weights' : 'keep hand-set weights');

  for (const r of out.results) {
    if (r.skipped) continue;
    // Both arms are always reported: the disagreement between them is the
    // finding, so neither may be quietly dropped.
    assert.ok(Number.isFinite(r.hand_set_mae) && Number.isFinite(r.fitted_mae));
    assert.ok(Number.isFinite(r.own_curve.hand_set_mae) && Number.isFinite(r.own_curve.fitted_mae));
    assert.ok(Number.isFinite(r.mean_rank_shift));
    // A claim of improvement and a claim of regression can never both hold.
    assert.ok(!(r.significant_improvement && r.significant_regression));
  }
});

test('board agreement is reported, because a weighting cannot matter more than the boards disagree', () => {
  const out = consensusWeightsWalkForward({ iterations: 200 });
  assert.equal(out.board_agreement.length, PANEL_SEASONS.length);
  for (const b of out.board_agreement) {
    assert.ok(b.source_rank_spearman > -1 && b.source_rank_spearman <= 1);
    assert.ok(b.n > 0);
  }
});
