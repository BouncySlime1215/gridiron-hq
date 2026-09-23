/**
 * The standing start/sit gate (plan item C12, unit C-01).
 *
 * Nick: "start/sit must beat 'start highest projection' ... If it can't beat dumb,
 * it's decoration." The app's start/sit already starts the higher projection
 * (lineup-brain.js#lineupCall solves on week_points), so what has to earn its place
 * is the PROJECTION.
 *
 * THE VERDICT is the plan's own rule (Independent Auditor ruling, 2026-09-22; prereg
 * addendum 2): the projection the app served against ESPN's weekly projection, the one a
 * manager in Nick's ESPN leagues actually starts by. See planRuleVerdict. The
 * pre-registered season-average rule below still runs exactly as registered, as
 * `average_check`: a floor, reported beside the verdict and never as it.
 *
 * The average check (prereg §8, H1):
 *
 *   our policy   start the higher weekly projection from production's CURRENT model
 *                settings, replayed week by week with only what was known before each
 *                week: the configuration-B structural head (roleRecency
 *                WEEKLY_ROLE_RECENCY passed explicitly, kOverride omitted so the fitted
 *                volume k resolves cutoff-safe) blended by the as-of weekly ensemble
 *                champion (weekly-weight-store.js#activeWeeklyWeightSet({season, week}),
 *                the resolution player-week-engine.js uses live). This is today's
 *                configuration, not necessarily the number served at the time: 2026
 *                week 2 was captured before the fitted k and its weights existed;
 *   dumb rule    start the higher season-to-date PPR average.
 *
 * Graded on same-week, same-position pairs both rules call startable (>= 8.0 PPR),
 * where the two rules disagree, on what the two picks actually scored (0 for a
 * did-not-play). The replay is weekly-backtest.js#replaySeasonWeekly, unedited; the
 * decision population is its `_decision_rows` (players active the week before). The
 * grading is baseline-gate.js, shared with the waiver and trade gates to come.
 *
 * Two arms on the forward weeks (prereg addendum 1). Both keep the replay rows' population
 * and actual scores and swap only the projections:
 *   served vs average  the projection the app actually served, from
 *                      weekly_prediction_snapshots (weekly-learning.js#captureWeeklyPredictions);
 *   served vs ESPN     the plan's "start the highest projection": ESPN's weekly
 *                      projection, from league_roster_snapshots, settled rows
 *                      (scripts/collect-roster-snapshots.mjs#writePeriod). Since addendum 2
 *                      this arm, pooled over every served week, IS the verdict's input
 *                      (its "at lock" source).
 *
 * Standing rule 3: replay magnitudes and lineup rates never reach Nick. Every window
 * carries a `direction`; the Lineup panel and the job's sync_log detail use only that.
 * The magnitudes stay in the stored evidence for the Auditor.
 *
 * Pre-registration (windows, ship rule, controls, sign convention):
 * docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md, and its addenda 1 and 2.
 *
 * WHAT THIS DOES NOT GRADE. The replay predictor is production's weekly projection in
 * production's configuration, not the full live week_points chain: the coordinator
 * correction, the chance to play and the betting-line lift are not in the replay
 * (weekly-backtest.js reads four tables; the live engine reads 23). Scoring is PPR,
 * not each league's scoringItems. The pairs are a league-wide pool, not a roster.
 * The served snapshot is the ensemble projection, not the lineup's week_points either
 * (storing the served week_points is WORK-QUEUE S-12).
 */
import { rows, row } from '../../db/index.js';
import { replaySeasonWeekly } from '../weekly-backtest.js';
import { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } from '../weekly-ensemble.js';
import { activeWeeklyWeightSet } from '../weekly-weight-store.js';
import { activeKVectorFor, activeFitMeta } from '../shrinkage-fit.js';
import { recordGateAudit } from '../model-governance.js';
import { gradeDecisions, baselineGateVerdict, SIGN_CONVENTION } from './baseline-gate.js';

