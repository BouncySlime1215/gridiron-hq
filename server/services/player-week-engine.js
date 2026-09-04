/**
 * Shared player-week state estimator.
 *
 * The structural head estimates football events (volume x efficiency). The
 * frozen Stage 1.3 ensemble updates that estimate from fantasy outcomes known
 * before the requested week. Fantasy scoring is a consumer of this state; the
 * props head will consume the same event parameters in Stage 2.2.
 */
import { rows } from '../db/index.js';
import {
  buildProjections, sampleAllocatedWeekEvents, sampleWeekEvents, sampleWeeks
} from './projections.js';
import { PPR, scoreLine } from './scoring.js';
import {
  WEEKLY_ROLE_RECENCY,
  weeklyEnsembleContext, weeklyEnsemblePrediction
} from './weekly-ensemble.js';
import { activeWeeklyWeightSet } from './weekly-weight-store.js';
import { roleChangepoints } from './role-changepoint.js';
import { opportunityContextMultiplier } from './nfl-player-context.js';
import {
  candidatePlayerHeads, PLAYER_HEAD_REGISTRY_VERSION
} from './player-head-registry.js';
import { playerSignalTrace } from './model-signal-quality.js';
import { playerWeekNewsSignal } from './nfl-news-signal.js';
import { priorFfOpportunity } from './ffopportunity.js';
import { nflEngineVersionFor } from './nfl-engine-registry.js';
import {
  percentiles, randBinomial, randNegBinomial, random, withRandomSeed
} from './stats-util.js';

export const PLAYER_WEEK_ENGINE_VERSION = 'player-week-v2.1.0-game-state-reconciliation';
const engineCache = new Map();
const distributionCache = new Map();
const qbShareCache = new Map();
let primaryQbCache = new WeakMap();
const MAX_ENGINE_CACHE = 32;
const MAX_DISTRIBUTION_CACHE = 1200;

function remember(cache, key, value, limit) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

export function clearPlayerWeekEngineCache() {
  engineCache.clear();
  distributionCache.clear();
  qbShareCache.clear();
  primaryQbCache = new WeakMap();
}

/** Resolve either the app's numeric player id or nflverse's GSIS id. */
export function playerWeekProjection(engine, playerId) {
  if (!engine || playerId == null) return null;
  const direct = engine.get(playerId) ?? engine.get(Number(playerId));
  if (direct) return direct;
  const id = String(playerId);
  for (const projection of engine.values()) {
    if (projection.gsis_id === id) return projection;
  }
  return null;
}

const descending = key => (a, b) => (b.params?.[key] ?? 0) - (a.params?.[key] ?? 0);

/**
 * Pregame-only market eligibility. This never looks at the target week's box
 * score. It approximates what a sportsbook could reasonably list and reports
 * uncertainty instead of letting backup cameos make the model look worse—or
 * filtering them after the result to make it look better.
 */
export function playerPropEligibility(engine, projection) {
  if (!projection?.team || !projection.params) return { eligible: false, reason: 'missing team or event state' };
  const teammates = [...engine.values()].filter(p => p.team === projection.team);
  const rawQbs = teammates.filter(p => p.position === 'QB').sort(descending('attempts'));
  const primary = projectedPrimaryQb(engine, projection.team, rawQbs);
  const qbs = primary
    ? [primary, ...rawQbs.filter(p => p.player_id !== primary.player_id)]
    : rawQbs;
  const qbRank = qbs.findIndex(p => p.player_id === projection.player_id) + 1;
  const qbGap = qbRank === 1 ? projection.params.attempts - (qbs[1]?.params.attempts ?? 0) : null;
  const clearQb1 = projection.position === 'QB' && qbRank === 1
    && projection.params.attempts >= 15;
  const touches = projection.params.carries + projection.params.targets;
  return {
    eligible: clearQb1 || projection.params.targets >= 2 || projection.params.carries >= 4,
    markets: {
      player_pass_yds: clearQb1,
      player_rush_yds: projection.params.carries >= 4,
      player_reception_yds: projection.params.targets >= 2,
      player_receptions: projection.params.targets >= 2,
      player_anytime_td: touches >= 4
    },
    qb_rank: qbRank || null,
    qb_attempt_gap: qbGap == null ? null : +qbGap.toFixed(2),
    state: clearQb1 ? 'cutoff_primary_qb'
      : projection.position === 'QB' ? 'uncertain_or_backup_qb'
        : touches >= 4 ? 'market_plausible_role' : 'thin_role'
  };
}

