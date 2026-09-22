/**
 * The standing start/sit gate (plan item C12, unit C-01).
 *
 * Nick: "start/sit must beat 'start highest projection' ... If it can't beat dumb,
 * it's decoration." The app's start/sit already starts the higher projection
 * (lineup-brain.js#lineupCall solves on week_points), so what has to earn its place
 * is the PROJECTION: does starting by ours beat starting by the dumbest projection a
 * manager has, his season-to-date average?
 *
 *   our policy   start the higher weekly projection as production would have served
 *                it that week: the configuration-B structural head (roleRecency
 *                WEEKLY_ROLE_RECENCY passed explicitly, kOverride omitted so the fitted
 *                volume k resolves cutoff-safe) blended by the as-of weekly ensemble
 *                champion (weekly-weight-store.js#activeWeeklyWeightSet({season, week}),
 *                the resolution player-week-engine.js uses live);
 *   dumb rule    start the higher season-to-date PPR average.
 *
 * Graded on same-week, same-position pairs both rules call startable (>= 8.0 PPR),
 * where the two rules disagree, on what the two picks actually scored (0 for a
 * did-not-play). The replay is weekly-backtest.js#replaySeasonWeekly, unedited; the
 * decision population is its `_decision_rows` (players active the week before). The
 * grading is baseline-gate.js, shared with the waiver and trade gates to come.
 *
 * Pre-registration (windows, ship rule, controls, sign convention):
 * docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md.
 *
 * WHAT THIS DOES NOT GRADE. The replay predictor is production's weekly projection in
 * production's configuration, not the full live week_points chain: the coordinator
 * correction, the chance to play and the betting-line lift are not in the replay
 * (weekly-backtest.js reads four tables; the live engine reads 23). Scoring is PPR,
 * not each league's scoringItems. The pairs are a league-wide pool, not a roster.
 */
import { rows, row } from '../../db/index.js';
import { replaySeasonWeekly } from '../weekly-backtest.js';
import { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } from '../weekly-ensemble.js';
import { activeWeeklyWeightSet } from '../weekly-weight-store.js';
import { activeKVectorFor, activeFitMeta } from '../shrinkage-fit.js';
import { recordGateAudit } from '../model-governance.js';
import { gradeDecisions, baselineGateVerdict, SIGN_CONVENTION } from './baseline-gate.js';

export const GATE_ID = 'start_sit';
export const GATE_VERSION = 'start-sit-gate-v1';
export const PREREG = 'docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md';
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

export const POLICY_TEXT = 'Start the higher weekly projection, as production would have served it that week '
  + '(structural head with weekly role recency and the fitted volume k, blended by that week\'s ensemble weights).';
export const BASELINE_TEXT = 'The dumb rule: start the player with the higher season-to-date PPR average '
  + '(his average in games played this season before the week). No model.';
export const UNIVERSE_TEXT = 'Every pair of same-position players (QB, RB, WR, TE) in the same week, both active '
  + 'the week before, not on a bye, and both projected at least 8.0 PPR by both rules. Graded only where the two '
  + 'rules disagree, on what the two picks actually scored (0 if he did not play).';
export const REPLAY_CAVEAT = 'Graded on the weekly replay of production\'s projection. The live number also carries '
  + 'the chance to play, the betting-line adjustment and the coordinator correction, which the replay does not.';

const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

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
 * Run the gate: k control, replays, pairs, grades, controls, verdict. Pure of side
 * effects apart from reads; refreshStartSitGate stores the result.
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
    perSeason[season] = { ...summary, decision_rows: w.decision_rows, bye_rows_removed: w.bye_rows_removed,
      team_unknown: w.team_unknown };
  }
  const past = { seasons: [...pastSeasons], weeks: [...pastWeeks], ...gradeWindow(pastRows, { iterations, seed }),
    per_season: perSeason };

  let forward;
  if (forwardSpec.status) {
    forward = forwardSpec;
  } else {
    const w = replayWindow(forwardSpec.season, forwardSpec.weeks);
    champions[forwardSpec.season] = w.champions;
    forward = { season: forwardSpec.season, weeks: forwardSpec.weeks, ...gradeWindow(w.rows, { iterations, seed }),
      decision_rows: w.decision_rows, bye_rows_removed: w.bye_rows_removed, team_unknown: w.team_unknown };
  }

  const controls = instrumentControls(pastRows);
  const ruled = baselineGateVerdict({ past, forward: forward.status ? null : forward });
  const fit = activeFitMeta();
  const championIds = [...new Set(Object.values(champions).flatMap(c => Object.values(c)))];
  return {
    gate: GATE_ID, version: GATE_VERSION, prereg: PREREG,
    policy: POLICY_TEXT, baseline: BASELINE_TEXT, universe: UNIVERSE_TEXT, scoring: 'PPR',
    sign_convention: SIGN_CONVENTION, replay_caveat: REPLAY_CAVEAT,
    configuration: {
      role_recency: { seasonDecay: WEEKLY_ROLE_RECENCY.seasonDecay, weekHalfLife: WEEKLY_ROLE_RECENCY.weekHalfLife },
      k_override: 'omitted', k_control: kc, champions,
    },
    model_version: `configB|${fit ? `shrinkage-fit-${fit.id}` : 'no-fit'}|${championIds.join('+')}`,
    past, forward, controls,
    gates: ruled.gates,
    verdict: controls.passed ? ruled.verdict : 'instrument_fault',
  };
}

/**
 * The job body: run the gate and store it through model-governance.js#recordGateAudit
 * (table model_gate_audits). sport = 'FANTASY' keeps it out of every betting reader of
 * that table, which all filter on 'NFL'. An instrument fault is returned as an error
 * so sync_log records it, and is stored anyway so the page can say what happened.
 */
export function refreshStartSitGate({ run = runStartSitGate } = {}) {
  const result = run();
  const audit = recordGateAudit({
    sport: 'FANTASY', market: GATE_ID, modelVersion: result.model_version,
    gates: result.gates.map(g => ({ id: g.id, label: g.label, value: g.value, passed: g.passed })),
    evidence: result,
  });
  const detail = {
    verdict: result.verdict, audit_id: audit?.id ?? null,
    past_n: result.past?.n ?? null, past_win_rate: result.past?.win_rate ?? null,
    past_points_per_decision: result.past?.points_per_decision ?? null,
    forward_n: result.forward?.n ?? null,
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
