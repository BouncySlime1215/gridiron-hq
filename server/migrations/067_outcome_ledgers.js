export const name = '067_outcome_ledgers';
/**
 * `trade_outcomes` — what actually happened to a trade, stored once.
 *
 * Until now nothing stored it. Accept/decline was recomputed at read time from
 * `league_transactions_raw` on every page load (`counterparty-pricing.js`
 * around :815, `manager-signals.js` around :190, each with its own pass), and
 * never joined to a trade this app proposed. Two questions therefore could not
 * be asked at all: when the model said 70%, was he — and what did the model
 * consider and decide not to send.
 *
 * The second question is why `considered_only` is a first-class `source` here
 * rather than a later addition. A ledger of what was PROPOSED is a ledger of
 * the model's own filter; scoring it against outcomes measures the filter and
 * calls the number a calibration. The rejected candidates are the control
 * group, and a control group added later is a control group that does not
 * exist for the period that matters.
 *
 * WHAT THIS TABLE DOES NOT DO. It does not replace the read-time passes. Those
 * keep working exactly as they do today, against the same raw table, and this
 * migration touches neither. The writer below is the same logic pointed at a
 * store, so that an outcome acquires a stamp and a join key instead of being
 * re-derived and thrown away.
 *
 * THE JOIN KEY IS THREE COLUMNS, NOT ONE. `league_transactions_raw`'s primary
 * key is (league_id, season, tx_id) — it is created by hand in
 * `scripts/collect-league-transactions.mjs`, not by a migration — so `tx_id` is
 * not unique on its own. The partial unique index below is on all three. Keying
 * idempotency on `espn_tx_id` alone would merge two different leagues' deals
 * the first time they shared an id, and the merge would look like a successful
 * de-duplication.
 *
 * THE CHECKS ARE THE CONTRACT. Every rule this ledger depends on is stated in
 * SQL rather than in a writer, because a rule held only in a writer is a rule
 * the next writer has not read:
 *   - a `considered_only` row is always `not_proposed`, and a `not_proposed`
 *     row always carries its reason. A non-event with no reason is a row that
 *     every non-event satisfies, which is not a datum.
 *   - an `observed` row always carries the ESPN id it came from, so it can be
 *     traced back to the raw row and re-derived.
 *   - an `app_proposed` row always carries `model_p_accept`. A prediction that
 *     was not recorded at the moment it was made cannot be recovered later, and
 *     a proposed row with no prediction can never be scored.
 *
 * `trade_outcomes_synthetic` is a SEPARATE TABLE, not a flag. A simulated deal
 * is a stress test of the machinery; a real one is evidence about a person.
 * They are never the same kind of thing and must never pool. A flag would be
 * one forgotten WHERE clause away from pricing a human being on invented
 * negotiations. Two tables make that mistake a syntax error rather than a
 * judgement call, and the `label` CHECK means a synthetic row cannot even
 * describe itself as real.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_outcomes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id            INTEGER NOT NULL,
      season               INTEGER NOT NULL,
      source               TEXT NOT NULL
        CHECK (source IN ('observed', 'app_proposed', 'considered_only')),
      proposer_team_id     TEXT,
      counterparty_team_id TEXT,
      give_json            TEXT,
      get_json             TEXT,
      proposed_at          TEXT,
      model_p_accept       REAL,
      model_p_accept_low   REAL,
      model_p_accept_high  REAL,
      model_basis          TEXT,
      model_version        TEXT,
      status               TEXT NOT NULL
        CHECK (status IN ('proposed', 'accepted', 'declined', 'countered',
                          'expired', 'ignored', 'not_proposed')),
      not_proposed_reason  TEXT,
      counter_json         TEXT,
      espn_tx_id           TEXT,
      idea_id              TEXT,
      resolved_at          TEXT,
      created_at           TEXT NOT NULL,

      CHECK (source <> 'considered_only' OR status = 'not_proposed'),
      CHECK (status <> 'not_proposed' OR not_proposed_reason IS NOT NULL),
      CHECK (source <> 'observed' OR espn_tx_id IS NOT NULL),
      CHECK (source <> 'app_proposed' OR model_p_accept IS NOT NULL),
      CHECK (model_p_accept IS NULL OR (model_p_accept >= 0 AND model_p_accept <= 1)),

      -- THE MODEL DOES NOT STATE A POINT, so the ledger must not record one as
      -- if it did. trade-acceptance.js returns a BAND and says in its own served
      -- sentence that it is "not a calibrated probability"; its fitted flag is
      -- false on every path. model_p_accept is the midpoint, kept because a
      -- calibration needs a point prediction to score — but it travels with the width the
      -- evidence actually bought and with the basis that produced it, so nobody
      -- reading this table later can mistake a declared starting point for a
      -- measurement. A midpoint stored alone would be exactly the invented
      -- precision this project keeps finding and removing.
      CHECK ((model_p_accept_low IS NULL) = (model_p_accept_high IS NULL)),
      CHECK (model_p_accept_low IS NULL
             OR (model_p_accept_low >= 0 AND model_p_accept_high <= 1
                 AND model_p_accept_low <= model_p_accept
                 AND model_p_accept <= model_p_accept_high)),
      CHECK (model_basis IS NULL
             OR model_basis IN ('no_information', 'heuristic_unanchored', 'heuristic_anchored')),
      -- A recorded prediction that does not say which kind of claim it was
      -- cannot be graded later: an anchored band and a declared starting point
      -- are not the same evidence and must never pool in one curve.
      CHECK (model_p_accept IS NULL OR model_basis IS NOT NULL)
    );

    -- Idempotency for the observed writer. PARTIAL, because app_proposed and
    -- considered_only rows have no ESPN id and many of them are legitimately
    -- NULL; a plain UNIQUE would allow exactly one such row per table.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_outcomes_espn
      ON trade_outcomes(league_id, season, espn_tx_id)
      WHERE espn_tx_id IS NOT NULL;

    -- Idempotency for the APP side, needed for the same reason the ESPN side is:
    -- a route can be hit twice. GET /:leagueId/proposals is a GET that a page
    -- calls on every open, so without this one browser refresh would write the
    -- whole slate again and a calibration would count one decision as many.
    -- idea_id is trade-engine's own ideaKey, which every proposal already has to
    -- cite, so it is the app-side equivalent of espn_tx_id.
    --
    -- The index includes the source column deliberately: the same idea can
    -- legitimately appear once as app_proposed and once as considered_only across
    -- different slates, and collapsing those two would delete exactly the
    -- contrast this ledger exists to measure.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_outcomes_idea
      ON trade_outcomes(league_id, season, idea_id, source)
      WHERE idea_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_league
      ON trade_outcomes(league_id, season, proposed_at);

    -- The calibration read: every app prediction with its resolution.
    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_model
      ON trade_outcomes(model_version, status)
      WHERE model_p_accept IS NOT NULL;

    CREATE TABLE IF NOT EXISTS trade_outcomes_synthetic (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      sim_run_id           TEXT NOT NULL,
      label                TEXT NOT NULL DEFAULT 'synthetic'
        CHECK (label = 'synthetic'),
      league_id            INTEGER NOT NULL,
      season               INTEGER NOT NULL,
      source               TEXT NOT NULL
        CHECK (source IN ('observed', 'app_proposed', 'considered_only')),
      proposer_team_id     TEXT,
      counterparty_team_id TEXT,
      give_json            TEXT,
      get_json             TEXT,
      proposed_at          TEXT,
      model_p_accept       REAL,
      model_p_accept_low   REAL,
      model_p_accept_high  REAL,
      model_basis          TEXT,
      model_version        TEXT,
      status               TEXT NOT NULL
        CHECK (status IN ('proposed', 'accepted', 'declined', 'countered',
                          'expired', 'ignored', 'not_proposed')),
      not_proposed_reason  TEXT,
      counter_json         TEXT,
      espn_tx_id           TEXT,
      idea_id              TEXT,
      resolved_at          TEXT,
      created_at           TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_synthetic_run
      ON trade_outcomes_synthetic(sim_run_id);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_trade_outcomes_synthetic_run;
    DROP TABLE IF EXISTS trade_outcomes_synthetic;
    DROP INDEX IF EXISTS idx_trade_outcomes_model;
    DROP INDEX IF EXISTS idx_trade_outcomes_league;
    DROP INDEX IF EXISTS idx_trade_outcomes_idea;
    DROP INDEX IF EXISTS idx_trade_outcomes_espn;
    DROP TABLE IF EXISTS trade_outcomes;
  `);
}
