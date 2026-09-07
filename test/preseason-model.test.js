import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// A temp database, exactly like every other db-touching test here: the preseason
// model reads through server/db/index.js, and pointing that at the user's real
// league file from a test would both be slow and mutate it.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-preseason-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db } = await import('../server/db/index.js');
const {
  buildFeatureRow, FEATURE_NAMES, fitMarketCurve, marketCurvePoints, marketCurveGames,
  fitPreseasonModel, componentsFor, blendPoints, driversFor, spreadFor, SHIPPED_BLEND,
  ridgeFit, ridgePredict, spearman, buildSeasonRows, preseasonProjections,
  preseasonProjection, resetPreseasonCache, seasonTotals
} = await import('../server/services/preseason-model.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ---------------------------------------------------------------- fixtures */

const POS_PLAN = [...Array(25).fill('QB'), ...Array(50).fill('RB'),
  ...Array(100).fill('WR'), ...Array(25).fill('TE')];
const TEAMS = Array.from({ length: 32 }, (_, i) => `T${String(i).padStart(2, '0')}`);
const SEASONS = [2021, 2022, 2023, 2024, 2025];

// Deterministic pseudo-random, so a failure is always the same failure.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/**
 * A miniature league: 200 ranked players, five completed seasons of weekly stat
 * lines, and a 2026 board. Rank predicts production with noise, which is all the
 * pipeline needs to have something to fit — the point of this fixture is that every
 * table the service reads is present and shaped correctly, not that the football is
 * realistic.
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
    CREATE TABLE IF NOT EXISTS nfl_depth (
      season INTEGER, week INTEGER, team TEXT, gsis_id TEXT, player_name TEXT, position TEXT);
    CREATE TABLE IF NOT EXISTS nflverse_player_positions (
      gsis_id TEXT PRIMARY KEY, position TEXT, position_group TEXT, ngs_position TEXT,
      birth_date TEXT, rookie_season INTEGER, draft_year INTEGER, draft_round INTEGER,
      draft_pick INTEGER);
    CREATE TABLE IF NOT EXISTS espn_player_market (
      espn_id INTEGER, season INTEGER, adp REAL, ppr_rank INTEGER, season_proj REAL);
  `);

  const players = POS_PLAN.map((position, i) => ({
    rank: i + 1, position, gsis: `00-${String(9000 + i).padStart(7, '0')}`,
    espn_id: 500000 + i, name: `Player ${i + 1}`, team: TEAMS[i % 32]
  }));

  const insPlayer = db.prepare('INSERT INTO players (name, position, espn_id, gsis_id) VALUES (?,?,?,?)');
  const insDepth = db.prepare('INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, position) VALUES (?,?,?,?,?,?)');
  const insBio = db.prepare(`INSERT INTO nflverse_player_positions
    (gsis_id, position, birth_date, rookie_season, draft_year, draft_round, draft_pick) VALUES (?,?,?,?,?,?,?)`);
  const insWeek = db.prepare(`INSERT INTO nfl_player_week_features
    (season, week, player_id, player_name, team, position, features) VALUES (?,?,?,?,?,?,?)`);
  const insAdp = db.prepare(`INSERT INTO nfl_historical_adp
    (season, source, player_key, name, position, team, ecr_rank, ecr_std_dev) VALUES (?,?,?,?,?,?,?,?)`);
  const insMarket = db.prepare('INSERT INTO espn_player_market (espn_id, season, adp, ppr_rank, season_proj) VALUES (?,?,?,?,?)');
  const insFf = db.prepare(`INSERT INTO nfl_ffopportunity_weekly
    (season, week, player_gsis_id, player_name, team, position, expected_fantasy_points, actual_fantasy_points)
    VALUES (?,?,?,?,?,?,?,?)`);

  for (const p of players) {
    insPlayer.run(p.name, p.position, p.espn_id, p.gsis);
    insDepth.run(2025, 1, p.team, p.gsis, p.name, p.position);
    insBio.run(p.gsis, p.position, `199${p.rank % 10}-04-0${(p.rank % 9) + 1}`,
      2018 + (p.rank % 5), 2018 + (p.rank % 5), (p.rank % 7) + 1, p.rank);
    insMarket.run(p.espn_id, 2026, p.rank, p.rank, 300 - p.rank);
  }

  for (const season of SEASONS) {
    for (const p of players) {
      insAdp.run(season, 'dynastyprocess_fpecr', p.name.toLowerCase(), p.name, p.position, p.team,
        p.rank, 3 + (p.rank % 5));
      // Better-ranked players score more and play more, with noise on both.
      const level = 18 - p.rank * 0.06 + (rnd() - 0.5) * 5;
      const games = Math.max(3, Math.min(17, Math.round(17 - rnd() * 6)));
      for (let week = 1; week <= games; week++) {
        const perGame = Math.max(0.5, level + (rnd() - 0.5) * 8);
        const features = {
          receptions: perGame / 3, receiving_yards: perGame * 5, receiving_tds: perGame / 60,
          targets: perGame / 2, carries: p.position === 'RB' ? perGame / 2 : 0,
          air_yards: perGame * 4, red_zone_targets: perGame / 20,
          pass_attempts: p.position === 'QB' ? 30 : 0,
          passing_yards: p.position === 'QB' ? perGame * 10 : 0
        };
        insWeek.run(season, week, p.gsis, p.name, p.team, p.position, JSON.stringify(features));
        insFf.run(season, week, p.gsis, p.name, p.team, p.position, perGame * 0.9, perGame);
      }
    }
  }
}
seedDatabase();
resetPreseasonCache();

/* ---------------------------------------------------------------- features */

test('feature builder reads prior seasons only, and encodes what it claims to', () => {
  const priorSeason = {
    ppg: 14, games: 12, points: 168, targets: 120, carries: 30, air_yards: 900,
    target_share: 0.24, carry_share: 0.08, attempt_share: 0, receptions: 80, name: 'X'
  };
  const ctx = {
    season: 2026,
    priorTotals: [
      new Map([['g1', priorSeason]]),
      new Map([['g1', { ...priorSeason, ppg: 10, games: 16 }]]),
      new Map()
    ],
    ffopp: new Map([['g1', { xp: 100, ap: 130, w: 12 }]]),
    bio: new Map([['g1', { birth_date: '2000-01-01', rookie_season: 2022, draft_round: 1, draft_pick: 5 }]]),
    projections: new Map()
  };
  const entry = { gsis: 'g1', name: 'X', position: 'WR', market_rank: 20, pos_rank: 9, rank_std: 4 };
  const row = buildFeatureRow(entry, ctx);
  const f = row.features;

  assert.equal(f.ppg_1, 14);
  assert.equal(f.ppg_2, 10);
  assert.equal(f.ppg_3, 0, 'a missing third season is zero, not undefined');
  assert.equal(f.games_1, 12);
  assert.equal(f.target_share_1, 0.24);
  assert.equal(f.targets_pg_1, 10);
  assert.equal(f.air_yards_pg_1, 75);
  assert.equal(f.has_history, 1);
  assert.equal(f.rookie, 0);
  assert.equal(f.is_WR, 1);
  assert.equal(f.is_RB, 0);
  // 130 actual vs 100 expected over 12 weeks = +2.5 pts/game of touchdown luck.
  assert.equal(f.td_luck_pg_1, 2.5);
  // Recency weighting: last season carries more than the one before it, so the
  // blended level must sit above the straight average of 14 and 10.
  assert.ok(f.ppg_w > 12 && f.ppg_w < 14, `ppg_w was ${f.ppg_w}`);
  assert.ok(f.age > 26 && f.age < 27, `age was ${f.age}`);
  assert.equal(row.vector.length, FEATURE_NAMES.length);
  assert.ok(row.vector.every(Number.isFinite), 'no NaN may reach a model');
  assert.equal(row.has_projection, false);
});

test('an unknown player produces a defined vector rather than holes', () => {
  const row = buildFeatureRow(
    { gsis: null, name: 'Rookie', position: 'RB', market_rank: 150, pos_rank: 44, rank_std: null },
    { season: 2026, priorTotals: [new Map(), new Map(), new Map()], ffopp: new Map(), bio: new Map(), projections: new Map() });
  assert.ok(row.vector.every(Number.isFinite));
  assert.equal(row.features.has_history, 0);
  assert.equal(row.features.td_luck_pg_1, 0);
});

test('the td-luck term is capped so one freak season cannot dominate a linear fit', () => {
  const row = buildFeatureRow({ gsis: 'g', name: 'X', position: 'TE', market_rank: 5, pos_rank: 2 }, {
    season: 2026, priorTotals: [new Map(), new Map(), new Map()],
    ffopp: new Map([['g', { xp: 10, ap: 500, w: 10 }]]), bio: new Map(), projections: new Map()
  });
  assert.equal(row.features.td_luck_pg_1, 6);
});

/* ------------------------------------------------------------- market curve */

test('the market curve is monotone in rank and unbiased at the top slot', () => {
  // Truth is exactly linear in rank. A local AVERAGE would drag the #1 slot down
  // (every neighbour is worse); a local LINEAR fit must not.
  const rowsIn = [];
  for (let season = 2022; season <= 2024; season++) {
    for (let rank = 1; rank <= 60; rank++) {
      rowsIn.push({ position: 'WR', pos_rank: rank, actual_points: 300 - 3 * rank, actual_games: 15 });
    }
  }
  const curves = fitMarketCurve(rowsIn);
  const top = marketCurvePoints(curves, 'WR', 1);
  assert.ok(Math.abs(top - 297) < 6, `rank-1 slot should be ~297, was ${top}`);
  for (let rank = 2; rank <= 60; rank++) {
    assert.ok(marketCurvePoints(curves, 'WR', rank) <= marketCurvePoints(curves, 'WR', rank - 1) + 1e-9,
      `curve rose from rank ${rank - 1} to ${rank}`);
  }
  assert.ok(Math.abs(marketCurveGames(curves, 'WR', 1) - 15) < 1e-6);
  assert.equal(marketCurvePoints(curves, 'QB', 1), null, 'a position never seen has no curve');
});

test('the curve is the average outcome at a rank, not the outcome of that finish', () => {
  // Two players per slot every season: one hits, one busts. The honest slot value is
  // the average of the two, which is exactly the mean-reversion trap this guards.
  const rowsIn = [];
  for (let season = 2022; season <= 2024; season++) {
    for (let rank = 1; rank <= 40; rank++) {
      rowsIn.push({ position: 'RB', pos_rank: rank, actual_points: 300, actual_games: 17 });
      rowsIn.push({ position: 'RB', pos_rank: rank, actual_points: 100, actual_games: 8 });
    }
  }
  const curves = fitMarketCurve(rowsIn);
  assert.ok(Math.abs(marketCurvePoints(curves, 'RB', 10) - 200) < 5);
  assert.ok(Math.abs(marketCurveGames(curves, 'RB', 10) - 12.5) < 0.5);
});

/* ---------------------------------------------------------------- the model */

test('ridge recovers a linear signal and is shrunk toward the mean', () => {
  const X = [], y = [];
  for (let i = 0; i < 400; i++) {
    const a = (i % 20) / 5, b = ((i * 7) % 13) / 4;
    X.push([a, b, 1]); y.push(3 * a - 2 * b + 5);
  }
  const fit = ridgeFit(X, y, { lambda: 0.001 });
  assert.ok(Math.abs(ridgePredict(fit, [2, 1, 1]) - 9) < 0.3);
  const shrunk = ridgeFit(X, y, { lambda: 1e6 });
  const grand = y.reduce((s, v) => s + v, 0) / y.length;
  assert.ok(Math.abs(ridgePredict(shrunk, [4, 0, 1]) - grand) < 0.5, 'a huge penalty must collapse to the mean');
});

test('more expected games means more points, holding the per-game rate fixed', () => {
  // The model component is ppg x games by construction; this pins that down against a
  // hand-built fit so a refactor cannot quietly invert it.
  const zero = new Array(FEATURE_NAMES.length).fill(0);
  const model = {
    curves: { WR: { points: [200, 190], games: [15, 15] } },
    ppgModel: { beta: zero, mu: zero, sd: zero.map(() => 1), intercept: 12 },
    gamesModel: { beta: zero, mu: zero, sd: zero.map(() => 1), intercept: 8 },
    blend: { ...SHIPPED_BLEND }, spread: {}
  };
  const row = { position: 'WR', pos_rank: 1, market_points: null, has_projection: false,
    features: {}, vector: zero };
  const low = componentsFor(model, row);
  model.gamesModel.intercept = 16;
  const high = componentsFor(model, row);
  assert.equal(low.ppg, high.ppg);
  assert.ok(high.model > low.model, 'doubling expected games must raise the model component');
  assert.equal(high.model, 12 * 16);
  // Expected games in the shipped path comes from the curve, not the head.
  assert.equal(high.games, 15);
});

test('the shipped blend is the market curve alone — the learned heads were declined', () => {
  assert.deepEqual(SHIPPED_BLEND, { market: 1, structural: 0, model: 0 });
  const c = { market: 210, structural: 999, model: 999 };
  assert.equal(blendPoints({ blend: SHIPPED_BLEND }, c), 210);
});

/* ------------------------------------------------------- end to end, on data */

test('season rows carry both the features and the realized target', () => {
  const built = buildSeasonRows(2025, { limit: 50 });
  assert.equal(built.length, 50);
  const first = built[0];
  assert.equal(first.market_rank, 1);
  assert.ok(first.gsis, 'the ECR name join must resolve');
  assert.ok(first.actual_points > 0);
  assert.ok(first.actual_games > 0);
  assert.ok(built.every(r => r.vector.every(Number.isFinite)));
  // Rank one really is better than rank fifty in the fixture, so the join is not
  // scrambling players onto each other's rows.
  assert.ok(spearman(built.map(r => -r.market_rank), built.map(r => r.actual_points)) > 0.4);
});

test('a fit on prior seasons predicts a held-out season better than last year alone', () => {
  const train = [2022, 2023, 2024].flatMap(s => buildSeasonRows(s, { limit: 200 }));
  const model = fitPreseasonModel(train);
  const testRows = buildSeasonRows(2025, { limit: 200 });
  const truth = testRows.map(r => r.actual_points);
  const curve = testRows.map(r => blendPoints(model, componentsFor(model, r)));
  const priorYear = testRows.map(r => r.raw.s1?.points ?? 0);
  assert.ok(spearman(curve, truth) > spearman(priorYear, truth),
    'the fitted slot curve must beat raw prior-year points on the fixture');
  assert.ok(spreadFor(model, 'WR', 1).p20 < 1 && spreadFor(model, 'WR', 1).p80 > 1,
    'the interval must straddle the point estimate');
  assert.ok(spreadFor(model, 'WR', 80).p80 >= spreadFor(model, 'WR', 1).p80,
    'late picks are relatively more uncertain than early ones');
});

test('drivers are concrete, bounded, and tied to real feature values', () => {
  const train = [2022, 2023, 2024].flatMap(s => buildSeasonRows(s, { limit: 200 }));
  const model = fitPreseasonModel(train);
  const row = buildSeasonRows(2025, { limit: 200 }).find(r => r.raw.s1?.target_share > 0.05);
  const c = componentsFor(model, row);
  const drivers = driversFor(model, row, {
    points: blendPoints(model, c), expected_games: c.games,
    components: { market: c.market, structural: c.structural, model: c.model }
  });
  assert.ok(drivers.length >= 1 && drivers.length <= 5);
  assert.ok(drivers.every(d => typeof d === 'string' && d.length > 0 && d.length < 200));
  assert.ok(drivers.some(d => d.includes(`${row.position}${row.pos_rank}`)),
    'the board slot is always stated');
});

test('preseasonProjections(2026) returns a usable board with finite numbers and reasons', () => {
  const board = preseasonProjections(2026);
  assert.ok(board.size > 150, `expected >150 players, got ${board.size}`);
  for (const p of board.values()) {
    for (const field of ['points', 'ppg', 'expected_games', 'p20', 'p80']) {
      assert.ok(Number.isFinite(p[field]), `${p.name}.${field} was ${p[field]}`);
    }
    assert.ok(p.points >= 0);
    assert.ok(p.expected_games >= 4 && p.expected_games <= 17);
    assert.ok(p.p20 <= p.points && p.p80 >= p.points, `${p.name} interval excludes its own estimate`);
    assert.ok(Array.isArray(p.drivers) && p.drivers.length >= 1 && p.drivers.length <= 5);
    for (const key of ['market', 'structural', 'model']) {
      assert.ok(Number.isFinite(p.components[key]), `${p.name} component ${key}`);
    }
  }
  // Within a position the shipped number is the slot curve, which is monotone.
  const wrs = [...board.values()].filter(p => p.position === 'WR').sort((a, b) => a.pos_rank - b.pos_rank);
  for (let i = 1; i < wrs.length; i++) {
    assert.ok(wrs[i].points <= wrs[i - 1].points + 1e-6,
      `WR${wrs[i].pos_rank} projected above WR${wrs[i - 1].pos_rank}`);
  }
});

test('a player can be looked up by gsis, players.id or espn_id', () => {
  const board = preseasonProjections(2026);
  const sample = [...board.values()][0];
  assert.equal(preseasonProjection(sample.gsis_id, 2026)?.name, sample.name);
  const ids = db.prepare('SELECT id, espn_id FROM players WHERE gsis_id = ?').get(sample.gsis_id);
  assert.equal(preseasonProjection(ids.id, 2026)?.name, sample.name);
  assert.equal(preseasonProjection(ids.espn_id, 2026)?.name, sample.name);
  assert.equal(preseasonProjection('no-such-player', 2026), null);
  assert.equal(preseasonProjection(null), null);
});

test('season totals are rebuilt with PPR weights and never from player_week_usage', () => {
  const totals = seasonTotals(2025).players;
  const [gsis] = [...totals.keys()];
  const t = totals.get(gsis);
  const recomputed = db.prepare(
    'SELECT features FROM nfl_player_week_features WHERE season = 2025 AND player_id = ?').all(gsis)
    .reduce((sum, r) => {
      const f = JSON.parse(r.features);
      return sum + f.passing_yards * 0.04 + f.receptions + f.receiving_yards * 0.1
        + f.receiving_tds * 6 + (f.carries ? 0 : 0);
    }, 0);
  assert.ok(Math.abs(t.points - recomputed) < 0.01, `${t.points} vs ${recomputed}`);
  assert.ok(t.games > 0 && Math.abs(t.ppg - t.points / t.games) < 1e-9);
});
