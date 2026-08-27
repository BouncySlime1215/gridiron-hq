/**
 * Volume x efficiency projection model.
 *
 * The central idea: separate *opportunity* from *conversion*, because they behave
 * completely differently. How many targets a receiver gets is a stable property of his
 * role — it persists week to week and year to year. What he does with them is mostly
 * noise around a talent level, and touchdown rate is the noisiest thing in the sport.
 *
 * So volume is forecast with light regression and efficiency with heavy regression,
 * and the two are recombined. Modelling them as one blended number — which is what a
 * scraped "projected points" column is — makes it impossible to express the single most
 * common real forecast: this player's role is safe and his scoring rate is a mirage.
 *
 * Volume itself is decomposed once more, into share x team volume:
 *
 *     targets = target_share  x  team pass attempts
 *     carries = carry_share   x  team rush attempts
 *
 * Share is the player's property and team volume is the game's, which is what lets the
 * Vegas game-script layer move a whole offense without touching anyone's role.
 *
 * Output is a distribution, not a number. Every projection can emit percentiles and
 * feed the simulator.
 */
import { rows } from '../db/index.js';
import { PPR, scoreSim } from './scoring.js';
import {
  shrink, mean, quantile, percentiles,
  randGamma, randNegBinomial, randBinomial, randPoisson, randn, randBeta, random
} from './stats-util.js';
import { activeKVector } from './shrinkage-fit.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const GAMES = 17;

/* ------------------------------------------------------------------ priors */

/**
 * Regression strengths, in effective games. These encode the whole thesis of the
 * model, so they are worth reading as a statement rather than as constants:
 * a role stabilises in a handful of games, efficiency takes most of a season,
 * and touchdown rate essentially never stabilises.
 */
const K = {
  share: 6,          // target/carry share — stable, trust it early
  team_volume: 10,   // team pass/rush rate — stable
  yards_per: 34,     // yards per opportunity — regress hard
  catch_rate: 26,
  td_rate: 70,       // the most regression-prone number in fantasy
  games: 8,          // availability
  /*
   * Interceptions are very close to random, and treating them otherwise was
   * an active defect rather than a missed opportunity: the anytime-INT
   * probability scored -6.2% Brier skill, i.e. measurably WORSE than ignoring
   * the player and quoting the league base rate.
   *
   * Measured directly: the correlation between a quarterback's prior INT rate
   * and his next game's INT rate is 0.023 over 1,552 starts (2022-2025).
   * That is indistinguishable from zero. The old value (td_rate/10 = 7,
   * against n = attempts/10) let a QB with ~700 prior attempts carry ~91%
   * weight on his own rate — nearly full trust in noise.
   *
   * 160 is swept, not chosen: K in {0.7, 2.5, 5, 10, 20, 40, 80, 160, 320, inf}
   * on 2022-2025, scoring Brier skill against each population's own
   * climatology. Skill rises monotonically from -6.2% at the old value to
   * +2.6% here, then falls again. Note it also beats pure league mean
   * (+2.4%), so a small amount of real quarterback signal does exist — just
   * an order of magnitude less than the model previously assumed.
   */
  int_rate: 160
};

// Recency weights. A role two years ago is weak evidence about this year's role.
const SEASON_WEIGHT = (s, through) => ({ 0: 1, 1: 0.55, 2: 0.28 })[through - s] ?? 0.12;

/**
 * Build Order 1.3 — how fast evidence goes stale, as fittable parameters.
 *
 * Two knobs, both previously implicit:
 *
 *   seasonDecay   geometric weight per season back. `null` keeps the original
 *                 hand-picked table {1, 0.55, 0.28, 0.12...}.
 *   weekHalfLife  decay WITHIN the cutoff season, in weeks. `null` is the
 *                 original behaviour: every week of the current season counts
 *                 equally, so a role change in week 9 is averaged against the
 *                 eight weeks that preceded it and barely moves the number.
 *
 * The season-total diagnostics showed the model's compression and its
 * under-prediction of good players BOTH worsen monotonically as history depth
 * grows (log-log slope 0.99 -> 1.05 -> 1.25 over the 2023/2024/2025 holdouts).
 * That is the signature of stale evidence: with three seasons on hand, a
 * player's current form gets averaged against two older, less relevant ones.
 * These knobs are what let that be measured instead of assumed.
 *
 * seasonDecay = 0.35 is fitted (swept on the 2023 + 2024 weekly replays,
 * validated on 2025): a steeper decay than the original table's ~0.55, i.e.
 * older seasons should count for less than they did. The validation gain is
 * small but real — weekly MAE 4.690 -> 4.675, paired-bootstrap 90% CI
 * [-0.0254, -0.0038] over 4,340 player-weeks.
 *
 * weekHalfLife stays OFF, which was the surprise: every within-season decay
 * tried made things WORSE (half-life 8 cost ~0.06 MAE, shorter cost more), and
 * a trailing 3-week average is likewise worse than the season-to-date average
 * (4.753 vs 4.509). Recent weeks are not more informative than the full season
 * so far — chasing hot streaks is a real, measurable mistake here.
 * See scripts/fit-weekly.mjs.
 */
