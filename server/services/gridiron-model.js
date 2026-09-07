/**
 * One model, in the only sense in which that is a good idea.
 *
 * There are now roughly thirty components in this platform that produce an
 * opinion, and the obvious reading of "consolidate them into one mega model" is
 * to average their outputs. That would make the platform strictly worse, and it
 * is worth being precise about why, because the intuition behind the request is
 * right and only the mechanism is wrong.
 *
 * Six of these components are MEASURED DEAD. The simulator picks spread winners
 * at 42.86% where 52.38% breaks even. Trend-based totals came in at 43.81%,
 * significantly below break-even. Gradient boosting on the residual is worse
 * than predicting zero. Averaging a dead estimator with a live one does not
 * produce a better estimator; it produces a worse one, diluted in exact
 * proportion to the weight you gave the corpse. A single model that consumed
 * everything would be a machine for laundering six failures into one number
 * nobody could audit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CONSOLIDATION ACTUALLY MEANS HERE
 *
 * The real fragmentation is not that there are many models. It is that the
 * knowledge of WHICH model may answer WHICH question, and on what evidence,
 * lives in comments, in a handful of audit rows, and in whoever last read them.
 * Nothing enforces it. A page can call a dead forecaster and render its number
 * with the same confidence as a measured one, and several have.
 *
 * So this is one entry point over every capability, where each carries:
 *
 *   ITS EVIDENCE     the sealed audit or validation that measured it, by id,
 *                    read from the database rather than restated here, so it
 *                    cannot drift from the record.
 *   ITS AUTHORITY    what it is permitted to influence, derived from that
 *                    evidence rather than asserted.
 *   ITS REFUSAL      what it must not be used for, stated at the point of use.
 *
 * `ask()` routes a question to the components entitled to answer it and refuses
 * where none are. That is a consolidation of AUTHORITY, which is the thing that
 * was actually scattered.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE COMBINING IS LEGITIMATE
 *
 * Two estimators of the same quantity, both with a measured error, combine
 * correctly by inverse-variance weighting: w ∝ 1/σ². This is not a preference,
 * it is the minimum-variance unbiased combination, and it has a property that
 * makes it exactly right for this codebase — an estimator with no measured
 * error has infinite variance and therefore zero weight. The dead models fall
 * out of the arithmetic on their own, with no special case and no list to
 * maintain.
 *
 * The one honest caveat, stated in the output rather than hidden: inverse-
 * variance weighting assumes independent errors, and two projections of the same
 * player built from overlapping data are correlated. The combination is still an
 * improvement over either alone; the *size* of the improvement is overstated by
 * the standard formula, and `consensus()` reports the correlation caveat
 * alongside the result rather than quietly claiming the full gain.
 */
import { rows, row } from '../db/index.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * What a component is allowed to influence.
 *
 * Derived from evidence, never asserted. The ladder is deliberately short —
 * finer gradations invite argument about which rung something sits on, and the
 * only distinction that changes behaviour is whether a number may move money.
 */
export const AUTHORITY = {
  /** Measured positive on real outcomes. May size a real-money decision. */
  authoritative: {
    rank: 3,
    may: ['inform', 'rank', 'size'],
    means: 'Measured positive against real outcomes on a sample large enough to mean something.'
  },
  /** Structurally sound, forward-unproven. May inform, may not size. */
  advisory: {
    rank: 2,
    may: ['inform', 'rank'],
    means: 'The method is sound and the inputs are honest, but nothing has yet shown it makes ' +
      'money or beats a market. It can order a list; it cannot justify a stake.'
  },
  /** Interesting, unvalidated. Visible, must not influence a decision. */
  research: {
    rank: 1,
    may: ['inform'],
    means: 'Shown for inspection only. Reading it is fine; routing a decision through it is not.'
  },
  /** Measured negative. Must not be used for anything but the record of failure. */
  retired: {
    rank: 0,
    may: [],
    means: 'Measured negative on a sealed audit. Kept so the failure is on the record and nobody ' +
      'rebuilds it, and excluded from every decision path.'
  }
};

