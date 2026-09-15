/**
 * Phase 0 of the 2026-09-09 learning-pipeline plan: `analyzeErrors` was the
 * one tool built to find systematic betting bias, but it had a real sign bug
 * (away/under bets read backwards) and no defense against testing ~20-30
 * segments at once with no multiple-comparisons correction and no minimum
 * effect size — exactly the setup where something looks "significant" by
 * chance alone. This proves the fix: the sign is right, pure noise doesn't
 * get flagged even at scale, a statistically-real-but-tiny effect gets
 * rejected, two segments describing the same games get flagged as
 * correlated rather than double-counted, a one-season fluke doesn't survive
 * leave-one-season-out, and `proposeAdjustment` refuses an overlapping
 * discovery/holdout split outright rather than silently mis-scoring it.
 *
 * All bets here are hand-built fixtures, not real replays — `analyzeErrors`
 * only needs the plain bet-shaped objects `replaySeason` would have produced,
 * so constructing them directly proves the analysis logic in isolation from
 * the (expensive, already-tested-elsewhere) ensemble/replay machinery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-error-analysis-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { analyzeErrors, proposeAdjustment, decisionTapeForecastRecords, forecastAccuracyReport } =
  await import('../server/services/nfl-replay.js');
const { withRandomSeed, random } = await import('../server/services/stats-util.js');
const { recordDecisionRun } = await import('../server/services/nfl-decision-tape.js');
const { NFL_PRODUCTION_POLICY } = await import('../server/services/nfl-policy.js');
const { run } = await import('../server/db/index.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** A minimal, valid spread bet. Every field `segmentsFor`/`analyzeErrors`
 * reads is set explicitly so a test failure can't hide behind a default. */
function spreadBet({ season = 2022, week = 8, home = 'AAA', away = 'BBB', side, line,
  modelMargin, actualMargin, won, edge = 5, disagreement = 3 }) {
  const backedHome = side === 'home';
  return {
    season, week, home, away, market: 'spread',
    side: backedHome ? `${home} ${line >= 0 ? '+' : ''}${line}` : `${away} ${-line >= 0 ? '+' : ''}${-line}`,
    line: backedHome ? line : -line,
    model_margin: modelMargin, market_margin: -line,
    edge, edge_points: Math.abs(edge), disagreement,
    actual_margin: actualMargin, actual_total: 44,
    result: won ? 'Won' : 'Lost', won, pushed: false,
    units: won ? 0.909 : -1, american_price: -110, opposite_price: -110
  };
}

test('sign fix: signed error is computed in the bet side\'s own reference frame, not always home\'s', () => {
  // Home bet: model projected home +6, home actually won by +2 (model too
  // generous to the side it bet — home did worse than the model's own call).
  const homeBet = spreadBet({ side: 'home', line: -3, modelMargin: 6, actualMargin: 2, won: true, week: 5 });
  // Away bet on a DIFFERENT game: model projected home +6 (so it liked away
  // relative to a wider market number), and home actually won by +9 — home
  // did BETTER than the model's own call, i.e. worse than the model's own
  // (already away-leaning) projection for the away side it bet.
  const awayBet = spreadBet({ home: 'CCC', away: 'DDD', side: 'away', line: -3, modelMargin: 6, actualMargin: 9, won: false, week: 5 });
  const result = analyzeErrors([homeBet, awayBet], { minBets: 1 });
  const homeSeg = result.segments.find(s => s.dimension === 'side' && s.segment === 'backed home');
  const awaySeg = result.segments.find(s => s.dimension === 'side' && s.segment === 'backed away');
  // Home: raw model_margin(6) - actual_margin(2) = +4 -> unflipped, matches original convention.
  assert.equal(homeSeg.mean_signed_error, 4);
  // Away: pre-fix code would have also reported +4 here (same raw value,
  // never flipped). The fix must report the NEGATION: actual(9) - model(6) = +3.
  assert.equal(awaySeg.mean_signed_error, 3, 'away/under bets must be re-derived in their own reference frame, not left in home/over terms');
});

