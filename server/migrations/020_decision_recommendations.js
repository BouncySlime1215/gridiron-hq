export const name = '020_decision_recommendations';

/**
 * The universal "Decision Inbox" (CODEX_SUGGESTIONS.md, global recommendation
 * #1, P1 design project): one normalized table every engine — fantasy or
 * betting — can publish a recommendation into, so the Dashboard can be a
 * ranked queue instead of a directory of links.
 *
 * This is NOT a replacement for anything that already exists:
 *
 *   - `trades.js`'s `/:leagueId/inbox` route stays exactly as-is. It computes
 *     an ephemeral, request-scoped "act now" list on every page load (roster
 *     fixes, major news, one mutual trade) and is not persisted or
 *     resolvable — it answers "what does the data say right now," not "what
 *     has the app told me and did I act on it." This table answers the
 *     second question and is additive to it.
 *   - The betting side's forward-ledger/pick-lifecycle machinery
 *     (`server/services/forward-ledger.js`, `nfl-execution.js`, the
 *     specified -> data-qualified -> ... -> eligible-for-review lifecycle in
 *     docs/NFL_RESEARCH_MASTER_PLAN_2026_09_08.md) keeps its own authority
 *     and state machine untouched. A betting engine may publish a row here
 *     ("this line moved past what the model would still bet") that
 *     REFERENCES that system's decision, but this table never re-implements
 *     or overrides it.
 *
 * Column choices, adjusted from the audit's proposed list for SQLite and this
 * codebase's conventions:
 *
 *   - `id` is TEXT (a crypto.randomUUID(), minted by the publisher) rather
 *     than an autoincrement int, matching `saved_prop_tickets.id` — lets
 *     `publishRecommendation()` compute an id before the row exists, which
 *     `ON CONFLICT` upsert-by-dedup_key needs.
 *   - `sport` is a CHECK'd enum using this codebase's existing uppercase
 *     convention (`shadow_decisions.sport = 'NFL'`, `beat-the-close.js`),
 *     not the audit's lowercase example.
 *   - `type` is deliberately NOT a CHECK'd enum. The whole point of this
 *     table is that engines not yet written will publish new types
 *     ("draft_run_response", "pitcher_change", ...) without a migration each
 *     time; only the lifecycle-bearing columns (`urgency`, `status`) are
 *     constrained.
 *   - `subject_ids` keeps the audit's literal column name (a JSON array of
 *     player/event/team ids as TEXT) even though this codebase's own
 *     convention for a JSON payload column is a `_json` suffix
 *     (`legs_json`, `outcome_json`, `spec_json`) — kept as named so the
 *     table stays directly reviewable against the audit's own quoted
 *     proposal. It is still JSON-encoded TEXT, not a real array column.
 *   - `link` is new (not in the audit's list): the Dashboard's "do"
 *     affordance needs somewhere to send the user, and every existing
 *     ephemeral inbox item in this codebase (`InboxItem.link` in
 *     `trades.js`) already carries one.
 *   - `dedup_key` is new: an engine that recomputes its condition on every
 *     page load (lineupDiff, waiverUpgrades are both called from GET
 *     routes) must not spawn a duplicate open row each time. Publishing is
 *     an upsert keyed on `dedup_key` scoped to `status='open'` — an engine
 *     re-publishing the same subject while a row is still open refreshes it
 *     in place; once resolved, a genuinely new occurrence can open a new row.
 *   - Timestamps are ISO/`datetime('now')` strings throughout, matching
 *     every other table in this schema (`auth_pairing_codes`, ranking_sets,
 *     etc.) rather than inventing a new convention.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_recommendations (
      id TEXT PRIMARY KEY,
      league_id INTEGER REFERENCES leagues(id) ON DELETE CASCADE,
      sport TEXT NOT NULL CHECK(sport IN ('NFL','MLB')),
      type TEXT NOT NULL,
      subject_ids TEXT,
      title TEXT NOT NULL,
      rationale TEXT,
      expected_value REAL,
      confidence REAL,
      urgency TEXT NOT NULL DEFAULT 'medium' CHECK(urgency IN ('high','medium','low')),
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','actioned','dismissed','expired')),
      source_model TEXT NOT NULL,
      source_version TEXT,
      link TEXT,
      dedup_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_reco_open_queue
      ON decision_recommendations(status, urgency, expires_at);
    CREATE INDEX IF NOT EXISTS idx_decision_reco_dedup
      ON decision_recommendations(dedup_key);
    CREATE INDEX IF NOT EXISTS idx_decision_reco_league
      ON decision_recommendations(league_id);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_decision_reco_league;
    DROP INDEX IF EXISTS idx_decision_reco_dedup;
    DROP INDEX IF EXISTS idx_decision_reco_open_queue;
    DROP TABLE IF EXISTS decision_recommendations;
  `);
}
