export const name = '035_alt_spread_capture';

/**
 * Somewhere to put an alternate-spread price, and a fence around what it is.
 *
 * WHY THIS TABLE EXISTS.
 *
 * The two-team six-point teaser strategy is measured everywhere except at the
 * one place money changes hands. `teaser-leg-rates.js` establishes the leg rate
 * on 2,894 legs; `teaser-scan.js` pairs them and prices the ticket. The price
 * it prices with comes from `nfl_teaser_price_ledger`, which holds ONE row: a
 * DraftKings +100 typed in by hand. Between -110 and -130 the strategy swings
 * from +6.7% to -1.1% per ticket, so that single unobserved number decides the
 * whole thing.
 *
 * The owner's `live_odds.py` already reads, per game and per book, the
 * alternate spread six points either side of the main number together with its
 * price. It renders that to a terminal table and exits — it persists nothing.
 * These two tables are where it can land instead.
 *
 * WHAT AN ALT SPREAD IS, AND WHAT IT IS NOT.
 *
 * A six-point teaser is a fixed-price product: the book quotes ONE price for
 * moving every leg six points, and that price is what `nfl_teaser_price_ledger`
 * records. An alternate spread is an ordinary single bet on a line the book has
 * moved, priced on its own. They are different products and their prices are
 * not interchangeable.
 *
 * What IS comparable is a PARLAY of two alt legs against a two-team teaser:
 * both are one stake that needs both games to come in, at lines six points off
 * the main number. If the alt sits around -250 a side, two of them parlay to a
 * profit multiple of 0.96 (American -104), which sits right next to a +100
 * teaser (multiple 1.00). Whichever is better is the play — and neither number
 * is knowable without capturing the alt prices, which is what this is for.
 *
 * That comparison is a COMPARISON. It is never a substitute recording. Nothing
 * in this migration or in `alt-spread-import.js` writes to
 * `nfl_teaser_price_ledger`, and the trigger at the bottom makes the one
 * laundering route that a well-meaning future caller would actually take —
 * inserting an alt-derived price into the ledger with honest labelling — abort
 * instead of succeeding.
 *
 * APPEND-ONLY, AND WHY NO UPDATE APPEARS ANYWHERE BELOW.
 *
 * Per the standing rule in this repo (and the two migrations that shipped
 * broken by ignoring it), `grep -r "BEFORE UPDATE ON" server/db/schema/
 * server/migrations/` was run before a line of this was written: 32 append-only
 * UPDATE guards exist across the schema modules and migrations 007, 008, 023,
 * 027, 028, 031, 032 and 034. An UPDATE against any of those tables aborts.
 *
 * This migration issues NO UPDATE at all, against these tables or any other.
 * Both tables here are new, both are created empty, and there is nothing to
 * backfill — which is the cheapest way to be safe on a 9.8 GB production
 * database. See `032_quote_receipt_clock.js` for the correct pattern when a
 * backfill genuinely is needed (drop the trigger, update, recreate it inside
 * the migration's own transaction, and say in a comment why lifting it is
 * legitimate).
 *
 * A capture is evidence about what a book was charging at an instant. Evidence
 * is not edited, so both tables carry no-update and no-delete triggers. A
 * corrected capture is a NEW capture with its own instant.
 */

