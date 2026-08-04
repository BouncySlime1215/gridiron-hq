/**
 * First-party MLB auto-picks.
 *
 * The previous auto-picks came from the proxied board, so when that pipeline
 * stopped publishing the page froze on July 19 forever — and worse, the picks
 * could never be graded, because grading depended on the same dead feed.
 *
 * These are generated from local projections and graded against local box
 * scores. Both halves are self-sufficient, so the page keeps working whether or
 * not anyone else's pipeline is alive.
 *
 * One honest limitation: there is no MLB odds feed wired up, so these cannot be
 * ranked by edge against a market price the way the NFL board is. They are
 * ranked by model conviction — how far the projection sits from a coin flip —
 * and the record below is therefore a test of the projections, not of any
 * claimed edge over a sportsbook.
 */
import { db, rows, run } from '../db/index.js';
import { boardFor } from './mlb-projections.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS mlb_first_party_picks (
    pick_date TEXT NOT NULL, rank INTEGER NOT NULL,
    market TEXT NOT NULL, selection TEXT, player_id INTEGER,
    matchup TEXT, game_pk INTEGER,
    side TEXT, line REAL, model_probability REAL, projection REAL,
    selected_at TEXT NOT NULL,
    PRIMARY KEY (pick_date, rank)
  );
`);

const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));
/** Distance from a coin flip — the only conviction measure available without prices. */
const conviction = p => Math.abs(p - 0.5);

/**
 * Bounds on what counts as a real pick.
 *
 * Ranking purely by conviction selects trivially true props — "this reliever
 * will not strike out six batters" projects at 96% and would win essentially
 * always, because no sportsbook would ever post that line. Including such picks
 * inflates the win rate while testing nothing.
 *
 * A pick only counts when the projection sits in the band a book would actually
 * price around a standard number. Anything more certain than PLAUSIBLE_MAX is a
 * line that would not exist, and anything under PLAUSIBLE_MIN is a coin flip
 * with no opinion behind it.
 */
const PLAUSIBLE_MIN = 0.54;
const PLAUSIBLE_MAX = 0.78;
/** A starter, not an opener or a long reliever who happened to start. */
const MIN_IP_PER_START = 4.0;

/**
 * Builds the day's candidate plays across all three markets, ranked by how
 * confident the model is rather than by edge, since no prices exist to compare.
 */
export function candidatesFor(date) {
  const board = boardFor(date, { limit: 120 });
  if (!board.games?.length) return { date: board.date, candidates: [], note: board.note };

  const out = [];

  for (const g of board.games) {
    if (!g.nrfi) continue;
    const side = g.nrfi.nrfi_probability >= 0.5 ? 'NRFI' : 'YRFI';
    const p = Math.max(g.nrfi.nrfi_probability, g.nrfi.yrfi_probability);
    if (p < PLAUSIBLE_MIN || p > PLAUSIBLE_MAX) continue;
    out.push({
      market: 'nrfi', selection: g.matchup, matchup: g.matchup, game_pk: g.game_pk,
      side, line: null, model_probability: r3(p), projection: null,
      conviction: r3(conviction(p))
    });
  }

  for (const b of board.batters) {
    // 1.5 total bases is the standard line and the one worth an opinion.
    const p = b.probabilities?.['over_1.5'];
    if (p == null) continue;
    const over = p >= 0.5;
    const sideProb = over ? p : 1 - p;
    if (sideProb < PLAUSIBLE_MIN || sideProb > PLAUSIBLE_MAX) continue;
    out.push({
      market: 'batter_total_bases', selection: b.name, player_id: b.player_id,
      matchup: null, side: over ? 'Over' : 'Under', line: 1.5,
      model_probability: r3(sideProb), projection: b.mean_tb,
      conviction: r3(conviction(p))
    });
  }

  for (const pit of board.pitchers) {
    // Openers and long relievers make the strikeout line meaningless — a book
    // only posts 5.5 for someone expected to work into the fifth or beyond.
    if ((pit.ip_per_start ?? 0) < MIN_IP_PER_START) continue;
    const p = pit.probabilities?.['over_5.5'];
    if (p == null) continue;
    const over = p >= 0.5;
    const sideProb = over ? p : 1 - p;
    if (sideProb < PLAUSIBLE_MIN || sideProb > PLAUSIBLE_MAX) continue;
    out.push({
      market: 'pitcher_strikeouts', selection: pit.name, player_id: pit.player_id,
      matchup: null, side: over ? 'Over' : 'Under', line: 5.5,
      model_probability: r3(sideProb), projection: pit.mean_k,
      conviction: r3(conviction(p))
    });
  }

  out.sort((a, b) => b.conviction - a.conviction);
  return { date: board.date, fell_back: board.fell_back ?? null, candidates: out };
}

/**
 * Locks in the day's five picks. Idempotent per date, so revisiting the page
 * never reshuffles a slate that has already been committed to.
 */
export function ensurePicksFor(date, n = 5) {
  const existing = rows('SELECT * FROM mlb_first_party_picks WHERE pick_date = ? ORDER BY rank', date);
  if (existing.length) return existing;

  const { candidates, date: actualDate } = candidatesFor(date);
  if (!candidates?.length) return [];

  // Spread the five across markets rather than letting one dominate — five
  // strikeout unders on the same slate is one correlated bet, not five.
  const picked = [];
  const perMarket = {};
  for (const c of candidates) {
    const used = perMarket[c.market] ?? 0;
    if (used >= 2 && picked.length < n) continue;
    picked.push(c);
    perMarket[c.market] = used + 1;
    if (picked.length >= n) break;
  }
  for (const c of candidates) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }

  const now = new Date().toISOString();
  picked.slice(0, n).forEach((c, i) => {
    run(`INSERT INTO mlb_first_party_picks
        (pick_date, rank, market, selection, player_id, matchup, game_pk, side, line,
         model_probability, projection, selected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pick_date, rank) DO NOTHING`,
      actualDate, i + 1, c.market, c.selection, c.player_id ?? null, c.matchup ?? null,
      c.game_pk ?? null, c.side, c.line, c.model_probability, c.projection, now);
  });
  return rows('SELECT * FROM mlb_first_party_picks WHERE pick_date = ? ORDER BY rank', actualDate);
}

/* ---------------------------------------------------------------- grading */

/**
 * Grades a pick against the local box score.
 *
 * This is what the proxied version could never do: results live in the same
 * database, so a pick settles as soon as the day's games are synced.
 */
function gradePick(p) {
  if (p.market === 'nrfi') {
    const g = rows(`SELECT first_inning_home_runs h, first_inning_away_runs a, yrfi
                    FROM mlb_games WHERE game_pk = ?`, p.game_pk)[0];
    if (!g || g.yrfi == null) return { status: 'Pending', detail: 'Awaiting first-inning result' };
    const noRun = g.yrfi === 0;
    const won = p.side === 'NRFI' ? noRun : !noRun;
    return {
      status: won ? 'Won' : 'Lost',
      detail: noRun ? 'No run in the 1st' : `Run scored in the 1st (${g.a}-${g.h})`
    };
  }

  if (p.market === 'batter_total_bases') {
    const b = rows(`SELECT total_bases FROM mlb_batter_games
                    WHERE player_id = ? AND date = ?`, p.player_id, p.pick_date)[0];
    if (!b) return { status: 'Pending', detail: 'No box score yet (or did not play)' };
    if (b.total_bases === p.line) return { status: 'Push', detail: `Exactly ${b.total_bases} TB` };
    const won = p.side === 'Over' ? b.total_bases > p.line : b.total_bases < p.line;
    return { status: won ? 'Won' : 'Lost', detail: `${b.total_bases} total bases` };
  }

  if (p.market === 'pitcher_strikeouts') {
    const s = rows(`SELECT strikeouts FROM mlb_pitcher_games
                    WHERE player_id = ? AND date = ?`, p.player_id, p.pick_date)[0];
    if (!s) return { status: 'Pending', detail: 'No box score yet (or did not start)' };
    if (s.strikeouts === p.line) return { status: 'Push', detail: `Exactly ${s.strikeouts} K` };
    const won = p.side === 'Over' ? s.strikeouts > p.line : s.strikeouts < p.line;
    return { status: won ? 'Won' : 'Lost', detail: `${s.strikeouts} strikeouts` };
  }

  return { status: 'Pending', detail: 'Unknown market' };
}

/**
 * Every pick ever made, graded. Units assume a flat 1-unit stake at -110, the
 * standard price for these markets — there is no stored price to use instead.
 */
export function allPicks() {
  return rows('SELECT * FROM mlb_first_party_picks ORDER BY pick_date DESC, rank ASC')
    .map(p => {
      const g = gradePick(p);
      const units = g.status === 'Won' ? 100 / 110 : g.status === 'Lost' ? -1 : 0;
      return { ...p, ...g, units: +units.toFixed(3) };
    });
}

export function standing() {
  const graded = allPicks();
  const settled = graded.filter(g => g.status === 'Won' || g.status === 'Lost');
  const wins = settled.filter(g => g.status === 'Won').length;
  const losses = settled.filter(g => g.status === 'Lost').length;
  const units = graded.reduce((s, g) => s + g.units, 0);
  return {
    wins, losses,
    pushes: graded.filter(g => g.status === 'Push').length,
    pending: graded.filter(g => g.status === 'Pending').length,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    units: +units.toFixed(2),
    days_tracked: new Set(graded.map(g => g.pick_date)).size,
    by_market: ['nrfi', 'batter_total_bases', 'pitcher_strikeouts'].map(m => {
      const sub = graded.filter(g => g.market === m);
      const s = sub.filter(g => g.status === 'Won' || g.status === 'Lost');
      const w = s.filter(g => g.status === 'Won').length;
      return {
        market: m, picks: sub.length, wins: w, losses: s.length - w,
        win_rate: s.length ? +(w / s.length).toFixed(4) : null,
        units: +sub.reduce((a, g) => a + g.units, 0).toFixed(2)
      };
    }).filter(x => x.picks > 0)
  };
}

/** Backfills picks for past dates so the record is not empty on day one. */
export function backfill(days = 14, endDate = new Date().toISOString().slice(0, 10)) {
  const dates = rows(`SELECT DISTINCT date FROM mlb_games
                      WHERE date <= ? ORDER BY date DESC LIMIT ?`, endDate, days)
    .map(r => r.date).reverse();
  let made = 0;
  for (const d of dates) made += ensurePicksFor(d).length;
  return { dates: dates.length, picks: made };
}
