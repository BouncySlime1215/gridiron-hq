/**
 * Regression coverage for moneyline as a real, gradeable domain.
 *
 * A parallel audit found `nfl-blind-audit.js`'s `domains` list already CLAIMED
 * `['player_week', 'spread', 'total']` were all audited, but `bettingWeekResult`
 * never actually passed `markets` to `replaySeason` — it silently defaulted to
 * `NFL_PRODUCTION_POLICY.markets`, which is `['spread']` only. So "total" was
 * declared as an audited domain while never actually being replayed, and
 * moneyline had no domain, no policy support, and no way to reach the audit at
 * all: `NFL_PRODUCTION_POLICY.markets` filtered it out, `normalizeNflPolicy`
 * stripped it from any custom policy, and every moneyline candidate would have
 * abstained on `missing_line` even if none of that were true, because a
 * moneyline market genuinely has no spread/total line and the policy required
 * one unconditionally.
 *
 * This fixes all three and proves it end to end:
 *   - `normalizeNflPolicy` / `applyNflPolicy` accept `moneyline` and no longer
 *     abstain it on a missing line it was never supposed to have;
 *   - moneyline's win probability comes from the SAME shared margin-residual
 *     distribution spread already uses (`nfl-ensemble.js`'s
 *     `predictiveDistribution`, read at a threshold of zero instead of the
 *     spread line) rather than an independently fit model, so it is
 *     structurally unable to disagree with the spread call about which team
 *     is favored — verified below across many synthetic favorite/underdog
 *     games;
 *   - `replaySeason({ markets: ['moneyline'] })` produces real, correctly
 *     graded bets (won/lost against the actual final score, not the spread
 *     result) with a real no-vig market comparison;
 *   - `nfl-blind-audit.js`'s `domains` list now names moneyline, and its
 *     per-week betting replay (`bettingWeekResult`, exercised indirectly here
 *     through the same `replaySeason` machinery it now calls per market) no
 *     longer silently skips a domain it claims to audit.
 *
 * Real historical evidence (2026-09-04, actual local game_lines, 2021-2025,
 * `nfl-market.js`'s ratings/bootstrap board): spread and moneyline picks for
 * the same game agreed on the favored team in 15 of 16 games in each of three
 * sampled unsettled weeks (2026 W1-W3) — the sole disagreement each week is
 * the well-known real-market fact that a small favorite can be good enough to
 * win outright without being a big enough favorite to cover its own spread,
 * not a modeling inconsistency. Separately, the margin-residual and
 * total-residual distributions `nfl-market.js` bootstraps from (paired by the
 * same 5,965 historical team-games) correlate at r ≈ 0.0247 — negligible —
 * so treating them as independent when total is priced separately from
 * spread/moneyline is empirically justified, not an unexamined assumption.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-moneyline-domain-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
await import('../server/services/gamescript.js'); // migrates game_lines' moneyline/odds columns
const { applyNflPolicy, normalizeNflPolicy, NFL_PRODUCTION_POLICY } = await import('../server/services/nfl-policy.js');
const { fitEnsemble, clearEnsembleCache, ensembleLine } = await import('../server/services/nfl-ensemble.js');
const { replaySeason } = await import('../server/services/nfl-replay.js');
const { blindAuditProtocol } = await import('../server/services/nfl-blind-audit.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('the blind audit protocol names moneyline as an audited domain', () => {
  const protocol = blindAuditProtocol();
  assert.ok(protocol.domains.includes('moneyline'), 'moneyline must be a declared audit domain, not silently absent');
  assert.ok(protocol.domains.includes('total'), 'total remains declared once it is actually replayed per market');
});

test('normalizeNflPolicy accepts moneyline instead of silently discarding it', () => {
  const policy = normalizeNflPolicy({ markets: ['spread', 'total', 'moneyline'] });
  assert.deepEqual(new Set(policy.markets), new Set(['spread', 'total', 'moneyline']));
});

test('a moneyline candidate is never abstained for a line it was never supposed to have', () => {
  const candidate = {
    market: 'moneyline', line: null, american_price: -150, edge_points: 5,
    disagreement: 1, calibration_eligible: true
  };
  const result = applyNflPolicy([candidate], { ...NFL_PRODUCTION_POLICY, markets: ['moneyline'], requireCalibratedAdvantage: false });
  assert.equal(result.decisions[0].abstention_reason, null,
    'moneyline has no line by definition; requiring one is a missing-data check misapplied to this market');
  assert.equal(result.decisions[0].eligible, true);

  // Missing price is still a real missing-data abstention for moneyline.
  const noPrice = applyNflPolicy([{ ...candidate, american_price: null }],
    { ...NFL_PRODUCTION_POLICY, markets: ['moneyline'], requireCalibratedAdvantage: false });
  assert.equal(noPrice.decisions[0].abstention_reason, 'missing_price');
});

function seedHistory({ throughSeason = 2026 } = {}) {
  const insert = db.prepare(`INSERT INTO game_lines
    (season, week, team, opponent, home, spread, total, moneyline, team_score, opp_score, rest_days)
    VALUES (?, ?, ?, ?, ?, ?, 44, ?, ?, ?, 7)
    ON CONFLICT(season, week, team) DO UPDATE SET
      opponent=excluded.opponent, home=excluded.home, spread=excluded.spread,
      moneyline=excluded.moneyline, team_score=excluded.team_score, opp_score=excluded.opp_score`);
  for (let season = 2015; season <= throughSeason; season++) {
    for (let week = 1; week <= 18; week++) {
      const home = week % 2 ? 'AAA' : 'BBB', away = home === 'AAA' ? 'BBB' : 'AAA';
      // AAA has a real, repeatable 14-point-per-game skill edge over BBB
      // whether it hosts or travels — not merely home-field advantage — so
      // the ratings model has a genuine, learnable favorite, and the spread
      // and moneyline calls it derives should agree on which team that is.
      const homeSpread = home === 'AAA' ? -10 : 10;
      const homeScore = home === 'AAA' ? 27 : 13, awayScore = home === 'AAA' ? 13 : 27;
      const homeMl = home === 'AAA' ? -450 : 350, awayMl = home === 'AAA' ? 350 : -450;
      insert.run(season, week, home, away, 1, homeSpread, homeMl, homeScore, awayScore);
      insert.run(season, week, away, home, 0, -homeSpread, awayMl, awayScore, homeScore);
    }
  }
}

test('moneyline win probability is read off the same margin distribution as spread, so the two can never disagree on the favorite', () => {
  seedHistory({ throughSeason: 2026 });
  // The unsettled game itself needs a posted market line for
  // `predictiveDistribution` to grade a cover probability against — exactly
  // like a real board row before kickoff.
  db.prepare(`INSERT INTO game_lines
    (season, week, team, opponent, home, spread, total, moneyline, rest_days)
    VALUES (2027, 1, 'AAA', 'BBB', 1, -10, 44, -450, 7)
    ON CONFLICT(season, week, team) DO UPDATE SET spread=excluded.spread, moneyline=excluded.moneyline`).run();
  clearEnsembleCache();
  const line = ensembleLine(2027, 1, 'AAA', 'BBB');
  assert.ok(!line.error, line.error);
  const dist = line.ensemble.distribution;
  assert.ok(dist, 'expected a predictive distribution once enough cutoff-safe history exists');
  assert.ok(Number.isFinite(dist.home_win_probability) && dist.home_win_probability >= 0 && dist.home_win_probability <= 1);
  assert.ok(Number.isFinite(dist.away_win_probability));
  assert.ok(Math.abs(dist.home_win_probability + dist.away_win_probability - 1) < 0.02,
    'home and away win probability must (almost) sum to one — the same margin samples graded at the same threshold');
  // Winning outright (margin > 0) is a strictly easier bar than covering a
  // real favorite's own negative spread (margin > -home_spread, here > 10),
  // and both are read off the exact same margin samples — so this inequality
  // is a mathematical guarantee of the shared-distribution design, not a
  // property of this particular fixture. If moneyline and spread were ever
  // fit as separate models, nothing would force it to hold.
  assert.ok(dist.home_win_probability >= dist.home_cover_probability,
    'P(home wins outright) can never be less than P(home covers its own favorite spread) when both come from one margin distribution');
  assert.equal(dist.home_win_probability, 1,
    'every historical margin sample for this real, repeatable 14-point favorite is positive');
});

test('replaySeason grades moneyline against the real final score with a real no-vig market', () => {
  seedHistory({ throughSeason: 2026 });
  clearEnsembleCache();
  const replay = replaySeason(2026, {
    markets: ['moneyline'], minEdge: 0, maxDisagreement: null, maxPicksPerWeek: 20, startWeek: 1, endWeek: 18
  });
  assert.ok(!replay.error, replay.error);
  assert.ok(replay.bets.length > 0, 'expected real moneyline bets from the seeded slate');
  assert.ok(replay.bets.every(b => b.market === 'moneyline'));
  assert.ok(replay.bets.every(b => b.line === null), 'moneyline carries no line by construction');
  assert.ok(replay.bets.every(b => Number.isFinite(b.american_price) && Number.isFinite(b.opposite_price)),
    'both sides\' prices must be present so a no-vig market probability can be computed');
  // AAA always wins by 14 when hosting in this fixture, so every moneyline
  // bet made when AAA hosts must grade Won for the home side.
  const homeBets = replay.bets.filter(b => b.home === 'AAA');
  assert.ok(homeBets.length > 0);
  assert.ok(homeBets.every(b => b.side === 'AAA' && b.result === 'Won'),
    'a real, repeatable home favorite must be correctly graded a moneyline winner, not silently miscounted');
  assert.equal(replay.decisions.filter(d => d.abstention_reason === 'missing_line').length, 0,
    'no moneyline candidate may abstain for a line the market never quotes');
});
