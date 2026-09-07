/**
 * Team-level aggregates of the player-level offseason/preseason engines, for
 * the NFL market models — and nothing else.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 *
 * `docs/OFFSEASON_MODEL.md` §6 ("How the betting engine should consume this")
 * lays down three rules that this file exists to obey rather than reinterpret:
 *
 *   1. TEAM-LEVEL AGGREGATES ONLY. Player multipliers must never reach a market
 *      model. The offseason panel is ~340 player-seasons a year and its shipped
 *      edge is ~3% of MAE — a fantasy-grade signal. Priced per-player into a
 *      team total it would be noise the closing line absorbed in March.
 *   2. ROUTE IT THROUGH `model-governance.js` AS A REGISTERED FEATURE CONTRACT,
 *      STARTING `blocked`. Not as a quietly-added column.
 *   3. NO MARKET-DERIVED COLUMN COMES ALONG FOR THE RIDE. `off_team_season` and
 *      `teamOffseasonSummary` both carry `implied_team_points` /
 *      `implied_points_delta`. Those are the one place the offseason model
 *      touched market data and they FAILED (0.995, CI 0.951-1.044). Feeding a
 *      market-derived team total back into a market model is circular on top of
 *      being useless, and the GBM already has the spread and the total as raw
 *      features. They are excluded here deliberately, not by oversight.
 *
 * The honest expected value of this whole exercise is zero — the project has no
 * demonstrated edge against closing lines (`PATH_TO_PROFIT`). It is written down
 * so that if someone tries it, they try it INSIDE the gate rather than around
 * it, and so the numbers exist the next time the idea comes up.
 *
 * NO LOOK-AHEAD, WHICH IS THE ONLY THING THAT MAKES THIS MEASURABLE
 *
 * Every column below is computable before Week 1 of season T:
 *
 *   - team assignment comes from `rosterAtSeasonStart(T)`, whose primary source
 *     is the Week 1 depth chart (2021+) or a dated roster snapshot (2026).
 *   - projected points come from `preseasonProjections(T)`, whose fit is trained
 *     on seasons strictly before T and whose board is preseason ADP/ECR.
 *   - churn and returning production are computed against season T-1 usage.
 *   - QB1 QBR delta is season T-1 QBR for both the incoming and outgoing
 *     starter — a backward-looking difference between two forward-looking
 *     identities.
 *
 * The residual leakage risk is real and is declared `high` in the contract:
 * `rosterAtSeasonStart` falls back to season-T usage for players with no depth
 * row at all. `teamStrengthCoverage()` reports the roster source per season so
 * that fallback is visible rather than assumed away.
 */
import { rows } from '../db/index.js';
import { rosterAtSeasonStart, seasonAggregate, teamOffseasonSummary } from './offseason-model.js';
import { preseasonProjections } from './preseason-model.js';
// One-way: nfl-gbm.js never imports this file (the challenger is injected into
// it as a plain object), so there is no import cycle to reason about.
import { buildGbmDataset, fitGbm, predictGbm } from './nfl-gbm.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { canonicalTeamCode } from './team-codes.js';
import { recordGateAudit } from './model-governance.js';

/** Seasons `off_team_season` and the depth-chart feed both cover. */
export const TEAM_STRENGTH_SEASONS = Object.freeze([2021, 2022, 2023, 2024, 2025, 2026]);

/**
 * The starters whose projections are summed into `proj_off_points`.
 *
 * Deliberately NOT read off the depth chart's own slot labels: that vocabulary
 * is not stable across seasons (2023 lists `WR`, 2025 lists `LWR`/`RWR`/`SWR`,
 * 2026 lists `WR`/`SWR`/`KR`), so a label-matching rule silently counts a
 * different number of players each year. Instead the roster fixes WHICH team a
 * player is on — the part the depth chart is reliable for — and the preseason
 * projection ranks who among them starts.
 */
const STARTERS = Object.freeze({ QB: 1, RB: 2, WR: 3, TE: 1 });

/** The feature columns exposed to the market models, market-derived ones excluded. */
export const TEAM_STRENGTH_KEYS = Object.freeze([
  'proj_off_points',
  'vacated_opportunity_share',
  'returning_points_share',
  'qb1_change',
  'qb1_qbr_delta',
  'qb1_proj_ppg_delta'
]);

const r2 = v => (Number.isFinite(v) ? +v.toFixed(2) : null);
const r3 = v => (Number.isFinite(v) ? +v.toFixed(3) : null);
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : null);
const cache = new Map();

