/**
 * AI slate reasoning over the two PROVEN execution edges — propose, simulate,
 * review, commit.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SCOPED TO EXECUTION AND NOT TO PICKING GAMES
 *
 * The obvious version of this feature is "AI proposes a spread pick, a
 * simulation checks it, AI reconsiders". That version is dishonest here, and
 * the reason is measured rather than aesthetic.
 *
 * `nfl-drive-sim.js` is the only game simulator in this repository, and it is
 * the thing such a loop would have to verify against. Audit run 8 puts it at
 * **46.91% directional accuracy** — below a coin flip — and
 * `docs/BETTING_CAPABILITY_AUDIT.md` Cluster 5 records the standing action item
 * as "repair the simulation". Wrapping a reasoning-and-verification ritual
 * around a simulator that is worse than guessing does not make the pick better.
 * It makes a broken pick look rigorous, which is worse than leaving it plainly
 * broken, because the ceremony is what someone would trust. The 21 spread
 * models measured against 15,096 closing lines all failed the same way. None of
 * that is fixed by asking a language model to think about it harder.
 *
 * So this module never forecasts a game. It reasons about ALLOCATION across
 * opportunities whose edge was already measured without any forecast at all:
 *
 *   1. LINE SHOPPING (`nfl-execution-edge.js` / `nfl-shopping-board.js`).
 *      272-event snapshot, 6.4 books per market: spread lines differ by 0.813
 *      points on average, 37.5% of markets differ by a full point or more, and
 *      best-price selection is worth 2.566% per bet. A second 652-market
 *      measurement: books disagree on the number 20.9% of the time. This is
 *      arithmetic on prices visible before the bet.
 *
 *   2. WONG TEASERS (`nfl-teasers.js` / `nfl-teaser-execution.js`). 1,391
 *      qualifying legs 1999-2025, 74.69% per leg, SE 1.17pp. +6.51% EV at -110
 *      and -1.29% at -130 — the edge is the payout structure meeting a lumpy
 *      margin distribution, not a prediction about any team.
 *
 * The judgement this feature adds is real and is not available from either
 * module alone: on a live slate several of these fire at once, and they are not
 * independent. Two teasers sharing a game are one correlated position wearing
 * two tickets. A shopped side can be the same game a teaser leg needs. Total
 * exposure has to stay survivable. Deciding what to take together, and how much
 * of each, is allocation under correlation — a judgement question, which is why
 * a language model is the right instrument for it, and it is asked ONLY about
 * bets whose edge was established before it was consulted.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT DO, STRUCTURALLY
 *
 * `stakeFor({source})` in `nfl-execution-edge.js` is the repository's staking
 * gate: an 'execution' source may size, a 'model' source returns zero units
 * until proven CLV. That gate is the whole discipline, and a reasoning layer
 * sitting on top of it is exactly the shape of thing that would quietly launder
 * a model pick into looking execution-grade. Three properties prevent it:
 *
 *   - `SOURCE_OF_KIND` maps a CLOSED ENUM of opportunity kinds to a staking
 *     source. The source is derived from the kind, never accepted from a
 *     caller. An unrecognised kind maps to 'model' and therefore to zero.
 *   - Every ceiling comes from `stakeFor` itself, called by this module before
 *     Claude is consulted. Claude never sees a bet that the gate zeroed.
 *   - `applyAllocation` CLAMPS. Claude may lower a stake or drop a bet; it
 *     cannot raise one above the gate's ceiling, cannot introduce an id that
 *     was not offered, and cannot exceed the portfolio cap. Its judgement is
 *     allowed to be more conservative than the arithmetic and never less.
 *
 * And nothing here places a bet. It returns a recommendation for a human to
 * approve, in the same shape as every other execution path in this repository
 * (`nfl-teaser-execution.js` records an execution; it does not transmit a
 * wager). There is no auto-execution path and none should be added.
 *
 * ---------------------------------------------------------------------------
 * AN HONEST RESULT THAT FALLS OUT OF THE SIZING, WORTH READING BEFORE THE CODE
 *
 * A shopped line's win probability here is NO_FORECAST_BASE (0.500) plus the
 * measured line edge, because a de-vigged spread is a coin flip by construction
 * and this module claims no forecasting skill whatsoever. That has a
 * consequence people find surprising: a bet whose only advantage is a better
 * PRICE sizes to exactly zero. A coin flip at -105 is still a losing bet. Best
 * price selection lowers the hurdle from ~52.38% to ~51.1%; it does not clear
 * it. Only a book disagreeing about the NUMBER by enough to matter — which in
 * practice means crossing 3 or 7, where the margin mass actually sits — makes a
 * shopped side standalone +EV.
 *
 * That is not a defect of the implementation. It is the measurement stated
 * correctly, and it is why most live shopping rows arrive here with a zero
 * ceiling and are shown to the reasoning step as context rather than as bets.
 */
