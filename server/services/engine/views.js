/**
 * Views at a snapshot (ENGINE-ARCHITECTURE.md §2.7, §2.12, §3.5, §4.6; EA-03 row; HEALTH-01b).
 *
 * A view is data: a name and a fixed list of (entity, field) rows. `entity` is a template
 * filled from the snapshot ({season}, {week}, {league_id}); `each` enumerates every entity
 * of a type with a row of the field at the cut whose id starts with a prefix (the week's
 * games). Nothing here computes a number: pages and Coach read rows as the engine wrote
 * them, so the "no arithmetic on engine values" check has one file of declarations.
 *
 * Resolution of one (entity, field) at snapshot S (§4.6):
 *   - S.fallback_set names a fallback for the field -> the fallback field's row, `fallback`;
 *   - else the latest row with producer_version = S.version_set[producer], lane live and
 *     id <= S.max_state_id;
 *   - HEALTH-01b: if that row failed its checks or is degraded, the ONE fallback rule
 *     (state.js#readServed, #250; RULINGS 3) decides, pinned to the snapshot's cut and
 *     versions: the field's declared fallback field (`fallback`), else its last healthy
 *     row (`last_good`, "last good, N min old"), else a degraded row labelled or `unknown`.
 *     A failed value is never served;
 *   - otherwise the typed status of rowStatus, with freshness from engine_runs at S's time;
 *   - a template the snapshot cannot fill (no NFL week once every game is final) is a row
 *     typed unknown ("snapshot N has no week"), never a read at week "null".
 * Every row carries producer@version, as_of, status, reason, health and its reason chain.
 * Older snapshots resolve by the same query with their own cut, versions and fallbacks.
 *
 * `pinSnapshot` is the Coach path: one snapshot per answer, every view it reads at that id.
 * This module only reads; it imports nothing from engine/daemon/.
 */
import { db as appDb } from '../../db/index.js';
import { getState, isLeagueScoped, readServed } from './state.js';
import { readFieldSpec, freshAt } from './fields.js';
import { rowStatus, minutesBetween } from './status.js';

export const VIEWS = Object.freeze({
  week: Object.freeze({
    name: 'week', scope: 'global',
    description: 'the NFL week and its games: kickoff cutoffs and game scripts',
    rows: Object.freeze([
      { entity: 'week:{season}:{week}', field: 'nfl.week' },
      { each: 'game', prefix: '{season}:{week}:', field: 'game.cutoff' },
      { each: 'game', prefix: '{season}:{week}:', field: 'game.script' },
    ]),
  }),
  league_week: Object.freeze({
    name: 'league_week', scope: 'league',
    description: 'the league\'s matchup period beside the NFL week',
    rows: Object.freeze([
      { entity: 'week:{season}:{week}', field: 'nfl.week' },
      { entity: 'league:{league_id}', field: 'league.week' },
    ]),
  }),
});

const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

function parseSnapshot(r) {
  if (!r) return null;
  return {
    id: Number(r.id), league_id: Number(r.league_id), tick_id: r.tick_id,
    max_event_id: Number(r.max_event_id), max_state_id: Number(r.max_state_id),
    version_set: JSON.parse(r.version_set), fallback_set: JSON.parse(r.fallback_set),
    season: r.season, nfl_week: r.nfl_week, world: r.world, created_at: r.created_at,
  };
}

export function snapshotById(id, database = appDb) {
  return parseSnapshot(database.prepare('SELECT * FROM engine_snapshots WHERE id = ?').get(Number(id)));
}

/** The newest snapshot for a league (0 = global), or null when none was ever published. */
export function latestSnapshotFor(leagueId, database = appDb) {
  return parseSnapshot(database.prepare('SELECT * FROM engine_snapshots WHERE league_id = ? ORDER BY id DESC LIMIT 1')
    .get(Number(leagueId ?? 0)));
}

/** The /snapshot answer body for one snapshot. */
export function snapshotOut(s, now = Date.now()) {
  return {
    id: s.id, league_id: s.league_id, tick_id: s.tick_id,
    cut: { max_event_id: s.max_event_id, max_state_id: s.max_state_id },
    version_set: s.version_set, fallback_set: s.fallback_set,
    season: s.season, nfl_week: s.nfl_week, world: s.world, created_at: s.created_at,
    age_sec: Math.max(0, Math.round((now - Date.parse(s.created_at)) / 1000)),
  };
}

/** Fill a template from the snapshot, or return {missing} naming what the snapshot lacks. */
function fill(template, snapshot, leagueId) {
  let missing = null;
  const text = template.replace(/\{(season|week|league_id)\}/g, (_, k) => {
    const v = k === 'season' ? snapshot.season : k === 'week' ? snapshot.nfl_week : leagueId;
    if (v == null) missing = missing ?? k;
    return String(v);
  });
  return missing ? { missing } : { text };
}