/** Prior-season PPR points by (team, player), for the returning-production share. */
function priorPointsByTeam(season) {
  const prior = seasonAggregate(season - 1);
  const teamPoints = new Map();   // team -> total prior PPR points
  const playerPoints = new Map(); // gsis -> { team, points } on his prior team
  for (const pt of prior.byPlayerTeam.values()) {
    const p = prior.players.get(pt.player_id);
    if (!p || !p.games) continue;
    // Split a traded player's season points across his teams by opportunity, so
    // a team is credited only with what was produced while wearing its jersey.
    const share = p.opportunity > 0 ? pt.opportunity / p.opportunity : 0;
    const pts = p.points * share;
    teamPoints.set(pt.team, (teamPoints.get(pt.team) ?? 0) + pts);
    const key = `${pt.player_id}|${pt.team}`;
    playerPoints.set(key, { player_id: pt.player_id, team: pt.team, points: pts });
  }
  return { teamPoints, playerPoints };
}

/** QB1 season-long projected PPG for a season, keyed by gsis. */
function qbProjectedPpg(season) {
  const out = new Map();
  for (const [gsis, p] of preseasonProjections(season)) {
    if (p.position === 'QB' && Number.isFinite(p.ppg)) out.set(gsis, p.ppg);
  }
  return out;
}

/**
 * Team-level strength aggregates for one season.
 *
 * @returns {Map<string, object>} team code -> feature row. Every value may be
 *   null; a caller must handle that rather than treat a missing season as zero.
 */
export function teamStrength(season) {
  const key = `ts:${season}`;
  if (cache.has(key)) return cache.get(key);

  const roster = rosterAtSeasonStart(season);
  const summary = teamOffseasonSummary(season);
  const summaryTeams = Array.isArray(summary.teams) ? summary.teams : [...summary.teams.values()];
  const byTeam = new Map(summaryTeams.map(t => [t.team, t]));

  const projections = preseasonProjections(season);
  const { teamPoints, playerPoints } = priorPointsByTeam(season);
  const qbNow = qbProjectedPpg(season);
  const qbPrior = qbProjectedPpg(season - 1);

  // `off_team_season` files the Rams under `LA` while `game_lines`, the depth
  // charts and `teamOffseasonSummary` all use `LAR`. Left unmapped that silently
  // stranded the Rams' QB1 QBR delta on a team code no game row ever matches —
  // a null column rather than a loud failure, which is exactly the kind of join
  // bug a differenced feature hides. Canonicalise both sides.
  const ots = new Map(rows(
    `SELECT team, qb_change, qb_qbr_delta FROM off_team_season WHERE season = ?`, season)
    .map(r => [canonicalTeamCode(r.team), r]));

  // --- projected offensive points: sum the starters' season projections ------
  const projByTeam = new Map();
  for (const [gsis, p] of projections) {
    const r = roster.players.get(gsis);
    if (!r?.team || !Number.isFinite(p.points)) continue;
    if (!projByTeam.has(r.team)) projByTeam.set(r.team, []);
    projByTeam.get(r.team).push({ position: p.position, points: p.points });
  }
  const projPoints = new Map();
  for (const [team, list] of projByTeam) {
    const used = {};
    let total = 0, counted = 0;
    for (const x of list.sort((a, b) => b.points - a.points)) {
      const need = STARTERS[x.position] ?? 0;
      used[x.position] = (used[x.position] ?? 0) + 1;
      if (used[x.position] <= need) { total += x.points; counted++; }
    }
    // A team missing most of its starting skill group projected nothing usable;
    // report null rather than a number that means "we found two receivers".
    projPoints.set(team, counted >= 5 ? total : null);
  }

  // --- returning production share -------------------------------------------
  const returning = new Map();
  for (const [team, total] of teamPoints) {
    if (!(total > 0)) { returning.set(team, null); continue; }
    let kept = 0;
    for (const rec of playerPoints.values()) {
      if (rec.team !== team) continue;
      if (roster.players.get(rec.player_id)?.team === team) kept += rec.points;
    }
    returning.set(team, kept / total);
  }

  const out = new Map();
  const teams = new Set([...byTeam.keys(), ...ots.keys(), ...projPoints.keys()]);
  for (const team of teams) {
    const s = byTeam.get(team);
    const o = ots.get(team);
    const qb1 = s?.qb1 ?? null;
    const priorQb1 = s?.prior_qb1 ?? null;
    const projDelta = qb1 && priorQb1 && qbNow.has(qb1) && qbPrior.has(priorQb1)
      ? qbNow.get(qb1) - qbPrior.get(priorQb1) : null;

    out.set(team, {
      season, team,
      proj_off_points: r3(projPoints.get(team) ?? null),
      vacated_opportunity_share: r3(s?.vacated_opportunity_share ?? null),
      returning_points_share: r3(returning.get(team) ?? null),
      qb1_change: s?.qb1_change == null ? null : (s.qb1_change ? 1 : 0),
      qb1_qbr_delta: r3(o?.qb_qbr_delta ?? null),
      qb1_proj_ppg_delta: r3(projDelta)
    });
  }
  cache.set(key, out);
  return out;
}

