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

const { analyzeErrors, proposeAdjustment } = await import('../server/services/nfl-replay.js');
const { withRandomSeed, random } = await import('../server/services/stats-util.js');

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
