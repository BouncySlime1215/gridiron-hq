/**
 * `monitor`: freshness, health and drift of every engine field, and the automatic fallback
 * (ENGINE-ARCHITECTURE.md §7.4; ENGINE-SPECS.md "EA-05 monitor + fallback", run as cloud
 * unit EA-06; ENGINE-00b-b RED (2)-(5)). HEALTH-01 rows for the Number health card (#237).
 *
 * One row per field: `health.monitor` on entity `engine_field` `<field>`, global. Per field:
 *   freshness  (fields with maxAgeSec) per league: the later of the newest live row's as_of
 *              and the producer's last good run (fields.freshAt); older than maxAgeSec at the
 *              tick = stale. Stale raises a card row; it never switches what is served.
 *   failed     entities whose newest live row failed its checks (HEALTH-01a). getState
 *              already serves the last good row; the card says so.
 *   drift      (fields with a fallbackField) the grader's weekly paired difference, live
 *              version minus fallback field, in the primary score (a loss: positive = live
 *              worse), one observation per graded week (a week is one cluster). One anytime-
 *              valid confidence sequence on those weeks (stats/confseq.js).
 *
 * THE RULE (pre-registered in docs/evidence/2026-09-24/monitor-preregistration.md):
 *   fall back   when the cluster floor is met (>= 4 graded weeks and >= 20 distinct players)
 *               and the sequence's lower bound is above 0 (live worse than its fallback);
 *   recover     when a FRESH window (weeks graded after the flip only) meets the floor and its
 *               upper bound is below 0 (live better): hysteresis, so it never flip-flops;
 *   alpha       min(0.10, 1 / monitored fields): one expected false flip per season across
 *               every field together (the system budget);
 *   variance    the larger of 2 x the median within-week variance of the weekly mean
 *               (sd^2 / n_pairs) and the cross-week sample variance of the weekly deltas.
 * A promoted version starts a new sequence: its weeks are its own.
 *
 * ON A FLIP the monitor writes the global engine_fallback row (fallback_field = the field's
 * fallbackField) and records `healthy_snapshot_id`, the newest snapshot published before the
 * field left 'ok'. served.js#readServed then serves the fallback field's row, or, when that
 * field has no row for the entity, the field's own row as of that snapshot. Recovery deletes
 * the engine_fallback row. Every flip changes the monitor row (append-only history) and the
 * card row; nothing degrades silently.
 * Only the live lane acts: a shadow monitor version writes its rows and touches nothing else.
 */
import { registerProducer } from '../registry.js';
import { confidenceSequence } from '../stats/confseq.js';

export const MONITOR_VERSION = 'ea06-1';
export const MONITOR_FIELD = 'health.monitor';
export const RULE = Object.freeze({ floorWeeks: 4, floorEntities: 20, flipsPerSeason: 1, alphaMax: 0.1, withinInflate: 2 });
export const CARD_PREFIX = 'engine:';

const WRITERS = registerProducer({
  name: 'monitor',
  active: MONITOR_VERSION,
  versions: { [MONITOR_VERSION]: { params: { rule: RULE } } },
  fields: [{ field: MONITOR_FIELD, valueType: 'object', entityTypes: ['engine_field'],
    replaces: ['ENGINE-00b-b drift monitor (never built)'],
    description: 'Freshness, failed rows and drift vs the fallback field of one engine field; the fallback in force' }],
  inputs: { events: [], fields: ['grade.week', 'grade.season_to_date', MONITOR_FIELD], monitor: true, scope: 'global',
    schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});

/** Each field's error level under the system budget of one expected false flip per season. */
export function alphaFor(monitoredFields) {
  return Math.min(RULE.alphaMax, RULE.flipsPerSeason / Math.max(1, monitoredFields));
}

const order = key => { const [s, w] = String(key).split(':').map(Number); return s * 100 + w; };
const r6 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(6));
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** The variance the sequence assumes for these weeks (see THE RULE), or null with fewer than one usable number. */
export function priorVarOf(weeks) {
  const within = weeks.filter(w => w.sd != null && w.n > 1).map(w => (w.sd * w.sd) / w.n);
  const ds = weeks.map(w => w.d);
  const m = ds.reduce((a, b) => a + b, 0) / (ds.length || 1);
  const cross = ds.length > 1 ? ds.reduce((s, d) => s + (d - m) ** 2, 0) / (ds.length - 1) : null;
  const candidates = [within.length ? RULE.withinInflate * median(within) : null, cross].filter(v => v != null && v > 0);
  return candidates.length ? Math.max(...candidates) : null;
}