export const GATE_ID = 'start_sit';
export const GATE_VERSION = 'start-sit-gate-v3';
export const PREREG = 'docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md';
export const PREREG_ADDENDUM = 'docs/evidence/2026-09-22/start-sit-baseline-gate-prereg-addendum-1.md';
/** The plan-rule verdict's own pre-registration (Auditor ruling A8), filed before 2026 week 3. */
export const PREREG_ADDENDUM_2 = 'docs/evidence/2026-09-22/start-sit-baseline-gate-prereg-addendum-2.md';
/** Graded weeks a source needs before the plan rule can pass or lose on it (addendum 2 §5, gate P3). */
export const PLAN_RULE_MIN_WEEKS = 4;
/** The startable line DECISION_CURVE (lineup-brain.js) is stated on: both projections >= 8.0 PPR. */
export const STARTABLE_PPR = 8;
/**
 * projections.js `K.share`, the value pickK falls back to when no fitted target-share
 * k resolves. Pinned against the source by test/start-sit-gate.test.js.
 */
export const HARDCODED_K_SHARE = 6;
/** Past window (prereg §6): both out of sample for the frozen-2023 ensemble weights. */
export const PAST_SEASONS = Object.freeze([2024, 2025]);
export const PAST_WEEKS = Object.freeze([5, 18]);
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

export const POLICY_TEXT = 'Start the higher weekly projection from the app\'s current model settings, replayed week by '
  + 'week with only what was known before each week (weekly role recency, the fitted volume numbers and the blend '
  + 'weights, each chosen by data cutoff).';
export const FORWARD_REPLAY_TEXT = 'This season, today\'s model settings replayed on this season\'s weeks: not the '
  + 'projection the app served at the time.';
export const SERVED_TEXT = 'What the app actually served: the projection it saved before each week\'s first kickoff, '
  + 'graded on the same players and the same scores as the replay.';
/** The plan's rule (Auditor ruling A6): what the top-level verdict is graded against. */
export const ESPN_BASELINE_TEXT = 'The plan\'s dumb rule: start the player ESPN projects higher that week (ESPN\'s own '
  + 'weekly projection, one value per player and week, from the synced leagues\' settled lineups).';
/** The pre-registered floor, average_check (A6): the weaker check, never the verdict. */
export const BASELINE_TEXT = 'The weaker check, set before the numbers: start the player with the higher season-to-date '
  + 'PPR average (his average in games played this season before the week). No model.';
export const UNIVERSE_TEXT = 'Every pair of same-position players (QB, RB, WR, TE) in the same week, both active '
  + 'the week before, not on a bye, and both projected at least 8.0 PPR by both rules. Graded only where the two '
  + 'rules disagree, on what the two picks actually scored (0 if he did not play).';
export const REPLAY_CAVEAT = 'Graded on the weekly replay of production\'s projection. The live number also carries '
  + 'the chance to play, the betting-line adjustment and the coordinator correction, which the replay does not.';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Which way a graded window points, and nothing about how far (standing rule 3).
 * The sign of points per disagreement (our pick minus the dumb pick).
 */
export function directionOf(grade) {
  if (!grade || grade.status) return 'not_available';
  if (!(grade.n > 0)) return 'no_disagreements';
  const points = grade.points_per_decision;
  if (!Number.isFinite(points)) return 'not_available';
  return points > 0 ? 'ours_ahead' : points < 0 ? 'dumb_ahead' : 'even';
}

const notAvailable = reason => ({ status: 'not_available', reason, direction: 'not_available' });

/** An arm that carries a status is a named absence (not_available), not a grade. */
const isGraded = arm => !!arm && !arm.status;
const weeksGraded = arm => (isGraded(arm) ? (arm.per_week ?? []).length : 0);