/** Per-season fill rate for every column, plus the roster source that produced it. */
export function teamStrengthCoverage(seasons = TEAM_STRENGTH_SEASONS) {
  return seasons.map(season => {
    const table = teamStrength(season);
    const list = [...table.values()];
    const filled = {};
    for (const k of TEAM_STRENGTH_KEYS) {
      filled[k] = list.filter(r => r[k] != null).length;
    }
    return {
      season, teams: list.length,
      roster_source: rosterAtSeasonStart(season).source,
      filled,
      // preseasonProjections needs a fit trained on seasons strictly before the
      // target and the shipped fit starts at 2022, so 2021-2022 have no
      // projection-derived column at all. That is a coverage limit, not a bug.
      projection_backed: filled.proj_off_points > 0
    };
  });
}

/** League mean of each column for a season — the contract's "shrink to league prior". */
export function leaguePrior(season) {
  const list = [...teamStrength(season).values()];
  const prior = {};
  for (const k of TEAM_STRENGTH_KEYS) {
    const vals = list.map(r => r[k]).filter(Number.isFinite);
    prior[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return prior;
}

/**
 * The challenger hook handed to `buildGbmDataset({ extraFeatures })`.
 *
 * Injected rather than imported by `nfl-gbm.js` so the champion path keeps no
 * reference to this file at all: with `extraFeatures` unset, the dataset the
 * champion trains on is byte-for-byte what it was before.
 *
 * Values are home-minus-away differentials, matching the existing feature style.
 * A season outside `TEAM_STRENGTH_SEASONS` (the GBM trains from 2018) or a team
 * with a null column falls back to the league prior for that season, which
 * differences to zero — the contract's declared `shrink to league prior`
 * behaviour, and the reason a thin early season shrinks the feature toward "no
 * information" instead of dropping the game from the panel entirely.
 */
export function teamStrengthGbmFeatures() {
  const priors = new Map();
  const priorFor = season => {
    if (!priors.has(season)) {
      priors.set(season, TEAM_STRENGTH_SEASONS.includes(season)
        ? leaguePrior(season)
        : Object.fromEntries(TEAM_STRENGTH_KEYS.map(k => [k, 0])));
    }
    return priors.get(season);
  };
  const valueFor = (season, team, k) => {
    if (!TEAM_STRENGTH_SEASONS.includes(season)) return priorFor(season)[k];
    const v = teamStrength(season).get(team)?.[k];
    return Number.isFinite(v) ? v : priorFor(season)[k];
  };
  return {
    names: TEAM_STRENGTH_KEYS.map(k => `ts_${k}`),
    row: g => TEAM_STRENGTH_KEYS.map(k =>
      valueFor(g.season, g.home, k) - valueFor(g.season, g.away, k))
  };
}

export function clearTeamStrengthCache() { cache.clear(); }

/* ==================================================== the evaluation harness */

/**
 * Champion vs challenger, walk-forward, on the residual the market leaves.
 *
 * The bar is deliberately the one the repo already set for the GBM: not "does
 * it look plausible" but "does adding these columns REDUCE held-out absolute
 * error against the current champion, on a test season no fit has seen." Both
 * arms are the same model class with the same hyperparameters and the same
 * seed, trained on the same games; the ONLY difference is the six extra
 * columns. So the comparison isolates the features rather than the tuning.
 *
 * Significance is `pairedBootstrapDiff` over the same games in the same order,
 * BLOCK-resampled by week: two games in the same week share weather regimes,
 * bye structure and market conditions, and resampling them independently would
 * report an interval narrower than the truth (backtest-significance.js documents
 * exactly this failure mode). `significant` is true only when the 90% interval
 * excludes zero — in EITHER direction, so a challenger that only looked better
 * by luck is caught by the same rule that catches one that only looked worse.
 *
 * @param {'spread'|'total'} market  spread grades the margin residual (actual
 *   margin minus market-implied margin); total grades the total residual
 *   (actual combined points minus the closing total).
 */
export function teamStrengthWalkForward({
  market = 'spread', fromSeason = 2018, throughSeason = 2025,
  testSeasons = [2023, 2024, 2025], iterations = 2000, ...opts
} = {}) {
  const champion = buildGbmDataset({ fromSeason, throughSeason });
  const challenger = buildGbmDataset({ fromSeason, throughSeason,
    extraFeatures: teamStrengthGbmFeatures() });

  // The two builders walk the same games in the same order and the challenger
  // drops a game only if its extra row is malformed, so a length mismatch means
  // the panels are not comparable and no honest paired test can be run on them.
  if (champion.X.length !== challenger.X.length) {
    return { error: `panels diverged (${champion.X.length} vs ${challenger.X.length} games); ` +
      'a paired comparison requires identical games' };
  }
  if (champion.X.length < 500) {
    return { error: `only ${champion.X.length} usable games — feature coverage is too thin` };
  }

  const targetOf = m => (market === 'total'
    ? (Number.isFinite(m.actualTotal) && Number.isFinite(m.total) ? m.actualTotal - m.total : null)
    : (Number.isFinite(m.actualMargin) ? m.actualMargin - m.marketMargin : null));

  const perSeason = [];
  const pooledA = [], pooledB = [], pooledGroups = [];

  for (const season of testSeasons) {
    const usable = i => Number.isFinite(targetOf(champion.meta[i]));
    const trainIdx = champion.meta.map((m, i) => (m.season < season && usable(i) ? i : -1)).filter(i => i >= 0);
    const testIdx = champion.meta.map((m, i) => (m.season === season && usable(i) ? i : -1)).filter(i => i >= 0);
    if (trainIdx.length < 300 || !testIdx.length) continue;

    const yTrain = trainIdx.map(i => targetOf(champion.meta[i]));
    const modelA = fitGbm(trainIdx.map(i => champion.X[i]), yTrain, opts);
    const modelB = fitGbm(trainIdx.map(i => challenger.X[i]), yTrain, opts);
    if (modelA.error || modelB.error) continue;

    const errA = [], errB = [], groups = [];
    let zeroErr = 0;
    for (const i of testIdx) {
      const truth = targetOf(champion.meta[i]);
      errA.push(Math.abs(predictGbm(modelA, champion.X[i]) - truth));
      errB.push(Math.abs(predictGbm(modelB, challenger.X[i]) - truth));
      groups.push(`${season}|${champion.meta[i].week}`);
      zeroErr += Math.abs(truth);
    }
    const n = testIdx.length;
    const maeA = errA.reduce((a, b) => a + b, 0) / n;
    const maeB = errB.reduce((a, b) => a + b, 0) / n;
    const boot = pairedBootstrapDiff(errA, errB, { iterations, seed: season, groups });

    perSeason.push({
      season, games: n, train_games: trainIdx.length,
      market_mae: r2(zeroErr / n),
      champion_mae: r2(maeA), challenger_mae: r2(maeB),
      delta_mae: r4(maeB - maeA),
      challenger_better: maeB < maeA,
      // The bar. Lower error is better, so a challenger win needs the whole
      // interval below zero, not merely a point estimate that fell that way.
      significant_improvement: boot.significant === true && boot.ci90?.[1] < 0,
      bootstrap: boot
    });
    pooledA.push(...errA); pooledB.push(...errB); pooledGroups.push(...groups);
  }

  if (!perSeason.length) return { error: 'no test season had enough training history' };

  const wins = perSeason.filter(s => s.significant_improvement).length;
  const pooled = pairedBootstrapDiff(pooledA, pooledB, { iterations, seed: 7, groups: pooledGroups });
  const maeA = pooledA.reduce((a, b) => a + b, 0) / pooledA.length;
  const maeB = pooledB.reduce((a, b) => a + b, 0) / pooledB.length;

  // The promotion rule, stated before the numbers were seen: significant
  // improvement on at least two of the three walk-forward seasons. One season
  // is a coin flip dressed up as evidence.
  const passes = wins >= 2;

  return {
    market,
    champion: 'nfl-gbm residual champion (29 team-week differentials + 7 situational)',
    challenger: `champion + ${TEAM_STRENGTH_KEYS.length} team-strength differentials`,
    added_features: TEAM_STRENGTH_KEYS.map(k => `ts_${k}`),
    target: market === 'total'
      ? 'total residual (actual combined points minus the closing total)'
      : 'margin residual (actual margin minus market-implied margin)',
    total_games: champion.X.length,
    hyperparameters: { trees: opts.trees ?? 60, learning_rate: opts.learningRate ?? 0.05,
      max_depth: opts.maxDepth ?? 3, min_leaf: opts.minLeaf ?? 40 },
    per_season: perSeason,
    pooled: {
      champion_mae: r2(maeA), challenger_mae: r2(maeB),
      delta_mae: r4(maeB - maeA), bootstrap: pooled
    },
    seasons_with_significant_improvement: wins,
    promotion_rule: 'significant reduction in held-out MAE on >= 2 of 3 walk-forward seasons',
    verdict: passes
      ? `The team-strength block reduces held-out ${market} error on ${wins} of ` +
        `${perSeason.length} seasons beyond bootstrap noise. That clears the stated bar and ` +
        'must now go through the ordinary gate audit before any registry change.'
      : `No improvement. ${wins} of ${perSeason.length} seasons show a significant reduction in ` +
        `held-out ${market} error; pooled MAE moves ${r4(maeB - maeA)} points with a 90% interval ` +
        `of [${pooled.ci90?.[0]}, ${pooled.ci90?.[1]}], which straddles zero. The contract stays ` +
        'blocked and the champion is untouched.'
  };
}

/**
 * Run the walk-forward for one market and file the result as a gate audit.
 *
 * The point of routing a NEGATIVE result through `recordGateAudit` is that the
 * gate is the only thing that can ever change a registry state, and it refuses:
 * `recordGateAudit` computes `verdict` itself from whether every gate passed,
 * and `promoteEligibleAudit` throws on anything that is not
 * `promotion_eligible`. So filing the failure here makes "we measured this and
 * it did not clear the bar" a durable, hashed record that a later session can
 * find — instead of the idea being re-proposed from scratch every offseason.
 *
 * Nothing in this function writes to `model_registry`. The champion is untouched
 * by construction, not by convention.
 */
export function recordTeamStrengthGate({ market = 'spread', ...opts } = {}) {
  const result = teamStrengthWalkForward({ market, ...opts });
  if (result.error) return { error: result.error };

  const gates = [
    {
      name: 'walk_forward_accuracy',
      description: 'Significant reduction in held-out MAE vs the champion on >= 2 of 3 walk-forward seasons.',
      passed: result.seasons_with_significant_improvement >= 2,
      observed: `${result.seasons_with_significant_improvement} of ${result.per_season.length} seasons`
    },
    {
      name: 'pooled_improvement',
      description: 'Pooled paired bootstrap over all test games excludes zero in the challenger\'s favour.',
      passed: result.pooled.bootstrap?.significant === true && result.pooled.bootstrap.ci90[1] < 0,
      observed: `delta ${result.pooled.delta_mae}, ci90 ${JSON.stringify(result.pooled.bootstrap?.ci90)}`
    },
    {
      name: 'beats_market_baseline',
      description: 'The challenger beats simply predicting zero residual — the closing line itself.',
      passed: result.per_season.every(s => s.challenger_mae < s.market_mae),
      observed: result.per_season
        .map(s => `${s.season}: ${s.challenger_mae} vs market ${s.market_mae}`).join('; ')
    },
    {
      name: 'forward_clv',
      description: 'Frozen forward decisions beat the defined forward benchmark.',
      // No forward evidence exists for these features and none is manufactured
      // retrospectively; per the operating manual's gate hierarchy this gate
      // cannot pass from a backtest, so it is filed failed rather than skipped.
      passed: false,
      observed: 'no frozen forward sample — an offseason feature has never been traded live'
    }
  ];

  return {
    result,
    audit: recordGateAudit({
      sport: 'NFL', market,
      modelVersion: `nfl-gbm-team-strength-v1-${market}`,
      gates,
      evidence: {
        per_season: result.per_season.map(s => ({
          season: s.season, games: s.games, market_mae: s.market_mae,
          champion_mae: s.champion_mae, challenger_mae: s.challenger_mae,
          delta_mae: s.delta_mae, ci90: s.bootstrap?.ci90,
          significant_improvement: s.significant_improvement
        })),
        pooled: result.pooled,
        added_features: result.added_features,
        coverage: teamStrengthCoverage(),
        contract: 'team_strength_aggregate',
        note: result.verdict
      }
    })
  };
}
