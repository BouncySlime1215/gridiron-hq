export const name = '065_outlook_fit_store';
/**
 * Where a fitted Team Outlook model lives, so the app can score a league
 * without the corpus it was fitted on.
 *
 * `history-corpus.js` opens `process.cwd()/data/derived/sleeper_history.sqlite`
 * read-only and returns null when it is absent, and the Dockerfile's runtime
 * stage copies only `client/dist`, `server` and `scripts` — never `data/`. So
 * on Fly every O4 number (`fitOutlook`, `fitThresholds`, the variance k) has
 * always resolved to nothing, silently, while working on a dev checkout. A
 * consumer wired to those functions would render a verdict in development and
 * an empty chip in production.
 *
 * Splitting the fit off from the corpus is what makes it deployable: a script
 * on a machine that HAS the corpus fits and writes here; the request path only
 * reads. Same pattern as `shrinkage_fits`/`shrinkage_k` and
 * `fantasy_coordinator_fits`.
 *
 * `features` is stored rather than assumed. The coefficients are positional, so
 * if `OUTLOOK_FEATURES` is ever reordered or extended in code, a stored vector
 * read back positionally would be applied to the wrong features and produce
 * confident, plausible, wrong probabilities with no error anywhere. The reader
 * compares the two lists and refuses the fit; that check is only possible if
 * the list travels with the fit.
 *
 * The partial unique index is what makes "the active fit" a fact rather than a
 * convention: two active rows cannot exist, so no reader has to decide which of
 * them to believe.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outlook_fits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fitted_at TEXT NOT NULL,
      through_season INTEGER,
      k REAL NOT NULL,
      l2 REAL,
      features TEXT NOT NULL,
      thresholds TEXT NOT NULL,
      provenance TEXT,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS outlook_fit_weeks (
      fit_id INTEGER NOT NULL REFERENCES outlook_fits(id) ON DELETE CASCADE,
      week INTEGER NOT NULL,
      n INTEGER,
      intercept REAL NOT NULL,
      coef TEXT NOT NULL,
      mu TEXT NOT NULL,
      sd TEXT NOT NULL,
      PRIMARY KEY (fit_id, week)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS outlook_fits_one_active
      ON outlook_fits(active) WHERE active = 1;
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS outlook_fits_one_active;
    DROP TABLE IF EXISTS outlook_fit_weeks;
    DROP TABLE IF EXISTS outlook_fits;
  `);
}
