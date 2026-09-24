export const name = '089_reasoning_claims';
/**
 * REASON-02. Additive only: one new table and two indexes. Nothing existing is altered.
 *
 * `reasoning_claims`: one row per claim a REASON-01 reasoning panel showed
 * ("he'll counter with X", "he needs a running back", "check first"), stored
 * as a checkable prediction with the rule that settles it. The C8 grader
 * (server/services/reasoning/grade.js) scores the share of settled claims that
 * came true, so the reasoning layer earns trust the way the numbers do.
 *
 * THE CHECKS ARE THE CONTRACT (same stance as 067_outcome_ledgers):
 *   - a claim with no rule is `uncheckable`, and only a claim with no rule is.
 *     It is still stored, so coverage (checkable / all) is a number, not a
 *     guess about what the panels said.
 *   - a settled claim (true / false / void) carries when and why it settled.
 *     A verdict with no evidence cannot be re-derived, so it is not a verdict.
 *
 * Idempotency: a panel reused across refreshes keeps its fingerprint, so the
 * same claim is never counted twice. A rewritten panel is a new prediction.
 *
 * Writer: recordClaims (server/services/reasoning/claims.js). Settled by
 * resolveOpenClaims (resolve.js). Read by the C8 grader (grade.js).
 * Numbered 089 by docs/handoff/local/MIGRATIONS.md (#271 REASON-02); 084-088 are reserved for other units.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reasoning_claims (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id       INTEGER NOT NULL,
      card_id         TEXT NOT NULL,
      fingerprint     TEXT NOT NULL,
      section         TEXT NOT NULL,
      claim_index     INTEGER NOT NULL,
      claim_text      TEXT NOT NULL,
      cites_json      TEXT NOT NULL,
      made_at         TEXT NOT NULL,
      kind            TEXT NOT NULL
        CHECK (kind IN ('counter_with', 'wants_position', 'check_first', 'uncheckable')),
      subject_team    TEXT,
      prediction_json TEXT NOT NULL,
      resolve_rule    TEXT NOT NULL,
      resolve_by      TEXT,
      status          TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'true', 'false', 'void', 'uncheckable')),
      resolved_at     TEXT,
      evidence_json   TEXT,
      created_at      TEXT NOT NULL,
      CHECK ((kind = 'uncheckable') = (resolve_rule = 'none')),
      CHECK ((kind = 'uncheckable') = (status = 'uncheckable')),
      CHECK (kind = 'uncheckable' OR resolve_by IS NOT NULL),
      CHECK (status NOT IN ('true', 'false', 'void')
             OR (resolved_at IS NOT NULL AND evidence_json IS NOT NULL)),
      UNIQUE (league_id, card_id, fingerprint, section, claim_index)
    );
    CREATE INDEX IF NOT EXISTS idx_reasoning_claims_open
      ON reasoning_claims(status, resolve_by);
    CREATE INDEX IF NOT EXISTS idx_reasoning_claims_league
      ON reasoning_claims(league_id, made_at);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_reasoning_claims_league');
  db.exec('DROP INDEX IF EXISTS idx_reasoning_claims_open');
  db.exec('DROP TABLE IF EXISTS reasoning_claims');
}
