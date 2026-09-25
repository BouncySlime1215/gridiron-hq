/**
 * RB-TITLE: the conditional (Rao-Blackwellised) title event for the season sim.
 *
 * Plain Monte Carlo scores a run's title as 1 for the one team that won that run's
 * bracket and 0 for everyone else. At league 4's title odds (0.1-1%), 1,200 runs hold a
 * handful of wins, so a trade's title delta sits inside its own noise.
 *
 * The conditional estimator keeps everything a run decided before the playoffs (the
 * field, its seeding, each team's AVAIL-HORIZON strength offset) and replaces the one
 * bracket that run played with the exact probability of each team winning that bracket,
 * computed from every run's playoff-week scores:
 *
 *   title_i(run) = P(i wins the bracket | field(run), offsets(run))
 *
 * Each game's win probability is P(S_a - S_b > offset gap) over the same-run score
 * differences of the two teams in that round's NFL weeks (all runs, so same-game
 * correlations between the two lineups are kept). Games are combined across the
 * bracket as independent. Rounds are different NFL weeks, which the sim draws
 * independently; games inside one round share a week, and treating them as independent
 * is the one approximation (the r50 harness in test/rb-title.test.js checks it for bias).
 *
 * The expectation is unchanged (it is E[1{title} | regular season]), the variance only
 * drops. Measured r50 (2026-09-24): SE 0.40x on title levels, 0.34x on paired deltas.
 *
 * GRIDIRON_RB_TITLE: unset / '0' = off (the sim is byte-identical to before);
 * 'shadow' = computed and carried beside the served odds (title_odds_rb), never served;
 * '1' = served. Preview mode does NOT turn it on: it moves a served number.
 */

export const RB_TITLE_ENV = 'GRIDIRON_RB_TITLE';

/** 'off' | 'shadow' | 'on', read per call so a test or a run can flip it. */
export function rbTitleMode() {
  const v = process.env[RB_TITLE_ENV];
  if (v === '1' || v === 'on') return 'on';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/**
 * Standard bracket positions for a power-of-two field: 1,8,4,5,2,7,3,6 for 8.
 * A copy of season-sim.js#bracketOrder (that module imports this one); the parity test
 * in test/rb-title.test.js plays both on the same scores.
 */
function bracketOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap(seed => [seed, n + 1 - seed]);
  }
  return order;
}

/** Count of sorted values < x and <= x. */
function ranks(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  const below = lo;
  hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; }
  return [below, lo];
}

/**
 * @param ids        every team that can make the field
 * @param runs       number of simulated runs whose playoff weeks are pooled
 * @param roundWeeks the league's playoff_weeks: NFL weeks per bracket round
 * @param reseed     the league's reseed rule (as playBracket)
 * @param rawPoints  (id, week, run) -> that team's lineup points WITHOUT its team offset
 * @returns { probs(field, offsets) -> Map<id, P(title)> }; `offsets` is the run's
 *          per-week team offset Map, or null when there is none.
 */
export function conditionalTitle({ ids, runs, roundWeeks, reseed, rawPoints }) {
  // Each team's round total per run: round -> Float64Array[run].
  const totals = new Map(ids.map(id => [id, roundWeeks.map(weeks => {
    const arr = new Float64Array(runs);
    for (let k = 0; k < runs; k++) {
      let s = 0;
      for (const w of weeks) s += rawPoints(id, w, k);
      arr[k] = s;
    }
    return arr;
  })]));
  const diffs = new Map();
  /** Sorted same-run differences a - b in round r. */
  const diffOf = (a, b, r) => {
    const key = `${a}\u0001${b}\u0001${r}`;
    let d = diffs.get(key);
    if (!d) {
      const xa = totals.get(a)[r], xb = totals.get(b)[r];
      d = new Float64Array(runs);
      for (let k = 0; k < runs; k++) d[k] = xa[k] - xb[k];
      d.sort();
      diffs.set(key, d);
    }
    return d;
  };
  /** P(a beats b in round r): its score beats b's by more than the offset gap; a tie goes to the better seed. */
  const winProb = (a, b, r, gap, aBetter) => {
    const [below, atOrBelow] = ranks(diffOf(a, b, r), gap);
    return (runs - atOrBelow + (aBetter ? atOrBelow - below : 0)) / runs;
  };

  const size = 2 ** roundWeeks.length;
  const order = bracketOrder(size);
  const memo = new Map();

  function probs(field, offsets) {
    const key = offsets ? null : field.join('\u0001');
    if (key != null && memo.has(key)) return memo.get(key);
    const seedOf = new Map(field.map((id, i) => [id, i]));
    const out = new Map(ids.map(id => [id, 0]));
    const off = id => (offsets ? offsets.get(id) ?? 0 : 0);

    const round = (slots, r, weight) => {
      if (r === roundWeeks.length) {
        const champ = slots.find(Boolean);
        if (champ != null) out.set(champ, (out.get(champ) ?? 0) + weight);
        return;
      }
      if (reseed && r > 0) {
        const alive = slots.filter(Boolean).sort((a, b) => seedOf.get(a) - seedOf.get(b));
        slots = [];
        while (alive.length > 1) slots.push(alive.shift(), alive.pop());
        if (alive.length) slots.push(alive[0], null);
      }
      const nWeeks = roundWeeks[r].length;
      const game = (i, next, w) => {
        if (i >= slots.length) { round(next, r + 1, w); return; }
        const a = slots[i], b = slots[i + 1];
        if (!a || !b) { game(i + 2, [...next, a ?? b ?? null], w); return; }
        const p = winProb(a, b, r, (off(b) - off(a)) * nWeeks, seedOf.get(a) < seedOf.get(b));
        if (p > 0) game(i + 2, [...next, a], w * p);
        if (p < 1) game(i + 2, [...next, b], w * (1 - p));
      };
      game(0, [], weight);
    };
    round(order.map(seed => (seed <= field.length ? field[seed - 1] : null)), 0, 1);
    if (key != null) memo.set(key, out);
    return out;
  }

  return { probs };
}

/** Mean, its standard error and a normal 95% interval for per-run probabilities. */
export function meanInterval(sum, sq, n) {
  if (!n) return { mean: null, se: null, ci: [null, null] };
  const mean = sum / n;
  const variance = n > 1 ? Math.max(0, (sq - n * mean * mean) / (n - 1)) : 0;
  const se = Math.sqrt(variance / n);
  return {
    mean, se,
    ci: [+Math.max(0, mean - 1.96 * se).toFixed(4), +Math.min(1, mean + 1.96 * se).toFixed(4)]
  };
}
