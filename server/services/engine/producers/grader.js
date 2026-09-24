/**
 * `grader`: the one producer that scores predictions against outcomes
 * (ENGINE-ARCHITECTURE.md D9, §3.7, §7.2; run as cloud unit EA-05).
 *
 * A field is graded once something registers it here (`registerGraded`), with its kind:
 *   dist   quantile forecast {levels, values} (or {quantiles: {level: value}}) scored on
 *          the outcome's points: quantile score, CRPS approximation, 80% coverage, PIT
 *   prob   probability (a number, or {p}) scored on `truth(outcome payload)` in {0, 1}:
 *          log loss, Brier, calibration slope/intercept
 * Outcome streams (OUTCOME_STREAMS), chosen at registration with `outcome`:
 *   outcome.player_week    (default; adapters/outcomes.js) entity `player_week_scored`
 *                          `<player>:<season>:<week>:<scoring_key>`; decision time = kickoff
 *   league.matchup_result  (prob only; adapters/league.js) entity `matchup`
 *                          `<league>:<season>:<week>:<a>:<b>`; truth = team a won; decision
 *                          time = the week's first kickoff (payload.decision_time)
 * Decisions (lineup.call,
 * waiver.board, search.trades) go through gradeDecisions, reused unchanged
 * (grade/scorers.js DECISION_SCORER); no decision field exists yet to wire.
 *
 * THE GRADING RULE. For each version of the field's producer (both lanes) and each outcome:
 *   - the decision time T is the outcome's game kickoff (`payload.kickoff`, the calendar's
 *     `game.cutoff` rule), unless the registration supplies `decisionTime(payload)`;
 *   - the graded row is the row IN FORCE at T: the latest row of that entity and version
 *     with written_at <= T. A row written after T is never graded (a later row for the
 *     same entity does not replace the one in force);
 *   - the version must be registered at or before T and its training window must end
 *     before T; otherwise nothing of that version is graded for that outcome;
 *   - the outcome is the LATEST `outcome.player_week` event for (player, season, week,
 *     scoring key) as of the tick: a stat correction replaces the outcome, never the
 *     prediction, so there is one grade per (prediction row, outcome entity);
 *   - season 2025 is the holdout: never graded (counted in `excluded.holdout_2025`).
 * Every exclusion is counted by reason; nothing is dropped silently.
 *
 * ROWS. Entity `producer` `<producer>@<version>`, global (league 0):
 *   grade.season_to_date  {season, by_field: {field: {kind, lane, n, clusters, floor_met,
 *                          metrics, labels, excluded, outcomes_hash, vs_fallback}}}
 *   grade.week            the same for the latest graded week, plus `graded`: every
 *                          (entity_id, state_id, outcome_event_id) it scored (the audit)
 * Labels: `forward` (season >= 2026) or `test` (earlier seasons). `fit` cannot occur: a
 * row whose training window reaches its decision time is excluded, not labelled.
 * Floors (clusterFloor): >= 4 distinct weeks and >= 20 distinct players (or matchups).
 * vs_incumbent (§7.2, grade/compare.js): on a SHADOW version's field, its paired score
 * difference against the active version on the same outcomes, per week cluster, with a
 * confidence sequence. scripts/check-promotion.mjs reads it (§6.3).
 *   grade.decision_luck   entity `<stream>@<which>` (offer.sent@app, rec.<kind>@shown,
 *                          rec.<kind>@considered): decision vs luck, point in time (§7.3,
 *                          grade/decision-luck.js). Inputs in force at the decision time only:
 *                          a league.settings or market.player_value row, or a rewritten
 *                          forecast, that arrived after it is never used.
 * Write-on-change: a tick with no new outcome and no new prediction writes nothing.
 * Coordination: EVAL-01's `brain_report` (#235) and IDEA-001's `served_numbers` (#243) are
 * read by neither side yet; GRADE_TO_EVAL_CHECK names which grade row feeds which check.
 */
import crypto from 'node:crypto';
import { registerProducer, fieldSpec } from '../registry.js';
import { quantileScore, pitFromQuantiles, inInterval, logLoss, brier, calibration, ksUniform, clusterFloor, mean }
  from '../grade/scorers.js';
import { pairedVsIncumbent } from '../grade/compare.js';
import { offerSplits, recSplits, summariseSplit } from '../grade/decision-luck.js';

export const GRADER_VERSION = 'ea05-2';
export const HOLDOUT_SEASONS = Object.freeze([2025]);
export const FORWARD_FROM_SEASON = 2026;
const PLAYER_CHUNK = 200;
const LOOKBACK_DAYS = 400;