function priorScores(season, week, scoring) {
  const out = new Map();
  for (const row of rows(`SELECT * FROM player_week_usage
                          WHERE season = ? AND week < ? ORDER BY week`, season, week)) {
    const list = out.get(row.player_id) ?? [];
    list.push(Number(scoreLine(row, scoring)));
    out.set(row.player_id, list);
  }
  return out;
}

export function buildPlayerWeekEngine({ season, week, scoring = PPR, kOverride, useCache = true } = {}) {
  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 22) {
    throw new Error('player-week engine requires an integer season and week');
  }
  const weightChampion = activeWeeklyWeightSet({ season, week });
  const cacheKey = JSON.stringify({ season, week, scoring, kOverride: kOverride ?? 'active',
    version: PLAYER_WEEK_ENGINE_VERSION, weightFit: weightChampion.id });
  if (useCache && engineCache.has(cacheKey)) return engineCache.get(cacheKey);

  const structural = buildProjections({
    through: season, throughWeek: week - 1, scoring, kOverride,
    roleRecency: WEEKLY_ROLE_RECENCY
  });
  const history = priorScores(season, week, scoring);
  const roleChanges = roleChangepoints(season, week);
  const out = new Map();
  for (const [playerId, projection] of structural) {
    const priorWeeks = history.get(playerId) ?? [];
    const context = weeklyEnsembleContext({
      structural: projection.ppg,
      priorWeeks,
      position: projection.position
    });
    const weights = weightChampion.weights[projection.position];
    const ppg = context ? weeklyEnsemblePrediction(context, weightChampion.weights) : projection.ppg;
    const engine = {
      version: PLAYER_WEEK_ENGINE_VERSION,
      gridiron_engine_version: nflEngineVersionFor(season, week),
      season, week,
      cutoff: `${season}-W${Math.max(0, week - 1)}`,
      mode: context ? 'position_ensemble' : 'structural_only_no_current_season_history',
      heads: context,
      weights: context ? weights : null,
      weight_fit: weightChampion.id,
      weight_source: weightChampion.source,
      role_change: roleChanges.get(playerId) ?? null
    };
    const roleChange = roleChanges.get(playerId) ?? null;
    /*
     * Age and injury are surfaced as CONTEXT, not applied as an adjustment.
     *
     * Both validated out of sample against a naive baseline (injury: MAE
     * 3.285 -> 3.276, CI [-0.0139,-0.0044], better in 2000/2000 resamples;
     * age: 1.816 -> 1.736, CI [-0.149,-0.0091]) and both still made the
     * shipped pipeline worse when actually applied, measured by ablation:
     *
     *   raw factors        rush MAE 21.107 -> 21.149, bias -1.214 -> -2.248
     *   age re-centered    rush MAE 21.107 -> 21.162, bias -1.214 -> -1.348
     *
     * The naive baseline they beat does not regress at all; the structural
     * model does, and its shrinkage toward positional priors already encodes
     * most of the aging and availability decline. Applying the factor on top
     * double counts it — the same failure as the opponent-on-volume attempt,
     * and it is exactly the "just adding bias" outcome to avoid.
     *
     * The information is still worth showing a human ("Questionable, limited
     * in practice" is decision-relevant even when it should not move the
     * number), so it rides along as metadata with no effect on any forecast.
     *
     * Phase 4 revisited this on the hypothesis that the ablation above failed
     * because it assumed a Questionable tag means the nominal ~50% (Probable
     * ~75%) the label implies, rather than the real published base rates —
     * Harvard Sports Analysis Collective (2013), "Inaccuracies in the Injury
     * Report Across the NFL," corroborated by ESPN: 62% and 89%. That
     * hypothesis does not apply here: INJURY_FACTORS (nfl-player-context.js)
     * was never a play-probability assumption in the first place — it is a
     * directly measured ratio of opportunity WHEN PLAYING, conditioned on the
     * player having recorded usage that week (measureInjuryEffect filters to
     * opp > 0). validateInjuryAdjustment/measureInjuryEffect never read
     * PLAY_ODDS or any other play-probability constant, so recalibrating one
     * cannot move a factor that was never built from it — verified by
     * inspection, not by re-running, since there is no shared code path to
     * re-run.
     *
     * The real play-probability assumption lives in
     * `weeklyAvailability`/`availability` (contingency.js) and `PLAY_ODDS`
     * (football-context.js), which are separate, already-wired-in pathways
     * (trade-engine, season-sim, model routes) — not part of this engine's own
     * ppg. Both were recalibrated to the cited rates there; see the comment on
     * `weeklyAvailability` for the re-run ablation numbers.
     */
    engine.opportunity_context = { ...opportunityContextMultiplier({
      playerName: projection.name, gsisId: projection.gsis_id, season, week
    }), applied: false,
    why_not_applied: 'validated against a non-regressing baseline; degrades the shipped model because structural shrinkage already encodes it' };
    engine.news_context = playerWeekNewsSignal(projection.name, {
      season, week, team: projection.team
    });
    engine.external_benchmarks = {
      ffopportunity: priorFfOpportunity(projection.gsis_id, season, week)
    };
    out.set(playerId, {
      ...projection,
      ppg: +ppg.toFixed(2),
      structural_ppg: projection.ppg,
      ensemble_shift: +(ppg - projection.ppg).toFixed(4),
      candidate_head_version: PLAYER_HEAD_REGISTRY_VERSION,
      candidate_heads: candidatePlayerHeads({ structural: projection.ppg, priorWeeks,
        evidenceGames: projection.evidence_games, roleChange }),
      player_week_engine: engine,
      model_reasoning: explainPlayerWeek({ ...projection, ppg, structural_ppg: projection.ppg,
        ensemble_shift: ppg - projection.ppg, player_week_engine: engine })
    });
  }
  // The truth ledger is part of the shared engine so fantasy and betting inspect
  // the same evidence state. Context-specific consumers may enrich it with
  // opponent, market and weather data, but they cannot replace this foundation.
  for (const [playerId, projection] of out) {
    const eligibility = playerPropEligibility(out, projection);
    out.set(playerId, {
      ...projection,
      signal_quality: playerSignalTrace({ projection, eligibility,
        eventState: playerWeekEventExpectation(projection) })
    });
  }
  return useCache ? remember(engineCache, cacheKey, out, MAX_ENGINE_CACHE) : out;
}

