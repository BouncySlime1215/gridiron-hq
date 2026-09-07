/**
 * Monte Carlo lookahead for the pick on the clock.
 *
 * rankTargets() answers "who is the best value right now". This answers the
 * question that actually decides a draft: "if I take X now, what roster do I
 * end up with?" — by playing the rest of the draft out a few hundred times
 * for each candidate. Opponents pick by market rank with the same noise the
 * fitted goneBy() curve implies, filtered by what their roster still needs;
 * the user's later picks follow the same value logic the board uses.
 *
 * TWO independent sources of randomness, and it matters which is which:
 *
 *   1. DRAFT ORDER — who else gets taken before my next turn (`pickOpponent`).
 *      This is what the simulation has always had.
 *   2. PLAYER OUTCOME — what each player on the finished roster actually scores
 *      over the season. Added 2026-09-07. Until then every candidate roster was
 *      scored on deterministic `projected_points`, so the reported `sd` was the
 *      spread of *who else got drafted*, not of how anyone performed — while the
 *      feature reads to a user as "how much does this pick change my likely
 *      finished roster", which implies exactly the uncertainty it did not have.
 *      docs/BETTING_CAPABILITY_AUDIT.md, cluster 5, called this out.
 *
 * The outcome draw reuses the machinery that is already proven in this repo
 * rather than inventing a second one:
 *
 *   - dependence from `correlation.js`'s **Gaussian copula** over the archetype
 *     correlation table (position × position × same-team|opponents, tens of
 *     thousands of fitted observations), which is what `season-sim.js` already
 *     draws 10,000 correlated fantasy seasons through. A QB and his own pass
 *     catchers move together; two players on different teams do not.
 *   - marginals from `preseason-model.js`'s recalibrated **p20/p80 band**
 *     (rank-local Gaussian-weighted quantiles of realized actual/predicted
 *     ratios, ~60-63% out-of-sample coverage against a 60% nominal). The band
 *     is a *ratio* band, so it transfers onto whatever point projection the
 *     board is using. A right-skewed lognormal carries it, recentred on the
 *     point projection and calibrated to the spread the ratios actually had —
 *     see SPREAD_SD_CALIBRATION for why neither of those was free.
 *
 * The lineup is still set from *expectations* and only scored on the draw —
 * the same anti-hindsight rule `season-sim.js#lineupPoints` documents. Letting
 * the drawn season pick the starters would hand every simulated manager a
 * crystal ball and quietly reward bench depth that only pays off in hindsight.
 *
 * Deterministic for a seed. Common random numbers across candidates on BOTH
 * axes — the same simulated football season and the same draft order are used
 * for every candidate at a given iteration — which is why the outcome worlds
 * are drawn once, up front, rather than inside the per-candidate loop, and why
 * candidates are RANKED on their within-iteration difference rather than on
 * their separate means (see the blocking step at the end). Season variance is
 * an order of magnitude larger than the gaps between candidates, so ranking on
 * unpaired means would be close to a coin flip at any affordable sim count.
 *
 * Even blocked, the leading candidates are often a statistical tie: `delta_se`
 * reports the standard error of each gap so callers can say so instead of
 * manufacturing a winner.
 *
 * Not pure any more: the band curve and the correlation table are read lazily
 * (both memoised, and both already warm during a live draft). Pass `bands` to
 * keep it pure, which is what the tests do.
 */
import { slotForPick } from './espn-draft.js';
import { rosterNeeds, buildLineup, FLEX_ELIGIBLE } from './draft-assist.js';
import { correlationMatrix } from './correlation.js';
import { preseasonProjections } from './preseason-model.js';
import { cholesky, correlatedNormals, withRandomSeed } from './stats-util.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BENCH_DISCOUNT = 0.25;
const BENCH_TARGET = { QB: 1, RB: 3, WR: 3, TE: 0, K: 0, DEF: 0 };

/* ------------------------------------------------ player-outcome marginals */

/** Φ⁻¹(0.8). The band is p20/p80, so this is the half-width in standard normals. */
const Z80 = 0.8416212335729143;
/** Only these positions have a fitted band and a fitted correlation archetype. */
const DRAWN_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
/**
 * Used when the preseason model has no band for a position at all (a fresh
 * install with no history). Roughly the pooled top-200 band, deliberately on
 * the narrow side: an invented wide band would be a claim, not a fallback.
 */
