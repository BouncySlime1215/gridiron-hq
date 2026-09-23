export const name = '071_rec_ledger';
/**
 * `rec_ledger` — every recommendation the app makes, frozen when it is made and
 * graded later against what the players actually scored (plan item 13, the
 * decision post-mortem loop; GR-01).
 *
 * ADDITIVE ONLY. One new table and its indexes, `IF NOT EXISTS` throughout. It
 * reads nothing, alters nothing and deletes nothing.
 *
 * WHY NOT AN EXISTING TABLE. `decision_recommendations` (020) is the inbox's
 * lifecycle (open / actioned / dismissed) and upserts over its own prediction,
 * so it cannot be graded after the fact. `trade_outcomes` (067) is the
 * acceptance ledger for the `/proposals` slate: did he say yes when the model
 * said 70%. This table is the other question: did the call gain points against
 * the call we would otherwise have made. It stores no acceptance probability,
 * so the two never hold the same number.
 *
 * ONE ROW PER (RECOMMENDATION, HORIZON). A trade is graded at +2 and +5 weeks, a
 * lineup at +1, so a trade is two rows. Each row is graded exactly once and
 * carries one scalar `score`, which keeps "graded share" a plain count.
 *
 * `disposition` separates what was SHOWN from what was CONSIDERED AND NOT SHOWN
 * (findTrades' edge-removed ideas, C-08). That is a column with a CHECK, not a
 * flag in `predicted_json`, for the reason 067 gives for its synthetic table: a
 * control group that is one forgotten WHERE clause away from pooling with the
 * treatment is not a control group.
 *
 * `season` / `week` are the scoring period the call was made for (the engines'
 * own `tradeWeekContext()`), so horizon h covers weeks week .. week+h-1.
 * `inputs_hash` is sha256 over the call's inputs; the unique index makes a
 * recommendation recomputed on every page open one row, not one per refresh.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rec_ledger (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id          INTEGER NOT NULL,
      kind               TEXT NOT NULL CHECK (kind IN ('trade', 'lineup', 'waiver', 'scenario')),
      disposition        TEXT NOT NULL DEFAULT 'shown'
        CHECK (disposition IN ('shown', 'considered_not_shown')),
      made_at            TEXT NOT NULL,
      season             INTEGER NOT NULL,
      week               INTEGER NOT NULL CHECK (week >= 1),
      inputs_hash        TEXT NOT NULL,
      predicted_json     TEXT NOT NULL,
      baseline_call_json TEXT,
      horizon            INTEGER NOT NULL CHECK (horizon >= 1),
      graded_at          TEXT,
      outcome_json       TEXT,
      score              REAL,
      CHECK ((graded_at IS NULL) = (outcome_json IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_ledger_identity
      ON rec_ledger (league_id, kind, disposition, inputs_hash, horizon);
    CREATE INDEX IF NOT EXISTS idx_rec_ledger_ungraded
      ON rec_ledger (graded_at, league_id, season);
  `);
}
