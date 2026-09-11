/**
 * Running the Wong teaser as a SEASON rather than as a series of unrelated
 * Sundays.
 *
 * `teaser-leg-rates.js` measures the family. `teaser-scan.js` turns the
 * measurement into this week's board. This module answers the three questions
 * that only appear once you accept both of those and have to actually operate:
 *
 *   1. What are my standing terms? (unit size, books, how many tickets a week,
 *      which push grading I price with) — `wongSettings` / `saveWongSettings`.
 *   2. Given a board of legal tickets, WHICH ones do I place? — `bestTicketSet`.
 *   3. Where does that put me by February, and how sure can I possibly be? —
 *      `wongSeason`.
 *
 * ---------------------------------------------------------------------------
 * THE FINDING THAT MOTIVATES (2): OVERLAP IS THE ONLY FREE LUNCH ON THIS BOARD.
 *
 * Leg selection here is unranked, and stays unranked. ~4,600 tests over model
 * edge (r = -0.007 against ATS residual), 501 game-feature hypotheses and 4,060
 * window searches found nothing that predicts which qualifying leg wins. There
 * is no ranking, scoring or model over legs in this file and there must not be
 * one. The two legitimate separators between tickets are:
 *
 *   - PUSH EXPOSURE. A half-point leg cannot push; an integer leg can. That is
 *     structural, not sampled, and it is already priced by `ticketEV` upstream,
 *     which is why this module treats `candidate.ev` as given and never
 *     recomputes it from anything about the teams.
 *   - OVERLAP. Two tickets that share a leg are not two bets; they are one bet
 *     with a shared point of failure. On a nine-leg board at a fixed 4 units of
 *     total risk, four NON-OVERLAPPING tickets take roughly a 25% chance of a
 *     losing week; spreading the same 4 units across all 36 overlapping pairs
 *     takes roughly 43%, for the same expected profit. Each leg appears in 8 of
 *     the 36 tickets, so one bad result takes 8 tickets with it.
 *
 * Same mean, much worse shape. So the ticket-selection problem is exactly
 * MAXIMUM-WEIGHT MATCHING: legs are vertices, legal pairs are edges, edge
 * weight is the pair's EV, and the answer is a set of edges sharing no vertex.
 * `bestTicketSet` solves it exactly (see the algorithm note there) rather than
 * greedily, because greedy is only optimal on this graph by accident.
 *
 * `test/teaser-season.test.js` SIMULATES the 25%-vs-43% claim rather than
 * quoting it, so if it ever stops being true the suite says so.
 * ---------------------------------------------------------------------------
 *
 * WHAT THIS MODULE REFUSES TO DO.
 *
 * It does not own a ledger. `server/services/nfl-teaser-execution.js` already
 * has one, with settlement and forward leg-rate accounting, and a second one
 * beside it would be two different answers to "what did I bet". `wongSeason`
 * READS that ledger and `recordWongTicket` WRITES through its
 * `recordTeaserExecution`. Neither inserts a row itself.
 *
 * It also does not add a table. Settings live in the existing `app_settings`
 * key/value table (the same one `espn-connect.js` and `claude.js` use), under
 * one JSON key. That table has no append-only trigger — several tables in this
 * database do, and two migrations have shipped broken because of it — so an
 * upsert is safe here in a way it would not be on, say, `nfl_quote_tape`.
 */
import { db, row, run } from '../../../db/index.js';
import {
  CROSS_BOTH_LINES, DEFAULT_REDUCED_PAYOUT, TEASER_POINTS,
  familyRate, profitMultiple, teasedLegRate, ticketEV,
} from './teaser-leg-rates.js';
import {
  recordTeaserExecution, teaserExecutionBoard, teaserExecutionLedger,
} from '../../../services/nfl-teaser-execution.js';

export const TEASER_SEASON_VERSION = 'nfl-teaser-season-v1';

const CROSS_BOTH = new Set(CROSS_BOTH_LINES);
const r2 = v => (Number.isFinite(v) ? +v.toFixed(2) : null);
const r4 = v => (Number.isFinite(v) ? +v.toFixed(4) : null);
const bookKey = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* ========================================================================= */
/* 1. SETTINGS                                                               */
/* ========================================================================= */

/**
 * One row in `app_settings`, one JSON blob.
 *
 * A column-per-setting table would have been a migration, and a migration
 * would have been a schema change to a 9.8 GB production database for six
 * scalars that only this feature reads. `app_settings` already exists, already
 * carries exactly this kind of operator preference, and is a plain
 * key/value table with no triggers on it (verified against
 * `server/db/schema/` and `server/migrations/` — the append-only triggers in
 * this database are all on evidence tapes and artifact tables, none of them
 * here).
 */
export const WONG_SETTINGS_KEY = 'wong_teaser_settings';

/**
 * The defaults are the owner's actual operating position, not neutral
 * placeholders: DraftKings at +100 with push-removes-the-leg, priced with the
 * conservative `stake_back` grading because no real pushed ticket has been
 * watched settle yet (see `REDUCED_PAYOUTS` in teaser-leg-rates.js).
 *
 * `max_tickets_per_week` defaults to 4 because that is where the overlap
 * finding bites: a typical week produces 6-10 qualifying legs, which supports
 * 3-5 disjoint tickets, and asking for more than the board can pair without
 * overlap is asking to be sold the 43% shape.
 */
export const DEFAULT_WONG_SETTINGS = Object.freeze({
  unit_size_dollars: 100,
  bankroll_units: 100,
  stake_units: 1,
  books: Object.freeze(['draftkings']),
  max_tickets_per_week: 4,
  reduced_payout: DEFAULT_REDUCED_PAYOUT,
  price_floor: -115,
  default_mode: 'paper',
});

const REDUCED_PAYOUT_MODELS = Object.freeze(['stake_back', 'same_price', 'graded_loss']);

