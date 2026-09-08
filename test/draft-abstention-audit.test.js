import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// A temp database, for the same reason preseason-model.test.js uses one: this
// audit reads the whole 2021-2025 panel through server/db/index.js, and a test
// must never touch (or wait on) the user's real league file.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-abstention-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db } = await import('../server/db/index.js');
const { resetPreseasonCache } = await import('../server/services/preseason-model.js');
const {
  seasonSlotTruth, gradePick, buildAbstentionPanel, fitGate, gateFlags, applyGate,
  clusterTwoSampleDiff, wilson, twoProportion, draftAbstentionAudit,
  REPLACEMENT_SLOT, TIER_BANDS, GATE_FLAGS, MIN_SLICE_SAMPLE
} = await import('../server/services/draft-abstention-audit.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ---------------------------------------------------------------- fixtures */

const POS_PLAN = [...Array(25).fill('QB'), ...Array(60).fill('RB'),
  ...Array(90).fill('WR'), ...Array(25).fill('TE')];
const TEAMS = Array.from({ length: 32 }, (_, i) => `T${String(i).padStart(2, '0')}`);
const SEASONS = [2021, 2022, 2023, 2024, 2025];

let seed = 20260907;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/**
 * A miniature five-season league. Rank predicts production with noise; some
 * players enter the league late so `has_history` and `rookie` actually vary,
 * which is what the gate reads. The football is not realistic and is not meant
 * to be — the point is that every table the panel builder reads is present and
 * shaped correctly, and that the gate's plumbing is exercised end to end.
 */
function seedDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_player_week_features (
      season INTEGER, week INTEGER, player_id TEXT, player_name TEXT, team TEXT,
      opponent TEXT, position TEXT, features TEXT);
    CREATE TABLE IF NOT EXISTS nfl_historical_adp (
      season INTEGER, source TEXT, player_key TEXT, name TEXT, position TEXT, team TEXT,
      ecr_rank REAL, ecr_std_dev REAL, scrape_date TEXT, fetched_at TEXT);
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
    rank: i + 1, position, gsis: `00-${String(9000 + i).padStart(7, '0')}`,
    espn_id: 500000 + i, name: `Player ${i + 1}`, team: TEAMS[i % 32],
    // Every eighth player debuts in 2023, so 2023 has real rookies with no
    // prior usage and later seasons have veterans who do.
    rookieSeason: i % 8 === 0 ? 2023 : 2019
  }));

  const insPlayer = db.prepare('INSERT INTO players (name, position, espn_id, gsis_id) VALUES (?,?,?,?)');
  // nfl_depth's real schema (server/services/nfl-advanced.js) always exists now that
  // schema creation is centralized (server/migrations/000_legacy_schema.js) — it spells
  // the position column pos_abb, not position.
  const insDepth = db.prepare('INSERT INTO nfl_depth (season, week, team, gsis_id, player_name, pos_abb) VALUES (?,?,?,?,?,?)');
  const insBio = db.prepare(`INSERT INTO nflverse_player_positions
    (gsis_id, position, birth_date, rookie_season, draft_year, draft_round, draft_pick) VALUES (?,?,?,?,?,?,?)`);
  const insWeek = db.prepare(`INSERT INTO nfl_player_week_features
    (season, week, player_id, player_name, team, position, features) VALUES (?,?,?,?,?,?,?)`);
  // nfl_historical_adp's real schema (server/db/schema/core-and-fantasy.js) requires
  // scrape_date/fetched_at NOT NULL and always exists now that schema creation is
  // centralized (server/migrations/000_legacy_schema.js).
  const insAdp = db.prepare(`INSERT INTO nfl_historical_adp
    (season, source, player_key, name, position, team, ecr_rank, ecr_std_dev, scrape_date, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,'2025-01-01','2025-01-01T00:00:00.000Z')`);
  // nfl_ffopportunity_weekly's real schema (server/db/schema/core-and-fantasy.js) requires
  // source_release/ingested_at NOT NULL and always exists now that schema creation is
  // centralized (server/migrations/000_legacy_schema.js).
  const insFf = db.prepare(`INSERT INTO nfl_ffopportunity_weekly
    (season, week, player_gsis_id, player_name, team, position, expected_fantasy_points, actual_fantasy_points,
     source_release, ingested_at)
    VALUES (?,?,?,?,?,?,?,?,'test','2025-01-01T00:00:00.000Z')`);

  for (const p of players) {
    insPlayer.run(p.name, p.position, p.espn_id, p.gsis);
    insDepth.run(2025, 1, p.team, p.gsis, p.name, p.position);
    insBio.run(p.gsis, p.position, `199${p.rank % 10}-04-0${(p.rank % 9) + 1}`,
      p.rookieSeason, p.rookieSeason, (p.rank % 7) + 1, p.rank);
  }

  for (const season of SEASONS) {
    for (const p of players) {
      insAdp.run(season, 'dynastyprocess_fpecr', p.name.toLowerCase(), p.name, p.position, p.team,
        p.rank, 2 + (p.rank % 30));
      if (season < p.rookieSeason) continue;
      const level = 18 - p.rank * 0.05 + (rnd() - 0.5) * 6;
      const games = Math.max(3, Math.min(17, Math.round(17 - rnd() * 7)));
      for (let week = 1; week <= games; week++) {
        const perGame = Math.max(0.5, level + (rnd() - 0.5) * 8);
        insWeek.run(season, week, p.gsis, p.name, p.team, p.position, JSON.stringify({
          receptions: perGame / 3, receiving_yards: perGame * 5, receiving_tds: perGame / 60,
          targets: perGame / 2, carries: p.position === 'RB' ? perGame / 2 : 0,
          air_yards: perGame * 4, red_zone_targets: perGame / 20,
          pass_attempts: p.position === 'QB' ? 30 : 0,
          passing_yards: p.position === 'QB' ? perGame * 10 : 0
        }));
        insFf.run(season, week, p.gsis, p.name, p.team, p.position, perGame * 0.9, perGame);
      }
    }
  }
}
seedDatabase();
resetPreseasonCache();