function opportunityMultipliers(mult = 1) {
  return typeof mult === 'object'
    ? { pass: mult.pass ?? 1, rush: mult.rush ?? 1 }
    : { pass: mult, rush: mult };
}

/**
 * Deterministic event expectation shared by props and fantasy.
 *
 * This is the canonical boundary of the model: every downstream product sees
 * the same attempts, targets, carries and efficiency rates. Game script may
 * move pass and rush opportunity in opposite directions, but it cannot create
 * a second player model.
 */
export function playerWeekEventExpectation(projection, { mult = 1, scoring = PPR } = {}) {
  if (!projection?.params) return null;
  const p = projection.params;
  const m = opportunityMultipliers(mult);
  const attempts = Math.max(0, p.attempts * m.pass);
  const carries = Math.max(0, p.carries * m.rush);
  const targets = Math.max(0, p.targets * m.pass);
  return eventExpectationFromVolume(projection, { attempts, carries, targets }, scoring);
}

function eventExpectationFromVolume(projection, { attempts, carries, targets }, scoring = PPR) {
  const p = projection.params;
  const events = {
    passYd: attempts * p.ypa,
    passTd: attempts * p.pass_td_rate,
    int: attempts * p.int_rate,
    rushYd: carries * p.ypc,
    rushTd: carries * p.rush_td_rate,
    rec: targets * p.catch_rate,
    recYd: targets * p.ypt,
    recTd: targets * p.rec_td_rate
  };
  return {
    player_id: projection.player_id,
    name: projection.name,
    team: projection.team,
    position: projection.position,
    volume: { attempts, carries, targets },
    efficiency: {
      ypa: p.ypa, ypc: p.ypc, ypt: p.ypt, catch_rate: p.catch_rate,
      pass_td_rate: p.pass_td_rate, rush_td_rate: p.rush_td_rate,
      rec_td_rate: p.rec_td_rate, int_rate: p.int_rate
    },
    events,
    structural_fantasy_points: scoreLine({
      passing_yards: events.passYd, passing_tds: events.passTd, interceptions: events.int,
      rushing_yards: events.rushYd, rushing_tds: events.rushTd,
      receptions: events.rec, receiving_yards: events.recYd, receiving_tds: events.recTd
    }, scoring),
    engine_version: projection.player_week_engine?.version ?? PLAYER_WEEK_ENGINE_VERSION,
    cutoff: projection.player_week_engine?.cutoff ?? null
  };
}

