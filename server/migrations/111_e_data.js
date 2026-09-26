export const name = '111_e_data';
/**
 * E-DATA (Batch D item 2). Additive only: three new tables, nothing existing is altered.
 *
 * `trade_proposal_snapshots` — the terms of one ESPN trade offer, written the first time any
 * collector pass sees it and never rewritten (#247 OFFER-SNAPSHOT's design; its migration 084
 * never merged). The raw table cannot hold this: its upsert overwrites `items_json` on every
 * sighting, so a resolved offer ESPN hands back with no items loses the terms it had while
 * pending, and an offer whose proposal row was never stored leaves its answer an orphan.
 * eval/decided-offers.js already reads this table (SNAP_COLS) to fill such a proposal, so the
 * pairing stays in the one producer E1 grades. `captured_from`: 'pending' (on the table),
 * 'resolved' (first seen after it was decided) or 'raw_backfill' (copied from a raw row
 * written before this table existed). Only the first two are a live first sight.
 *
 * `offer_first_sight` — every model's P(yes) for one offer as it stood when the offer was
 * first seen live: the E1 activity baseline, the clone band (anchor-only, what the grader
 * replays), the LIVE-BLEND weights and blend, and what p-yes.js would have served. Written
 * once, never rewritten, so LIVE-BLEND's weights can be earned forward (p-yes-blend.js
 * #forwardGraded). `seen_state` 'resolved' = the answer was already collected at first sight:
 * recorded, but not a forward prediction. A row with no p carries a typed `reason`.
 *
 * `fc_value_history` — every FantasyCalc capture of the player_metrics values Nick's rules
 * read (fc_value, fc_trend30, fc_adp), one row per player, source and capture instant.
 * `player_metrics` keeps only the latest; `dynasty_value_history` (073) keeps one row per
 * UTC day per league format, first capture wins. Read by fc-value.js#fcValuesAsOf.
 *
 * Numbered 111: 106 is main's espn_weekly_projection_snapshots (#431) and 107-110 are claimed
 * by #438/#433 (coordinator, 2026-09-25). docs/handoff/local/MIGRATIONS.md gets its row on
 * merge; 084 stays #247's reservation until that PR is closed.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_proposal_snapshots (
      league_id            INTEGER NOT NULL,
      season               INTEGER NOT NULL,
      proposal_tx_id       TEXT NOT NULL,
      proposer_team_id     INTEGER,
      counterparty_team_id INTEGER,
      proposed_at          TEXT,
      scoring_period       INTEGER,
      items_json           TEXT NOT NULL
        CHECK (json_valid(items_json) AND json_type(items_json) = 'array'
               AND json_array_length(items_json) > 0),
      captured_from        TEXT NOT NULL
        CHECK (captured_from IN ('pending', 'resolved', 'raw_backfill')),
      captured_at          TEXT NOT NULL,
      last_seen_at         TEXT NOT NULL,
      last_status          TEXT,
      PRIMARY KEY (league_id, season, proposal_tx_id)
    );

    CREATE TABLE IF NOT EXISTS offer_first_sight (
      league_id            INTEGER NOT NULL,
      season               INTEGER NOT NULL,
      proposal_tx_id       TEXT NOT NULL,
      proposer_team_id     INTEGER,
      counterparty_team_id INTEGER,
      proposed_at          TEXT,
      recorded_at          TEXT NOT NULL,
      seen_state           TEXT NOT NULL CHECK (seen_state IN ('pending', 'resolved')),
      p_baseline           REAL,
      p_clone              REAL,
      p_blend              REAL,
      p_served             REAL,
      served_basis         TEXT,
      served_mode          TEXT,
      w_baseline           REAL,
      w_clone              REAL,
      n_graded             INTEGER,
      baseline_n           INTEGER,
      reason               TEXT,
      CHECK (p_served IS NOT NULL OR reason IS NOT NULL),
      PRIMARY KEY (league_id, season, proposal_tx_id)
    );

    CREATE TABLE IF NOT EXISTS fc_value_history (
      player_id   INTEGER NOT NULL,
      source      TEXT NOT NULL CHECK (source IN ('fc_value', 'fc_trend30', 'fc_adp')),
      value       REAL NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (player_id, source, captured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_fc_value_history_at ON fc_value_history(source, captured_at);
  `);
}

/**
 * Refuses while any table holds a row: ESPN only answers with the last ~3 days, a first-sight
 * prediction cannot be recomputed later without hindsight, and FantasyCalc serves no history.
 */
export function down(db) {
  for (const t of ['trade_proposal_snapshots', 'offer_first_sight', 'fc_value_history']) {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
    if (exists && db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()) {
      throw new Error(`111 down refused: ${t} holds rows that cannot be fetched or recomputed again`);
    }
  }
  db.exec('DROP INDEX IF EXISTS idx_fc_value_history_at');
  for (const t of ['fc_value_history', 'offer_first_sight', 'trade_proposal_snapshots']) db.exec(`DROP TABLE IF EXISTS ${t}`);
}
