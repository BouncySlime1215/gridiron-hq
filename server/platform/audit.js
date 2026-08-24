import { run, rows } from '../db/index.js';

/** Records one audit-log entry. Never throws — an audit-log failure must never fail the action it's recording. */
export function recordAudit({ actor = null, role = null, action, entityType, entityId = null, details = null }) {
  try {
    run(
      `INSERT INTO audit_log (actor, role, action, entity_type, entity_id, details) VALUES (?,?,?,?,?,?)`,
      actor, role, action, entityType, entityId != null ? String(entityId) : null,
      details != null ? JSON.stringify(details) : null
    );
  } catch (e) {
    console.error('[audit] failed to record entry:', e.message);
  }
}

export function auditTrail(entityType, entityId, limit = 200) {
  return rows(
    `SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?`,
    entityType, String(entityId), limit
  ).map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}