const FALLBACK_BAND = { p20: 0.62, p80: 1.38 };

/**
 * (position, positional rank) → { p20, p80 } as RATIOS of the point projection.
 *
 * `preseasonProjections()` publishes p20/p80 in points, already run through
 * `spreadFor()`'s rank-local curve; dividing by the point estimate recovers the
 * ratio band, which is the form that transfers onto the board's own projection.
 * Read this way rather than by joining player ids, so a player the board knows
 * and the preseason model does not still gets his rank's band.
 */
let _bandCurve = null;
/** Test hook: the curve is process-lived, like every other model cache here. */
export function resetLookaheadBandCache() { _bandCurve = null; }

function bandCurve(season) {
  if (_bandCurve && _bandCurve.season === season) return _bandCurve.byPos;
  const byPos = new Map();
  try {
    for (const pr of preseasonProjections(season).values()) {
      if (!(pr.points > 0) || !(pr.p20 > 0) || !(pr.p80 > 0) || !pr.pos_rank) continue;
      if (!DRAWN_POSITIONS.has(pr.position)) continue;
      if (!byPos.has(pr.position)) byPos.set(pr.position, []);
      byPos.get(pr.position).push({ rank: pr.pos_rank, p20: pr.p20 / pr.points, p80: pr.p80 / pr.points });
    }
  } catch { /* no history fitted yet — FALLBACK_BAND covers it */ }
  for (const list of byPos.values()) list.sort((a, b) => a.rank - b.rank);
  _bandCurve = { season, byPos };
  return byPos;
}

/** Nearest fitted rank in the position's curve; the curve is already smooth in rank. */
function bandAt(byPos, position, posRank) {
  const list = byPos.get(position);
  if (!list?.length) return FALLBACK_BAND;
  const want = Number.isFinite(posRank) ? posRank : list[list.length - 1].rank;
  let best = list[0], bestGap = Math.abs(list[0].rank - want);
  for (const c of list) {
    const gap = Math.abs(c.rank - want);
    if (gap < bestGap) { best = c; bestGap = gap; }
    if (c.rank > want && gap > bestGap) break;
  }
  return best;
}

/**
 * `sims` correlated season "worlds": one multiplier per player per world, to be
 * applied to that player's point projection.
 *
 * The dependence is the Gaussian copula from `correlation.js` — but at SEASON
 * grain, so `opponent` is left null and only the same-team archetypes fire.
 * Two players who never share a roster are independent over a season, which is
 * very nearly true; the same-team block (QB↔WR 0.18, QB↔TE 0.16 as fitted) is
 * the stack effect this whole exercise is about.
 *
 * Two honest limitations, both conservative:
 *   - the fitted table is a WEEKLY correlation. Season totals share more
 *     structure than single weeks do (an offense that busts, busts all year),
 *     so this understates the true season-level dependence. Using the proven
 *     table unscaled beats inventing a season multiplier nobody has validated.
 *   - `pairCorrelation()` scales QB↔catcher by target share when it has one.
 *     The draft board does not carry target share, so the unscaled archetype is
 *     used and a true WR1 stack is treated the same as a WR4 stack.
 *
 * The marginal is a lognormal whose LOG-SPREAD is read off the band's two
 * quantiles — right-skewed, and, being a monotone transform of the latent
 * normal, it leaves the copula's rank dependence untouched — then recentred so
 * that E[multiplier] = 1 exactly.
 *
 * The recentring is not cosmetic, and matching the band's quantiles literally
 * was tried first and rejected. A lognormal fitted to hit p20 and p80 exactly
 * has mean exp(mu + sigma^2/2), and the band widens fast with positional rank:
 * measured on the shipped 2026 curve that mean is a well-behaved 1.02x for the
 * top 12 at a position but reaches 4.76x in the deep tail, because a symmetric
 * log-scale extrapolates an upper tail the real ratio distribution does not
 * have. Left in, the lookahead would have preferred hoarding late-round
 * lottery tickets — a changed recommendation produced by a fitting artifact.
 * Recentred, the point projection stays the expectation (this is a
 * variance-realism fix, not a new claim about who scores more) and the band
 * contributes only what it was calibrated to contribute: the spread and its
 * skew. The cost is that the drawn quantiles sit a factor exp(-sigma^2/2)
 * below the band's own — about 6-9% for a startable player.
 *
 * SIGMA_CAP then bounds the tail past where the band was ever graded (the
 * preseason model's coverage was measured on the top 150/200, not on WR90).
 */