/**
 * The capability map.
 *
 * `audit` names a sealed row in audit_registry; status is read from it at call
 * time rather than copied here, so this file cannot claim a component passed
 * when the registry says it failed. Where a capability has no sealed audit, that
 * is stated as the reason for its authority rather than left blank.
 */
const CAPABILITIES = [
  /* ---------------------------------------------------------------- fantasy */
  {
    id: 'fantasy.projection',
    question: 'How many points will this player score?',
    module: 'player-week-engine + player-head-registry',
    domain: 'fantasy',
    evidence: { kind: 'validation', source: 'player_head_audits' },
    baseAuthority: 'advisory',
    refuses: 'Cannot be used to price a bet. Forecast quality is not betting profitability, and ' +
      'this has never been tested against a market.'
  },
  {
    id: 'fantasy.start_sit',
    question: 'Who should I start this week?',
    module: 'lineup-brain',
    domain: 'fantasy',
    evidence: { kind: 'derived', from: 'fantasy.projection' },
    baseAuthority: 'advisory',
    refuses: 'Margins inside about 1.5 points are inside the projection error and are reported as ' +
      'ties rather than as decisions.'
  },
  {
    id: 'fantasy.waivers',
    question: 'Who on the wire would improve my lineup?',
    module: 'waiver-brain',
    domain: 'fantasy',
    evidence: { kind: 'structural', note: 'Solves the lineup with and without each candidate.' },
    baseAuthority: 'advisory'
  },
  {
    id: 'fantasy.trade_plan',
    question: 'Which trade should I actually send?',
    module: 'league-brain',
    domain: 'fantasy',
    evidence: { kind: 'structural',
      note: 'Ranks by acceptance probability times gain. The acceptance curve is elicited from the ' +
        'user, not fitted — no fantasy league produces enough trade history to fit one.' },
    baseAuthority: 'advisory',
    refuses: 'The acceptance probabilities are stated assumptions. Treating them as measurements ' +
      'would be false precision.'
  },
  {
    id: 'fantasy.td_regression',
    question: 'Whose touchdown rate is about to change?',
    module: 'td-regression',
    domain: 'fantasy',
    evidence: { kind: 'fitted',
      note: 'Rates fitted per position group by expectation-maximisation over 16,000 player-weeks.' },
    baseAuthority: 'advisory',
    refuses: 'Predicts the touchdown component only. A genuine regression candidate can still be a ' +
      'bad hold if his role is shrinking.'
  },
  {
    id: 'fantasy.trends',
    question: 'What has changed about this team lately?',
    module: 'weekly-trends + trend-exploits',
    domain: 'fantasy',
    evidence: { kind: 'method',
      note: 'Welch t-test against the team\'s own baseline, Sidak-corrected across a pre-specified ' +
        'shortlist. The METHOD is sound; that a detected trend predicts fantasy outcomes forward ' +
        'has not been tested.' },
    baseAuthority: 'advisory',
    refuses: 'Measured NOT to transfer to betting — see betting.trend_totals.'
  },
  {
    id: 'fantasy.liquidity',
    question: 'Can I even trade for this position?',
    module: 'position-liquidity',
    domain: 'fantasy',
    evidence: { kind: 'structural', note: 'Counts startable depth against roster requirements.' },
    baseAuthority: 'advisory'
  },
  {
    id: 'fantasy.bye_risk',
    question: 'Which future weeks already cost me points?',
    module: 'roster-risk',
    domain: 'fantasy',
    evidence: { kind: 'structural', note: 'Re-solves the lineup without the players on bye.' },
    baseAuthority: 'advisory'
  },
  {
    id: 'fantasy.draft_board',
    question: 'Who should I draft right now?',
    module: 'draft-assist + draft-lookahead',
    domain: 'fantasy',
    evidence: { kind: 'validation',
      note: 'Value over an EXPECTED replacement level (survival model, not a static cutoff), fit ' +
        'and graded against 2,182 matched ECR player-seasons 2021-2025. RB over WR at overall ' +
        '13-36 (t=3.4), a rookie-WR premium (t=3.4), and "gone by my next pick" beating a naive ' +
        'baseline on out-of-fold log-loss (0.166/0.159 vs 0.182/0.177). docs/DRAFT_AUDIT_2021_2025.md.' },
    baseAuthority: 'advisory',
    note: 'The strongest evidence in the fantasy domain, and it does not depend on beating the ' +
      'market on point projection — it prices where the market\'s own rank order is mispriced ' +
      'against how a snake draft actually plays out, a different and better-fitting question. The ' +
      'Monte Carlo lookahead (200 sims x 6 candidates) draws BOTH draft order and each player\'s ' +
      'season outcome, the latter through correlation.js\'s Gaussian copula with marginals from ' +
      'the preseason p20/p80 band (2026-09-07; before that it drew only draft order and its ' +
      'reported spread described who else got drafted, not how anyone performed). Roster spread ' +
      'now matches the realized 13.7% measured on 2023-2025. docs/DRAFT_LOOKAHEAD_VARIANCE.md.',
    refuses: 'Cannot be read as "this player will outscore that one" — it answers a roster-' +
      'construction question, not a point-projection one.'
  },
  {
    id: 'fantasy.preseason_projection',
    question: 'How many points will this player score this season, before Week 1?',
    module: 'preseason-model',
    domain: 'fantasy',
    evidence: { kind: 'validation',
      note: 'Ridge, GBM (the same nfl-gbm.js used by the betting engine) and three stacked blends ' +
        'were walk-forward fit for 2023/2024/2025 and none beat a calibrated market-rank curve by a ' +
        'significant margin on any season (pooled Spearman 0.591 / MAE 58.0 for the curve vs 0.571 / ' +
        '59.4 for the GBM). The p20-p80 band shipped with 69% out-of-sample coverage against a 60% ' +
        'nominal target, fixed 2026-09-07 with a rank-local recalibration (pinball loss improved ' +
        'significantly, pooled, clustered by season). docs/PRESEASON_MODEL.md, docs/PRESEASON_BAND_CALIBRATION.md.' },
    baseAuthority: 'advisory',
    note: 'What ships is the market curve itself, not a learned model of it — the point estimate IS ' +
      'the calibrated ADP-to-points translation. Learned heads survive only as the ordering behind ' +
      'the driver text shown on a player\'s row, never as the number.',
    refuses: 'The point estimate does not and is not claimed to beat the market. Do not read a ' +
      'disagreement between this and ESPN\'s own line as a discovered edge.'
  },

  /* ---------------------------------------------------------------- betting */
  {
    id: 'betting.line_shopping',
    question: 'Which book pays most for this bet?',
    module: 'nfl-shopping-board + nfl-execution',
    domain: 'betting',
    audit: 'line shopping saves win rate',
    evidence: { kind: 'sealed_audit' },
    baseAuthority: 'authoritative',
    note: 'The only component here measured positive on real outcomes. It requires no forecast — ' +
      'it is arithmetic on prices visible before the bet.'
  },
  {
    id: 'betting.teasers',
    question: 'Is this teaser worth betting?',
    module: 'nfl-teasers + nfl-teaser-execution',
    domain: 'betting',
    evidence: { kind: 'historical',
      note: '74.69% per leg over 1,391 legs across 26 seasons. Worth +6.5% at -110 and -1.3% at ' +
        '-130, so the entire edge is the price.' },
    baseAuthority: 'advisory',
    refuses: 'Cannot size until a real book price is recorded. The historical rate is not an edge ' +
      'at an unknown price.'
  },
  {
    id: 'betting.live_winprob',
    question: 'Who is winning this game right now?',
    module: 'nfl-live',
    domain: 'betting',
    audit: 'live win probability is calibrated',
    evidence: { kind: 'sealed_audit' },
    baseAuthority: 'authoritative',
    refuses: 'Calibrated against outcomes, never tested against a live PRICE. Being right is not ' +
      'the same as being right before the market, and a 20-second latency is a hard gate.'
  },
  {
    id: 'betting.simulator',
    question: 'How will this game play out?',
    module: 'nfl-drive-sim',
    domain: 'betting',
    audit: 'simulator beats closing line ATS',
    evidence: { kind: 'sealed_audit' },
    baseAuthority: 'advisory',
    note: 'Excellent as a DESCRIPTION of football — its play mix matches reality across 178,095 ' +
      'plays and its deterministic totals land within 2.4 points. Measured dead as a betting tool. ' +
      'Those are different skills and the registry separates them.'
  },
  {
    id: 'betting.trend_totals',
    question: 'Does a team trend predict the total?',
    module: 'weekly-trends applied to totals',
    domain: 'betting',
    audit: 'team trend predicts the game total',
    evidence: { kind: 'sealed_audit' },
    baseAuthority: 'advisory'
  },
  {
    id: 'betting.model_spread',
    question: 'Who covers the spread?',
    module: 'nfl-market + nfl-ensemble',
    domain: 'betting',
    audit: 'CLV across five seasons (powered)',
    evidence: { kind: 'sealed_audit' },
    baseAuthority: 'advisory',
    refuses: 'Sizing is blocked in nfl-execution-edge until proven closing-line value exists. This ' +
      'is enforced in code, not by convention.'
  },
  {
    id: 'betting.slate_allocation',
    question: 'Of the proven edges live right now, which should I take together and at what size?',
    module: 'execution-slate-reasoning',
    domain: 'betting',
    evidence: { kind: 'structural',
      note: 'Adds no edge of its own. It allocates across opportunities whose edge was measured ' +
        'elsewhere (line shopping, Wong teasers), reasons over a Monte Carlo of the proposed ' +
        'slate\'s bankroll path, and may only lower a stake the staking gate already permitted. ' +
        'The allocation judgement itself has never been measured against outcomes.' },
    baseAuthority: 'advisory',
    refuses: 'Cannot size on its own authority — every ceiling comes from nfl-execution-edge\'s ' +
      'stakeFor gate and this layer can only clamp downward. It forecasts no game: the drive ' +
      'simulator is 46.91% directional and is deliberately absent from this path. It recommends ' +
      'only; a human approves and places every bet.'
  },

  /* ------------------------------------------------------------- crossover */
  {
    id: 'crossover.vegas_to_fantasy',
    question: 'What does the betting market imply for fantasy volume?',
    module: 'gamescript -> waiver-brain.vegasLift',
    domain: 'crossover',
    evidence: { kind: 'fitted',
      note: 'Game-script multipliers fitted out of sample and clamped to [0.75, 1.30].' },
    baseAuthority: 'advisory',
    note: 'Applied to a start/sit call at full weight because that decision IS one week, and to a ' +
      'trade valuation at a quarter weight because a single line says little about fifteen weeks.'
  },
  {
    id: 'crossover.fantasy_to_betting_spread_total',
    question: 'Do the fantasy player engines improve the spread or total line?',
    module: 'nfl-team-strength (challenger, feature contract team_strength_aggregate)',
    domain: 'crossover',
    evidence: { kind: 'sealed_audit_negative',
      note: 'Team-level aggregates (projected offensive points, vacated opportunity, returning ' +
        'production, QB1 change/QBR delta) walk-forward tested against the market-consensus ' +
        'champion, 2,211 games 2023-2025. Spread: 0 of 3 seasons significant, pooled +0.02 MAE ' +
        '(worse). Total: 1 of 3 significant and the sign reverses the next season, pooled interval ' +
        'straddles zero. In 5 of 6 season-market cells the champion itself loses to a zero-residual ' +
        'baseline, so this reproduces the standing zero-edge-vs-closing-lines finding rather than ' +
        'fixing it. docs/BETTING_PLAYER_ENGINES.md.' },
    baseAuthority: 'retired',
    note: 'Kept in the registry, not deleted, specifically so this is not proposed and rebuilt next ' +
      'season without the numbers being read first. Both feature contracts recorded blocked via ' +
      'model-governance.js; the champion model was never touched.'
  },
  {
    id: 'crossover.fantasy_to_betting_props',
    question: 'Do the fantasy player engines improve TD prop calibration?',
    module: 'nfl-prop-player-heads + nfl-prop-player-weekly-heads (two challengers, both retired)',
    domain: 'crossover',
    evidence: { kind: 'sealed_audit_negative',
      note: 'Tried twice, at two grains, both declined. SEASON-GRAIN (career TD rate, preseason ' +
        'role band, offseason churn -- constant across a player\'s 17 weeks): 0 of 3 seasons ' +
        'significant on anytime and 2+ TD. WEEKLY-GRAIN retry (within-season red-zone opportunity ' +
        'trend, opponent-share trend, goal-line trend, opponent red-zone defense as a guarded ' +
        'separate arm): also 0 of 3 both markets, and 3 of the significant ablation cells were ' +
        'significantly WORSE for the challenger. docs/PROPS_PLAYER_ENGINES.md, ' +
        'docs/PROPS_PLAYER_ENGINES_WEEKLY.md.' },
    baseAuthority: 'retired',
    note: 'The season-grain retirement guessed the cause was grain -- a constant can\'t separate ' +
      'two games. The weekly retry checked that guess directly: the trend features are genuinely ' +
      'NEW information (correlation with the shipped model\'s own logit ~0.04-0.06, versus ~0.29-' +
      '0.32 for their own levels, so they are not just a restatement of what the model already ' +
      'knows) and it still bought nothing. So grain was never the binding constraint -- within-' +
      'season DIRECTION of red-zone role carries no incremental TD signal beyond its LEVEL, at ' +
      'either grain. That is the more informative null, and it closes this line rather than ' +
      'leaving a "try weekly next" open item.'
  },
  {
    id: 'fantasy.adp_source_disagreement',
    question: 'Does disagreement between ESPN/Sleeper/FFC ranks predict anything, the way book ' +
      'disagreement predicts a line-shopping edge?',
    module: '(research script, not a service -- see docs/ADP_DISAGREEMENT.md)',
    domain: 'fantasy',
    evidence: { kind: 'sealed_audit_negative',
      note: 'The literal cross-source question is unanswerable from retained data (ranks and ' +
        'realized outcomes never overlap in storage -- flagged as a cheap future fix). Tested the ' +
        'closest proxy instead, expert-ranker dispersion already in the model since v1: adding a ' +
        'disagreement term to the market curve is 0 of 3 seasons significant, every CI straddles ' +
        'zero. Direction (who is "wrong" and which way) has no consistent sign across seasons.' },
    baseAuthority: 'retired',
    note: 'One non-null side finding -- high-disagreement players show ~1.2-1.4x the outcome ' +
      'variance of low-disagreement players at the same rank, 2 of 3 seasons -- answers a band-' +
      'width question, not a ranking one, and was deliberately not shipped on that basis.'
  },
  {
    id: 'fantasy.draft_board_abstention',
    question: 'Can the draft board flag its own coin-flip recommendations in advance?',
    module: 'draft-abstention-audit (standalone instrument, imported by nothing)',
    domain: 'fantasy',
    evidence: { kind: 'sealed_audit_negative',
      note: 'A gate on pre-outcome coverage facts (no prior usage, rookie, missing projection, wide ' +
        'band, thin expert agreement) was graded, kept-vs-declined, against realized value on the ' +
        '2021-2025 panel. 0 of 3 seasons significant at any gate strength; the separation\'s sign ' +
        'flips between seasons; the strictest gate picked the worst players most clearly in one ' +
        'season (significant, wrong direction). docs/DRAFT_BOARD_ABSTENTION.md.' },
    baseAuthority: 'retired',
    note: 'Directly mirrors a betting-side result: its own confidence gate backfired the same way ' +
      '(top-3-confidence picks at 45.1%, below the all-games rate). Kept as a record so the idea ' +
      'is not re-proposed as though it were untried.'
  }
];

