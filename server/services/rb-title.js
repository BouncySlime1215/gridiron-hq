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
 * correlations between the two lineups are kept). U1c: the games of one round are
 * integrated jointly from the same runs (they share NFL weeks); rounds are different NFL
 * weeks, which the sim draws independently, so they combine as independent.
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

/**
 * @param ids        every team that can make the field
 * @param runs       number of simulated runs whose playoff weeks are pooled
 * @param roundWeeks the league's playoff_weeks: NFL weeks per bracket round
 * @param reseed     the league's reseed rule (as playBracket)
 * @param rawPoints  (id, week, run) -> that team's lineup points WITHOUT its team offset
 * @returns { probs(field, offsets) -> Map<id, P(title)> }; `offsets` is the run's
 *          per-week team offset Map, or null when there is none.
 *
 * U1c: each round's games are integrated JOINTLY. A round's games share NFL weeks (same-game
 * copula, game shocks), so their winners are not independent; the probability of each pattern
 * of winners is counted over the same-run outcomes of every game in the round (2^games patterns,
 * one pass over the runs). Rounds are different NFL weeks and stay independent.
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

  const size = 2 ** roundWeeks.length;
  const order = bracketOrder(size);
  const memo = new Map();
  const patternMemo = new Map();

  /**
   * P(each pattern of winners) for one round's games, over the same runs. games: [[a, b, gap, aBetter]];
   * bit g of a pattern is 1 when game g's first team wins (its score beats b's by more than the
   * gap; a tie goes to the better seed).
   */
  function patterns(r, games, cacheKey) {
    if (cacheKey != null && patternMemo.has(cacheKey)) return patternMemo.get(cacheKey);
    const counts = new Float64Array(2 ** games.length);
    const xs = games.map(([a, b]) => [totals.get(a)[r], totals.get(b)[r]]);
    for (let k = 0; k < runs; k++) {
      let bits = 0;
      for (let g = 0; g < games.length; g++) {
        const d = xs[g][0][k] - xs[g][1][k], gap = games[g][2];
        if (d > gap || (d === gap && games[g][3])) bits |= 1 << g;
      }
      counts[bits]++;
    }
    for (let i = 0; i < counts.length; i++) counts[i] /= runs;
    if (cacheKey != null) patternMemo.set(cacheKey, counts);
    return counts;
  }

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
      const games = [];
      for (let i = 0; i < slots.length; i += 2) {
        const a = slots[i], b = slots[i + 1];
        if (a && b) games.push([a, b, (off(b) - off(a)) * nWeeks, seedOf.get(a) < seedOf.get(b)]);
      }
      // Seeds only break ties, so with no offsets the pattern table depends on the pairings alone.
      const cacheKey = offsets ? null : `${r}\u0001${games.map(g => `${g[0]}\u0002${g[1]}\u0002${g[3] ? 1 : 0}`).join('\u0001')}`;
      const dist = patterns(r, games, cacheKey);
      for (let bits = 0; bits < dist.length; bits++) {
        const p = dist[bits];
        if (!p) continue;
        const next = [];
        let g = 0;
        for (let i = 0; i < slots.length; i += 2) {
          const a = slots[i], b = slots[i + 1];
          if (a && b) { next.push((bits >> g) & 1 ? a : b); g++; } else next.push(a ?? b ?? null);
        }
        round(next, r + 1, weight * p);
      }
    };
    round(order.map(seed => (seed <= field.length ? field[seed - 1] : null)), 0, 1);
    if (key != null) memo.set(key, out);
    return out;
  }

  return { probs };
}

/**
 * U1b RB-SE: the number of independent batches behind the conditional estimate's SE.
 * Every run's conditional probability is computed from one pooled set of playoff-week scores,
 * whose error is shared across runs, so meanInterval's independent-runs SE understates (1.0x on
 * 4-team brackets to 2.75x on 8-team; docs/tdd/2026-09-25-u1-rb-title-on.tdd.md). Each batch
 * instead builds its OWN pool from its own runs; the batch means are independent, and
 * sd(batch means) / sqrt(B) is the SE of the full-pool mean (both variance parts scale 1/n).
 */
export const RB_SE_BATCHES = 20;

/** Which batch run k of `runs` falls in (contiguous, near-equal batches). */
export const batchOf = (k, runs, batches) => Math.floor((k * batches) / runs);

/** SE of a mean from B independent batch means: sd(batch means) / sqrt(B). */
export function batchSe(batchMeans) {
  const b = batchMeans.length;
  if (b < 2) return null;
  let sum = 0, sq = 0;
  for (const v of batchMeans) { sum += v; sq += v * v; }
  const m = sum / b;
  return Math.sqrt(Math.max(0, (sq - b * m * m) / (b - 1)) / b);
}

/** SE of a paired difference from the two arms' batch means (same runs, same batches). */
export function batchPairedSe(before, after) {
  if (!before || !after || before.length !== after.length) return null;
  return batchSe(Float64Array.from(after, (v, i) => v - before[i]));
}

/** The served interval: full-pool mean, batch SE, normal 95% interval. */
export function batchInterval(mean, batchMeans) {
  const se = batchSe(batchMeans);
  if (se == null) return { mean, se: null, ci: [null, null] };
  return { mean, se,
    ci: [+Math.max(0, mean - 1.96 * se).toFixed(4), +Math.min(1, mean + 1.96 * se).toFixed(4)] };
}