/**
 * Which EVAL-01 check (PR #235, `brain_report.check_id`) each graded stream feeds once both
 * land. Names only: neither side reads the other yet.
 */
export const GRADE_TO_EVAL_CHECK = Object.freeze({
  'blend.p_accept': 'E1', 'clone.p_accept': 'E1',
  'title.odds': 'E3-live',
  'lineup.call': 'E6',
  'autopsy.week': 'E7',
});

const DECISION_EVENTS = Object.freeze(['offer.sent', 'rec.shown', 'rec.considered', 'rec.graded', 'league.settings',
  'market.player_value']);

/** Where a graded field's outcomes come from, and how a prediction row joins one. */
export const OUTCOME_STREAMS = Object.freeze({
  'outcome.player_week': Object.freeze({ entityType: 'player_week_scored', kinds: ['dist', 'prob'],
    key: p => `${p.player_id}:${p.season}:${p.week}:${p.scoring_key}`, clusterEntity: p => String(p.player_id),
    decisionTime: p => p.kickoff, truth: null }),
  'league.matchup_result': Object.freeze({ entityType: 'matchup', kinds: ['prob'],
    key: p => p.matchup, clusterEntity: p => p.matchup, decisionTime: p => p.decision_time,
    truth: p => (p.tie || p.winner == null ? null : p.winner === p.team_a ? 1 : 0) }),
});

const WRITERS = registerProducer({
  name: 'grader',
  active: GRADER_VERSION,
  versions: { [GRADER_VERSION]: { params: { decision_time: 'game kickoff', floor: { weeks: 4, entities: 20 },
    holdout: HOLDOUT_SEASONS, lookback_days: LOOKBACK_DAYS } } },
  fields: [
    { field: 'grade.season_to_date', valueType: 'object', entityTypes: ['producer'],
      replaces: ['gates/baseline-gate.js#gradeDecisions (as the scorer, reused)'],
      description: 'Proper scores of one producer version, season to date, per graded field' },
    { field: 'grade.week', valueType: 'object', entityTypes: ['producer'],
      description: 'Proper scores of one producer version for the latest graded week, with every graded pair' },
    { field: 'grade.decision_luck', valueType: 'object', entityTypes: ['producer'],
      description: 'Decision vs luck per decision stream: expected value at decision time from inputs in force then; luck = the rest' },
  ],
  inputs: { events: [...Object.keys(OUTCOME_STREAMS), ...DECISION_EVENTS], fields: [], grades: true, scope: 'global',
    schedule: 'tick', cost: 'cheap', budget_ms: 60000 },
});

const graded = new Map();

/**
 * Grade `field` from now on. kind 'dist' | 'prob'; `outcome` one of OUTCOME_STREAMS (default
 * outcome.player_week). A prob field needs truth(payload) -> 0 | 1 unless its stream has one.
 */
export function registerGraded(field, { kind, truth = null, decisionTime = null, outcome = 'outcome.player_week' } = {}) {
  if (!['dist', 'prob'].includes(kind)) throw new Error(`graded field ${field}: kind must be dist or prob`);
  const stream = OUTCOME_STREAMS[outcome];
  if (!stream) throw new Error(`graded field ${field}: outcome must be one of ${Object.keys(OUTCOME_STREAMS).join(', ')}`);
  if (!stream.kinds.includes(kind)) throw new Error(`graded field ${field}: ${outcome} grades ${stream.kinds.join('/')} only`);
  const truthFn = truth ?? stream.truth;
  if (kind === 'prob' && typeof truthFn !== 'function') throw new Error(`graded field ${field}: a prob field needs truth(payload)`);
  const spec = fieldSpec(field);
  if (spec && spec.valueType !== kind) throw new Error(`graded field ${field} is valueType ${spec.valueType}, not ${kind}`);
  if (graded.has(field)) return graded.get(field);
  const g = Object.freeze({ field, kind, truth: truthFn, decisionTime, outcome });
  graded.set(field, g);
  return g;
}

export const listGraded = () => [...graded.values()];

const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const r6 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(6));

function quantilesOf(value) {
  if (Array.isArray(value?.levels) && Array.isArray(value?.values)) return { levels: value.levels.map(Number), values: value.values.map(Number) };
  if (value?.quantiles && typeof value.quantiles === 'object') {
    const pairs = Object.entries(value.quantiles).map(([l, v]) => [Number(l), Number(v)]).sort((a, b) => a[0] - b[0]);
    return { levels: pairs.map(p => p[0]), values: pairs.map(p => p[1]) };
  }
  return null;
}
const probOf = value => (typeof value === 'number' ? value : typeof value?.p === 'number' ? value.p : null);