/* ------------------------------------------------------- the outcome panel */

test('replacement level is the Nth-best actual finisher, at the audit\'s 8-team slots', () => {
  const truth = seasonSlotTruth(2024);
  for (const [pos, slot] of Object.entries(REPLACEMENT_SLOT)) {
    const finishers = truth.finishers[pos];
    assert.ok(finishers.length >= slot, `${pos} has fewer than ${slot} finishers in the fixture`);
    // Sorted descending, and the replacement number is exactly that slot's points.
    for (let i = 1; i < finishers.length; i++) assert.ok(finishers[i] <= finishers[i - 1]);
    assert.equal(truth.replacement[pos], finishers[slot - 1]);
  }
});

test('a slot\'s expectation is the finisher at that rank, not the player drafted there', () => {
  const truth = { replacement: { WR: 100 }, finishers: { WR: [300, 250, 200, 150, 120] },
    finishRank: new Map([['g1', 5]]) };
  // Drafted WR2 (slot worth 250 - 100 = 150), actually scored 120 (VORP+ 20).
  const graded = gradePick({
    season: 2024, gsis: 'g1', name: 'X', position: 'WR', team: 'AAA',
    market_rank: 10, pos_rank: 2, rank_std: 5,
    features: { has_history: 1, rookie: 0 }, has_projection: true,
    actual_points: 120, actual_games: 16
  }, truth);
  assert.equal(graded.expected_vorp_plus, 150);
  assert.equal(graded.vorp_plus, 20);
  assert.equal(graded.abs_err, 130);
  assert.equal(graded.hit, false); // finished WR5, drafted WR2
  assert.equal(graded.bust, false); // 5 < 2 + 12, and played 16 games
});

