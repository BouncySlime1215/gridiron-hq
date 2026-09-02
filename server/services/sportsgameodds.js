/**
 * SportsGameOdds — an optional second, free multi-book quote provider.
 *
 * The Odds API's free tier is 500 credits a month and this project spends its
 * entire month on Week 1 alone. SportsGameOdds' free "Amateur" tier is a
 * different shape of limit — 10 requests a minute, 2,500 objects a month, no
 * credit card — and covers 9 US books including DraftKings, FanDuel and
 * BetMGM. It does not replace the Odds API's regional Pinnacle read
 * (`nfl-sharp.js`), but it is a second, independent source for exactly the
 * spreads/totals capture this app is starved of.
 *
 * This module is entirely opt-in: every export is a no-op without
 * `SPORTSGAMEODDS_API_KEY` set, so a user who has not created an account is
 * unaffected. Once a key exists, `captureSportsGameOddsSnapshot()` writes into
 * the SAME `nfl_line_snapshots` table `line-shopping.js` owns, in the same
 * shape (book, market, side, line, price), so every existing consumer —
 * `nfl-shopping-board.js`, `nfl-sharp.js`, `nfl-execution.js`, the movement
 * feature in `nfl-specialists.js` — reads it unchanged.
 *
 * The exact event/odds JSON shape here was assembled from SportsGameOdds'
 * published documentation (oddID = `{statID}-{statEntityID}-{periodID}-
 * {betTypeID}-{sideID}`, per-book prices under `byBookmaker`), not from a
 * live key — nobody has one yet. Every parsing step fails closed: a game
 * whose shape does not match expectations is counted `unmatched` and skipped,
 * never guessed into a row. Run `sportsGameOddsSnapshotStatus()` after the
 * first real key is added to confirm the shape still holds.
 */
import { teamResolver as sharedTeamResolver, normalizeToken as normalizeTeam } from './team-codes.js';
import { db, run, rows } from '../db/index.js';

const BASE = 'https://api.sportsgameodds.com/v2';
const RATE_LIMIT_MS = 6500; // 10 req/min ceiling on the free tier; stay comfortably under it.

db.exec(`
  CREATE TABLE IF NOT EXISTS sgo_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    objects_used_this_month INTEGER NOT NULL DEFAULT 0,
    month TEXT NOT NULL, last_call_at TEXT
  );
`);

export const hasKey = () => Boolean(process.env.SPORTSGAMEODDS_API_KEY);