export const RECENCY = { seasonDecay: 0.35, weekHalfLife: null };

/**
 * Weight for one usage row given the cutoff. Combines the season-level decay
 * with the within-season decay (the latter only applies to the cutoff season,
 * where "how many weeks ago" is meaningful).
 */
function seasonWeight(s, through, r) {
  const back = through - s;
  return r.seasonDecay == null
    ? (({ 0: 1, 1: 0.55, 2: 0.28 })[back] ?? 0.12)
    : Math.pow(r.seasonDecay, back);
}

function rowWeight(u, through, throughWeek, r) {
  const seasonW = seasonWeight(u.season, through, r);
  if (r.weekHalfLife == null || u.season !== through || throughWeek == null) return seasonW;
  const weeksAgo = Math.max(0, throughWeek - u.week);
  return seasonW * Math.pow(0.5, weeksAgo / r.weekHalfLife);
}

/**
 * Build Order 1.1 — every shrink() call below goes through this picker rather
 * than the hardcoded K object directly. When a fitted k-vector is active (see
 * shrinkage-fit.js), it replaces both the constant and, for raw-opportunity
 * efficiency metrics, the evidence unit itself: the old code converted counts
 * to "pseudo games" (targets/5, carries/8, attempts/10) purely so they could
 * be compared against one hand-picked K.yards_per/K.td_rate shared across
 * every position. A fitted k is already measured in raw units (targets,
 * carries, attempts, or recency-weighted games — whatever `rawN` is), so
 * there is no conversion left to do; `hardcodedN`/`hardcodedK` are only used
 * when no fit for that (metric, position) has ever beaten the baseline.
 */
function pickK(kOverride, metric, position, rawN, hardcodedN, hardcodedK) {
  const fitted = kOverride?.[metric]?.[position];
  return fitted != null ? { n: rawN, k: fitted } : { n: hardcodedN, k: hardcodedK };
}

/** shrink() toward a pure prior when a fit found no detectable between-player variance (k = Infinity). */
const shrinkSafe = (observed, prior, n, k) => (k === Infinity ? prior : shrink(observed, prior, n, k));

/**
 * Build Order 1.2 — the level-uncertainty parameters seasonDistribution draws with.
 *
 * `sigma = clamp(a + b/sqrt(evidence), lo, hi)` is the spread of a player's *true*
 * level around the projection; `downMult` widens only the downside (see the two-piece
 * draw); `conc` is the beta-binomial concentration on games played.
 *
 * These are fitted, not chosen — see scripts/fit-level-uncertainty.mjs. The original
 * `a=0, b=1.15, lo=0.30, hi=0.70` produced 80% intervals that covered 0.63-0.70 of
 * outcomes, because it treated level uncertainty as pure *estimation* error that
 * vanishes with evidence (b/sqrt(n) decays fast). Measured across three held-out
 * seasons, the residual spread of log(actual/predicted) is ~0.89 and essentially
 * FLAT in evidence — the variance is mostly genuine year-over-year change in the
 * player (role, team, scheme, health), which more history does not shrink away.
 * Hence a large floor `a` and a small evidence term.
 */
export const LEVEL_UNCERTAINTY = { a: 0, b: 1.15, lo: 0.30, hi: 0.70, downMult: 1, conc: 3.5 };

/* --------------------------------------------------------------- histories */

/**
 * Every weekly usage line up to and including the cutoff, so backtests can't peek ahead.
 *
 * `throughWeek` makes the cutoff mid-season: everything from earlier seasons, plus
 * weeks 1..throughWeek of the cutoff season. That is what the model actually has in
 * production on a Wednesday — the season so far and nothing after it — and it is what
 * a week-by-week walk-forward replay has to be able to ask for. Omit it for a
 * season-boundary cutoff (draft-time projections).
 */
function history(through, throughWeek = null) {
  if (throughWeek == null) {
    return rows(`SELECT u.*, p.name, p.position AS pos, p.espn_id, p.sleeper_id, p.gsis_id
                 FROM player_week_usage u JOIN players p ON p.id = u.player_id
                 WHERE u.season <= ? AND p.position IN ('QB','RB','WR','TE')`, through);
  }
  return rows(`SELECT u.*, p.name, p.position AS pos, p.espn_id, p.sleeper_id, p.gsis_id
               FROM player_week_usage u JOIN players p ON p.id = u.player_id
               WHERE (u.season < ? OR (u.season = ? AND u.week <= ?))
                 AND p.position IN ('QB','RB','WR','TE')`, through, through, throughWeek);
}

