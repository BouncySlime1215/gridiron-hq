/**
 * `ctx.monitor`: what the monitor producer may read and write beyond its own field
 * (ENGINE-ARCHITECTURE.md §7.4; cloud unit EA-06). Only a producer declaring
 * `inputs.monitor: true` gets it (daemon/context.js), the same way only the grader gets
 * `ctx.read.graded`: the monitor watches every field, so it cannot declare them one by one.
 *
 *   fields()                    every stored field spec (engine_fields), this process's or not
 *   activeVersion(producer)     the producer's active version (engine_producers), or null
 *   latestByLeague(field)       per league: live rows of the active version (latest per entity,
 *                               failed rows included), how many of those failed, the latest as_of
 *   freshAt(producer, leagueId, rowAsOf)   fields.freshAt at the tick
 *   latestSnapshotId()          the newest snapshot published at or before the tick, or null
 *   fallback(field)             the global engine_fallback row in force, or null
 *   setFallback / clearFallback the engine_fallback writers (fields.js), global rows
 *   leagues()                   the leagues the Number health card can be opened on
 *   writeCard(leagueId, rows)   upsert HEALTH-01 rows into number_audit (#237) when that
 *                               table exists; returns false when it does not
 * Every read is cut at the tick's input cut, like ctx.read.
 */
import { readFieldSpec, freshAt, readFallback, setFallback, clearFallback } from '../fields.js';
import { producerSpec } from '../registry.js';

const tableExists = (database, name) => !!database.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function makeMonitorAccess({ database, tick, cut }) {
  const activeVersion = producer => database.prepare(`SELECT version FROM engine_producers
      WHERE producer = ? AND status = 'active' ORDER BY registered_at DESC LIMIT 1`).get(producer)?.version
    ?? producerSpec(producer)?.active ?? null;

  return Object.freeze({
    fields() {
      return database.prepare('SELECT field FROM engine_fields ORDER BY field').all().map(r => readFieldSpec(r.field, database));
    },
    activeVersion,
    latestByLeague(field) {
      const spec = readFieldSpec(field, database);
      const version = spec ? activeVersion(spec.producer) : null;
      if (!version) return [];
      return database.prepare(`SELECT league_id, COUNT(*) AS rows,
            SUM(CASE WHEN json_extract(health, '$.status') = 'failed' THEN 1 ELSE 0 END) AS failed,
            MAX(as_of) AS latest_as_of
          FROM engine_state WHERE id IN (SELECT MAX(id) FROM engine_state
            WHERE field = ? AND lane = 'live' AND producer_version = ? AND id <= ? AND as_of <= ?
            GROUP BY entity_type, entity_id, league_id)
          GROUP BY league_id ORDER BY league_id`).all(field, version, cut.state, tick.as_of)
        .map(r => ({ league_id: Number(r.league_id), rows: Number(r.rows), failed: Number(r.failed), latest_as_of: r.latest_as_of }));
    },
    freshAt(producer, leagueId, rowAsOf) {
      return freshAt({ producer, leagueId, rowAsOf, ref: tick.as_of }, database);
    },
    latestSnapshotId() {
      const r = database.prepare('SELECT MAX(id) AS id FROM engine_snapshots WHERE created_at <= ?').get(tick.as_of);
      return r?.id == null ? null : Number(r.id);
    },
    fallback(field) {
      return readFallback(field, 0, database);
    },
    setFallback({ field, fallbackField, reason, n }) {
      setFallback({ field, leagueId: 0, fallbackField, reason, n, since: tick.as_of }, database);
    },
    clearFallback(field) {
      return clearFallback({ field, leagueId: 0 }, database);
    },
    leagues() {
      const ids = new Set(database.prepare('SELECT DISTINCT league_id FROM engine_events WHERE league_id > 0').all()
        .map(r => Number(r.league_id)));
      if (tableExists(database, 'number_audit')) {
        for (const r of database.prepare('SELECT DISTINCT league_id FROM number_audit').all()) ids.add(Number(r.league_id));
      }
      return [...ids].sort((a, b) => a - b);
    },
    writeCard(leagueId, cardRows) {
      if (!tableExists(database, 'number_audit')) return false;
      // The same upsert as number-audit.js#writeAuditRows (#237): first_seen_at holds while a check keeps its status.
      const stmt = database.prepare(`INSERT INTO number_audit
          (league_id, check_id, status, inventory_row, title, detail, cause, trust, pages_affected, values_json, as_of, first_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(league_id, check_id) DO UPDATE SET
          first_seen_at = CASE WHEN number_audit.status = excluded.status THEN number_audit.first_seen_at ELSE excluded.first_seen_at END,
          status = excluded.status, inventory_row = excluded.inventory_row, title = excluded.title,
          detail = excluded.detail, cause = excluded.cause, trust = excluded.trust,
          pages_affected = excluded.pages_affected, values_json = excluded.values_json, as_of = excluded.as_of`);
      for (const r of cardRows) {
        stmt.run(Number(leagueId), r.check_id, r.status, r.inventory_row ?? null, r.title, r.detail, r.cause ?? null,
          r.trust ?? null, JSON.stringify(r.pages_affected ?? []), JSON.stringify(r.values ?? {}), tick.as_of, tick.as_of);
      }
      return true;
    },
    cardHas(checkId) {
      if (!tableExists(database, 'number_audit')) return false;
      return !!database.prepare('SELECT 1 FROM number_audit WHERE check_id = ? LIMIT 1').get(checkId);
    },
  });
}