/**
 * Live status for one capability, read from the registry rather than restated.
 *
 * A capability whose sealed audit FAILED is retired here regardless of what it
 * claims about itself. This is the enforcement point: the file cannot lie about
 * a result, because it does not hold the result.
 */
function statusOf(cap) {
  if (!cap.audit) {
    return { authority: cap.baseAuthority, evidence: cap.evidence, audit: null };
  }
  const a = row(
    `SELECT id, name, observed, threshold, direction, passed, sample_size, status, ran_at
     FROM audit_registry WHERE name = ? AND status = 'sealed'
     ORDER BY ran_at DESC LIMIT 1`, cap.audit);
  if (!a) {
    return { authority: 'research', evidence: cap.evidence, audit: null,
      why: `Claims a sealed audit named "${cap.audit}" and the registry has none. Until that ` +
        'result exists this cannot be trusted above research.' };
  }
  const passed = !!a.passed;
  return {
    // A failed audit retires the capability. A passed one lifts it to
    // authoritative only if the capability was already advisory or better —
    // passing an audit does not promote something that was never sound.
    authority: passed
      ? (AUTHORITY[cap.baseAuthority].rank >= 2 ? 'authoritative' : cap.baseAuthority)
      : 'retired',
    evidence: cap.evidence,
    audit: {
      id: a.id, name: a.name, observed: r4(a.observed), threshold: a.threshold,
      direction: a.direction, passed, sample_size: a.sample_size, ran_at: a.ran_at
    },
    why: passed
      ? `Sealed audit #${a.id}: ${r4(a.observed)} ${a.direction === 'above' ? '>' : '<'} ${a.threshold}.`
      : `Sealed audit #${a.id} FAILED: ${r4(a.observed)} against a ${a.direction === 'above' ? '>' : '<'} ${a.threshold} bar. Retired.`
  };
}