import { withRandomSeed, cholesky, correlatedNormals, probit, quantile } from './stats-util.js';
import { stakeFor, impliedProb } from './nfl-execution-edge.js';
import { estimateBetCorrelation } from './staking.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
const dec = american => (american >= 0 ? 1 + american / 100 : 1 + 100 / -american);

/**
 * A de-vigged spread is a coin flip. This module has no forecast and says so
 * with a constant rather than by omission — every shopped-line win probability
 * is this number plus a MEASURED line edge, and nothing else is ever added to
 * it. If a future version wants to move this, it needs a proven forecast, which
 * is the thing 21 models failed to produce against 15,096 closing lines.
 */
export const NO_FORECAST_BASE = 0.5;

/**
 * The closed enum. A kind maps to a staking source; anything unrecognised maps
 * to 'model', which `stakeFor` zeroes. This is the laundering guard, and it is
 * a lookup rather than a parameter so it cannot be passed around.
 */
export const SOURCE_OF_KIND = Object.freeze({
  /** Wong teaser ticket — edge is the payout structure over the margin distribution. */
  teaser: 'execution',
  /** Best-of-N-books line — edge is observed price/line dispersion at bet time. */
  shopped_line: 'execution'
});

export const SLATE_POLICY = Object.freeze({
  bankroll_units: 100,
  /** Quarter Kelly, matching RISK_MODES.cautious — the default until real money has run through. */
  kelly_fraction: 0.25,
  max_units_per_bet: 3,
  /** Total staked across the slate, as units of a 100u bankroll. */
  max_slate_units: 8,
  /** "A few hundred draws" — enough to read a distribution, fast enough for a live slate. */
  sims: 400,
  /** A month of slates. Drawdown is a path property and needs more than one week to exist. */
  weeks: 4,
  seed: 4021,
  /** Structural: propose, then review. There is no third. */
  max_claude_calls: 2
});

export const SLATE_STATUS = {
  /** Claude reviewed the simulation of its own slate and kept it. */
  CONFIRMED: 'confirmed',
  /** Claude reviewed the simulation and changed the allocation. */
  REVISED: 'revised',
  /** Nothing survived the staking gate; there was no slate to reason about. */
  EMPTY: 'empty'
};

/* ------------------------------------------------------------ opportunities */

/**
 * Turn one `shoppingBoard()` row into a candidate, or null.
 *
 * `line_edge` is `bestExecution`'s valuation of this book's number against the
 * median book, priced over the empirical margin distribution — so a half point
 * across 3 is worth an order of magnitude more than one across 5, which is the
 * entire reason line shopping beats price shopping.
 */
export function shoppedLineOpportunity(rowIn) {
  if (!rowIn || !Number.isFinite(rowIn.best_price)) return null;
  const lineEdge = Number.isFinite(rowIn.line_edge) ? rowIn.line_edge : 0;
  const winProbability = NO_FORECAST_BASE + lineEdge;
  if (!(winProbability > 0 && winProbability < 1)) return null;
  return {
    id: `shop:${rowIn.event_id}:${rowIn.market}:${rowIn.side}`,
    kind: 'shopped_line',
    label: `${rowIn.side} ${rowIn.best_line ?? ''} ${rowIn.market} at ${rowIn.best_book}`.replace(/\s+/g, ' ').trim(),
    matchup: rowIn.matchup ?? null,
    book: rowIn.best_book ?? null,
    american_price: rowIn.best_price,
    win_probability: r4(winProbability),
    // Every opportunity carries the games it settles on, because that is what
    // makes two of them correlated.
    games: [{ event_id: rowIn.event_id, matchup: rowIn.matchup ?? null }],
    measured: {
      basis: 'execution dispersion across books, measured at bet time',
      line_edge: r4(lineEdge),
      price_edge: r4(rowIn.price_edge ?? 0),
      books_compared: rowIn.books_compared ?? null,
      median_line: rowIn.median_line ?? null,
      note: lineEdge > 0
        ? `This book's number is worth ${(lineEdge * 100).toFixed(2)}pp of win probability against the median book.`
        : 'No line advantage against the median book — price advantage alone does not beat the vig.'
    }
  };
}

/**
 * Turn one eligible `compileTeaserRoutes()` candidate into a bet.
 *
 * Ineligible candidates are refused here rather than passed along with a
 * warning: `compileTeaserRoutes` already applies the price floor, the mathematical
 * break-even and the line-freshness gates, and the entire teaser edge is the
 * price. A candidate that failed those gates is not a thin bet, it is a
 * negative one.
 */