const SIGMA_CAP = 1.0;

/**
 * How much wider a lognormal fitted through p20/p80 is than the data it was
 * fitted to, in standard deviations.
 *
 * The band's QUANTILES are well calibrated — that is what
 * docs/PRESEASON_BAND_CALIBRATION.md measured, and it holds here: over 599
 * held-out player-seasons (2023-2025, walk-forward fits, top 200, projection
 * > 20 pts) the realized 20th/80th percentiles of actual/predicted are
 * 0.569/1.419 against a band of 0.546/1.406. But a lognormal that reproduces
 * those two quantiles has 1.30x the standard deviation the ratios actually
 * have, because its upper tail is fatter than the real one — 1.20x / 1.27x /
 * 1.37x / 1.22x across positional-rank buckets 1-6 / 7-12 / 13-24 / 25-48, so
 * one constant covers the whole board. Left uncorrected the same 1.26x
 * over-dispersion shows up at roster level (17.2% simulated CV against 13.7%
 * measured on synthetic 7-starter rosters built from the realized ratios).
 *
 * So sigma is solved to reproduce the measured STANDARD DEVIATION rather than
 * to hit the two quantiles exactly. This costs less than it sounds: recentring
 * to E=1 was already pulling the fat-tailed fit's quantiles down, and the
 * corrected draw lands CLOSER to the realized band than the uncorrected one
 * (posrank 1-6: drawn p20 0.71 / p80 1.26 vs realized 0.72 / 1.34, against
 * 0.65 / 1.30 uncorrected).
 *
 * Measured, not tuned: it is a ratio read off held-out grading data.
 * `scratchpad/lookahead-variance/perplayer.mjs` reproduces the table, and
 * docs/DRAFT_LOOKAHEAD_VARIANCE.md carries it. Re-measure if the band is
 * refitted — this constant is a property of that fit, not a universal one.
 */
const SPREAD_SD_CALIBRATION = 1.30;
function outcomeWorlds(universe, { sims, seed, bandOf }) {
  if (!universe.length || !sims) return null;
  const n = universe.length;
  const L = cholesky(correlationMatrix(universe.map(p => ({
    id: p.player_id, position: p.position, team: p.team_abbr,
    // Season grain: no single opponent, and no target share on the draft board.
    opponent: null, target_share: null
  }))));

  const mu = new Float64Array(n), sd = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bandOf(universe[i]) ?? FALLBACK_BAND;
    const lo = Math.max(0.02, Math.min(0.99, b.p20));
    const hi = Math.max(lo * 1.02, b.p80);
    const raw = Math.min(SIGMA_CAP, (Math.log(hi) - Math.log(lo)) / (2 * Z80));
    // Lognormal CV implied by the band, de-inflated to the measured spread,
    // then back to the sigma that produces it.
    const cv = Math.sqrt(Math.exp(raw * raw) - 1) / SPREAD_SD_CALIBRATION;
    const s = Math.sqrt(Math.log(1 + cv * cv));
    sd[i] = s;
    mu[i] = -0.5 * s * s;   // E[exp(mu + s·Z)] = 1
  }

  // Drawn once for the whole call, before any candidate is scored: candidate A
  // and candidate B are compared inside the SAME simulated season.
  return withRandomSeed(seed, () => {
    const worlds = new Array(sims);
    for (let s = 0; s < sims; s++) {
      const z = correlatedNormals(L);
      const m = new Float64Array(n);
      for (let i = 0; i < n; i++) m[i] = Math.exp(mu[i] + sd[i] * z[i]);
      worlds[s] = m;
    }
    return worlds;
  });
}

function interest(needs, pos) {
  if ((needs.starters[pos] ?? 0) > 0) return 1;
  if (FLEX_ELIGIBLE.includes(pos) && (needs.starters.FLEX ?? 0) > 0) return 0.9;
  if ((needs.depth[pos] ?? 0) > 0) return 0.6;
  if (pos === 'K' || pos === 'DEF') return 0.05;
  return ['QB', 'TE'].includes(pos) ? 0.12 : 0.35;
}

/**
 * Roster value: starting lineup plus a discounted bench.
 *
 * `world` (a vector of season multipliers, or null) decides what everyone
 * SCORES. `buildLineup` decides who STARTS, and it sorts on `projected_points`
 * — i.e. on the expectation, before the season is known. Scoring the lineup on
 * the draw while setting it on the draw would be the hindsight bug
 * `season-sim.js#lineupPoints` exists to prevent.
 */
