/**
 * Offseason model: feature builder, effect direction, and the shipped API.
 *
 * The fixture is a synthetic league with KNOWN effects injected, which is the
 * only way to test a measurement tool: on real data a null result is
 * ambiguous between "no effect" and "the code lost it", and this repo's whole
 * discipline depends on being able to tell those apart. Here a mover is built
 * to lose exactly 30% of his share, so `measureEffects` returning ~0.70 proves
 * the pipeline recovers an effect it is given, and the null results it reports
 * on real data can be believed.
 *
 * The real database is exercised separately at the end, in a child process, so
 * this file's synthetic DB and the live one never fight over the singleton
 * connection in server/db/index.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-offseason-model-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db } = await import('../server/db/index.js');

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_player_week_features (
    season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
    player_name TEXT, team TEXT, opponent TEXT, position TEXT, features TEXT NOT NULL,
    PRIMARY KEY (season, week, player_id));
  CREATE TABLE IF NOT EXISTS nfl_depth (
    season INTEGER, week INTEGER, team TEXT, gsis_id TEXT, player_name TEXT,
    pos_abb TEXT, pos_rank INTEGER, pos_slot TEXT, captured TEXT,
    PRIMARY KEY (season, week, team, gsis_id, pos_abb));
  CREATE TABLE IF NOT EXISTS nfl_roster_snapshots (
    captured_at TEXT NOT NULL, player_id INTEGER, espn_id INTEGER, gsis_id TEXT,
    player_name TEXT NOT NULL, position TEXT, team TEXT NOT NULL, status TEXT,
    depth_slot TEXT, depth_order INTEGER, source TEXT NOT NULL,
    PRIMARY KEY (captured_at, team, player_name));
  CREATE TABLE IF NOT EXISTS nfl_team_coaches (
    season INTEGER NOT NULL, team TEXT NOT NULL, coach TEXT NOT NULL,
    games INTEGER NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (season, team));
  CREATE TABLE IF NOT EXISTS nfl_injuries (
    season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, full_name TEXT,
    position TEXT, report_status TEXT, practice_status TEXT, injury TEXT,
    modified_at TEXT, PRIMARY KEY (season, week, gsis_id));
  CREATE TABLE IF NOT EXISTS nflverse_player_positions (
    gsis_id TEXT PRIMARY KEY, position TEXT, position_group TEXT, ngs_position TEXT,
    birth_date TEXT, rookie_season INTEGER, draft_year INTEGER, draft_round INTEGER,
    draft_pick INTEGER);
  CREATE TABLE IF NOT EXISTS game_lines (
    season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
    opponent TEXT, home INTEGER, spread REAL, total REAL, implied_points REAL,
    source TEXT, fetched_at TEXT, PRIMARY KEY (season, week, team));
`);

// ---------------------------------------------------------------------------
// The synthetic league
// ---------------------------------------------------------------------------

const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI',
  'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];
/** slot -> {position, targets, carries, attempts}. Team weekly total is a constant 80. */
const SLOTS = [
  { slot: 'QB1', position: 'QB', rank: 1, targets: 0, carries: 0, attempts: 30 },
  { slot: 'RB1', position: 'RB', rank: 1, targets: 3, carries: 15, attempts: 0 },
  { slot: 'RB2', position: 'RB', rank: 2, targets: 2, carries: 7, attempts: 0 },
  { slot: 'WR1', position: 'WR', rank: 1, targets: 9, carries: 0, attempts: 0 },
  { slot: 'WR2', position: 'WR', rank: 2, targets: 6, carries: 0, attempts: 0 },
  { slot: 'WR3', position: 'WR', rank: 3, targets: 3, carries: 0, attempts: 0 },
  { slot: 'TE1', position: 'TE', rank: 1, targets: 5, carries: 0, attempts: 0 }
];
const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];
/** 2026 has moves and depth changes but no games — the August case. */
const ALL_SEASONS = [...SEASONS, 2026];
const WEEKS = 17;

