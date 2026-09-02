/**
 * Free player-prop quote feeds — no key, no credits.
 *
 * `nfl_prop_quote_snapshots` has never held a real row (see nfl-prop-clv.js's
 * header): the only prop source wired up was the metered Odds API, and that
 * budget was gone before Week 1. This is where the model's most demonstrable
 * skill (2+ TD, any-type TD) has never once been compared to a real price.
 *
 * Two providers, each fetched directly (not through a caching aggregator),
 * so — unlike `book-feeds.js` — a quote here needs no `book_updated_at`
 * staleness gate: our own `captured_at` IS the freshness signal, the same
 * convention `book-feeds.js` already uses for Pinnacle and Bovada.
 *
 *   actionnetwork – `api.actionnetwork.com/web/v2/games/{id}/props`, per
 *                    game. Verified 2026-09-02: no key, seven real books
 *                    plus a per-market opener (book id 30). Five markets are
 *                    read here (passing/rushing/receiving yards, receptions,
 *                    anytime TD); the other ~75 (milestone ladders, first/
 *                    last TD, "most yards") are counted and skipped.
 *   underdog        – `api.underdogfantasy.com/beta/v5/over_under_lines`,
 *                    one call for every sport. No key, no headers. Real
 *                    two-sided prices (not just a payout multiplier) on
 *                    four of the five markets — Underdog has no binary
 *                    anytime-TD market, only a yardage-style rush+rec TD
 *                    count, which is a different question and is skipped.
 *
 * Every row lands in the same `nfl_prop_quote_snapshots` shape the Odds API
 * path wrote, plus `provider`, `book_updated_at`, `is_opener` — the pattern
 * `book-feeds.js` established for `nfl_line_snapshots`. `event_id` uses the
 * same canonical `nfl:<date>:<AWAY>@<HOME>` key so props join to the game
 * evidence already keyed that way, not a provider-specific id.
 */
import { db, rows, run } from '../db/index.js';
import { teamResolver } from './team-codes.js';
import './nfl-props.js'; // owns nfl_prop_quote_snapshots, columns extended below

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ENABLED = process.env.FREE_PROP_FEEDS !== '0';
export const enabled = () => ENABLED;

const propCols = new Set(db.prepare('PRAGMA table_info(nfl_prop_quote_snapshots)').all().map(c => c.name));
for (const [column, type] of [['provider', 'TEXT'], ['book_updated_at', 'TEXT'], ['is_opener', 'INTEGER']]) {
  if (!propCols.has(column)) db.exec(`ALTER TABLE nfl_prop_quote_snapshots ADD COLUMN ${column} ${type}`);
}