/**
 * The plan-rule verdict (prereg addendum 2 §4-5): the projection the app served against
 * ESPN's weekly projection, as a pure function of two graded served-vs-ESPN arms, each
 * pooled over every served week from 2026 week 2 on.
 *
 *   atLock      ESPN's settled value (league_roster_snapshots, source 'final'). It carries
 *               news from after our snapshot, which favours ESPN, so it can support a pass
 *               but never a loss.
 *   sameCutoff  ESPN captured with our snapshot (RL-1-1) or ours captured at lock (S-12).
 *               Neither exists yet. Once it has PLAN_RULE_MIN_WEEKS graded weeks it alone
 *               decides; until then the at-lock arm decides.
 *
 * On the deciding arm: P1 points CI lower bound > 0 and P2 win-rate CI lower bound > 0.5
 * (player-clustered, pooled), P3 at least PLAN_RULE_MIN_WEEKS graded weeks (a week with at
 * least one disagreement). Every bound is strict. beats_dumb = P1 and P2 and P3;
 * loses_to_dumb = the same-cutoff arm decides, P3, and the points CI upper bound < 0;
 * anything else is not_shown with a reason: too_few_weeks, espn_ahead_at_lock_only (an
 * at-lock "loss" the source cannot support) or not_distinguishable. No week-clustered
 * criterion: addendum 2 §5 allows one only at a cluster count its own calibration supports.
 */
export function planRuleVerdict({ atLock = null, sameCutoff = null } = {}) {
  const sameDecides = weeksGraded(sameCutoff) >= PLAN_RULE_MIN_WEEKS;
  const arm = sameDecides ? sameCutoff : atLock;
  const weeks = weeksGraded(arm);
  const lo = ci => (Array.isArray(ci) && Number.isFinite(ci[0]) ? ci[0] : null);
  const hi = ci => (Array.isArray(ci) && Number.isFinite(ci[1]) ? ci[1] : null);
  const points = isGraded(arm) ? arm.ci90?.player?.points : null;
  const winRate = isGraded(arm) ? arm.ci90?.player?.win_rate : null;
  const gates = [
    { id: 'P1', label: 'points per disagreement vs ESPN, player-clustered 90% CI lower bound > 0',
      value: lo(points), passed: lo(points) != null && lo(points) > 0 },
    { id: 'P2', label: 'decision win rate vs ESPN, player-clustered 90% CI lower bound > 0.5',
      value: lo(winRate), passed: lo(winRate) != null && lo(winRate) > 0.5 },
    { id: 'P3', label: `at least ${PLAN_RULE_MIN_WEEKS} graded weeks`, value: weeks, passed: weeks >= PLAN_RULE_MIN_WEEKS },
  ];
  const [p1, p2, p3] = gates.map(g => g.passed);
  const espnAhead = hi(points) != null && hi(points) < 0;
  let verdict = 'not_shown';
  let reason = null;
  if (p1 && p2 && p3) verdict = 'beats_dumb';
  else if (!p3) reason = 'too_few_weeks';
  else if (espnAhead && sameDecides) verdict = 'loses_to_dumb';
  else if (espnAhead) reason = 'espn_ahead_at_lock_only';
  else reason = 'not_distinguishable';
  return {
    verdict, reason, source: sameDecides ? 'espn_same_cutoff' : 'espn_at_lock', weeks_graded: weeks,
    direction: arm ? directionOf(arm) : 'not_available',
    gates,
    mde80: isGraded(arm) ? arm.mde80 ?? null : null,
    prereg: PREREG_ADDENDUM_2,
  };
}

/**
 * Pairs, disagreements and each rule's pair accuracy.
 *
 * Pair accuracy uses scripts/promote-early-week-weights.mjs#startSitPairAccuracy's
 * definition exactly (1 when the higher projection scored more, 0 when not, 0.5 when
 * either the projections or the actuals tie), pinned equal by a test.
 *
 * @param rows [{season, week, position, player_id, policy, baseline, actual}]
 */