export function up(db) {
  db.exec(`
    -- One row per (capture run, book). A single scraper run covering FanDuel,
    -- DraftKings and BetMGM writes three rows, so one book failing never
    -- invalidates the other two, and each book's coverage is countable on its
    -- own.
    CREATE TABLE IF NOT EXISTS nfl_alt_spread_captures (
      capture_id TEXT PRIMARY KEY,
      -- The instant the book was observed, from the capture itself.
      captured_at TEXT NOT NULL,
      -- The instant this row was written. Distinct on purpose: a capture read
      -- from a file the next morning was still observed when it was observed.
      imported_at TEXT NOT NULL,
      book TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      source TEXT NOT NULL,
      source_version TEXT,
      -- The only honest label for this path, and the CHECK keeps it that way.
      -- These prices are read off the book's own site by the owner's own
      -- scraper. They are not an aggregator's copy, and they are not a teaser
      -- price. A future provenance value has to be added deliberately here
      -- rather than typed into a payload.
      provenance TEXT NOT NULL CHECK(provenance IN ('direct_book_scrape')),
      games INTEGER NOT NULL,
      quotes INTEGER NOT NULL,
      -- Games present in the payload that carried no alt pair at all. The
      -- Python returns (None,)*8 when an event page fails, so this is the
      -- normal shape of a partial run and has to be counted rather than
      -- silently dropped: coverage computed only from successes is always 100%.
      games_without_alt INTEGER NOT NULL DEFAULT 0,
      payload_sha256 TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alt_spread_captures_book
      ON nfl_alt_spread_captures(book, captured_at DESC);

    -- One row per side per quoted number. A fully captured game contributes
    -- the away main line plus four alt rows (both sides of the +6 number and
    -- both sides of the -6 number), and the home main row too when the source
    -- supplies a home price.
    CREATE TABLE IF NOT EXISTS nfl_alt_spread_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id TEXT NOT NULL REFERENCES nfl_alt_spread_captures(capture_id),
      captured_at TEXT NOT NULL,
      -- When this particular number was seen. FanDuel's alt lines come from a
      -- SECOND request (an event-page fetch) issued after the main board was
      -- read, so the main line and the alt line are not simultaneous. The gap
      -- is small and usually harmless, and it is exactly the gap in which a
      -- line moves and "six points off the main number" stops being true. It
      -- is recorded rather than assumed away.
      observed_at TEXT NOT NULL,
      book TEXT NOT NULL,
      -- book-feeds.js's key: nfl:<UTC kickoff date>:<AWAY>@<HOME>. This is the
      -- key nfl_line_snapshots and the quote tape use, so an alt quote joins
      -- the rest of the system without translation.
      event_key TEXT NOT NULL,
      -- nfl-contract-key.js's key: nfl|<EASTERN date>|<AWAY>@<HOME>. Both are
      -- stored because they DISAGREE, by design, on exactly the games that
      -- matter: four of week 1's sixteen kick off after 8pm Eastern and so
      -- carry a UTC date one day later than their 'gameday'. Neither key is
      -- wrong; joining on the wrong one for the reader is.
      contract_event_key TEXT NOT NULL,
      commence_time TEXT NOT NULL,
      away_team TEXT NOT NULL,
      home_team TEXT NOT NULL,
      -- How the kickoff was established: matched against game_lines on the
      -- TEAM PAIR (never the date), or taken from the book when no scheduled
      -- game matched.
      schedule_source TEXT NOT NULL CHECK(schedule_source IN ('game_lines_team_pair','book_reported')),
      season INTEGER,
      week INTEGER,
      side TEXT NOT NULL CHECK(side IN ('home','away')),
      team TEXT NOT NULL,
      market TEXT NOT NULL CHECK(market IN ('main_spread','alt_spread')),
      -- What was asked for, from THIS team's point of view: 0 for the main
      -- line, +6 for the teaser direction, -6 for the opposite one.
      requested_move REAL NOT NULL,
      -- What the book actually offered: alt line minus this side's main line.
      -- NULL on a main row. This is not decoration. _parse_alt_spreads()'s
      -- find_pair() walks deltas of 0, +/-0.5 and +/-1 looking for a pair that
      -- exists on the board, so a value recorded as "the six-point alt" can be
      -- a 5.5-, 6.5- or 7-point move. Comparing a 5-point move to a six-point
      -- teaser is a different bet, and this column is how anyone notices.
      observed_move REAL,
      line REAL NOT NULL,
      price INTEGER NOT NULL,
      -- This side's main line at capture, so a row is self-describing.
      main_line REAL NOT NULL,
      -- 1 when the main line was mirrored from the other side rather than
      -- quoted. Mirroring a spread LINE is definitional (home -3.5 is away
      -- +3.5); mirroring a PRICE is not, and is never done.
      main_line_derived INTEGER NOT NULL DEFAULT 0,
      -- crossesBothKeyNumbers(main_line, observed_move) — the repo's own
      -- definition, evaluated at the move the book actually gave.
      crosses_both INTEGER NOT NULL DEFAULT 0,
      -- 1 only when this is the same leg a real teaser would produce: main
      -- line in the measured eight AND the observed move is exactly +6.
      teaser_equivalent_leg INTEGER NOT NULL DEFAULT 0,
      UNIQUE(capture_id, event_key, side, market, requested_move)
    );
    CREATE INDEX IF NOT EXISTS idx_alt_spread_quotes_event
      ON nfl_alt_spread_quotes(event_key, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alt_spread_quotes_teaser_legs
      ON nfl_alt_spread_quotes(book, teaser_equivalent_leg, captured_at DESC);

    CREATE TRIGGER IF NOT EXISTS nfl_alt_spread_captures_no_update
      BEFORE UPDATE ON nfl_alt_spread_captures
      BEGIN SELECT RAISE(ABORT, 'alt spread captures are append-only — import a new capture instead of editing one'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_alt_spread_captures_no_delete
      BEFORE DELETE ON nfl_alt_spread_captures
      BEGIN SELECT RAISE(ABORT, 'alt spread captures are append-only — a capture that happened cannot be un-happened'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_alt_spread_quotes_no_update
      BEFORE UPDATE ON nfl_alt_spread_quotes
      BEGIN SELECT RAISE(ABORT, 'alt spread quotes are append-only — import a new capture instead of editing one'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_alt_spread_quotes_no_delete
      BEFORE DELETE ON nfl_alt_spread_quotes
      BEGIN SELECT RAISE(ABORT, 'alt spread quotes are append-only — a quote that was observed cannot be un-observed'); END;
  `);

  // THE FENCE.
  //
  // `teaser-scan.js` refuses to emit a single candidate when
  // `nfl_teaser_price_ledger` holds no reachable price. That refusal is
  // correct, and it is also a standing temptation: the fastest way to make the
  // scanner produce output is to put SOME price in the ledger, and after this
  // migration ships there will be a table full of alt prices sitting right
  // there looking like the answer.
  //
  // They are not the answer. An alt-derived parlay equivalent is a comparison
  // against a teaser price, not an observation of one, and a ledger row is read
  // downstream as "this is what the book charges for the teaser". So the one
  // route a careful person would actually take — inserting the derived number
  // and labelling it honestly — is made to fail loudly.
  //
  // This is deliberately narrow. It fires only on the marker string this
  // system emits (`alt_spread_six_point_quote`) or a book name that says "alt
  // spread". Every existing ledger row, and every hand-typed one, passes
  // untouched: the sole row in the live ledger carries a NULL `notes`, and
  // `COALESCE(...) LIKE` on a NULL yields no match.
  //
  // It cannot stop code that lies about what it is inserting. Nothing can. The
  // real guarantee is structural — `alt-spread-import.js` does not reference
  // `nfl_teaser_price_ledger` at all — and this backstops the honest mistake,
  // which is the one that actually happens.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS nfl_teaser_price_ledger_no_alt_spread
      BEFORE INSERT ON nfl_teaser_price_ledger
      WHEN COALESCE(NEW.notes,'') LIKE '%alt_spread_six_point_quote%'
        OR COALESCE(NEW.push_rule,'') LIKE '%alt_spread_six_point_quote%'
        OR lower(COALESCE(NEW.book,'')) LIKE '%alt_spread%'
        OR lower(COALESCE(NEW.book,'')) LIKE '%alt spread%'
      BEGIN
        SELECT RAISE(ABORT,
          'an alternate-spread price is not a teaser price — nfl_teaser_price_ledger records what a book charges for the teaser product itself; record alt quotes in nfl_alt_spread_quotes and compare with altParlayEquivalent()');
      END;
  `);
}

export function down(db) {
  const captures = db.prepare(`SELECT COUNT(*) n FROM nfl_alt_spread_captures`).get()?.n ?? 0;
  const quotes = db.prepare(`SELECT COUNT(*) n FROM nfl_alt_spread_quotes`).get()?.n ?? 0;
  if (captures || quotes) {
    throw new Error(
      `035_alt_spread_capture: refusing to downgrade — ${captures} capture(s) and ${quotes} quote(s) are ` +
      'recorded. These are observations of what a book was charging at an instant that has passed; they ' +
      'cannot be re-observed, and the price they measure is the single unmeasured input in the teaser ' +
      'strategy. Export them before dropping the tables.');
  }
  db.exec(`
    DROP TRIGGER IF EXISTS nfl_teaser_price_ledger_no_alt_spread;
    DROP TRIGGER IF EXISTS nfl_alt_spread_quotes_no_delete;
    DROP TRIGGER IF EXISTS nfl_alt_spread_quotes_no_update;
    DROP TRIGGER IF EXISTS nfl_alt_spread_captures_no_delete;
    DROP TRIGGER IF EXISTS nfl_alt_spread_captures_no_update;
    DROP INDEX IF EXISTS idx_alt_spread_quotes_teaser_legs;
    DROP INDEX IF EXISTS idx_alt_spread_quotes_event;
    DROP INDEX IF EXISTS idx_alt_spread_captures_book;
    DROP TABLE IF EXISTS nfl_alt_spread_quotes;
    DROP TABLE IF EXISTS nfl_alt_spread_captures;
  `);
}
