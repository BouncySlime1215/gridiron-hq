export const name = '003_draft_state_machine';

/**
 * Upgrades the drafts/draft_picks tables (created ad-hoc in db/index.js) to
 * support a transactional, idempotent, server-authoritative draft engine:
 * optimistic-concurrency revisions, idempotent pick submission, configurable
 * draft order/roster rules, a durable server-owned pick clock, a persisted
 * per-team queue, and a full event log for undo/redo/correction and audit.
 */
export function up(db) {
  const draftCols = db.prepare(`PRAGMA table_info(drafts)`).all().map(c => c.name);
  if (!draftCols.includes('revision')) db.exec(`ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
  if (!draftCols.includes('order_type')) db.exec(`ALTER TABLE drafts ADD COLUMN order_type TEXT NOT NULL DEFAULT 'snake'`);
  if (!draftCols.includes('roster_positions')) db.exec(`ALTER TABLE drafts ADD COLUMN roster_positions TEXT`);
  if (!draftCols.includes('turn_deadline')) db.exec(`ALTER TABLE drafts ADD COLUMN turn_deadline TEXT`);
  if (!draftCols.includes('paused')) db.exec(`ALTER TABLE drafts ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);

  const pickCols = db.prepare(`PRAGMA table_info(draft_picks)`).all().map(c => c.name);
  if (!pickCols.includes('idempotency_key')) db.exec(`ALTER TABLE draft_picks ADD COLUMN idempotency_key TEXT`);
  if (!pickCols.includes('source')) db.exec(`ALTER TABLE draft_picks ADD COLUMN source TEXT DEFAULT 'user'`);

  db.exec(`
    -- Only enforced when a client actually supplies a key; retried requests
    -- with the same key replay the original result instead of erroring.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_draft_picks_idempotency
      ON draft_picks(draft_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS draft_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      team_slot INTEGER NOT NULL,
      player_id INTEGER NOT NULL REFERENCES players(id),
      position INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(draft_id, team_slot, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_draft_queue_slot ON draft_queue(draft_id, team_slot, position);

    -- Full, ordered history of every state-changing action on a draft: pick,
    -- undo, redo, correction, pause/resume. Powers audit, undo/redo, and
    -- draft-history export/import; also the source of truth for "what
    -- happened" independent of the current draft_picks snapshot.
    CREATE TABLE IF NOT EXISTS draft_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      actor TEXT,
      role TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(draft_id, seq)
    );
  `);
}
