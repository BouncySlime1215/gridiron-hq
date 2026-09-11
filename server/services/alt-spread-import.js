/**
 * Alternate-spread capture import — the missing price measurement, and a hard
 * line around what it does and does not measure.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * The two-team six-point teaser strategy in `server/betting/nfl/strategy/` is
 * measured at every point except the one where money changes hands. The leg
 * rate is 74.06% over 2,894 legs on eight cross-both numbers. The pairing, the
 * push split and the ticket EV are all derived. The PRICE — what a book
 * actually charges for the teaser — comes from `nfl_teaser_price_ledger`, which
 * holds a single row somebody typed in by hand. The strategy swings from +6.7%
 * to -1.1% per ticket between -110 and -130, so that one number decides
 * everything and has essentially never been observed.
 *
 * `live_odds.py` already reads the closest thing that exists: per game, per
 * book, the alternate spread six points either side of the main number, WITH
 * ITS PRICE. It renders a terminal table and exits — it persists nothing. This
 * module is where a capture can land instead.
 *
 * ===========================================================================
 * AN ALT PRICE IS NOT A TEASER PRICE. KEEP THIS SHARP.
 * ===========================================================================
 *
 * A six-point teaser is a fixed-price product: one quoted price for moving
 * every leg six points, which is the number `nfl_teaser_price_ledger` records.
 * An alternate spread is an ordinary single bet on a line the book has already
 * moved, priced individually. Two different products.
 *
 * What is directly comparable is a PARLAY of two alt legs against a two-team
 * teaser. Both are one stake needing both games, at lines six points off the
 * main number. `altParlayEquivalent()` does that arithmetic. If an alt sits at
 * -250 a side, two parlayed return a profit multiple of 0.96 — American -104 —
 * which sits right beside the owner's recorded +100 teaser (multiple 1.00).
 * Whichever is better is the play, and neither is knowable without the capture.
 *
 * So: a comparison, always. Never a substitute recording. This module does not
 * import, reference or write `nfl_teaser_price_ledger`, and migration 035 adds
 * a trigger that aborts an insert into that ledger carrying this system's
 * marker. See `HOW FAR THE COMPARISON GOES` at the bottom of this file for the
 * places it stops being valid.
 *
 * ===========================================================================
 * THE PYTHON SIDE, DOCUMENTED FROM READING IT
 * ===========================================================================
 *
 * `live_odds.py` was read, not run. It drives real sportsbook sites through Tor
 * with fingerprint evasion; running it is the owner's decision. Nothing about
 * that machinery is reproduced here. What follows is the parsing contract this
 * importer has to accept.
 *
 * --- FanDuel (`_parse_fd`, competition-page JSON) --------------------------
 * Shape: `body.attachments.events` (map of eventId -> {name, openDate}) and
 * `body.attachments.markets` (map of marketId -> {marketType, eventId,
 * runners[]}). Event `name` is "Away Full Name @ Home Full Name", split on
 * " @ ". Prices live at
 * `runner.winRunnerOdds.americanDisplayOdds.americanOdds` (already a signed
 * integer). The spread comes from the runner whose `result.type == "AWAY"`,
 * taking `runner.handicap` — so FanDuel's `Side.spread` is the AWAY number, and
 * the HOME price is never read. Moneyline is away-only. Total is over-only.
 *
 * --- FanDuel alt spreads (`_parse_alt_spreads`, event-page JSON) -----------
 * A SECOND request per game, triggered by an SPA `history.pushState` and caught
 * off the `event-page` response. Markets with `marketType ==
 * "ALTERNATE_HANDICAP"`; each runner's line is scraped out of `runnerName` with
 * the regex /\(([+-]?[\d.]+)\)/ — i.e. the number in parentheses inside the
 * display name — and filed under the key `(result.type, line)`.
 *
 * --- Locating the +/-6 pair (`find_pair`) ---------------------------------
 * Given the away main spread A, it wants away at A+6 and home at -(A+6), then
 * away at A-6 and home at -(A-6). It walks `delta` over [0, 0.5, -0.5, 1, -1]
 * and returns the FIRST delta at which BOTH the away key (A+6+delta) and the
 * mirrored home key (-(A+6)-delta) exist on the board. Two consequences this
 * importer has to handle:
 *   1. The pair is always mirrored (home key is the negation of the away key),
 *      so a captured pair is genuinely two sides of one number.
 *   2. A non-zero delta means the recorded "six-point alt" is a 5.5-, 6.5- or
 *      7-point move. Recording that as a six-point quote would silently compare
 *      a different bet to the teaser. Hence `observed_move` on every row.
 *
 * --- Sign convention, and the field-name trap -----------------------------
 * `Side.spread` is the AWAY spread. The eight returned values map as:
 *   alt_a_p6  = away line at A+6      <- the AWAY team's TEASER leg
 *   alt_h_p6  = home line at -(A+6)   <- home moved 6 AGAINST itself
 *   alt_a_m6  = away line at A-6      <- away moved 6 AGAINST itself
 *   alt_h_m6  = home line at -(A-6)   <- the HOME team's TEASER leg
 * The trap: the home team's teaser leg lives in the fields named `_m6`. Half
 * the value of this module is refusing to carry that confusion forward, so the
 * JSON contract names every leg by the direction of the move FOR THAT TEAM:
 * `away_plus6`, `home_minus6`, `away_minus6`, `home_plus6`.
 *
 * --- DraftKings (`_parse_dk`) ---------------------------------------------
 * Shape: `body.eventGroup.events[]` ({eventId, name, startDate}) plus a
 * separate `offerCategories[] -> offerSubcategoryDescriptors[] ->
 * offerSubcategory.offers[][]` (a list of lists) indexed back to events by
 * `offer.eventId`. Category names are matched by lower-cased substring
 * ("moneyline", "spread", "total"). Within an outcome, the side is decided by
 * `away.lower() in outcome.label.lower()` — a substring test against the FULL
 * away team name. `line` is a float, `oddsAmerican` a string with a leading "+"
 * stripped. NO alt spreads are parsed for DraftKings at all; `Side.alt_*` stays
 * None for every DK game. That is the single largest coverage gap, and it is on
 * the book whose teaser price is the one already in the ledger.
 *
 * --- BetMGM (`_parse_mgm`) ------------------------------------------------
 * Shape: a list of fixtures, or `{fixtures|events|data: [...]}`. Each fixture
 * has `participants[]` with `homeAway` and a `name` that is either a string or
 * `{value}`; `markets[] -> selections[]` with the same string-or-{value}
 * shape for names, `price.americanOdds` (or `price.a`), and `handicap` or
 * `line`. Side selection is again `away.lower() in selection_name.lower()`.
 * NO alt spreads are parsed for BetMGM either.
 *
 * --- Team naming (`_abbr`, `_slug`) — the important one -------------------
 * `_abbr(team)` returns the LAST WORD of the team name, first three characters,
 * upper-cased. That is a NICKNAME code, and it is not this repo's code. Run
 * against `nfl_teams`, exactly ONE of the 32 agrees (SEA), and three of the
 * results are actively dangerous:
 *     Arizona Cardinals   -> CAR   (this repo's CAR is Carolina)
 *     Kansas City Chiefs  -> CHI   (this repo's CHI is Chicago)
 *     Cleveland Browns    -> BRO  and  Denver Broncos -> BRO
 *     San Francisco 49ers -> 49E   (starts with a digit)
 * `merge()` builds its game keys out of `_abbr`, so those keys are usable for
 * merging three books inside that script and for nothing else. THIS IMPORTER
 * NEVER ACCEPTS A THREE-LETTER CODE FROM THE SCRAPER. The JSON contract carries
 * full team names, resolved here through `teamResolver()`, which is the repo's
 * one franchise map. `scraperAbbreviationAudit()` below reproduces the whole
 * collision table on demand.
 *
 * `_slug(team)` lower-cases, turns spaces into hyphens and drops periods; it is
 * only used to build a FanDuel event URL and never reaches this importer.
 *
 * --- `merge()` ------------------------------------------------------------
 * Unions the three books' `_abbr` keys and takes home/away/start from the first
 * book that has the game (FanDuel, then DraftKings, then BetMGM). It never
 * checks that the books agree on the teams or the kickoff, so if two books
 * spell a franchise differently the game splits into two entries each holding
 * one book's numbers. The contract below is therefore emitted PER BOOK, and
 * this importer resolves and keys each book's games independently.
 *
 * ===========================================================================
 * FRAGILITIES WORTH NAMING (all read out of the Python, none fixed here)
 * ===========================================================================
 *  - The alt line is recovered from a DISPLAY STRING by regex. A FanDuel
 *    copy change that drops the parentheses turns every alt into None with no
 *    error anywhere.
 *  - `find_pair`'s delta walk silently substitutes a 5.5/6.5/7-point move for
 *    the six-point one it was asked for.
 *  - Main lines and alt lines are captured in SEPARATE requests, so they are
 *    not simultaneous; the contract carries `alt_observed_at` for that reason.
 *  - Only the AWAY side of the main spread is parsed, on all three books, so
 *    the home main PRICE is never captured. The home main LINE is mirrored
 *    here (definitional); the home main price is never invented.
 *  - Side selection on DK and MGM is a substring test against the full team
 *    name. If a book shortens a label ("Cowboys -7" rather than "Dallas
 *    Cowboys -7") the spread comes back None rather than wrong — quiet, but at
 *    least not misleading.
 *  - MGM's `hcap = s.get("handicap") or s.get("line")` treats a handicap of 0
 *    as absent, so a pick'em spread is dropped.
 *  - Price coercion is `int(str(raw).replace("+",""))` on DK and `int(raw)` on
 *    MGM: a Unicode minus sign or a literal "EVEN" raises and the outcome is
 *    skipped.
 */