/**
 * Distinct weeks each team has actually played, per season, straight from the log.
 *
 * Availability is "share of his team's games he played", and that denominator is 17
 * only for a completed season. Mid-season it is however many games the team has
 * played so far — using 17 there would read a player who has started all eight games
 * to date as 47% available, which would halve every in-season projection.
 */
function teamGamesPlayed(log) {
  const weeks = new Map();
  for (const u of log) {
    if (!u.team) continue;
    const k = `${u.team}|${u.season}`;
    (weeks.get(k) ?? weeks.set(k, new Set()).get(k)).add(u.week);
  }
  const out = new Map();
  for (const [k, set] of weeks) out.set(k, set.size);
  return out;
}

/**
 * Team pass and rush volume per game. Derived by summing player lines rather than read
 * from a team table, which keeps it consistent with the shares computed off the same rows.
 */
function teamVolume(log, through, kOverride, throughWeek = null, recency = RECENCY) {
  const byTeamWeek = new Map();
  for (const u of log) {
    const k = `${u.team}|${u.season}|${u.week}`;
    const t = byTeamWeek.get(k) ?? { season: u.season, team: u.team, week: u.week, att: 0, car: 0 };
    t.att += u.attempts ?? 0;
    t.car += u.carries ?? 0;
    byTeamWeek.set(k, t);
  }
  const agg = new Map();
  for (const t of byTeamWeek.values()) {
    if (!t.team) continue;
    const w = rowWeight(t, through, throughWeek, recency);
    const a = agg.get(t.team) ?? { w: 0, att: 0, car: 0 };
    a.w += w; a.att += w * t.att; a.car += w * t.car;
    agg.set(t.team, a);
  }
  const passLg = mean([...agg.values()].filter(a => a.w).map(a => a.att / a.w)) || 33;
  const rushLg = mean([...agg.values()].filter(a => a.w).map(a => a.car / a.w)) || 26;

  const out = new Map();
  for (const [team, a] of agg) {
    if (!a.w) continue;
    const passK = pickK(kOverride, 'team_pass_att', 'ALL', a.w, a.w, K.team_volume);
    const rushK = pickK(kOverride, 'team_rush_att', 'ALL', a.w, a.w, K.team_volume);
    out.set(team, {
      pass_att: +shrinkSafe(a.att / a.w, passLg, passK.n, passK.k).toFixed(2),
      rush_att: +shrinkSafe(a.car / a.w, rushLg, rushK.n, rushK.k).toFixed(2)
    });
  }
  return { teams: out, league: { pass_att: +passLg.toFixed(2), rush_att: +rushLg.toFixed(2) } };
}

/**
 * Positional priors — what an unknown player at this position looks like.
 *
 * These are OPPORTUNITY-WEIGHTED rates (total events / total opportunities),
 * not the average of per-game rates. The distinction is not cosmetic; the old
 * form was measurably biased.
 *
 * Averaging per-game ratios gives a five-attempt game exactly as much say as
 * a forty-five-attempt game. Rates are bounded below by zero and unbounded
 * above, so the noisy low-volume games are asymmetric — one interception on
 * five attempts reads as a 0.200 rate and drags the mean up, while the best
 * possible low-volume game only reaches 0.000. Every rate prior inherited
 * that upward pull.
 *
 * Measured effect on interceptions, where it mattered most because the rate
 * compounds over ~33 attempts into a probability: the prior sat at 0.0250
 * against a true opportunity-weighted league rate of 0.0219, about 14% high.
 * Since int_rate is shrunk ~85% toward this prior, essentially every
 * quarterback inherited the inflation, and anytime-interception probability
 * came out near 0.55 against an actual base rate of 0.489 — scoring WORSE
 * than simply quoting the base rate (-1.6% Brier skill).
 *
 * Weighting by opportunity is also just the correct estimator for a rate:
 * it is the maximum-likelihood pooled rate, and it is what "league average
 * yards per attempt" means when anyone says it out loud.
 */