function historicalPrimaryQbShare(season, week) {
  const key = `${season ?? 'all'}|${week ?? 'all'}`;
  if (qbShareCache.has(key)) return qbShareCache.get(key);
  const cutoff = Number.isInteger(season) && Number.isInteger(week)
    ? `AND (season < ? OR (season = ? AND week < ?))`
    : '';
  const args = cutoff ? [season, season, week] : [];
  const games = rows(`SELECT season,week,team,attempts FROM player_week_usage
                      WHERE position='QB' AND attempts > 0 ${cutoff}
                      ORDER BY season,week,team`, ...args);
  const grouped = new Map();
  for (const game of games) {
    const key = `${game.season}|${game.week}|${game.team}`;
    const state = grouped.get(key) ?? { total: 0, top: 0 };
    state.total += game.attempts;
    state.top = Math.max(state.top, game.attempts);
    grouped.set(key, state);
  }
  const shares = [...grouped.values()].filter(x => x.total >= 10).map(x => x.top / x.total);
  // A tiny early-season sample should not claim certainty. The prior is itself
  // measured from the complete pre-cutoff population available to the model.
  const prior = shares.length ? shares.reduce((sum, x) => sum + x, 0) / shares.length : 0.96;
  const recent = shares.slice(-256);
  const observed = recent.length ? recent.reduce((sum, x) => sum + x, 0) / recent.length : prior;
  const result = Math.max(0.88, Math.min(0.995,
    (observed * recent.length + prior * 64) / (recent.length + 64)));
  qbShareCache.set(key, result);
  return result;
}

function recentPrimaryQb(engine, team, qbs) {
  if (!qbs.length) return null;
  const reference = qbs[0]?.player_week_engine;
  const season = reference?.season;
  const week = reference?.week;
  if (!Number.isInteger(season) || !Number.isInteger(week)) return qbs[0];
  const candidates = new Set(qbs.map(p => p.player_id));
  const recent = rows(`SELECT player_id,week,attempts FROM player_week_usage
                       WHERE season=? AND week<? AND team=? AND position='QB' AND attempts>0
                       ORDER BY week DESC,attempts DESC`, season, week, team);
  const latestWeek = recent[0]?.week;
  const latest = recent.find(x => x.week === latestWeek && candidates.has(x.player_id));
  if (latest?.attempts >= 10) return qbs.find(p => p.player_id === latest.player_id) ?? qbs[0];
  return qbs[0];
}

function projectedPrimaryQb(engine, team, qbs = null) {
  let cache = primaryQbCache.get(engine);
  if (!cache) { cache = new Map(); primaryQbCache.set(engine, cache); }
  if (cache.has(team)) return cache.get(team);
  const candidates = qbs ?? [...engine.values()]
    .filter(p => p.team === team && p.position === 'QB').sort(descending('attempts'));
  const result = recentPrimaryQb(engine, team, candidates);
  cache.set(team, result);
  return result;
}