function sequence(weeks, alpha) {
  if (!weeks.length) return null;
  const priorVar = priorVarOf(weeks);
  if (priorVar == null) return { n: weeks.length, mean: null, lower: null, upper: null, reason: 'no variance yet' };
  const cs = confidenceSequence(weeks.map(w => w.d), { alpha, priorVar });
  return { n: cs.n, mean: r6(cs.mean), lower: r6(cs.lower), upper: r6(cs.upper), prior_var: r6(priorVar) };
}

/**
 * One drift decision. `weeks` [{key 'season:week', d, n, entities, sd}], `prev` {status, flipped_after},
 * `seasonEntities` the distinct players paired this season (grade.season_to_date), when known.
 * Returns {state: {status, flipped_after}, flip: 'fallback' | 'recovered' | null, cs, fresh, floor}.
 */
export function decideDrift({ weeks, prev = { status: 'ok' }, alpha, seasonEntities = null }) {
  const sorted = [...weeks].sort((a, b) => order(a.key) - order(b.key));
  const status = prev?.status === 'fallback' ? 'fallback' : 'ok';
  const flippedAfter = status === 'fallback' ? prev.flipped_after ?? null : null;
  const maxEntities = ws => ws.reduce((m, w) => Math.max(m, w.entities ?? 0), 0);
  const floorOf = (ws, entities) => ({ weeks: ws.length, entities, met: ws.length >= RULE.floorWeeks && entities >= RULE.floorEntities });

  const cs = sequence(sorted, alpha);
  const floor = floorOf(sorted, seasonEntities ?? maxEntities(sorted));
  if (status === 'ok') {
    if (floor.met && cs?.lower != null && cs.lower > 0) {
      return { state: { status: 'fallback', flipped_after: sorted.at(-1).key }, flip: 'fallback', cs, fresh: null, floor };
    }
    return { state: { status: 'ok', flipped_after: null }, flip: null, cs, fresh: null, floor };
  }
  const freshWeeks = sorted.filter(w => flippedAfter == null || order(w.key) > order(flippedAfter));
  const fresh = sequence(freshWeeks, alpha);
  const freshFloor = floorOf(freshWeeks, maxEntities(freshWeeks));
  if (freshFloor.met && fresh?.upper != null && fresh.upper < 0) {
    return { state: { status: 'ok', flipped_after: null }, flip: 'recovered', cs, fresh: { ...fresh, floor: freshFloor }, floor };
  }
  return { state: { status: 'fallback', flipped_after: flippedAfter }, flip: null, cs,
    fresh: fresh ? { ...fresh, floor: freshFloor } : { n: 0, floor: freshFloor }, floor };
}

/** The grader's live weekly pairs per field, from grade.week rows of each producer's active version. */
function weeklyObservations(gradeRows, activeEntity) {
  const out = new Map(); // field -> [{key, d, n, entities, sd}]
  for (const r of gradeRows ?? []) {
    const v = r.value;
    if (!v?.by_field || v.season == null || v.week == null) continue;
    for (const [field, f] of Object.entries(v.by_field)) {
      const p = f?.vs_fallback;
      if (f?.lane !== 'live' || !p || !(p.n_pairs > 0) || p.delta_mean == null) continue;
      if (activeEntity(field) !== r.entity_id) continue;
      if (!out.has(field)) out.set(field, []);
      out.get(field).push({ key: `${v.season}:${v.week}`, d: p.delta_mean, n: p.n_pairs, entities: p.entities ?? 0, sd: p.delta_sd ?? null });
    }
  }
  return out;
}

function seasonEntitiesOf(seasonRows, activeEntity) {
  const out = new Map();
  for (const r of seasonRows ?? []) {
    for (const [field, f] of Object.entries(r.value?.by_field ?? {})) {
      if (f?.lane === 'live' && f.vs_fallback?.entities != null && activeEntity(field) === r.entity_id) out.set(field, f.vs_fallback.entities);
    }
  }
  return out;
}