function rosterValue(picks, slots, replacement, world) {
  const lineup = buildLineup(picks, slots);
  const scored = p => {
    const base = p.projected_points ?? 0;
    const i = p.outcome_idx;
    return world && i != null ? base * world[i] : base;
  };
  let starters = 0;
  for (const s of lineup.starters) if (s.player) starters += scored(s.player);
  const bench = lineup.bench
    .map(p => Math.max(0, scored(p) - (replacement[p.position] ?? 0)))
    .sort((a, b) => b - a).slice(0, 4)
    .reduce((s, v) => s + v, 0);
  return starters + BENCH_DISCOUNT * bench;
}

/**
 * Narrowly exposed for deterministic regression tests, following the same
 * convention as `season-sim.js#__test`. These are the pieces whose accidental
 * breakage is silent: a copula that has quietly stopped correlating, or a
 * marginal that has quietly stopped varying, both still return numbers.
 */
export const __test = { outcomeWorlds, bandAt, rosterValue, SIGMA_CAP, FALLBACK_BAND };

/**
 * @param opts.outcomeDraws  false reverts to the pre-2026-09-07 behaviour —
 *                           deterministic `projected_points` for every player,
 *                           draft order the only randomness. Kept so the two
 *                           can be diffed on one board state.
 * @param opts.bands         (player) => { p20, p80 } ratio band, overriding the
 *                           preseason curve. Supplying it makes the call pure.
 */