function activeDepthRoster(engine, team) {
  const reference = [...engine.values()].find(player => player.team === team)?.player_week_engine;
  const season = reference?.season, week = reference?.week;
  if (!Number.isInteger(season) || !Number.isInteger(week)) return null;
  const game = rows(`SELECT gameday FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`, season, week, team)[0];
  const candidates = rows(`SELECT week,gsis_id,player_name,pos_abb,captured FROM nfl_depth
    WHERE season=? AND week<=? AND team=? ORDER BY week DESC,captured DESC`, season, week, team)
    .filter(player => !game?.gameday || !player.captured || String(player.captured).slice(0, 10) <= game.gameday);
  let latestWeek = candidates[0]?.week ?? null;
  let latest = latestWeek == null ? [] : candidates.filter(player => player.week === latestWeek);
  // nflverse depth history is not available for every old season. In that
  // case, build a strictly pre-kickoff active roster from the last four team
  // games. This is safer than the app's current roster table, which otherwise
  // lets modern players leak backward into historical player projections.
  if (!latest.length) {
    const history = rows(`SELECT season,week,player_id,player_name,features FROM nfl_player_week_features
      WHERE team=? AND (season<? OR (season=? AND week<?)) AND season>=?
      ORDER BY season DESC,week DESC`, team, season, season, week, season - 1);
    const recentWeeks = [...new Set(history.map(player => `${player.season}|${player.week}`))].slice(0, 4);
    const active = history.filter(player => recentWeeks.includes(`${player.season}|${player.week}`)).filter(player => {
      try {
        const features = JSON.parse(player.features);
        return (features.pass_attempts ?? 0) + (features.carries ?? 0) + (features.targets ?? 0) > 0;
      } catch { return false; }
    });
    latestWeek = active[0]?.week ?? null;
    latest = active.map(player => ({ gsis_id: player.player_id, player_name: player.player_name }));
  }
  if (!latest.length) return null;
  const ids = new Set(latest.map(player => player.gsis_id).filter(Boolean));
  const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = new Set(latest.map(player => normalize(player.player_name)).filter(Boolean));
  return { season, week: latestWeek, ids, names, has: player => (player.gsis_id && ids.has(player.gsis_id))
    || names.has(normalize(player.name)) };
}

function teamProjectionSet(engine, team, mult = 1) {
  const raw = [...engine.values()].filter(p => p.team === team && p.params);
  const roster = activeDepthRoster(engine, team);
  const filtered = roster ? raw.filter(player => roster.has(player)) : raw;
  // A populated chart is authoritative only if identities actually join. A
  // broken provider join must remain visible rather than erasing the offense.
  const all = filtered.length >= 5 ? filtered : raw;
  if (!all.length) return null;
  const allQbs = all.filter(p => p.position === 'QB').sort(descending('attempts'));
  const recentQb = projectedPrimaryQb(engine, team, allQbs);
  // Resolve the cutoff-safe starter before pruning the roster. Per-start volume
  // alone keeps departed or backup QBs near 30 attempts and previously excluded
  // the actual current starter from the two-player candidate set.
  const qbs = recentQb
    ? [recentQb, ...allQbs.filter(p => p.player_id !== recentQb.player_id)].slice(0, 3)
    : allQbs.slice(0, 3);
  const receivers = all.filter(p => p.params.targets > 0).sort(descending('targets')).slice(0, 8);
  const rushers = all.filter(p => p.params.carries > 0).sort(descending('carries')).slice(0, 6);
  const participants = [...new Map([...qbs, ...receivers, ...rushers].map(p => [p.player_id, p])).values()];
  const base = all[0].volume ?? {};
  const m = opportunityMultipliers(mult);
  const passMean = Math.max(1, (base.team_pass_att ?? 33) * m.pass);
  const rushMean = Math.max(1, (base.team_rush_att ?? 26) * m.rush);
  const targetRate = Math.max(0.72, Math.min(0.98,
    receivers.reduce((sum, p) => sum + p.params.targets, 0) / Math.max(1, base.team_pass_att ?? 33)));
  const primaryQb = recentQb ?? qbs[0];
  const reference = primaryQb?.player_week_engine;
  const primaryQbShare = historicalPrimaryQbShare(reference?.season, reference?.week);
  return {
    all, qbs, receivers, rushers, participants, passMean, rushMean, targetRate,
    primaryQb, primaryQbShare
  };
}