/** The (entity_type, entity_id, field) keys a view declares, expanded at the snapshot. */
function expand(view, snapshot, leagueId, database) {
  const out = [];
  for (const r of view.rows) {
    if (r.entity) {
      const f = fill(r.entity, snapshot, leagueId);
      if (f.missing) {
        const type = r.entity.slice(0, r.entity.indexOf(':'));
        out.push({ entityType: type, entityId: r.entity.slice(type.length + 1), field: r.field, missing: f.missing });
        continue;
      }
      const cut = f.text.indexOf(':');
      out.push({ entityType: f.text.slice(0, cut), entityId: f.text.slice(cut + 1), field: r.field });
      continue;
    }
    const f = fill(r.prefix ?? '', snapshot, leagueId);
    if (f.missing) {
      out.push({ entityType: r.each, entityId: `${r.prefix ?? ''}*`, field: r.field, missing: f.missing });
      continue;
    }
    const prefix = f.text;
    const league = isLeagueScoped(r.each) ? Number(leagueId ?? 0) : 0;
    const ids = database.prepare(`SELECT DISTINCT entity_id FROM engine_state WHERE entity_type = ? AND field = ?
        AND league_id = ? AND id <= ? AND substr(entity_id, 1, ?) = ? ORDER BY entity_id`)
      .all(r.each, r.field, league, snapshot.max_state_id, prefix.length, prefix).map(x => x.entity_id);
    for (const entityId of ids) out.push({ entityType: r.each, entityId, field: r.field });
  }
  return out;
}

/**
 * Per-resolution memo: a view reads the same few field specs and producer run times for
 * every row, so each is looked up once per call. Nothing outlives the call.
 */
function makeLookup(snapshot, database) {
  const specs = new Map();
  const runs = new Map();
  return {
    spec(field) {
      if (!specs.has(field)) specs.set(field, readFieldSpec(field, database));
      return specs.get(field);
    },
    /** fresh_at: the later of the row's as_of and the producer's last good run before the snapshot. */
    fresh(producer, leagueId, rowAsOf) {
      const k = `${producer}|${leagueId}`;
      if (!runs.has(k)) runs.set(k, freshAt({ producer, leagueId, rowAsOf: null, ref: snapshot.created_at }, database));
      const run = runs.get(k);
      return [rowAsOf, run].filter(Boolean).sort().at(-1) ?? null;
    },
  };
}

function served(row, extra) {
  return {
    entity_type: extra.entityType, entity_id: extra.entityId, league_id: extra.leagueId, field: extra.field,
    status: extra.status, reason: extra.reason ?? null, value: row ? row.value : null,
    fallback_used: extra.fallbackUsed ?? false, fallback_field: extra.fallbackField ?? null,
    age_min: extra.ageMin ?? null,
    producer: row?.producer ?? null, producer_version: row?.producer_version ?? null, as_of: row?.as_of ?? null,
    health: row?.health ?? null, reason_chain: row?.reason_chain ?? null, event_ids: row?.event_ids ?? [],
    fresh_at: extra.freshAt ?? null, state_id: row?.id ?? null,
  };
}

/** The row of `field` at the snapshot's cut and version, or null ('failed' rows included when asked). */
function rowAtCut(key, field, spec, snapshot, { includeFailed = false } = {}, database) {
  const version = snapshot.version_set[spec.producer];
  if (version == null) return { missingVersion: true };
  const row = getState(key.entityType, key.entityId, field, { asOf: FAR_FUTURE, leagueId: key.leagueId, lane: 'live',
    version, maxId: snapshot.max_state_id, includeFailed }, database);
  return { row };
}

/** The fallback reason the monitor recorded, when the same fallback is still in force; else a plain one. */
function fallbackReason(field, fallbackField, leagueId, snapshot, database) {
  const r = database.prepare(`SELECT reason FROM engine_fallback WHERE field = ? AND fallback_field = ? AND league_id IN (?, 0)
      ORDER BY league_id DESC LIMIT 1`).get(field, fallbackField, Number(leagueId ?? 0));
  return `${field} is on its fallback ${fallbackField}: ${r?.reason ?? `in force at snapshot ${snapshot.id}`}`;
}

function serveFallback(key, field, fallbackField, reason, snapshot, look, database) {
  const spec = look.spec(fallbackField);
  const base = { ...key, field, fallbackUsed: true, fallbackField };
  if (!spec) return served(null, { ...base, status: 'unknown', reason: `${reason}; ${fallbackField} is not registered` });
  const { row, missingVersion } = rowAtCut(key, fallbackField, spec, snapshot, {}, database);
  if (missingVersion) return served(null, { ...base, status: 'unknown', reason: `${reason}; ${spec.producer} is not in snapshot ${snapshot.id}` });
  if (!row) return served(null, { ...base, status: 'unknown', reason: `${reason}; ${fallbackField} has no row at the snapshot` });
  return served(row, { ...base, status: 'fallback', reason, freshAt: look.fresh(row.producer, key.leagueId, row.as_of) });
}

