/**
 * The Wong teaser desk: one board across several books, a refresh button that
 * actually captures, and a ledger of what was taken.
 *
 * WHY THIS IS ITS OWN ROUTER AND NOT MORE OF `betting-hub.js`.
 *
 * The hub's `/teasers/*` routes are built on `teaserExecutionBoard`, which is
 * built on `simultaneousQuotes`, which pins every book to one event's newest
 * capture instant and therefore drops every book on the hourly tier —
 * DraftKings included, which is the only book with a recorded teaser price on
 * this database. Those routes are correct for what they do and are left alone.
 * This router serves the strategy module in `betting/nfl/strategy/`, which
 * reads each book from the table that actually holds its lines.
 *
 * AUTH. Mounted ungated, matching the hub's own teaser routes
 * (`POST /teasers/executions`, `POST /teasers/executions/:id/settle`) and its
 * capture triggers (`POST /watch/run`, `POST /polymarket/ingest`). The server
 * binds to 127.0.0.1 and nothing here transmits a wager; `POST /tickets`
 * records what the owner says they did, it does not place anything.
 *
 * ERRORS. `{ error: '<sentence>' }` with a real status, `next(e)` for anything
 * unexpected so the app-level handler logs it — the hub's convention exactly.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, row } from '../db/index.js';
import {
  DEFAULT_WONG_BOOKS, scanAllBooks, scanTeaserBoard, sourceForBook, legProbabilities,
} from '../betting/nfl/strategy/teaser-scan.js';
import {
  CROSS_BOTH_LINES, TEASER_POINTS, familyRate, ticketEV, ticketProbabilities,
} from '../betting/nfl/strategy/teaser-leg-rates.js';

const r = Router();

const CROSS_BOTH = new Set(CROSS_BOTH_LINES);
const MAX_BOOKS = 12;
const bookKey = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const r4 = value => (value == null || !Number.isFinite(value) ? null : +value.toFixed(4));

/* ------------------------------------------------------- the season module */

/**
 * `teaser-season.js` is being written in parallel and may not exist yet.
 *
 * It is imported lazily, per request, and its absence is reported as a 503
 * rather than being papered over with a stub. A stub would answer the client
 * with numbers nobody computed, which on a settings endpoint means silently
 * running the season on defaults the owner never chose. "Not available yet" is
 * a true statement; a fabricated default is not.
 */
export const SEASON_MODULE_PATH = '../betting/nfl/strategy/teaser-season.js';

/**
 * The path the four delegated endpoints import, as a replaceable object.
 *
 * This exists so the 503 path and the delegation path can BOTH be tested
 * deterministically. Testing them against the real path would mean a suite
 * whose result depends on whether the module happens to exist yet, which is
 * the one thing a test of "what happens when it does not exist" must not do.
 * Nothing in the application replaces it.
 */
export const seasonModuleSource = { path: SEASON_MODULE_PATH };

async function seasonModule(res, ...required) {
  let mod;
  try {
    mod = await import(seasonModuleSource.path);
  } catch (error) {
    res.status(503).json({
      error: 'season module not available yet',
      module: 'server/betting/nfl/strategy/teaser-season.js',
      detail: error.message,
    });
    return null;
  }
  const missing = required.filter(name => typeof mod[name] !== 'function');
  if (missing.length) {
    res.status(503).json({
      error: 'season module not available yet',
      module: 'server/betting/nfl/strategy/teaser-season.js',
      detail: `it does not export ${missing.join(', ')} yet`,
    });
    return null;
  }
  return mod;
}

/* ------------------------------------------------------------- the board */

/**
 * The commence-time window for one season/week, from the stored schedule.
 *
 * `nfl_line_snapshots` keys events as `nfl:<utc-date>:<AWAY>@<HOME>` and the
 * schedule stores local game dates, which are not the same day for any kickoff
 * after 7pm Eastern. So the ceiling is the last scheduled date PLUS TWO DAYS:
 * enough to keep a Monday-night game whose UTC date has rolled over, and still
 * three days short of the next week's Thursday.
 */