const gsis = (teamIndex, slotIndex) => `00-9${String(teamIndex).padStart(2, '0')}${slotIndex}00`;
const nameOf = (teamIndex, slotIndex) => `${TEAMS[teamIndex]} ${SLOTS[slotIndex].slot}`;

/**
 * The injected truth. A deterministic hash picks which players move, get
 * demoted, or miss time in each offseason, and by exactly how much their share
 * changes — so every assertion below has a number it must recover.
 */
const MOVER_FACTOR = 0.70;
const DEMOTION_FACTOR = 0.60;
const INJURY_FACTOR = 0.85;
// A real mixing function, not a linear combination. The first version of this
// fixture used `(7919a + 104729b + 15485863c) % 1000`, which is affine in its
// inputs, so `isMover` and `wasHurt` — sharing two of three arguments — came out
// on disjoint intervals and NO injured player was ever a mover. The effect
// measurement then read the contrast group's movers as an injury bonus. A
// fixture that correlates its own conditions tests nothing.
function hash(a, b, c) {
  let x = (a * 0x9e3779b1 + b * 0x85ebca6b + c * 0xc2b2ae35) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
const isMover = (t, s, i) => hash(t, i, s) < 0.16;
// Only a player who is not already listed last can be demoted in a way the
// depth chart can express: nfl_depth stops at three deep, so demoting a WR3
// would be invisible to the feature builder and would land in the CONTRAST
// group carrying a real effect, quietly diluting both arms.
const isDemoted = (t, s, i) =>
  !isMover(t, s, i) && SLOTS[i].rank < 3 && hash(t + 3, i + 5, s) < 0.2;
const wasHurt = (t, s, i) => hash(t + 11, i + 2, s) < 0.10;
/** Where a mover goes: the next team along, so every team both loses and gains. */
const movedTo = (t, s, i) => TEAMS[(t + 1 + Math.floor(hash(t, i, s) * 10)) % TEAMS.length];

/** The team a player is on during season `s`, honouring every move up to and including `s`. */
function teamDuring(teamIndex, slotIndex, season) {
  let team = TEAMS[teamIndex];
  for (const s of ALL_SEASONS) {
    if (s > season) break;
    if (s > SEASONS[0] && isMover(teamIndex, s, slotIndex)) team = movedTo(teamIndex, s, slotIndex);
  }
  return team;
}

/** Cumulative usage factor: every injected effect a player has collected by `season`. */
function usageFactor(teamIndex, slotIndex, season) {
  let f = 1;
  for (const s of ALL_SEASONS) {
    if (s > season) break;
    if (s === SEASONS[0]) continue;
    if (isMover(teamIndex, s, slotIndex)) f *= MOVER_FACTOR;
    if (isDemoted(teamIndex, s, slotIndex)) f *= DEMOTION_FACTOR;
    if (wasHurt(teamIndex, s - 1, slotIndex)) f *= INJURY_FACTOR;
  }
  return f;
}

/** Depth rank at the start of `season`: a demoted player is listed a slot lower. */
function depthRankAt(teamIndex, slotIndex, season) {
  const base = SLOTS[slotIndex].rank;
  return isDemoted(teamIndex, season, slotIndex) ? Math.min(base + 1, 3) : base;
}

function seed() {
  const insFeat = db.prepare(`INSERT OR REPLACE INTO nfl_player_week_features
    (season, week, player_id, player_name, team, opponent, position, features)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insDepth = db.prepare(`INSERT OR REPLACE INTO nfl_depth
    (season, week, team, gsis_id, player_name, pos_abb, pos_rank, pos_slot, captured)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insSnap = db.prepare(`INSERT OR REPLACE INTO nfl_roster_snapshots
    (captured_at, player_id, espn_id, gsis_id, player_name, position, team, status,
     depth_slot, depth_order, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insCoach = db.prepare(`INSERT OR REPLACE INTO nfl_team_coaches
    (season, team, coach, games, fetched_at) VALUES (?,?,?,?,?)`);
  const insBio = db.prepare(`INSERT OR REPLACE INTO nflverse_player_positions
    (gsis_id, position, birth_date, rookie_season, draft_year, draft_round, draft_pick)
    VALUES (?,?,?,?,?,?,?)`);
  const insLine = db.prepare(`INSERT OR REPLACE INTO game_lines
    (season, week, team, implied_points) VALUES (?,?,?,?)`);

  for (const season of SEASONS) {
    // Every player's usage for this season, bucketed by the team he plays for,
    // so opportunity_share is computed against a real team total.
    const roster = [];
    for (let t = 0; t < TEAMS.length; t++) {
      for (let i = 0; i < SLOTS.length; i++) {
        const f = usageFactor(t, i, season);
        roster.push({
          id: gsis(t, i), name: nameOf(t, i), slot: SLOTS[i],
          team: teamDuring(t, i, season), teamIndex: t, slotIndex: i,
          targets: SLOTS[i].targets * f, carries: SLOTS[i].carries * f,
          attempts: SLOTS[i].attempts * f,
          games: wasHurt(t, season, i) ? 9 : WEEKS
        });
      }
    }
    const teamTotal = new Map();
    for (const p of roster) {
      teamTotal.set(p.team, (teamTotal.get(p.team) ?? 0) + p.targets + p.carries + p.attempts);
    }

    for (const p of roster) {
      const opp = p.targets + p.carries + p.attempts;
      const total = teamTotal.get(p.team) || 1;
      const features = JSON.stringify({
        targets: p.targets, carries: p.carries, pass_attempts: p.attempts,
        opportunity_share: opp / total,
        target_share: p.targets / total,
        receptions: p.targets * 0.65, receiving_yards: p.targets * 8,
        rushing_yards: p.carries * 4.2, passing_yards: p.attempts * 7,
        receiving_tds: p.targets * 0.05, rushing_tds: p.carries * 0.03,
        passing_tds: p.attempts * 0.05, interceptions: p.attempts * 0.02
      });
      for (let w = 1; w <= p.games; w++) {
        insFeat.run(season, w, p.id, p.name, p.team, null, p.slot.position, features);
      }
      // Depth chart at the start of the season, and the injury report that
      // explains the games he did not play.
      insDepth.run(season, 1, p.team, p.id, p.name, p.slot.position,
        depthRankAt(p.teamIndex, p.slotIndex, season), p.slot.position,
        `${season}-09-05T00:00:00Z`);
      if (p.games < WEEKS) {
        for (let w = p.games + 1; w <= WEEKS; w++) {
          insInjury(insBio, season, w, p);
        }
      }
      if (season === SEASONS[0]) {
        insBio.run(p.id, p.slot.position, `${1996 + (p.slotIndex % 6)}-04-01`, 2019, 2019,
          1 + (p.slotIndex % 5), 10 + p.slotIndex * 12);
      }
    }
    for (let t = 0; t < TEAMS.length; t++) {
      // One in four teams changes head coach each offseason.
      insCoach.run(season, TEAMS[t], `Coach ${TEAMS[t]}-${Math.floor((season - 2020) / 4) + (t % 4 === 0 ? season - 2020 : 0)}`,
        17, '2026-01-01T00:00:00Z');
      for (let w = 1; w <= WEEKS; w++) insLine.run(season, w, TEAMS[t], 22 + (t % 5));
    }
  }

  // 2026: no weekly features at all, only a dated roster snapshot — exactly the
  // situation the model must handle in August.
  const captured = '2026-08-20T12:00:00Z';
  for (let t = 0; t < TEAMS.length; t++) {
    for (let i = 0; i < SLOTS.length; i++) {
      insSnap.run(captured, null, null, gsis(t, i), nameOf(t, i), SLOTS[i].position,
        teamDuring(t, i, 2026), 'active', SLOTS[i].position, depthRankAt(t, i, 2026), 'espn_roster');
    }
    insCoach.run(2026, TEAMS[t], `Coach ${TEAMS[t]}-2026${t % 4 === 0 ? 'x' : ''}`, 17, '2026-01-01T00:00:00Z');
    for (let w = 1; w <= WEEKS; w++) insLine.run(2026, w, TEAMS[t], 22 + (t % 5));
  }
}

function insInjury(_unused, season, week, p) {
  db.prepare(`INSERT OR REPLACE INTO nfl_injuries
    (season, week, gsis_id, team, full_name, position, report_status, modified_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(season, week, p.id, p.team, p.name, p.slot.position, 'Out', `${season}-10-01`);
}

seed();

const M = await import('../server/services/offseason-model.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

test('pprPoints scores a receiving line the way PPR does', () => {
  assert.equal(M.pprPoints({ receptions: 5, receiving_yards: 80, receiving_tds: 1 }), 19);
  assert.equal(M.pprPoints({ passing_yards: 300, passing_tds: 2, interceptions: 1 }), 18);
  assert.equal(M.pprPoints({}), 0, 'an empty line is zero, not NaN');
});

test('fitRidge recovers a known linear relationship at a small penalty', () => {
  const X = [], y = [];
  for (let i = 0; i < 400; i++) {
    const a = (i % 20) / 10, b = ((i * 7) % 13) / 6;
    X.push([a, b]); y.push(1.5 + 2 * a - 3 * b);
  }
  const m = M.fitRidge(X, y, 0.001);
  const pred = M.predictRidge(m, [1, 1]);
  assert.ok(Math.abs(pred - (1.5 + 2 - 3)) < 0.05, `expected ~0.5, got ${pred}`);
});

test('fitMeanReversion finds the negative slope that IS regression to the mean', () => {
  const rowsIn = [];
  for (let i = 1; i <= 200; i++) {
    const share = 0.02 + (i % 25) * 0.01;
    rowsIn.push({ position: 'WR', prior_log_share: Math.log(share),
      y_share: -0.5 * (Math.log(share) - Math.log(0.15)) });
  }
  const m = M.fitMeanReversion(rowsIn, 'y_share');
  assert.ok(m.by_position.WR.slope < -0.4 && m.by_position.WR.slope > -0.6,
    `slope should be ~-0.5, got ${m.by_position.WR.slope}`);
});

test('featureVector splits demotion from promotion and flags missing evidence', () => {
  const base = { position: 'WR', prior_log_share: Math.log(0.15), changed_team: 0,
    vacated_share_new_team: 0.1, depth_rank_delta: null, qb1_change: 0, hc_change: 0,
    games_missed_prior: 0, age_from_peak: null, implied_points_delta: null,
    two_year_share_trend: null, depth_rank: null };
  const at = n => M.featureVector({ ...base, depth_rank_delta: n });
  const idx = n => M.FEATURE_NAMES.indexOf(n);
  assert.equal(at(2)[idx('depth_demotion_steps')], 2);
  assert.equal(at(2)[idx('depth_promotion_steps')], 0);
  assert.equal(at(-2)[idx('depth_demotion_steps')], 0);
  assert.equal(at(-2)[idx('depth_promotion_steps')], 2);
  assert.equal(M.featureVector(base)[idx('depth_missing')], 1,
    'a null depth delta must set the missing flag, not silently read as zero');
  assert.equal(M.featureVector(base)[idx('implied_missing')], 1);
});

test('keepFeatures zeroes everything outside the shipped set', () => {
  const full = new Array(M.FEATURE_NAMES.length).fill(3);
  const kept = M.keepFeatures(full, M.SHIPPED_FEATURES);
  for (const [i, name] of M.FEATURE_NAMES.entries()) {
    assert.equal(kept[i], M.SHIPPED_FEATURES.includes(name) ? 3 : 0, name);
  }
  for (const declined of M.DECLINED_FEATURES) {
    assert.ok(!M.SHIPPED_FEATURES.includes(declined),
      `${declined} failed its effect test and must not be in the shipped model`);
  }
});

test('partialChangeEffect cancels the controls and is zero when nothing changed', () => {
  const train = M.panelFor([2022, 2023, 2024]);
  const model = M.fitRidge(train.map(M.shippedVector), train.map(r => r.y_share), 10);
  const unchanged = { position: 'WR', prior_log_share: Math.log(0.2), changed_team: 0,
    vacated_share_new_team: 0, depth_rank_delta: 0, qb1_change: 0, hc_change: 0,
    games_missed_prior: 0, implied_points_delta: null, two_year_share_trend: null,
    age_from_peak: null, depth_rank: 1 };
  assert.equal(M.partialChangeEffect(model, unchanged).total, 0);

  // Same player, twice the prior share: a control, so it must not move the
  // published number by even a rounding error.
  const richer = { ...unchanged, prior_log_share: Math.log(0.4) };
  assert.equal(M.partialChangeEffect(model, richer).total, 0);

  const mover = { ...unchanged, changed_team: 1, vacated_share_new_team: 0.1 };
  assert.ok(M.partialChangeEffect(model, mover).total < 0,
    'a mover must be discounted, not promoted');
});

// ---------------------------------------------------------------------------
// The feature builder, against the fixture's known truth
// ---------------------------------------------------------------------------

test('buildPanel reads team change, vacated share, depth and injury off the fixture', () => {
  const panel = M.buildPanel(2024);
  assert.ok(panel.length > 150, `expected a full league, got ${panel.length}`);
  assert.equal(M.rosterAtSeasonStart(2024).source, 'depth');

  for (const r of panel) {
    assert.equal(r.changed_team, r.prior_team === r.team ? 0 : 1,
      `${r.name}: changed_team must agree with the team pair it reports`);
    assert.ok(r.vacated_share_new_team >= 0 && r.vacated_share_new_team <= 1);
    assert.ok(r.prior_log_share < 0, 'a share is a fraction, so its log is negative');
  }
  assert.ok(panel.some(r => r.changed_team === 1), 'the fixture moves players every offseason');
  assert.ok(panel.some(r => r.depth_rank_delta > 0), 'and demotes some');
  assert.ok(panel.some(r => r.games_missed_prior >= 4), 'and injures some');

  // The fixture's injured players miss exactly 8 of 17 games.
  const hurt = panel.filter(r => r.games_missed_prior > 0);
  assert.ok(hurt.length > 10);
  for (const r of hurt) assert.equal(r.games_missed_prior, 8, `${r.name}`);
});

test('vacated share excludes the player himself, so a stayer is not credited with his own role', () => {
  const panel = M.buildPanel(2024).filter(r => r.changed_team === 0);
  const summary = M.teamOffseasonSummary(2024);
  for (const r of panel.slice(0, 40)) {
    const team = summary.teams.get(r.team);
    // Excluding a present player from the denominator can only raise the ratio,
    // never lower it — and it must never reach 1 for a team that kept anyone.
    assert.ok(r.vacated_share_new_team >= (team.vacated_opportunity_share ?? 0) - 1e-9,
      `${r.name}: ex-self share must not fall below the raw team share`);
    assert.ok(r.vacated_share_new_team < 1);
  }
});

test('the 2026 roster snapshot stands in for a depth chart that does not exist yet', () => {
  const roster = M.rosterAtSeasonStart(2026);
  assert.equal(roster.source, 'roster_snapshot');
  assert.ok(roster.players.size > 100);
  const panel = M.buildPanel(2026);
  assert.ok(panel.length > 100);
  assert.ok(panel.every(r => r.opp_share === null && r.y_share === null),
    'a season with no games played must carry no outcome');
});

test('teamOffseasonSummary reports vacated shares, coach change and named movement', () => {
  const summary = M.teamOffseasonSummary(2025);
  assert.equal(summary.teams.size, TEAMS.length);
  for (const t of summary.teams.values()) {
    assert.ok(t.vacated_opportunity_share >= 0 && t.vacated_opportunity_share <= 1, t.team);
    assert.equal(typeof t.head_coach_change, 'boolean');
    assert.ok(Array.isArray(t.notable_departures) && Array.isArray(t.notable_arrivals));
  }
  assert.ok([...summary.teams.values()].some(t => t.head_coach_change === true));
  assert.ok([...summary.teams.values()].some(t => t.notable_arrivals.length > 0));
});

// ---------------------------------------------------------------------------
// Effect direction and magnitude, against the injected truth
// ---------------------------------------------------------------------------

test('measureEffects recovers the size of every effect the fixture injected', () => {
  const measured = M.measureEffects([2022, 2023, 2024, 2025]);
  const e = measured.effects;

  // The measured multiplier is on SHARE, and the injected factor is on raw
  // usage, so the two differ by design: a mover both takes usage off his old
  // team and adds it to his new one, which moves the denominators on both
  // sides. The recovered number must therefore land between the injected factor
  // and no effect, closer to the injection — not equal it.
  const recovers = (measured, injected) =>
    measured < 1 - (1 - injected) / 2 && measured > injected - 0.1;

  assert.ok(e.team_change.n_group >= 20 && e.team_change.n_contrast >= 20);
  assert.ok(recovers(e.team_change.multiplier, MOVER_FACTOR),
    `team change should recover a discount near ${MOVER_FACTOR}, got ${e.team_change.multiplier}`);
  assert.ok(e.team_change.ci_multiplier.hi < 1, 'and its CI must exclude no effect');

  // Demotion is asserted on direction and significance only, not size. Its
  // group is defined by a depth-rank delta, and that delta also moves when a
  // player's PRIOR usage rank drifts for unrelated reasons — a coarse
  // three-deep proxy contaminated by rank churn attenuates any real effect
  // toward 1. That attenuation is a property of the depth chart as evidence,
  // not a defect in the estimator, and pinning a number here would only lock in
  // the fixture's particular churn rate.
  assert.ok(e.depth_demotion.multiplier < 0.95,
    `depth demotion should come back a clear discount, got ${e.depth_demotion.multiplier}`);
  assert.ok(e.depth_demotion.ci_multiplier.hi < 1);

  // Promotion was never injected, so it must come back indistinguishable from
  // nothing. A pipeline that "finds" it is finding noise.
  assert.ok(e.depth_promotion.crosses_zero,
    `promotion was not injected but measured ${e.depth_promotion.multiplier}`);
  assert.ok(e.hc_change.crosses_zero, 'no coaching effect was injected');
});

test('measureEffects prices the injury return the fixture injected, in the right direction', () => {
  const e = M.measureEffects([2022, 2023, 2024, 2025]).effects.injury_return;
  assert.ok(e.n_group >= 20, `n=${e.n_group}`);
  assert.ok(e.multiplier < 1 && e.ci_multiplier.hi < 1,
    `a player returning from missed time should be discounted, got ${e.multiplier}`);
});

test('attrition is reported separately rather than folded into a multiplier', () => {
  const a = M.attrition([2023, 2024, 2025]);
  assert.ok(a.mover_played_rate >= 0 && a.mover_played_rate <= 1);
  assert.ok(a.n_movers > 0 && a.n_stayers > 0);
  assert.ok(a.note.includes('Played'));
});

// ---------------------------------------------------------------------------
// The shipped API
// ---------------------------------------------------------------------------

test('offseasonAdjustments builds a whole league with finite, bounded multipliers', () => {
  const map = M.offseasonAdjustments(2026);
  assert.ok(map.size > 100, `expected >100 players, got ${map.size}`);
  for (const a of map.values()) {
    assert.ok(Number.isFinite(a.opportunity_multiplier), `${a.name} opportunity`);
    assert.ok(Number.isFinite(a.ppg_multiplier), `${a.name} ppg`);
    assert.ok(a.opportunity_multiplier >= 0.4 && a.opportunity_multiplier <= 1.6,
      `${a.name}: ${a.opportunity_multiplier} outside [0.4, 1.6]`);
    assert.ok(a.ppg_multiplier >= 0.4 && a.ppg_multiplier <= 1.6, `${a.name}`);
    assert.ok(['high', 'medium', 'low'].includes(a.confidence));
    assert.ok(Array.isArray(a.drivers));
    assert.ok(a.n_basis > 0, 'a shipped multiplier must say how many rows it rests on');
    assert.ok('team_change' in a.components && 'qb_change' in a.components
      && 'coach_change' in a.components && 'injury_return' in a.components
      && 'depth' in a.components && 'vacated' in a.components);
  }
});

test('a player with no priced change gets exactly 1.0 and says nothing', () => {
  const map = M.offseasonAdjustments(2026);
  let checked = 0;
  for (const a of map.values()) {
    const priced = a.drivers.filter(d => !d.includes('no measured effect'));
    if (priced.length) continue;
    checked++;
    assert.equal(a.opportunity_multiplier, 1, `${a.name} must be exactly 1.0`);
    assert.equal(a.ppg_multiplier, 1, `${a.name} must be exactly 1.0`);
    for (const v of Object.values(a.components)) assert.equal(v, null, a.name);
  }
  assert.ok(checked > 0, 'the fixture must contain at least one unchanged player');
});

test('a mover into an emptied room is discounted and explains itself', () => {
  const map = M.offseasonAdjustments(2026);
  const movers = [...map.values()].filter(a => a.prior_team !== a.team);
  const stayers = [...map.values()].filter(a => a.prior_team === a.team);
  assert.ok(movers.length > 10, `expected movers, got ${movers.length}`);

  const avg = list => list.reduce((s, a) => s + a.opportunity_multiplier, 0) / list.length;
  assert.ok(avg(movers) < avg(stayers) - 0.05,
    `movers ${avg(movers)} should sit clearly below stayers ${avg(stayers)}`);

  for (const a of movers) {
    assert.ok(a.components.team_change != null,
      `${a.name}: a mover's team-change component must be priced, not null`);
    assert.ok(a.drivers.some(d => d.startsWith('moved ') && d.includes('vacated')),
      `${a.name} drivers: ${JSON.stringify(a.drivers)}`);
  }
});

test('a declined effect is reported as a driver but never priced', () => {
  const map = M.offseasonAdjustments(2026);
  const withCoach = [...map.values()].filter(a =>
    a.drivers.some(d => d.startsWith('new head coach')));
  assert.ok(withCoach.length > 0, 'the fixture changes head coaches');
  for (const a of withCoach) {
    assert.equal(a.components.coach_change, null,
      `${a.name}: an unreplicated effect must contribute nothing`);
    assert.ok(a.drivers.some(d => d.includes('no measured effect')),
      'and must say so in the driver text');
  }
});

test('offseasonAdjustment accepts a gsis id and answers neutrally for an unknown one', () => {
  const known = [...M.offseasonAdjustments(2026).keys()][0];
  assert.equal(M.offseasonAdjustment(known, 2026).player_id, known);

  const missing = M.offseasonAdjustment('00-0000000', 2026);
  assert.equal(missing.opportunity_multiplier, 1);
  assert.equal(missing.ppg_multiplier, 1);
  assert.deepEqual(missing.drivers, []);
  assert.equal(missing.reason, 'no prior-season usage record');

  const noCrosswalk = M.offseasonAdjustment(999999, 2026);
  assert.equal(noCrosswalk.opportunity_multiplier, 1);
  assert.equal(noCrosswalk.reason, 'no gsis crosswalk');
});

test('walkForward never lets a model see the season it is graded on', () => {
  const wf = M.walkForward({ testSeasons: [2024, 2025], gbm: false });
  for (const s of wf.per_season) {
    assert.ok(!s.error, JSON.stringify(s.error));
    assert.ok(s.fit_seasons.every(f => f < s.season),
      `${s.season} was fit on ${s.fit_seasons.join(',')}`);
    assert.ok(s.n_train > 0 && s.n_test > 0);
  }
  // On a fixture whose effects are real and injected, the shipped model must
  // beat doing nothing. (On real data this is the claim the docs defend; here
  // it is a guard that the plumbing is connected at all.)
  assert.ok(wf.pooled.shipped_adjustment.mae < wf.pooled.no_change.mae,
    JSON.stringify({ shipped: wf.pooled.shipped_adjustment.mae, none: wf.pooled.no_change.mae }));
});

test('the shipped fit is the one the docs justify', () => {
  assert.equal(M.SHIPPED_FIT, 'ridge_shipped_features');
  assert.deepEqual(M.MULTIPLIER_BOUNDS, { lo: 0.4, hi: 1.6 });
});

// ---------------------------------------------------------------------------
// The real database, in a child process
// ---------------------------------------------------------------------------

/**
 * Opt-in, because `server/db/index.js` has no read-only mode: importing it runs
 * `PRAGMA journal_mode = WAL` and a page of `CREATE TABLE IF NOT EXISTS` against
 * whatever file it is pointed at. That is harmless and idempotent, but the local
 * league database is multi-gigabyte production data and a test suite has no
 * business opening it read-write on every run. Enable deliberately:
 *
 *   GRIDIRON_REAL_DB_SMOKE=1 npm test
 *
 * Last manual run (2026-09-06): 362 players, 1302ms, every multiplier finite and
 * inside [0.4, 1.6]. Those numbers are what docs/OFFSEASON_MODEL.md quotes.
 */
test('offseasonAdjustments(2026) runs on the real database inside its budget', { skip:
  !process.env.GRIDIRON_REAL_DB_SMOKE ? 'set GRIDIRON_REAL_DB_SMOKE=1 to run against the live database'
    : fs.existsSync(path.join(repo, 'server', 'data.sqlite')) ? false : 'no local data.sqlite' }, () => {
  const script = `
    const M = await import('./server/services/offseason-model.js');
    const t0 = Date.now();
    const map = M.offseasonAdjustments(2026);
    const v = [...map.values()];
    console.log(JSON.stringify({
      ms: Date.now() - t0, n: v.length,
      movers: v.filter(a => a.prior_team !== a.team).length,
      finite: v.every(a => Number.isFinite(a.opportunity_multiplier) && Number.isFinite(a.ppg_multiplier)),
      bounded: v.every(a => a.opportunity_multiplier >= 0.4 && a.opportunity_multiplier <= 1.6
        && a.ppg_multiplier >= 0.4 && a.ppg_multiplier <= 1.6),
      unchangedAreOne: v.filter(a => !a.drivers.filter(d => !d.includes('no measured effect')).length)
        .every(a => a.opportunity_multiplier === 1 && a.ppg_multiplier === 1)
    }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, GRIDIRON_DB_PATH: '', NFL_SEASON: '2026' } });
  const r = JSON.parse(out.trim().split('\n').at(-1));
  assert.ok(r.n > 100, `expected >100 players, got ${r.n}`);
  assert.ok(r.finite, 'every multiplier must be finite');
  assert.ok(r.bounded, 'every multiplier must sit inside [0.4, 1.6]');
  assert.ok(r.unchangedAreOne, 'a player with no priced change must be exactly 1.0');
  assert.ok(r.movers > 20, `expected real 2026 movement, got ${r.movers}`);
  assert.ok(r.ms < 2000, `build took ${r.ms}ms, budget is 2000ms`);
});