test('Holm correction: pure noise across ~20 segments does not get flagged, even though a flat threshold would', () => {
  // 2200 bets, i.i.d. coin flips at the true break-even rate (52.4%), spread
  // across every dimension analyzeErrors buckets by. No real bias exists
  // anywhere in this data by construction.
  const bets = [];
  withRandomSeed(9001, () => {
    for (let i = 0; i < 2200; i++) {
      const week = 1 + Math.floor(random() * 18);
      const line = -1 - Math.floor(random() * 12);
      const edge = (random() - 0.5) * 10;
      const disagreement = random() * 8;
      const won = random() < 0.524; // true break-even: zero real edge anywhere
      bets.push(spreadBet({
        season: 2021 + Math.floor(random() * 4), week,
        home: `T${i % 8}`, away: `T${(i + 1) % 8}`,
        side: random() < 0.5 ? 'home' : 'away', line,
        modelMargin: (random() - 0.5) * 14, actualMargin: (random() - 0.5) * 14,
        won, edge, disagreement
      }));
    }
  });
  const result = analyzeErrors(bets, { minBets: 25 });
  assert.ok(result.segments.length >= 15, `expected many segments to reach minBets, got ${result.segments.length}`);
  // The old flat z>=1.5 threshold, applied to this same data, WOULD flag some
  // of these by pure chance (~1 in 15 segments at that loose a cutoff) --
  // that's the exact failure mode this test guards against.
  const wouldFlagUnderOldRule = result.segments.filter(s => Math.abs(s.z) >= 1.5).length;
  assert.ok(wouldFlagUnderOldRule >= 1, 'test setup check: the old threshold should be loose enough that pure noise trips it at this scale');
  assert.equal(result.weakest.length, 0, 'Holm-corrected significance must suppress the false positives a flat threshold would allow through');
  assert.equal(result.strongest.length, 0);
});

test('effect-size gate rejects a segment that is statistically significant but practically tiny', () => {
  // Large, clean sample with a real but MINISCULE win-rate edge over break-even
  // (53% vs 52.4% break-even -- technically on the winning side, corrected
  // p-value can clear alpha at this n, but the ROI this implies is nowhere
  // near MIN_EFFECT_ROI).
  const bets = [];
  withRandomSeed(4242, () => {
    for (let i = 0; i < 600; i++) {
      const won = random() < 0.531; // just barely over break-even
      bets.push(spreadBet({
        season: 2021 + (i % 5), week: 1 + (i % 18) || 1,
        home: `X${i % 4}`, away: `Y${i % 4}`, side: 'home', line: -3,
        modelMargin: 3, actualMargin: won ? 4 : 2, won, edge: 6, disagreement: 2
      }));
    }
  });
  const result = analyzeErrors(bets, { minBets: 25 });
  const homeSeg = result.segments.find(s => s.dimension === 'side' && s.segment === 'backed home');
  assert.ok(homeSeg, 'segment should exist at this sample size');
  // Whether or not it clears Holm significance, it must not reach `strongest`
  // -- the effect (roi ~1-2%) is far below MIN_EFFECT_ROI (5%).
  assert.ok(!result.strongest.some(s => s.dimension === 'side' && s.segment === 'backed home'),
    `a ~${homeSeg.roi} ROI segment must not clear the minimum real-effect bar`);
});

test('overlap detection flags two segments built from the same underlying games', () => {
  // Every divisional bet in this fixture is ALSO a late-season (wk 14+) bet --
  // by construction, the two labels describe the same games.
  const bets = [];
  for (let i = 0; i < 40; i++) {
    bets.push({
      season: 2022, week: 15, home: `D${i}`, away: `E${i}`, market: 'spread',
      side: `D${i} +3`, line: 3, model_margin: 1, market_margin: 3,
      edge: -2, edge_points: 2, disagreement: 2, actual_margin: -8, actual_total: 44,
      result: 'Lost', won: false, pushed: false, units: -1, american_price: -110, opposite_price: -110
    });
  }
  // Seed game_lines context so `divisional` and `part of season` both resolve
  // for these synthetic games.
  db.exec(`INSERT INTO game_lines (season, week, team, opponent, home, div_game, spread, team_score, opp_score, source, fetched_at)
    VALUES ${bets.map((b, i) => `(2022, 15, 'D${i}', 'E${i}', 1, 1, 3, 0, 8, 'test', datetime('now'))`).join(',')}`);
  const result = analyzeErrors(bets, { minBets: 25 });
  assert.ok(result.overlap_warnings.length >= 1, 'divisional and late-season should be flagged as overlapping when they are literally the same games');
  const warning = result.overlap_warnings[0];
  assert.ok(warning.overlap_fraction >= 0.5);
});

