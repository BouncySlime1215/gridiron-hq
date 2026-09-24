/**
 * `grader`: the one producer that scores predictions against outcomes
 * (ENGINE-ARCHITECTURE.md D9, §3.7, §7.2; run as cloud unit EA-05).
 *
 * A field is graded once something registers it here (`registerGraded`), with its kind:
 *   dist   quantile forecast {levels, values} (or {quantiles: {level: value}}) scored on
 *          the outcome's points: quantile score, CRPS approximation, 80% coverage, PIT
 *   prob   probability (a number, or {p}) scored on `truth(outcome payload)` in {0, 1}:
 *          log loss, Brier, calibration slope/intercept
 * Outcomes today are `outcome.player_week` (adapters/outcomes.js); a graded row's entity is
 * `player_week_scored` `<player>:<season>:<week>:<scoring_key>`. Decisions (lineup.call,
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
 *   grade.week            the same for the latest graded week (vs_fallback per week too),
 *                          plus `graded`: every
 *                          (entity_id, state_id, outcome_event_id) it scored (the audit)
 * Labels: `forward` (season >= 2026) or `test` (earlier seasons). `fit` cannot occur: a
 * row whose training window reaches its decision time is excluded, not labelled.
 * Floors (clusterFloor): >= 4 distinct weeks and >= 20 distinct players.
 * Write-on-change: a tick with no new outcome and no new prediction writes nothing.
 * Coordination: EVAL-01's `brain_report` (#235) and IDEA-001's `served_numbers` (#243) are
 * read by neither side yet; GRADE_TO_EVAL_CHECK names which grade row feeds which check.
 */
import crypto from 'node:crypto';
import { registerProducer, fieldSpec } from '../registry.js';
import { quantileScore, pitFromQuantiles, inInterval, logLoss, brier, calibration, ksUniform, clusterFloor, mean }
  from '../grade/scorers.js';

export const GRADER_VERSION = 'ea05-1';
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
  ],
  inputs: { events: ['outcome.player_week'], fields: [], grades: true, scope: 'global', schedule: 'tick', cost: 'cheap',
    budget_ms: 60000 },
});

const graded = new Map();

/** Grade `field` from now on. kind 'dist' | 'prob'; a prob field needs truth(payload) -> 0 | 1. */
export function registerGraded(field, { kind, truth = null, decisionTime = null } = {}) {
  if (!['dist', 'prob'].includes(kind)) throw new Error(`graded field ${field}: kind must be dist or prob`);
  if (kind === 'prob' && typeof truth !== 'function') throw new Error(`graded field ${field}: a prob field needs truth(payload)`);
  const spec = fieldSpec(field);
  if (spec && spec.valueType !== kind) throw new Error(`graded field ${field} is valueType ${spec.valueType}, not ${kind}`);
  if (graded.has(field)) return graded.get(field);
  const g = Object.freeze({ field, kind, truth, decisionTime });
  graded.set(field, g);
  return g;
}

export const listGraded = () => [...graded.values()];

const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const r6 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(6));
const baseKey = p => `${p.player_id}:${p.season}:${p.week}:${p.scoring_key}`;

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

/** The latest outcome per (player, season, week, scoring key), for the players that have predictions. */
function latestOutcomes(ctx, playerIds) {
  const from = new Date(Date.parse(ctx.tick.as_of) - LOOKBACK_DAYS * 86400000).toISOString();
  const latest = new Map();
  const ids = [...playerIds].sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i += PLAYER_CHUNK) {
    const entities = ids.slice(i, i + PLAYER_CHUNK).map(p => `player:${p}`);
    for (const e of ctx.read.events({ types: ['outcome.player_week'], from, entities })) {
      const k = baseKey(e.payload);
      if (!latest.has(k) || latest.get(k).id < e.id) latest.set(k, e);
    }
  }
  return latest;
}

