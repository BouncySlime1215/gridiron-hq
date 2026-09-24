export const name = '095_surprise_hypotheses';
/**
 * HYPO-01a. Additive only: one new table.
 *
 * `surprise_hypotheses` — one row per outcome the model did not expect, written by
 * server/services/hypo/surprise.js#detectSurprises for Jev / R&D to test. A row is a
 * question, never an answer: nothing here is read back into a served number, and
 * HYPO-01b decides later whether a hypothesis survives a walk-forward screen.
 *
 * The spec (ENGINE-SPECS HYPO-01a) wanted these as engine_state rows with entity
 * `hypothesis`. The unit was written before ENGINE-00a's spine (075, PR #216) reached
 * main, so the rows live in their own table; the columns map one to one onto a state
 * row (surprise_key = entity key, evidence_json = the reason chain's event ids), and
 * moving them onto the spine is a follow-up.
 *
 * THE EVIDENCE IS THE CONTRACT. A hypothesis that cannot name the rows that
 * triggered it cannot be tested without double-dipping (HYPO-01b excludes the
 * triggering events), so the CHECK refuses a row whose evidence names no
 * trade_outcomes id and no transaction id. COALESCE is load-bearing: a missing
 * JSON path gives NULL, and a CHECK that evaluates to NULL passes.
 *
 * Idempotent on surprise_key: re-running the detector over the same rows writes
 * nothing. Numbered 095 by the coordinator's ledger (handoff MIGRATIONS.md); 086 is taken.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS surprise_hypotheses (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      surprise_key     TEXT NOT NULL UNIQUE,
      league_id        INTEGER NOT NULL,
      season           INTEGER NOT NULL,
      kind             TEXT NOT NULL
        CHECK (kind IN ('accept_low', 'decline_high', 'roster_burst')),
      team_id          TEXT,
      model_p          REAL NOT NULL CHECK (model_p >= 0 AND model_p <= 1),
      surprisal        REAL NOT NULL,
      outcome          TEXT NOT NULL,
      evidence_json    TEXT NOT NULL CHECK (json_valid(evidence_json)),
      statement        TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'testing', 'kept', 'dead')),
      detector_version TEXT NOT NULL,
      occurred_at      TEXT,
      detected_at      TEXT NOT NULL,
      CHECK (COALESCE(json_array_length(evidence_json, '$.trade_outcome_ids'), 0) > 0
             OR COALESCE(json_array_length(evidence_json, '$.tx_ids'), 0) > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_surprise_hypotheses_league
      ON surprise_hypotheses(league_id, season, status, detected_at);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_surprise_hypotheses_league');
  db.exec('DROP TABLE IF EXISTS surprise_hypotheses');
}
