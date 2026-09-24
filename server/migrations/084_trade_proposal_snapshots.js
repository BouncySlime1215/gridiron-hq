export const name = '084_trade_proposal_snapshots';
/**
 * OFFER-SNAPSHOT. Additive only: two new tables, nothing existing is altered.
 *
 * `trade_proposal_snapshots` — the terms of one ESPN trade offer, written the
 * first time the collector sees it and never rewritten. 38 of 82 decided offers
 * in the ESPN leagues had no proposal row, so the players offered were unknown
 * and the acceptance model had nothing to learn terms from. The raw table
 * cannot hold this: its upsert overwrites `items_json` on every sighting, so a
 * resolved proposal that ESPN hands back with no items loses the terms it had
 * while pending. `captured_from` says which sighting the terms came from —
 * 'pending' (the offer as it was on the table), 'resolved' (first seen after it
 * was decided), or 'raw_backfill' (copied from a raw row written before this
 * table existed). The three are not the same evidence and must stay apart.
 *
 * `trade_outcome_links` — one row per decision row in the raw table (accept,
 * decline, veto, proposer-side close), linked to its proposal via
 * `related_tx_id`, or stored as 'proposal_missing' with a typed reason. Before
 * this, `settleObservedOutcomes` dropped such a decision with a free-text skip
 * that nothing kept, so the missing share could not even be counted.
 *
 * The raw table's key is (league_id, season, tx_id); both tables key on all
 * three, for the reason migration 067 gives.
 *
 * Numbered 084 per the MIGRATIONS.md registry (first built as 079, which main
 * uses for SERVE-LOG served_numbers).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_proposal_snapshots (
      league_id         INTEGER NOT NULL,
      season            INTEGER NOT NULL,
      proposal_tx_id    TEXT NOT NULL,
      proposer_team_id  INTEGER,
      proposed_at       TEXT,
      scoring_period    INTEGER,
      items_json        TEXT NOT NULL
        CHECK (json_valid(items_json) AND json_type(items_json) = 'array'
               AND json_array_length(items_json) > 0),
      first_raw_json    TEXT,
      captured_from     TEXT NOT NULL
        CHECK (captured_from IN ('pending', 'resolved', 'raw_backfill')),
      captured_at       TEXT NOT NULL,
      last_seen_at      TEXT NOT NULL,
      last_status       TEXT,
      resolution        TEXT
        CHECK (resolution IS NULL OR resolution IN ('accepted', 'declined', 'vetoed', 'closed')),
      resolution_tx_id  TEXT,
      resolved_at       TEXT,
      CHECK ((resolution IS NULL) = (resolution_tx_id IS NULL)),
      PRIMARY KEY (league_id, season, proposal_tx_id)
    );

    CREATE TABLE IF NOT EXISTS trade_outcome_links (
      league_id         INTEGER NOT NULL,
      season            INTEGER NOT NULL,
      outcome_tx_id     TEXT NOT NULL,
      outcome_type      TEXT NOT NULL,
      resolution        TEXT NOT NULL
        CHECK (resolution IN ('accepted', 'declined', 'vetoed', 'closed')),
      related_tx_id     TEXT,
      proposal_tx_id    TEXT,
      link_state        TEXT NOT NULL
        CHECK (link_state IN ('linked', 'proposal_missing')),
      missing_reason    TEXT
        CHECK (missing_reason IS NULL
               OR missing_reason IN ('no_related_tx_id', 'proposal_never_captured', 'proposal_items_empty')),
      decided_at        TEXT,
      recorded_at       TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      CHECK ((link_state = 'linked') = (missing_reason IS NULL)),
      CHECK (link_state <> 'linked' OR proposal_tx_id IS NOT NULL),
      CHECK (link_state = 'linked' OR proposal_tx_id IS NULL),
      PRIMARY KEY (league_id, season, outcome_tx_id)
    );

    CREATE INDEX IF NOT EXISTS idx_trade_outcome_links_proposal
      ON trade_outcome_links(league_id, season, proposal_tx_id);
  `);
}

/**
 * Refuses while either table holds a row: ESPN only answers with the last ~3 days,
 * so a captured offer that is dropped can never be fetched again.
 */
export function down(db) {
  for (const t of ['trade_proposal_snapshots', 'trade_outcome_links']) {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    if (exists && db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()) {
      throw new Error(`084 down refused: ${t} holds rows, and ESPN cannot re-serve offers older than ~3 days`);
    }
  }
  db.exec('DROP INDEX IF EXISTS idx_trade_outcome_links_proposal');
  db.exec('DROP TABLE IF EXISTS trade_outcome_links');
  db.exec('DROP TABLE IF EXISTS trade_proposal_snapshots');
}
