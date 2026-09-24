export const name = '082_follow_ledger';
/**
 * `follow_ledger` — did Nick follow the call (SELF-01a).
 *
 * ADDITIVE ONLY. One new table and its indexes, `IF NOT EXISTS` throughout. It
 * reads nothing, alters nothing and deletes nothing.
 *
 * WHY NOT rec_ledger (071). rec_ledger holds one row per (recommendation,
 * grading horizon) and grades the CALL against realised points. This table
 * holds one row per DECISION shown (one start/sit pair, one waiver claim, one
 * trade idea, one War Room next move) and records what Nick DID about it:
 * follow / ignore / no_action, matched from ESPN lineups and transactions. The
 * two answer different questions and neither stores the other's number;
 * `rec_ledger_hash` joins them.
 *
 * `decision_key` is sha256 over (league, season, week, kind, pick,
 * alternative). The first showing wins (`INSERT OR IGNORE`), so the as-of
 * inputs are those of the first time the call was on screen, and re-syncing or
 * re-rendering adds nothing.
 *
 * `margin` is the projected gap the call was made on (start/sit: pick minus
 * alternative projected points). `near_tie` is set for start/sit only, iff
 * abs(margin) < `epsilon`, the pre-registered threshold stored on the row, for
 * the discontinuity design SELF-01b grades.
 *
 * `outcome` NULL means not yet resolved; `unresolved_reason` then says why when
 * the window has closed but the evidence to resolve it is missing (no lineup
 * capture, no transaction capture). A missing capture is never a 'no_action'.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS follow_ledger (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id         INTEGER NOT NULL,
      team_id           TEXT,
      season            INTEGER NOT NULL,
      week              INTEGER NOT NULL CHECK (week >= 1),
      kind              TEXT NOT NULL CHECK (kind IN ('start_sit', 'waiver', 'trade', 'next_move')),
      action            TEXT NOT NULL CHECK (action IN ('start_sit', 'waiver', 'trade')),
      decision_key      TEXT NOT NULL,
      rec_ledger_hash   TEXT,
      source            TEXT NOT NULL CHECK (source IN ('live', 'backfill')),
      shown_at          TEXT NOT NULL,
      as_of_json        TEXT NOT NULL,
      pick_json         TEXT NOT NULL,
      alternative_json  TEXT NOT NULL,
      margin            REAL,
      epsilon           REAL,
      near_tie          INTEGER CHECK (near_tie IN (0, 1)),
      outcome           TEXT CHECK (outcome IN ('follow', 'ignore', 'no_action')),
      complied          INTEGER CHECK (complied IN (0, 1)),
      basis             TEXT,
      matched_json      TEXT,
      resolved_at       TEXT,
      unresolved_reason TEXT,
      CHECK ((outcome IS NULL) = (resolved_at IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_follow_ledger_identity
      ON follow_ledger (league_id, decision_key);
    CREATE INDEX IF NOT EXISTS idx_follow_ledger_open
      ON follow_ledger (resolved_at, league_id, season, week);
  `);
}

/**
 * Rolls 082 back only while the ledger is empty. Each row is Nick's action on a
 * call shown at a moment that cannot be replayed; dropping a populated table
 * would delete that evidence (the same refusal 071 makes).
 */
export function down(db) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='follow_ledger'`).get();
  const n = exists ? db.prepare('SELECT COUNT(*) AS n FROM follow_ledger').get().n : 0;
  if (n) {
    throw new Error(`rollback refused: ${n} follow_ledger row(s) record what was done about a shown call. `
      + 'Rolling back would delete that evidence. Restore the pre-migration snapshot instead.');
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_follow_ledger_open;
    DROP INDEX IF EXISTS idx_follow_ledger_identity;
    DROP TABLE IF EXISTS follow_ledger;
  `);
}