async function getJson(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const eventKey = (commence, away, home) => `nfl:${String(commence ?? '').slice(0, 10)}:${away}@${home}`;
const cap = s => (s === 'over' ? 'Over' : s === 'under' ? 'Under' : s);

/* -------------------------------------------------------- Action Network */

const ACTION_NETWORK_BOOK_IDS = '30,68,69,71,75,79,123,247'; // Open, DK, FD, BetRivers, BetMGM, bet365, Caesars, Unibet
const ACTION_NETWORK_BOOKS = Object.freeze({
  30: 'action_open', 68: 'draftkings', 69: 'fanduel', 71: 'betrivers',
  75: 'betmgm', 79: 'bet365', 123: 'caesars', 247: 'unibet'
});
// Exact suffix match: the milestone ladders and "most yards" markets share a
// stem with these but always add "_milestones_..." or a "most_" prefix.
const ACTION_NETWORK_MARKET_RE = /_(passing_yards|rushing_yards|receiving_yards|receptions|anytime_touchdown_scorer)$/;
const ACTION_NETWORK_MARKET_MAP = Object.freeze({
  passing_yards: 'player_pass_yds', rushing_yards: 'player_rush_yds',
  receiving_yards: 'player_reception_yds', receptions: 'player_receptions',
  anytime_touchdown_scorer: 'player_anytime_td'
});

/** The week's NFL games from Action Network's scoreboard, teams resolved to our own codes. */
export async function fetchActionNetworkGames({ week = null } = {}, resolve = teamResolver()) {
  const q = week ? `&week=${week}&seasonType=reg` : '';
  const payload = await getJson(`https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=${ACTION_NETWORK_BOOK_IDS}&period=game${q}`);
  const out = [];
  for (const g of payload.games ?? []) {
    const [teamA, teamB] = g.teams ?? [];
    if (!teamA || !teamB) continue;
    const home = resolve(g.home_team_id === teamA.id ? teamA.full_name : teamB.full_name);
    const away = resolve(g.away_team_id === teamA.id ? teamA.full_name : teamB.full_name);
    if (!home || !away) continue;
    out.push({ id: g.id, season: g.season, week: g.week, commence_time: g.start_time, home, away });
  }
  return out;
}

/**
 * One game's props payload -> normalised rows. Pure: takes the already
 * fetched JSON, no network. `capturedAt` stamps every row the same instant.
 */
export function parseActionNetworkProps(payload, game, capturedAt) {
  const out = [];
  let unsupported = 0;
  const players = payload.players ?? {};
  for (const market of Object.values(payload.player_props ?? {})) {
    const suffix = ACTION_NETWORK_MARKET_RE.exec(market.type)?.[1];
    if (!suffix) { unsupported++; continue; }
    const ourMarket = ACTION_NETWORK_MARKET_MAP[suffix];
    const isAnytimeTd = suffix === 'anytime_touchdown_scorer';
    for (const [bookIdStr, lines] of Object.entries(market.lines ?? {})) {
      const book = ACTION_NETWORK_BOOKS[Number(bookIdStr)];
      if (!book) continue;
      for (const line of lines) {
        const player = players[line.player_id]?.full_name ?? market.player_abbr ?? null;
        if (!player || !Number.isFinite(line.odds)) continue;
        out.push({
          event_id: eventKey(game.commence_time, game.away.abbr, game.home.abbr),
          commence_time: game.commence_time, home_team: game.home.name, away_team: game.away.name,
          book, market: ourMarket, player, side: isAnytimeTd ? 'Yes' : cap(line.side),
          line: isAnytimeTd ? null : line.value, american_price: line.odds,
          provider: 'actionnetwork', book_updated_at: null, is_opener: book === 'action_open' ? 1 : 0,
          captured_at: capturedAt
        });
      }
    }
  }
  return { rows: out, unsupported };
}

/** Fetch and parse one week's Action Network props, every game. */
export async function captureActionNetworkProps({ week = null } = {}) {
  if (!ENABLED) return { skipped: true, reason: 'FREE_PROP_FEEDS=0' };
  const games = await fetchActionNetworkGames({ week });
  const capturedAt = new Date().toISOString();
  let stored = 0, unsupported = 0;
  const errors = {};
  for (const game of games) {
    try {
      const payload = await getJson(`https://api.actionnetwork.com/web/v2/games/${game.id}/props?bookIds=${ACTION_NETWORK_BOOK_IDS}`);
      const { rows: parsed, unsupported: u } = parseActionNetworkProps(payload, game, capturedAt);
      unsupported += u;
      stored += persistPropQuotes(parsed);
    } catch (error) { errors[game.id] = error.message; }
  }
  return { provider: 'actionnetwork', games: games.length, stored, unsupported, errors, captured_at: capturedAt };
}

/* ------------------------------------------------------------- Underdog */

const UNDERDOG_STAT_MAP = Object.freeze({
  passing_yds: 'player_pass_yds', rushing_yds: 'player_rush_yds',
  receiving_yds: 'player_reception_yds', receiving_rec: 'player_receptions'
});

/**
 * The whole cross-sport payload -> normalised NFL rows. Pure. `resolve`
 * turns Underdog's team titles ("New England Patriots @ Seattle Seahawks")
 * into our team codes via the game's `full_team_names_title`.
 */
export function parseUnderdog(payload, capturedAt, resolve = teamResolver()) {
  const out = [];
  let unsupported = 0;
  const appearances = new Map((payload.appearances ?? []).map(a => [a.id, a]));
  const players = new Map((payload.players ?? []).map(p => [p.id, p]));
  const games = new Map((payload.games ?? []).filter(g => g.sport_id === 'NFL').map(g => [g.id, g]));

  for (const line of payload.over_under_lines ?? []) {
    if (line.over_under?.category !== 'player_prop') continue;
    const stat = line.over_under?.appearance_stat?.stat;
    const ourMarket = UNDERDOG_STAT_MAP[stat];
    if (!ourMarket) { unsupported++; continue; }
    const appearance = appearances.get(line.over_under.appearance_stat.appearance_id);
    const game = appearance ? games.get(appearance.match_id) : null;
    if (!game) continue;
    const [awayTitle, homeTitle] = (game.full_team_names_title ?? '').split(' @ ');
    const home = resolve(homeTitle), away = resolve(awayTitle);
    if (!home || !away) continue;
    const p = players.get(appearance.player_id);
    // Underdog's player objects carry first_name/last_name, never a combined
    // full_name field — using one that does not exist silently produced the
    // market's own title string ("Mark Andrews Receiving Yards O/U") as the
    // "player name" for effectively every row, which is why nfl_prop_clv's
    // identity match rate looked catastrophic before this fix.
    const player = p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : null;
    const lineValue = Number(line.stat_value);
    for (const opt of line.options ?? []) {
      const price = Number(opt.american_price);
      if (!Number.isFinite(price) || (opt.choice !== 'higher' && opt.choice !== 'lower')) continue;
      if (!player) continue;
      out.push({
        event_id: eventKey(game.scheduled_at, away.abbr, home.abbr),
        commence_time: game.scheduled_at, home_team: home.name, away_team: away.name,
        book: 'underdog', market: ourMarket, player,
        side: opt.choice === 'higher' ? 'Over' : 'Under', line: lineValue, american_price: price,
        provider: 'underdog', book_updated_at: null, is_opener: 0, captured_at: capturedAt
      });
    }
  }
  return { rows: out, unsupported };
}

export async function captureUnderdogProps() {
  if (!ENABLED) return { skipped: true, reason: 'FREE_PROP_FEEDS=0' };
  const capturedAt = new Date().toISOString();
  const payload = await getJson('https://api.underdogfantasy.com/beta/v5/over_under_lines?sport_id=NFL');
  const { rows: parsed, unsupported } = parseUnderdog(payload, capturedAt);
  const stored = persistPropQuotes(parsed);
  return { provider: 'underdog', stored, unsupported, captured_at: capturedAt };
}

/* ------------------------------------------------------------- shared */

function persistPropQuotes(quotes) {
  const insert = db.prepare(`INSERT OR IGNORE INTO nfl_prop_quote_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,player,side,line,line_key,american_price,provider,book_updated_at,is_opener)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let stored = 0;
  for (const q of quotes) stored += insert.run(q.captured_at, q.event_id, q.commence_time, q.home_team, q.away_team,
    q.book, q.market, q.player, q.side, q.line, q.line == null ? 'null' : String(q.line), q.american_price,
    q.provider, q.book_updated_at, q.is_opener ? 1 : 0).changes;
  return stored;
}

export async function capturePropFeeds({ week = null } = {}) {
  if (!ENABLED) return { skipped: true, reason: 'FREE_PROP_FEEDS=0' };
  const [an, ud] = await Promise.all([
    captureActionNetworkProps({ week }).catch(error => ({ provider: 'actionnetwork', error: error.message })),
    captureUnderdogProps().catch(error => ({ provider: 'underdog', error: error.message }))
  ]);
  return { actionnetwork: an, underdog: ud };
}

export function propFeedStatus() {
  const byProvider = rows(`SELECT provider, COUNT(*) n, COUNT(DISTINCT event_id) games, COUNT(DISTINCT book) books,
      MAX(captured_at) latest FROM nfl_prop_quote_snapshots WHERE provider IS NOT NULL GROUP BY provider`);
  const byMarket = rows(`SELECT market, COUNT(*) n, COUNT(DISTINCT player) players FROM nfl_prop_quote_snapshots
      WHERE provider IS NOT NULL GROUP BY market`);
  return { by_provider: byProvider, by_market: byMarket };
}

export const __test = { parseActionNetworkProps, parseUnderdog, eventKey };
