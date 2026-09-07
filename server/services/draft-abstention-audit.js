/**
 * Does the draft board know when it is guessing?
 *
 * `nfl-abstention-audit.js` asks the betting version of this question — it
 * grades the games the policy REFUSED alongside the ones it took, because
 * every refusal is a labelled counterfactual nobody had ever scored. The
 * draft board has no abstention concept at all: it ranks a player with three
 * seasons of usage history and a rookie extrapolated from draft capital with
 * exactly the same visual authority. This module asks whether that is
 * defensible.
 *
 * The move that makes it cheap is the same one that made the betting audit
 * cheap: `docs/DRAFT_AUDIT_2021_2025.md`'s panel already grades every ECR slot
 * 2021-2025, including the slots a gate would decline to speak confidently
 * about. The counterfactual is already sitting there.
 *
 * WHAT THIS CAN AND CANNOT SAY — carried over verbatim in spirit from
 * `nfl-abstention-audit.js`, because the epistemic trap is identical:
 *
 *   CAN    — whether picks a coverage-side gate would flag as thin actually
 *            landed further from their slot's expectation than picks it kept,
 *            on held-out seasons, at a stated significance bar.
 *   CANNOT — establish that softening the board's tone on flagged picks makes
 *            anyone's draft better going forward. A gate that separates here
 *            is a HYPOTHESIS for a forward test, never a licence to start
 *            hiding or down-weighting players.
 *
 * And the standing warning from the betting side, which is the reason this
 * test was worth running at all: there, selectivity INVERTED. The model's
 * top-3-confidence picks hit 45.1% (z = -2.42) against 51.0% for all games.
 * Conviction was anti-predictive. A null or inverted result here is the
 * expected outcome, not a failure of the harness.
 *
 * Design constraints this file obeys:
 *   - Every gate input is a COVERAGE-side fact known before Week 1: whether
 *     the player has a prior-season usage line, whether he is a rookie,
 *     whether the in-house projection covers him, how wide his position/tier
 *     prediction band is, and how much the expert panel disagreed (rank_std).
 *     Nothing derived from the outcome ever reaches the gate.
 *   - Every threshold is fitted on seasons strictly before the season being
 *     graded. Walk-forward, no exceptions.
 *   - It changes no ranking. It is a measurement of an idea, not the idea.
 */
import { buildSeasonRows, fitPreseasonModel, seasonTotals, spreadFor, SPREAD_TIERS, SKILL_POSITIONS }
  from './preseason-model.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { random, withRandomSeed } from './stats-util.js';

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** 8-team demand, the same replacement slots the 2021-2025 audit panel used. */
export const REPLACEMENT_SLOT = Object.freeze({ QB: 11, RB: 27, WR: 27, TE: 8 });

/** Overall-ECR bands the audit reports by; used here as the slot-norm cells. */
export const TIER_BANDS = Object.freeze([
  { name: '1-12', lo: 1, hi: 12 }, { name: '13-24', lo: 13, hi: 24 },
  { name: '25-36', lo: 25, hi: 36 }, { name: '37-60', lo: 37, hi: 60 },
  { name: '61-100', lo: 61, hi: 100 }, { name: '101-150', lo: 101, hi: 150 }
]);

/**
 * `nfl-slice-diagnostic.js`'s read floor, imported as a principle rather than
 * a number: below this many picks a rate is not allowed to become a sentence.
 */
export const MIN_SLICE_SAMPLE = 30;

const bandFor = rank => TIER_BANDS.find(b => rank >= b.lo && rank <= b.hi)?.name ?? '101-150';

/* ============================================================ the panel */

/**
 * Season-level truth: replacement points per position, and the points scored
 * by the player who actually FINISHED at each positional rank.
 *
 * The second is the audit's definition of what a draft slot was worth — not
 * the points of the player drafted there (that is the outcome) but of whoever
 * ended up at that finish. Using the drafted player's own points would make
 * "expected" and "realized" the same number and the whole comparison vacuous.
 */
export function seasonSlotTruth(season) {
  const players = [...seasonTotals(season).players.values()];
  const out = { replacement: {}, finishers: {}, finishRank: new Map() };
  for (const pos of SKILL_POSITIONS) {
    const at = players.filter(p => p.position === pos).sort((a, b) => b.points - a.points);
    at.forEach((p, i) => out.finishRank.set(p.gsis, i + 1));
    const slot = REPLACEMENT_SLOT[pos];
    out.replacement[pos] = at[slot - 1]?.points ?? 0;
    out.finishers[pos] = at.map(p => p.points);
  }
  return out;
}