test('VORP+ floors at zero and a DNP is an outcome, not missing data', () => {
  const truth = { replacement: { RB: 160 }, finishers: { RB: [300, 200] }, finishRank: new Map() };
  const g = gradePick({
    season: 2024, gsis: 'gone', name: 'Y', position: 'RB', team: 'BBB',
    market_rank: 30, pos_rank: 12, rank_std: 8,
    features: { has_history: 1, rookie: 0 }, has_projection: true,
    actual_points: 0, actual_games: 0
  }, truth);
  assert.equal(g.vorp_plus, 0);
  assert.equal(g.expected_vorp_plus, 0); // no 12th finisher in this fixture
  assert.equal(g.bust, true);            // 0 games
  assert.equal(g.finish_pos_rank, 9999);
});

test('the panel covers every graded top-150 skill slot in every season', () => {
  const panel = buildAbstentionPanel({ seasons: SEASONS, limit: 150 });
  assert.equal(panel.length, 750);
  for (const season of SEASONS) {
    assert.equal(panel.filter(p => p.season === season).length, 150);
  }
  for (const p of panel) {
    assert.ok(TIER_BANDS.some(b => b.name === p.band));
    assert.ok(p.abs_err >= 0);
  }
});

/* ------------------------------------------------------------------- gate */

test('every gate input is a pre-outcome fact: shuffling outcomes cannot move a flag', () => {
  const gate = { rank_std_cut: { WR: 10 }, band_width: { WR: { early: 0.9, middle: 0.9, late: 0.9 } },
    band_width_cut: 0.5 };
  const base = {
    position: 'WR', pos_rank: 5, rank_std: 20, has_history: false, rookie: true,
    has_projection: false, vorp_plus: 10, expected_vorp_plus: 90, abs_err: 80,
    hit: false, bust: true, points: 40, games: 3, finish_pos_rank: 88
  };
  const before = gateFlags(base, gate);
  // Every outcome field replaced with its opposite. The flags must not move.
  const after = gateFlags({ ...base, vorp_plus: 300, expected_vorp_plus: 0, abs_err: 0,
    hit: true, bust: false, points: 400, games: 17, finish_pos_rank: 1 }, gate);
  assert.deepEqual(after, before);
  assert.deepEqual(before.sort(), ['high_rank_std', 'no_projection', 'thin_history', 'wide_band'].sort());
});

test('thin history folds rookie and no-prior-usage into one flag, so a count of two means two things', () => {
  const gate = { rank_std_cut: { RB: 100 }, band_width: { RB: { early: 0.1, middle: 0.1, late: 0.1 } },
    band_width_cut: 0.5 };
  const rookie = { position: 'RB', pos_rank: 3, rank_std: 4, has_history: false, rookie: true, has_projection: true };
  assert.deepEqual(gateFlags(rookie, gate), ['thin_history']);
  // A rookie alone is one flag, so the default two-flag gate keeps him.
  assert.equal(applyGate(rookie, gate, { minFlags: 2 }).declined, false);
  assert.equal(applyGate(rookie, gate, { minFlags: 1 }).declined, true);
  // Add a second, genuinely different coverage hole and he is declined.
  const alsoUnprojected = { ...rookie, has_projection: false };
  assert.equal(applyGate(alsoUnprojected, gate, { minFlags: 2 }).declined, true);
});

test('flags a veteran with full coverage as nothing at all', () => {
  const gate = { rank_std_cut: { WR: 15 }, band_width: { WR: { early: 0.3, middle: 0.3, late: 0.3 } },
    band_width_cut: 0.6 };
  assert.deepEqual(gateFlags({ position: 'WR', pos_rank: 2, rank_std: 3,
    has_history: true, rookie: false, has_projection: true }, gate), []);
});