export function startSitDecisions(rows, { threshold = STARTABLE_PPR } = {}) {
  const groups = new Map();
  for (const r of rows) {
    if (!SKILL.has(r.position)) continue;
    if (![r.policy, r.baseline, r.actual].every(Number.isFinite)) continue;
    if (!(r.policy >= threshold && r.baseline >= threshold)) continue;
    const key = `${r.season}|${r.week}|${r.position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let pairs = 0, agreements = 0, accPolicy = 0, accBaseline = 0;
  const disagreements = [];
  const score = (px, py, ax, ay) => (ax === ay || px === py ? 0.5 : ((px > py) === (ax > ay) ? 1 : 0));
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i], y = list[j];
        pairs++;
        accPolicy += score(x.policy, y.policy, x.actual, y.actual);
        accBaseline += score(x.baseline, y.baseline, x.actual, y.actual);
        if (x.policy === y.policy || x.baseline === y.baseline) continue;     // a tie is no call
        if ((x.policy > y.policy) === (x.baseline > y.baseline)) { agreements++; continue; }
        const ours = x.policy > y.policy ? x : y;
        const theirs = ours === x ? y : x;
        disagreements.push({
          season: ours.season, week: ours.week, position: ours.position,
          policy_id: ours.player_id, baseline_id: theirs.player_id,
          policy_points: ours.actual, baseline_points: theirs.actual,
          policy_margin: r4(ours.policy - theirs.policy), baseline_margin: r4(theirs.baseline - ours.baseline),
        });
      }
    }
  }
  return {
    pairs, disagreements,
    agreement_share: pairs ? r4(agreements / pairs) : null,
    pair_accuracy: { policy: pairs ? r4(accPolicy / pairs) : null, baseline: pairs ? r4(accBaseline / pairs) : null },
  };
}

/**
 * Drop players on a bye. His team is the one he played for in week W-1 (known at
 * forecast time); if that team has no row in week W it did not play, which the
 * published schedule knows before the season. An injury zero is kept: his team
 * played, he did not, and both rules had to live with that.
 *
 * @param usage [{player_id, week, team}] for the season
 */
export function removeByes(decisionRows, usage) {
  const teamAt = new Map();
  const played = new Set();
  for (const u of usage) {
    if (u.team == null) continue;
    teamAt.set(`${u.player_id}|${u.week}`, u.team);
    played.add(`${u.team}|${u.week}`);
  }
  const kept = [], removed = [];
  let teamUnknown = 0;
  for (const r of decisionRows) {
    const team = teamAt.get(`${r.player_id}|${r.week - 1}`);
    if (team == null) { teamUnknown++; kept.push(r); continue; }
    (played.has(`${team}|${r.week}`) ? kept : removed).push(r);
  }
  return { kept, removed, team_unknown: teamUnknown };
}

/** Configuration B's k: what buildProjections resolves with kOverride omitted and weekly role recency. */
export function defaultKResolver(season) {
  return activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: season });
}

/**
 * The k control (prereg §7). Stops the gate when the target-share k a replay would use
 * is missing or is the hardcoded K.share = 6: configuration B grades the fitted k, and 6
 * means no fit resolved for that season.
 */
export function kControl(seasons, resolve = defaultKResolver) {
  return seasons.map(season => {
    const k = resolve(season)?.target_share?.ALL;
    if (!Number.isFinite(k) || k === HARDCODED_K_SHARE) {
      throw new Error(`k control: the ${season} replay's target_share k resolves to ${k ?? 'nothing'}, which is the `
        + `hardcoded K.share = ${HARDCODED_K_SHARE} (projections.js), not a fitted k. Configuration B needs an active `
        + 'volume fit (shrinkage_fits), so the gate stops before grading anything.');
    }
    return { season, target_share_k: k };
  });
}

/**
 * The as-of ensemble head: for a context in week W, the weight set production would
 * have resolved for (season, W). Read once per week.
 */
export function asOfChampionHead(season, { weightSetFor = activeWeeklyWeightSet } = {}) {
  const memo = new Map();
  const resolve = week => {
    if (!memo.has(week)) memo.set(week, weightSetFor({ season, week }));
    return memo.get(week);
  };
  const head = ctx => weeklyEnsemblePrediction(ctx, resolve(ctx.week).weights);
  head.resolve = resolve;
  head.champions = () => Object.fromEntries([...memo].map(([week, set]) => [week, set.id]));
  return head;
}