test('leave-one-season-out rejects a bias driven by a single anomalous season', () => {
  // Genuinely biased in 2024 only; 2022 and 2023 are at break-even. Pooled
  // across all three, this could still look like a real effect -- but it
  // must not survive leave-one-season-out (removing 2024 kills it).
  const bets = [];
  for (const season of [2022, 2023, 2024]) {
    for (let i = 0; i < 40; i++) {
      const won = season === 2024 ? false : (i % 2 === 0);
      bets.push(spreadBet({
        season, week: 15, home: `W${season}_${i}`, away: `L${season}_${i}`,
        side: 'home', line: -3, modelMargin: 4, actualMargin: won ? 5 : 1,
        won, edge: 5, disagreement: 2
      }));
    }
  }
  const result = analyzeErrors(bets, { minBets: 25 });
  const seg = result.segments.find(s => s.dimension === 'side' && s.segment === 'backed home');
  assert.ok(seg, 'segment should exist');
  assert.ok(!result.weakest.some(s => s.dimension === 'side' && s.segment === 'backed home'),
    'a bias present in only 1 of 3 seasons must not survive leave-one-season-out');
});

test('robustAcrossSeasons: fewer than 3 seasons must be reported not-estimable, never a truthy pass (R28)', () => {
  // Real bias, but confined to a single season -- by construction there are
  // only 2 seasons of history in this segment, so leave-one-season-out
  // literally cannot run (removing either one leaves too little to compare).
  // Before the fix this uncomputable check returned `robust: true`, which
  // would fool any caller doing `if (result.robust)` into treating "we
  // couldn't check this" as "we checked this and it's fine."
  const bets = [];
  for (const season of [2023, 2024]) {
    for (let i = 0; i < 40; i++) {
      bets.push(spreadBet({
        season, week: 15, home: `Q${season}_${i}`, away: `R${season}_${i}`,
        side: 'home', line: -3, modelMargin: 4, actualMargin: 1,
        won: false, edge: 5, disagreement: 2
      }));
    }
  }
  const result = analyzeErrors(bets, { minBets: 25 });
  const seg = result.segments.find(s => s.dimension === 'side' && s.segment === 'backed home');
  assert.ok(seg, 'segment should exist');
  assert.equal(seg._seasons === undefined, true, 'internal _seasons must be stripped from the public segments list');
  const flagged = result.weakest.find(s => s.dimension === 'side' && s.segment === 'backed home');
  assert.ok(flagged, 'this 2-season bias should otherwise clear significance + effect-size gates, exercising the robustness branch');
  assert.notEqual(flagged.robust_across_seasons, true, 'an uncomputable (fewer than 3 seasons) check must never read as a pass');
  assert.equal(flagged.leave_one_season_out.robust, false);
  assert.equal(flagged.leave_one_season_out.status, 'insufficient_data');
  assert.match(flagged.leave_one_season_out.note, /fewer than 3 seasons/);
});

test('proposeAdjustment refuses an overlapping discovery/holdout split outright', () => {
  const segment = { dimension: 'divisional', segment: 'divisional', win_rate: 0.4 };
  assert.throws(
    () => proposeAdjustment(segment, { discoverySeasons: [2021, 2022, 2023], holdoutSeasons: [2023, 2024] }),
    /overlap/i
  );
});

