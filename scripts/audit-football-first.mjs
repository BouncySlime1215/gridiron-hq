#!/usr/bin/env node
/**
 * Does football-first beat the closing line?
 *
 *   node scripts/audit-football-first.mjs
 *
 * Every forecasting attempt in this codebase has been nineteen statistical
 * estimators arguing about a number, measured at 46.5% against a 52.38%
 * break-even. `football-first.js` inverts that: it starts from football facts
 * with mechanical consequences — who is hurt, how a staff calls plays, whether
 * the wind is up — and regresses them against the market's own residual, which
 * is the only target that can contain an edge.
 *
 * The in-sample fit explains 0.6% of that residual. That is small by any normal
 * standard and it is not obviously fatal here: a closing line is close to
 * unbeatable, most of what remains after it is genuine randomness, and a real
 * edge of the size anyone actually finds would look exactly this small. The
 * question is whether the remainder is real, and only an out-of-sample test at
 * the price answers it.
 *
 * THE DESIGN:
 *
 *   FITTED ON PRIOR SEASONS ONLY. Each held-out season is scored by a model that
 *   never saw it. Fitting and scoring on the same games would produce a
 *   beautiful result and no information.
 *
 *   AGAINST THE CLOSING NUMBER. Not the opener. Beating an opener is a claim
 *   about latency, not knowledge.
 *
 *   THE REAL BAR. 52.38% at -110. A 51% signal loses money, and calling it
 *   "better than a coin flip" is how this analysis flatters itself.
 *
 *   A THRESHOLD, PREREGISTERED. Betting every game dilutes any signal into the
 *   noise around it, so only leans above a stated size are taken — and the size
 *   is chosen before the result is seen, not after.
 */
import { rows } from '../server/db/index.js';
import { footballFirstLean } from '../server/services/football-first.js';
import { preregister, runAudit } from '../server/services/audit-registry.js';

const BREAK_EVEN = 0.5238;
const MIN_LEAN = 1.0;          // points of market error before a bet is taken
// Held out as widely as the weekly-feature table allows. Each season is scored
// by a model fitted on the five seasons before it, so 2021 is the earliest that
// can be scored against features starting in 2016.
//
// This is deliberately a SECOND LOOK at a hypothesis already tested on 2024-25,
// where it came back 33-24 (57.89%) at z = 0.834 — promising and not
// significant. A second look is legitimate only if it is counted, so it is filed
// as a new preregistration rather than quietly rerun, and the registry will
// charge it against the multiple-comparisons correction.
const HELD_OUT = [2021, 2022, 2023, 2024, 2025];

console.log('\n  Football-first against the closing line — preregistered audit\n');
console.log(`  Held-out seasons: ${HELD_OUT.join(', ')}`);
console.log(`  Minimum lean: ${MIN_LEAN} points\n`);

const filed = preregister({
  name: 'football-first beats the closing spread (five held-out seasons)',
  hypothesis:
    'A model built from football facts — usage-weighted injury differential, efficiency-minus-' +
    'results, pace, staff tendency against likely game script, wind and rest — fitted against the ' +
    'market residual on prior seasons only, picks spread winners above the -110 break-even rate on ' +
    `held-out seasons when its lean exceeds ${MIN_LEAN} points. Second look at the 2024-25 result ` +
    '(33-24, 57.89%, z = 0.834) on a larger held-out sample; filed separately so the registry ' +
    'counts it.',
  metric: 'ats_win_rate',
  direction: 'above',
  threshold: BREAK_EVEN,
  requireSignificance: true
});
if (filed.error) { console.error('  preregistration failed:', filed.error); process.exit(1); }
console.log(`  Filed as audit #${filed.audit_id}\n`);

const result = await runAudit(filed.audit_id, async () => {
  const bets = [];
  for (const season of HELD_OUT) {
    const games = rows(
      `SELECT season, week, team home, opponent away, spread, team_score, opp_score
       FROM game_lines
       WHERE home = 1 AND season = ? AND week >= 5
         AND spread IS NOT NULL AND team_score IS NOT NULL
       ORDER BY week`, season);

    for (const g of games) {
      // The model for season N is fitted on seasons before N — see residualModel.
      const lean = footballFirstLean(g.season, g.week, g.home, g.away, { target: 'margin' });
      if (lean.error || lean.lean_points == null) continue;
      if (Math.abs(lean.lean_points) < MIN_LEAN) continue;

      const marketMargin = -g.spread;
      const actualMargin = g.team_score - g.opp_score;
      const cover = actualMargin - marketMargin;
      if (cover === 0) continue;                      // push

      const backedHome = lean.lean_points > 0;
      const won = backedHome ? cover > 0 : cover < 0;
      bets.push({
        season, week: g.week, side: backedHome ? g.home : g.away,
        lean: lean.lean_points, leading_reason: lean.leading_reason,
        won: won ? 1 : 0
      });
    }
  }

  const n = bets.length;
  const wins = bets.reduce((s, b) => s + b.won, 0);
  const rate = n ? wins / n : 0;
  const se = n ? Math.sqrt(BREAK_EVEN * (1 - BREAK_EVEN) / n) : 1;
  const z = n ? (rate - BREAK_EVEN) / se : 0;

  // Which football fact led the picks that were taken, so a positive or negative
  // result can be attributed rather than just recorded.
  const byReason = {};
  for (const b of bets) {
    const k = b.leading_reason ?? 'unattributed';
    byReason[k] ??= { n: 0, wins: 0 };
    byReason[k].n++; byReason[k].wins += b.won;
  }

  return {
    observed: rate,
    sampleSize: n,
    pValue: 1 - normalCdf(z),
    detail: {
      bets: n, wins, losses: n - wins,
      win_rate: +rate.toFixed(4),
      z: +z.toFixed(3),
      vs_break_even_pp: +((rate - BREAK_EVEN) * 100).toFixed(2),
      min_lean: MIN_LEAN,
      seasons: HELD_OUT.join(','),
      by_leading_reason: Object.fromEntries(Object.entries(byReason).map(([k, v]) =>
        [k, { n: v.n, win_rate: +(v.wins / v.n).toFixed(3) }]))
    }
  };
});

if (result.error) { console.error('  audit error:', result.error); process.exit(1); }

const d = result.detail_json
  ? (typeof result.detail_json === 'string' ? JSON.parse(result.detail_json) : result.detail_json)
  : (result.detail ?? {});

console.log('  RESULT');
console.log(`    bets            ${d.bets}`);
console.log(`    record          ${d.wins}-${d.losses}`);
console.log(`    win rate        ${(d.win_rate * 100).toFixed(2)}%`);
console.log(`    break-even      ${(BREAK_EVEN * 100).toFixed(2)}%  (-110)`);
console.log(`    vs break-even   ${d.vs_break_even_pp > 0 ? '+' : ''}${d.vs_break_even_pp} pp`);
console.log(`    z               ${d.z}`);
console.log('\n  BY LEADING FOOTBALL REASON');
for (const [reason, v] of Object.entries(d.by_leading_reason ?? {})) {
  console.log(`    ${reason.padEnd(38)} ${(v.win_rate * 100).toFixed(1)}%  n=${v.n}`);
}
console.log(`\n    VERDICT         ${result.passed ? 'PASS' : 'FAIL'}`);
console.log(`\n  ${result.note ?? ''}\n`);

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d2 = 0.3989423 * Math.exp(-z * z / 2);
  const p = d2 * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