function trainingEnd(tw) {
  if (tw == null) return { ok: true, end: null };
  const raw = tw.to ?? tw.end ?? null;
  const t = raw == null ? NaN : Date.parse(raw);
  return Number.isFinite(t) ? { ok: true, end: new Date(t).toISOString() } : { ok: false, end: null };
}

const lookbackFrom = ctx => new Date(Date.parse(ctx.tick.as_of) - LOOKBACK_DAYS * 86400000).toISOString();

/** Events of `types` naming any of these players, read in chunks (every getEvents read is bounded). */
function eventsForPlayers(ctx, types, playerIds, from = undefined) {
  const out = [];
  const ids = [...playerIds].sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i += PLAYER_CHUNK) {
    const entities = ids.slice(i, i + PLAYER_CHUNK).map(p => `player:${p}`);
    out.push(...ctx.read.events({ types, entities, ...(from ? { from } : {}) }));
  }
  return out;
}

/**
 * The latest outcome per outcome entity, per stream: player-weeks for the players that have
 * predictions (a stat correction replaces the outcome), matchups for the leagues that do.
 */
function latestOutcomes(ctx, predictionRows) {
  const byStream = new Map(Object.keys(OUTCOME_STREAMS).map(s => [s, new Map()]));
  const keep = (stream, e) => {
    const m = byStream.get(stream);
    const k = OUTCOME_STREAMS[stream].key(e.payload);
    if (!m.has(k) || m.get(k).id < e.id) m.set(k, e);
  };
  const players = new Set(); const leagues = new Set();
  for (const r of predictionRows) {
    if (r.entity_type === 'player_week_scored') players.add(Number(r.entity_id.split(':')[0]));
    else if (r.entity_type === 'matchup') leagues.add(Number(r.entity_id.split(':')[0]));
  }
  if (players.size) {
    for (const e of eventsForPlayers(ctx, ['outcome.player_week'], players, lookbackFrom(ctx))) keep('outcome.player_week', e);
  }
  for (const league of [...leagues].sort((a, b) => a - b)) {
    for (const e of ctx.read.events({ types: ['league.matchup_result'], leagueId: league, from: lookbackFrom(ctx) })) {
      keep('league.matchup_result', e);
    }
  }
  return byStream;
}

/** Score one prediction row against one outcome. Returns the item, or a reason it cannot be scored. */
function scoreItem(g, pred, outcome) {
  const p = outcome.payload;
  const base = { entity_id: pred.entity_id, state_id: pred.id, outcome_event_id: outcome.id,
    week: `${p.season}:${p.week}`, entity: OUTCOME_STREAMS[g.outcome].clusterEntity(p), season: p.season };
  if (g.kind === 'dist') {
    const q = quantilesOf(pred.value);
    if (!q) return { reason: 'malformed' };
    try {
      const s = quantileScore(q.levels, q.values, p.points);
      const pZero = typeof pred.value?.p_zero === 'number' ? brier(pred.value.p_zero, p.points === 0 ? 1 : 0) : null;
      return { item: { ...base, primary: s.score, crps_approx: s.crps_approx, pit: pitFromQuantiles(q.levels, q.values, p.points),
        cover80: inInterval(q.levels, q.values, p.points), p_zero_brier: pZero } };
    } catch (e) {
      return { reason: 'malformed', error: e.message };
    }
  }
  const prob = probOf(pred.value);
  const y = g.truth(p);
  if (!(prob >= 0 && prob <= 1) || !(y === 0 || y === 1)) return { reason: 'malformed' };
  return { item: { ...base, primary: logLoss(prob, y), brier: brier(prob, y), p: prob, y } };
}