export function weekWindow({ season = null, week = null } = {}) {
  if (!Number.isInteger(season)) return null;
  const params = [season];
  let sql = `SELECT MIN(date) lo, MAX(date) hi FROM schedule_games
             WHERE season = ? AND date IS NOT NULL`;
  if (Number.isInteger(week)) { sql += ' AND week = ?'; params.push(week); }
  const bounds = row(sql, ...params);
  if (!bounds?.lo || !bounds?.hi) return null;
  const to = new Date(new Date(`${bounds.hi}T00:00:00.000Z`).getTime() + 2 * 86400000);
  return {
    from: new Date(`${bounds.lo}T00:00:00.000Z`).toISOString(),
    to: to.toISOString(),
    source: 'schedule_games',
    applied: true,
  };
}

function parseBooks(value) {
  if (value == null || value === '') return [...DEFAULT_WONG_BOOKS];
  const list = String(value).split(',').map(book => book.trim()).filter(Boolean);
  return list.length ? list.slice(0, MAX_BOOKS) : [...DEFAULT_WONG_BOOKS];
}

const intOrNull = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * The board, in the exact shape the client renders.
 *
 * The window's lower bound is clamped to now, never below it: `bookSpreadBoard`
 * treats `fromCommence` as its kickoff gate, and these tables are append-only,
 * so asking for "week 1" on the Monday after week 1 would otherwise resurrect
 * finished games carrying their last, perfectly fresh-looking quote.
 */
export function wongBoard({ books = DEFAULT_WONG_BOOKS, season = null, week = null,
  now = new Date() } = {}) {
  const nowIso = new Date(now).toISOString();
  const window = weekWindow({ season, week });
  const fromCommence = window && window.from > nowIso ? window.from : null;
  const scan = scanAllBooks({ books, now, fromCommence, toCommence: window?.to ?? null });
  return {
    generated_at: nowIso,
    season, week,
    week_window: window ?? (season == null ? null : {
      applied: false,
      note: `no rows in schedule_games for season ${season}${week == null ? '' : ` week ${week}`}; `
        + 'showing every game that has not kicked off',
    }),
    ...scan,
  };
}