/** One season's replay in configuration B, as gate rows with byes removed. */
export function replayWindow(season, [startWeek, endWeek]) {
  const head = asOfChampionHead(season);
  const replay = replaySeasonWeekly(season, {
    startWeek, endWeek, distributions: false, roleRecency: WEEKLY_ROLE_RECENCY, predictionHead: head,
  });
  const raw = (replay._decision_rows ?? []).map(d => ({
    season, week: d.week, position: d.position, player_id: d.player_id,
    policy: d.prediction, baseline: d.season_to_date, actual: d.actual, played: d.played,
  }));
  const usage = rows('SELECT player_id, week, team FROM player_week_usage WHERE season = ? AND team IS NOT NULL', season);
  const { kept, removed, team_unknown: teamUnknown } = removeByes(raw, usage);
  for (let week = startWeek; week <= endWeek; week++) head.resolve(week);
  return { season, weeks: [startWeek, endWeek], rows: kept, decision_rows: raw.length,
    bye_rows_removed: removed.length, team_unknown: teamUnknown, champions: head.champions() };
}

/** The forward window: every played week >= 2 of the newest season with rows, if it is after the past window. */
function forwardWindow(pastSeasons) {
  const latest = row('SELECT MAX(season) AS season FROM player_week_usage')?.season;
  if (!Number.isInteger(latest) || latest <= Math.max(...pastSeasons)) {
    return { status: 'not_available', reason: `no weekly usage for a season after ${Math.max(...pastSeasons)}` };
  }
  const maxWeek = row('SELECT MAX(week) AS week FROM player_week_usage WHERE season = ?', latest)?.week;
  if (!(maxWeek >= 2)) {
    return { status: 'not_available', season: latest,
      reason: `${latest} has no played week after week 1, and week 1 has no in-season history to grade` };
  }
  return { season: latest, weeks: [2, maxWeek] };
}

const maeOf = (list, key) => (list.length
  ? r4(list.reduce((s, r) => s + Math.abs(r[key] - r.actual), 0) / list.length) : null);

/** Everything one window reports: the grade, the pair census and both rules' error. */
function gradeWindow(windowRows, opts) {
  const pairs = startSitDecisions(windowRows);
  const skill = windowRows.filter(r => SKILL.has(r.position));
  return {
    ...gradeDecisions(pairs.disagreements, opts),
    pairs: pairs.pairs, agreement_share: pairs.agreement_share, pair_accuracy: pairs.pair_accuracy,
    mae_including_dnp: { policy: maeOf(skill, 'policy'), baseline: maeOf(skill, 'baseline'), rows: skill.length },
  };
}

/** Swap one field of each row for another producer's value, keyed by week and player; rows without one drop out. */
export function substitute(windowRows, values, field) {
  const kept = [];
  let missing = 0;
  for (const r of windowRows) {
    const v = values.get(`${r.week}|${r.player_id}`);
    if (!Number.isFinite(v)) { missing++; continue; }
    kept.push({ ...r, [field]: v });
  }
  return { rows: kept, missing };
}

/**
 * The projection the app served before each week: weekly_prediction_snapshots, written
 * pregame by weekly-learning.js#captureWeeklyPredictions (first write wins, refused once
 * the slate starts).
 */
export function servedSnapshots(season, [startWeek, endWeek]) {
  return rows(`SELECT week, player_id, prediction, weight_fit, as_of FROM weekly_prediction_snapshots
    WHERE season = ? AND week BETWEEN ? AND ?`, season, startWeek, endWeek);
}

/**
 * ESPN's weekly projection per (week, player): league_roster_snapshots.projected_points,
 * settled rows only (source 'final', written by scripts/collect-roster-snapshots.mjs#writePeriod
 * from each finished period's boxscore). One value per player-week: when the leagues
 * hold different values, that player-week is dropped and counted, never averaged.
 */
export function espnProjections(season, [startWeek, endWeek]) {
  const got = rows(`SELECT scoring_period_id AS week, player_id, COUNT(DISTINCT projected_points) AS n_values,
      MIN(projected_points) AS projection
    FROM league_roster_snapshots
    WHERE season = ? AND scoring_period_id BETWEEN ? AND ? AND source = 'final'
      AND player_id IS NOT NULL AND projected_points IS NOT NULL
    GROUP BY scoring_period_id, player_id`, season, startWeek, endWeek);
  const values = new Map();
  let conflicting = 0;
  for (const g of got) {
    if (g.n_values === 1) values.set(`${g.week}|${g.player_id}`, g.projection);
    else conflicting++;
  }
  return { values, conflicting };
}