export function teaserOpportunity(candidate, { legRate, standardError } = {}) {
  if (!candidate?.eligible || !Number.isFinite(candidate.american_price)) return null;
  const legs = candidate.legs ?? [];
  if (legs.length < 2) return null;
  // Different games is what makes p^n legal at all; compileTeaserRoutes enforces
  // it, and this is the second lock on the same door.
  if (new Set(legs.map(l => l.event_id)).size !== legs.length) return null;
  const p = Number.isFinite(candidate.expected_ticket_probability)
    ? candidate.expected_ticket_probability
    : (Number.isFinite(legRate) ? Math.pow(legRate, legs.length) : null);
  if (!(p > 0 && p < 1)) return null;
  return {
    id: `teaser:${candidate.candidate_id}`,
    kind: 'teaser',
    label: `${legs.length}-leg 6pt teaser at ${candidate.book}: ${legs.map(l => `${l.team} ${l.market_line}→${l.teased_line}`).join(' + ')}`,
    matchup: legs.map(l => l.matchup).join(' / '),
    book: candidate.book ?? null,
    american_price: candidate.american_price,
    win_probability: r4(p),
    games: legs.map(l => ({ event_id: l.event_id, matchup: l.matchup ?? null, team: l.team, opponent: l.opponent })),
    measured: {
      basis: 'Wong teaser leg rate, 1,391 legs 1999-2025',
      leg_rate: r4(legRate ?? null),
      leg_standard_error: r4(standardError ?? null),
      legs: legs.length,
      expected_ev: candidate.expected_ev ?? null,
      note: `Ticket probability is the measured leg rate to the power of ${legs.length}, legal only because the legs are in different games.`
    }
  };
}

/**
 * Size every candidate through the real gate and return only what may be bet.
 *
 * This runs BEFORE any Claude call. The reasoning step is shown ceilings that
 * the staking gate produced, so the worst it can do is be too cautious.
 */
export function gateOpportunities(candidates, { policy = SLATE_POLICY } = {}) {
  const offered = [], blocked = [];
  for (const c of candidates ?? []) {
    if (!c?.id) continue;
    // Derived from the kind. Never read off the candidate.
    const source = SOURCE_OF_KIND[c.kind] ?? 'model';
    const stake = stakeFor({
      winProbability: c.win_probability,
      americanPrice: c.american_price,
      source,
      bankrollUnits: policy.bankroll_units,
      fraction: policy.kelly_fraction,
      maxUnitsPerBet: policy.max_units_per_bet
    });
    const ceiling = Number.isFinite(stake.units) ? stake.units : 0;
    const entry = {
      ...c, staking_source: source,
      ceiling_units: r2(ceiling),
      edge: r4(c.win_probability - impliedProb(c.american_price)),
      gate_reason: stake.reason ?? null
    };
    if (ceiling > 0) offered.push(entry);
    else blocked.push({ ...entry, blocked: true });
  }
  offered.sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0));
  return { offered, blocked };
}

/* ------------------------------------------------------------- correlation */

/**
 * How much two opportunities move together.
 *
 * Delegates to `staking.js#estimateBetCorrelation` rather than restating its
 * rules, so there is one place in this codebase that decides what "same game"
 * is worth. A teaser spans several games, so the pair is scored at its most
 * correlated leg — the honest reading, since a shared game dominates whatever
 * the other legs do.
 */
export function opportunityCorrelation(a, b) {
  if (!a || !b) return 0;
  if (a === b || a.id === b.id) return 1;
  let rho = 0;
  for (const ga of a.games ?? []) {
    for (const gb of b.games ?? []) {
      if (ga.event_id && gb.event_id && ga.event_id === gb.event_id) { rho = Math.max(rho, 0.8); continue; }
      rho = Math.max(rho, estimateBetCorrelation(ga, gb));
    }
  }
  return rho;
}

function correlationMatrix(bets) {
  const n = bets.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const rho = opportunityCorrelation(bets[i], bets[j]);
      m[i][j] = rho; m[j][i] = rho;
    }
  }
  return m;
}

/**
 * Say what correlation is ACTUALLY in this slate, naming the pairs.
 *
 * The first version of this stated the RULE — "bets sharing a game are
 * correlated at 0.80" — regardless of whether this slate had any shared games.
 * On a slate with none, the model read that boilerplate as a fact about the
 * bets in front of it and revised a perfectly diversified allocation to manage
 * a correlation that did not exist. The briefing was the thing that was wrong,
 * not the reasoning over it, and a reasoning layer is only as good as the
 * facts it is handed. So this reports the realised matrix and says plainly when
 * a slate is independent.
 */