r.get('/board', (req, res, next) => {
  try {
    const season = intOrNull(req.query.season);
    const week = intOrNull(req.query.week);
    if (Number.isNaN(season)) return res.status(400).json({ error: 'season must be a whole number' });
    if (Number.isNaN(week)) return res.status(400).json({ error: 'week must be a whole number' });
    res.json(wongBoard({ books: parseBooks(req.query.books), season, week }));
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------- the refresh */

/**
 * The two capture paths behind the refresh button, as a replaceable object.
 *
 * `captureExtraBookFeeds` is the one that matters here: Rotowire and SBR are
 * what put DraftKings into `nfl_line_snapshots`, and DraftKings is the only
 * book on this database with a recorded teaser price. `captureBookFeeds` is
 * the first-hand tier (Pinnacle, FanDuel, Bovada, ...) and is what keeps the
 * quote-tape books off the 30-minute stale flag.
 *
 * It is a mutable module export so a test can swap in a failing or slow
 * capture. Nothing in the application replaces it.
 */
export const captureRunners = {
  extra_book_feeds: async () =>
    (await import('../services/book-feeds-extra.js')).captureExtraBookFeeds(),
  book_feeds: async () =>
    (await import('../services/book-feeds.js')).captureBookFeeds(),
};

/**
 * Run both captures, and never let either one turn into an error page.
 *
 * A refresh that fails has still produced the most useful thing available —
 * the board as it stands — and the operator's next question is "is what I am
 * looking at current?", which a 500 cannot answer. So every failure mode
 * (throw, rate limit, provider backoff, feeds disabled) comes back as a
 * `captures[]` entry with `ok: false` and a reason, and the board comes back
 * beside it flagged stale.
 */
export async function runCaptures() {
  const names = Object.keys(captureRunners);
  const settled = await Promise.allSettled(names.map(async name => {
    const started = Date.now();
    try {
      const out = await captureRunners[name]();
      return { name, out, duration_ms: Date.now() - started };
    } catch (error) {
      return { name, error, duration_ms: Date.now() - started };
    }
  }));

  return settled.map((entry, index) => {
    const name = names[index];
    // Promise.allSettled only rejects here if the wrapper itself threw.
    if (entry.status === 'rejected') {
      return { source: name, ok: false, rows: 0, error: String(entry.reason?.message ?? entry.reason),
        duration_ms: null };
    }
    const { out, error, duration_ms: durationMs } = entry.value;
    if (error) {
      return { source: name, ok: false, rows: 0, error: error.message, duration_ms: durationMs };
    }
    if (out?.skipped) {
      return { source: name, ok: false, rows: 0, skipped: true,
        error: out.reason ?? 'capture skipped', duration_ms: durationMs };
    }
    const written = Number(out?.quotes ?? 0);
    // A provider that was rate limited or backing off reports itself in
    // `errors` while the others may still have written rows. That is a partial
    // success, not a failure, and flattening it to one boolean would hide
    // which feed went quiet.
    const providerErrors = out?.errors ? Object.entries(out.errors)
      .map(([provider, message]) => `${provider}: ${message}`) : [];
    return {
      source: name,
      ok: written > 0,
      rows: written,
      error: written > 0 ? null
        : (providerErrors.join('; ') || 'the capture returned no quotes'),
      warnings: providerErrors.length ? providerErrors : undefined,
      events: out?.events ?? null,
      books: out?.book_keys ?? null,
      captured_at: out?.captured_at ?? null,
      duration_ms: durationMs,
    };
  });
}

r.post('/refresh', async (req, res, next) => {
  const started = Date.now();
  try {
    const season = intOrNull(req.body?.season ?? req.query.season);
    const week = intOrNull(req.body?.week ?? req.query.week);
    const books = parseBooks(req.body?.books ?? req.query.books);
    const captures = await runCaptures();
    const refreshed = captures.some(capture => capture.ok && capture.rows > 0);

    let board;
    try {
      board = wongBoard({ books, season: Number.isNaN(season) ? null : season,
        week: Number.isNaN(week) ? null : week });
    } catch (error) {
      // The scan itself failing IS an error page: there is no stale board to
      // fall back to, because the failure is in reading the tables at all.
      return next(error);
    }

    res.json({
      refreshed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      captures,
      stale: !refreshed,
      stale_reason: refreshed ? null
        : 'no capture wrote a new quote, so this board is the one that was already stored — '
          + captures.map(capture => `${capture.source}: ${capture.error}`).join('; '),
      board: { ...board, stale: !refreshed },
    });
  } catch (e) { next(e); }
});

/* ---------------------------------------------- delegated season endpoints */

r.get('/settings', async (_req, res, next) => {
  try {
    const mod = await seasonModule(res, 'wongSettings');
    if (!mod) return;
    res.json(mod.wongSettings());
  } catch (e) { next(e); }
});

r.put('/settings', async (req, res, next) => {
  try {
    const mod = await seasonModule(res, 'saveWongSettings');
    if (!mod) return;
    const out = mod.saveWongSettings(req.body ?? {});
    if (out?.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

r.get('/season', async (req, res, next) => {
  try {
    const mod = await seasonModule(res, 'wongSeason');
    if (!mod) return;
    const season = intOrNull(req.query.season);
    if (Number.isNaN(season)) return res.status(400).json({ error: 'season must be a whole number' });
    res.json(mod.wongSeason({ season: season ?? undefined }));
  } catch (e) { next(e); }
});

r.get('/combos', async (req, res, next) => {
  try {
    const mod = await seasonModule(res, 'bestTicketSet');
    if (!mod) return;
    const maxTickets = intOrNull(req.query.maxTickets);
    if (Number.isNaN(maxTickets) || (maxTickets != null && (maxTickets < 1 || maxTickets > 50))) {
      return res.status(400).json({ error: 'maxTickets must be a whole number between 1 and 50' });
    }
    // `bestTicketSet` solves a matching over candidates; it does not know what
    // a book is and never scans. This route used to hand it `book` and nothing
    // else, so `candidates` defaulted to [] and it answered "no legal pair of
    // legs on this board" against a board holding 36 of them — a seam between
    // two modules whose contracts were written separately.
    const book = req.query.book ? String(req.query.book) : 'draftkings';
    const board = scanTeaserBoard({ book });
    const set = mod.bestTicketSet({
      candidates: board.candidates ?? [],
      maxTickets: maxTickets ?? undefined,
    });
    // Carry the board's own refusal through. A caller seeing an empty set needs
    // to know whether there were no legs or no price, and the set alone cannot
    // say which.
    res.json({
      ...set,
      book: board.book,
      provenance: board.provenance,
      board_captured_at: board.board_captured_at,
      qualifying_legs: board.qualifying_legs,
      stale_legs: board.stale_legs,
      price: board.price ?? null,
      blocked_reasons: board.blocked_reasons ?? [],
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------- the ledger */

/**
 * What a submitted ticket has to be before it is written down.
 *
 * Every one of these is a rule of the strategy or of the schema, not a
 * preference: two legs because `ticketEV` only models the reduced-push bucket
 * for two (a three-leg ticket with one push reduces to a double and with two
 * to a single, and those pay differently); different games because a book will
 * not book a same-game teaser and because the pair correlation this prices
 * with was measured on cross-game pairs; the eight lines because a leg that
 * does not cross both 3 and 7 is not this bet at all.
 */
export function validateTicket(input = {}) {
  const errors = [];
  const book = bookKey(input.book);
  if (!book) errors.push('book is required');
  else if (!sourceForBook(book)) {
    errors.push(`no known spread source for book '${input.book}' — this desk cannot read its lines, `
      + 'so it will not vouch for a ticket at it');
  }

  const mode = input.mode === 'placed' ? 'placed' : input.mode === 'paper' ? 'paper' : null;
  if (!mode) errors.push("mode must be 'paper' or 'placed'");

  const price = Number(input.american_price);
  if (!Number.isFinite(price) || !Number.isInteger(price) || Math.abs(price) < 100) {
    errors.push('american_price must be whole American odds at or beyond +/-100');
  }

  const stake = Number(input.stake_units);
  if (!Number.isFinite(stake) || stake <= 0 || stake > 5) {
    errors.push('stake_units must be greater than 0 and at most 5');
  }

  const submitted = Array.isArray(input.legs) ? input.legs : [];
  if (submitted.length !== 2) {
    errors.push(`a two-team teaser has exactly 2 legs; got ${submitted.length}`);
  }
  const legs = [];
  submitted.forEach((leg, index) => {
    const slot = index + 1;
    if (!leg?.event_id) errors.push(`leg ${slot}: event_id is required`);
    if (!leg?.team) errors.push(`leg ${slot}: team is required`);
    const line = Number(leg?.line);
    if (!Number.isFinite(line)) errors.push(`leg ${slot}: line is required`);
    else if (!CROSS_BOTH.has(line)) {
      errors.push(`leg ${slot}: ${line} does not cross both 3 and 7 when teased 6 points; `
        + `the qualifying lines are ${CROSS_BOTH_LINES.join(', ')}`);
    }
    const teasedTo = leg?.teased_to == null ? line + TEASER_POINTS : Number(leg.teased_to);
    if (Number.isFinite(line) && Math.abs(teasedTo - (line + TEASER_POINTS)) > 1e-9) {
      errors.push(`leg ${slot}: teased_to ${leg.teased_to} is not ${line} plus ${TEASER_POINTS} points`);
    }
    legs.push({ event_id: String(leg?.event_id ?? ''), team: String(leg?.team ?? ''),
      line, teased_to: line + TEASER_POINTS });
  });
  if (legs.length === 2 && legs[0].event_id && legs[0].event_id === legs[1].event_id) {
    errors.push('both legs are the same game; a teaser needs two different games');
  }

  return { ok: errors.length === 0, errors, ticket: { book, mode, price, stake, legs,
    note: input.note ? String(input.note).slice(0, 500) : null } };
}

/** Deterministic id in the same 24-character shape the hub's ledger uses. */
function wongCandidateId(identity) {
  return `wong:${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 18)}`;
}

/**
 * Record a ticket.
 *
 * A CONTRADICTION IN THE BRIEF, RESOLVED HERE RATHER THAN HIDDEN.
 *
 * This was specified as "record via the existing `recordTeaserExecution`
 * path". That function takes a `candidate_id` and looks it up on
 * `teaserExecutionBoard()` — which is built on `simultaneousQuotes`, which is
 * precisely the board that cannot see DraftKings. So for the one book with a
 * recorded teaser price on this database, the existing path structurally
 * cannot accept a ticket, and a submitted ticket would always come back
 * "candidate is no longer on the current execution board".
 *
 * So: the existing path is TRIED FIRST and used whenever it can see the pair,
 * which keeps its gates (price reachable, price fresh, price beats
 * mathematical break-even, EV positive) in force for the books it covers. When
 * it cannot, the ticket is written to the SAME two tables in the same shape,
 * so `settleTeaserExecution` and `teaserExecutionLedger` read it unchanged.
 * The response says which happened in `recorded_via`; nothing is silent.
 */
export async function recordWongTicket(input = {}, { now = new Date() } = {}) {
  const check = validateTicket(input);
  if (!check.ok) return { status: 400, body: { error: check.errors[0], errors: check.errors } };
  const { book, mode, price, stake, legs, note } = check.ticket;

  const sameLegs = candidate => {
    const want = legs.map(leg => `${leg.event_id}|${leg.team}|${leg.line}`).sort();
    const got = (candidate.legs ?? []).map(leg => `${leg.event_id}|${leg.team}|${leg.market_line}`).sort();
    return want.length === got.length && want.every((key, index) => key === got[index]);
  };

  // The hub's board is TRIED, never depended on: it is built on a chain of
  // services (`simultaneousQuotes`, `wongHistory`, the profitability ledger)
  // any of which can be unavailable on a fresh database, and a ticket the
  // owner has already placed must not fail to be written down because a board
  // that cannot see their book could not be built.
  let hubBoard = null;
  let recordViaHub = null;
  try {
    const mod = await import('../services/nfl-teaser-execution.js');
    recordViaHub = mod.recordTeaserExecution;
    hubBoard = mod.teaserExecutionBoard({ now });
  } catch { hubBoard = null; }
  const match = hubBoard?.candidates?.find(candidate =>
    bookKey(candidate.book) === book && sameLegs(candidate));

  if (match && recordViaHub) {
    if (!match.eligible) {
      return { status: 409, body: { error: 'execution blocked', reasons: match.blocked_reasons,
        recorded_via: 'nfl-teaser-execution board candidate' } };
    }
    const out = recordViaHub({ candidate_id: match.candidate_id, mode,
      stake_units: stake, note });
    if (out?.error) return { status: out.reasons ? 409 : 400, body: out };
    return { status: 201, body: { ...out, recorded_via: 'nfl-teaser-execution board candidate' } };
  }

  // ---- the direct path, for a book the hub's board cannot see ----

  // Verified against THIS desk's board, which can. A leg that is not on it is
  // still recorded — refusing to write down a wager the owner has already
  // placed makes the ledger lie by omission — but it is flagged, and its
  // capture stamp is the submission time rather than a quote nobody saw.
  const desk = wongBoard({ books: [book], now });
  const onBoard = new Map();
  for (const game of desk.comparison) {
    for (const entry of game.by_book) {
      if (entry.line == null) continue;
      onBoard.set(`${game.event_id}|${entry.side}|${entry.line}`, { ...entry, game });
    }
  }
  const nowIso = new Date(now).toISOString();
  const warnings = [];
  const enriched = legs.map(leg => {
    const found = onBoard.get(`${leg.event_id}|${leg.team}|${leg.line}`) ?? null;
    if (!found) {
      warnings.push(`${leg.team} ${leg.line} is not on the current ${book} board at that number; `
        + 'recorded on the owner\'s word, with the submission time as its capture stamp');
    } else if (!found.fresh) {
      warnings.push(`${leg.team} ${leg.line} is on the ${book} board but its quote is `
        + `${found.age_minutes} minutes old, past the ${found.max_age_minutes} minute budget`);
    }
    const game = found?.game ?? null;
    const opponent = game
      ? (leg.team === game.home_team ? game.away_team : game.home_team) : null;
    return {
      ...leg,
      opponent,
      matchup: game ? `${game.away_team} at ${game.home_team}` : leg.event_id,
      commence_time: game?.commence_time ?? null,
      captured_at: found?.captured_at ?? nowIso,
      provenance: found?.provenance ?? null,
    };
  });

  // `expected_ev` and `expected_leg_rate` are NOT NULL on the ledger, and the
  // only honest source for them is the measured family. If the measurement is
  // unavailable there is no number to store, and storing a zero would put a
  // ticket in the ledger claiming it was priced at nothing.
  let family, probabilities, ev;
  try {
    family = familyRate({ side: 'all' });
    const priced = legs.map(leg => {
      const probability = legProbabilities(leg.line);
      return { w: probability.w, t: probability.t };
    });
    probabilities = ticketProbabilities(priced);
    ev = ticketEV({ legs: priced, americanPrice: price, reducedPayout: 'stake_back' });
  } catch (error) {
    return { status: 503, body: { error: 'the measured teaser leg rates are unavailable, so this '
      + 'ticket cannot be priced and will not be written down half-priced', detail: error.message } };
  }

  // If the owner's stated payout matches a standing recorded price for this
  // book, that row's stamp is the honest one; otherwise the price is news as
  // of now.
  const ledgerPrice = row(`SELECT * FROM nfl_teaser_price_ledger
    WHERE teaser_points = ? AND legs = 2 AND reachable = 1 AND american_price = ?
      AND lower(replace(replace(book,' ',''),'-','')) = ?
    ORDER BY captured_at DESC, id DESC LIMIT 1`, TEASER_POINTS, price, book);

  const candidateId = wongCandidateId({ book, price, mode,
    legs: enriched.map(leg => [leg.event_id, leg.team, leg.line, leg.teased_to]).sort() });
  const existing = row('SELECT id FROM nfl_teaser_executions WHERE candidate_id=? AND mode=?',
    candidateId, mode);
  if (existing) {
    return { status: 409, body: { error: `this ticket is already logged as ${mode}`,
      execution_id: existing.id } };
  }

  const lineCapturedAt = enriched.map(leg => leg.captured_at).sort()[0];
  db.exec('BEGIN IMMEDIATE');
  let executionId;
  try {
    const inserted = db.prepare(`INSERT INTO nfl_teaser_executions
      (candidate_id,logged_at,mode,book,american_price,teaser_points,stake_units,
       expected_leg_rate,expected_ticket_probability,expected_ev,price_captured_at,
       line_captured_at,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidateId, nowIso, mode, book, price, TEASER_POINTS, stake,
      family.rate_of_decided, r4(probabilities.win), r4(ev.ev),
      ledgerPrice?.captured_at ?? nowIso, lineCapturedAt, note);
    executionId = Number(inserted.lastInsertRowid);
    const insertLeg = db.prepare(`INSERT INTO nfl_teaser_execution_legs
      (execution_id,slot,event_id,team,opponent,matchup,commence_time,market_line,teased_line)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    enriched.forEach((leg, index) => insertLeg.run(executionId, index + 1, leg.event_id,
      leg.team, leg.opponent, leg.matchup, leg.commence_time, leg.line, leg.teased_to));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    status: 201,
    body: {
      logged: true,
      execution_id: executionId,
      mode,
      book,
      candidate_id: candidateId,
      american_price: price,
      stake_units: stake,
      legs: enriched,
      expected_leg_rate: r4(family.rate_of_decided),
      expected_ticket_probability: r4(probabilities.win),
      expected_ev: r4(ev.ev),
      expected_ev_percent: r4(ev.ev_percent),
      reduced_payout: 'stake_back',
      reduced_payout_verified: false,
      price_captured_at: ledgerPrice?.captured_at ?? nowIso,
      line_captured_at: lineCapturedAt,
      recorded_via: 'wong desk direct write',
      recorded_via_reason: hubBoard
        ? `this pair is not on the hub's execution board — that board is built on simultaneousQuotes, `
          + `which drops every book on the hourly capture tier, ${book} included`
        : 'the hub\'s execution board could not be built at all',
      warnings: warnings.length ? warnings : undefined,
    },
  };
}

r.post('/tickets', async (req, res, next) => {
  try {
    const out = await recordWongTicket(req.body ?? {});
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
});

r.post('/tickets/:id/settle', async (req, res, next) => {
  try {
    const { settleTeaserExecution } = await import('../services/nfl-teaser-execution.js');
    const out = settleTeaserExecution(req.params.id, req.body ?? {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) { next(e); }
});

/**
 * The ledger.
 *
 * `season` filters on the LEGS' kickoff, not on when the ticket was logged: a
 * season runs September to February and a ticket logged in January belongs to
 * the season whose games it is on, not to the calendar year it was typed in.
 */
r.get('/tickets', async (req, res, next) => {
  try {
    const { teaserExecutionLedger } = await import('../services/nfl-teaser-execution.js');
    const season = intOrNull(req.query.season);
    if (Number.isNaN(season)) return res.status(400).json({ error: 'season must be a whole number' });
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const ledger = teaserExecutionLedger({ limit });
    if (season == null) return res.json({ season: null, ...ledger });

    const from = `${season}-08-01`;
    const to = `${season + 1}-03-01`;
    const inSeason = execution => (execution.legs ?? []).some(leg =>
      leg.commence_time && leg.commence_time >= from && leg.commence_time < to);
    const executions = ledger.executions.filter(inSeason);
    const settled = executions.filter(execution => execution.status === 'won' || execution.status === 'lost');
    res.json({
      season,
      season_window: { from, to },
      ...ledger,
      executions,
      season_summary: {
        tickets: executions.length,
        paper_tickets: executions.filter(execution => execution.mode === 'paper').length,
        placed_tickets: executions.filter(execution => execution.mode === 'placed').length,
        open_tickets: executions.filter(execution => execution.status === 'open').length,
        ticket_wins: settled.filter(execution => execution.status === 'won').length,
        ticket_losses: settled.filter(execution => execution.status === 'lost').length,
        placed_profit_units: r4(executions
          .filter(execution => execution.mode === 'placed')
          .reduce((sum, execution) => sum + (execution.profit_units ?? 0), 0)),
      },
      note: `${ledger.note} \`summary\` is all-time; \`season_summary\` covers only tickets whose `
        + 'legs kick off inside the season window.',
    });
  } catch (e) { next(e); }
});

export default r;
