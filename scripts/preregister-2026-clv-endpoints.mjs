#!/usr/bin/env node
/**
 * u5-clv-endpoints, Step 0 item 5 — pre-register the 2026 CLV endpoints
 * before Week 3 kickoffs.
 *
 *   node scripts/preregister-2026-clv-endpoints.mjs
 *
 * This PREREGISTERS two hypotheses. It deliberately never calls runAudit():
 * the whole point of filing these now, before Week 3, is that the pass
 * criterion, the metric, and (for one of the two) the mSPRT variance are
 * locked in before this season's evidence exists to be looked at. Whoever
 * eventually grades these — likely at a declared mid-season checkpoint and
 * again at season's end, both legitimate under the always-valid check because
 * the sigma below is fixed rather than re-estimated each look — calls
 * runAudit() separately, with a producer built on
 * `executionClvReport({ includeAbstained: true })`
 * (server/services/nfl-execution-clv.js), NOT on a re-derived query of its
 * own: that function is the one place in this codebase that already grades
 * every decision — accepted or passed — against its own contract's close.
 *
 * WHY TWO HYPOTHESES, AND NOT A THIRD FOR ROI:
 *
 *   The plan is explicit that ROI cannot be decided this season — a single
 *   season's win-loss record is nowhere near the sample size a real edge
 *   needs to separate from variance at -110 (this codebase's own audits #1,
 *   #13, #14, #15 each spent a multi-season backtest to get a readable
 *   answer, and still landed inside noise more often than not). CLV is
 *   different: it is a continuous, low-variance signal available after every
 *   single decision rather than a binary win/loss after every game, so it is
 *   the one thing genuinely worth tracking from Week 1 of a live season.
 *
 * WHY THE FULL SCHEDULE, NOT JUST THE BETS TAKEN:
 *
 *   Grading only the accepted tickets (this project bets a small minority of
 *   games most weeks) answers "did the games we chose beat the close" — a
 *   question already confounded with the selection policy itself. Grading
 *   every decision, including every abstention, against the price this
 *   system actually observed before declining answers the sharper question
 *   this pre-registration exists to ask: does this system's OWN LOOK at a
 *   line, on average, beat where that line ends up, independent of whether
 *   it chose to bet it. That is `includeAbstained: true` on
 *   `executionClvReport()` (added alongside this file), and the denominator
 *   it produces should approach the 2026 regular season's 272 games as the
 *   execution pipeline logs a decision for every slate, not the roughly
 *   dozens of tickets actually accepted in a season.
 *
 * WHY POINT CLV GETS A DECLARED SIGMA AND PRICE CLV DOES NOT:
 *
 *   The plan's standing rule (backtest-significance.js's alwaysValidPValue
 *   header; scripts/governed-reevaluation.mjs's calibration-season sigma,
 *   computed and then discarded before later seasons are scored) is that an
 *   anytime-valid sequential test needs its variance fixed from a hold-out
 *   sample, not estimated from the sequence under test. server/data.sqlite
 *   (read read-only to write this file) actually HAS a hold-out sample for
 *   point movement: `game_lines.open_spread` and `.spread` (the closing
 *   number, in this schema) are both populated for 2021-2025, giving a real,
 *   development-era distribution of how far a spread moves between an early
 *   market snapshot and the close. It has NO equivalent for price: there is
 *   exactly one `spread_odds` column, never an open/close PAIR, so there is
 *   no historical juice-movement distribution to measure a sigma from. This
 *   file could invent a number for price CLV anyway, but a fabricated
 *   variance passed off as "declared in advance" is exactly the failure mode
 *   Codex correction C17 exists to prevent — it would be worse than not
 *   declaring one. So price CLV starts the season on the honest, weaker,
 *   fully-labelled `plugin_from_evaluated_sequence` / NOT-anytime-valid path
 *   (see backtest-significance.js#alwaysValidPValue), explicit and queryable
 *   on its own row via `always_valid_variance_source` rather than declared
 *   under false pretenses.
 *
 * HOW THE POINT-CLV SIGMA WAS MEASURED (reproduce with the query below):
 *
 *   SELECT spread, open_spread FROM game_lines
 *   WHERE season BETWEEN 2021 AND 2025 AND home = 1
 *     AND spread IS NOT NULL AND open_spread IS NOT NULL
 *
 *   restricted to home=1 rows deliberately: game_lines carries one row per
 *   team per game, and `open_spread` was found (while building this file) to
 *   NOT be sign-consistent on away rows — several away-team rows show a
 *   20-30+ point "move" that home-row spreads never do, which is a labelling
 *   inconsistency between the two ingestion passes, not a real line move (an
 *   NFL spread realistically moves single digits outside a season-ending
 *   news event). The home=1 subset is internally consistent and matches the
 *   convention `nfl-execution-clv.js#kickoffForEvent` already relies on.
 *
 *   n = 1394, mean(spread - open_spread) = -0.0004 (no systematic drift, as
 *   expected), sample sd = 2.5737 points. Median absolute move 1 point, p90
 *   4 points, max 15 points across those 1394 games — in line with publicly
 *   known NFL closing-line-movement figures, unlike the pre-filter number.
 *
 *   This is a deliberately CONSERVATIVE proxy, not a perfect model: our own
 *   execution pipeline looks at a line much closer to kickoff than the true
 *   open, so the real decision-to-close movement this system will face is
 *   almost certainly smaller than open-to-close. A larger sigma makes the
 *   mSPRT more conservative (harder to call significant), which is the safe
 *   direction to be wrong in here — it can undersell a real signal, never
 *   manufacture one.
 */
