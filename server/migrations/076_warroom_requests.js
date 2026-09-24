export const name = '076_warroom_requests';
/**
 * WR-3 + WR-COACH. Additive only: three new tables, nothing altered.
 *
 * `warroom_requests` — one row per War Room input from Nick (set objective,
 * approve a target, "I sent it", a logged reply with its decline reason, a deck
 * skip with its reason, risk mode, a tolerance slider, add/remove a stop, and
 * `retract` for undo). The route only records; the offline campaign producer
 * reads rows where consumed_at IS NULL, replans, and stamps consumed_at. The web
 * server never computes a plan. `source` says whether Nick tapped it or Coach
 * proposed it; a Coach-proposed plan change is written only with confirmed = 1
 * (Nick's Confirm tap after the trade-off preview).
 *
 * `warroom_layouts` — per-user saved dashboard layout, versioned: every save is
 * a new row, so a layout change is never lost and can be restored.
 *
 * `warroom_action_log` — every Coach UI action (applied, refused, previewed,
 * confirmed, cancelled, undone) with what Nick asked, so the War Room can be
 * replayed and Coach's usefulness graded.
 *
 * Numbered 076: 071 (#174, #184), 072 (#164, #166), 074 (#218) and 075 (#216,
 * #220) are claimed by open PRs.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS warroom_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      league_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'nick' CHECK (source IN ('nick', 'coach')),
      confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_requests_pending
      ON warroom_requests(league_id, consumed_at, id);

    CREATE TABLE IF NOT EXISTS warroom_layouts (
      user_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      layout TEXT NOT NULL,
      saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (user_id, version)
    );

    CREATE TABLE IF NOT EXISTS warroom_action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      league_id INTEGER,
      action_type TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'refused', 'previewed', 'confirmed', 'cancelled', 'undone')),
      asked TEXT,
      action TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_action_log_user
      ON warroom_action_log(user_id, id);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_warroom_action_log_user');
  db.exec('DROP TABLE IF EXISTS warroom_action_log');
  db.exec('DROP TABLE IF EXISTS warroom_layouts');
  db.exec('DROP INDEX IF EXISTS idx_warroom_requests_pending');
  db.exec('DROP TABLE IF EXISTS warroom_requests');
}