function proportional(total, players, weightOf) {
  const weight = players.reduce((sum, p) => sum + Math.max(0, weightOf(p)), 0);
  return new Map(players.map(p => [p.player_id,
    weight > 0 ? total * Math.max(0, weightOf(p)) / weight : 0]));
}

function reconciledVolume(total, players, rawOf, strength) {
  const bottomTotal = players.reduce((sum, p) => sum + Math.max(0, rawOf(p)), 0);
  if (!players.length || bottomTotal <= 0) return new Map(players.map(p => [p.player_id, 0]));
  const ratio = total / bottomTotal;
  const adjustment = 1 + Math.max(0, Math.min(1, strength)) * (ratio - 1);
  return new Map(players.map(p => [p.player_id, Math.max(0, rawOf(p)) * adjustment]));
}

function qbExpectedAttempts(set, { conditionalPrimary = false } = {}) {
  const out = new Map(set.qbs.map(p => [p.player_id, 0]));
  if (!set.primaryQb) return out;
  const primaryShare = conditionalPrimary ? 1 : set.primaryQbShare;
  out.set(set.primaryQb.player_id, set.passMean * primaryShare);
  const backups = set.qbs.filter(p => p.player_id !== set.primaryQb.player_id);
  const residual = set.passMean * (1 - primaryShare);
  const allocation = proportional(residual, backups,
    p => Math.max(0.01, (p.expected_games ?? 1) * Math.max(1, p.params.attempts)));
  for (const p of backups) out.set(p.player_id, allocation.get(p.player_id) ?? 0);
  return out;
}

/**
 * Deterministic mean of the same constrained team opportunity process used by
 * production Monte Carlo. This is the point-estimate path for fast replay and
 * prevents the audit from grading a different standalone-volume model.
 */
export function teamWeekEventExpectations(engine, team, {
  mult = 1, scoring = PPR, reconciliationStrength = 0,
  conditionalPrimary = false
} = {}) {
  const set = teamProjectionSet(engine, team, mult);
  if (!set) return new Map();
  const attempts = qbExpectedAttempts(set, { conditionalPrimary });
  const eligibleRushers = conditionalPrimary
    ? set.rushers.filter(player => player.position !== 'QB' || player.player_id === set.primaryQb?.player_id)
    : set.rushers;
  const carries = reconciledVolume(set.rushMean, eligibleRushers,
    p => p.params.carries, reconciliationStrength);
  const targets = reconciledVolume(set.passMean * set.targetRate, set.receivers,
    p => p.params.targets, reconciliationStrength);
  return new Map(set.all.map(p => [p.player_id, eventExpectationFromVolume(p, {
    attempts: attempts.get(p.player_id) ?? 0,
    carries: carries.get(p.player_id) ?? 0,
    targets: targets.get(p.player_id) ?? 0
  }, scoring)]));
}

/** Joint event draws from the same distribution fantasy scoring consumes. */
export function samplePlayerWeekEvents(projection, { runs = 2000, mult = 1, seed = null } = {}) {
  if (!projection?.params) return [];
  const draw = () => Array.from({ length: runs }, () => sampleWeekEvents(projection.params, mult));
  return seed == null ? draw() : withRandomSeed(seed >>> 0, draw);
}