import crypto from 'node:crypto';
import { db, rows, row, run } from '../db/index.js';
import { teamResolver } from './team-codes.js';
import { nflKickoffDate } from './date-util.js';
import { eventKey as contractEventKey, easternGameDate } from './nfl-contract-key.js';
import { CROSS_BOTH_LINES, crossesBothKeyNumbers, profitMultiple, toAmerican, TEASER_POINTS }
  from '../betting/nfl/strategy/teaser-leg-rates.js';

/* ======================================================================== */
/* Constants                                                                */
/* ======================================================================== */

export const ALT_SPREAD_IMPORT_VERSION = 'nfl-alt-spread-import-v1';

/** The schema string a payload must declare. Bump only with a new importer. */
export const ALT_SPREAD_CAPTURE_SCHEMA = 'gridiron.alt_spread_capture.v1';

/**
 * The only provenance this path may claim, and it is the honest one: these
 * prices are read off the book's own site by the owner's own scraper. Not an
 * aggregator's copy of a book, and not a teaser price.
 */
export const ALT_SPREAD_PROVENANCE = 'direct_book_scrape';

/**
 * The marker migration 035's ledger trigger watches for. Anything derived from
 * an alt quote carries it, so an attempt to file a derived number as a teaser
 * price aborts at the database rather than succeeding quietly.
 */
export const ALT_SPREAD_LEDGER_MARKER = 'alt_spread_six_point_quote';

const CROSS_BOTH_SET = new Set(CROSS_BOTH_LINES);

/** Half-point grid check, same rule nfl-contract-key.js applies to a spread. */
const isHalfPoint = value => Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
const EPS = 1e-9;
const near = (a, b) => Math.abs(a - b) < 1e-6;

/** American prices a real book can post. Alt spreads run deep; teasers do not. */
const MIN_PRICE_MAGNITUDE = 100;
const MAX_PRICE_MAGNITUDE = 100000;
/** A spread outside this is a parse failure, not a line. Matches MARKETS.spreads. */
const SPREAD_BOUNDS = [-60, 60];
/** How far ahead of `now` a capture instant may sit before it is not an observation. */
const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * The four alt legs, named by the direction of the move FOR THAT TEAM, with the
 * `live_odds.py` field each one comes from. `mirror` names the entry that must
 * hold the negation of the same number.
 */
export const ALT_LEG_SPECS = Object.freeze({
  away_plus6: Object.freeze({ side: 'away', requested_move: 6, python: 'alt_a_p6', mirror: 'home_minus6' }),
  home_minus6: Object.freeze({ side: 'home', requested_move: -6, python: 'alt_h_p6', mirror: 'away_plus6' }),
  away_minus6: Object.freeze({ side: 'away', requested_move: -6, python: 'alt_a_m6', mirror: 'home_plus6' }),
  home_plus6: Object.freeze({ side: 'home', requested_move: 6, python: 'alt_h_m6', mirror: 'away_minus6' })
});

/** The two mirrored pairs, as [teaser-direction leg, opposite leg]. */
const ALT_PAIRS = Object.freeze([
  Object.freeze(['away_plus6', 'home_minus6']),
  Object.freeze(['home_plus6', 'away_minus6'])
]);

/* ======================================================================== */
/* The hand-off contract                                                    */
/* ======================================================================== */

/**
 * ONE CAPTURE RUN, AS JSON.
 *
 * Written down as a constant rather than as prose so the Python side has a
 * fixed target and this importer has one thing to validate against. Deliberately
 * small: run stamp, book, and per game the teams, the kickoff, the main line
 * with its price, and the four alt legs with theirs.
 *
 * Three rules are load-bearing:
 *
 *   1. TEAMS ARE FULL NAMES. Never the scraper's three-letter `_abbr` key —
 *      see the header: it maps Cardinals to CAR and Chiefs to CHI, both of
 *      which mean a different franchise in this repo.
 *   2. LEGS ARE NAMED BY DIRECTION OF MOVE FOR THAT TEAM, not by the Python
 *      field name. The home team's teaser leg is `home_plus6`, which the Python
 *      keeps in `alt_h_m6`.
 *   3. PRICES ARE INTEGERS. American, signed, |price| >= 100. A null price is
 *      an absent quote and the whole pair is dropped; it is never a zero.
 *
 * Everything a book failed to capture is simply absent. Absence is normal and
 * is counted; a present-but-wrong value is an error and is refused.
 */
