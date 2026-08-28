/**
 * What happened on the games the model refused to bet.
 *
 * The production policy abstains constantly — it declined all 16 games in the
 * current week. Every one of those refusals is a labelled counterfactual: the
 * model looked, said no, and the game was played anyway. Nothing has ever
 * scored the road not taken, so "the policy is appropriately humble" and "the
 * policy is uselessly timid" have been indistinguishable.
 *
 * They are distinguishable, and cheaply, because `replaySeason` already grades
 * every candidate it considers — including the ones `applyNflPolicy` rejects —
 * and attaches the real result to each. The outcome of every abstention has
 * been sitting in that return value ungraded the whole time.
 *
 * What this can and cannot say:
 *
 *   CAN   — whether a specific abstention rule (edge floor, disagreement
 *           ceiling, weekly cap) declined bets that would collectively have
 *           beaten the real break-even.
 *   CANNOT — establish that relaxing the rule is +EV going forward. This is a
 *           backward-looking audit on data the ensemble was fitted near, so a
 *           rule that looks costly here is a HYPOTHESIS for a walk-forward
 *           test, never a licence to widen the policy.
 */
import { replaySeason } from './nfl-replay.js';
import { realBreakEven } from './nfl-execution-edge.js';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/** Payout at the real historical price — the same settlement the replay uses. */
const unitsFor = (won, pushed, price) => {
  if (pushed) return 0;
  if (!Number.isFinite(price)) return null;
  if (!won) return -1;
  return price > 0 ? price / 100 : 100 / Math.abs(price);
};

/**
 * Wilson score interval — the right interval for a win rate.
 *
 * The textbook normal approximation (p ± 1.96·√(p(1−p)/n)) misbehaves badly at
 * the sample sizes here, and every claim on this page is a proportion measured
 * on a few hundred bets. Wilson stays honest at small n and near the extremes.
 */
function wilson(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [r4(centre - half), r4(centre + half)];
}

/**
 * Two-proportion z-test. Answers the only question that matters here: is the
 * pool the policy PICKED actually better than the pool it REFUSED, or is the
 * difference the size you would expect from chance at this sample size?
 */
function twoProportion(winsA, nA, winsB, nB) {
  if (!nA || !nB) return null;
  const pA = winsA / nA, pB = winsB / nB;
  const pooled = (winsA + winsB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (!(se > 0)) return null;
  const z = (pA - pB) / se;
  // Two-sided p from the normal tail, via a standard erf approximation.
  const erf = x => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  };
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return { difference: r4(pA - pB), z: r4(z), p_value: r4(p), significant: p < 0.05 };
}

function summarize(rows) {
  const settled = rows.filter(d => d.result === 'Won' || d.result === 'Lost');
  const priced = settled.map(d => unitsFor(d.won, d.pushed, d.american_price)).filter(u => u != null);
  const wins = settled.filter(d => d.result === 'Won').length;
  const units = priced.reduce((s, u) => s + u, 0);
  return {
    n: rows.length,
    settled: settled.length,
    wins, losses: settled.length - wins,
    win_rate: settled.length ? r4(wins / settled.length) : null,
    // Reported next to every rate so a headline number can never be read
    // without the width of the claim attached to it.
    win_rate_95: wilson(wins, settled.length),
    units: r4(units),
    // ROI on turnover — the number that decides whether a rule cost money.
    roi: priced.length ? r4(units / priced.length) : null
  };
}

/**
 * Grade every decision the policy made across a set of seasons, split by what
 * the policy did with it.
 *
 * @param seasons which seasons to replay. Defaults to the opened development
 *   window; these are seasons the ensemble has effectively seen, which is
 *   exactly why the output is a hypothesis generator rather than evidence.
 */
// A full five-season replay takes over a minute of synchronous CPU, which on a
// single-threaded server blocks every other request. Memoised per parameter set
// and cleared with the model cache.
const _cache = new Map();
export function clearAbstentionAuditCache() { _cache.clear(); }

export function abstentionAudit({ seasons = [2021, 2022, 2023, 2024, 2025], markets = ['spread'] } = {}) {
  const key = `${seasons.join(',')}|${markets.join(',')}`;
  if (_cache.has(key)) return _cache.get(key);
  const value = computeAbstentionAudit({ seasons, markets });
  _cache.set(key, value);
  return value;
}

function computeAbstentionAudit({ seasons, markets }) {
  const all = [];
  const perSeason = [];
  for (const season of seasons) {
    const replay = replaySeason(season, { markets });
    if (replay.error) { perSeason.push({ season, error: replay.error }); continue; }
    const decisions = (replay.decisions ?? []).map(d => ({ ...d, season }));
    all.push(...decisions);
    perSeason.push({ season, decisions: decisions.length,
      taken: decisions.filter(d => d.eligible).length });
  }
  if (!all.length) return { error: 'no decisions could be replayed for those seasons' };

  const taken = all.filter(d => d.eligible);
  const declined = all.filter(d => !d.eligible);

  // Group the refusals by the rule that caused them. A rule that declines bets
  // which collectively beat break-even is the one worth interrogating.
  const byReason = new Map();
  for (const d of declined) {
    const key = d.abstention_reason ?? 'unspecified';
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(d);
  }

  const be = realBreakEven();
  const breakEven = be?.real_breakeven ?? 0.5238;

  const reasons = [...byReason.entries()]
    .map(([reason, rows]) => {
      const s = summarize(rows);
      return {
        reason, ...s,
        // Did declining these actually save money, or cost it?
        // A rate above break-even means nothing if the interval still contains
        // it. Only a lower bound clear of break-even is a real finding.
        beat_break_even: s.win_rate_95 ? s.win_rate_95[0] > breakEven : null,
        verdict: s.settled < 100 ? 'sample too small to read'
          : s.win_rate_95 && s.win_rate_95[0] > breakEven
            ? 'DECLINED A PROFITABLE POOL — worth a walk-forward test'
          : s.win_rate > breakEven
            ? 'point estimate beats break-even but the interval does not clear it'
          : 'correctly declined'
      };
    })
    .sort((a, b) => (b.settled ?? 0) - (a.settled ?? 0));

  return {
    seasons, markets, per_season: perSeason,
    break_even: r4(breakEven),
    taken: summarize(taken),
    declined: summarize(declined),
    by_reason: reasons,
    // The headline comparison: is the stuff we bet actually better than the
    // stuff we refused? If not, the selection rule is adding nothing.
    selection_works: (() => {
      const t = summarize(taken), d = summarize(declined);
      if (t.win_rate == null || d.win_rate == null) return null;
      const test = twoProportion(t.wins, t.settled, d.wins, d.settled);
      return {
        taken_win_rate: t.win_rate, taken_95: t.win_rate_95,
        declined_win_rate: d.win_rate, declined_95: d.win_rate_95,
        edge_from_selection: r4(t.win_rate - d.win_rate),
        test,
        verdict: !test ? 'not testable'
          : test.significant
            ? (test.difference > 0
              ? 'Selection genuinely helps — picked games beat refused ones.'
              : 'Selection is ANTI-PREDICTIVE — the games it picked did significantly worse than the ones it refused.')
          : 'No measurable selection skill in either direction at this sample size.'
      };
    })(),
    note: 'Backward-looking on seasons the ensemble was fitted near. A rule that looks ' +
      'expensive here is a hypothesis for a walk-forward test, never a licence to widen ' +
      'the policy — every signal that skipped that step in this project degraded the pipeline.'
  };
}