/** Points of the player who finished at `posRank`; 0 past the end of the list. */
const finisherPoints = (truth, pos, posRank) => truth.finishers[pos]?.[posRank - 1] ?? 0;

/**
 * One graded pick: the coverage-side facts a board knew at draft time, and
 * what the slot actually returned.
 *
 * `expected_vorp_plus` follows `docs/DRAFT_AUDIT_2021_2025.md` exactly: the
 * VORP+ of the player who finished at the drafted positional rank. It is a
 * post-season quantity and is used ONLY as the outcome benchmark, never as a
 * gate input.
 */
export function gradePick(row, truth) {
  const pos = row.position;
  const rep = truth.replacement[pos] ?? 0;
  const points = row.actual_points ?? 0;
  const games = row.actual_games ?? 0;
  const vorpPlus = Math.max(0, points - rep);
  const expected = Math.max(0, finisherPoints(truth, pos, row.pos_rank) - rep);
  const finish = row.gsis ? truth.finishRank.get(row.gsis) ?? 9999 : 9999;
  return {
    season: row.season, gsis: row.gsis, name: row.name, position: pos,
    team: row.team ?? null,
    market_rank: row.market_rank, pos_rank: row.pos_rank, band: bandFor(row.market_rank),
    rank_std: Number.isFinite(row.rank_std) ? row.rank_std : null,
    // --- coverage-side facts, all known before Week 1 ---
    has_history: row.features.has_history === 1,
    rookie: row.features.rookie === 1,
    has_projection: !!row.has_projection,
    // --- outcome ---
    points, games, finish_pos_rank: finish,
    vorp_plus: r3(vorpPlus), expected_vorp_plus: r3(expected),
    abs_err: r3(Math.abs(vorpPlus - expected)),
    hit: finish <= row.pos_rank,
    bust: finish >= row.pos_rank + 12 || games <= 8
  };
}

/** The full 2021-2025 top-`limit` panel, one row per graded ECR slot. */
export function buildAbstentionPanel({ seasons = [2021, 2022, 2023, 2024, 2025], limit = 150 } = {}) {
  const out = [];
  for (const season of seasons) {
    const truth = seasonSlotTruth(season);
    for (const row of buildSeasonRows(season, { limit })) {
      if (!SKILL_POSITIONS.includes(row.position)) continue;
      if (row.actual_points == null) continue;
      out.push(gradePick(row, truth));
    }
  }
  return out;
}

/* ============================================================ the gate */

const percentile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/**
 * Fit the gate's thresholds on training seasons only.
 *
 * Two of the four flags are threshold-free facts (thin history, no
 * projection). The other two need a norm to be "unusual" relative to, and
 * that norm is exactly the thing that must not be allowed to peek: the
 * rank_std cut and the band-width cut are computed from the training seasons'
 * distributions and then frozen.
 *
 * `trainRows` are `buildSeasonRows` outputs (feature rows, with actuals), not
 * graded panel rows, because the band width comes from a preseason model fit
 * on them.
 */
export function fitGate(trainRows, { rankStdQuantile = 0.75 } = {}) {
  const skill = trainRows.filter(r => SKILL_POSITIONS.includes(r.position));

  // rank_std cut, per position — expert panels disagree more about tight ends
  // than about quarterbacks, and a pooled cut would just flag every TE.
  const rankStdCut = {};
  for (const pos of SKILL_POSITIONS) {
    const vals = skill.filter(r => r.position === pos && Number.isFinite(r.rank_std))
      .map(r => r.rank_std).sort((a, b) => a - b);
    rankStdCut[pos] = vals.length >= MIN_SLICE_SAMPLE ? r3(percentile(vals, rankStdQuantile)) : null;
  }

  // Band width by position x spread tier, from a model fitted on the training
  // seasons. `fitPreseasonModel`'s spread block is the shipped p20/p80; width
  // is p80 - p20 in ratio units, so it is comparable across positions.
  const model = fitPreseasonModel(skill);
  const widths = [];
  const bandWidth = {};
  for (const pos of SKILL_POSITIONS) {
    bandWidth[pos] = {};
    for (const tier of SPREAD_TIERS) {
      const s = spreadFor(model, pos, tier.lo);
      const w = r3((s.p80 ?? 1.5) - (s.p20 ?? 0.5));
      bandWidth[pos][tier.name] = w;
      widths.push(w);
    }
  }
  widths.sort((a, b) => a - b);
  // "Unusually wide" = wider than the median cell on the training seasons.
  const bandWidthCut = r3(percentile(widths, 0.5));

  return { rank_std_cut: rankStdCut, band_width: bandWidth, band_width_cut: bandWidthCut,
    train_n: skill.length };
}