export function describeCorrelation(bets) {
  if (bets.length < 2) return 'Single bet — correlation has nothing to act on.';
  const pairs = [];
  for (let i = 0; i < bets.length; i++) {
    for (let j = i + 1; j < bets.length; j++) {
      const rho = opportunityCorrelation(bets[i], bets[j]);
      if (rho > 0) pairs.push(`${bets[i].id} × ${bets[j].id} at ${rho.toFixed(2)}`);
    }
  }
  if (!pairs.length) {
    return `Within-week outcomes drawn through a Gaussian copula. THIS SLATE IS UNCORRELATED — no two ` +
      `of these ${bets.length} bets share a game or any other common factor, so they win and lose independently.`;
  }
  return `Within-week outcomes drawn through a Gaussian copula. Correlated pairs in THIS slate: ${pairs.join('; ')}. ` +
    `All other pairs are independent.`;
}

/* ------------------------------------------------------------- simulation */

/**
 * Monte Carlo of the proposed slate's BANKROLL PATH.
 *
 * Not a single-shot EV calculation — the numbers worth reasoning about are path
 * properties. A slate can have positive expectation and still be a bad idea
 * because of the shape of the road it takes, and drawdown does not exist inside
 * one week.
 *
 * Each draw plays `weeks` repetitions of the same slate composition. Within a
 * week the win/loss vector is drawn through a Gaussian copula on the
 * correlation matrix above — the same machinery `staking.js#slateRiskCheck` and
 * `nfl-prop-correlation.js` already use — so two teasers sharing a game lose
 * together the way they actually would. Across weeks the draws are independent,
 * which is the right assumption for different games in different weeks.
 *
 * Every win probability is the bet's OWN MEASURED rate: the Wong leg rate to
 * the power of its legs for a teaser, 0.5 plus the measured line edge for a
 * shopped side. Nothing here is forecast.
 *
 * Seeded by default so a recommendation is reproducible and so the tests do not
 * chase noise.
 */
export function simulateSlate(bets, { policy = SLATE_POLICY, sims = null, weeks = null, seed = null,
  nullEdge = false } = {}) {
  const staked = (bets ?? []).filter(b => Number.isFinite(b?.units) && b.units > 0)
    // The null-edge counterfactual: identical bets, identical stakes, but every
    // win probability replaced by the price's own implied probability — i.e.
    // the measured edge is assumed not to exist. See `nullComparison`.
    .map(b => (nullEdge ? { ...b, win_probability: impliedProb(b.american_price) } : b));
  const nSims = sims ?? policy.sims, nWeeks = weeks ?? policy.weeks;
  const start = policy.bankroll_units;
  if (!staked.length) {
    return { simulated: false, reason: 'no staked bets in the proposed slate', bets: 0,
      sims: 0, weeks: nWeeks, starting_bankroll: start };
  }

  const L = cholesky(correlationMatrix(staked));
  const thresholds = staked.map(b => probit(1 - b.win_probability));
  const payout = staked.map(b => dec(b.american_price) - 1);
  const weeklyStake = staked.reduce((s, b) => s + b.units, 0);

  const finals = [], maxDrawdowns = [], worstWeeks = [];
  let losingMonths = 0, ruinish = 0;
  const meanPath = new Array(nWeeks + 1).fill(0);

  withRandomSeed(seed ?? policy.seed, () => {
    for (let s = 0; s < nSims; s++) {
      let bank = start, peak = start, maxDd = 0, worstWeek = 0;
      meanPath[0] += start;
      for (let w = 0; w < nWeeks; w++) {
        const z = correlatedNormals(L);
        let delta = 0;
        for (let i = 0; i < staked.length; i++) {
          delta += z[i] <= thresholds[i] ? -staked[i].units : staked[i].units * payout[i];
        }
        bank += delta;
        if (delta < worstWeek) worstWeek = delta;
        if (bank > peak) peak = bank;
        const dd = peak > 0 ? (peak - bank) / peak : 0;
        if (dd > maxDd) maxDd = dd;
        meanPath[w + 1] += bank;
      }
      finals.push(bank);
      maxDrawdowns.push(maxDd);
      worstWeeks.push(worstWeek);
      if (bank < start) losingMonths++;
      if (bank < start * 0.8) ruinish++;
    }
  });

  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    simulated: true,
    bets: staked.length,
    sims: nSims,
    weeks: nWeeks,
    starting_bankroll: start,
    weekly_stake_units: r2(weeklyStake),
    total_staked_over_horizon: r2(weeklyStake * nWeeks),
    expected_final_bankroll: r2(mean(finals)),
    expected_profit_units: r2(mean(finals) - start),
    /** Return on total money put through the window — the meaningful ROI here. */
    roi_on_turnover: r4((mean(finals) - start) / (weeklyStake * nWeeks)),
    final_bankroll_percentiles: {
      p5: r2(quantile(finals, 0.05)), p25: r2(quantile(finals, 0.25)),
      p50: r2(quantile(finals, 0.5)), p75: r2(quantile(finals, 0.75)),
      p95: r2(quantile(finals, 0.95))
    },
    probability_losing_month: r4(losingMonths / nSims),
    probability_down_20pct: r4(ruinish / nSims),
    max_drawdown: {
      mean: r4(mean(maxDrawdowns)),
      p50: r4(quantile(maxDrawdowns, 0.5)),
      p95: r4(quantile(maxDrawdowns, 0.95)),
      worst: r4(Math.max(...maxDrawdowns))
    },
    worst_single_week_units: r2(Math.min(...worstWeeks)),
    mean_bankroll_path: meanPath.map(v => r2(v / nSims)),
    correlation_note: describeCorrelation(staked),
    method: `${nSims} draws x ${nWeeks} weeks. Each bet's win probability is its own measured rate ` +
      '(Wong leg rate^legs for teasers; 0.5 + measured line edge for shopped sides). No game forecast is used.'
  };
}

