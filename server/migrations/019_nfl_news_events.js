export const name = '019_nfl_news_events';

/**
 * Package E's typed evidence schema (NFL_RESEARCH_MASTER_PLAN_2026_09_08.md §E).
 *
 * `nfl_news_signals` (nfl-news-signal.js) already types availability/role claims
 * against a closed enum. This table is the superset the plan actually asks for:
 * a general claim (not limited to that enum), the exact supporting span, TWO
 * separate clocks (published_at vs first_seen_time — see nfl-bitemporal.js's
 * header for why those differ), a novelty judgement, and a nullable pointer to
 * an earlier event this one contradicts or supersedes. It does not replace
 * nfl_news_signals; nfl-news-events.js can and does read it for corroboration.
 *
 * `nfl_news_event_extraction_cache` is keyed by CONTENT hash, not news_id —
 * unlike nfl-news-signal.js's per-news_id attempt log, this also catches the
 * same text re-appearing under a different news_id (a wire story reposted by
 * two outlets), which is exactly the "duplicate article" negative control.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_news_events (
      event_id             TEXT PRIMARY KEY,
      source_kind          TEXT NOT NULL CHECK(source_kind IN ('news_item','press_conference')),
      source_ref           TEXT NOT NULL,
      content_hash         TEXT NOT NULL,
      player_key           TEXT,
      player_id            TEXT,
      player_name          TEXT,
      team                 TEXT,
      claim_type           TEXT NOT NULL,
      claim_text           TEXT NOT NULL,
      evidence_span        TEXT NOT NULL,
      source_name          TEXT,
      source_url           TEXT,
      reporter_handle      TEXT,
      published_at         TEXT NOT NULL,
      first_seen_time      TEXT NOT NULL,
      certainty            REAL,
      certainty_label      TEXT NOT NULL DEFAULT 'stated' CHECK(certainty_label IN ('stated','unknown')),
      novelty_score        REAL,
      novelty_label        TEXT CHECK(novelty_label IN ('new','restatement','unknown') OR novelty_label IS NULL),
      scenario_json         TEXT,
      superseded_event_id   TEXT REFERENCES nfl_news_events(event_id),
      contradiction_reason  TEXT,
      risk_branch           TEXT,
      extractor_version     TEXT NOT NULL,
      verification_state    TEXT NOT NULL DEFAULT 'quarantined',
      verification_reason   TEXT NOT NULL DEFAULT 'source not evaluated',
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nfl_news_events_player ON nfl_news_events(player_key, first_seen_time);
    CREATE INDEX IF NOT EXISTS idx_nfl_news_events_team ON nfl_news_events(team, first_seen_time);
    CREATE INDEX IF NOT EXISTS idx_nfl_news_events_hash ON nfl_news_events(content_hash);
    CREATE INDEX IF NOT EXISTS idx_nfl_news_events_source ON nfl_news_events(source_kind, source_ref);

    CREATE TABLE IF NOT EXISTS nfl_news_event_extraction_cache (
      content_hash      TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      attempted_at      TEXT NOT NULL,
      claims_found      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (content_hash, extractor_version)
    );
  `);
}

export function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS nfl_news_event_extraction_cache;
    DROP TABLE IF EXISTS nfl_news_events;
  `);
}
