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
 * @param batches    U1b: number of SE batches priced beside the full pool (0 = none)
 * @returns { probs(field, offsets) -> Map<id, P(title)>, probsAll(field, offsets) -> Map<id,
 *          Float64Array[pool]> (pool 0 = all runs, 1..B = batches) }; `offsets` is the run's
 *          per-week team offset Map, or null when there is none.
 *
 * U1c: each round's games are integrated JOINTLY. A round's games share NFL weeks (same-game
 * copula, game shocks), so their winners are not independent; the probability of each pattern
 * of winners is counted over the same-run outcomes of every game in the round (2^games patterns,
 * one pass over the runs). Rounds are different NFL weeks and stay independent.
 */
export function conditionalTitle({ ids, runs, roundWeeks, reseed, rawPoints, batches = 0 }) {
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

  // U1b/U1c: pool 0 is every run; pools 1..B are the SE batches (contiguous runs, rb-title.js#batchOf),
  // each integrated on its own runs only. One recursion prices every pool at once.
  const B = Math.min(batches, runs);
  const nPools = 1 + B;
  const starts = Array.from({ length: B + 1 }, (_, b) => Math.ceil((b * runs) / B));
  const poolSize = [runs, ...Array.from({ length: B }, (_, b) => starts[b + 1] - starts[b])];
  // Runs as bits (32 per word). segs[w]: [[pool, mask]] for every pool word w's runs fall in.
  const nWords = Math.ceil(runs / 32);
  const rangeMask = (lo, hi) => (hi - lo >= 32 ? 0xffffffff : (((1 << (hi - lo)) - 1) << lo) >>> 0);
  const segs = Array.from({ length: nWords }, (_, w) => {
    const lo = 32 * w, hi = Math.min(runs, lo + 32);
    const out = [[0, rangeMask(0, hi - lo)]];
    for (let b = 0; b < B; b++) {
      const s0 = Math.max(starts[b], lo), s1 = Math.min(starts[b + 1], hi);
      if (s1 > s0) out.push([1 + b, rangeMask(s0 - lo, s1 - lo)]);
    }
    return out;
  });
  const popcount = x => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  const winMemo = new Map();
  /** Bitset of the runs in which a beats b in round r by more than `gap` (a tie goes to a when aBetter). */
  function winBits(a, b, r, gap, aBetter) {
    const key = gap === 0 ? `${a}\u0001${b}\u0001${r}\u0001${aBetter ? 1 : 0}` : null;
    if (key != null && winMemo.has(key)) return winMemo.get(key);
    const xa = totals.get(a)[r], xb = totals.get(b)[r];
    const bits = new Uint32Array(nWords);
    for (let k = 0; k < runs; k++) {
      const d = xa[k] - xb[k];
      if (d > gap || (d === gap && aBetter)) bits[k >>> 5] |= 1 << (k & 31);
    }
    if (key != null) winMemo.set(key, bits);
    return bits;
  }

  /**
   * U1c: P(each pattern of winners) of one round's games, counted over the same runs, for every pool.
   * games: [[a, b, gap, aBetter]]; bit g of a pattern is 1 when game g's first team wins.
   * Returns Float64Array[pool * 2^n + pattern].
   */
  function patterns(r, games, cacheKey) {
    if (cacheKey != null && patternMemo.has(cacheKey)) return patternMemo.get(cacheKey);
    const n = games.length, P = 2 ** n;
    const counts = new Float64Array(nPools * P);
    const wins = games.map(([a, b, gap, better]) => winBits(a, b, r, gap, better));
    const masks = new Uint32Array(P);
    for (let w = 0; w < nWords; w++) {
      masks[0] = 0xffffffff;
      let width = 1;
      for (let g = 0; g < n; g++) {
        const x = wins[g][w];
        for (let i = 0; i < width; i++) { const m = masks[i]; masks[i | (1 << g)] = (m & x) >>> 0; masks[i] = (m & ~x) >>> 0; }
        width <<= 1;
      }
      for (const [pool, seg] of segs[w]) {
        const base = pool * P;
        for (let i = 0; i < P; i++) { const m = masks[i] & seg; if (m) counts[base + i] += popcount(m); }
      }
    }
    for (let pool = 0; pool < nPools; pool++) for (let i = 0; i < P; i++) counts[pool * P + i] /= poolSize[pool];
    if (cacheKey != null) patternMemo.set(cacheKey, counts);
    return counts;
  }

  /** Map<id, Float64Array[pool]>: each team's title probability in every pool (0 = all runs). */
  function probsAll(field, offsets) {
    const key = offsets ? null : field.join('\u0001');
    if (key != null && memo.has(key)) return memo.get(key);
    const seedOf = new Map(field.map((id, i) => [id, i]));
    const out = new Map(ids.map(id => [id, new Float64Array(nPools)]));
    const off = id => (offsets ? offsets.get(id) ?? 0 : 0);

    const round = (slots, r, weight) => {
      if (r === roundWeeks.length) {
        const champ = slots.find(Boolean);
        if (champ != null) { const o = out.get(champ); for (let q = 0; q < nPools; q++) o[q] += weight[q]; }
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
      const P = 2 ** games.length;
      for (let bits = 0; bits < P; bits++) {
        const w = new Float64Array(nPools);
        let any = false;
        for (let q = 0; q < nPools; q++) { w[q] = weight[q] * dist[q * P + bits]; if (w[q]) any = true; }
        if (!any) continue;
        const next = [];
        let g = 0;
        for (let i = 0; i < slots.length; i += 2) {
          const a = slots[i], b = slots[i + 1];
          if (a && b) { next.push((bits >> g) & 1 ? a : b); g++; } else next.push(a ?? b ?? null);
        }
        round(next, r + 1, w);
      }
    };
    round(order.map(seed => (seed <= field.length ? field[seed - 1] : null)), 0, new Float64Array(nPools).fill(1));
    if (key != null) memo.set(key, out);
    return out;
  }

  /** Map<id, P(title)> on all runs' pool. */
  const probs = (field, offsets) => new Map([...probsAll(field, offsets)].map(([id, v]) => [id, v[0]]));

  return { probs, probsAll, batches: B };
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
