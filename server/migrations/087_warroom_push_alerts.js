export const name = '087_warroom_push_alerts';
/**
 * PUSH-01 (NORTH-STAR-PLAN row 7). Additive only: two new tables.
 *
 * `warroom_push_state` — per league and kind ('next_move' | 'feasibility'), the
 * value the War Room producer last saw (`seen_value`) and the value Nick was last
 * told about (`announced_value`; the baseline on the first run). A change is
 * `seen_value` moving; a push is owed only while the latest value differs from
 * `announced_value`, so a move that flips back before delivery sends nothing.
 *
 * `warroom_push_alerts` — the outbox and its history, one row per change.
 * status: 'queued' (waiting: quiet hours, no channel, or a retry), 'sent',
 * 'superseded' (a newer change for the same league and kind replaced it before
 * delivery), 'failed' (three send attempts failed; `error` says why). The partial
 * unique index keeps at most one queued alert per league and kind.
 *
 * Written and read only by server/services/campaign/push-alerts.js, called from
 * scripts/campaign/produce-plans.mjs after each plans run.
 *
 * Numbered 087: 085 and 086 are claimed by open PRs.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS warroom_push_state (
      league_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('next_move', 'feasibility')),
      seen_value TEXT NOT NULL,
      announced_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (league_id, kind)
    );
    CREATE TABLE IF NOT EXISTS warroom_push_alerts (
      id INTEGER PRIMARY KEY,
      league_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('next_move', 'feasibility')),
      from_value TEXT NOT NULL,
      to_value TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'superseded', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      channel TEXT,
      error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_warroom_push_alerts_one_queued
      ON warroom_push_alerts(league_id, kind) WHERE status = 'queued';
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_warroom_push_alerts_one_queued');
  db.exec('DROP TABLE IF EXISTS warroom_push_alerts');
  db.exec('DROP TABLE IF EXISTS warroom_push_state');
}