/* --------------------------------------------------------- the bounded loop */

/**
 * Clamp a proposed allocation to what the staking gate already permitted.
 *
 * This is the function that makes "the AI cannot over-bet" a property of the
 * code rather than a property of the prompt. Unknown ids are dropped, units are
 * clamped into [0, ceiling], and the slate total is trimmed — proportionally,
 * so trimming does not silently re-rank Claude's priorities — to the portfolio
 * cap.
 */
export function applyAllocation(offered, allocation, { policy = SLATE_POLICY } = {}) {
  const byId = new Map((offered ?? []).map(o => [o.id, o]));
  const notes = [];
  let bets = [];
  for (const a of allocation ?? []) {
    const o = byId.get(a?.id);
    if (!o) { if (a?.id) notes.push(`Dropped "${a.id}" — not among the offered opportunities.`); continue; }
    const asked = Number(a.units);
    if (!Number.isFinite(asked) || asked <= 0) continue;
    const units = Math.min(asked, o.ceiling_units);
    if (units < asked) notes.push(`${o.id} clamped from ${r2(asked)}u to the gate's ${o.ceiling_units}u ceiling.`);
    bets.push({ ...o, units: r2(units), rationale: typeof a.why === 'string' ? a.why : null });
  }
  const total = bets.reduce((s, b) => s + b.units, 0);
  if (total > policy.max_slate_units && total > 0) {
    const scale = policy.max_slate_units / total;
    bets = bets.map(b => ({ ...b, units: r2(b.units * scale) }));
    notes.push(`Slate scaled by ${r2(scale)} to the ${policy.max_slate_units}u portfolio cap.`);
  }
  return { bets, total_units: r2(bets.reduce((s, b) => s + b.units, 0)), adjustments: notes };
}

/**
 * The packet the review call reads.
 *
 * Deliberately the simulation's actual output rather than a verdict computed
 * from it. There is no threshold in this module that decides whether the slate
 * is acceptable — the numbers go over, and the reasoning about them happens in
 * the model. That is the whole point of the design: a rule that fires at
 * "drawdown > 0.15" would be a rule wearing a reasoning costume, and it would
 * be blind to the thing that actually matters, which is whether THIS shape of
 * risk is worth THIS shape of return given what the slate is made of.
 */
/**
 * The same slate with the measured edge removed, as a reference point.
 *
 * This exists because of a systematic failure in the first measured run of this
 * feature: across nine live runs on three different slates, the review call
 * revised DOWNWARD every single time — including on a lone, well-priced bet
 * carrying a genuine 6.34pp edge, which it cut nearly in half after reading a
 * "59.8% chance of a losing month".
 *
 * That reaction was not stupid, it was unanchored. A ~50-60% chance of a losing
 * month is the ORDINARY condition of a small positive edge bet in small
 * fractional-Kelly units: weekly outcomes are lumpy, the edge is a few
 * percentage points, and most months are close to flat in either direction.
 * Presented alone, that number reads like an alarm. It is not one. Presented
 * next to what the same slate does with NO edge at all, it becomes what it
 * actually is — a measurement of variance, not of danger — and the difference
 * between the two columns is the edge doing its work.
 *
 * So the briefing shows both. This is a robustness question the reader wants
 * answered anyway ("what if the measured rate does not hold forward?"), and it
 * costs one extra JS simulation — about two milliseconds — with no extra API
 * call. It is not a threshold and it does not decide anything: it is the second
 * number that makes the first one legible.
 */