test('proposeAdjustment refuses an empty discovery or holdout set', () => {
  const segment = { dimension: 'divisional', segment: 'divisional', win_rate: 0.4 };
  assert.throws(() => proposeAdjustment(segment, { discoverySeasons: [], holdoutSeasons: [2024] }), /required/i);
  assert.throws(() => proposeAdjustment(segment, { discoverySeasons: [2021], holdoutSeasons: [] }), /required/i);
});

/*
 * WP14/C10: decisionTapeForecastRecords/forecastAccuracyReport are sourced
 * from the REAL decision tape (nfl-decision-tape.js's recordDecisionRun),
 * not hand-built bet fixtures -- the property under test is specifically
 * that a no-bet (abstained) game's frozen forecast survives the trip through
 * that tape and comes back out gradeable, which a bet-shaped fixture could
 * never demonstrate.
 */

let _testRunSuffix = 0;
/** One decision-tape run for a season/week, with a mix of eligible and abstained games. */
function recordBoard(season, week, decisions) {
  const decidedAt = new Date().toISOString();
  return recordDecisionRun(season, week, { policy: NFL_PRODUCTION_POLICY, decisions }, {
    observation: { experimentId: 'error-analysis-test', horizon: 'test', cutoffAt: decidedAt,
      jobId: 'test', observationId: `error-analysis-test:${season}:${week}:${_testRunSuffix++}` },
    decidedAt
  });
}

/** One decision candidate, eligible (bet-shaped) or abstained (no-bet), always carrying a frozen forecast. */
function candidate({ home, away, market = 'spread', eligible, abstentionReason = null,
  projectedMargin, marketMargin, selection = null, line = null, americanPrice = null }) {
  return {
    matchup: `${away} at ${home}`, home_team: home, away_team: away, market,
    eligible, abstention_reason: eligible ? null : (abstentionReason ?? 'missing_line'),
    selection: eligible ? (selection ?? home) : null,
    line: eligible ? (line ?? -3) : null, american_price: eligible ? (americanPrice ?? -110) : null,
    model_probability: eligible ? 0.55 : null, implied_probability: eligible ? 0.52 : null,
    probability_difference: eligible ? 0.03 : null, is_market_identity: false,
    feature_snapshot: { raw_forecast: { projected_margin: projectedMargin, market_margin: marketMargin } }
  };
}

/** Records the final score both sides of game_lines need. */
function finalGame(season, week, home, away, homeScore, awayScore) {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,team_score,opp_score) VALUES (?,?,?,?,1,?,?)`,
    season, week, home, away, homeScore, awayScore);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,team_score,opp_score) VALUES (?,?,?,?,0,?,?)`,
    season, week, away, home, awayScore, homeScore);
}

test('decisionTapeForecastRecords retains a no-bet (abstained) game\'s forecast, not just bets', () => {
  recordBoard(2031, 1, [
    candidate({ home: 'AAA', away: 'BBB', eligible: true, projectedMargin: 4, marketMargin: 3 }),
    candidate({ home: 'CCC', away: 'DDD', eligible: false, abstentionReason: 'missing_line',
      projectedMargin: 6, marketMargin: null })
  ]);
  finalGame(2031, 1, 'AAA', 'BBB', 24, 20); // actual margin +4
  finalGame(2031, 1, 'CCC', 'DDD', 27, 20); // actual margin +7

  const recs = decisionTapeForecastRecords({ seasons: [2031] });
  assert.equal(recs.length, 2);

  const bet = recs.find(r => r.home_team === 'AAA');
  assert.equal(bet.eligible, true);
  assert.equal(bet.actual_margin, 4);
  assert.equal(bet.forecast_error, 0, 'projected 4, actual 4');
  assert.equal(bet.market_error, 1, 'market -3 (margin +3), actual 4');

  const noBet = recs.find(r => r.home_team === 'CCC');
  assert.ok(noBet, 'the abstained game must still appear');
  assert.equal(noBet.eligible, false);
  assert.equal(noBet.abstention_reason, 'missing_line');
  assert.equal(noBet.actual_margin, 7);
  assert.equal(noBet.projected_margin, 6, 'the frozen forecast survives even though nothing was bet');
  assert.equal(noBet.forecast_error, 1);
  assert.equal(noBet.market_error, null, 'no market_margin was ever frozen for this abstention');
});