let _lastCallAt = 0;
async function throttledFetch(url) {
  const wait = RATE_LIMIT_MS - (Date.now() - _lastCallAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  _lastCallAt = Date.now();
  return fetch(url, { headers: { 'X-Api-Key': process.env.SPORTSGAMEODDS_API_KEY },
    signal: AbortSignal.timeout(20000) });
}

function recordUsage(objectCount) {
  const month = new Date().toISOString().slice(0, 7);
  run(`INSERT INTO sgo_usage (id, objects_used_this_month, month, last_call_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         objects_used_this_month = CASE WHEN sgo_usage.month = excluded.month
           THEN sgo_usage.objects_used_this_month + excluded.objects_used_this_month
           ELSE excluded.objects_used_this_month END,
         month = excluded.month, last_call_at = excluded.last_call_at`,
  objectCount, month, new Date().toISOString());
}

export function sgoUsage() {
  const row = rows('SELECT * FROM sgo_usage WHERE id = 1')[0] ?? null;
  const month = new Date().toISOString().slice(0, 7);
  return { has_key: hasKey(),
    objects_used_this_month: row && row.month === month ? row.objects_used_this_month : 0,
    monthly_object_budget: 2500, last_call_at: row?.last_call_at ?? null };
}

/** Every NFL event with odds currently posted. Free tier: paginate with `cursor` if `nextCursor` is returned. */
async function fetchNflEvents() {
  const url = `${BASE}/events?leagueID=NFL&oddsAvailable=true&limit=50`;
  const res = await throttledFetch(url);
  if (!res.ok) return { error: `SportsGameOdds events -> HTTP ${res.status}` };
  const payload = await res.json();
  const events = payload?.data ?? payload?.events ?? [];
  recordUsage(Array.isArray(events) ? events.length : 0);
  return { events: Array.isArray(events) ? events : [] };
}

/** Resolve SportsGameOdds' team naming to this app's canonical abbreviation (team-codes.js). */
function teamResolver() {
  const resolve = sharedTeamResolver();
  return candidate => resolve(candidate)?.abbr ?? null;
}

/** Best-effort team-name extraction across the couple of shapes SGO's docs show. */
function teamCandidates(side) {
  return [side?.names?.long, side?.names?.short, side?.name, side?.teamID, side]
    .filter(value => typeof value === 'string');
}

/**
 * Pull spread and total quotes out of one event's `odds` map. The oddID
 * convention is documented as `{statID}-{statEntityID}-{periodID}-{betTypeID}-
 * {sideID}`; full-game spread/total legs are `points-{home|away}-game-sp-
 * {home|away}` and `points-all-game-ou-{over|under}`.
 */
function extractQuotes(event, resolveTeam) {
  const homeCandidates = teamCandidates(event.teams?.home ?? event.homeTeam);
  const awayCandidates = teamCandidates(event.teams?.away ?? event.awayTeam);
  const home = homeCandidates.map(resolveTeam).find(Boolean);
  const away = awayCandidates.map(resolveTeam).find(Boolean);
  if (!home || !away) return { error: 'could not resolve home/away team names' };

  const odds = event.odds ?? {};
  const quotes = [];
  for (const [oddId, entry] of Object.entries(odds)) {
    const parts = String(oddId).split('-');
    if (parts.length < 5) continue;
    const [statId, entityId, periodId, betTypeId, sideId] = parts;
    if (statId !== 'points' || periodId !== 'game') continue;
    const byBook = entry?.byBookmaker ?? {};
    for (const [book, quote] of Object.entries(byBook)) {
      if (quote?.available === false) continue;
      if (betTypeId === 'sp' && (entityId === 'home' || entityId === 'away')) {
        // Each side's own leg already carries its own signed number (the home
        // leg negative for a favorite, the away leg positive) — the same
        // per-side convention the Odds API path stores, so no sign flip here.
        const line = Number(quote.spread ?? entry.bookSpread);
        const price = Number(quote.odds);
        if (!Number.isFinite(line) || !Number.isFinite(price)) continue;
        quotes.push({ book, market: 'spreads', side: entityId === 'home' ? home : away, line, price });
      } else if (betTypeId === 'ou' && entityId === 'all' && (sideId === 'over' || sideId === 'under')) {
        const line = Number(quote.overUnder ?? entry.bookOverUnder);
        const price = Number(quote.odds);
        if (!Number.isFinite(line) || !Number.isFinite(price)) continue;
        quotes.push({ book, market: 'totals', side: sideId === 'over' ? 'Over' : 'Under', line, price });
      } else if (betTypeId === 'ml' && (entityId === 'home' || entityId === 'away')) {
        const price = Number(quote.odds);
        if (!Number.isFinite(price)) continue;
        quotes.push({ book, market: 'h2h', side: entityId === 'home' ? home : away, line: null, price });
      }
    }
  }
  return { home, away, commenceTime: event.status?.startsAt ?? event.commence_time ?? event.startTime ?? null,
    eventId: event.eventID ?? event.id, quotes };
}

/**
 * Capture the current NFL slate into `nfl_line_snapshots`, the exact table
 * and row shape `line-shopping.js#snapshotLines` writes, so every consumer of
 * multi-book NFL quotes works whichever provider actually has a key.
 */
export async function captureSportsGameOddsSnapshot() {
  if (!hasKey()) return { error: 'no SPORTSGAMEODDS_API_KEY configured' };
  const { events, error } = await fetchNflEvents();
  if (error) return { error };
  const resolveTeam = teamResolver();
  const at = new Date().toISOString();
  let matched = 0, unmatched = 0, rowsWritten = 0;
  const sampleErrors = [];
  for (const event of events) {
    const parsed = extractQuotes(event, resolveTeam);
    if (parsed.error) { unmatched++; if (sampleErrors.length < 3) sampleErrors.push(parsed.error); continue; }
    matched++;
    const homeFull = rows('SELECT name FROM nfl_teams WHERE abbr=?', parsed.home)[0]?.name ?? parsed.home;
    const awayFull = rows('SELECT name FROM nfl_teams WHERE abbr=?', parsed.away)[0]?.name ?? parsed.away;
    for (const q of parsed.quotes) {
      run(`INSERT INTO nfl_line_snapshots
          (captured_at, event_id, commence_time, home_team, away_team, book, market, side, line, price)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT DO NOTHING`,
        at, `sgo:${parsed.eventId}`, parsed.commenceTime, homeFull, awayFull,
        q.book, q.market, q.side === parsed.home ? homeFull : q.side === parsed.away ? awayFull : q.side,
        q.line, q.price);
      rowsWritten++;
    }
  }
  const { clearShoppingBoardCache } = await import('./nfl-shopping-board.js');
  clearShoppingBoardCache();
  return { captured_at: at, provider: 'sportsgameodds', events_seen: events.length,
    events_matched: matched, events_unmatched: unmatched, quotes: rowsWritten,
    unmatched_reasons: sampleErrors.length ? sampleErrors : undefined,
    usage: sgoUsage() };
}

export function sportsGameOddsSnapshotStatus() {
  const captured = rows(`SELECT COUNT(*) n, MAX(captured_at) latest FROM nfl_line_snapshots
    WHERE event_id LIKE 'sgo:%'`)[0] ?? {};
  return { has_key: hasKey(), usage: sgoUsage(), snapshots_captured: captured.n ?? 0,
    latest_capture: captured.latest ?? null,
    note: hasKey()
      ? 'Optional second quote provider. Verify events_matched > 0 on the first real capture — the parser was built from documentation, not a live key.'
      : 'Not configured. Create a free account at sportsgameodds.com and set SPORTSGAMEODDS_API_KEY to enable a second, independent multi-book source that does not share the Odds API budget.' };
}

export const __test = { extractQuotes, teamResolver, normalizeTeam };