export function nullComparison(bets, { policy = SLATE_POLICY, simulate = simulateSlate } = {}) {
  return simulate(bets, { policy, nullEdge: true });
}

export function simulationBriefing(sim, slate, nullSim = null) {
  if (!sim?.simulated) return `The simulation could not run: ${sim?.reason ?? 'unknown'}.`;
  const pct = v => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const p = sim.final_bankroll_percentiles;
  const reference = nullSim?.simulated ? `

FOR REFERENCE — THE SAME BETS AT THE SAME STAKES WITH NO EDGE AT ALL
Identical slate, identical sizes, but every win probability replaced by the price's own implied probability (i.e. assuming the measured edge is not real):
  Expected final bankroll   ${nullSim.expected_final_bankroll}u  (${nullSim.expected_profit_units >= 0 ? '+' : ''}${nullSim.expected_profit_units}u)
  Chance of a losing month  ${pct(nullSim.probability_losing_month)}
  Max drawdown p95          ${pct(nullSim.max_drawdown.p95)}
Read the two columns together. A chance of a losing month near 50% is the ORDINARY condition of a small edge bet in fractional-Kelly units — it is a fact about variance, not a warning. What tells you the edge is working is the GAP between the two columns (${sim.expected_profit_units >= nullSim.expected_profit_units ? '+' : ''}${r2(sim.expected_profit_units - nullSim.expected_profit_units)}u of expected bankroll), not the absolute level of either.` : '';
  return `SIMULATION OF THE SLATE YOU JUST PROPOSED — ${sim.sims} draws over ${sim.weeks} weeks, starting from ${sim.starting_bankroll}u.

You proposed ${slate.total_units}u per week across ${sim.bets} bet(s):
${slate.bets.map(b => `  - ${b.id} | ${b.label} | ${b.units}u | measured win prob ${b.win_probability} at ${b.american_price}`).join('\n')}

WHAT THE SIMULATION SAYS
  Expected final bankroll   ${sim.expected_final_bankroll}u  (${sim.expected_profit_units >= 0 ? '+' : ''}${sim.expected_profit_units}u)
  ROI on turnover           ${pct(sim.roi_on_turnover)} of the ${sim.total_staked_over_horizon}u put through
  Final bankroll spread     p5 ${p.p5}u | p25 ${p.p25}u | median ${p.p50}u | p75 ${p.p75}u | p95 ${p.p95}u
  Chance of a losing month  ${pct(sim.probability_losing_month)}
  Chance of finishing -20%  ${pct(sim.probability_down_20pct)}
  Max drawdown across paths mean ${pct(sim.max_drawdown.mean)} | median ${pct(sim.max_drawdown.p50)} | p95 ${pct(sim.max_drawdown.p95)} | worst ${pct(sim.max_drawdown.worst)}
  Worst single week         ${sim.worst_single_week_units}u
  Mean bankroll by week     ${sim.mean_bankroll_path.join('u → ')}u
  ${sim.correlation_note}

${sim.method}${reference}

READ THIS AND DECIDE. The expectation is positive by construction — every bet here cleared a staking gate — so "it is +EV" is not the question. The question is whether the SHAPE of this is what you intended when you allocated: the drawdown, the losing-month frequency, and how much of the downside comes from bets that fail together rather than separately.

HOLDING IS A REAL ANSWER AND OFTEN THE RIGHT ONE. These stakes came from a quarter-Kelly gate that is already deliberately conservative, so a slate that merely looks volatile is usually a slate that is correctly sized — cutting it further gives up the edge without buying much safety. Revise when the simulation shows you something you actually got wrong: exposure concentrated in bets that fail together, a drawdown driven by correlation you did not price, a bet whose contribution is not worth its share of the tail. Do not revise merely because the numbers look uncomfortable in isolation.

You may only lower stakes or drop bets. You cannot raise a stake above the ceiling already shown to you, and you cannot add a bet that was not offered.

Respond with ONLY JSON, no other fields:
{"decision":"hold" or "revise",
 "assessment":"two or three sentences on what the simulation output actually says about this slate — cite the specific numbers that drove your decision",
 "changed_my_mind":"one sentence: what in the simulation was different from what you assumed when you first allocated, or 'nothing' if it matched",
 "slate":[{"id":"offered id","units":number,"why":"one line"}]}
The "slate" array is your FINAL allocation. On "hold" repeat your original allocation unchanged.`;
}

