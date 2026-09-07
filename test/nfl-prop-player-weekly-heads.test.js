import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The redo. The season-level version of this hypothesis was declined 0/3 and
// 0/3 (docs/PROPS_PLAYER_ENGINES.md) and diagnosed its own failure as a GRAIN
// problem: the features were constant across a player's whole season, and a
// season constant cannot explain week-to-week variation in a per-game price.
// This harness re-asks the same question with weekly-grain features.
//
// A redo is only worth anything if it is genuinely a different test, so what
// this file protects is exactly that:
//
//  1. the features actually VARY week to week inside a player-season — this is
//     the whole difference from the first attempt, and it is asserted from the
//     data rather than believed from the docstring;
//  2. a player-week's feature never contains that week's own game, so the
//     within-season trend is a trend as of kickoff and not hindsight;
//  3. the no-feature control reproduces the shipped head, so a loss indicts the
//     features and not the fitter's shape;
//  4. training is strictly chronological and a season with no prior data is
//     skipped rather than quietly graded;
//  5. "wins" requires a significant improvement in the right direction;
//  6. the matchup block — the one nfl-opponent.js's documented double-counting
//     failure warns about — is separable, so its effect is measured rather than
//     bundled invisibly into an all-features variant.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-prop-weekly-heads-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
db.exec(`CREATE TABLE IF NOT EXISTS nfl_player_week_features (
  season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
  player_name TEXT, team TEXT, opponent TEXT, position TEXT, features TEXT NOT NULL,
  PRIMARY KEY (season, week, player_id)
)`);

const GSIS = n => `00-00${String(10000 + n).slice(-5)}`;
const PLAYERS = Array.from({ length: 40 }, (_, i) => GSIS(i));
const SEASONS = [2020, 2021, 2022, 2023];

// A synthetic league. Player 1 is the ROLE-CHANGE probe: no red-zone work at
// all through week 8, then a large goal-line role from week 9 on — the "starter
// went out in week 6" case the first attempt could not express. Player 0 is the
// leakage probe: he scores in exactly one week, so a feature that saw its own
// week would show it.
const insert = db.prepare(`INSERT OR REPLACE INTO nfl_player_week_features
  (season,week,player_id,player_name,team,opponent,position,features) VALUES (?,?,?,?,?,?,?,?)`);
for (const season of SEASONS) {
  for (let i = 0; i < PLAYERS.length; i++) {
    for (let week = 1; week <= 15; week++) {
      const rolled = i === 1 && week >= 9;
      const scores = i === 1 ? (rolled ? 1 : 0) : ((i + week + season) % 4 === 0 ? 1 : 0);
      insert.run(season, week, PLAYERS[i], `Player ${i}`, i % 2 ? 'BUF' : 'MIA',
        i % 2 ? 'MIA' : 'BUF', ['RB', 'WR', 'TE', 'WR'][i % 4], JSON.stringify({
          carries: 8 + (i % 5), targets: 4 + (i % 6), pass_attempts: 0,
          rushing_yards: 30 + i, receiving_yards: 25 + i, passing_yards: 0,
          receptions: 3, rushing_tds: scores, receiving_tds: 0, passing_tds: 0, interceptions: 0,
          red_zone_carries: i === 1 ? (rolled ? 5 : 0) : (i % 3),
          goal_line_carries: i === 1 ? (rolled ? 3 : 0) : (i % 2),
          red_zone_targets: (i + week) % 3,
          end_zone_targets: i === 1 ? 0 : (i + week) % 2,
          goal_to_go_targets: i === 1 ? 0 : i % 2,
          opportunity_share: 0.05 + ((i + week) % 7) / 50
        }));
    }
  }
}

const { propPlayerWeeklyFeatures, weeklyVarianceReport, assertNoTargetWeekLeak,
  clearWeeklyFeatureCache, WEEKLY_FEATURE_BLOCKS } =
  await import('../server/services/nfl-props-player-features-weekly.js');
const { weeklyChallengerRows, walkForwardWeeklyChallengerTd, ablateWeeklyChallengerTd,
  WEEKLY_CHALLENGER_HEADS, WEEKLY_CHALLENGER_MODEL_VERSION } =
  await import('../server/services/nfl-prop-player-weekly-heads.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Replay-shaped rows: probability p, outcome y, one synthetic game per week. */
function replayRows({ seasons = [2021, 2022, 2023] } = {}) {
  const out = [];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const season of seasons) {
    for (let week = 1; week <= 15; week++) {
      for (let i = 0; i < PLAYERS.length; i++) {
        const p = 0.1 + 0.5 * rand();
        const y = rand() < p ? 1 : 0;
        const p2 = p * 0.3;
        out.push({
          season, week, player_id: PLAYERS[i], position: ['RB', 'WR', 'TE', 'WR'][i % 4],
          team: i % 2 ? 'BUF' : 'MIA', opponent: i % 2 ? 'MIA' : 'BUF',
          eligibility: { markets: { player_anytime_td: true } },
          market: { anytime_td: p, multi_td: p2 },
          actual: { anytime_td: y, multi_td: rand() < p2 ? 1 : 0 }
        });
      }
    }
  }
  return out;
}

