export const name = '037_execution_opportunity_frozen_columns';

/**
 * a6-money-path: `nfl_execution_opportunities` has exactly one legitimate
 * write path after it is opened — `recordState()` in
 * server/services/nfl-execution-lifecycle.js, which runs
 * `UPDATE nfl_execution_opportunities SET status=? WHERE id=?` and nothing
 * else. Everything that makes an opportunity mean what it says it means —
 * the contract it was opened against, the model's own frozen forecast
 * (`model_line`, `model_probability`, `market_line_at_decision`,
 * `push_probability`, `push_treatment`), which decision run it cites
 * (`decision_event_id`), even `created_at` — is supposed to be fixed at
 * OFFERED and never touched again. Nothing in the schema said so; only
 * application discipline did, and application discipline is exactly what a
 * bug or a future caller can get around without anyone noticing until a
 * settled bet's own recorded evidence no longer matches what was actually
 * decided.
 *
 * This is the database-level backstop for that, matching the append-only
 * discipline `nfl_execution_lifecycle_events` already has (023) with the one
 * difference this table actually needs: `status` is allowed to change, since
 * that is the entire point of the lifecycle. Every other column raises.
 *
 * `IS NOT` (not `<>`) throughout because several of these columns are
 * nullable and `<>` against NULL is never true in SQLite — a frozen NULL
 * column changing to a real value would silently pass a `<>` check.
 *
 * NOT applied by this change — see the build notes for a6-money-path. A
 * fresh migration file only; running it is a separate, explicit step against
 * a real database.
 */
export function up(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS nfl_execution_opportunities_frozen_columns
      BEFORE UPDATE ON nfl_execution_opportunities
      WHEN NEW.id IS NOT OLD.id
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.contract_key IS NOT OLD.contract_key
        OR NEW.contract_hash IS NOT OLD.contract_hash
        OR NEW.event_key IS NOT OLD.event_key
        OR NEW.matchup IS NOT OLD.matchup
        OR NEW.market IS NOT OLD.market
        OR NEW.side IS NOT OLD.side
        OR NEW.participant IS NOT OLD.participant
        OR NEW.decision_source IS NOT OLD.decision_source
        OR NEW.note IS NOT OLD.note
        OR NEW.model_line IS NOT OLD.model_line
        OR NEW.model_probability IS NOT OLD.model_probability
        OR NEW.market_line_at_decision IS NOT OLD.market_line_at_decision
        OR NEW.decision_event_id IS NOT OLD.decision_event_id
        OR NEW.push_probability IS NOT OLD.push_probability
        OR NEW.push_treatment IS NOT OLD.push_treatment
      BEGIN
        SELECT RAISE(ABORT, 'nfl_execution_opportunities: only status may change once an opportunity is opened');
      END;
  `);
}

export function down(db) {
  db.exec(`DROP TRIGGER IF EXISTS nfl_execution_opportunities_frozen_columns;`);
}