function allocateCount(total, players, weightOf) {
  const out = new Map(players.map(p => [p.player_id, 0]));
  let remaining = Math.max(0, Math.round(total));
  let weight = players.reduce((sum, p) => sum + Math.max(0, weightOf(p)), 0);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (i === players.length - 1) { out.set(p.player_id, remaining); break; }
    const own = Math.max(0, weightOf(p));
    const n = weight > 0 ? randBinomial(remaining, Math.min(1, own / weight)) : 0;
    out.set(p.player_id, n); remaining -= n; weight -= own;
  }
  return out;
}

/**
 * Joint team simulation: one pass/rush total is drawn, then constrained among
 * players. The sum of player attempts/carries can therefore never exceed the
 * offense's sampled opportunity. Targets are a subset of pass attempts.
 */
export function sampleTeamWeekEvents(engine, team, {
  runs = 2000, mult = 1, seed = null, reconciliationStrength = 0,
  conditionalPrimary = false
} = {}) {
  const set = teamProjectionSet(engine, team, mult);
  if (!set) return new Map();
  const { qbs, receivers, rushers, participants, passMean, rushMean, targetRate,
    primaryQb, primaryQbShare } = set;
  const samples = new Map(participants.map(p => [p.player_id, []]));

  const carryMeans = reconciledVolume(rushMean, rushers, p => p.params.carries, reconciliationStrength);
  const targetMeans = reconciledVolume(passMean * targetRate, receivers,
    p => p.params.targets, reconciliationStrength);
  const reconciledCarryMean = [...carryMeans.values()].reduce((sum, x) => sum + x, 0);
  const reconciledTargetRate = Math.max(0, Math.min(0.98,
    [...targetMeans.values()].reduce((sum, x) => sum + x, 0) / Math.max(1, passMean)));

  const draw = () => {
    for (let run = 0; run < runs; run++) {
      const teamAttempts = randNegBinomial(passMean, 12);
      const teamCarries = randNegBinomial(reconciledCarryMean, 12);
      const teamTargets = randBinomial(teamAttempts, reconciledTargetRate);
      // Quarterback participation is a game state, not independent noise on
      // every attempt. Select the active passer once; never fabricate a weekly
      // 65/35 split merely because two QBs have historical starts.
      let activeQb = primaryQb;
      if (!conditionalPrimary && qbs.length > 1 && random() > primaryQbShare) {
        const backups = qbs.filter(p => p.player_id !== primaryQb?.player_id);
        const backupWeights = backups.map(p => Math.max(0.01,
          (p.expected_games ?? 1) * Math.max(1, p.params.attempts)));
        const totalWeight = backupWeights.reduce((sum, x) => sum + x, 0);
        let drawWeight = random() * totalWeight;
        activeQb = backups.find((_, i) => (drawWeight -= backupWeights[i]) <= 0) ?? backups.at(-1);
      }
      const attempts = new Map(qbs.map(p => [p.player_id,
        p.player_id === activeQb?.player_id ? teamAttempts : 0]));
      const carries = allocateCount(teamCarries, rushers, p => carryMeans.get(p.player_id) ?? 0);
      const targets = allocateCount(teamTargets, receivers, p => targetMeans.get(p.player_id) ?? 0);
      for (const p of participants) {
        samples.get(p.player_id).push(sampleAllocatedWeekEvents(p.params, {
          attempts: attempts.get(p.player_id) ?? 0,
          carries: carries.get(p.player_id) ?? 0,
          targets: targets.get(p.player_id) ?? 0
        }));
      }
    }
  };
  if (seed == null) draw(); else withRandomSeed(seed >>> 0, draw);
  return samples;
}

/**
 * Deterministic explanation assembled from model fields, never generated text.
 * Every sentence carries the exact values and cutoff that support it.
 */