/** Every capability with its live authority. The platform's epistemic state. */
export function modelMap({ domain = null } = {}) {
  const caps = CAPABILITIES
    .filter(c => !domain || c.domain === domain)
    .map(c => {
      const s = statusOf(c);
      return {
        id: c.id, question: c.question, module: c.module, domain: c.domain,
        authority: s.authority,
        may: AUTHORITY[s.authority].may,
        means: AUTHORITY[s.authority].means,
        evidence: s.evidence, audit: s.audit,
        why: s.why ?? (c.evidence?.note ?? null),
        note: c.note ?? null,
        refuses: c.refuses ?? null
      };
    });

  const byAuthority = caps.reduce((m, c) => {
    (m[c.authority] ??= []).push(c.id); return m;
  }, {});

  return {
    capabilities: caps,
    by_authority: byAuthority,
    counts: Object.fromEntries(Object.entries(byAuthority).map(([k, v]) => [k, v.length])),
    can_size: caps.filter(c => c.may.includes('size')).map(c => c.id),
    retired: caps.filter(c => c.authority === 'retired').map(c => ({ id: c.id, why: c.why })),
    note: 'Authority is derived from the sealed audit registry at call time, not asserted here. A ' +
      'capability whose audit failed is retired regardless of what its module claims, which is the ' +
      'entire point of keeping the result somewhere the code cannot edit.'
  };
}