/**
 * The forward weeks as the app served them (prereg addendum 1, arms A and B). Both arms
 * keep the replay rows (who, which week, the season average, what he scored) and swap
 * only the projections. Descriptive: neither is read by the verdict.
 */
export function servedArms(season, weeks, replayRows, { champions = {}, iterations = 2000, seed = 1 } = {}) {
  const label = `${season} ${weeks[0] === weeks[1] ? `week ${weeks[0]}` : `weeks ${weeks[0]}-${weeks[1]}`}`;
  const snaps = servedSnapshots(season, weeks);
  const fit = activeFitMeta();
  const kFittedAt = fit ? row('SELECT fitted_at FROM shrinkage_fits WHERE id = ?', fit.id)?.fitted_at ?? null : null;
  const perWeek = new Map();
  for (const s of snaps) {
    if (!perWeek.has(s.week)) perWeek.set(s.week, { asOf: s.as_of, fits: new Set() });
    const w = perWeek.get(s.week);
    if (s.as_of < w.asOf) w.asOf = s.as_of;
    if (s.weight_fit != null) w.fits.add(s.weight_fit);
  }
  const weekMeta = [...perWeek].sort(([a], [b]) => a - b).map(([week, w]) => {
    const champion = champions[week] ?? null;
    return {
      week, captured_at: w.asOf, weight_fit: [...w.fits].sort(), replay_champion: champion,
      same_weights: champion != null && w.fits.size === 1 && w.fits.has(champion),
      k_fit_id: fit?.id ?? null, k_fitted_at: kFittedAt,
      served_before_k_fit: kFittedAt == null ? null : Date.parse(w.asOf) < Date.parse(kFittedAt),
    };
  });
  const grade = (gradedRows, extra) => {
    const g = { ...gradeWindow(gradedRows, { iterations, seed }), rows: gradedRows.length, ...extra };
    return { ...g, direction: directionOf(g) };
  };

  const noSnapshot = `no pregame snapshot in weekly_prediction_snapshots for ${label}`;
  const served = new Map(snaps.map(s => [`${s.week}|${s.player_id}`, s.prediction]));
  const a = substitute(replayRows, served, 'policy');
  const vsAverage = snaps.length ? grade(a.rows, { excluded: { no_snapshot: a.missing } }) : notAvailable(noSnapshot);

  const espn = espnProjections(season, weeks);
  let vsEspn;
  if (!snaps.length) vsEspn = notAvailable(noSnapshot);
  else if (!espn.values.size) {
    vsEspn = notAvailable(`no settled ESPN projection in league_roster_snapshots for ${label}`
      + (espn.conflicting ? '; some player-weeks were dropped because the leagues hold different values' : ''));
  } else {
    const b = substitute(a.rows, espn.values, 'baseline');
    vsEspn = grade(b.rows, { excluded: { no_snapshot: a.missing, no_espn: b.missing,
      espn_conflicting_player_weeks: espn.conflicting } });
  }
  return { label: SERVED_TEXT, weeks: weekMeta, vs_average: vsAverage,
    vs_espn: vsEspn.status ? vsEspn : { baseline: ESPN_BASELINE_TEXT, ...vsEspn } };
}

/**
 * The known-nonzero control first (prereg §7): an oracle that starts whoever actually
 * scored more must win every disagreement it has, and a policy identical to the dumb
 * rule must have none. If the oracle finds nothing, the rows cannot show an edge and
 * no verdict is drawn from them.
 */