export function lookahead(state, {
  sims = 200, candidates = 6, seed = 20260906, targets = [],
  outcomeDraws = true, bands = null
} = {}) {
  const { draft, on_the_clock, positions } = state;
  if (!on_the_clock.my_turn && on_the_clock.picks_until_my_turn == null) return null;
  const slots = draft.roster_slots;
  const teams = draft.team_count;
  const total = teams * draft.rounds;
  const replacement = Object.fromEntries(Object.entries(positions).map(([pos, p]) => [pos, p.replacement_points ?? 0]));

  // Pool: everything the board knows, with a usable value for players ESPN has no line for.
  const pool = state.available.map((p, i) => ({
    idx: i, player_id: p.player_id, name: p.name, position: p.position, team_abbr: p.team_abbr,
    market_rank: p.market_rank ?? (200 + i), pick_number: null,
    projected_pos_rank: p.projected_pos_rank ?? null,
    projected_points: p.projected_points ?? Math.max(0, (replacement[p.position] ?? 0) - 8 - i * 0.1)
  }));

  // Current rosters for every slot, as counts, from the board.
  const baseCounts = {};
  for (let s = 1; s <= teams; s++) baseCounts[s] = { ...(state.team_counts?.[s] ?? {}) };
  const myPicksNow = state.my_team.picks.map(p => ({ ...p }));

  /* ---------------------------------------------------- season outcome draws
   * The universe is every player who could be on my finished roster: the pool
   * AND the players I have already taken. Including the latter is not cosmetic
   * — the QB I drafted in round 3 is exactly who a round-8 WR candidate should
   * be correlated with, and it is the only way "stacking my own QB" can ever
   * show up in this number. */
  const universe = [...pool, ...myPicksNow]
    .filter(p => DRAWN_POSITIONS.has(p.position) && (p.projected_points ?? 0) > 0);

  // Positional rank drives the band's width (a WR40 is far less predictable
  // than a WR4). The board's own projected rank is a full-league rank and is
  // preferred; the fallback re-adds the players already drafted at the
  // position, since a rank inside the *remaining* pool would read every board
  // as if it were pick 1.
  const takenAtPos = {};
  for (const counts of Object.values(state.team_counts ?? {})) {
    for (const [pos, c] of Object.entries(counts ?? {})) takenAtPos[pos] = (takenAtPos[pos] ?? 0) + c;
  }
  const poolRank = {};
  for (const p of [...pool].sort((a, b) => a.market_rank - b.market_rank)) {
    poolRank[p.position] = (poolRank[p.position] ?? 0) + 1;
    p.band_pos_rank = p.projected_pos_rank ?? (poolRank[p.position] + (takenAtPos[p.position] ?? 0));
  }
  for (const p of myPicksNow) p.band_pos_rank = p.projected_pos_rank ?? (takenAtPos[p.position] ?? 24);

  universe.forEach((p, i) => { p.outcome_idx = i; });
  const curve = bands ? null : bandCurve(draft.season ?? new Date().getFullYear());
  const bandOf = bands ?? (p => bandAt(curve, p.position, p.band_pos_rank));
  const worlds = outcomeDraws ? outcomeWorlds(universe, { sims, seed, bandOf }) : null;

  // The user's decision point: the next pick they own (now, or after the
  // intervening picks are simulated).
  const firstPick = on_the_clock.pick_number;
  const myFirst = on_the_clock.my_turn ? firstPick : on_the_clock.my_upcoming_picks[0];
  if (!myFirst) return null;

  const cands = (targets.length ? targets : state.targets ?? []).slice(0, candidates);
  if (!cands.length) return null;
  const depthW = 0.5 * Math.min(1, teams / 12);
  const byProj = (a, b) => (b.projected_points ?? -1) - (a.projected_points ?? -1);

  const pickOpponent = (rng, avail, counts, round) => {
    const needs = rosterNeeds(counts, slots, teams);
    // Consider the top of the market; in the last two rounds add the best K/DEF,
    // which sit past any market cutoff but are what teams actually take then.
    const lateK = round >= draft.rounds - 1;
    const top = lateK
      ? [...avail.slice(0, 40), ...avail.filter(p => p.position === 'K' || p.position === 'DEF').sort(byProj).slice(0, 6)]
      : avail.slice(0, 40);
    const best = top[0].market_rank;
    const tau = 2.5 + best * 0.08;
    let sum = 0; const w = new Array(top.length);
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const isKD = p.position === 'K' || p.position === 'DEF';
      // K/DEF market ranks are noise: in the last two rounds treat them as
      // level with the top of the board for a team that still needs one.
      let wi = (isKD && lateK ? 1 : Math.exp(-Math.max(0, p.market_rank - best) / tau)) * interest(needs, p.position);
      if (isKD && !lateK) wi *= 0.02;
      w[i] = wi; sum += wi;
    }
    let r = rng() * sum;
    for (let i = 0; i < top.length; i++) { r -= w[i]; if (r <= 0) return top[i]; }
    return top[top.length - 1];
  };

  const pickMine = (avail, counts, round) => {
    const needs = rosterNeeds(counts, slots, teams);
    const roundsLeft = draft.rounds - round + 1;
    const flexOpen = (needs.starters.FLEX ?? 0) > 0;
    // Same candidate rule as rankTargets: top of the market, the top of each
    // position by projection, and K/DEF once the last two rounds arrive.
    const kdWanted = pos => roundsLeft <= 2 && (needs.starters[pos] ?? 0) > 0;
    const cands = new Map(avail.slice(0, 60).filter(p => !['K', 'DEF'].includes(p.position) || kdWanted(p.position)).map(p => [p.player_id, p]));
    for (const pos of ['QB', 'RB', 'WR', 'TE']) avail.filter(p => p.position === pos).sort(byProj).slice(0, 8).forEach(p => cands.set(p.player_id, p));
    for (const pos of ['K', 'DEF']) if (kdWanted(pos)) avail.filter(p => p.position === pos).sort(byProj).slice(0, 2).forEach(p => cands.set(p.player_id, p));
    let best = null, bestScore = -Infinity;
    for (const p of cands.values()) {
      const pos = p.position;
      const startsHere = (needs.starters[pos] ?? 0) > 0 || (flexOpen && FLEX_ELIGIBLE.includes(pos));
      // Same need weights as rankTargets — the simulated "me" must draft like the board.
      const needWeight = startsHere ? 1
        : (needs.depth[pos] ?? 0) > 0 ? (['QB', 'TE'].includes(pos) ? 0.4 * depthW : pos === 'RB' ? depthW + 0.05 : depthW)
        : ['QB', 'TE'].includes(pos) ? 0.03 : 0.2;
      const vorp = p.projected_points - (replacement[pos] ?? 0);
      // Mirrors rankTargets: P(used) × max(0, edge) plus a usability tie-break.
      let score = Math.max(0, vorp) * needWeight + (startsHere ? 4 : needWeight * 5)
        - 0.4 * (['K', 'DEF'].includes(pos) ? 0 : Math.min(p.market_rank, 60));
      if (pos === 'K' && roundsLeft > 1) score -= 80;
      if (pos === 'DEF' && roundsLeft > 2) score -= 60;
      // Never leave a starting slot empty for the last rounds.
      if (roundsLeft <= 2 && (needs.starters[pos] ?? 0) > 0) score += 40;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  };

  const runOne = (candidate, rng, world) => {
    const avail = pool.slice();
    const counts = Object.fromEntries(Object.entries(baseCounts).map(([s, c]) => [s, { ...c }]));
    const mine = myPicksNow.slice();
    const remove = p => { const i = avail.indexOf(p); if (i >= 0) avail.splice(i, 1); };
    const take = (slot, p, n) => {
      remove(p);
      counts[slot][p.position] = (counts[slot][p.position] ?? 0) + 1;
      if (slot === draft.my_slot) mine.push({ ...p, pick_number: n, player_id: p.player_id });
    };
    let nextExpect = null;
    for (let n = firstPick; n <= total; n++) {
      if (!avail.length) break;             // pool exhausted: score what was drafted
      const slot = slotForPick(n, teams);
      const round = Math.ceil(n / teams);
      if (slot === draft.my_slot) {
        if (n === myFirst) {
          const c = avail.find(p => p.player_id === candidate.player_id);
          if (!c) return null;             // sniped before my turn in this world
          take(slot, c, n);
        } else {
          if (nextExpect === null) nextExpect = avail.slice(0, 30);
          take(slot, pickMine(avail, counts[slot], round), n);
        }
      } else {
        take(slot, pickOpponent(rng, avail, counts[slot], round), n);
      }
    }
    return {
      value: rosterValue(mine, slots, replacement, world),
      // The same roster scored on point projections alone — i.e. what this
      // simulation reported before outcome draws existed. Kept per-run so the
      // two variance components can be reported separately rather than being
      // silently pooled into one number the user cannot decompose.
      flat: rosterValue(mine, slots, replacement, null),
      roster: mine, nextExpect
    };
  };

  const out = [];
  for (const cand of cands) {
    const values = [], flats = []; let sniped = 0;
    // Per-iteration value, NaN where this candidate was sniped. Kept so the
    // candidates can be compared iteration by iteration below rather than only
    // through their means — see the blocking step after this loop.
    const bySim = new Float64Array(sims).fill(NaN);
    const survivorsNext = new Map();
    const finalCounts = {};
    for (let s = 0; s < sims; s++) {
      // Common random numbers on both axes: iteration s is the same draft order
      // AND the same simulated season for every candidate.
      const r = runOne(cand, mulberry32(seed + s), worlds?.[s]);
      if (!r) { sniped++; continue; }
      values.push(r.value); flats.push(r.flat); bySim[s] = r.value;
      for (const p of r.roster) finalCounts[p.position] = (finalCounts[p.position] ?? 0) + 1;
      // Best expected at my following pick, by position, for the note.
      const seen = new Set();
      for (const p of r.nextExpect ?? []) {
        if (seen.has(p.position)) continue;
        seen.add(p.position);
        survivorsNext.set(p.name, (survivorsNext.get(p.name) ?? 0) + 1);
      }
    }
    if (!values.length) { out.push({ player_id: cand.player_id, name: cand.name, position: cand.position, sniped_pct: 100, expected: null, by_sim: null }); continue; }
    const n = values.length;
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const stdev = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
    const mean = avg(values);
    const sd = stdev(values, mean);
    const flatMean = avg(flats);
    const pct = q => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    out.push({
      player_id: cand.player_id, name: cand.name, position: cand.position, team_abbr: cand.team_abbr,
      expected: +mean.toFixed(1), sd: +sd.toFixed(1), sims: n,
      // The 10th/90th of the finished-roster distribution: the honest "how bad
      // and how good does this get", now that there is a distribution to read.
      p10: +pct(0.1).toFixed(1), p90: +pct(0.9).toFixed(1),
      // Decomposition: `sd_order` is the spread of who else got drafted — the
      // only thing the old `sd` ever measured. The gap to `sd` is the season.
      sd_order: +stdev(flats, flatMean).toFixed(1),
      by_sim: bySim,
      sniped_pct: Math.round(100 * sniped / sims),
      typical_build: Object.entries(finalCounts).map(([pos, c]) => `${pos} ${(c / n).toFixed(1)}`).join(', '),
      likely_next: [...survivorsNext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([name, c]) => ({ name, pct: Math.round(100 * c / n) }))
    });
  }
  /* ------------------------------------------------------------- blocking
   * Ordering is decided on the WITHIN-ITERATION comparison, not on the
   * candidates' separate means.
   *
   * The two are the same quantity but not the same estimator, and once season
   * outcomes are drawn the difference decides whether the feature is usable.
   * A finished roster now has sd ~270 points, so the standard error of a
   * candidate's mean at 200 iterations is ~19 — while the candidates are
   * separated by 5-12. Ranking on unpaired means at that resolution is close to
   * a coin flip, and the recommendation flips from one run to the next.
   *
   * But iteration s uses the SAME simulated season and the SAME draft order for
   * every candidate, so nearly all of that 270 is a block effect shared by all
   * of them: a year where the whole board underperforms drags every candidate
   * together and says nothing about which to take. Subtracting each iteration's
   * own mean removes it, which is the entire reason common random numbers were
   * used in the first place. What survives is the part that actually differs
   * between candidates.
   *
   * `expected` is still the honest absolute mean, and `sd` still the honest
   * absolute spread — this changes how they are COMPARED, not what they are.
   */
  const scored = out.filter(o => o.by_sim);
  if (scored.length > 1) {
    const blockMean = new Float64Array(sims), blockN = new Float64Array(sims);
    for (const o of scored) {
      for (let s = 0; s < sims; s++) {
        const v = o.by_sim[s];
        if (Number.isNaN(v)) continue;
        blockMean[s] += v; blockN[s]++;
      }
    }
    for (let s = 0; s < sims; s++) if (blockN[s]) blockMean[s] /= blockN[s];
    // The level the blocked comparison is measured against, so an absolute
    // number can be put back on the same footing as the ordering.
    let grand = 0, grandN = 0;
    for (let s = 0; s < sims; s++) if (blockN[s] >= 2) { grand += blockMean[s]; grandN++; }
    grand = grandN ? grand / grandN : 0;
    for (const o of scored) {
      let sum = 0, n = 0, sq = 0;
      for (let s = 0; s < sims; s++) {
        const v = o.by_sim[s];
        // Only iterations where at least one other candidate also survived can
        // say anything about a difference.
        if (Number.isNaN(v) || blockN[s] < 2) continue;
        const d = v - blockMean[s];
        sum += d; sq += d * d; n++;
      }
      o._rel = n ? sum / n : -Infinity;
      // Standard error of that within-iteration edge — the number that says
      // whether the ordering below is worth reading.
      o._relSe = n > 1 ? Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2) / n) : null;
      /* The comparable absolute level.
       *
       * `expected` is the mean over the iterations where this candidate was
       * still there — which is a different, and favourably selected, set of
       * worlds for a candidate who gets sniped 37% of the time than for one who
       * never does. That selection is why `expected` can rank a candidate first
       * while the like-for-like comparison ranks him fourth. Re-anchoring the
       * blocked edge on the field's own average puts the number the user reads
       * back in the same order as the ranking it sits next to. `expected` is
       * kept as-is: it is still the right answer to "if I do get him, what does
       * my roster look like".
       */
      o.expected_paired = n ? +(grand + o._rel).toFixed(1) : null;
    }
  } else for (const o of scored) { o._rel = o.expected; o._relSe = null; o.expected_paired = o.expected; }

  out.sort((a, b) => (b._rel ?? -Infinity) - (a._rel ?? -Infinity));
  const best = out.find(o => o.expected != null);
  // Read before the loop: it strips `_rel` as it goes, and `best` is the first
  // thing it strips.
  const bestRel = best?._rel;
  for (const o of out) {
    o.delta = o._rel != null && bestRel != null && Number.isFinite(bestRel)
      ? +(o._rel - bestRel).toFixed(1) : null;
    // How much of that gap is simulation noise. |delta| under ~2x this is a tie.
    o.delta_se = o._relSe == null ? null : +o._relSe.toFixed(2);
    delete o._rel; delete o._relSe; delete o.by_sim;
  }
  return {
    pick_number: myFirst, sims, candidates: out,
    // What the spread on screen is actually made of, so the UI never has to
    // guess whether `sd` includes player outcomes.
    outcome_draws: !!worlds,
    drawn_players: worlds ? universe.length : 0,
    generated_at: new Date().toISOString()
  };
}