export function explainPlayerWeek(projection) {
  const engine = projection.player_week_engine;
  const heads = engine?.heads;
  if (!engine || !heads) return {
    source: 'deterministic_model_evidence',
    cutoff: engine?.cutoff ?? null,
    summary: `Structural projection: ${Number(projection.ppg ?? projection.structural_ppg ?? 0).toFixed(1)} fantasy points. No current-season games are available before this cutoff, so no weekly outcome update was applied.`,
    claims: [{ id: 'structural_ppg', value: projection.structural_ppg ?? projection.ppg, unit: 'fantasy_points' }],
    unsupported_claims_allowed: false
  };
  const shift = projection.ensemble_shift ?? projection.ppg - projection.structural_ppg;
  const direction = Math.abs(shift) < 0.05 ? 'left it effectively unchanged'
    : shift > 0 ? `raised it by ${shift.toFixed(1)}` : `lowered it by ${Math.abs(shift).toFixed(1)}`;
  const change = engine.role_change;
  const changeText = change
    ? ` A ${change.status.replaceAll('_', ' ')} is confirmed: opportunities moved from ${change.prior_opportunities.toFixed(1)} to ${change.recent_opportunities.toFixed(1)} and snap share moved ${change.snap_change_points > 0 ? '+' : ''}${change.snap_change_points.toFixed(1)} points.`
    : '';
  return {
    source: 'deterministic_model_evidence',
    cutoff: engine.cutoff,
    summary: `The structural model projects ${projection.structural_ppg.toFixed(1)} points. ` +
      `The frozen ${projection.position} ensemble ${direction} to ${projection.ppg.toFixed(1)}, using only games completed through ${engine.cutoff}. ` +
      `Season average is ${heads.season_to_date.toFixed(1)}, median ${heads.median.toFixed(1)}, and last game ${heads.last1.toFixed(1)}.` + changeText,
    claims: [
      { id: 'structural_ppg', value: projection.structural_ppg, unit: 'fantasy_points' },
      { id: 'ensemble_ppg', value: projection.ppg, unit: 'fantasy_points' },
      { id: 'season_to_date', value: heads.season_to_date, unit: 'fantasy_points' },
      { id: 'last3', value: heads.last3, unit: 'fantasy_points' },
      { id: 'last1', value: heads.last1, unit: 'fantasy_points' },
      { id: 'median', value: heads.median, unit: 'fantasy_points' }
    ],
    weights: Object.fromEntries(['structural', 'season_to_date', 'last3', 'last1', 'median']
      .map((name, index) => [name, engine.weights[index]])),
    role_change: change,
    unsupported_claims_allowed: false
  };
}

/** Distribution centered on the shared engine's ensemble point estimate. */
export function playerWeekDistribution(projection, {
  runs = 2000, scoring = PPR, mult = 1, activeProbability = 1, useCache = true
} = {}) {
  const cacheKey = JSON.stringify({
    version: PLAYER_WEEK_ENGINE_VERSION, player: projection.player_id,
    season: projection.player_week_engine?.season, week: projection.player_week_engine?.week,
    params: projection.params, shift: projection.ensemble_shift ?? 0,
    runs, scoring, mult, activeProbability
  });
  if (useCache && distributionCache.has(cacheKey)) return distributionCache.get(cacheKey);
  const shift = projection.ensemble_shift ?? 0;
  let seed = 2166136261;
  for (let i = 0; i < cacheKey.length; i++) seed = Math.imul(seed ^ cacheKey.charCodeAt(i), 16777619);
  const samples = withRandomSeed(seed >>> 0, () =>
    sampleWeeks(projection.params, runs, scoring, mult, activeProbability)
      .map(value => Math.max(0, value + shift)));
  const pct = percentiles(samples, [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]);
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const boom = ({ QB: 24, RB: 18, WR: 18, TE: 14 })[projection.position] ?? 18;
  const bust = ({ QB: 14, RB: 8, WR: 8, TE: 6 })[projection.position] ?? 8;
  const result = {
    ...pct,
    mean: +mean.toFixed(2),
    boom_rate: +(samples.filter(value => value >= boom).length / samples.length).toFixed(3),
    bust_rate: +(samples.filter(value => value <= bust).length / samples.length).toFixed(3)
  };
  return useCache ? remember(distributionCache, cacheKey, result, MAX_DISTRIBUTION_CACHE) : result;
}