export const ALT_SPREAD_CAPTURE_CONTRACT = Object.freeze({
  schema: ALT_SPREAD_CAPTURE_SCHEMA,
  description: 'One alternate-spread capture run, one file. Emitted by live_odds.py, imported by importAltSpreadCapture().',
  envelope: Object.freeze({
    schema: 'required string, exactly "gridiron.alt_spread_capture.v1"',
    captured_at: 'required ISO-8601 instant, UTC, when the books were read. Not in the future.',
    source: 'required string naming the producer, e.g. "live_odds.py"',
    source_version: 'optional string — a git sha or a date, so a parser change is attributable',
    provenance: 'required, exactly "direct_book_scrape". The only honest label for this path.',
    note: 'optional free text carried onto the capture row',
    books: 'required non-empty array of book blocks'
  }),
  book_block: Object.freeze({
    book: 'required string; normalised to lower-case alphanumerics (fanduel, draftkings, betmgm)',
    games: 'required non-empty array of game blocks'
  }),
  game_block: Object.freeze({
    away_team: 'required FULL team name as the book spells it, e.g. "Dallas Cowboys"',
    home_team: 'required FULL team name',
    kickoff: 'required ISO-8601 instant as the book reports it',
    alt_observed_at: 'optional ISO-8601 instant the alt legs were read, when it differs from captured_at',
    main: Object.freeze({
      away: 'required { line: number on the half-point grid, price: signed integer }',
      home: 'optional { line, price }. line must mirror away exactly. Omit it rather than guessing a price.'
    }),
    alt_six: Object.freeze({
      away_plus6: 'optional { line, price } — away main + 6. live_odds.py alt_a_p6. THE AWAY TEASER LEG.',
      home_minus6: 'optional { line, price } — home main - 6. live_odds.py alt_h_p6. Mirrors away_plus6.',
      home_plus6: 'optional { line, price } — home main + 6. live_odds.py alt_h_m6. THE HOME TEASER LEG.',
      away_minus6: 'optional { line, price } — away main - 6. live_odds.py alt_a_m6. Mirrors home_plus6.',
      _pairs: 'away_plus6 and home_minus6 are two sides of one number, as are home_plus6 and away_minus6. Each pair is all-or-nothing.'
    })
  }),
  example: Object.freeze({
    schema: ALT_SPREAD_CAPTURE_SCHEMA,
    captured_at: '2026-09-11T18:04:11Z',
    source: 'live_odds.py',
    provenance: ALT_SPREAD_PROVENANCE,
    books: [{
      book: 'fanduel',
      games: [{
        away_team: 'Dallas Cowboys',
        home_team: 'New York Giants',
        kickoff: '2026-09-14T00:20:00Z',
        main: { away: { line: -7.5, price: -110 } },
        alt_six: {
          away_plus6: { line: -1.5, price: -260 },
          home_minus6: { line: 1.5, price: 210 },
          away_minus6: { line: -13.5, price: 260 },
          home_plus6: { line: 13.5, price: -320 }
        }
      }]
    }]
  })
});

/**
 * The exact addition to `live_odds.py` that emits the contract above.
 *
 * Kept here so it lives beside the validator that has to accept it. NOT applied
 * to the Python file by this work — that file is the owner's, and a scraper
 * that persists is a different operational decision from one that prints.
 *
 * It adds a `--json PATH` flag and touches nothing else: no new request, no
 * change to any parser, no change to the default behaviour.
 */
export const PYTHON_EMITTER_SNIPPET = `
# ─── JSON hand-off for the Gridiron importer ─────────────────────────────────
# Adds "--json PATH". Changes no parsing and issues no extra request.
CAPTURE_SCHEMA = "gridiron.alt_spread_capture.v1"

def _leg(line, price):
    return None if line is None or price is None else {"line": float(line), "price": int(price)}

def _book_game(g: Game, s: Side) -> Optional[dict]:
    if s.spread is None or s.spread_price is None:
        return None
    alt = {}
    # away_plus6 / home_minus6 are the two sides of the SAME number (alt_a_p6 /
    # alt_h_p6); home_plus6 / away_minus6 are the two sides of the other one
    # (alt_h_m6 / alt_a_m6). The home team's TEASER leg is alt_h_m6.
    ap6, hm6 = _leg(s.alt_a_p6, s.alt_a_p6_price), _leg(s.alt_h_p6, s.alt_h_p6_price)
    if ap6 and hm6:
        alt["away_plus6"], alt["home_minus6"] = ap6, hm6
    am6, hp6 = _leg(s.alt_a_m6, s.alt_a_m6_price), _leg(s.alt_h_m6, s.alt_h_m6_price)
    if am6 and hp6:
        alt["away_minus6"], alt["home_plus6"] = am6, hp6
    if not alt:
        return None
    return {"away_team": g.away, "home_team": g.home, "kickoff": g.start,
            "main": {"away": {"line": float(s.spread), "price": int(s.spread_price)}},
            "alt_six": alt}

def capture_payload(games: list[Game]) -> dict:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    books = []
    for book, attr in (("fanduel", "fd"), ("draftkings", "dk"), ("betmgm", "mgm")):
        entries = [e for e in (_book_game(g, getattr(g, attr)) for g in games) if e]
        if entries:
            books.append({"book": book, "games": entries})
    return {"schema": CAPTURE_SCHEMA, "captured_at": now, "source": "live_odds.py",
            "provenance": "direct_book_scrape", "books": books}

# ... and inside main(), right after the games are built:
#
#         if "--json" in sys.argv:
#             path = sys.argv[sys.argv.index("--json") + 1]
#             with open(path, "w") as fh:
#                 json.dump(capture_payload(games), fh, indent=2)
#             console.log(f"[green]wrote capture to {path}[/green]")
`.trim();

/* ======================================================================== */
/* Franchise-name consistency                                               */
/* ======================================================================== */

/**
 * Does this name contain a word that belongs to a DIFFERENT franchise?
 *
 * `teamResolver()` resolves on whichever token it can match, which means the
 * city half of a name is not checked at all. "Cleveland Broncos" resolves to
 * Denver. For a shared resolver that leniency is defensible; for an importer
 * writing prices keyed by franchise it is not, because the resulting row is
 * wrong rather than missing.
 *
 * Only tokens that identify exactly ONE franchise can contradict. "New" and
 * "York" are shared, so "New York Giants" is accepted; "Cleveland" is unique to
 * CLE, so "Cleveland Broncos" is refused. Tokens the map has never seen — "LA"
 * in "LA Rams", say — are ignored, so a book's shorthand still resolves.
 */
let distinctiveTokens = null;
function tokenOwners({ database = db } = {}) {
  if (distinctiveTokens) return distinctiveTokens;
  const owners = new Map();
  for (const team of database.prepare('SELECT abbr, name FROM nfl_teams').all()) {
    for (const token of String(team.name).toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!owners.has(token)) owners.set(token, new Set());
      owners.get(token).add(team.abbr);
    }
  }
  distinctiveTokens = new Map([...owners.entries()]
    .filter(([, abbrs]) => abbrs.size === 1)
    .map(([token, abbrs]) => [token, [...abbrs][0]]));
  return distinctiveTokens;
}

export function clearTokenOwnerCache() { distinctiveTokens = null; }

export function contradictingToken(name, team, { database = db } = {}) {
  const owners = tokenOwners({ database });
  for (const token of String(name ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
    const abbr = owners.get(token);
    if (abbr && abbr !== team.abbr) return { token, abbr };
  }
  return null;
}

/* ======================================================================== */
/* Errors                                                                   */
/* ======================================================================== */

/** Carries every specific reason, not just the first one found. */
export class AltSpreadCaptureError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'AltSpreadCaptureError';
    this.errors = errors;
  }
}

/* ======================================================================== */
/* Team-code audit                                                          */
/* ======================================================================== */