function positionalPriors(log) {
  const byPos = {};
  for (const u of log) {
    const p = (byPos[u.pos] ??= {
      tgtShare: [], carShare: [],
      recYds: 0, receptions: 0, recTds: 0, targets: 0,
      rushYds: 0, rushTds: 0, carries: 0,
      passYds: 0, passTds: 0, ints: 0, attempts: 0
    });
    if (u.target_share != null && u.target_share > 0) p.tgtShare.push(u.target_share);
    if (u.targets > 0) {
      p.recYds += u.receiving_yards ?? 0;
      p.receptions += u.receptions ?? 0;
      p.recTds += u.receiving_tds ?? 0;
      p.targets += u.targets;
    }
    if (u.carries > 0) {
      p.rushYds += u.rushing_yards ?? 0;
      p.rushTds += u.rushing_tds ?? 0;
      p.carries += u.carries;
    }
    if (u.attempts > 0) {
      p.passYds += u.passing_yards ?? 0;
      p.passTds += u.passing_tds ?? 0;
      p.ints += u.interceptions ?? 0;
      p.attempts += u.attempts;
    }
  }
  const rate = (num, den) => (den > 0 ? num / den : null);
  const out = {};
  for (const [pos, p] of Object.entries(byPos)) {
    out[pos] = {
      ypt: rate(p.recYds, p.targets) || 7.5,
      ypc: rate(p.rushYds, p.carries) || 4.3,
      ypa: rate(p.passYds, p.attempts) || 7.0,
      catch_rate: rate(p.receptions, p.targets) || 0.63,
      rec_td_rate: rate(p.recTds, p.targets) || 0.05,
      rush_td_rate: rate(p.rushTds, p.carries) || 0.025,
      pass_td_rate: rate(p.passTds, p.attempts) || 0.045,
      int_rate: rate(p.ints, p.attempts) || 0.024
    };
  }
  return out;
}

/* ------------------------------------------------------------- the model */

/**
 * Build a projection for every player with usage history.
 *
 * @param through   last season allowed as evidence (exclusive of the season being predicted)
 * @param scoring   league scoring rules
 * @param kOverride fitted shrinkage vector {metric: {position: k}} to use instead of
 *   the hardcoded K constants below. Omit to use whichever fit (if any) has been
 *   proven to beat hardcoded and marked active (see shrinkage-fit.js); pass `null`
 *   explicitly to force the hardcoded constants regardless of an active fit — that
 *   is how the backtest compares the two on identical inputs.
 * @returns Map<player_id, projection>
 */