function summarise(g, lane, items, excluded) {
  const floor = clusterFloor(items);
  const labels = {};
  for (const it of items) {
    const l = it.season >= FORWARD_FROM_SEASON ? 'forward' : 'test';
    labels[l] = (labels[l] ?? 0) + 1;
  }
  let metrics = null;
  if (items.length && g.kind === 'dist') {
    const covers = items.map(i => i.cover80).filter(v => v != null);
    const pz = items.map(i => i.p_zero_brier).filter(v => v != null);
    const ks = ksUniform(items.map(i => i.pit));
    metrics = { quantile_score: r6(mean(items.map(i => i.primary))), crps_approx: r6(mean(items.map(i => i.crps_approx))),
      coverage80: covers.length ? r6(mean(covers)) : null, p_zero_brier: pz.length ? r6(mean(pz)) : null,
      pit_ks: { d: r6(ks.d), p: r6(ks.p), n: ks.n } };
  } else if (items.length) {
    const cal = calibration(items.map(i => i.p), items.map(i => i.y));
    metrics = { log_loss: r6(mean(items.map(i => i.primary))), brier: r6(mean(items.map(i => i.brier))),
      calibration: { slope: r6(cal.slope), intercept: r6(cal.intercept), ...(cal.reason ? { reason: cal.reason } : {}) } };
  }
  return { kind: g.kind, lane, n: items.length, clusters: { weeks: floor.weeks, entities: floor.entities },
    floor_met: floor.met, metrics, labels, excluded: { ...excluded },
    outcomes_hash: hash(items.map(i => i.outcome_event_id).sort((a, b) => a - b)) };
}

/** Grade every version of one field. Returns [{version, lane, items, excluded}] (items already cut and scored). */
function gradeField(ctx, g, read, outcomesByStream) {
  const stream = OUTCOME_STREAMS[g.outcome];
  const outcomes = outcomesByStream.get(g.outcome);
  const out = [];
  for (const v of read.versions) {
    if (v.status !== 'active' && v.status !== 'shadow') continue;
    const lane = v.status === 'active' ? 'live' : 'shadow';
    const byEntity = new Map();
    for (const r of read.rows) {
      if (r.producer_version !== v.version || r.entity_type !== stream.entityType) continue;
      if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
      byEntity.get(r.entity_id).push(r);
    }
    const excluded = { holdout_2025: 0, version_after_decision: 0, training_after_decision: 0, training_window_unreadable: 0,
      written_after_decision: 0, no_decision_time: 0, malformed: 0 };
    const items = [];
    const tw = trainingEnd(v.training_window);
    for (const [entityId, preds] of [...byEntity].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const outcome = outcomes.get(entityId);
      if (!outcome) continue; // not settled yet: nothing to grade, nothing excluded
      const p = outcome.payload;
      if (HOLDOUT_SEASONS.includes(Number(p.season))) { excluded.holdout_2025 += 1; continue; }
      const T = g.decisionTime ? g.decisionTime(p) : stream.decisionTime(p);
      if (!T) { excluded.no_decision_time += 1; continue; }
      if (!(v.registered_at <= T)) { excluded.version_after_decision += 1; continue; }
      if (!tw.ok) { excluded.training_window_unreadable += 1; continue; }
      if (tw.end && !(tw.end < T)) { excluded.training_after_decision += 1; continue; }
      let inForce = null;
      for (const r of preds) if (r.written_at <= T) inForce = r; // ascending id: the last one written by T
      if (!inForce) { excluded.written_after_decision += 1; continue; }
      if (inForce.value == null) continue; // a typed absence in force: no forecast was made
      const s = scoreItem(g, inForce, outcome);
      if (s.item) items.push(s.item); else excluded[s.reason] += 1;
    }
    out.push({ version: v.version, lane, items, excluded });
  }
  return out;
}

function run(ctx) {
  gradeFields(ctx);
  gradeDecisionLuck(ctx);
}