/**
 * Route a question to whatever is entitled to answer it.
 *
 * @param purpose what the answer is for. 'size' demands an authoritative
 *   component and refuses if none exists — which, for every forecasting question
 *   in this platform, is the correct answer and the one that keeps a bankroll.
 */
export function ask(capabilityId, { purpose = 'inform' } = {}) {
  const cap = CAPABILITIES.find(c => c.id === capabilityId);
  if (!cap) {
    return { error: `no capability "${capabilityId}"`,
      available: CAPABILITIES.map(c => c.id) };
  }
  const s = statusOf(cap);
  const may = AUTHORITY[s.authority].may;

  if (!may.includes(purpose)) {
    return {
      capability: cap.id, question: cap.question, authority: s.authority,
      permitted: false, purpose,
      refusal: s.authority === 'retired'
        ? `${cap.id} is retired. ${s.why} Using it to ${purpose} anything is the failure this ` +
          'registry exists to prevent.'
        : `${cap.id} is ${s.authority} and may only ${may.join(', ') || 'do nothing'}. It has not ` +
          `earned the right to ${purpose}. ${AUTHORITY[s.authority].means}`,
      what_would_change_it: s.authority === 'advisory'
        ? 'A sealed audit measuring it positive against real outcomes on an adequate sample.'
        : 'Nothing available. The result is on the record.',
      audit: s.audit
    };
  }

  return {
    capability: cap.id, question: cap.question, module: cap.module,
    authority: s.authority, permitted: true, purpose,
    may, evidence: s.evidence, audit: s.audit,
    why: s.why ?? cap.evidence?.note ?? null,
    caveat: cap.refuses ?? null,
    note: cap.note ?? null
  };
}