/** Score one prediction row against one outcome. Returns the item, or a reason it cannot be scored. */
function scoreItem(g, pred, outcome) {
  const p = outcome.payload;
  const base = { entity_id: pred.entity_id, state_id: pred.id, outcome_event_id: outcome.id,
    week: `${p.season}:${p.week}`, entity: String(p.player_id), season: p.season };
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

/**
 * This version against the fallback field on the same outcomes: one pair per base key
 * (player:season:week) both scored. Deltas are this minus the fallback in the primary
 * score (a loss), so a positive mean says this version is worse. `entities` counts
 * distinct players in the pairs (the cluster floor's second count; EA-06 monitor reads it).
 */
export function pairedVsFallback(items, fallbackItems, fallbackField) {
  const base = i => i.entity_id.split(':').slice(0, 3).join(':');
  const theirs = new Map(fallbackItems.map(i => [base(i), i.primary]));
  const deltas = []; const players = new Set();
  for (const i of items) {
    const other = theirs.get(base(i));
    if (other == null) continue;
    deltas.push(i.primary - other);
    players.add(i.entity ?? i.entity_id.split(':')[0]);
  }
  const m = mean(deltas);
  const sd = deltas.length > 1 ? Math.sqrt(deltas.reduce((s, d) => s + (d - m) ** 2, 0) / (deltas.length - 1)) : null;
  return { field: fallbackField, n_pairs: deltas.length, entities: players.size, delta_mean: r6(m), delta_sd: r6(sd),
    sign: 'this minus the fallback, in the primary score; negative favours this version' };
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
function gradeField(ctx, g, read, outcomes) {
  const out = [];
  for (const v of read.versions) {
    if (v.status !== 'active' && v.status !== 'shadow') continue;
    const lane = v.status === 'active' ? 'live' : 'shadow';
    const byEntity = new Map();
    for (const r of read.rows) {
      if (r.producer_version !== v.version || r.entity_type !== 'player_week_scored') continue;
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
      const T = g.decisionTime ? g.decisionTime(p) : p.kickoff;
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
  const specs = listGraded();
  if (!specs.length) return;
  const reads = new Map(specs.map(g => [g.field, ctx.read.graded(g.field)]));
  const players = new Set();
  for (const r of reads.values()) {
    for (const row of r.rows) if (row.entity_type === 'player_week_scored') players.add(Number(row.entity_id.split(':')[0]));
  }
  if (!players.size) return;
  const outcomes = latestOutcomes(ctx, players);
  const results = new Map(); // `${producer}@${version}` -> {field -> {lane, items, excluded}}
  const activeItems = new Map(); // field -> items of its active version (for vs_fallback)
  for (const g of specs) {
    const read = reads.get(g.field);
    if (!read.producer) continue;
    for (const r of gradeField(ctx, g, read, outcomes)) {
      const key = `${read.producer}@${r.version}`;
      if (!r.items.length && !Object.values(r.excluded).some(n => n > 0)) continue;
      if (!results.has(key)) results.set(key, new Map());
      results.get(key).set(g.field, r);
      if (r.lane === 'live') activeItems.set(g.field, r.items);
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
      const fbItems = fb && activeItems.has(fb) ? activeItems.get(fb) : null;
      if (fbItems) std.vs_fallback = pairedVsFallback(inSeason(r.items), inSeason(fbItems), fb);
      stdByField[field] = std;
      const wItems = inWeek(r.items);
      weekByField[field] = { ...summarise(g, r.lane, wItems, {}),
        ...(fbItems ? { vs_fallback: pairedVsFallback(wItems, inWeek(fbItems), fb) } : {}),
        graded: wItems.map(i => ({ entity_id: i.entity_id, state_id: i.state_id, outcome_event_id: i.outcome_event_id })) };
    }
    const text = n => `${n} predictions graded against outcome.player_week at each one's decision time`;
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

export const graderProducer = Object.freeze({ name: 'grader', run });