export function buildProjections({
  through = SEASON - 1, throughWeek = null, scoring = PPR, kOverride, recency,
  roleRecency
} = {}) {
  const k = kOverride === undefined ? activeKVector() : kOverride;
  const r = { ...RECENCY, ...recency };
  // Opportunity and efficiency are different processes. `roleRecency` lets an
  // experiment shorten only the memory of volume while efficiency keeps the
  // already-validated global history. Omitted means identical legacy behavior.
  const rr = { ...r, ...roleRecency };
  const log = history(through, throughWeek);
  if (!log.length) return new Map();
  const { teams: teamVol, league: leagueVol } = teamVolume(log, through, k, throughWeek, rr);
  const priors = positionalPriors(log);
  const teamGames = teamGamesPlayed(log);

  // Accumulate weighted per-player usage.
  const acc = new Map();
  for (const u of log) {
    const w = rowWeight(u, through, throughWeek, r);
    const roleW = rowWeight(u, through, throughWeek, rr);
    if (w <= 0) continue;
    const a = acc.get(u.player_id) ?? {
      id: u.player_id, name: u.name, pos: u.pos, espn_id: u.espn_id, sleeper_id: u.sleeper_id,
      gsis_id: u.gsis_id,
      team: null, lastSeason: -1, w: 0, games: 0, seasons: new Set(), gamesBySeason: new Map(), attemptsBySeason: new Map(),
      roleW: 0, tgtShareW: 0, tgtShare: 0, roleCarries: 0, roleAttempts: 0,
      targets: 0, receptions: 0, recYds: 0, recTd: 0,
      carries: 0, rushYds: 0, rushTd: 0,
      attempts: 0, passYds: 0, passTd: 0, ints: 0,
      weekly: []
    };
    // Most recent team wins — players move.
    if (u.season > a.lastSeason || (u.season === a.lastSeason && u.team)) {
      if (u.team) { a.team = u.team; a.lastSeason = u.season; }
    }
    a.w += w; a.games += 1; a.seasons.add(u.season);
    a.gamesBySeason.set(u.season, (a.gamesBySeason.get(u.season) ?? 0) + 1);
    a.attemptsBySeason.set(u.season, (a.attemptsBySeason.get(u.season) ?? 0) + (u.attempts ?? 0));
    a.roleW += roleW;
    if (u.target_share != null) { a.tgtShareW += roleW; a.tgtShare += roleW * u.target_share; }
    a.roleCarries += roleW * (u.carries ?? 0);
    a.roleAttempts += roleW * (u.attempts ?? 0);
    a.targets += w * (u.targets ?? 0);
    a.receptions += w * (u.receptions ?? 0);
    a.recYds += w * (u.receiving_yards ?? 0);
    a.recTd += w * (u.receiving_tds ?? 0);
    a.carries += w * (u.carries ?? 0);
    a.rushYds += w * (u.rushing_yards ?? 0);
    a.rushTd += w * (u.rushing_tds ?? 0);
    a.attempts += w * (u.attempts ?? 0);
    a.passYds += w * (u.passing_yards ?? 0);
    a.passTd += w * (u.passing_tds ?? 0);
    a.ints += w * (u.interceptions ?? 0);
    // Raw weekly opportunity counts, for estimating how variable the role is.
    a.weekly.push({ season: u.season, targets: u.targets ?? 0, carries: u.carries ?? 0, attempts: u.attempts ?? 0 });
    acc.set(u.player_id, a);
  }

  const out = new Map();
  for (const a of acc.values()) {
    const prior = priors[a.pos] ?? priors.WR ?? {};
    const tv = teamVol.get(a.team) ?? leagueVol;
    const n = a.w;                       // effective games of evidence
    const perGame = x => (n ? x / n : 0);
    const rolePerGame = x => (a.roleW ? x / a.roleW : 0);

    /* ---- volume: share x team volume ---- */
    const carryShareGroup = a.pos === 'RB' ? 'RB' : 'OTHER';
    const tgtShareObs = a.tgtShareW ? a.tgtShare / a.tgtShareW : 0;
    const tgtShareK = pickK(k, 'target_share', 'ALL', a.tgtShareW, a.tgtShareW, K.share);
    const targetSharePrior = 0.06;
    const tgtShare = shrinkSafe(tgtShareObs, targetSharePrior, tgtShareK.n, tgtShareK.k);
    const carShareObs = tv.rush_att ? rolePerGame(a.roleCarries) / tv.rush_att : 0;
    const carShareK = pickK(k, 'carry_share', carryShareGroup, a.roleW, a.roleW, K.share);
    const carrySharePrior = a.pos === 'RB' ? 0.25 : 0.02;
    const carShare = shrinkSafe(carShareObs, carrySharePrior, carShareK.n, carShareK.k);

    const targets = a.pos === 'QB' ? 0 : Math.max(0, tgtShare * tv.pass_att);
    const carries = Math.max(0, carShare * tv.rush_att);
    // Quarterback attempts are the team's, so they don't decompose into a share.
    const qbAttK = pickK(k, 'qb_attempts', 'QB', a.roleW, a.roleW, K.share);
    const attempts = a.pos === 'QB'
      ? shrinkSafe(rolePerGame(a.roleAttempts), tv.pass_att * 0.92, qbAttK.n, qbAttK.k) : 0;

    /* ---- efficiency: heavy regression toward the positional norm ---- */
    const yptK = pickK(k, 'ypt', a.pos, a.targets, a.targets / 5, K.yards_per / 5);
    const ypt = shrinkSafe(a.targets > 0 ? a.recYds / a.targets : prior.ypt, prior.ypt, yptK.n, yptK.k);
    const catchRateK = pickK(k, 'catch_rate', a.pos, a.targets, a.targets / 5, K.catch_rate / 5);
    const catchRate = shrinkSafe(a.targets > 0 ? a.receptions / a.targets : prior.catch_rate,
      prior.catch_rate, catchRateK.n, catchRateK.k);
    const recTdK = pickK(k, 'rec_td_rate', a.pos, a.targets, a.targets / 5, K.td_rate / 5);
    const recTdRate = shrinkSafe(a.targets > 0 ? a.recTd / a.targets : prior.rec_td_rate,
      prior.rec_td_rate, recTdK.n, recTdK.k);
    const ypcK = pickK(k, 'ypc', a.pos, a.carries, a.carries / 8, K.yards_per / 8);
    const ypc = shrinkSafe(a.carries > 0 ? a.rushYds / a.carries : prior.ypc, prior.ypc, ypcK.n, ypcK.k);
    const rushTdK = pickK(k, 'rush_td_rate', a.pos, a.carries, a.carries / 8, K.td_rate / 8);
    const rushTdRate = shrinkSafe(a.carries > 0 ? a.rushTd / a.carries : prior.rush_td_rate,
      prior.rush_td_rate, rushTdK.n, rushTdK.k);
    const ypaK = pickK(k, 'ypa', a.pos, a.attempts, a.attempts / 10, K.yards_per / 10);
    const ypa = shrinkSafe(a.attempts > 0 ? a.passYds / a.attempts : prior.ypa, prior.ypa, ypaK.n, ypaK.k);
    const passTdK = pickK(k, 'pass_td_rate', a.pos, a.attempts, a.attempts / 10, K.td_rate / 10);
    const passTdRate = shrinkSafe(a.attempts > 0 ? a.passTd / a.attempts : prior.pass_td_rate,
      prior.pass_td_rate, passTdK.n, passTdK.k);
    const intRateK = pickK(k, 'int_rate', a.pos, a.attempts, a.attempts / 10, K.int_rate);
    const intRate = shrinkSafe(a.attempts > 0 ? a.ints / a.attempts : prior.int_rate,
      prior.int_rate, intRateK.n, intRateK.k);

    /* ---- how variable is the role, week to week ---- */
    const recent = a.weekly.filter(x => x.season === through);
    const opp = recent.map(x => (a.pos === 'QB' ? x.attempts : x.targets + x.carries));
    const oppMean = mean(opp) || (targets + carries + attempts) || 1;
    const oppVar = opp.length > 1 ? mean(opp.map(x => (x - oppMean) ** 2)) : oppMean * 1.6;
    // Negative binomial dispersion implied by the observed over-dispersion. Clamped:
    // a tiny sample can imply an absurd shape in either direction.
    const dispersion = Math.min(30, Math.max(1.2, oppVar > oppMean ? (oppMean ** 2) / (oppVar - oppMean) : 12));

    /* ---- expected availability ----
     *
     * This is a *role* forecast, not an injury forecast, and it is the single biggest
     * source of error when it is missing. A backup quarterback's per-game numbers look
     * like a starter's, because the only games in his record are the ones he started.
     * Projecting those rates across a full season turns a clipboard-holder into a QB12.
     *
     * So availability is modelled as the share of his team's games he actually played,
     * across every season since he entered the league — not as an average of the games
     * he happened to appear in. */
    const firstSeason = Math.min(...a.seasons);
    let availW = 0, availPlayed = 0;
    for (let s = firstSeason; s <= through; s++) {
      const w = seasonWeight(s, through, r);
      // Denominator is his team's games actually played that season — 17 for a
      // completed season, but only the games so far when the cutoff is mid-season.
      const teamG = teamGames.get(`${a.team}|${s}`) ?? (s === through && throughWeek != null ? throughWeek : GAMES);
      availW += w * Math.max(1, teamG);
      availPlayed += w * (a.gamesBySeason.get(s) ?? 0);
    }
    const playRate = availW ? availPlayed / availW : 0;
    // Prior and evidence weight chosen by sweeping both against two held-out seasons
    // (2024 and 2025) rather than by intuition — see the backtest harness. The surface
    // is flat, so these are a reasonable point on a plateau, not a tuned optimum.
    const availK = pickK(k, 'availability', 'ALL', availW / GAMES, availW / GAMES, 0.8);
    let rate = shrinkSafe(playRate, 0.66, availK.n, availK.k);

    // Quarterback is winner-take-all: there is one football, and the man holding it
    // plays every snap. So a passer's share of his team's attempts *is* his share of
    // starts, and it separates a starter from a backup far more sharply than games
    // played does — a backup who started three games looks nearly full-time on games
    // alone, and looks like a backup on attempt share.
    if (a.pos === 'QB') {
      const perGameAtt = (teamVol.get(a.team) ?? leagueVol).pass_att;
      let shareW = 0, shareSum = 0;
      for (const s of a.seasons) {
        const w = seasonWeight(s, through, r);
        const own = a.attemptsBySeason.get(s) ?? 0;
        // Same partial-season correction as availability: his share of the team's
        // attempts has to divide by the attempts the team has actually thrown.
        const teamG = teamGames.get(`${a.team}|${s}`) ?? (s === through && throughWeek != null ? throughWeek : GAMES);
        const teamAtt = perGameAtt * Math.max(1, teamG);
        if (teamAtt > 0) { shareW += w; shareSum += w * Math.min(1, own / teamAtt); }
      }
      const attShare = shareW ? shareSum / shareW : 0;
      const attShareK = pickK(k, 'qb_attempt_share', 'QB', shareW, shareW, 0.5);
      rate = Math.min(rate, shrinkSafe(attShare, 0.45, attShareK.n, attShareK.k));
    }
    const expectedGames = Math.min(GAMES, Math.max(1, rate * GAMES));

    const params = {
      position: a.pos, targets, carries, attempts, dispersion,
      ypt, catch_rate: catchRate, rec_td_rate: recTdRate,
      ypc, rush_td_rate: rushTdRate,
      ypa, pass_td_rate: passTdRate, int_rate: intRate
    };

    // Deterministic expectation, used for ranking and as the point estimate.
    const meanPpg = scoreSim({
      passYd: attempts * ypa, passTd: attempts * passTdRate, int: attempts * intRate,
      rushYd: carries * ypc, rushTd: carries * rushTdRate,
      rec: targets * catchRate, recYd: targets * ypt, recTd: targets * recTdRate
    }, scoring);

    out.set(a.id, {
      player_id: a.id, name: a.name, position: a.pos, team: a.team,
      espn_id: a.espn_id, sleeper_id: a.sleeper_id, gsis_id: a.gsis_id,
      evidence_games: a.games, evidence_weight: +n.toFixed(1), seasons: [...a.seasons].sort(),
      role_prior: { mode: 'flat_structural_head', target_share: 0.06,
        carry_share: a.pos === 'RB' ? 0.25 : 0.02 },
      expected_games: +expectedGames.toFixed(1),
      volume: {
        target_share: +tgtShare.toFixed(4), targets_per_game: +targets.toFixed(2),
        carry_share: +carShare.toFixed(4), carries_per_game: +carries.toFixed(2),
        attempts_per_game: +attempts.toFixed(2),
        team_pass_att: tv.pass_att, team_rush_att: tv.rush_att
      },
      efficiency: {
        yards_per_target: +ypt.toFixed(2), catch_rate: +catchRate.toFixed(3),
        rec_td_rate: +recTdRate.toFixed(4), yards_per_carry: +ypc.toFixed(2),
        rush_td_rate: +rushTdRate.toFixed(4), yards_per_attempt: +ypa.toFixed(2),
        pass_td_rate: +passTdRate.toFixed(4)
      },
      params,
      ppg: +meanPpg.toFixed(2),
      points: +(meanPpg * expectedGames).toFixed(1)
    });
  }
  return out;
}