function validateSettings(candidate) {
  const s = { ...DEFAULT_WONG_SETTINGS, ...candidate };
  const fail = message => { throw new TypeError(`wong settings: ${message}`); };

  if (!Number.isFinite(s.unit_size_dollars) || s.unit_size_dollars <= 0) {
    fail(`unit_size_dollars must be a positive number, got ${s.unit_size_dollars}`);
  }
  if (!Number.isFinite(s.bankroll_units) || s.bankroll_units <= 0) {
    fail(`bankroll_units must be a positive number, got ${s.bankroll_units}`);
  }
  // The ledger's own CHECK is `stake_units > 0` and `recordTeaserExecution`
  // refuses anything over 5. Rejecting it here rather than at the insert means
  // an impossible setting cannot be saved and then fail every Sunday.
  if (!Number.isFinite(s.stake_units) || s.stake_units <= 0 || s.stake_units > 5) {
    fail(`stake_units must be greater than 0 and at most 5 (the ledger's cap), got ${s.stake_units}`);
  }
  const books = Array.isArray(s.books) ? s.books.map(b => String(b)).filter(Boolean) : [];
  if (!books.length) fail('books must be a non-empty array of book names');
  if (!Number.isInteger(s.max_tickets_per_week) || s.max_tickets_per_week < 1 || s.max_tickets_per_week > 12) {
    fail(`max_tickets_per_week must be an integer from 1 to 12, got ${s.max_tickets_per_week}`);
  }
  if (!REDUCED_PAYOUT_MODELS.includes(s.reduced_payout)) {
    fail(`reduced_payout must be one of ${REDUCED_PAYOUT_MODELS.join(', ')}, got ${s.reduced_payout}`);
  }
  if (!Number.isFinite(s.price_floor) || Math.abs(s.price_floor) < 100) {
    fail(`price_floor must be a real American price at or beyond +/-100, got ${s.price_floor}`);
  }
  if (!['paper', 'placed'].includes(s.default_mode)) {
    fail(`default_mode must be 'paper' or 'placed', got ${s.default_mode}`);
  }
  return {
    unit_size_dollars: s.unit_size_dollars,
    bankroll_units: s.bankroll_units,
    stake_units: s.stake_units,
    books,
    max_tickets_per_week: s.max_tickets_per_week,
    reduced_payout: s.reduced_payout,
    price_floor: s.price_floor,
    default_mode: s.default_mode,
  };
}

/**
 * The effective settings: stored values layered over the defaults.
 *
 * A stored blob that no longer validates (a hand-edited row, a setting this
 * version dropped) does not throw the caller's request away — it is reported
 * as `invalid_stored_value` and the defaults are used, because a dashboard
 * that cannot render its own settings page is a worse failure than a setting
 * silently reverting.
 */
export function wongSettings() {
  const stored = row('SELECT value FROM app_settings WHERE key = ?', WONG_SETTINGS_KEY)?.value ?? null;
  if (!stored) return { ...DEFAULT_WONG_SETTINGS, books: [...DEFAULT_WONG_SETTINGS.books], stored: false };
  let parsed = null;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { ...DEFAULT_WONG_SETTINGS, books: [...DEFAULT_WONG_SETTINGS.books],
      stored: false, invalid_stored_value: 'stored settings are not valid JSON' };
  }
  try {
    return { ...validateSettings(parsed), stored: true };
  } catch (error) {
    return { ...DEFAULT_WONG_SETTINGS, books: [...DEFAULT_WONG_SETTINGS.books],
      stored: false, invalid_stored_value: error.message };
  }
}

/**
 * Merge a patch over the current settings, validate the RESULT, persist it.
 *
 * Validating the merged result rather than the patch is the point: a patch of
 * `{ stake_units: 9 }` is only wrong in the context of the whole, and a
 * half-applied settings write is how an operator ends up betting a size they
 * never chose.
 */
export function saveWongSettings(patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('saveWongSettings takes an object patch');
  }
  const current = wongSettings();
  delete current.stored;
  delete current.invalid_stored_value;
  const next = validateSettings({ ...current, ...patch });
  run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  WONG_SETTINGS_KEY, JSON.stringify(next));
  return { ...next, stored: true };
}

/** Drop the stored blob; `wongSettings()` falls back to the defaults. */
export function resetWongSettings() {
  run('DELETE FROM app_settings WHERE key = ?', WONG_SETTINGS_KEY);
  return { ...DEFAULT_WONG_SETTINGS, books: [...DEFAULT_WONG_SETTINGS.books], stored: false };
}

/* ========================================================================= */
/* 2. TICKET SELECTION — maximum-weight matching                             */
/* ========================================================================= */

/**
 * Which simultaneous block of games a kickoff belongs to.
 *
 * Three-hour buckets on the Eastern clock, which is the grid the NFL actually
 * posts to: Thursday night, Sunday ~13:00, Sunday ~16:05/16:25, Sunday night,
 * Monday night, and the occasional 09:30 London game each land in their own
 * bucket, while 16:05 and 16:25 correctly land in the same one — they are the
 * same block of television and they finish together.
 *
 * This is used ONLY as a tie-break, and the effect it chases is small and
 * measured, not a hunch: `familyPairCorrelation()` puts same-week family legs
 * at rho = -0.044 (95% week-block bootstrap about [-0.091, -0.004]). Legs in
 * different slots share less of whatever produces that correlation — weather
 * fronts, a league-wide scoring day, the same referee crew's afternoon — so
 * where two ticket sets are worth identically the same EV, the one whose legs
 * are spread across slots is very slightly less concentrated. "Very slightly"
 * is the honest size of it: it is worth breaking a tie on and worth nothing
 * else, which is exactly how it is used below.
 */
