export const name = '053_nfl_news_signals_versioning';

/**
 * WP08/R1: `nfl_news_signals` PRIMARY KEY (news_id,player_key,signal_type)
 * meant a re-sync or re-extraction of the SAME story overwrote the existing
 * row's content in place (`ON CONFLICT ... DO UPDATE`, nfl-news-signal.js).
 * A later corrected extraction -- a fixed status, a revised confidence, a
 * different evidence span -- silently replaced what an earlier snapshot
 * would have seen, with `created_at` left untouched (see migration 051's
 * sibling R2 fix in nfl-news-signal.js for the companion bug this enabled:
 * comparing that stale `created_at` against a cutoff). There was no way to
 * ask "what did this system actually claim about this player as of last
 * Tuesday" once Wednesday's re-sync had run.
 *
 * This rebuilds the table append-only, the same pattern already established
 * for `nfl_feature_revisions` (indexesAndTriggers() in nfl-a-to-m.js: BEFORE
 * UPDATE/DELETE triggers that RAISE(ABORT)) and for the PRIMARY KEY rebuild
 * itself (039_candidate_finding_rule_version.js is the direct precedent for
 * "SQLite has no ALTER TABLE for this, so recreate the table"):
 *
 *   - PRIMARY KEY becomes a surrogate `id INTEGER PRIMARY KEY AUTOINCREMENT`.
 *     AUTOINCREMENT guarantees strictly increasing ids in insert order even
 *     when two versions land inside the same `datetime('now')` second (that
 *     function's resolution is whole seconds -- real risk for a re-sync run
 *     that processes many stories quickly), which a plain MAX(created_at)
 *     comparison cannot promise.
 *   - (news_id,player_key,signal_type) becomes a plain (non-unique) index:
 *     several versions may now share it.
 *   - BEFORE UPDATE / BEFORE DELETE triggers make the table genuinely
 *     append-only at the database level, not just by caller convention --
 *     nfl-news-signal.js's rewritten sync functions only ever INSERT.
 *   - The three generic `nfl_blind_input_nfl_news_signals_*` mutation-journal
 *     triggers (installed once, by migration 000's indexesAndTriggers(), for
 *     every table in BLIND_AUDIT_INPUT_TABLES) are recreated here verbatim.
 *     Migration 000 never runs again on an existing database, so rebuilding
 *     this table without also recreating them would silently drop this
 *     table out of the blind-audit mutation journal on every already-
 *     installed database. Requires zero import from nfl-a-to-m.js: the SQL
 *     is copied, not evaluated, so a later change to that generic loop
 *     cannot retroactively alter what an already-applied migration did.
 *
 * `nfl_news_signals_current` is a view exposing exactly one row per
 * (news_id,player_key,signal_type) -- the highest `id` (latest version) --
 * with the identical column shape the table always had. Every existing
 * reader outside nfl-news-signal.js (news-lag-trader.js,
 * nfl-capture-dispatch.js, nfl-news-market-latency.js, nfl-rookie-ingest.js,
 * signal-latency.js, polymarket.js, who-plays.js, routes/news.js) assumed
 * one row per key; this view is what they are updated to read instead of the
 * raw table, so "the current claim" keeps meaning exactly what it always
 * meant for them, with zero awareness of versioning required on their part.
 * Point-in-time callers (playerNewsSignal, teamNewsSignals) read the raw
 * table directly -- they need "the latest version AS OF A PAST CUTOFF", which
 * this view (always "as of now") cannot express.
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(nfl_news_signals)`).all();
  if (cols.some(c => c.name === 'id' && c.pk === 1)) return; // already rebuilt

  db.exec(`
    CREATE TABLE nfl_news_signals_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id INTEGER NOT NULL,
      player_key TEXT NOT NULL,
      player_id TEXT,
      player_name TEXT,
      team TEXT,
      signal_type TEXT NOT NULL,
      status TEXT,
      body_part TEXT,
      unavailable_probability REAL,
      role_delta REAL,
      confidence REAL NOT NULL,
      published_at TEXT NOT NULL,
      source TEXT,
      source_url TEXT,
      evidence_span TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      verification_state TEXT NOT NULL DEFAULT 'quarantined',
      verification_reason TEXT NOT NULL DEFAULT 'source not evaluated',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO nfl_news_signals_new
      (news_id, player_key, player_id, player_name, team, signal_type, status, body_part,
       unavailable_probability, role_delta, confidence, published_at, source, source_url,
       evidence_span, extractor_version, verification_state, verification_reason, created_at)
    SELECT news_id, player_key, player_id, player_name, team, signal_type, status, body_part,
       unavailable_probability, role_delta, confidence, published_at, source, source_url,
       evidence_span, extractor_version, verification_state, verification_reason, created_at
    FROM nfl_news_signals
    ORDER BY created_at, rowid;
    DROP TABLE nfl_news_signals;
    ALTER TABLE nfl_news_signals_new RENAME TO nfl_news_signals;

    CREATE INDEX IF NOT EXISTS idx_nfl_news_signal_player ON nfl_news_signals(player_key,published_at);
    CREATE INDEX IF NOT EXISTS idx_nfl_news_signals_key ON nfl_news_signals(news_id,player_key,signal_type,id);

    CREATE TRIGGER IF NOT EXISTS nfl_news_signals_no_update BEFORE UPDATE ON nfl_news_signals
      BEGIN SELECT RAISE(ABORT, 'nfl_news_signals is append-only: insert a new version, never update one'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_news_signals_no_delete BEFORE DELETE ON nfl_news_signals
      BEGIN SELECT RAISE(ABORT, 'nfl_news_signals is append-only: superseded versions are retained, never deleted'); END;

    CREATE TRIGGER IF NOT EXISTS nfl_blind_input_nfl_news_signals_insert AFTER INSERT ON nfl_news_signals
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('nfl_news_signals','insert',datetime('now'));
      END;
    CREATE TRIGGER IF NOT EXISTS nfl_blind_input_nfl_news_signals_update AFTER UPDATE ON nfl_news_signals
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('nfl_news_signals','update',datetime('now'));
      END;
    CREATE TRIGGER IF NOT EXISTS nfl_blind_input_nfl_news_signals_delete AFTER DELETE ON nfl_news_signals
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('nfl_news_signals','delete',datetime('now'));
      END;

    CREATE VIEW IF NOT EXISTS nfl_news_signals_current AS
      SELECT s.* FROM nfl_news_signals s
      WHERE NOT EXISTS (
        SELECT 1 FROM nfl_news_signals s2
        WHERE s2.news_id = s.news_id AND s2.player_key = s.player_key AND s2.signal_type = s.signal_type
          AND s2.id > s.id
      );
  `);

  const violations = db.prepare(`PRAGMA foreign_key_check(nfl_news_signals)`).all();
  if (violations.length) {
    throw new Error(`nfl_news_signals rebuild produced ${violations.length} foreign-key violation(s)`);
  }
}

export function down(db) {
  // Best-effort revert. A key with more than one version cannot be losslessly
  // represented under the old single-row-per-key PRIMARY KEY, so rolling back
  // after real versioning has happened is refused rather than silently
  // picking a version to keep and discarding the rest.
  const multiVersion = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT news_id,player_key,signal_type FROM nfl_news_signals
      GROUP BY news_id,player_key,signal_type HAVING COUNT(*) > 1
    )`).get();
  if (multiVersion.n > 0) {
    throw new Error(`cannot roll back 053_nfl_news_signals_versioning: ${multiVersion.n} key(s) have more than `
      + 'one version, which would collide under the old PRIMARY KEY (news_id,player_key,signal_type)');
  }
  db.exec(`
    DROP VIEW IF EXISTS nfl_news_signals_current;
    DROP TRIGGER IF EXISTS nfl_news_signals_no_update;
    DROP TRIGGER IF EXISTS nfl_news_signals_no_delete;
    DROP TRIGGER IF EXISTS nfl_blind_input_nfl_news_signals_insert;
    DROP TRIGGER IF EXISTS nfl_blind_input_nfl_news_signals_update;
    DROP TRIGGER IF EXISTS nfl_blind_input_nfl_news_signals_delete;

    CREATE TABLE nfl_news_signals_old (
      news_id INTEGER NOT NULL,
      player_key TEXT NOT NULL,
      player_id TEXT,
      player_name TEXT,
      team TEXT,
      signal_type TEXT NOT NULL,
      status TEXT,
      body_part TEXT,
      unavailable_probability REAL,
      role_delta REAL,
      confidence REAL NOT NULL,
      published_at TEXT NOT NULL,
      source TEXT,
      source_url TEXT,
      evidence_span TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      verification_state TEXT NOT NULL DEFAULT 'quarantined',
      verification_reason TEXT NOT NULL DEFAULT 'source not evaluated',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (news_id,player_key,signal_type)
    );
    INSERT INTO nfl_news_signals_old
      (news_id, player_key, player_id, player_name, team, signal_type, status, body_part,
       unavailable_probability, role_delta, confidence, published_at, source, source_url,
       evidence_span, extractor_version, verification_state, verification_reason, created_at)
    SELECT news_id, player_key, player_id, player_name, team, signal_type, status, body_part,
       unavailable_probability, role_delta, confidence, published_at, source, source_url,
       evidence_span, extractor_version, verification_state, verification_reason, created_at
    FROM nfl_news_signals;
    DROP TABLE nfl_news_signals;
    ALTER TABLE nfl_news_signals_old RENAME TO nfl_news_signals;
    CREATE INDEX IF NOT EXISTS idx_nfl_news_signal_player ON nfl_news_signals(player_key,published_at);

    CREATE TRIGGER IF NOT EXISTS nfl_blind_input_nfl_news_signals_insert AFTER INSERT ON nfl_news_signals
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('nfl_news_signals','insert',datetime('now'));
      END;
    CREATE TRIGGER IF NOT EXISTS nfl_blind_input_nfl_news_signals_update AFTER UPDATE ON nfl_news_signals
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('nfl_news_signals','update',datetime('now'));
      END;
    CREATE TRIGGER IF NOT EXISTS nfl_blind_input_nfl_news_signals_delete AFTER DELETE ON nfl_news_signals
      BEGIN
        INSERT INTO nfl_blind_input_mutations(table_name,operation,changed_at)
        VALUES ('nfl_news_signals','delete',datetime('now'));
      END;
  `);
}