test('gate thresholds are fitted walk-forward and never see the season being graded', async () => {
  const { buildSeasonRows } = await import('../server/services/preseason-model.js');
  const early = fitGate([2021, 2022].flatMap(s => buildSeasonRows(s, { limit: 150 })));
  const late = fitGate([2021, 2022, 2023, 2024].flatMap(s => buildSeasonRows(s, { limit: 150 })));
  assert.equal(early.train_n, 300);
  assert.equal(late.train_n, 600);
  // Refitting on the same training seasons is deterministic: a threshold that
  // moved without new training data would mean something leaked in.
  const again = fitGate([2021, 2022].flatMap(s => buildSeasonRows(s, { limit: 150 })));
  assert.deepEqual(again.rank_std_cut, early.rank_std_cut);
  assert.deepEqual(again.band_width, early.band_width);
  for (const cut of Object.values(early.rank_std_cut)) assert.ok(cut === null || cut > 0);
});

test('a position with fewer than the slice floor of training rows gets no rank_std cut', () => {
  const thin = Array.from({ length: MIN_SLICE_SAMPLE - 1 }, (_, i) => ({
    position: 'TE', pos_rank: i + 1, rank_std: i, actual_points: 100, actual_games: 16,
    actual_ppg: 6.25, vector: [], features: {}, market_rank: i + 1, season: 2022
  }));
  const gate = fitGate(thin);
  assert.equal(gate.rank_std_cut.TE, null);
  // A null cut must never fire the flag — "we don't know the norm" is not
  // "this player is unusual".
  assert.ok(!gateFlags({ position: 'TE', pos_rank: 1, rank_std: 999, has_history: true,
    rookie: false, has_projection: true }, { ...gate, band_width_cut: 99 }).includes('high_rank_std'));
});

/* ------------------------------------------------------------- statistics */

test('wilson stays inside [0,1] and widens as n shrinks', () => {
  const wide = wilson(5, 10), narrow = wilson(500, 1000);
  assert.ok(wide[0] >= 0 && wide[1] <= 1);
  assert.ok((wide[1] - wide[0]) > (narrow[1] - narrow[0]));
  assert.equal(wilson(0, 0), null);
});

test('two-proportion reproduces a known z and refuses an empty arm', () => {
  const t = twoProportion(60, 100, 40, 100);
  assert.ok(Math.abs(t.z - 2.8284) < 0.01, `z was ${t.z}`);
  assert.equal(t.significant, true);
  assert.equal(twoProportion(1, 0, 1, 10), null);
  // Identical rates are never a finding.
  assert.equal(twoProportion(50, 100, 50, 100).difference, 0);
});

test('the two-sample cluster bootstrap finds a real gap and refuses to invent one', () => {
  const groups = i => `g${i % 20}`;
  const a = Array.from({ length: 200 }, (_, i) => 10 + Math.sin(i) * 2);
  const b = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 2);
  const real = clusterTwoSampleDiff(a, b,
    { groupsA: a.map((_, i) => groups(i)), groupsB: b.map((_, i) => groups(i)) });
  assert.equal(real.significant, true);
  assert.ok(real.mean_diff > 8 && real.mean_diff < 12);

  const noiseA = Array.from({ length: 200 }, (_, i) => Math.sin(i * 1.7) * 5);
  const noiseB = Array.from({ length: 200 }, (_, i) => Math.cos(i * 1.3) * 5);
  const nothing = clusterTwoSampleDiff(noiseA, noiseB,
    { groupsA: noiseA.map((_, i) => groups(i)), groupsB: noiseB.map((_, i) => groups(i)) });
  assert.equal(nothing.significant, false);
  assert.ok(nothing.ci90[0] <= 0 && nothing.ci90[1] >= 0);
});

test('the cluster bootstrap refuses a sample too small to read, rather than returning a number', () => {
  const r = clusterTwoSampleDiff([1, 2, 3], [4, 5, 6], {});
  assert.ok(r.error);
  assert.equal(r.significant, undefined);
});

