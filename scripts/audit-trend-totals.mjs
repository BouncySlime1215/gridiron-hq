#!/usr/bin/env node
/**
 * Does a statistically real change in how a team plays beat the total?
 *
 *   node scripts/audit-trend-totals.mjs
 *
 * The trend machinery was built for fantasy, where the question is "who should I
 * start". It answers a betting question too, and a much sharper one: if an
 * offence has genuinely sped up or started throwing, and the total has not moved
 * to account for it, that is an edge. If the total HAS moved — which is the
 * likely answer, because sportsbooks employ people to notice this — then the
 * machinery is fantasy-only and it is worth knowing that before betting on it.
 *
 * This is exactly the kind of plausible idea that has failed here six times
 * already: gradient boosting on the residual, injuries in the ensemble, referee
 * assignments, formations, prediction-market flow, and the simulator itself. The
 * base rate on "surely THIS one beats the closing line" in this codebase is
 * zero, so the test is preregistered and sealed before it runs rather than
 * inspected and then written up.
 *
 * THE DESIGN, and why each choice is the strict one:
 *
 *   CUTOFF-SAFE. A trend for week N is computed only from weeks strictly before
 *   N. Using the week itself would leak the result into the signal — the single
 *   easiest way to manufacture a backtest that wins.
 *
 *   AGAINST THE CLOSING TOTAL. Not the opening line. Beating an opening number
 *   proves you are faster than the market's own updating, which is a claim about
 *   latency rather than about knowledge, and it is not a bet anyone can place at
 *   the number they got.
 *
 *   BOTH TEAMS COUNT. A game total is the sum of two offences, so a game
 *   qualifies when either side has a significant pace or efficiency trend, and
 *   the direction is the net of the two.
 *
 *   THE BAR IS THE REAL ONE. 52.38% at -110, not 50%. A signal that wins 51% of
 *   its bets loses money, and reporting it as "better than a coin flip" is how
 *   this sort of analysis flatters itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RESULT, recorded here because it is the point of having run it
 *
 * Filed as audit #13 and sealed on 30 Aug 2026 across 2016-2025:
 *
 *     194 bets, 85-109, a 43.81% win rate against a 52.38% break-even.
 *     8.57 percentage points BELOW the bar, at z = -2.39.
 *
 * Betting with a statistically real pace or efficiency trend does not merely
 * fail to beat the total, it loses significantly. The market has already priced
 * these changes — which is the correct prior for anything a sportsbook could
 * compute from public box scores, and it is now the seventh distinct attempt in
 * this codebase to beat a closing line and the seventh failure.
 *
 * The trend machinery remains useful for FANTASY, where the opponents are nine
 * people who read box scores rather than a market that employs people to notice
 * exactly this. That distinction is the whole finding.
 *
 * A NOTE ON THE OBVIOUS TEMPTATION: if betting with the trend wins 43.8%, then
 * betting against it won 56.2%, and that looks like an edge. It is not a
 * finding, it is the same 194 games read backwards after seeing the answer.
 * Testing it requires a fresh preregistration that the registry will count
 * against the multiple-comparisons correction, and it should be run on held-out
 * seasons rather than these.
 */
import { rows, row } from '../server/db/index.js';
import { teamTrends } from '../server/services/weekly-trends.js';
import { preregister, runAudit } from '../server/services/audit-registry.js';

const LOOKBACK = 3;
const BREAK_EVEN = 0.5238;

/** Metrics whose movement should mechanically raise or lower a game total. */
const SCORING_TRENDS = [
  { key: 'off_seconds_per_drive', raisesTotal: 'down' },  // faster = more drives
  { key: 'off_plays', raisesTotal: 'up' },
  { key: 'off_epa_per_play', raisesTotal: 'up' },
  { key: 'off_no_huddle_rate', raisesTotal: 'up' },
  { key: 'off_red_zone_td_rate', raisesTotal: 'up' },
  { key: 'def_pass_epa_per_play', raisesTotal: 'up' },    // worse defence = more points
  { key: 'def_rush_epa_per_play', raisesTotal: 'up' },
  { key: 'def_red_zone_td_rate', raisesTotal: 'up' }
];

console.log('\n  Trend-based totals — preregistered audit\n');

const seasons = rows(`SELECT DISTINCT season FROM nfl_team_week_features ORDER BY season`)
  .map(r => r.season);
console.log(`  Seasons with weekly features: ${seasons.join(', ')}`);