/* --------------------------------------------------------------- sampling */

/**
 * One simulated week for a player.
 *
 * Built up from its parts rather than drawn from a bell curve: touches are an
 * over-dispersed count, yards per touch is a positive skewed rate, and touchdowns are
 * rare binomial events. Composing them reproduces the real right skew of fantasy
 * scoring — which a Gaussian cannot, and which is exactly where start/sit and
 * playoff decisions live.
 *
 * @param mult optional matchup multiplier applied to opportunity
 */
export function sampleWeekEvents(params, mult = 1) {
  const p = params;
  // A scalar applies to everything (a pure matchup adjustment); an object lets the
  // game-script layer move passing and rushing volume in opposite directions, which is
  // the entire point of it — a favourite runs more *and* throws less.
  const mPass = typeof mult === 'object' ? (mult.pass ?? 1) : mult;
  const mRush = typeof mult === 'object' ? (mult.rush ?? 1) : mult;
  let attempts = 0, carries = 0, targets = 0;

  if (p.attempts > 0) {
    attempts = randNegBinomial(p.attempts * mPass, p.dispersion);
  }
  if (p.carries > 0) {
    carries = randNegBinomial(p.carries * mRush, p.dispersion);
  }
  if (p.targets > 0) {
    targets = randNegBinomial(p.targets * mPass, p.dispersion);
  }
  return sampleAllocatedWeekEvents(p, { attempts, carries, targets });
}