/**
 * Propose → simulate → review → (re-simulate if revised) → commit.
 *
 * TWO CALLS, AND THE CAP IS STRUCTURAL. `propose` and `review` are each
 * referenced exactly once and there is no loop construct in this function, so
 * "at most 2 Claude calls" cannot drift as the code changes — the same
 * discipline `draft-advice-verify.js#proposeVerifyRetry` uses on the draft
 * clock, for the same reason: an unbounded verification loop is an unbounded
 * latency, and a live slate has a kickoff.
 *
 * The review call ALWAYS fires when there is a slate. It is not gated behind a
 * numeric disagreement test, because a threshold gate is precisely the shallow
 * check this feature exists to avoid — the model looks at its own slate's
 * simulated bankroll path and decides for itself whether the allocation it
 * chose is the allocation it still wants. Holding is a real outcome, and a
 * "hold" that cites the numbers is worth more than a rule that never fired.
 *
 * When the review revises, the committed slate is re-simulated in JS (free,
 * milliseconds, no API call) so what ships is the simulation OF THE SLATE BEING
 * RECOMMENDED rather than of the one that was abandoned.
 *
 * Every side effect is injected, so the whole loop is testable without an API
 * key, a database or a live slate.
 *
 * @param offered   gated opportunities (ceiling_units > 0)
 * @param propose   async (offered) => ({ allocation, reasoning, raw })
 * @param review    async (briefing, context) => ({ decision, assessment, changed_my_mind, slate })
 */
export async function reasonAboutSlate({ offered, propose, review, policy = SLATE_POLICY, simulate = simulateSlate }) {
  const t0 = Date.now();
  if (!offered?.length) {
    return {
      status: SLATE_STATUS.EMPTY, claude_calls: 0, slate: { bets: [], total_units: 0 },
      note: 'No opportunity cleared the staking gate, so there was nothing to allocate. ' +
        'This is the common case and it is the gate working: a shopped price with no line ' +
        'advantage does not beat the vig, and a teaser outside its price floor is negative.',
      latency_ms: { propose_ms: 0, simulate_ms: 0, review_ms: 0, resimulate_ms: 0, total_ms: Date.now() - t0 }
    };
  }

  const first = await propose(offered);
  const tProposed = Date.now();
  const proposedSlate = applyAllocation(offered, first?.allocation, { policy });

  const simulation = simulate(proposedSlate.bets, { policy });
  const nullSimulation = nullComparison(proposedSlate.bets, { policy, simulate });
  const tSimulated = Date.now();

  // Exactly one more call. Whatever comes back is final.
  const second = await review(simulationBriefing(simulation, proposedSlate, nullSimulation),
    { simulation, null_simulation: nullSimulation, slate: proposedSlate, offered });
  const tReviewed = Date.now();

  const revised = second?.decision === 'revise';
  const finalSlate = revised ? applyAllocation(offered, second?.slate, { policy }) : proposedSlate;
  const finalSimulation = revised ? simulate(finalSlate.bets, { policy }) : simulation;
  const tDone = Date.now();

  const effect = revised ? revisionEffect(simulation, finalSimulation, proposedSlate, finalSlate) : null;

  return {
    status: revised ? SLATE_STATUS.REVISED : SLATE_STATUS.CONFIRMED,
    claude_calls: 2,
    slate: finalSlate,
    proposed_slate: revised ? proposedSlate : null,
    reasoning: {
      initial: first?.reasoning ?? null,
      review_assessment: second?.assessment ?? null,
      changed_my_mind: second?.changed_my_mind ?? null
    },
    simulation: finalSimulation,
    simulation_no_edge: nullSimulation,
    simulation_of_proposal: revised ? simulation : null,
    revision_effect: effect,
    exposure_change_units: revised ? r2(finalSlate.total_units - proposedSlate.total_units) : 0,
    note: revised
      ? `Revised after simulation: first instinct was ${proposedSlate.total_units}u across ${proposedSlate.bets.length} bet(s), ` +
        `committed ${finalSlate.total_units}u across ${finalSlate.bets.length}. ${effect.summary}`
      : `Confirmed after simulation: the ${finalSlate.total_units}u allocation held once its bankroll path was simulated.`,
    human_approval_required: true,
    disclaimer: 'A recommendation for a human to approve. Nothing here places a bet or moves money.',
    latency_ms: {
      propose_ms: tProposed - t0,
      simulate_ms: tSimulated - tProposed,
      review_ms: tReviewed - tSimulated,
      resimulate_ms: tDone - tReviewed,
      total_ms: tDone - t0
    }
  };
}