/** `live_odds.py`'s `_abbr`, reproduced exactly, so the audit is real. */
export function scraperAbbr(teamName) {
  const words = String(teamName ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length ? words[words.length - 1].slice(0, 3).toUpperCase() : 'UNK';
}

/**
 * Does the scraper's three-letter key ever mean what this repo means by it?
 *
 * Answer, on the 32 rows of `nfl_teams`: once. Every other franchise gets a
 * nickname code, two franchises collide with each other, and two collide with a
 * DIFFERENT franchise's real code in this database. Which is why the contract
 * carries full names and this importer refuses codes.
 */
export function scraperAbbreviationAudit({ database = db } = {}) {
  const teams = database.prepare('SELECT abbr, name FROM nfl_teams ORDER BY abbr').all();
  const repoCodes = new Set(teams.map(t => t.abbr));
  const byScraperCode = new Map();
  const entries = teams.map(t => {
    const scraper = scraperAbbr(t.name);
    if (!byScraperCode.has(scraper)) byScraperCode.set(scraper, []);
    byScraperCode.get(scraper).push(t.abbr);
    return { repo_abbr: t.abbr, name: t.name, scraper_abbr: scraper, matches: scraper === t.abbr };
  });
  return {
    teams: entries.length,
    matching: entries.filter(e => e.matches).map(e => e.repo_abbr),
    mismatched: entries.filter(e => !e.matches).length,
    // Two different franchises producing one scraper code: inside the scraper
    // these two games can collide on a merge key.
    internal_collisions: [...byScraperCode.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([code, list]) => ({ scraper_abbr: code, franchises: list })),
    // A scraper code that is some OTHER franchise's real code here. The
    // dangerous class: it resolves, and it resolves to the wrong team.
    aliases_another_franchise: entries
      .filter(e => !e.matches && repoCodes.has(e.scraper_abbr))
      .map(e => ({ name: e.name, repo_abbr: e.repo_abbr, scraper_abbr: e.scraper_abbr,
        means_here: teams.find(t => t.abbr === e.scraper_abbr)?.name ?? null })),
    entries,
    conclusion: 'The scraper key is a nickname code and is never a valid team code in this database. ' +
      'The JSON contract carries full team names; teamResolver() is the only accepted route to an abbr.'
  };
}

/* ======================================================================== */
/* Keys and schedule                                                        */
/* ======================================================================== */

/**
 * `book-feeds.js`'s event key, character for character:
 *   nfl:<first 10 chars of the UTC commence time>:<AWAY>@<HOME>
 *
 * Duplicated rather than imported so this module has no dependency on a feed
 * module's private `__test` export — and `test/alt-spread-import.test.js`
 * asserts the two agree, which is the part that actually keeps them in step.
 */
export function eventKeyFor(commenceTime, away, home) {
  return `nfl:${String(commenceTime ?? '').slice(0, 10)}:${away}@${home}`;
}

/**
 * Find the scheduled game for a captured one, BY TEAM PAIR ONLY.
 *
 * The date is deliberately not part of the match, and this is not fussiness.
 * `game_lines.gameday` is an EASTERN date; the event key is built from the UTC
 * one. In week 1 of 2026 four of the sixteen games kick off at 8pm Eastern or
 * later, so their UTC date is the NEXT DAY:
 *
 *     NE @ SEA  gameday 2026-09-09 20:20 ET  ->  nfl:2026-09-10:NE@SEA
 *     SF @ LAR  gameday 2026-09-10 20:35 ET  ->  nfl:2026-09-11:SF@LAR
 *     DAL @ NYG gameday 2026-09-13 20:20 ET  ->  nfl:2026-09-14:DAL@NYG
 *     DEN @ KC  gameday 2026-09-14 20:15 ET  ->  nfl:2026-09-15:DEN@KC
 *
 * (Verified against `nfl_line_snapshots` on the live database: those four keys
 * are exactly the ones present with the later date.) A join that pins the date
 * loses a quarter of the slate — and loses it on Sunday and Monday night, which
 * is where the standalone games and the sharpest numbers are.
 *
 * A team pair is unique within any plausible window, so the pair alone is a
 * safe key; the reported kickoff is used only to pick the nearest match and to
 * measure drift.
 */
export function resolveScheduledGame({ away, home, kickoff }, { database = db, windowHours = 60 } = {}) {
  const candidates = database.prepare(
    `SELECT season, week, gameday, gametime FROM game_lines
      WHERE home = 1 AND team = ? AND opponent = ?`).all(home, away);
  const reported = Date.parse(kickoff);
  let best = null;
  for (const c of candidates) {
    const at = nflKickoffDate(c.gameday, c.gametime);
    if (!at) continue;
    const driftMs = Math.abs(at.getTime() - reported);
    if (!Number.isFinite(driftMs)) continue;
    if (!best || driftMs < best.driftMs) best = { ...c, at, driftMs };
  }
  if (!best || best.driftMs > windowHours * 3600_000) {
    return { matched: false, reason: best ? 'nearest_scheduled_game_out_of_window' : 'no_scheduled_game_for_team_pair',
      kickoff: new Date(reported).toISOString(), season: null, week: null, drift_minutes: null };
  }
  return {
    matched: true, reason: null,
    // The repo's own kickoff wins, so the key matches every other table.
    kickoff: best.at.toISOString(),
    season: best.season, week: best.week,
    gameday: best.gameday, gametime: best.gametime,
    drift_minutes: Math.round(best.driftMs / 60000)
  };
}

/* ======================================================================== */
/* The synthetic teaser comparison                                          */
/* ======================================================================== */

/**
 * The American price of parlaying two alternate-spread legs.
 *
 * This is the number to hold up next to a recorded two-team teaser price. It is
 * NOT a teaser price and must never be written into `nfl_teaser_price_ledger` —
 * every field below says so, and migration 035 enforces it at the database.
 *
 * The arithmetic, spelled out because the American notation confuses it: a leg
 * at -250 has a profit multiple of 100/250 = 0.4, so a decimal payout of 1.4.
 * Two of them parlay to 1.4 x 1.4 = 1.96 decimal, a profit multiple of 0.96 —
 * stake 100, get 196 back, 96 of it profit. In American notation a multiple
 * below 1 is a negative price, so that is -104.17, not "+96". Both are
 * returned, because "+96" is how the profit reads per 100 staked and -104 is
 * how a book would post it, and comparing the wrong one to a +100 teaser
 * (multiple 1.00) is exactly the mistake this function exists to prevent.
 */
export function altParlayEquivalent({ legAPrice, legBPrice } = {}) {
  const legs = [legAPrice, legBPrice];
  for (const [i, price] of legs.entries()) {
    if (!Number.isInteger(price)) {
      throw new TypeError(`leg ${i === 0 ? 'A' : 'B'} price must be an integer American price, got ${price}`);
    }
    if (Math.abs(price) < MIN_PRICE_MAGNITUDE || Math.abs(price) > MAX_PRICE_MAGNITUDE) {
      throw new RangeError(`leg ${i === 0 ? 'A' : 'B'} price ${price} is outside ` +
        `+/-${MIN_PRICE_MAGNITUDE}..${MAX_PRICE_MAGNITUDE}`);
    }
  }
  const decimals = legs.map(price => 1 + profitMultiple(price));
  const decimal = decimals[0] * decimals[1];
  const profit = decimal - 1;
  return {
    leg_prices: legs,
    leg_decimals: decimals,
    decimal,
    profit_multiple: profit,
    /** Profit per 100 staked. This is the "+96" number in the informal telling. */
    profit_per_100: profit * 100,
    /** How a book would actually post this parlay. Compare THIS to a teaser price. */
    american: toAmerican(profit),
    is_teaser_price: false,
    ledger_eligible: false,
    marker: ALT_SPREAD_LEDGER_MARKER,
    compare_against: 'nfl_teaser_price_ledger row with teaser_points = 6, legs = 2, reachable = 1',
    caveat: 'A parlay of two alt legs and a two-team teaser are different products with the same shape. ' +
      'They differ on push handling (a teaser push reduces to the book\'s one-leg TEASER price; a parlay ' +
      'push drops the leg and pays the survivor at its own alt price), on limits, and on whether the alt ' +
      'line is exactly six points off the main number. Use this to decide which to bet, never to fill in ' +
      'a teaser price that was not observed.'
  };
}

/**
 * Is this alt quote the same leg a six-point teaser would produce?
 *
 * The eight cross-both numbers are POSTED lines: -8.5/-8/-7.5/-7 and
 * +1.5/+2/+2.5/+3. A teaser takes one of them and moves it six points, landing
 * on -2.5/-2/-1.5/-1 and +7.5/+8/+8.5/+9. So an alt leg reproduces a teaser leg
 * when two things hold: the side's MAIN line is one of the eight, and the alt
 * actually moves it by six.
 *
 * The verdict is keyed to membership in `CROSS_BOTH_LINES` rather than to a
 * second, locally invented crossing rule. That set is the solution of one
 * inequality (see teaser-leg-rates.js) and it is the population the 74.06% was
 * measured on; a leg outside it has no measured rate here whatever else is true
 * about it.
 *
 * `crosses_both_key_numbers` is reported separately and IS recomputed, at the
 * move the book actually gave — `crossesBothKeyNumbers(mainLine, observedMove)`
 * — because when `find_pair` substitutes a 5.5- or 6.5-point move, whether that
 * move still crosses 3 and 7 is a real question with a real answer.
 */
export function altLegTeaserEquivalence({ mainLine, altLine, points = TEASER_POINTS } = {}) {
  if (!Number.isFinite(mainLine) || !Number.isFinite(altLine)) {
    throw new TypeError(`mainLine and altLine must be finite numbers, got ${mainLine} and ${altLine}`);
  }
  const observedMove = Math.round((altLine - mainLine) * 100) / 100;
  const inFamily = CROSS_BOTH_SET.has(mainLine);
  const exactlySix = Math.abs(observedMove - points) < EPS;
  const crossesBoth = observedMove > 0 ? crossesBothKeyNumbers(mainLine, observedMove) : false;
  const sameLeg = inFamily && exactlySix;

  let reason;
  if (sameLeg) reason = 'identical to the leg a six-point teaser produces from this main line';
  else if (!inFamily && !exactlySix) {
    reason = `main line ${mainLine} is not one of the eight cross-both numbers, and the book moved ` +
      `${observedMove} points rather than ${points}`;
  } else if (!inFamily) {
    reason = `main line ${mainLine} is not one of the eight cross-both numbers ` +
      `(${CROSS_BOTH_LINES.join(', ')}), so no measured leg rate applies`;
  } else {
    reason = `the book moved ${observedMove} points, not ${points} — this is a different bet from the ` +
      'teaser leg, and the measured rate does not describe it';
  }

  return {
    main_line: mainLine,
    alt_line: altLine,
    observed_move: observedMove,
    requested_move: exactlySix ? points : null,
    main_line_in_cross_both_family: inFamily,
    move_is_exactly_six: exactlySix,
    crosses_both_key_numbers: crossesBoth,
    /** Where a real teaser would have put this line, for side-by-side reading. */
    teaser_would_reach: Math.round((mainLine + points) * 100) / 100,
    same_leg_a_teaser_produces: sameLeg,
    reason
  };
}

/* ======================================================================== */
/* Validation                                                               */
/* ======================================================================== */

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const normaliseBook = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A bare short code, e.g. "COW", "CAR", "49E".
 *
 * This guard exists because `teamResolver()` does NOT reliably refuse the
 * scraper's `_abbr` output, and the way it fails is the bad way. Measured
 * against `nfl_teams`:
 *
 *     "COW" -> DAL   (containment fallback; right team, by luck)
 *     "GIA" -> NYG   (containment fallback; right team, by luck)
 *     "49E" -> SF    (containment fallback; right team, by luck)
 *     "CAR" -> CAR   Carolina — but "CAR" is the scraper's code for ARIZONA
 *     "CHI" -> CHI   Chicago  — but "CHI" is the scraper's code for KANSAS CITY
 *     "BRO" -> null  (Browns and Broncos, ambiguous, so at least it refuses)
 *
 * Two of those resolve, cleanly, to the wrong franchise. There is no signal
 * downstream that anything went wrong: the row simply describes a different
 * game. So a bare code is refused here BEFORE the resolver ever sees it,
 * rather than trusted to fail. The contract asks for full names for exactly
 * this reason.
 */
const BARE_TEAM_CODE = /^[A-Za-z0-9]{2,4}$/;

function isoInstant(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A `{line, price}` quote, or a specific complaint about why it is not one. */
function readQuote(value, where, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${where}: expected an object of the shape { line, price }, got ${JSON.stringify(value) ?? 'undefined'}`);
    return null;
  }
  const line = value.line;
  const price = value.price;
  let ok = true;
  if (typeof line !== 'number' || !Number.isFinite(line)) {
    errors.push(`${where}.line: expected a finite number, got ${JSON.stringify(line)}`); ok = false;
  } else if (!isHalfPoint(line)) {
    errors.push(`${where}.line: ${line} is not on the half-point grid a spread is posted on`); ok = false;
  } else if (line < SPREAD_BOUNDS[0] || line > SPREAD_BOUNDS[1]) {
    errors.push(`${where}.line: ${line} is outside ${SPREAD_BOUNDS.join('..')}, which is a parse failure not a line`);
    ok = false;
  }
  if (!Number.isInteger(price)) {
    errors.push(`${where}.price: expected a signed integer American price, got ${JSON.stringify(price)}`); ok = false;
  } else if (Math.abs(price) < MIN_PRICE_MAGNITUDE || Math.abs(price) > MAX_PRICE_MAGNITUDE) {
    errors.push(`${where}.price: ${price} is outside +/-${MIN_PRICE_MAGNITUDE}..${MAX_PRICE_MAGNITUDE}`); ok = false;
  }
  return ok ? { line, price } : null;
}

/**
 * Validate and normalise one capture, resolving teams and kickoffs.
 *
 * Two tiers, on purpose:
 *
 *   ENVELOPE errors (schema, capture instant, provenance, book blocks) are
 *   fatal for the whole payload. If the run stamp or the provenance cannot be
 *   trusted, no row in it can be.
 *
 *   GAME errors are collected per game with the game named. A game whose alt
 *   legs were simply not captured is NOT an error — `_fetch_fd_alts_spa`
 *   returns (None,)*8 on a failed event page and that is the normal shape of a
 *   real run — it is counted as `without_alt` so a thin capture is visible
 *   instead of looking complete.
 *
 * The caller decides what a game error means; `importAltSpreadCapture` refuses
 * the whole capture by default, because a payload containing a value that is
 * present and wrong is not trustworthy in its other rows either.
 */
export function validateAltSpreadCapture(payload, { now = new Date(), database = db } = {}) {
  const errors = [];
  const nowIso = new Date(now).toISOString();

  if (!isPlainObject(payload)) {
    throw new AltSpreadCaptureError('capture payload must be a JSON object',
      [`payload: expected an object, got ${Array.isArray(payload) ? 'an array' : typeof payload}`]);
  }
  if (payload.schema !== ALT_SPREAD_CAPTURE_SCHEMA) {
    errors.push(`schema: expected "${ALT_SPREAD_CAPTURE_SCHEMA}", got ${JSON.stringify(payload.schema)}`);
  }
  const capturedAt = isoInstant(payload.captured_at);
  if (!capturedAt) {
    errors.push(`captured_at: expected an ISO-8601 instant, got ${JSON.stringify(payload.captured_at)}`);
  } else if (Date.parse(capturedAt) > Date.parse(nowIso) + FUTURE_SKEW_MS) {
    // A capture instant after now is not an observation of anything.
    errors.push(`captured_at: ${capturedAt} is in the future relative to ${nowIso}; a capture cannot be observed before it happens`);
  }
  const source = typeof payload.source === 'string' ? payload.source.trim() : '';
  if (!source) errors.push(`source: expected a non-empty string naming the producer, got ${JSON.stringify(payload.source)}`);
  if (payload.provenance !== ALT_SPREAD_PROVENANCE) {
    errors.push(`provenance: expected "${ALT_SPREAD_PROVENANCE}" — the only label this path may claim ` +
      `(these are prices scraped from the book itself, and they are not teaser prices) — got ${JSON.stringify(payload.provenance)}`);
  }
  if (!Array.isArray(payload.books) || payload.books.length === 0) {
    errors.push('books: expected a non-empty array of book blocks');
  }
  if (errors.length) throw new AltSpreadCaptureError('capture envelope is not valid', errors);

  const resolve = teamResolver();
  const books = [];
  const gameErrors = [];

  for (const [bi, block] of payload.books.entries()) {
    const at = `books[${bi}]`;
    if (!isPlainObject(block)) { gameErrors.push(`${at}: expected an object`); continue; }
    const book = normaliseBook(block.book);
    if (!book) { gameErrors.push(`${at}.book: expected a book name, got ${JSON.stringify(block.book)}`); continue; }
    if (!Array.isArray(block.games) || block.games.length === 0) {
      gameErrors.push(`${at}.games: expected a non-empty array for book '${book}'`); continue;
    }

    const games = [];
    const withoutAlt = [];
    const seenEvents = new Set();

    for (const [gi, game] of block.games.entries()) {
      const where = `${at}(${book}).games[${gi}]`;
      if (!isPlainObject(game)) { gameErrors.push(`${where}: expected an object`); continue; }

      const readTeam = (raw, field) => {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (BARE_TEAM_CODE.test(text)) {
          gameErrors.push(`${where}.${field}: ${JSON.stringify(raw)} is a bare team code, and this contract ` +
            'takes FULL team names only. live_odds.py\'s _abbr() emits nickname codes — Arizona becomes ' +
            '"CAR" and Kansas City becomes "CHI", both of which resolve here to a DIFFERENT franchise ' +
            'with no error at all. A code is refused rather than resolved.');
          return null;
        }
        const team = resolve(raw);
        if (!team) {
          gameErrors.push(`${where}.${field}: ${JSON.stringify(raw)} does not resolve to a franchise in ` +
            'nfl_teams. The contract expects a full team name as the book spells it, e.g. "Dallas Cowboys".');
          return null;
        }
        // teamResolver() matches on the nickname and ignores the city, so a
        // name that is internally inconsistent still resolves — and resolves
        // silently to the wrong franchise. Measured: "Cleveland Broncos"
        // returns DEN. That is the failure mode worth refusing, because a
        // capture that mislabels a team would otherwise import a real price
        // against a team that never played the game.
        const contradiction = contradictingToken(raw, team);
        if (contradiction) {
          gameErrors.push(`${where}.${field}: ${JSON.stringify(raw)} resolved to ${team.abbr} ` +
            `(${team.name}), but the word "${contradiction.token}" belongs to ${contradiction.abbr}. ` +
            'A name that names two different franchises is refused rather than resolved to whichever ' +
            'one the nickname happened to match.');
          return null;
        }
        return team;
      };
      const awayTeam = readTeam(game.away_team, 'away_team');
      const homeTeam = readTeam(game.home_team, 'home_team');
      if (!awayTeam || !homeTeam) continue;
      if (awayTeam.abbr === homeTeam.abbr) {
        gameErrors.push(`${where}: ${awayTeam.abbr} is on both sides of the game`); continue;
      }

      const reportedKickoff = isoInstant(game.kickoff);
      if (!reportedKickoff) {
        gameErrors.push(`${where}.kickoff: expected an ISO-8601 instant, got ${JSON.stringify(game.kickoff)}`); continue;
      }

      if (!isPlainObject(game.main)) {
        gameErrors.push(`${where}.main: expected { away: { line, price } }`); continue;
      }
      const mainAway = readQuote(game.main.away, `${where}.main.away`, gameErrors);
      if (!mainAway) continue;

      // The home main LINE is the negation of the away one — that is what a
      // two-way spread means, not an estimate. The home main PRICE is a
      // separate number the scraper never reads, and is left absent.
      let mainHome = null;
      let mainHomeDerived = true;
      if (game.main.home !== undefined && game.main.home !== null) {
        const quoted = readQuote(game.main.home, `${where}.main.home`, gameErrors);
        if (!quoted) continue;
        if (!near(quoted.line, -mainAway.line)) {
          gameErrors.push(`${where}.main.home.line: ${quoted.line} does not mirror the away line ` +
            `${mainAway.line}; the two sides of one spread are equal and opposite, so this is a torn capture`);
          continue;
        }
        mainHome = quoted;
        mainHomeDerived = false;
      }
      const mainLineFor = { away: mainAway.line, home: -mainAway.line };

      // --- the alt legs -------------------------------------------------
      const altBlock = game.alt_six;
      if (altBlock !== undefined && altBlock !== null && !isPlainObject(altBlock)) {
        gameErrors.push(`${where}.alt_six: expected an object of leg quotes, got ${JSON.stringify(altBlock)}`); continue;
      }
      const alt = isPlainObject(altBlock) ? altBlock : {};
      for (const key of Object.keys(alt)) {
        if (!ALT_LEG_SPECS[key]) {
          gameErrors.push(`${where}.alt_six.${key}: unknown leg name; expected one of ` +
            `${Object.keys(ALT_LEG_SPECS).join(', ')}`);
        }
      }

      const legs = [];
      let pairError = false;
      for (const [a, b] of ALT_PAIRS) {
        const rawA = alt[a] ?? null;
        const rawB = alt[b] ?? null;
        if (rawA === null && rawB === null) continue;
        if (rawA === null || rawB === null) {
          // find_pair() returns both sides or neither. One side alone means the
          // capture is torn, and a torn pair is how a price gets attached to a
          // number that was never actually paired on the board.
          gameErrors.push(`${where}.alt_six: '${a}' and '${b}' are the two sides of one number and must ` +
            `both be present or both absent; got ${rawA === null ? a : b} missing`);
          pairError = true; continue;
        }
        const qa = readQuote(rawA, `${where}.alt_six.${a}`, gameErrors);
        const qb = readQuote(rawB, `${where}.alt_six.${b}`, gameErrors);
        if (!qa || !qb) { pairError = true; continue; }
        if (!near(qa.line, -qb.line)) {
          gameErrors.push(`${where}.alt_six: '${a}' line ${qa.line} and '${b}' line ${qb.line} are not ` +
            'the two sides of one number (they must be equal and opposite)');
          pairError = true; continue;
        }
        for (const [key, quote] of [[a, qa], [b, qb]]) {
          const spec = ALT_LEG_SPECS[key];
          const mainLine = mainLineFor[spec.side];
          const equivalence = altLegTeaserEquivalence({ mainLine, altLine: quote.line });
          // The direction has to be the direction the name claims. A leg named
          // `home_plus6` whose line moved the home team backwards is a mapping
          // error somewhere upstream, and it would be recorded as a teaser leg.
          if (Math.sign(equivalence.observed_move) !== Math.sign(spec.requested_move)
              && Math.abs(equivalence.observed_move) > EPS) {
            gameErrors.push(`${where}.alt_six.${key}: line ${quote.line} moves the ${spec.side} main line ` +
              `${mainLine} by ${equivalence.observed_move}, which is the opposite direction from the ` +
              `${spec.requested_move > 0 ? '+' : ''}${spec.requested_move} this leg name asserts`);
            pairError = true; continue;
          }
          legs.push({ key, ...spec, ...quote, main_line: mainLine, equivalence });
        }
      }
      if (pairError) continue;

      if (!legs.length) {
        // Normal, not an error: the alt fetch failed for this game.
        withoutAlt.push({ away: awayTeam.abbr, home: homeTeam.abbr, reason: 'no_alt_six_captured' });
        continue;
      }

      const schedule = resolveScheduledGame(
        { away: awayTeam.abbr, home: homeTeam.abbr, kickoff: reportedKickoff }, { database });
      const commenceTime = schedule.matched ? schedule.kickoff : reportedKickoff;
      const key = eventKeyFor(commenceTime, awayTeam.abbr, homeTeam.abbr);
      if (seenEvents.has(key)) {
        gameErrors.push(`${where}: ${key} appears twice in book '${book}'; one book quotes one game once`);
        continue;
      }
      seenEvents.add(key);

      const contract = contractEventKey({ homeTeam: homeTeam.abbr, awayTeam: awayTeam.abbr, commenceTime });

      games.push({
        away: awayTeam.abbr, home: homeTeam.abbr,
        away_name: awayTeam.name, home_name: homeTeam.name,
        event_key: key,
        contract_event_key: contract.ok ? contract.key : `nfl|${easternGameDate(commenceTime)}|${awayTeam.abbr}@${homeTeam.abbr}`,
        commence_time: commenceTime,
        reported_kickoff: reportedKickoff,
        schedule_source: schedule.matched ? 'game_lines_team_pair' : 'book_reported',
        schedule_drift_minutes: schedule.drift_minutes,
        schedule_reason: schedule.reason,
        season: schedule.season, week: schedule.week,
        observed_at: isoInstant(game.alt_observed_at) ?? capturedAt,
        main: { away: mainAway, home: mainHome, home_line_derived: mainHomeDerived,
          home_line: -mainAway.line },
        legs
      });
    }

    books.push({ book, games, without_alt: withoutAlt });
  }

  return {
    schema: ALT_SPREAD_CAPTURE_SCHEMA,
    captured_at: capturedAt,
    source,
    source_version: typeof payload.source_version === 'string' ? payload.source_version : null,
    provenance: ALT_SPREAD_PROVENANCE,
    note: typeof payload.note === 'string' ? payload.note : null,
    books,
    errors: gameErrors,
    importer_version: ALT_SPREAD_IMPORT_VERSION
  };
}

/* ======================================================================== */
/* Import                                                                   */
/* ======================================================================== */

/** Stable stringify, so the same capture hashes the same however JSON key order lands. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

/** One capture-run identity per (book, instant, content). Re-importing hits it. */
function captureIdFor(normalised, block) {
  const body = canonical({
    schema: normalised.schema, captured_at: normalised.captured_at,
    source: normalised.source, source_version: normalised.source_version,
    provenance: normalised.provenance, book: block.book,
    games: block.games.map(g => ({
      event_key: g.event_key, commence_time: g.commence_time, observed_at: g.observed_at,
      main_away: g.main.away, main_home: g.main.home,
      legs: g.legs.map(l => ({ key: l.key, line: l.line, price: l.price }))
        .sort((x, y) => x.key.localeCompare(y.key))
    })).sort((x, y) => x.event_key.localeCompare(y.event_key))
  });
  return { capture_id: sha256(body).slice(0, 32), payload_sha256: sha256(body) };
}

/**
 * Import one capture run.
 *
 * `allowPartial` is false by default and that default is the point. A game
 * whose alt legs were never captured is skipped and counted — that is absence,
 * and absence is normal. A game carrying a value that is present and WRONG (an
 * unresolvable team, a torn mirror pair, a leg moving the wrong way, a price
 * that is not an integer) fails the whole import, because a payload that got
 * one of those wrong has told us nothing about whether it got the rest right.
 * Set `allowPartial: true` to take the good games anyway with the rest listed.
 *
 * Idempotent by content: the same capture imported twice writes nothing the
 * second time and says so. Nothing is ever updated — both tables carry
 * append-only triggers, and a corrected capture is a new capture.
 */
export function importAltSpreadCapture(payload, { now = new Date(), database = db,
  allowPartial = false, note = null } = {}) {
  const importedAt = new Date(now).toISOString();
  const normalised = validateAltSpreadCapture(payload, { now, database });

  if (normalised.errors.length && !allowPartial) {
    throw new AltSpreadCaptureError(
      `capture rejected: ${normalised.errors.length} game-level problem(s). A capture holding a value that ` +
      'is present and wrong is not trustworthy in its other rows either; pass allowPartial:true to import ' +
      'the sound games and list the rest.', normalised.errors);
  }

  const insertCapture = database.prepare(`INSERT OR IGNORE INTO nfl_alt_spread_captures
    (capture_id, captured_at, imported_at, book, schema_version, source, source_version,
     provenance, games, quotes, games_without_alt, payload_sha256, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertQuote = database.prepare(`INSERT INTO nfl_alt_spread_quotes
    (capture_id, captured_at, observed_at, book, event_key, contract_event_key, commence_time,
     away_team, home_team, schedule_source, season, week, side, team, market,
     requested_move, observed_move, line, price, main_line, main_line_derived,
     crosses_both, teaser_equivalent_leg)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const captures = [];
  const owned = !database.isTransaction;
  if (owned) database.exec('BEGIN IMMEDIATE');
  try {
    for (const block of normalised.books) {
      const { capture_id: captureId, payload_sha256: hash } = captureIdFor(normalised, block);
      const quoteRows = [];

      for (const game of block.games) {
        const base = [normalised.captured_at, game.observed_at, block.book, game.event_key,
          game.contract_event_key, game.commence_time, game.away, game.home,
          game.schedule_source, game.season, game.week];

        // Main rows. Away always; home only when its own price was quoted —
        // the LINE mirrors, the PRICE does not, and a mirrored price would be
        // an invention sitting in a table of observations.
        quoteRows.push([...base, 'away', game.away, 'main_spread', 0, null,
          game.main.away.line, game.main.away.price, game.main.away.line, 0, 0, 0]);
        if (game.main.home) {
          quoteRows.push([...base, 'home', game.home, 'main_spread', 0, null,
            game.main.home.line, game.main.home.price, game.main.home.line, 0, 0, 0]);
        }

        for (const leg of game.legs) {
          const team = leg.side === 'away' ? game.away : game.home;
          const derived = leg.side === 'home' && game.main.home_line_derived ? 1 : 0;
          quoteRows.push([...base, leg.side, team, 'alt_spread', leg.requested_move,
            leg.equivalence.observed_move, leg.line, leg.price, leg.main_line, derived,
            leg.equivalence.crosses_both_key_numbers ? 1 : 0,
            leg.equivalence.same_leg_a_teaser_produces ? 1 : 0]);
        }
      }

      const inserted = insertCapture.run(captureId, normalised.captured_at, importedAt, block.book,
        normalised.schema, normalised.source, normalised.source_version, normalised.provenance,
        block.games.length, quoteRows.length, block.without_alt.length, hash,
        note ?? normalised.note);

      if (!inserted.changes) {
        captures.push({ capture_id: captureId, book: block.book, already_imported: true,
          games: block.games.length, quotes: 0, games_without_alt: block.without_alt.length,
          teaser_equivalent_legs: 0 });
        continue;
      }
      for (const values of quoteRows) insertQuote.run(captureId, ...values);
      captures.push({
        capture_id: captureId, book: block.book, already_imported: false,
        games: block.games.length, quotes: quoteRows.length,
        games_without_alt: block.without_alt.length,
        teaser_equivalent_legs: block.games.reduce(
          (n, g) => n + g.legs.filter(l => l.equivalence.same_leg_a_teaser_produces).length, 0),
        off_six_point_legs: block.games.flatMap(g => g.legs)
          .filter(l => !l.equivalence.move_is_exactly_six)
          .map(l => ({ leg: l.key, main_line: l.main_line, alt_line: l.line,
            observed_move: l.equivalence.observed_move })),
        unscheduled_games: block.games.filter(g => g.schedule_source === 'book_reported')
          .map(g => ({ event_key: g.event_key, reason: g.schedule_reason }))
      });
    }
    if (owned) database.exec('COMMIT');
  } catch (error) {
    if (owned) database.exec('ROLLBACK');
    throw error;
  }

  return {
    captured_at: normalised.captured_at,
    imported_at: importedAt,
    source: normalised.source,
    provenance: normalised.provenance,
    importer_version: ALT_SPREAD_IMPORT_VERSION,
    captures,
    imported_quotes: captures.reduce((n, c) => n + c.quotes, 0),
    games_without_alt: captures.reduce((n, c) => n + c.games_without_alt, 0),
    rejected: normalised.errors,
    skipped_games: normalised.books.flatMap(b => b.without_alt.map(g => ({ book: b.book, ...g }))),
    is_teaser_price: false,
    note: 'Alternate-spread quotes. Not teaser prices — compare with altParlayEquivalent().'
  };
}

/* ======================================================================== */
/* Read-back                                                                */
/* ======================================================================== */

/** Recent capture runs, newest first. */
export function altSpreadCaptures({ limit = 25, book = null } = {}) {
  const sql = `SELECT * FROM nfl_alt_spread_captures ${book ? 'WHERE book = ?' : ''}
    ORDER BY captured_at DESC, rowid DESC LIMIT ?`;
  return book ? rows(sql, normaliseBook(book), limit) : rows(sql, limit);
}

/**
 * The alt legs that reproduce a real teaser leg, newest capture per side, with
 * the parlay-equivalent price for every legal pair of them.
 *
 * Deliberately does NOT read or write `nfl_teaser_price_ledger`. It answers
 * "what would two alt legs cost me", and the answer is meant to be held up
 * beside a recorded teaser price by a person, not merged with one.
 */
export function altTeaserEquivalentBoard({ book, since = null, limit = 200 } = {}) {
  const key = normaliseBook(book);
  const legs = rows(`
    WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY event_key, side ORDER BY captured_at DESC, id DESC) rn
        FROM nfl_alt_spread_quotes
       WHERE book = ? AND market = 'alt_spread' AND teaser_equivalent_leg = 1
         AND requested_move = 6 AND (? IS NULL OR captured_at >= ?))
    SELECT * FROM ranked WHERE rn = 1 ORDER BY commence_time, event_key LIMIT ?`,
  key, since, since, limit);

  const pairs = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      // Same rule the teaser scan enforces: different games.
      if (legs[i].event_key === legs[j].event_key) continue;
      const equivalent = altParlayEquivalent({ legAPrice: legs[i].price, legBPrice: legs[j].price });
      pairs.push({
        legs: [legs[i], legs[j]].map(l => ({ event_key: l.event_key, team: l.team, main_line: l.main_line,
          alt_line: l.line, price: l.price, captured_at: l.captured_at })),
        ...equivalent
      });
    }
  }
  pairs.sort((a, b) => b.profit_multiple - a.profit_multiple);
  return { book: key, legs, legs_count: legs.length, pairs, pair_count: pairs.length,
    is_teaser_price: false,
    note: 'Two alt legs parlayed. Compare `american` against a recorded two-team six-point teaser price; ' +
      'do not record it as one.' };
}

/** One game's most recent alt capture, for a spot check. */
export function altSpreadQuotesForEvent(eventKey, { book = null } = {}) {
  return rows(`SELECT * FROM nfl_alt_spread_quotes
    WHERE event_key = ? ${book ? 'AND book = ?' : ''}
    ORDER BY captured_at DESC, id DESC`,
  ...(book ? [eventKey, normaliseBook(book)] : [eventKey]));
}

/**
 * A standing assertion that nothing from this path reached the teaser ledger.
 *
 * Cheap enough to call from a status route, and it names the exact confusion it
 * is guarding against rather than returning a bare count.
 */
export function assertNoAltPricesInTeaserLedger() {
  const suspect = row(`SELECT COUNT(*) n FROM nfl_teaser_price_ledger
     WHERE COALESCE(notes,'') LIKE ? OR COALESCE(push_rule,'') LIKE ? OR lower(book) LIKE '%alt%spread%'`,
  `%${ALT_SPREAD_LEDGER_MARKER}%`, `%${ALT_SPREAD_LEDGER_MARKER}%`)?.n ?? 0;
  return {
    clean: suspect === 0,
    suspect_rows: suspect,
    rule: 'nfl_teaser_price_ledger records what a book charges for the teaser product itself. An ' +
      'alternate-spread price, and any parlay equivalent derived from one, is a different product and ' +
      'belongs in nfl_alt_spread_quotes.'
  };
}

/* ==========================================================================
 * HOW FAR THE COMPARISON GOES — and where it stops
 * ==========================================================================
 *
 * Read this before treating a captured alt price as if it settled the question
 * the teaser price leaves open. It narrows the uncertainty; it does not close
 * it.
 *
 * WHAT IT GENUINELY SUBSTITUTES FOR
 *  - The shape is right. Two alt legs parlayed and a two-team teaser are both
 *    one stake requiring both games at lines six points off the main number.
 *    Bet-for-bet they are the same exposure.
 *  - It is observed rather than assumed, which is more than the ledger's single
 *    hand-typed row can say, and it is observed at a stamped instant on a
 *    named book.
 *  - It bounds the decision usefully. If the alt parlay comes back at -104 and
 *    the recorded teaser is +100, the teaser wins on price and the question is
 *    settled for that ticket regardless of the residual differences below.
 *
 * WHERE IT BREAKS DOWN
 *  1. PUSH TREATMENT IS A DIFFERENT CONTRACT. Four of the eight cross-both
 *     numbers tease to integers (-1, -2, +8, +9) and can push. A teaser push
 *     reduces the ticket to the book's ONE-LEG TEASER price (which is why
 *     `recordTeaserPrice` accepts legs = 1, and which is typically -450 to
 *     -600). A parlay push voids the leg and pays the survivor at ITS OWN alt
 *     price, which is a different and usually better outcome. The two products
 *     diverge precisely on the push mass the strategy's edge is built out of.
 *  2. THE ALT MAY NOT BE SIX POINTS. `find_pair` walks deltas of +/-0.5 and
 *     +/-1, so a captured "six-point alt" can be a 5.5-, 6.5- or 7-point move.
 *     `observed_move` and `teaser_equivalent_leg` exist so this is visible, but
 *     it means a naive average over captured alt prices is an average over
 *     several different bets.
 *  3. THE MAIN LINE AND THE ALT LINE ARE NOT SIMULTANEOUS. FanDuel's alts come
 *     from a second request per game. If the main line moved between the two,
 *     "six points off the main number" was never true of the pair as recorded.
 *     `observed_at` records the gap; nothing can repair it after the fact.
 *  4. COVERAGE IS ONE BOOK. `live_odds.py` parses alt spreads for FanDuel only.
 *     DraftKings and BetMGM get main lines, moneyline and total, and no alts at
 *     all — and DraftKings is the book the one existing teaser price is from.
 *     So the capture does not yet speak to the price actually in the ledger.
 *  5. LIMITS AND AVAILABILITY DIFFER. A displayed alt price is not a promise of
 *     a bet at a useful size; teaser limits and alt limits are set separately.
 *     `reachable` exists on the teaser ledger for exactly this reason, and
 *     nothing in a scrape can populate its equivalent here.
 *  6. THE VIG SITS IN A DIFFERENT PLACE. A book prices a teaser as a product and
 *     an alt ladder off a model of the margin distribution. They can disagree
 *     by more than rounding, in either direction, and the disagreement is the
 *     whole reason to capture — which also means neither can be used as a proxy
 *     for the other's level.
 *  7. IT IS STILL NOT THE MEASUREMENT ASKED FOR. The unmeasured input is what a
 *     book charges FOR THE TEASER. The only thing that measures that is a
 *     teaser bet slip. This is the best available second-best, and labelling it
 *     as the thing itself would put a fabricated number underneath a decision
 *     that already swings on 20 cents of price.
 */