const filed = preregister({
  name: 'team trend predicts the game total',
  hypothesis:
    'When an offence or defence has changed by more than noise over its last 3 games — measured ' +
    'cutoff-safe, corrected for multiple comparisons — betting the game total in the direction that ' +
    'change implies wins above the -110 break-even rate against the CLOSING total.',
  metric: 'total_win_rate',
  direction: 'above',
  threshold: BREAK_EVEN,
  requireSignificance: true
});
if (filed.error) { console.error('  preregistration failed:', filed.error); process.exit(1); }
console.log(`  Filed as audit #${filed.audit_id}, threshold ${BREAK_EVEN} (the real -110 bar, not 0.5)\n`);

const result = await runAudit(filed.audit_id, async () => {
  const bets = [];
  const trendCache = new Map();

  for (const season of seasons) {
    const games = rows(
      `SELECT season, week, team, opponent, total, team_score, opp_score, home
       FROM game_lines
       WHERE season = ? AND total IS NOT NULL AND team_score IS NOT NULL AND home = 1
       ORDER BY week`, season);

    for (const g of games) {
      // Cutoff-safe: trends are computed strictly BEFORE this week.
      if (g.week <= LOOKBACK + 2) continue;
      const through = g.week - 1;

      const lean = (team) => {
        const key = `${season}|${team}|${through}`;
        if (!trendCache.has(key)) {
          trendCache.set(key, teamTrends(team, season, { throughWeek: through, lookback: LOOKBACK }));
        }
        const t = trendCache.get(key);
        if (t.insufficient || !t.trends?.length) return 0;
        let net = 0;
        for (const tr of t.trends) {
          const spec = SCORING_TRENDS.find(s => s.key === tr.metric);
          if (!spec) continue;
          const raises = (tr.direction === spec.raisesTotal);
          // Weighted by effect size: a marginal trend should nudge, not decide.
          net += (raises ? 1 : -1) * Math.abs(tr.effect_size);
        }
        return net;
      };

      const net = lean(g.team) + lean(g.opponent);
      // Only bet when the combined lean is meaningful. A near-zero net is the
      // model saying it has no opinion, and betting it anyway is how a real
      // signal gets diluted into a coin flip.
      if (Math.abs(net) < 1.0) continue;

      const actual = g.team_score + g.opp_score;
      if (actual === g.total) continue;                 // push
      const wentOver = actual > g.total;
      const betOver = net > 0;
      bets.push({ season, week: g.week, team: g.team, opponent: g.opponent,
        net: +net.toFixed(2), total: g.total, actual, bet: betOver ? 'over' : 'under',
        won: betOver === wentOver ? 1 : 0 });
    }
  }

  const n = bets.length;
  const wins = bets.reduce((s, b) => s + b.won, 0);
  const rate = n ? wins / n : 0;
  // One-sided z against the break-even rate, which is the only comparison that
  // decides whether this is worth money.
  const se = n ? Math.sqrt(BREAK_EVEN * (1 - BREAK_EVEN) / n) : 1;
  const z = n ? (rate - BREAK_EVEN) / se : 0;
  const p = 1 - normalCdf(z);

  return {
    observed: rate,
    sampleSize: n,
    pValue: p,
    detail: {
      bets: n, wins, losses: n - wins,
      win_rate: +rate.toFixed(4),
      z: +z.toFixed(3),
      vs_break_even_pp: +((rate - BREAK_EVEN) * 100).toFixed(2),
      overs: bets.filter(b => b.bet === 'over').length,
      unders: bets.filter(b => b.bet === 'under').length,
      seasons: seasons.join(',')
    }
  };
});

if (result.error) { console.error('  audit error:', result.error); process.exit(1); }

// The registry stores the producer's `detail` as JSON on the sealed row and
// returns it under a different name than it was passed in. Reading `result.detail`
// printed a screen of "undefined" over a result that had recorded perfectly well,
// which is the sort of reporting bug that makes a real finding look like a crash.
const d = result.detail_json
  ? (typeof result.detail_json === 'string' ? JSON.parse(result.detail_json) : result.detail_json)
  : (result.detail ?? {});
console.log('  RESULT');
console.log(`    bets            ${d.bets}  (${d.overs} over, ${d.unders} under)`);
console.log(`    record          ${d.wins}-${d.losses}`);
console.log(`    win rate        ${(d.win_rate * 100).toFixed(2)}%`);
console.log(`    break-even      ${(BREAK_EVEN * 100).toFixed(2)}%  (-110)`);
console.log(`    vs break-even   ${d.vs_break_even_pp > 0 ? '+' : ''}${d.vs_break_even_pp} pp`);
console.log(`    z               ${d.z}`);
console.log(`    p               ${result.p_value ?? '—'}`);
console.log(`\n    VERDICT         ${result.passed ? 'PASS' : 'FAIL'}${result.significant === false ? ' (not significant)' : ''}`);
console.log(`\n  ${result.note ?? ''}\n`);

function normalCdf(z) {
  // Abramowitz & Stegun 26.2.17 — accurate to ~7.5e-8, far tighter than needed.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