/**
 * Event draw conditional on opportunity counts allocated by a team simulation.
 * Keeping efficiency sampling here means standalone and joint simulations use
 * identical yardage and touchdown mechanics.
 */
export function sampleAllocatedWeekEvents(p, { attempts = 0, carries = 0, targets = 0 } = {}) {
  const passYd = attempts > 0 ? randGamma(attempts * 0.9, p.ypa / 0.9) : 0;
  const passTd = randBinomial(attempts, Math.min(0.35, p.pass_td_rate));
  const int = randBinomial(attempts, Math.min(0.2, p.int_rate));
  const rushYd = carries > 0 ? randGamma(carries * 0.75, p.ypc / 0.75) : 0;
  const rushTd = randBinomial(carries, Math.min(0.3, p.rush_td_rate));
  const rec = randBinomial(targets, Math.min(0.95, p.catch_rate));
  const recYd = rec > 0 ? randGamma(rec * 0.8, (p.ypt / Math.max(0.05, p.catch_rate)) / 0.8) : 0;
  const recTd = randBinomial(targets, Math.min(0.35, p.rec_td_rate));
  return { attempts, carries, targets, passYd, passTd, int, rushYd, rushTd, rec, recYd, recTd };
}

/** One simulated week scored for fantasy from the shared football-event draw. */
export function sampleWeek(params, scoring = PPR, mult = 1) {
  return scoreSim(sampleWeekEvents(params, mult), scoring);
}

/**
 * Build Order 1.2 — parameter uncertainty for the WEEKLY distribution.
 *
 * `seasonDistribution` has drawn a per-season "true level" for a while, but the
 * weekly sampler never did: every simulated week used the point-estimate role and
 * efficiency exactly, so the only spread was within-week sampling noise. Measured
 * week-by-week that leaves the interval visibly too narrow — the PIT histogram is
 * overweight in BOTH tail bins (674 and 544 against 434 expected), which is the
 * signature of under-dispersion rather than bias.
 *
 * The missing piece is the same one the season path models: we do not actually know
 * his true target share or efficiency, and that uncertainty does not average away
 * within a single week. `sigma` = 0 reproduces the original behaviour exactly.
 *
 * sigma = 0.45 is fitted, not chosen: swept on the 2023 + 2024 weekly replays and
 * validated on 2025, where it moved 80% coverage from 0.724 to 0.791 (gate is
 * [0.78, 0.82]) and PIT calibration error from 0.161 to 0.109, at effectively
 * unchanged CRPS (3.248 -> 3.251) — i.e. it widened the interval where it was
 * genuinely too narrow rather than buying coverage by hedging everything.
 * `downMult` stayed at 1.0: unlike season totals, weekly outcomes showed no
 * benefit from a fattened downside once the overall spread was right.
 * See scripts/fit-weekly-coverage.mjs.
 */