test('the features actually vary week to week — the whole point of the redo', () => {
  clearWeeklyFeatureCache();
  const rep = weeklyVarianceReport(2023);
  assert.ok(rep.player_seasons >= 30);
  // The trend block is the hypothesis proper. If any of it were flat within a
  // player-season, this would be the season-level test wearing a new label —
  // which is the exact failure mode this whole file exists to rule out.
  for (const name of ['wk_rz_opp_recent', 'wk_rz_opp_trend', 'wk_gl_opp_trend',
    'wk_opp_share_trend', 'wk_td_rate_trend']) {
    assert.ok(rep.varying_share[name] > 0.5,
      `${name} varies within only ${rep.varying_share[name]} of player-seasons — that is season-level, not weekly`);
  }
  // The churn interaction is a season-level number times a week-decaying
  // weight, so it must move too for anyone the offseason panel flagged, and the
  // weight's own main effect must move for everyone.
  assert.equal(rep.varying_share.wk_early_weight, 1);
  // Opponent red-zone defense updates every week even on a fixed schedule.
  assert.equal(rep.varying_share.wk_opp_rz_td_rel, 1);
});

test('a week-9 role change shows up in week 10 and not before', () => {
  clearWeeklyFeatureCache();
  const m = propPlayerWeeklyFeatures(2023);
  const at = week => m.get(`${week}|${PLAYERS[1]}`);
  // Player 1 has zero goal-line work through week 8 and a lot from week 9 on.
  assert.equal(at(8).wk_gl_opp_recent, 0, 'no goal-line role is visible before it exists');
  assert.equal(at(9).wk_gl_opp_recent, 0, 'week 9 cannot see its own week 9');
  assert.ok(at(10).wk_gl_opp_recent > 0, 'the new role is visible the week after it starts');
  assert.ok(at(11).wk_gl_opp_trend > 0, 'and reads as a rising trend against his season rate');
  // Which is exactly the separation a season constant cannot make: his week-3
  // and week-12 features must not be the same number.
  assert.notEqual(at(3).wk_gl_opp_recent, at(12).wk_gl_opp_recent);
});

test('no player-week feature contains that week own game', () => {
  clearWeeklyFeatureCache();
  // Re-derived from the raw weekly rows with the target week excluded, for
  // every row in the season, rather than asserted in a comment.
  const res = assertNoTargetWeekLeak(2023);
  assert.equal(res.leaked, 0);
  assert.ok(res.rows_checked > 500);
});

test('missing context is flagged, never imputed as an average player', () => {
  clearWeeklyFeatureCache();
  const f = propPlayerWeeklyFeatures(2023).get(`2|${PLAYERS[4]}`);
  // No offseason panel exists in this synthetic league, so the block must
  // announce itself absent instead of contributing a fabricated zero that
  // reads as "an average amount of churn".
  assert.equal(f.wk_newrole_missing, 1);
  assert.equal(f.wk_new_role_vacated, 0);
  // Week 1 has no prior games at all, so the trend block flags itself too.
  const w1 = propPlayerWeeklyFeatures(2023).get(`1|${PLAYERS[4]}`);
  assert.equal(w1.wk_trend_missing, 1);
  assert.equal(w1.wk_games_prior, 0);
});

test('both TD markets are built, including the 2+ market the shipped tdRows skips', () => {
  clearWeeklyFeatureCache();
  const rows = replayRows();
  const any = weeklyChallengerRows(rows, 'anytime_td');
  const multi = weeklyChallengerRows(rows, 'multi_td');
  assert.ok(any.length > 500);
  assert.equal(any.length, multi.length, 'identical player-weeks in both markets');
  assert.ok(multi.every((r, i) => r.p < any[i].p));
  assert.throws(() => weeklyChallengerRows(rows, 'rec_yds'), /unknown TD prop market/);
});