/** Resolve one (entity, field) at a snapshot (§4.6 + HEALTH-01b). */
export function resolveRow({ entityType, entityId, field }, snapshot, leagueId, database = appDb,
  look = makeLookup(snapshot, database)) {
  const key = { entityType, entityId, leagueId: isLeagueScoped(entityType) ? Number(leagueId) : 0 };
  const spec = look.spec(field);
  if (!spec) return served(null, { ...key, field, status: 'unknown', reason: 'field_not_registered' });
  const monitorFallback = snapshot.fallback_set[field];
  if (monitorFallback) {
    return serveFallback(key, field, monitorFallback,
      fallbackReason(field, monitorFallback, snapshot.league_id, snapshot, database), snapshot, look, database);
  }
  if (snapshot.version_set[spec.producer] == null) {
    return served(null, { ...key, field, status: 'unknown', reason: `producer_not_in_snapshot: ${spec.producer}` });
  }
  // RULINGS 3: the one last-good / fallback rule is the engine spine's (state.js#readServed,
  // #250), read at this snapshot's cut and versions. This module maps its answer to a view row.
  const versionFor = f => { const s = look.spec(f); return s ? snapshot.version_set[s.producer] ?? null : null; };
  const rs = readServed(key.entityType, key.entityId, field, { asOf: FAR_FUTURE, leagueId: key.leagueId, lane: 'live',
    pin: { maxId: snapshot.max_state_id, versionFor } }, database);
  if (rs.status === 'unknown') {
    return served(null, { ...key, field, status: 'unknown', reason: rs.reason === 'no_row_as_of' ? 'no_row_at_snapshot' : rs.reason });
  }
  if (rs.status === 'failed') return served(null, { ...key, field, status: 'unknown', reason: rs.reason });
  if (rs.status === 'fallback' && rs.fallback.kind === 'field') {
    return served(rs.row, { ...key, field, status: 'fallback', fallbackUsed: true, fallbackField: rs.fallback.field,
      reason: rs.reason, freshAt: look.fresh(rs.row.producer, key.leagueId, rs.row.as_of) });
  }
  if (rs.status === 'fallback') {
    const age = minutesBetween(rs.row.as_of, snapshot.created_at);
    return served(rs.row, { ...key, field, status: 'last_good', fallbackUsed: true, ageMin: age,
      reason: `${rs.reason}; last good, ${age} min old`, freshAt: rs.row.as_of });
  }
  // ok, or degraded with nothing healthy to fall back to: served as itself, typed by rowStatus.
  const latest = rs.row;
  const fresh = look.fresh(latest.producer, key.leagueId, latest.as_of);
  const [status, reason] = rowStatus(latest, spec, fresh, snapshot.created_at);
  return served(latest, { ...key, field, status, reason, freshAt: fresh,
    ageMin: status === 'stale' ? minutesBetween(fresh ?? latest.as_of, snapshot.created_at) : null });
}

/** Resolve every row of a view at one snapshot. `view` is a declaration (VIEWS[name]). */
export function resolveView({ view, snapshot, leagueId = null }, database = appDb) {
  const look = makeLookup(snapshot, database);
  const rows = expand(view, snapshot, leagueId, database).map(k => (k.missing
    // e.g. no current NFL week once every game is final: the row is typed, never read at week "null".
    ? served(null, { entityType: k.entityType, entityId: k.entityId, leagueId: isLeagueScoped(k.entityType) ? Number(leagueId) : 0,
      field: k.field, status: 'unknown', reason: `snapshot ${snapshot.id} has no ${k.missing}` })
    : resolveRow(k, snapshot, leagueId, database, look)));
  return { view: view.name, snapshot_id: snapshot.id, league_id: leagueId == null ? null : Number(leagueId), rows };
}

/**
 * Pin one snapshot for a whole Coach answer (or any multi-view read): every view read
 * through the session resolves at the same id, even if the daemon publishes a newer one
 * meanwhile. Pins the league's newest snapshot unless `snapshotId` names one.
 */
export function pinSnapshot({ leagueId = null, snapshotId = null } = {}, database = appDb) {
  const snapshot = snapshotId != null ? snapshotById(snapshotId, database) : latestSnapshotFor(leagueId ?? 0, database);
  if (!snapshot) throw new Error(`no engine snapshot for league ${leagueId ?? 0}`);
  return {
    snapshot,
    view(name) {
      const v = VIEWS[name];
      if (!v) throw new Error(`unknown view "${name}"`);
      return resolveView({ view: v, snapshot, leagueId }, database);
    },
  };
}