function instrumentControls(windowRows) {
  const oracle = startSitDecisions(windowRows.map(r => ({ ...r, policy: r.actual }))).disagreements;
  const identity = startSitDecisions(windowRows.map(r => ({ ...r, policy: r.baseline }))).disagreements;
  const outcome = d => d.policy_points - d.baseline_points;
  const oracleWins = oracle.filter(d => outcome(d) > 0).length;
  const oraclePoints = oracle.length ? oracle.reduce((s, d) => s + outcome(d), 0) / oracle.length : null;
  const o = { n: oracle.length, win_rate: oracle.length ? r4(oracleWins / oracle.length) : null,
    points_per_decision: r4(oraclePoints) };
  return {
    oracle: o, identity: { n: identity.length },
    passed: o.n > 0 && o.win_rate === 1 && o.points_per_decision > 0 && identity.length === 0,
  };
}

/**
 * Run the gate: k control, replays, pairs, grades, controls, then both rules: the
 * plan-rule verdict (top-level `verdict`, `plan_rule`) and the pre-registered average
 * check (`average_check`, never the top-level verdict). Pure of side effects apart from
 * reads; refreshStartSitGate stores the result.
 */
export function runStartSitGate({
  pastSeasons = PAST_SEASONS, pastWeeks = PAST_WEEKS, iterations = 2000, seed = 1,
  resolveK = defaultKResolver,
} = {}) {
  const forwardSpec = forwardWindow(pastSeasons);
  const seasons = [...pastSeasons, ...(forwardSpec.status ? [] : [forwardSpec.season])];
  // Before any replay: a replay that would read the hardcoded K.share grades a model
  // configuration B does not describe.
  const kc = kControl(seasons, resolveK);

  const champions = {};
  const perSeason = {};
  const pastRows = [];
  for (const season of pastSeasons) {
    const w = replayWindow(season, pastWeeks);
    champions[season] = w.champions;
    pastRows.push(...w.rows);
    // The weekly table and the failing weeks are reported once, pooled, below.
    const summary = gradeWindow(w.rows, { iterations, seed });
    delete summary.per_week;
    delete summary.failing_weeks;
    perSeason[season] = { ...summary, direction: directionOf(summary), decision_rows: w.decision_rows,
      bye_rows_removed: w.bye_rows_removed, team_unknown: w.team_unknown };
  }
  const pastGrade = gradeWindow(pastRows, { iterations, seed });
  const past = { seasons: [...pastSeasons], weeks: [...pastWeeks], ...pastGrade, direction: directionOf(pastGrade),
    per_season: perSeason };

  let forward;
  if (forwardSpec.status) {
    forward = { ...forwardSpec, direction: 'not_available' };
  } else {
    const w = replayWindow(forwardSpec.season, forwardSpec.weeks);
    champions[forwardSpec.season] = w.champions;
    const replayGrade = gradeWindow(w.rows, { iterations, seed });
    forward = { season: forwardSpec.season, weeks: forwardSpec.weeks, label: FORWARD_REPLAY_TEXT, ...replayGrade,
      direction: directionOf(replayGrade),
      decision_rows: w.decision_rows, bye_rows_removed: w.bye_rows_removed, team_unknown: w.team_unknown,
      served: servedArms(forwardSpec.season, forwardSpec.weeks, w.rows, { champions: w.champions, iterations, seed }) };
  }

  const controls = instrumentControls(pastRows);
  // H1 exactly as pre-registered (prereg §8): G4 reads the replay's forward grade only.
  // It is a floor check now (Auditor ruling (a)): reported beside the verdict, never as it.
  const ruled = baselineGateVerdict({ past, forward: forward.status ? null : forward });
  const averageCheck = { verdict: controls.passed ? ruled.verdict : 'instrument_fault', gates: ruled.gates,
    rule: BASELINE_TEXT, prereg: PREREG };
  // The verdict: the plan's rule, what the app served against ESPN's weekly projection
  // (prereg addendum 2). Its only source today is at lock; no same-cutoff capture exists
  // yet (RL-1-1, S-12), so it can pass or stay not_shown but never lose.
  const planned = planRuleVerdict({ atLock: forward.status ? null : forward.served.vs_espn, sameCutoff: null });
  const planRule = controls.passed ? planned : { ...planned, verdict: 'instrument_fault', reason: null };
  const fit = activeFitMeta();
  const championIds = [...new Set(Object.values(champions).flatMap(c => Object.values(c)))];
  return {
    gate: GATE_ID, version: GATE_VERSION, prereg: PREREG, prereg_addendum: PREREG_ADDENDUM,
    prereg_addendum_2: PREREG_ADDENDUM_2,
    policy: POLICY_TEXT, baseline: ESPN_BASELINE_TEXT, universe: UNIVERSE_TEXT, scoring: 'PPR',
    sign_convention: SIGN_CONVENTION, replay_caveat: REPLAY_CAVEAT,
    configuration: {
      role_recency: { seasonDecay: WEEKLY_ROLE_RECENCY.seasonDecay, weekHalfLife: WEEKLY_ROLE_RECENCY.weekHalfLife },
      k_override: 'omitted', k_control: kc, champions,
    },
    model_version: `configB|${fit ? `shrinkage-fit-${fit.id}` : 'no-fit'}|${championIds.join('+')}`,
    past, forward, controls,
    average_check: averageCheck,
    plan_rule: planRule,
    verdict: planRule.verdict,
  };
}