export const WEEKLY_LEVEL = { sigma: 0.45, downMult: 1 };

/** N simulated weeks. */
export function sampleWeeks(params, n = 2000, scoring = PPR, mult = 1, activeProbability = 1, levelOpts) {
  const L = { ...WEEKLY_LEVEL, ...levelOpts };
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (random() > activeProbability) { out[i] = 0; continue; }
    let m = mult;
    if (L.sigma > 0) {
      const z = randn();
      const level = Math.exp(z < 0 ? z * L.sigma * L.downMult : z * L.sigma);
      m = typeof mult === 'object'
        ? { pass: (mult.pass ?? 1) * level, rush: (mult.rush ?? 1) * level }
        : mult * level;
    }
    out[i] = sampleWeek(params, scoring, m);
  }
  return out;
}

/**
 * Weekly distribution summary for a projection: the percentiles that answer
 * start/sit and trade questions directly.
 */
export function weeklyDistribution(projection, {
  runs = 2000, scoring = PPR, mult = 1, activeProbability = 1
} = {}) {
  const s = sampleWeeks(projection.params, runs, scoring, mult, activeProbability);
  const pct = percentiles(s, [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]);
  const m = mean(s);
  return {
    ...pct,
    mean: +m.toFixed(2),
    // Boom and bust thresholds by position, matching the existing volatility view.
    boom_rate: +(s.filter(x => x >= ({ QB: 24, RB: 18, WR: 18, TE: 14 })[projection.position] ?? 18).length / s.length).toFixed(3),
    bust_rate: +(s.filter(x => x <= ({ QB: 14, RB: 8, WR: 8, TE: 6 })[projection.position] ?? 8).length / s.length).toFixed(3)
  };
}

/**
 * Season totals as a distribution: sample each week independently across the number
 * of games the player is expected to play.
 */
export function seasonDistribution(projection, { runs = 1000, scoring = PPR, mult = 1, level: levelOpts } = {}) {
  /*
   * Two sources of uncertainty, and leaving either out makes the interval a lie.
   *
   *   week-to-week noise — the same player has good and bad games
   *   parameter uncertainty — we don't actually know his true role or talent
   *
   * Only the first was modelled originally, and averaging seventeen independent weeks
   * crushes it almost to a point: the backtester measured 33% coverage on a nominal 80%
   * interval. Real season totals move because a role changed or a player got hurt, not
   * because seventeen coin flips landed the same way.
   *
   * So each simulated season first draws a *true* level for the player and a number of
   * games, then plays the weeks out at that level.
   */
  const L = { ...LEVEL_UNCERTAINTY, ...levelOpts };
  const evidence = projection.evidence_weight ?? projection.evidence_games ?? 4;
  // Less evidence, wider prior on his true level. Bounded so a well-established
  // starter still carries real uncertainty and a rookie does not carry absurd amounts.
  const sigma = Math.max(L.lo, Math.min(L.hi, L.a + L.b / Math.sqrt(Math.max(1, evidence))));
  const availRate = Math.max(0.05, Math.min(1, (projection.expected_games ?? GAMES) / GAMES));

  const totals = new Array(runs);
  for (let i = 0; i < runs; i++) {
    // Two-piece log-normal. The original was symmetric in log space (a plain
    // log-normal), which puts the fat tail on the UPSIDE — but measured against
    // three held-out seasons, log(actual/predicted) is consistently *negatively*
    // skewed (-0.97, -1.04, -1.36): a player who loses his role collapses further
    // than a breakout climbs. `downMult` widens only the downside so the left tail
    // carries the mass the data actually shows, instead of the model being
    // repeatedly surprised by busts.
    const z = randn();
    const level = Math.exp(z < 0 ? z * sigma * L.downMult : z * sigma);
    // Beta-binomial rather than binomial: a season is usually "healthy" or "hurt",
    // not seventeen independent coin flips at a fixed rate.
    const games = randBinomial(GAMES, randBeta(availRate * L.conc, (1 - availRate) * L.conc));
    let t = 0;
    for (let g = 0; g < games; g++) t += sampleWeek(projection.params, scoring, mult * level);
    totals[i] = t;
  }
  return { ...percentiles(totals, [0.05, 0.25, 0.5, 0.75, 0.95]), mean: +mean(totals).toFixed(1), samples: totals };
}