/**
 * Combine several estimates of the same quantity by their measured precision.
 *
 * @param estimates [{ source, value, rmse }] — rmse is the measured error. An
 *   estimate without one contributes nothing, which is deliberate: it is the
 *   mechanism by which an unmeasured or dead model is excluded without a list.
 *
 * The weights are w ∝ 1/σ², the minimum-variance unbiased combination. The
 * caveat about correlated errors is returned with the answer rather than left
 * for the reader to remember.
 */
export function consensus(estimates = []) {
  const usable = estimates.filter(e =>
    Number.isFinite(e?.value) && Number.isFinite(e?.rmse) && e.rmse > 0);
  const excluded = estimates.filter(e => !usable.includes(e))
    .map(e => ({ source: e?.source ?? 'unnamed',
      why: !Number.isFinite(e?.value) ? 'no value'
        : 'no measured error, so it has infinite variance and zero weight' }));

  if (!usable.length) {
    return { value: null, excluded,
      refusal: 'Nothing here has a measured error. A combination of unmeasured estimates is not a ' +
        'better estimate, it is an average of guesses wearing the costume of one.' };
  }

  const weights = usable.map(e => 1 / (e.rmse * e.rmse));
  const total = weights.reduce((a, b) => a + b, 0);
  const value = usable.reduce((s, e, i) => s + e.value * weights[i], 0) / total;
  // Theoretical error of the combination under independence.
  const combinedRmse = Math.sqrt(1 / total);
  const best = Math.min(...usable.map(e => e.rmse));

  return {
    value: r2(value),
    combined_rmse_if_independent: r4(combinedRmse),
    best_single_rmse: r4(best),
    contributors: usable.map((e, i) => ({
      source: e.source, value: r2(e.value), rmse: r4(e.rmse),
      weight: r4(weights[i] / total)
    })),
    excluded,
    caveat: usable.length > 1
      ? 'Inverse-variance weighting assumes independent errors. Two projections of the same player ' +
        'are built from overlapping data and are correlated, so the true error of this combination ' +
        `is somewhere between ${r4(combinedRmse)} and ${r4(best)} — closer to the latter the more ` +
        'alike the inputs are. The combination is still no worse than the best input; the *size* of ' +
        'the gain is what the standard formula overstates.'
      : 'Only one estimate had a measured error, so this is that estimate.'
  };
}