/**
 * Did the revision actually change the risk, or only the tickets?
 *
 * This exists because of something the first live run of this feature did, and
 * it is worth recording rather than smoothing over. Handed a slate holding a
 * shopped Rams side plus a teaser containing the same Rams game, the model read
 * the simulation correctly — it cited the 50.7% losing-month rate, the 13.8%
 * p95 drawdown and the -4.79u worst week, and concluded, accurately, that the
 * per-bet ceilings had not accounted for the 0.80 same-game correlation. Then
 * it "revised" by swapping one teaser for a different teaser that contained the
 * SAME shared game. Identical exposure, identical correlation, identical
 * simulated bankroll path. The stated intent was to cut tail risk; the change
 * cut nothing.
 *
 * A `status: revised` flag on its own would have reported that as the
 * verification loop working. It is not: it is the loop producing a confident
 * sentence attached to a null edit, which is exactly the failure mode this
 * whole feature was built to avoid on the prediction side. So the committed
 * slate's simulation is compared against the abandoned one and the difference
 * is stated as a number. A revision that moved nothing is labelled as such, and
 * the reader can see it without re-reading the model's prose.
 *
 * The comparison is deliberately on the SIMULATED RISK rather than on the bet
 * list, because changing which tickets are held is not the same as changing
 * what is at risk, and only the second one matters.
 */
export function revisionEffect(before, after, proposedSlate, finalSlate) {
  const beforeSet = new Set(proposedSlate.bets.map(b => b.id));
  const afterSet = new Set(finalSlate.bets.map(b => b.id));
  const composition_changed = beforeSet.size !== afterSet.size
    || [...beforeSet].some(id => !afterSet.has(id));
  const exposure = r2(finalSlate.total_units - proposedSlate.total_units);
  const ddDelta = before?.simulated && after?.simulated
    ? r4(after.max_drawdown.p95 - before.max_drawdown.p95) : null;
  const lossDelta = before?.simulated && after?.simulated
    ? r4(after.probability_losing_month - before.probability_losing_month) : null;
  const p5Delta = before?.simulated && after?.simulated
    ? r2(after.final_bankroll_percentiles.p5 - before.final_bankroll_percentiles.p5) : null;
  // "Material" is a change the simulation can actually resolve. At a few
  // hundred draws, a drawdown difference under half a point is noise.
  const material = (ddDelta != null && Math.abs(ddDelta) >= 0.005)
    || (lossDelta != null && Math.abs(lossDelta) >= 0.01)
    || Math.abs(exposure ?? 0) >= 0.25;
  return {
    composition_changed,
    exposure_change_units: exposure,
    p95_drawdown_change: ddDelta,
    losing_month_change: lossDelta,
    p5_bankroll_change: p5Delta,
    material,
    summary: material
      ? `The revision moved the simulated risk: exposure ${exposure >= 0 ? '+' : ''}${exposure}u, ` +
        `p95 drawdown ${ddDelta >= 0 ? '+' : ''}${((ddDelta ?? 0) * 100).toFixed(1)}pp, ` +
        `losing-month rate ${lossDelta >= 0 ? '+' : ''}${((lossDelta ?? 0) * 100).toFixed(1)}pp.`
      : composition_changed
        ? 'The revision swapped tickets but did not change the simulated risk — same exposure, same ' +
          'drawdown, same losing-month rate. Treat the stated rationale with suspicion: the bets ' +
          'changed and what is at risk did not.'
        : 'The revision changed nothing measurable.'
  };
}

/** The prompt for the first call. Facts only — every number here was measured. */
export function proposalPrompt(offered, { policy = SLATE_POLICY } = {}) {
  return `You are allocating a bankroll across live betting opportunities. Every opportunity below has a MEASURED edge that required no forecast of any game. You are NOT being asked to predict any outcome, and you must not.

BANKROLL ${policy.bankroll_units}u. Portfolio cap ${policy.max_slate_units}u total this week. Per-bet ceilings are already computed by the staking gate and you cannot exceed them.

LIVE OPPORTUNITIES
${offered.map(o => `- id: ${o.id}
  ${o.label}${o.matchup ? ` (${o.matchup})` : ''}
  measured win probability ${o.win_probability} at ${o.american_price} (market implies ${r4(impliedProb(o.american_price))}, edge ${o.edge})
  staking gate allows up to ${o.ceiling_units}u
  basis: ${o.measured.basis}. ${o.measured.note}
  settles on: ${o.games.map(g => g.matchup ?? g.event_id).join(', ')}`).join('\n')}

WHAT THIS DECISION ACTUALLY TURNS ON
  - These are not independent. Two bets settling on the same game move together; a teaser already spans several games. Correlated positions concentrate risk that a per-bet ceiling does not see.
  - Taking every ceiling is not the answer. The ceilings were computed one bet at a time.
  - A thin edge on a correlated bet can be worth less than a smaller edge on an uncorrelated one.

Respond with ONLY JSON, no other fields:
{"reasoning":"three sentences max on how you allocated and what correlation you are managing",
 "slate":[{"id":"exact id from above","units":number,"why":"one line"}]}
Omit any opportunity you do not want. Units may be fractional.`;
}