export const GATE_FLAGS = Object.freeze(['thin_history', 'no_projection', 'wide_band', 'high_rank_std']);

/**
 * Which coverage-side flags fire for one pick.
 *
 * `thin_history` folds "no prior-season usage on record" and "rookie with no
 * NFL snaps" into a single flag on purpose. They are near-collinear (a rookie
 * has no prior usage by construction), and counting them separately would
 * make any "two or more flags" rule mean "is a rookie" while looking like it
 * meant something broader.
 */
export function gateFlags(pick, gate) {
  const flags = [];
  if (!pick.has_history || pick.rookie) flags.push('thin_history');
  if (!pick.has_projection) flags.push('no_projection');
  const tier = SPREAD_TIERS.find(t => pick.pos_rank >= t.lo && pick.pos_rank <= t.hi) ?? SPREAD_TIERS[2];
  const width = gate.band_width?.[pick.position]?.[tier.name];
  if (Number.isFinite(width) && Number.isFinite(gate.band_width_cut) && width > gate.band_width_cut) {
    flags.push('wide_band');
  }
  const cut = gate.rank_std_cut?.[pick.position];
  if (Number.isFinite(cut) && Number.isFinite(pick.rank_std) && pick.rank_std > cut) {
    flags.push('high_rank_std');
  }
  return flags;
}

/** DECLINE = "present this with a widened disclaimer", never "hide the player". */
export function applyGate(pick, gate, { minFlags = 2 } = {}) {
  const flags = gateFlags(pick, gate);
  return { flags, declined: flags.length >= minFlags };
}

/* ============================================================ statistics */

/**
 * Wilson score interval, same construction and for the same reason as
 * `nfl-abstention-audit.js`: every headline here is a proportion measured on
 * a few dozen to a few hundred picks, and the normal approximation misbehaves
 * badly at that size.
 */
export function wilson(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [r4(centre - half), r4(centre + half)];
}

const erf = x => {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
};