test('training is strictly chronological and a season with no prior data is skipped', () => {
  clearWeeklyFeatureCache();
  const rows = replayRows();
  const res = walkForwardWeeklyChallengerTd(rows, {
    testSeasons: [2021, 2022, 2023], bootstrapIterations: 200
  });
  const by = Object.fromEntries(res.per_season.map(s => [s.season, s]));
  assert.equal(by[2021].skipped, true);
  assert.match(by[2021].why, /prior-season rows/);

  const built = weeklyChallengerRows(rows, 'anytime_td');
  const count = pred => built.filter(pred).length;
  assert.equal(by[2022].train_n, count(r => r.season < 2022), '2022 trains on 2021 only');
  assert.equal(by[2023].train_n, count(r => r.season < 2023), '2023 trains on 2021+2022 only');
  assert.equal(by[2023].test_n, count(r => r.season === 2023));
  // The challenger's own variant selection is chronological too — it never
  // sees the test season when deciding which variant to run.
  assert.equal(by[2023].challenger_inner_season, 2022);
  assert.equal(by[2023].challenger_inner_ranking.length, WEEKLY_CHALLENGER_HEADS.length);
});

test('the no-feature control tracks the shipped head, so a loss indicts the features', () => {
  clearWeeklyFeatureCache();
  const res = walkForwardWeeklyChallengerTd(replayRows(), {
    testSeasons: [2023], bootstrapIterations: 200
  });
  const s = res.per_season[0];
  assert.equal(s.stacked, true, 'the fair form stacks on the shipped head');
  // An earlier form of this comparison replaced the isotonic head with a Platt
  // fit and lost on head shape rather than on features. Stacking keeps the
  // challenger anchored to the baseline it starts from.
  assert.ok(Math.abs(s.challenger.brier - s.shipped.brier) < 0.01,
    `challenger ${s.challenger.brier} vs shipped ${s.shipped.brier} diverged too far to be a feature test`);
});

test('a win needs significance in the right direction, not a favourable point estimate', () => {
  clearWeeklyFeatureCache();
  const res = walkForwardWeeklyChallengerTd(replayRows(), {
    testSeasons: [2022, 2023], bootstrapIterations: 400
  });
  for (const s of res.per_season.filter(x => !x.skipped)) {
    const [lo, hi] = s.bootstrap.ci90;
    const straddles = lo <= 0 && hi >= 0;
    if (straddles || s.bootstrap.mean_diff >= 0) assert.equal(s.wins, false);
    else assert.equal(s.wins, true);
  }
  assert.ok(res.seasons_won < 2);
  assert.match(res.verdict, /does NOT clear the pre-stated bar/);
  assert.match(res.bar, /at least 2 of 3 held-out seasons/);
});

test('the matchup block is separable, so its documented double-count risk is measured', () => {
  clearWeeklyFeatureCache();
  const ab = ablateWeeklyChallengerTd(replayRows(), { testSeasons: [2023], bootstrapIterations: 200 });
  const s = ab.per_season[0];
  const ids = s.blocks.map(b => b.id);
  // nfl-opponent.js records opponent adjustment making weekly stat predictions
  // monotonically WORSE by double-counting the betting line. That block must
  // therefore be gradeable on its own, and there must be a variant of the
  // hypothesis that excludes it entirely, so the failure is not repeated blind.
  assert.ok(ids.includes('weekly_matchup'), 'the risky block gets its own arm');
  assert.ok(ids.includes('weekly_core'), 'and there is a matchup-free variant of the hypothesis');
  assert.deepEqual(WEEKLY_CHALLENGER_HEADS.find(h => h.id === 'weekly_core').blocks,
    ['trend', 'newrole']);
  assert.ok(!WEEKLY_FEATURE_BLOCKS.trend.some(n => n.includes('opp_rz')),
    'no opponent feature may hide inside the trend block');
  for (const b of s.blocks) {
    assert.ok(Number.isFinite(b.brier));
    assert.equal(b.helps, b.significant === true && b.mean_diff < 0);
  }
});

test('nothing here is wired into the shipped calibration path', () => {
  // Research-only. It must not have quietly become the thing production calls,
  // and it must not have written a calibration fit.
  const src = fs.readFileSync(new URL('../server/services/nfl-props.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('nfl-prop-player-weekly-heads'));
  assert.ok(!src.includes('nfl-props-player-features-weekly'));
  const calib = fs.readFileSync(new URL('../server/services/nfl-prop-calibration.js', import.meta.url), 'utf8');
  assert.ok(!calib.includes('weekly-heads'), 'the shipped calibration file does not import the challenger');
  const fits = db.prepare('SELECT COUNT(*) n FROM nfl_prop_calibration_fits').get();
  assert.equal(fits.n, 0, 'the challenger evaluation must persist no calibration fit');
});

test('the first attempt is left intact as a separate, differently named record', () => {
  const seasonLevel = fs.readFileSync(
    new URL('../server/services/nfl-prop-player-heads.js', import.meta.url), 'utf8');
  assert.ok(seasonLevel.includes("'player-head-registry-v1-engine-context'"),
    'the season-level attempt keeps its own model version');
  assert.notEqual(WEEKLY_CHALLENGER_MODEL_VERSION, 'player-head-registry-v1-engine-context');
});