import { row } from '../server/db/index.js';
import { preregister } from '../server/services/audit-registry.js';

const POINT_CLV_SIGMA = 2.5737;
const POINT_CLV_SIGMA_SOURCE =
  'game_lines.spread - game_lines.open_spread, home=1 rows, seasons 2021-2025, n=1394, sample sd; ' +
  'measured 2026-09-13 while filing this preregistration, from server/data.sqlite read read-only, ' +
  'never from any 2026 game';

function assertDevelopmentEraSigmaStillHolds() {
  // A cheap sanity re-check, not a re-derivation: confirms the figure above
  // still roughly matches this database's development-era rows, so a future
  // re-run of this file (a second preregistration of the same hypothesis,
  // which the registry will count against the multiple-comparisons
  // correction exactly as any other second look does) does not silently ship
  // a stale sigma if the underlying seasons' data were ever reloaded
  // differently. Read-only; never touches season 2026.
  const stats = row(`
    SELECT COUNT(*) AS n,
           AVG(spread - open_spread) AS mean_move,
           AVG((spread - open_spread) * (spread - open_spread)) AS mean_sq
    FROM game_lines
    WHERE season BETWEEN 2021 AND 2025 AND home = 1
      AND spread IS NOT NULL AND open_spread IS NOT NULL`);
  if (!stats || stats.n < 500) {
    console.warn(`  WARNING: development-era open/close spread sample is only n=${stats?.n ?? 0} in this ` +
      'database — the declared sigma below was measured against a different (likely larger) sample. ' +
      'Re-derive it before trusting the anytime-valid gate on this filing.');
    return;
  }
  const variance = (stats.n / (stats.n - 1)) * (stats.mean_sq - stats.mean_move * stats.mean_move);
  const sd = Math.sqrt(Math.max(0, variance));
  const drift = Math.abs(sd - POINT_CLV_SIGMA) / POINT_CLV_SIGMA;
  console.log(`  development-era point-CLV sigma check: n=${stats.n}, measured sd=${sd.toFixed(4)}, ` +
    `declared=${POINT_CLV_SIGMA} (${(drift * 100).toFixed(2)}% apart)`);
  if (drift > 0.10) {
    console.warn('  WARNING: the live database disagrees with the declared sigma above by more than ' +
      '10% — re-derive POINT_CLV_SIGMA before relying on the anytime-valid label.');
  }
}

console.log('\n  Pre-registering the 2026 CLV endpoints (Step 0 item 5, before Week 3 kickoffs)\n');
assertDevelopmentEraSigmaStillHolds();

const pointClv = preregister({
  name: 'all-game point CLV, 2026 season (all decisions)',
  hypothesis:
    'Across every spread decision this system reaches in the 2026 regular season — accepted AND ' +
    'abstained, graded via executionClvReport({ includeAbstained: true }) against each contract\'s own ' +
    'close, denominator the full slate the model looked at rather than only the tickets it took — the ' +
    'mean signed point CLV (our line, or the last line observed before declining, minus the market\'s ' +
    'closing main line) is greater than zero. This is a claim about whether this system\'s OWN LOOK at a ' +
    'number beats where the market ends up, independent of the acceptance policy. NOT a claim about ROI: ' +
    'the plan is explicit that a single season cannot decide that question. sigma for the always-valid ' +
    'check is declared below from 2021-2025 development-era line movement, never from 2026 data.',
  metric: 'mean_point_clv_all_decisions',
  direction: 'above',
  threshold: 0,
  requireSignificance: true,
  declaredSigma: POINT_CLV_SIGMA,
  declaredSigmaSource: POINT_CLV_SIGMA_SOURCE
});
if (pointClv.error) { console.error(`  point-CLV preregistration failed: ${pointClv.error}`); process.exit(1); }
console.log(`  Filed point CLV as audit #${pointClv.audit_id}, ` +
  `declared sigma ${POINT_CLV_SIGMA} (${POINT_CLV_SIGMA_SOURCE})`);

const priceClv = preregister({
  name: 'all-game price CLV, 2026 season (all decisions)',
  hypothesis:
    'Across every spread decision this system reaches in the 2026 regular season — accepted AND ' +
    'abstained, graded via executionClvReport({ includeAbstained: true }) at the identical handicap the ' +
    'decision was made at — the mean price CLV in probability space (closing implied probability minus ' +
    'our own implied probability at decision time) is greater than zero: this system\'s price, on ' +
    'average, beat the vig the market closed at. NOT a claim about ROI. UNLIKE point CLV above, no sigma ' +
    'is declared here: this schema has no open/close PRICE pair for any development-era season (a single ' +
    'spread_odds column only), so there is no honest hold-out basis to fix a variance from before this ' +
    'season\'s evidence exists. Filing without one is the honest choice — the always-valid check on this ' +
    'row will report on the plugin_from_evaluated_sequence / not-anytime-valid path until a real ' +
    'development-era price-movement sample exists to declare one from, and that fact is queryable ' +
    'directly off this row rather than hidden behind a fabricated number.',
  metric: 'mean_price_clv_probability_all_decisions',
  direction: 'above',
  threshold: 0,
  requireSignificance: true
  // declaredSigma intentionally omitted — see hypothesis text above.
});
if (priceClv.error) { console.error(`  price-CLV preregistration failed: ${priceClv.error}`); process.exit(1); }
console.log(`  Filed price CLV as audit #${priceClv.audit_id}, sigma undeclared (see hypothesis text)`);

console.log('\n  Both are now sealed at the definition stage: running either seals it permanently, and a ' +
  'second look at either requires a new preregistration the registry will count against the ' +
  'multiple-comparisons correction. Neither has been run.\n');