const ageText = ms => { const m = Math.round(ms / 60000); return m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m} min`; };
const CARD_STATUS = { ok: 'ok', stale: 'warn', failed: 'broken', fallback: 'broken' };

/** The Number health card row (#237's number_audit shape) for one field in one league. */
export function cardRow(field, m, leagueStatus, asOf) {
  const base = { check_id: `${CARD_PREFIX}${field}`, inventory_row: 'HEALTH-01', status: CARD_STATUS[leagueStatus],
    pages_affected: [], values: { field, status: leagueStatus, drift: m.drift?.cs ?? null, failed_rows: m.failed_rows } };
  if (leagueStatus === 'fallback') {
    const f = m.fallback;
    return { ...base, title: `Engine number "${field}" fell back`,
      detail: `${f.reason}. Serving ${f.field} since ${f.since}${m.healthy_snapshot_id != null
        ? `; where ${f.field} has no value, the last healthy snapshot (#${m.healthy_snapshot_id})` : ''}.`,
      cause: 'The live producer scored worse than its fallback on settled outcomes (drift monitor).',
      trust: `Trust the fallback (${f.field}) until a fresh ${RULE.floorWeeks}-week window shows the live producer better.` };
  }
  if (leagueStatus === 'failed') {
    return { ...base, title: `Engine number "${field}" failed its checks`,
      detail: `${m.failed_rows} ${m.failed_rows === 1 ? 'entity\'s' : 'entities\''} newest row failed a health check; the last good row is served.`,
      cause: 'A producer wrote a value that broke an invariant (HEALTH-01a).', trust: 'The last good value, labelled.' };
  }
  if (leagueStatus === 'stale') {
    const oldest = Object.values(m.freshness ?? {}).filter(x => x.status === 'stale')
      .map(x => (x.fresh_at == null ? null : x.fresh_at)).sort()[0];
    const age = oldest == null ? null : Date.parse(asOf) - Date.parse(oldest);
    return { ...base, title: `Engine number "${field}" is stale`,
      detail: `Last refreshed ${age == null ? 'never' : `${ageText(age)} ago`}; its max age is ${ageText(m.max_age_sec * 1000)}.`,
      cause: 'Its producer has not run successfully within the field\'s max age.', trust: 'The value shown, as of its time.' };
  }
  return { ...base, title: `Engine number "${field}" is healthy`, detail: 'Fresh, passing its checks, not on a fallback.',
    cause: null, trust: null };
}

/**
 * The monitor's run. `gradeRows` / `seasonRows` default to the newest grade.week /
 * grade.season_to_date rows per producer version (tests inject the grader's rows).
 */
export function runMonitor(ctx, { gradeRows = null, seasonRows = null } = {}) {
  if (!ctx.monitor) throw new Error('the monitor needs ctx.monitor (inputs.monitor: true)');
  const acting = ctx.lane === 'live';
  const specs = ctx.monitor.fields().filter(s => s && s.field !== MONITOR_FIELD);
  const bySpec = new Map(specs.map(s => [s.field, s]));
  const activeEntity = field => {
    const s = bySpec.get(field);
    const v = s ? ctx.monitor.activeVersion(s.producer) : null;
    return v ? `${s.producer}@${v}` : null;
  };
  const obs = weeklyObservations(gradeRows ?? ctx.read.latest('grade.week', { entityType: 'producer' }), activeEntity);
  const seasonEntities = seasonEntitiesOf(seasonRows ?? ctx.read.latest('grade.season_to_date', { entityType: 'producer' }), activeEntity);
  const alpha = alphaFor(specs.filter(s => s.fallbackField).length);
  const now = Date.parse(ctx.tick.as_of);
  const snapshotNow = ctx.monitor.latestSnapshotId();
  const leagues = acting ? ctx.monitor.leagues() : [];
  const summary = { fields: 0, flips: [], stale: [], failed: [] };

  for (const spec of specs) {
    const prev = ctx.read.state(MONITOR_FIELD, 'engine_field', spec.field)?.value ?? null;
    const version = ctx.monitor.activeVersion(spec.producer);
    const sameVersion = prev?.version === version;

    // drift
    let drift = null; let weeks = {};
    if (spec.fallbackField) {
      weeks = sameVersion ? { ...(prev?.weeks ?? {}) } : {};
      for (const w of obs.get(spec.field) ?? []) weeks[w.key] = { d: w.d, n: w.n, entities: w.entities, sd: w.sd };
      const prevDrift = prev?.drift?.status === 'fallback'
        ? { status: 'fallback', flipped_after: sameVersion ? prev.drift.flipped_after : null } : { status: 'ok' };
      drift = decideDrift({ weeks: Object.entries(weeks).map(([key, w]) => ({ key, ...w })), prev: prevDrift, alpha,
        seasonEntities: seasonEntities.get(spec.field) ?? null });
    }

    // freshness and failed rows
    const freshness = {}; let failedRows = 0;
    for (const l of ctx.monitor.latestByLeague(spec.field)) {
      failedRows += l.failed;
      if (spec.maxAgeSec == null) continue;
      const at = ctx.monitor.freshAt(spec.producer, l.league_id, l.latest_as_of);
      const st = at == null || now - Date.parse(at) > spec.maxAgeSec * 1000 ? 'stale' : 'ok';
      const was = prev?.freshness?.[l.league_id];
      // fresh_at only while stale: it is fixed until the producer runs again, so a stale field is not rewritten every tick
      freshness[l.league_id] = { status: st, since: was?.status === st ? was.since : ctx.tick.as_of,
        fresh_at: st === 'stale' ? at : null };
    }
    const anyStale = Object.values(freshness).some(f => f.status === 'stale');
    const status = drift?.state.status === 'fallback' ? 'fallback' : failedRows > 0 ? 'failed' : anyStale ? 'stale' : 'ok';
    const prevStatus = prev?.status ?? 'ok';
    const healthySnapshot = status === 'ok' ? null : prevStatus === 'ok' ? snapshotNow : prev?.healthy_snapshot_id ?? snapshotNow;

    // the fallback pointer
    let fallback = status === 'fallback' && sameVersion && prev?.fallback ? prev.fallback : null;
    if (drift?.flip === 'fallback' || (status === 'fallback' && !fallback)) {
      const nPairs = Object.values(weeks).reduce((s, w) => s + w.n, 0);
      const reason = `live ${spec.producer}@${version} scored worse than ${spec.fallbackField} on ${nPairs} paired outcomes over `
        + `${drift.cs.n} weeks: mean loss difference ${drift.cs.mean}, anytime ${Math.round((1 - alpha) * 1000) / 10}% `
        + `lower bound ${drift.cs.lower} > 0`;
      fallback = { target: 'field', field: spec.fallbackField, snapshot_id: healthySnapshot, since: ctx.tick.as_of, reason, n: nPairs };
    }
    if (acting && status === 'fallback' && !ctx.monitor.fallback(spec.field)) {
      ctx.monitor.setFallback({ field: spec.field, fallbackField: spec.fallbackField, reason: fallback.reason, n: fallback.n });
    }
    if (acting && drift?.flip === 'recovered') ctx.monitor.clearFallback(spec.field);
    if (drift?.flip) summary.flips.push({ field: spec.field, flip: drift.flip });

    const value = {
      status, since: status === prevStatus && prev ? prev.since : ctx.tick.as_of, version, producer: spec.producer,
      max_age_sec: spec.maxAgeSec, freshness, failed_rows: failedRows, healthy_snapshot_id: healthySnapshot, fallback,
      drift: drift ? { status: drift.state.status, flipped_after: drift.state.flipped_after, alpha: r6(alpha),
        fallback_field: spec.fallbackField, cs: drift.cs, fresh: drift.fresh, floor: drift.floor } : null,
      weeks: spec.fallbackField ? weeks : null,
    };
    const text = status === 'ok' ? 'healthy' : status === 'fallback' ? `fell back: ${fallback.reason}`
      : status === 'failed' ? `${failedRows} newest rows failed their checks` : 'older than its max age';
    ctx.write(WRITERS[MONITOR_FIELD], { entityType: 'engine_field', entityId: spec.field, field: MONITOR_FIELD, value,
      reasonChain: { contributions: [{ source: 'health_monitor', kind: 'monitor', event_ids: [], delta: null, text }] } });
    summary.fields += 1;
    if (status === 'stale') summary.stale.push(spec.field);
    if (status === 'failed') summary.failed.push(spec.field);

    // the Number health card: a row once a field is not ok, kept (turning ok) after that
    if (acting && (status !== 'ok' || ctx.monitor.cardHas(`${CARD_PREFIX}${spec.field}`))) {
      for (const league of leagues) {
        const ls = status === 'stale' && !(freshness[league]?.status === 'stale' || freshness[0]?.status === 'stale') ? 'ok' : status;
        ctx.monitor.writeCard(league, [cardRow(spec.field, value, ls, ctx.tick.as_of)]);
      }
    }
  }
  return summary;
}

export const monitorProducer = Object.freeze({ name: 'monitor', run: ctx => { runMonitor(ctx); } });