function gradeFields(ctx) {
  const specs = listGraded();
  if (!specs.length) return;
  const reads = new Map(specs.map(g => [g.field, ctx.read.graded(g.field)]));
  const predictionRows = [...reads.values()].flatMap(r => r.rows);
  if (!predictionRows.length) return;
  const outcomes = latestOutcomes(ctx, predictionRows);
  const results = new Map(); // `${producer}@${version}` -> {field -> {lane, items, excluded}}
  const activeItems = new Map(); // field -> items of its active version (for vs_fallback and vs_incumbent)
  const activeVersions = new Map(); // field -> its active version
  for (const g of specs) {
    const read = reads.get(g.field);
    if (!read.producer) continue;
    for (const r of gradeField(ctx, g, read, outcomes)) {
      const key = `${read.producer}@${r.version}`;
      if (!r.items.length && !Object.values(r.excluded).some(n => n > 0)) continue;
      if (!results.has(key)) results.set(key, new Map());
      results.get(key).set(g.field, r);
      if (r.lane === 'live') { activeItems.set(g.field, r.items); activeVersions.set(g.field, r.version); }
    }
  }
  const allItems = [...results.values()].flatMap(m => [...m.values()].flatMap(r => r.items));
  if (!allItems.length && !results.size) return;
  const season = allItems.length ? Math.max(...allItems.map(i => i.season)) : null;
  const inSeason = items => items.filter(i => i.season === season);
  const week = allItems.length ? Math.max(...allItems.filter(i => i.season === season).map(i => Number(i.week.split(':')[1]))) : null;
  const inWeek = items => inSeason(items).filter(i => i.week === `${season}:${week}`);

  for (const [entity, fields] of [...results].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const stdByField = {}; const weekByField = {};
    for (const [field, r] of [...fields].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const g = graded.get(field);
      const std = summarise(g, r.lane, inSeason(r.items), r.excluded);
      const fb = fieldSpec(field)?.fallbackField;
      if (fb && activeItems.has(fb)) {
        const theirs = new Map(inSeason(activeItems.get(fb)).map(i => [i.entity_id.split(':').slice(0, 3).join(':'), i.primary]));
        const deltas = inSeason(r.items).map(i => {
          const other = theirs.get(i.entity_id.split(':').slice(0, 3).join(':'));
          return other == null ? null : i.primary - other;
        }).filter(d => d != null);
        std.vs_fallback = { field: fb, n_pairs: deltas.length, delta_mean: r6(mean(deltas)),
          sign: 'this minus the fallback, in the primary score; negative favours this version' };
      }
      if (r.lane === 'shadow' && activeItems.has(field)) {
        const cmp = pairedVsIncumbent(inSeason(r.items), inSeason(activeItems.get(field)));
        if (cmp) {
          std.vs_incumbent = { version: activeVersions.get(field) ?? null, ...cmp, delta_mean: r6(cmp.delta_mean),
            interval: { ...cmp.interval, lo: r6(cmp.interval.lo), hi: r6(cmp.interval.hi) } };
        }
      }
      stdByField[field] = std;
      const wItems = inWeek(r.items);
      weekByField[field] = { ...summarise(g, r.lane, wItems, {}),
        graded: wItems.map(i => ({ entity_id: i.entity_id, state_id: i.state_id, outcome_event_id: i.outcome_event_id })) };
    }
    const text = n => `${n} predictions graded against their outcomes at each one's decision time`;
    const nStd = Object.values(stdByField).reduce((s, f) => s + f.n, 0);
    ctx.write(WRITERS['grade.season_to_date'], { entityType: 'producer', entityId: entity, field: 'grade.season_to_date',
      value: { season, by_field: stdByField },
      reasonChain: { contributions: [{ source: 'outcome.player_week', kind: 'event', event_ids: [], delta: null, text: text(nStd) }] } });
    if (week != null) {
      const nWeek = Object.values(weekByField).reduce((s, f) => s + f.n, 0);
      ctx.write(WRITERS['grade.week'], { entityType: 'producer', entityId: entity, field: 'grade.week',
        value: { season, week, by_field: weekByField },
        reasonChain: { contributions: [{ source: 'outcome.player_week', kind: 'event', event_ids: [], delta: null, text: text(nWeek) }] } });
    }
  }
}

/**
 * Decision vs luck (§7.3): offers and recs, each graded with inputs in force at its decision
 * time only (grade/decision-luck.js). One grade.decision_luck row per stream; a stream with
 * nothing settled writes nothing, one whose decisions were all excluded writes its reasons.
 */
function gradeDecisionLuck(ctx) {
  const from = lookbackFrom(ctx);
  const offers = ctx.read.events({ types: ['offer.sent'], from });
  const made = ctx.read.events({ types: ['rec.shown', 'rec.considered'], from });
  const settled = ctx.read.events({ types: ['rec.graded'], from });
  const streams = {};
  if (offers.length) {
    const pids = new Set();
    for (const o of offers) {
      for (const x of [...(o.payload.give ?? []), ...(o.payload.get ?? [])]) {
        const pid = Number(typeof x === 'object' && x ? x.id : x);
        if (pid > 0) pids.add(pid);
      }
    }
    const settings = ctx.read.events({ types: ['league.settings'] });
    const values = pids.size ? eventsForPlayers(ctx, ['market.player_value'], pids) : [];
    Object.assign(streams, offerSplits(offers, settings, values));
  }
  if (made.length && settled.length) Object.assign(streams, recSplits(made, settled));
  for (const [entity, split] of Object.entries(streams).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const value = summariseSplit(split);
    ctx.write(WRITERS['grade.decision_luck'], { entityType: 'producer', entityId: entity, field: 'grade.decision_luck', value,
      reasonChain: { contributions: [{ source: entity.split('@')[0], kind: 'event', event_ids: [], delta: null,
        text: `${value.n} decisions split into decision (inputs in force at decision time) and luck` }] } });
  }
}

export const graderProducer = Object.freeze({ name: 'grader', run });