/**
 * The job body: run the gate and store it through model-governance.js#recordGateAudit
 * (table model_gate_audits). sport = 'FANTASY' keeps it out of every betting reader of
 * that table, which all filter on 'NFL'. An instrument fault is returned as an error
 * so sync_log records it, and is stored anyway so the page can say what happened.
 *
 * The stored gates are the average check's G1-G4 plus the plan-rule gate PLAN (Auditor
 * ruling A4), so model_gate_audits.verdict reads 'blocked' unless both the plan's rule and
 * the floor pass.
 *
 * The returned detail becomes sync_log.last_detail, which the Coach can read
 * (coach/catalog.js). Its `verdict` is the plan rule's and `average_verdict` the floor's
 * (A5), and it carries verdicts and directions only: no rate, no size.
 */
export function refreshStartSitGate({ run = runStartSitGate } = {}) {
  const result = run();
  const planGate = { id: 'PLAN', label: 'plan rule (prereg addendum 2): the served projection beats ESPN\'s weekly projection',
    value: result.plan_rule.verdict, passed: result.plan_rule.verdict === 'beats_dumb' };
  const audit = recordGateAudit({
    sport: 'FANTASY', market: GATE_ID, modelVersion: result.model_version,
    gates: [...result.average_check.gates.map(g => ({ id: g.id, label: g.label, value: g.value, passed: g.passed })), planGate],
    evidence: result,
  });
  const detail = {
    verdict: result.verdict, average_verdict: result.average_check.verdict, audit_id: audit?.id ?? null,
    past_direction: result.past?.direction ?? null,
    forward_direction: result.forward?.direction ?? null,
    served_vs_average_direction: result.forward?.served?.vs_average?.direction ?? null,
    served_vs_espn_direction: result.forward?.served?.vs_espn?.direction ?? null,
  };
  if (result.verdict === 'instrument_fault') {
    detail.error = 'instrument fault: the oracle control found no edge on these rows, so no verdict was drawn';
  }
  return detail;
}

/** The latest stored gate result, or a named absence. Read by GET /api/gates/start-sit. */
export function latestStartSitGate() {
  const stored = rows(`SELECT id, created_at, verdict, model_version, evidence_json FROM model_gate_audits
    WHERE sport = ? AND market = ? ORDER BY id DESC LIMIT 1`, 'FANTASY', GATE_ID)[0];
  if (!stored) {
    return { status: 'not_run', gate: GATE_ID,
      reason: 'The weekly start/sit gate job (start_sit_gate) has not stored a result yet.' };
  }
  let evidence;
  try {
    evidence = JSON.parse(stored.evidence_json);
  } catch (error) {
    return { status: 'unreadable', gate: GATE_ID, audit_id: stored.id,
      reason: `the stored gate evidence is not valid JSON (${error.message})` };
  }
  return { ...evidence, status: 'measured', audit_id: stored.id, stored_at: stored.created_at,
    audit_verdict: stored.verdict };
}