test('clustering widens the interval relative to resampling individuals', () => {
  // 200 values in 10 perfectly-correlated blocks: the true effective sample
  // size is 10, and a per-unit resample would claim 200.
  const blocked = Array.from({ length: 200 }, (_, i) => (i % 10) * 3);
  const flat = Array.from({ length: 200 }, () => 0);
  const clustered = clusterTwoSampleDiff(blocked, flat,
    { groupsA: blocked.map((_, i) => `b${i % 10}`), groupsB: flat.map((_, i) => `c${i % 10}`) });
  const unclustered = clusterTwoSampleDiff(blocked, flat, {});
  const width = r => r.ci90[1] - r.ci90[0];
  assert.ok(width(clustered) > width(unclustered));
});

/* ----------------------------------------------------------- the verdict */

test('the audit reports both sets and never grades only the kept one', () => {
  const a = draftAbstentionAudit({ seasons: SEASONS, heldOut: [2024, 2025], iterations: 400 });
  assert.equal(a.panel_n, 750);
  for (const s of a.per_season) {
    assert.ok(s.kept.n > 0 && s.declined.n > 0, `${s.season} produced an empty arm`);
    assert.equal(s.kept.n + s.declined.n, 150);
    // The declined set's own record is always present — the whole point of
    // nfl-abstention-audit.js is that a refusal is a graded counterfactual.
    assert.ok(Number.isFinite(s.declined.hit_rate));
    assert.ok(Array.isArray(s.declined.hit_rate_95));
    assert.equal(s.by_flag.length, GATE_FLAGS.length);
    assert.ok(s.train_seasons.every(t => t < s.season));
  }
  assert.ok(a.pooled.kept.n + a.pooled.declined.n === 300);
});

test('the bar is >= 2 of 3 held-out seasons and a pooled result cannot substitute for it', () => {
  const a = draftAbstentionAudit({ seasons: SEASONS, heldOut: [2023, 2024, 2025], iterations: 400 });
  assert.match(a.bar, /2 of 3/);
  assert.equal(a.passes, a.seasons_separating.length >= 2);
  // An inverted season is reported as inverted, never quietly counted as a pass.
  for (const s of a.seasons_inverted) assert.ok(!a.seasons_separating.includes(s));
  assert.match(a.note, /CANNOT/);
});

test('a gate that declines nothing produces no separation claim, not a division by zero', () => {
  // minFlags above the number of flags that exist can never decline anyone.
  const a = draftAbstentionAudit({ seasons: SEASONS, heldOut: [2025],
    minFlags: GATE_FLAGS.length + 1, iterations: 200 });
  const s = a.per_season[0];
  assert.equal(s.declined.n, 0);
  assert.ok(s.separation.error);
  assert.equal(a.passes, false);
});

/**
 * The shipped finding, pinned.
 *
 * On the real 2021-2025 panel this gate separated nothing: the kept-vs-declined
 * interval straddled zero in all three held-out seasons, and the declined picks
 * hit MORE often than the kept ones in every one of them (see
 * docs/DRAFT_BOARD_ABSTENTION.md). That is a result, and it is the reason the
 * field was never wired into the board.
 *
 * This test does not re-derive that number from the fixture — the fixture is
 * synthetic football. It pins the thing that must not silently change: the
 * verdict string is decided by the >= 2-of-3 rule and by nothing else, so
 * nobody can later relax the gate into a pass without the bar moving in plain
 * sight.
 */
test('the verdict is a function of the bar, not of the author\'s hopes', () => {
  const a = draftAbstentionAudit({ seasons: SEASONS, heldOut: [2023, 2024, 2025], iterations: 400 });
  if (a.passes) {
    assert.ok(a.seasons_separating.length >= 2);
    assert.match(a.verdict, /GATE SEPARATES/);
  } else if (a.seasons_inverted.length) {
    assert.match(a.verdict, /ANTI-SELECTIVE|NO SEPARATION/);
  } else {
    assert.match(a.verdict, /NO SEPARATION/);
    assert.match(a.verdict, /Do not ship/);
  }
});