const SLOT_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export function kickoffSlot(commenceTime) {
  if (!commenceTime) return null;
  const at = new Date(commenceTime);
  if (Number.isNaN(at.getTime())) return null;
  const parts = Object.fromEntries(SLOT_PARTS.formatToParts(at).map(p => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;          // en-US hour12:false yields '24' at midnight
  const minutes = hour * 60 + Number(parts.minute);
  return `${parts.year}-${parts.month}-${parts.day}#${Math.floor(minutes / 180)}`;
}

/**
 * A ticket is legal or it is not, and this is where that is decided.
 *
 * The different-games rule is automatic on this family — a game's two sides
 * can never both qualify, since the counterpart of a -7..-8.5 favourite is a
 * +7..+8.5 dog, which is not in the set — but it is checked rather than
 * assumed, because it is also a book rule and a schema constraint
 * (`nfl_teaser_execution_legs UNIQUE (execution_id, event_id)`), and the day
 * it stops being automatic is the day it matters most.
 */
export function ticketLegality(candidate) {
  const legs = candidate?.legs;
  if (!Array.isArray(legs) || legs.length !== 2) {
    return { legal: false, reason: `a Wong ticket is exactly two legs, got ${legs?.length ?? 0}` };
  }
  const [a, b] = legs;
  if (!a?.event_id || !b?.event_id || !a?.team || !b?.team) {
    return { legal: false, reason: 'each leg needs an event_id and a team' };
  }
  if (String(a.event_id) === String(b.event_id)) {
    return { legal: false, reason: `both legs are in the same game (${a.event_id}); a teaser may not correlate with itself` };
  }
  for (const leg of legs) {
    if (!CROSS_BOTH.has(leg.line)) {
      return { legal: false, reason: `line ${leg.line} on ${leg.team} is not in the cross-both family ${CROSS_BOTH_LINES.join(', ')}` };
    }
  }
  if (!Number.isFinite(candidate.ev)) {
    return { legal: false, reason: 'candidate carries no numeric ev; price it with ticketEV first' };
  }
  return { legal: true, reason: null };
}

const legKey = leg => `${leg.event_id}|${leg.team}`;

/**
 * The chosen set of tickets, sharing no leg, maximising total EV.
 *
 * ALGORITHM, AND WHY IT IS EXACT.
 *
 * Legs are vertices, legal pairs are edges, edge weight is the pair's EV. The
 * quantity to maximise is the total weight of a set of edges no two of which
 * share a vertex, subject to at most `maxTickets` edges — maximum-weight
 * matching with a cardinality cap.
 *
 * Blossom would be the textbook answer and is entirely unnecessary here: a
 * week produces on the order of ten qualifying legs, not ten thousand. This
 * uses memoised depth-first search over the set of still-available legs,
 * always branching on the LOWEST-INDEXED available leg — either it goes
 * unmatched, or it is matched to one of its partners. Every matching is
 * reachable by exactly one such sequence of decisions, so the search is
 * exhaustive, and memoising on `(available legs, tickets left)` means each
 * distinct sub-problem is solved once. Exhaustive over a superset of the
 * optimum with no pruning that can discard it = exact. This is not a greedy
 * algorithm and does not degrade to one.
 *
 * The one escape hatch: `nodeBudget` (default 2,000,000 states). Matching is
 * exponential in the worst case and a pathological board must not hang a
 * request. If the budget is exhausted the search falls back to greedy and says
 * so — `optimal: false`, `method: 'greedy_fallback'`. On a real NFL week the
 * search finishes in the low thousands of states and this never fires. It also
 * fires above 30 legs, where the bitmask stops fitting in a JS integer.
 *
 * TIE-BREAKS. Every ticket on this board is priced off the same pooled family
 * rate, so EVs differ only by push mass and exact ties are the normal case,
 * not the exception. Ties are broken toward ticket sets with more legs in
 * DIFFERENT kickoff slots (see `kickoffSlot`), lexicographically — the slot
 * count can never outrank a genuine EV difference, only settle an equality.
 */
export function bestTicketSet({ candidates = [], maxTickets = 4, nodeBudget = 2_000_000 } = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('bestTicketSet needs an array of candidates');
  const cap = Number.isFinite(maxTickets) ? Math.max(0, Math.floor(maxTickets)) : Infinity;

  /* ---- build the graph, rejecting anything that is not a legal ticket ---- */
  const rejected = [];
  const vertexIndex = new Map();
  const vertices = [];
  const edgeByPair = new Map();

  for (const candidate of candidates) {
    const legality = ticketLegality(candidate);
    if (!legality.legal) { rejected.push({ candidate, reason: legality.reason }); continue; }
    const [a, b] = candidate.legs;
    for (const leg of [a, b]) {
      const key = legKey(leg);
      if (!vertexIndex.has(key)) {
        vertexIndex.set(key, vertices.length);
        vertices.push({ key, event_id: leg.event_id, team: leg.team, line: leg.line,
          teased_to: leg.teased_to ?? leg.line + TEASER_POINTS,
          commence_time: leg.commence_time ?? null, slot: kickoffSlot(leg.commence_time) });
      }
    }
    const i = vertexIndex.get(legKey(a));
    const j = vertexIndex.get(legKey(b));
    const pairKey = i < j ? `${i}-${j}` : `${j}-${i}`;
    const slotDiff = vertices[i].slot && vertices[j].slot && vertices[i].slot !== vertices[j].slot ? 1 : 0;
    const edge = { i: Math.min(i, j), j: Math.max(i, j), ev: candidate.ev, slotDiff, candidate };
    const existing = edgeByPair.get(pairKey);
    // The same unordered pair quoted twice is a duplicate, not two bets.
    if (!existing || edge.ev > existing.ev) edgeByPair.set(pairKey, edge);
    else rejected.push({ candidate, reason: 'duplicate of a higher-EV quote for the same pair of legs' });
  }

  const edges = [...edgeByPair.values()];
  const n = vertices.length;
  const adjacency = Array.from({ length: n }, () => []);
  edges.forEach((edge, index) => {
    adjacency[edge.i].push({ other: edge.j, index });
    adjacency[edge.j].push({ other: edge.i, index });
  });

  const emptyResult = chosen => buildResult({ chosen, vertices, edges, adjacency, cap, rejected });
  if (!edges.length || cap === 0) {
    return { ...emptyResult([]), method: 'no_search_needed', optimal: true,
      notes: [!edges.length ? 'no legal pair of legs on this board' : 'maxTickets is zero'] };
  }

  /* ---------------------------- greedy, used as the fallback only -------- */
  const greedy = () => {
    const order = [...edges].sort((x, y) => y.ev - x.ev || y.slotDiff - x.slotDiff);
    const used = new Set();
    const picked = [];
    for (const edge of order) {
      if (picked.length >= cap) break;
      if (used.has(edge.i) || used.has(edge.j)) continue;
      used.add(edge.i); used.add(edge.j); picked.push(edge);
    }
    return picked;
  };

  if (n > 30) {
    return { ...emptyResult(greedy()), method: 'greedy_fallback', optimal: false,
      notes: [`${n} legs exceeds the 30-leg bitmask limit of the exact search; this set is greedy and may not be optimal`] };
  }

  /* ------------------------------- exact memoised search ----------------- */
  const capForSearch = Math.min(cap, Math.floor(n / 2));
  const memo = new Map();
  let nodes = 0;
  let exhausted = false;

  // `available` is a bitmask of legs not yet spoken for; `left` is the number
  // of tickets still in budget. Returns the best {ev, slots} reachable plus the
  // decision taken at this node, for reconstruction afterwards.
  const solve = (available, left) => {
    if (available === 0 || left === 0) return { ev: 0, slots: 0, choice: null };
    const key = available * (capForSearch + 1) + left;
    const hit = memo.get(key);
    if (hit) return hit;
    if (++nodes > nodeBudget) { exhausted = true; return { ev: 0, slots: 0, choice: null }; }

    const lowest = 31 - Math.clz32(available & -available);
    const withoutLowest = available & ~(1 << lowest);

    // Option one: this leg goes unused.
    const skipped = solve(withoutLowest, left);
    let best = { ev: skipped.ev, slots: skipped.slots, choice: null };

    // Option two: pair it with each still-available partner.
    for (const { other, index } of adjacency[lowest]) {
      if (!(available & (1 << other))) continue;
      const edge = edges[index];
      const rest = solve(withoutLowest & ~(1 << other), left - 1);
      const candidateBest = { ev: edge.ev + rest.ev, slots: edge.slotDiff + rest.slots, choice: index };
      if (better(candidateBest, best)) best = candidateBest;
      if (exhausted) break;
    }
    if (!exhausted) memo.set(key, best);
    return best;
  };

  const full = (1 << n) - 1;                       // n <= 30 by the guard above
  solve(full, capForSearch);

  if (exhausted) {
    return { ...emptyResult(greedy()), method: 'greedy_fallback', optimal: false,
      notes: [`the exact search passed its ${nodeBudget}-state budget on a ${n}-leg, ${edges.length}-pair board; ` +
        'this set is greedy and may not be optimal'] };
  }

  // Walk the memo back out into the actual edge list.
  const chosen = [];
  let available = full;
  let left = capForSearch;
  while (available !== 0 && left > 0) {
    const node = memo.get(available * (capForSearch + 1) + left) ?? { choice: null };
    const lowest = 31 - Math.clz32(available & -available);
    if (node.choice == null) { available &= ~(1 << lowest); continue; }
    const edge = edges[node.choice];
    chosen.push(edge);
    available &= ~((1 << edge.i) | (1 << edge.j));
    left -= 1;
  }

  return { ...emptyResult(chosen), method: 'exact_maximum_weight_matching', optimal: true,
    search: { states_explored: nodes, memo_size: memo.size, node_budget: nodeBudget },
    notes: [] };
}

/** Lexicographic (EV, then kickoff-slot spread). The tolerance is float slop, not a fudge. */
function better(a, b) {
  if (a.ev - b.ev > 1e-12) return true;
  if (b.ev - a.ev > 1e-12) return false;
  return a.slots > b.slots;
}

function buildResult({ chosen, vertices, edges, adjacency, cap, rejected }) {
  const used = new Set();
  for (const edge of chosen) { used.add(edge.i); used.add(edge.j); }

  const tickets = chosen
    .map(edge => ({
      ...edge.candidate,
      ev: edge.ev,
      legs_in_different_slots: edge.slotDiff === 1,
      kickoff_slots: [vertices[edge.i].slot, vertices[edge.j].slot],
    }))
    .sort((x, y) => y.ev - x.ev);

  // WHY a leg was left out. `all_partners_used` is not a guess: with every EV
  // positive, an optimal set below the ticket cap that left a leg whose partner
  // was also free would not be optimal — another disjoint ticket could be added
  // for a strictly higher total. So under the cap, an unused leg with partners
  // must have had every one of them taken.
  const atCap = chosen.length >= cap;
  const unused = vertices
    .map((vertex, index) => ({ vertex, index }))
    .filter(({ index }) => !used.has(index))
    .map(({ vertex, index }) => {
      const partners = adjacency[index].length;
      const reason = partners === 0 ? 'no_legal_partner'
        : atCap ? 'ticket_cap_reached'
          : 'all_partners_used_by_higher_ev_tickets';
      return {
        event_id: vertex.event_id, team: vertex.team, line: vertex.line,
        teased_to: vertex.teased_to, commence_time: vertex.commence_time,
        kickoff_slot: vertex.slot, legal_partners: partners, reason,
      };
    });

  const totalEv = chosen.reduce((sum, edge) => sum + edge.ev, 0);
  return {
    tickets,
    ticket_count: tickets.length,
    total_ev: totalEv,
    total_ev_percent: totalEv * 100,
    mean_ev_per_ticket: tickets.length ? totalEv / tickets.length : null,
    disjoint: true,
    legs_used: [...used].map(i => vertices[i].key).sort(),
    legs_unused: unused,
    graph: { legs: vertices.length, legal_pairs: edges.length, max_tickets: cap },
    rejected,
    version: TEASER_SEASON_VERSION,
  };
}

/* ========================================================================= */
/* 3. SEASON STATE, PACE AND PROJECTION                                      */
/* ========================================================================= */

export const SEASON_WEEKS = 18;

/**
 * Which NFL season a timestamp belongs to. March is the boundary because the
 * league year turns in March; a February game is the previous season's
 * playoffs, not the next season's week 1.
 */
export function nflSeasonOf(when) {
  const at = new Date(when);
  if (Number.isNaN(at.getTime())) return null;
  return at.getUTCMonth() + 1 >= 3 ? at.getUTCFullYear() : at.getUTCFullYear() - 1;
}

/**
 * Week 1's Thursday: the Thursday after the first Monday in September, which is
 * the rule the league has used since 2002. Computed rather than tabulated so it
 * does not need maintaining, and returned at 00:00 UTC on that date — the hour
 * does not matter because everything downstream measures whole weeks from it.
 */
export function seasonWeek1Kickoff(season) {
  const sept1 = new Date(Date.UTC(season, 8, 1));
  const firstMonday = 1 + ((8 - sept1.getUTCDay()) % 7);   // getUTCDay: Monday = 1
  return new Date(Date.UTC(season, 8, firstMonday + 3));
}

/** Where in the season we are. Week 1 is the week that starts at week 1's Thursday. */
export function seasonPaceClock({ season, now = new Date() } = {}) {
  const week1 = seasonWeek1Kickoff(season);
  const elapsedMs = new Date(now).getTime() - week1.getTime();
  const weeksSinceKickoff = elapsedMs / (7 * 24 * 3600e3);
  const currentWeek = Math.min(SEASON_WEEKS + 1, Math.max(0, Math.floor(weeksSinceKickoff) + 1));
  const weeksElapsed = Math.min(SEASON_WEEKS, Math.max(0, currentWeek - 1));
  return {
    season,
    week1_kickoff: week1.toISOString(),
    season_weeks: SEASON_WEEKS,
    current_week: currentWeek > SEASON_WEEKS ? null : currentWeek,
    weeks_elapsed: weeksElapsed,
    // Includes the week in progress, which is bettable until its games kick.
    weeks_remaining: Math.max(0, SEASON_WEEKS - weeksElapsed),
    season_over: currentWeek > SEASON_WEEKS,
    note: 'weeks_elapsed counts fully completed weeks; weeks_remaining includes the week in progress.',
  };
}

/* --------------------------------------------- the forward rate prior ---- */

/**
 * THE HONESTY THAT MATTERS MOST IN THIS FILE.
 *
 * The measured family rate is 74.06% of decided legs on n = 2,868. Its SAMPLING
 * standard error is 0.81pp, so a naive 95% interval is [72.5%, 75.7%]. Running
 * the projection off that interval would be a lie of a specific and expensive
 * kind: it treats 26 seasons of a non-stationary market as if they were 2,868
 * draws from a fixed urn.
 *
 * They are not. Between 1999 and 2024 the market's key-number habits moved, the
 * scoring environment moved, and books learned what a Wong teaser is. The
 * forward rate is not the historical rate plus sampling noise; it is the
 * historical rate plus sampling noise plus drift, and the drift term is bigger.
 *
 * So the projection draws the leg rate itself from Beta(alpha, beta) with the
 * measured mean and a standard deviation of 2.3pp — roughly a 95% forward
 * interval of [69.6%, 78.5%], i.e. the 70-79% a sceptical operator would
 * actually quote. In pseudo-sample terms that beta is worth about 360 legs, not
 * 2,868: it deliberately discounts the historical sample eightfold, which is
 * the numerical form of "the past is informative about the future, but not
 * eight times more informative than a single season would be".
 *
 * Beta rather than a normal for the obvious reason (it cannot wander past 1)
 * and one non-obvious one: it is the conjugate form, so the pseudo-sample size
 * `alpha + beta` is directly readable as "how much evidence am I claiming",
 * which is the number a reader should argue with. Argue with 360.
 *
 * `projectRemainingSeason` returns BOTH the at-the-point-estimate run and the
 * with-rate-uncertainty run, and `wongSeason` marks the second as the headline.
 * That is on purpose: a caller that shows only one number should be made to
 * show the honest one, and a caller that wants the flattering one has to
 * reach past a field called `optimistic_ignores_rate_uncertainty` to get it.
 */
export const FORWARD_RATE_SD = 0.023;

export function forwardRatePrior({ mean, sd = FORWARD_RATE_SD } = {}) {
  if (!Number.isFinite(mean) || mean <= 0 || mean >= 1) {
    throw new TypeError(`forwardRatePrior needs a mean strictly between 0 and 1, got ${mean}`);
  }
  const variance = sd * sd;
  const concentration = (mean * (1 - mean)) / variance - 1;
  if (!(concentration > 0)) throw new TypeError('forward rate sd is too wide for this mean');
  return {
    distribution: 'beta',
    alpha: mean * concentration,
    beta: (1 - mean) * concentration,
    mean, sd,
    pseudo_sample_legs: concentration,
    rationale: 'sampling error alone is 0.81pp on n=2868; this widens it to 2.3pp to carry ' +
      'market drift over 26 non-stationary seasons, which is the dominant forward uncertainty.',
  };
}

/* ------------------------------------------------------------ the RNG ---- */

/** Seeded so a projection is reproducible; a projection that moves when nobody changed anything is not evidence. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia-Tsang. Both shapes here are well above 1, so the a<1 boost is not needed. */
function gammaSample(shape, rng) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = rng();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

function betaSample(alpha, beta, rng) {
  const x = gammaSample(alpha, rng);
  return x / (x + gammaSample(beta, rng));
}

/* ------------------------------------------------------- the leg mix ---- */

/**
 * The forward leg population: each of the eight family lines, weighted by how
 * often the market actually posts it, carrying ITS OWN push share.
 *
 * Not a pooled push share, because push mass is structural: four of the eight
 * lines are half-points and cannot push at all, and a simulation that gives
 * every leg the pooled 0.9% invents pushes on legs that cannot have them and
 * understates them on legs that can. The MEAN is identical either way — that is
 * arithmetic, not luck — but the variance is not, and the variance is what a
 * projection is for.
 */
export function familyLegMix({ points = TEASER_POINTS } = {}) {
  const mix = CROSS_BOTH_LINES.map(line => {
    const measured = teasedLegRate(line, { points });
    return { line, weight: measured.n, push_share: measured.push_share ?? 0 };
  }).filter(entry => entry.weight > 0);
  const total = mix.reduce((sum, entry) => sum + entry.weight, 0);
  if (!total) {
    throw new Error('the cross-both family has no measured legs in this database — ' +
      'pass an explicit legMix (a fixture database has no game_lines)');
  }
  return mix.map(entry => ({ ...entry, weight: entry.weight / total }));
}

function cumulative(mix) {
  let running = 0;
  return mix.map(entry => { running += entry.weight; return { ...entry, upto: running }; });
}

/* ------------------------------------------------------ the simulation --- */

const REDUCED_GRADE = Object.freeze({
  stake_back: () => 0,
  same_price: b => b,
  graded_loss: () => -1,
});

/**
 * One season's worth of remaining tickets, in units of profit.
 *
 * Each leg draws a line from the mix, then pushes with that line's push share
 * and otherwise wins at the decided rate. Legs are independent, which is very
 * slightly optimistic — `familyPairCorrelation()` measures rho = -0.044 on
 * same-week family legs, so independence overstates a two-leg ticket's win
 * probability by about 0.85pp. That overstatement is the same one `ticketEV`
 * already carries, so leaving it here keeps the projection consistent with the
 * price gate rather than quietly disagreeing with it. It is an overstatement,
 * not a safety margin.
 */
function simulateRemainder({ tickets, rate, mixCdf, payout, grade, stakeUnits, rng }) {
  let profit = 0;
  for (let t = 0; t < tickets; t++) {
    let wins = 0, pushes = 0, lost = false;
    for (let leg = 0; leg < 2; leg++) {
      const draw = rng();
      let entry = mixCdf[mixCdf.length - 1];
      for (const item of mixCdf) { if (draw <= item.upto) { entry = item; break; } }
      const u = rng();
      if (u < entry.push_share) pushes++;
      else if (u < entry.push_share + (1 - entry.push_share) * rate) wins++;
      else { lost = true; break; }
    }
    if (lost) profit -= stakeUnits;
    else if (wins === 2) profit += stakeUnits * payout;
    else if (pushes === 2) profit += 0;                    // voided, stake back
    else profit += stakeUnits * grade(payout);             // one push, one win
  }
  return profit;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function summariseRuns(profits, { unitSize, realisedUnits }) {
  const sorted = [...profits].sort((a, b) => a - b);
  const mean = profits.reduce((sum, v) => sum + v, 0) / (profits.length || 1);
  const losingRemainder = profits.filter(v => v < 0).length / (profits.length || 1);
  const losingSeason = profits.filter(v => v + realisedUnits < 0).length / (profits.length || 1);
  const stat = value => (value == null ? null : { units: r4(value), dollars: r2(value * unitSize) });
  return {
    runs: profits.length,
    mean: stat(mean),
    median: stat(percentile(sorted, 0.5)),
    p05: stat(percentile(sorted, 0.05)),
    p95: stat(percentile(sorted, 0.95)),
    // Season = what is already banked plus what is left to run. Remainder =
    // the forward tickets alone, which is the number to judge the strategy by
    // and the number a good week of luck cannot flatter.
    probability_of_losing_season: r4(losingSeason),
    probability_of_losing_remainder: r4(losingRemainder),
  };
}

/**
 * The projection.
 *
 * Two runs, always both: one at the point estimate, one drawing the leg rate
 * from the forward prior. Neither is optional and the second is the headline —
 * see the comment on `FORWARD_RATE_SD`.
 */
export function projectRemainingSeason({
  tickets, americanPrice, stakeUnits = 1, unitSize = 100,
  reducedPayout = DEFAULT_REDUCED_PAYOUT, legRate = null, legMix = null,
  runs = 50_000, seed = 20260910, realisedUnits = 0, rateSd = FORWARD_RATE_SD,
} = {}) {
  if (!Number.isInteger(tickets) || tickets < 0) {
    throw new TypeError(`projectRemainingSeason needs a non-negative integer ticket count, got ${tickets}`);
  }
  const grade = REDUCED_GRADE[reducedPayout];
  if (!grade) throw new TypeError(`unknown reducedPayout '${reducedPayout}'`);
  if (!Number.isInteger(runs) || runs < 1000) {
    throw new TypeError(`projectRemainingSeason needs at least 1000 runs, got ${runs}`);
  }

  const rate = legRate ?? familyRate({ side: 'all' }).rate_of_decided;
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) {
    throw new Error('the family leg rate is unavailable — pass legRate explicitly ' +
      '(a fixture database has no game_lines to measure)');
  }
  const mix = legMix ?? familyLegMix();
  const mixWeight = mix.reduce((sum, entry) => sum + entry.weight, 0);
  if (Math.abs(mixWeight - 1) > 1e-6) throw new TypeError(`legMix weights must sum to 1, got ${mixWeight}`);
  const mixCdf = cumulative(mix);
  const payout = profitMultiple(americanPrice);
  const prior = forwardRatePrior({ mean: rate, sd: rateSd });

  // The analytic answer, for the point-estimate run to be checked against. The
  // pooled push share is the mix-weighted average by construction, so this is
  // the same bet the simulation is drawing, priced in closed form.
  const pooledPush = mix.reduce((sum, entry) => sum + entry.weight * entry.push_share, 0);
  const legProbability = { w: (1 - pooledPush) * rate, t: pooledPush };
  const analytic = ticketEV({ legs: [legProbability, legProbability], americanPrice, reducedPayout });

  const pointProfits = new Float64Array(runs);
  const uncertainProfits = new Float64Array(runs);
  const drawnRates = new Float64Array(runs);
  const pointRng = mulberry32(seed);
  const uncertainRng = mulberry32(seed ^ 0x9e3779b9);

  for (let i = 0; i < runs; i++) {
    pointProfits[i] = simulateRemainder({ tickets, rate, mixCdf, payout, grade, stakeUnits, rng: pointRng });
    const drawn = betaSample(prior.alpha, prior.beta, uncertainRng);
    drawnRates[i] = drawn;
    uncertainProfits[i] = simulateRemainder({ tickets, rate: drawn, mixCdf, payout, grade, stakeUnits, rng: uncertainRng });
  }

  const drawnSorted = [...drawnRates].sort((a, b) => a - b);
  const pointArray = [...pointProfits];
  const uncertainArray = [...uncertainProfits];

  return {
    tickets,
    american_price: americanPrice,
    profit_multiple: payout,
    stake_units: stakeUnits,
    unit_size_dollars: unitSize,
    reduced_payout: reducedPayout,
    reduced_payout_verified: false,
    leg_rate_point_estimate: rate,
    leg_mix: mix,
    pooled_push_share: pooledPush,
    analytic: {
      ev_per_ticket: analytic.ev,
      ev_percent_per_ticket: analytic.ev_percent,
      probabilities: analytic.probabilities,
      break_even_american: analytic.break_even_american,
      expected_units: analytic.ev * stakeUnits * tickets,
      expected_dollars: r2(analytic.ev * stakeUnits * tickets * unitSize),
    },
    rate_prior: {
      ...prior,
      // Measured off the actual draws, so the stated interval is an observation
      // of this run rather than a claim about the arithmetic above it.
      observed_interval_95: [r4(percentile(drawnSorted, 0.025)), r4(percentile(drawnSorted, 0.975))],
      observed_mean: r4(drawnSorted.reduce((s, v) => s + v, 0) / (drawnSorted.length || 1)),
    },
    optimistic_ignores_rate_uncertainty: summariseRuns(pointArray, { unitSize, realisedUnits }),
    with_rate_uncertainty: summariseRuns(uncertainArray, { unitSize, realisedUnits }),
    headline: 'with_rate_uncertainty',
    honesty: 'optimistic_ignores_rate_uncertainty holds the leg rate fixed at the measured ' +
      '74.06% and therefore reports sampling noise only. with_rate_uncertainty draws the rate ' +
      'from the forward prior and is the one to quote. Showing only the first would understate ' +
      'the spread and the chance of a losing season.',
    seed,
    version: TEASER_SEASON_VERSION,
  };
}

/* -------------------------------------------------------- season state --- */

function executionSeason(execution) {
  const kickoffs = (execution.legs ?? []).map(leg => leg.commence_time).filter(Boolean).sort();
  return nflSeasonOf(kickoffs[0] ?? execution.logged_at);
}

/**
 * The recorded price to project at.
 *
 * In order of evidentiary weight: the price on this season's own placed
 * tickets (what was actually taken), then the newest reachable price in the
 * price ledger for a configured book (what is currently offered), then the
 * owner's recorded DraftKings +100 (what was seen once). The chosen source is
 * reported, because "+100" from a ledger row and "+100" from a default are not
 * the same claim.
 */
function priceForProjection({ executions, books }) {
  const placed = executions.filter(e => e.mode === 'placed' && Number.isFinite(e.american_price));
  if (placed.length) {
    const counts = new Map();
    for (const e of placed) counts.set(e.american_price, (counts.get(e.american_price) ?? 0) + 1);
    const [price] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    return { american_price: price, source: 'modal price of this season\'s placed tickets' };
  }
  for (const book of books) {
    const ledger = db.prepare(`SELECT american_price, captured_at FROM nfl_teaser_price_ledger
      WHERE teaser_points = 6 AND legs = 2 AND reachable = 1
        AND lower(replace(replace(book,' ',''),'-','')) = ?
      ORDER BY captured_at DESC, id DESC LIMIT 1`).get(bookKey(book));
    if (ledger) {
      return { american_price: ledger.american_price,
        source: `newest reachable ${book} price in nfl_teaser_price_ledger (${ledger.captured_at})` };
    }
  }
  return { american_price: 100,
    source: 'default: the owner\'s recorded DraftKings +100, push removes the leg and reduces to a single' };
}

/**
 * Where the season stands and where it is going.
 *
 * Placed and paper are kept apart throughout, the same way
 * `teaserExecutionLedger` keeps them apart: money is money and paper is a
 * rehearsal, and a combined ROI is a number that describes neither.
 */
export function wongSeason({
  season = nflSeasonOf(new Date()), now = new Date(), settings = null,
  legRate = null, legMix = null, runs = 50_000, seed = 20260910,
  ticketsPerWeek = null, ledgerLimit = 1000, rateSd = FORWARD_RATE_SD,
} = {}) {
  const config = settings ?? wongSettings();
  const ledger = teaserExecutionLedger({ limit: ledgerLimit });
  const mine = ledger.executions.filter(execution => executionSeason(execution) === season);
  const placed = mine.filter(execution => execution.mode === 'placed');
  const paper = mine.filter(execution => execution.mode === 'paper');

  const account = tickets => {
    const settled = tickets.filter(t => t.status !== 'open');
    const staked = settled.reduce((sum, t) => sum + (t.stake_units ?? 0), 0);
    const profit = settled.reduce((sum, t) => sum + (t.profit_units ?? 0), 0);
    return {
      tickets: tickets.length,
      open: tickets.filter(t => t.status === 'open').length,
      won: tickets.filter(t => t.status === 'won').length,
      lost: tickets.filter(t => t.status === 'lost').length,
      pushed: tickets.filter(t => t.status === 'push').length,
      voided: tickets.filter(t => t.status === 'void').length,
      open_exposure_units: r4(tickets.filter(t => t.status === 'open')
        .reduce((sum, t) => sum + (t.stake_units ?? 0), 0)),
      units_staked: r4(staked),
      units_won: r4(settled.reduce((sum, t) => sum + Math.max(0, t.profit_units ?? 0), 0)),
      units_lost: r4(-settled.reduce((sum, t) => sum + Math.min(0, t.profit_units ?? 0), 0)),
      net_units: r4(profit),
      net_dollars: r2(profit * config.unit_size_dollars),
      roi: staked > 0 ? r4(profit / staked) : null,
      record: `${tickets.filter(t => t.status === 'won').length}-` +
        `${tickets.filter(t => t.status === 'lost').length}-` +
        `${tickets.filter(t => t.status === 'push' || t.status === 'void').length}`,
    };
  };

  const placedAccount = account(placed);
  const clock = seasonPaceClock({ season, now });
  const measuredPerWeek = clock.weeks_elapsed > 0 ? placed.length / clock.weeks_elapsed : null;
  const plannedPerWeek = Number.isFinite(ticketsPerWeek) ? ticketsPerWeek
    : (measuredPerWeek && measuredPerWeek > 0 ? measuredPerWeek : config.max_tickets_per_week);
  const ticketsRemaining = Math.max(0, Math.round(plannedPerWeek * clock.weeks_remaining));

  const price = priceForProjection({ executions: mine, books: config.books });
  const projection = projectRemainingSeason({
    tickets: ticketsRemaining,
    americanPrice: price.american_price,
    stakeUnits: config.stake_units,
    unitSize: config.unit_size_dollars,
    reducedPayout: config.reduced_payout,
    legRate, legMix, runs, seed, rateSd,
    realisedUnits: placedAccount.net_units ?? 0,
  });

  return {
    season,
    generated_at: new Date(now).toISOString(),
    settings: config,
    placed: placedAccount,
    paper: account(paper),
    open_tickets: mine.filter(t => t.status === 'open').map(t => ({
      id: t.id, mode: t.mode, book: t.book, american_price: t.american_price,
      stake_units: t.stake_units, logged_at: t.logged_at,
      legs: (t.legs ?? []).map(leg => ({ event_id: leg.event_id, team: leg.team,
        market_line: leg.market_line, teased_line: leg.teased_line, commence_time: leg.commence_time })),
    })),
    pace: {
      ...clock,
      placed_tickets: placed.length,
      paper_tickets: paper.length,
      tickets_per_week: measuredPerWeek == null ? null : r4(measuredPerWeek),
      planned_tickets_per_week: r4(plannedPerWeek),
      tickets_remaining: ticketsRemaining,
      projected_full_season_tickets: placed.length + ticketsRemaining,
      pace_basis: Number.isFinite(ticketsPerWeek) ? 'caller override'
        : (measuredPerWeek && measuredPerWeek > 0
          ? 'measured from placed tickets so far'
          : 'no placed tickets yet — using the configured max_tickets_per_week'),
    },
    price,
    projection,
    forward_leg_rate: ledger.summary.forward_leg_rate,
    version: TEASER_SEASON_VERSION,
  };
}

/* ========================================================================= */
/* 4. RECORDING A BET                                                        */
/* ========================================================================= */

/**
 * Log a chosen ticket, through the existing ledger.
 *
 * A DELIBERATE SEAM, STATED RATHER THAN PAPERED OVER. `recordTeaserExecution`
 * will only log a candidate that appears on `teaserExecutionBoard()`, and that
 * board is compiled from `simultaneousQuotes`, which pins each event to its
 * single newest capture instant. `teaser-scan.js` exists precisely because that
 * pin drops slow-tier books — DraftKings among them — so a ticket the scan
 * found may well have no counterpart on the execution board.
 *
 * The honest options were: reimplement the insert here (two ledgers, two
 * answers), or bridge and report when the bridge fails. This bridges. It
 * matches the scan ticket to a board candidate by book and by its exact pair of
 * (event_id, team) legs, and when there is no match it returns the board's own
 * blocked reasons rather than writing a row the ledger's own gates never
 * approved. That failure is not a bug in this function; it is the seam being
 * visible, and it is where the two boards should be reconciled.
 */
export function recordWongTicket({
  ticket, mode = null, stakeUnits = null, note = null, settings = null, board = null, book = null,
} = {}) {
  const config = settings ?? wongSettings();
  const legality = ticketLegality(ticket);
  if (!legality.legal) return { error: 'ticket is not a legal Wong ticket', reason: legality.reason };

  const chosenMode = mode ?? config.default_mode;
  if (!['paper', 'placed'].includes(chosenMode)) {
    return { error: `mode must be 'paper' or 'placed', got ${chosenMode}` };
  }
  const units = stakeUnits ?? config.stake_units;
  if (!Number.isFinite(units) || units <= 0 || units > 5) {
    return { error: `stake_units must be greater than 0 and at most 5, got ${units}` };
  }

  const executionBoard = board ?? teaserExecutionBoard();
  const wanted = ticket.legs.map(leg => `${leg.event_id}|${leg.team}`).sort().join('||');
  // `bestTicketSet` passes the scan candidate straight through and the scan
  // puts the book on the board rather than on each ticket, so the caller may
  // have to say which book this was found at. Unset means "any".
  const wantedBook = (book ?? ticket.book) ? bookKey(book ?? ticket.book) : null;
  const match = executionBoard.candidates.find(candidate => {
    if (wantedBook && bookKey(candidate.book) !== wantedBook) return false;
    return candidate.legs.map(leg => `${leg.event_id}|${leg.team}`).sort().join('||') === wanted;
  });

  if (!match) {
    return {
      error: 'this ticket has no counterpart on the execution board, so the ledger will not accept it',
      reason: 'recordTeaserExecution only logs candidates compiled by teaserExecutionBoard(), which is ' +
        'built on simultaneousQuotes() and pins each event to its newest capture instant. A scan ticket ' +
        'from a slow-tier book (DraftKings included) is routinely absent from it.',
      wanted_legs: ticket.legs.map(leg => ({ event_id: leg.event_id, team: leg.team, line: leg.line })),
      board_candidates: executionBoard.candidates.length,
      board_status: executionBoard.status,
      board_blocked_reasons: [...new Set(executionBoard.books.flatMap(b => b.blocked_reasons ?? []))],
    };
  }

  const logged = recordTeaserExecution({
    candidate_id: match.candidate_id, mode: chosenMode, stake_units: units,
    note: note ?? `wong season selector, ${config.stake_units}u at ${config.unit_size_dollars}/unit`,
  });
  if (logged.error) return logged;
  return {
    ...logged,
    stake_units: units,
    stake_dollars: r2(units * config.unit_size_dollars),
    ticket_ev: Number.isFinite(ticket.ev) ? ticket.ev : null,
    expected_dollars: Number.isFinite(ticket.ev)
      ? r2(ticket.ev * units * config.unit_size_dollars) : null,
    version: TEASER_SEASON_VERSION,
  };
}