test('decisionTapeForecastRecords excludes a game with no final score yet, rather than zeroing it', () => {
  recordBoard(2032, 1, [
    candidate({ home: 'EEE', away: 'FFF', eligible: true, projectedMargin: 2, marketMargin: 1 })
  ]);
  // No finalGame() call -- this game has not been played.
  const recs = decisionTapeForecastRecords({ seasons: [2032] });
  assert.equal(recs.length, 0, 'an unplayed game has nothing to grade the forecast against');
});

test('forecastAccuracyReport reports insufficient_data below the read floor, never a rate', () => {
  recordBoard(2033, 1, [candidate({ home: 'GGG', away: 'HHH', eligible: true, projectedMargin: 3, marketMargin: 2 })]);
  finalGame(2033, 1, 'GGG', 'HHH', 23, 20);
  const recs = decisionTapeForecastRecords({ seasons: [2033] });
  const report = forecastAccuracyReport(recs);
  assert.equal(report.all.status, 'insufficient_data');
  assert.equal(report.all.readable, false);
  assert.equal(report.all.forecast_mae, null, 'a rate must not be reported below the read floor');
});

test('forecastAccuracyReport separates the eligible cohort from the abstained cohort', () => {
  const decisions = [];
  for (let i = 0; i < 25; i++) {
    const home = `E${i}`, away = `e${i}`;
    decisions.push(candidate({ home, away, eligible: true, projectedMargin: 3, marketMargin: 5 }));
  }
  for (let i = 0; i < 25; i++) {
    const home = `A${i}`, away = `a${i}`;
    decisions.push(candidate({ home, away, eligible: false, projectedMargin: 3, marketMargin: 5 }));
  }
  recordBoard(2034, 1, decisions);
  for (const d of decisions) finalGame(2034, 1, d.home_team, d.away_team, 23, 20); // actual margin +3 every game

  const recs = decisionTapeForecastRecords({ seasons: [2034] });
  const report = forecastAccuracyReport(recs);

  assert.equal(report.eligible.games, 25);
  assert.equal(report.abstained.games, 25);
  assert.equal(report.eligible.readable, true);
  assert.equal(report.abstained.readable, true);
  // Every game: projected 3, actual 3 -> forecast_mae 0; market 5, actual 3 -> market_mae 2.
  assert.equal(report.eligible.forecast_mae, 0);
  assert.equal(report.abstained.forecast_mae, 0);
  assert.equal(report.eligible.beat_market_rate, 1);
  assert.equal(report.abstained.beat_market_rate, 1);
});

test('forecastAccuracyReport keeps by_season a single-season slice, never blended into the pooled cohort', () => {
  const decisions2035 = [];
  for (let i = 0; i < 12; i++) decisions2035.push(candidate({ home: `S${i}`, away: `s${i}`,
    eligible: true, projectedMargin: 3, marketMargin: 5 }));
  recordBoard(2035, 1, decisions2035);
  for (const d of decisions2035) finalGame(2035, 1, d.home_team, d.away_team, 23, 20);

  const decisions2036 = [];
  for (let i = 0; i < 12; i++) decisions2036.push(candidate({ home: `T${i}`, away: `t${i}`,
    eligible: true, projectedMargin: 3, marketMargin: 5 }));
  recordBoard(2036, 1, decisions2036);
  for (const d of decisions2036) finalGame(2036, 1, d.home_team, d.away_team, 23, 20);

  // 12 + 12 = 24 clears the default 20-game floor pooled, but neither season alone does.
  const recs = decisionTapeForecastRecords({ seasons: [2035, 2036] });
  const report = forecastAccuracyReport(recs);
  assert.equal(report.all.readable, true, 'the pooled cohort clears the floor');
  const s2035 = report.by_season.find(s => s.season === 2035);
  const s2036 = report.by_season.find(s => s.season === 2036);
  assert.equal(s2035.readable, false, 'one season alone (12 games) must not pass the same floor as the pool');
  assert.equal(s2036.readable, false);
});