/**
 * Measured errors for the fantasy projection heads, read from the validation.
 *
 * `player_head_audits` holds a real out-of-sample tournament: seventeen
 * candidate heads, seven discarded as redundant against a correlation threshold,
 * Holm-corrected across the rest, one survivor. Those RMSEs are exactly what
 * `consensus()` needs, and nothing was reading them.
 */
export function projectionHeads() {
  const a = row(`SELECT result_json FROM player_head_audits ORDER BY created_at DESC LIMIT 1`);
  if (!a?.result_json) return { error: 'no player-head validation on record' };
  let r;
  try { r = JSON.parse(a.result_json); } catch { return { error: 'validation record is unreadable' }; }

  const heads = (r.discovery ?? []).map(d => ({
    id: d.head?.id, name: d.head?.name, family: d.head?.family,
    // Discovery is the out-of-sample season; development is where they were
    // fitted. Only the former is an honest error estimate.
    rmse: d.discovery?.rmse ?? null, mae: d.discovery?.mae ?? null,
    n: d.discovery?.n ?? null, spearman: d.discovery?.spearman ?? null,
    survived: (r.survivors ?? []).includes(d.head?.id),
    holm_passed: !!d.holm?.passed
  })).filter(h => h.rmse != null).sort((a2, b) => a2.rmse - b.rmse);

  return {
    baseline: r.baseline ? {
      id: r.baseline.id, rmse: r.baseline.discovery?.rmse, mae: r.baseline.discovery?.mae,
      n: r.baseline.discovery?.n
    } : null,
    heads,
    survivors: r.survivors ?? [],
    candidates_tested: r.candidates_tested ?? heads.length,
    candidates_redundant: r.candidates_redundant ?? 0,
    production_eligible: !!r.production_eligible,
    note: r.note ?? null,
    caveat: 'These are forecast errors on held-out weeks. They establish that one head predicts ' +
      'fantasy points better than another; they say nothing about beating a market, and the ' +
      'validation record says so itself.'
  };
}