export function twoProportion(winsA, nA, winsB, nB) {
  if (!nA || !nB) return null;
  const pA = winsA / nA, pB = winsB / nB;
  const pooled = (winsA + winsB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (!(se > 0)) return null;
  const z = (pA - pB) / se;
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return { difference: r4(pA - pB), z: r4(z), p_value: r4(p), significant: p < 0.05 };
}

/**
 * Cluster bootstrap for the difference in means between two DISJOINT sets.
 *
 * `pairedBootstrapDiff` is the right tool when two forecasters are graded on
 * the same units, and it is used that way below (each set against its own
 * slot-norm benchmark). It is the WRONG tool for kept-vs-declined, which are
 * different players: there is nothing to pair. Resampling clusters
 * independently within each set is the correct analogue, and it keeps the
 * same clustering discipline for the same reason — players on one offense
 * share game script and target competition, and seasons share a scoring
 * environment, so resampling individuals would understate the true spread.
 *
 * `significant` follows `pairedBootstrapDiff`'s convention exactly: the 90%
 * interval must exclude zero.
 */
export function clusterTwoSampleDiff(valuesA, valuesB, { groupsA, groupsB, iterations = 2000, seed = 7 } = {}) {
  if (valuesA.length < 10 || valuesB.length < 10) {
    return { error: `too few observations (${valuesA.length} vs ${valuesB.length}) to bootstrap meaningfully` };
  }
  const blocks = (values, groups) => {
    if (!groups || groups.length < values.length) return values.map(v => [v]);
    const by = new Map();
    for (let i = 0; i < values.length; i++) {
      const k = groups[i];
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(values[i]);
    }
    return [...by.values()];
  };
  const bA = blocks(valuesA, groupsA), bB = blocks(valuesB, groupsB);
  const draw = (bs) => {
    let sum = 0, n = 0;
    for (let g = 0; g < bs.length; g++) {
      const blk = bs[Math.floor(random() * bs.length)];
      for (const v of blk) { sum += v; n++; }
    }
    return n ? sum / n : 0;
  };
  const diffs = new Array(iterations);
  withRandomSeed(seed, () => {
    for (let it = 0; it < iterations; it++) diffs[it] = draw(bA) - draw(bB);
  });
  diffs.sort((x, y) => x - y);
  const lo = diffs[Math.floor(iterations * 0.05)], hi = diffs[Math.floor(iterations * 0.95)];
  return {
    mean_diff: r4(diffs.reduce((s, x) => s + x, 0) / iterations),
    ci90: [r4(lo), r4(hi)],
    significant: !(lo <= 0 && hi >= 0),
    n_a: valuesA.length, n_b: valuesB.length, iterations
  };
}

/* ============================================================ the audit */

function summarize(picks) {
  if (!picks.length) return { n: 0 };
  const hits = picks.filter(p => p.hit).length;
  const busts = picks.filter(p => p.bust).length;
  return {
    n: picks.length,
    hit_rate: r4(hits / picks.length), hit_rate_95: wilson(hits, picks.length),
    bust_rate: r4(busts / picks.length),
    vorp_plus_per_pick: r3(mean(picks.map(p => p.vorp_plus))),
    expected_vorp_plus_per_pick: r3(mean(picks.map(p => p.expected_vorp_plus))),
    abs_err_per_pick: r3(mean(picks.map(p => p.abs_err))),
    slot_adjusted_err: r3(mean(picks.map(p => p.resid))),
    readable: picks.length >= MIN_SLICE_SAMPLE
  };
}

/**
 * Slot-norm cell means from the training seasons: the average |realized −
 * slot expectation| for picks in each overall-ECR band.
 *
 * This is what makes kept-vs-declined comparable at all. Thin-coverage picks
 * are overwhelmingly late picks, and late slots sit at replacement, so their
 * raw absolute error is small for a purely structural reason. Comparing raw
 * error would report "the gate works" from nothing but draft position.
 * Subtracting the band's own training-season norm removes that.
 */
function slotNorms(trainPanel) {
  const byBand = new Map();
  for (const p of trainPanel) {
    if (!byBand.has(p.band)) byBand.set(p.band, []);
    byBand.get(p.band).push(p.abs_err);
  }
  const global = mean(trainPanel.map(p => p.abs_err)) ?? 0;
  const norms = {};
  for (const b of TIER_BANDS) {
    const vals = byBand.get(b.name) ?? [];
    norms[b.name] = r3(vals.length >= MIN_SLICE_SAMPLE ? mean(vals) : global);
  }
  return { norms, global: r3(global) };
}

/**
 * The whole test, walk-forward.
 *
 * For each held-out season T: fit the gate and the slot norms on every season
 * strictly before T, apply them to T's panel, and grade the kept and declined
 * sets separately.
 */
export function draftAbstentionAudit({
  seasons = [2021, 2022, 2023, 2024, 2025],
  heldOut = [2023, 2024, 2025],
  limit = 150, minFlags = 2, iterations = 2000
} = {}) {
  const panel = buildAbstentionPanel({ seasons, limit });
  if (!panel.length) return { error: 'no graded picks in the panel' };

  const perSeason = [];
  for (const season of heldOut) {
    const trainSeasons = seasons.filter(s => s < season);
    if (trainSeasons.length < 2) { perSeason.push({ season, error: 'fewer than two training seasons' }); continue; }

    const trainRows = trainSeasons.flatMap(s => buildSeasonRows(s, { limit }));
    const gate = fitGate(trainRows);
    const trainPanel = panel.filter(p => trainSeasons.includes(p.season));
    const { norms, global } = slotNorms(trainPanel);

    const test = panel.filter(p => p.season === season).map(p => {
      const g = applyGate(p, gate, { minFlags });
      const norm = norms[p.band] ?? global;
      return { ...p, ...g, slot_norm: norm, resid: r3(p.abs_err - norm) };
    });

    const kept = test.filter(p => !p.declined);
    const declined = test.filter(p => p.declined);

    // Each set against its OWN slot-norm benchmark: a genuine paired
    // comparison (two forecasts of the same pick), clustered by NFL team
    // because teammates share one offense's volume.
    const pairedFor = set => set.length >= 10
      ? pairedBootstrapDiff(set.map(p => p.slot_norm), set.map(p => p.abs_err),
        { iterations, seed: 11, groups: set.map(p => p.team ?? p.gsis) })
      : { error: `only ${set.length} picks` };

    // The headline: is the kept set actually more reliable than the declined
    // set? Positive mean_diff = declined picks landed further from their
    // slot's expectation, i.e. the gate separated something real.
    const separation = clusterTwoSampleDiff(
      declined.map(p => p.resid), kept.map(p => p.resid),
      { groupsA: declined.map(p => p.team ?? p.gsis), groupsB: kept.map(p => p.team ?? p.gsis),
        iterations, seed: 11 });

    perSeason.push({
      season, train_seasons: trainSeasons, gate,
      slot_norms: norms,
      kept: summarize(kept), declined: summarize(declined),
      kept_vs_slot_norm: pairedFor(kept),
      declined_vs_slot_norm: pairedFor(declined),
      separation,
      hit_rate_test: twoProportion(kept.filter(p => p.hit).length, kept.length,
        declined.filter(p => p.hit).length, declined.length),
      // Per-flag, in the shape `nfl-abstention-audit.js` reports `by_reason`:
      // which single coverage fact, if any, is doing the separating.
      by_flag: GATE_FLAGS.map(flag => {
        const on = test.filter(p => p.flags.includes(flag));
        const off = test.filter(p => !p.flags.includes(flag));
        return {
          flag, n: on.length,
          slot_adjusted_err_on: r3(mean(on.map(p => p.resid))),
          slot_adjusted_err_off: r3(mean(off.map(p => p.resid))),
          hit_rate_on: on.length ? r4(on.filter(p => p.hit).length / on.length) : null,
          hit_rate_off: off.length ? r4(off.filter(p => p.hit).length / off.length) : null,
          readable: on.length >= MIN_SLICE_SAMPLE
        };
      }),
      picks: test
    });
  }

  // Pooled across the held-out seasons, clustered BY SEASON — the higher-power
  // version of the same question, and the one that can catch a real effect too
  // small to clear the bar in any single 150-pick season. Reported alongside
  // the per-season bar, never in place of it: the repo's standing rule is
  // >= 2 of 3 held-out seasons, and a pooled result cannot substitute for it.
  const allTest = perSeason.filter(s => !s.error).flatMap(s => s.picks);
  const pk = allTest.filter(p => !p.declined), pd = allTest.filter(p => p.declined);
  const pooled = pk.length >= 10 && pd.length >= 10
    ? clusterTwoSampleDiff(pd.map(p => p.resid), pk.map(p => p.resid),
      { groupsA: pd.map(p => p.season), groupsB: pk.map(p => p.season), iterations, seed: 11 })
    : { error: 'too few picks pooled' };

  const scored = perSeason.filter(s => !s.error && s.separation && !s.separation.error);
  const separating = scored.filter(s => s.separation.significant && s.separation.mean_diff > 0);
  const inverted = scored.filter(s => s.separation.significant && s.separation.mean_diff < 0);
  const passes = separating.length >= 2;

  return {
    seasons, held_out: heldOut, min_flags: minFlags, panel_n: panel.length,
    per_season: perSeason,
    pooled: {
      kept: summarize(pk), declined: summarize(pd),
      separation: pooled,
      hit_rate_test: twoProportion(pk.filter(p => p.hit).length, pk.length,
        pd.filter(p => p.hit).length, pd.length)
    },
    bar: 'the kept set is significantly more reliable than the declined set in >= 2 of 3 held-out seasons',
    seasons_separating: separating.map(s => s.season),
    seasons_inverted: inverted.map(s => s.season),
    passes,
    verdict: passes
      ? 'GATE SEPARATES — kept picks landed measurably closer to their slot expectation than declined picks. '
        + 'A hypothesis for a forward test and a presentational change, not a licence to re-rank.'
      : inverted.length
        ? 'GATE IS ANTI-SELECTIVE — the picks it flagged as thin did BETTER than the ones it kept, which is '
          + 'the same inversion the betting side found (top-3 confidence picks at 45.1%, z = -2.42). Do not ship.'
        : 'NO SEPARATION — coverage-side thinness does not identify picks that land further from their slot '
          + 'expectation. The gate measures nothing real at this sample size. Do not ship.',
    note: 'Backward-looking on a five-season panel. CAN say a coverage rule flagged picks that did or did not '
      + 'land further from their slot expectation on held-out seasons; CANNOT say that softening the board\'s '
      + 'tone on flagged picks improves anyone\'s draft going forward.'
  };
}