/**
 * The whole picture in one call: what works, what does not, and what that means.
 */
export function stateOfTheModel() {
  const map = modelMap();
  const heads = projectionHeads();
  const sealed = rows(
    `SELECT id, name, observed, threshold, direction, passed, sample_size
     FROM audit_registry WHERE status = 'sealed' ORDER BY passed DESC, id`);

  const authoritative = map.capabilities.filter(c => c.authority === 'authoritative');
  const retired = map.capabilities.filter(c => c.authority === 'retired');

  return {
    counts: map.counts,
    can_size_real_money: map.can_size,
    authoritative: authoritative.map(c => ({ id: c.id, question: c.question, why: c.why })),
    retired: retired.map(c => ({ id: c.id, question: c.question, why: c.why })),
    sealed_audits: { total: sealed.length,
      passed: sealed.filter(s => s.passed).length,
      failed: sealed.filter(s => !s.passed).length },
    projection: heads.error ? null : {
      best_head: heads.heads[0]?.id ?? null,
      best_rmse: heads.heads[0]?.rmse ?? null,
      baseline_rmse: heads.baseline?.rmse ?? null,
      survivors: heads.survivors,
      tested: heads.candidates_tested
    },
    summary:
      `${map.counts.authoritative ?? 0} of ${map.capabilities.length} capabilities have earned the ` +
      `right to size a decision, ${map.counts.advisory ?? 0} may inform one, and ` +
      `${map.counts.retired ?? 0} are retired on a failed audit. That distribution is the honest ` +
      'shape of this platform: the parts that measure something already true work, and the parts ' +
      'that forecast a market do not.',
    why_not_one_number:
      'Averaging every component into a single output would blend six measured-dead forecasters ' +
      'into the live ones and dilute them in exact proportion to the weight given the failures. ' +
      'What is consolidated here is authority — which component may answer which question, on what ' +
      'evidence, read from the sealed registry rather than asserted — and combination is offered ' +
      'only where two estimators of the same quantity both carry a measured error.'
  };
}
