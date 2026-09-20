/**
 * ESPN's own market view of the player pool, per league.
 *
 * The people in an ESPN draft room see ESPN's rank, ESPN's ADP and ESPN's
 * injury tag next to every name, and most of them draft off it. So for an
 * ESPN league this is the single most relevant "market" signal there is —
 * more than FFC or Sleeper, which are what the board used until 2026-09-06.
 * Fetched from the league's own URL so `appliedTotal` is in the league's
 * scoring. Proven fields (300/300 coverage for 2026): ownership.averageDraftPosition,
 * draftRanksByRankType.PPR.rank, injuryStatus, stats[102026] season projection,
 * stats[1120261] week-1 projection, lastNewsDate.
 */
import { db, row, rows, run } from '../db/index.js';
import { BROWSER_HEADERS } from './espn-draft.js';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

// Where the last sync records which league it read. A single key, because the
// table it describes holds a single league's market.
const MARKET_SOURCE_KEY = 'espn_player_market_source';

/**
 * Thrown when the league this sync was asked for has no stored ESPN cookie
 * pair. Defined here rather than imported: the shared credential resolver
 * (platform/espn-credentials.js) is not on main yet, and this refusal must not
 * wait for it.
 *
 * THE NAME IS DELIBERATELY NOT THEIRS. `platform/espn-credentials.js` on #48
 * exports a class called `EspnCredentialsMissing` too, and the two are not
 * interchangeable: theirs takes a message and carries
 * `code: 'espn_not_connected'`, this one takes a league row id and carries
 * `leagueRowId`. `instanceof` is false between them in both directions. One
 * exported name over two incompatible classes is a catch block that matches
 * the wrong throw and turns a 409 the caller could act on into a 500 it
 * cannot, without a word in any log. Nothing imports both today, so nothing
 * is broken yet; a name that is already wrong and not yet harmful is the
 * cheapest moment to fix it.
 *
 * WHAT THE SWAP ACTUALLY COSTS. An earlier draft of this comment said the
 * throw site becomes "a one-line swap to credentialsForLeague". That is true
 * of the line and false of the change. `credentialsForLeague` falls back
 * through `league_memberships` to a connected member, so a bare `leagues` row
 * stops being a refusal case at all — it is a refusal only when no member is
 * connected either. Four of this module's eight tests are written against a
 * bare or half row and change meaning on that day, and a fifth case appears
 * that cannot be written today because the join does not exist on main: a
 * bare row with a connected member, syncing on that member's pair. See
 * docs/tdd/espn-market-refuses-anonymous.tdd.md.
 */
export class EspnMarketCredentialsMissing extends Error {
  constructor(leagueRowId, leagueId) {
    super(`league ${leagueRowId} (ESPN ${leagueId}) has no stored ESPN cookies, so its market cannot be read`);
    this.name = 'EspnMarketCredentialsMissing';
    this.status = 409;
    this.leagueRowId = leagueRowId;
  }
}

export async function syncEspnMarket(leagueRowId, { limit = 400 } = {}) {
  const lg = row('SELECT league_id, season, espn_s2, swid FROM leagues WHERE id = ?', leagueRowId);
  if (!lg) throw new Error(`league row ${leagueRowId} not found`);
  const season = lg.season;
  const filter = {
    players: {
      limit,
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 23] },
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'PPR' },
      filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`00${season}`, `10${season}`, `11${season}1`] }
    }
  };
  const headers = { ...BROWSER_HEADERS, 'x-fantasy-filter': JSON.stringify(filter) };
  // Refuse rather than fetch anonymously. Without the cookie pair ESPN still
  // answers — with a thin PUBLIC payload — and this function would write that
  // down as the league's own market, under a fetched_at stamp that makes it
  // look collected minutes ago. The docstring above promises `appliedTotal` in
  // the LEAGUE's scoring; an unauthenticated read cannot deliver that, and the
  // board has no way to tell the two apart afterwards. Silent public data
  // wearing a league's label is worse than a named refusal: a caller that
  // cannot read a league says so and the board shows "never collected".
  if (!lg.espn_s2 || !lg.swid) throw new EspnMarketCredentialsMissing(leagueRowId, lg.league_id);
  headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
  const url = `${BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}?view=kona_player_info`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`ESPN kona_player_info ${resp.status}`);
  const data = await resp.json();
  const now = new Date().toISOString();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const e of data.players ?? []) {
      const p = e.player ?? e;
      if (p?.id == null) continue;
      const seasonStat = (p.stats ?? []).find(s => s.statSourceId === 1 && s.scoringPeriodId === 0 && s.seasonId === season);
      const week1 = (p.stats ?? []).find(s => s.statSourceId === 1 && s.scoringPeriodId === 1 && s.seasonId === season);
      run(`INSERT INTO espn_player_market (espn_id, season, adp, adp_change, ppr_rank, std_rank, percent_owned, percent_started,
             injury_status, season_proj, week1_proj, news_at, outlook, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(espn_id) DO UPDATE SET season=excluded.season, adp=excluded.adp, adp_change=excluded.adp_change,
             ppr_rank=excluded.ppr_rank, std_rank=excluded.std_rank, percent_owned=excluded.percent_owned,
             percent_started=excluded.percent_started, injury_status=excluded.injury_status, season_proj=excluded.season_proj,
             week1_proj=excluded.week1_proj, news_at=excluded.news_at, outlook=excluded.outlook, fetched_at=excluded.fetched_at`,
        p.id, season,
        p.ownership?.averageDraftPosition ?? null, p.ownership?.averageDraftPositionPercentChange ?? null,
        p.draftRanksByRankType?.PPR?.rank ?? null, p.draftRanksByRankType?.STANDARD?.rank ?? null,
        p.ownership?.percentOwned ?? null, p.ownership?.percentStarted ?? null,
        p.injuryStatus ?? null, seasonStat?.appliedTotal ?? null, week1?.appliedTotal ?? null,
        p.lastNewsDate ? new Date(p.lastNewsDate).toISOString() : null,
        p.seasonOutlook ? String(p.seasonOutlook).slice(0, 1200) : null, now);
      n++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // WHOSE market these rows are. The table's primary key is `espn_id` alone
  // (db/schema/core-and-fantasy.js:596), so it holds exactly one league's
  // market at a time and a second league's sync overwrites the first — while
  // this module's docstring promises a per-league read in the league's own
  // scoring. Keying the table per league is a migration on a shared schema and
  // a decision about whether the board wants one market or several, so it is
  // not taken here. Until it is, the rows at least say which sync produced
  // them, so a reader cannot take league A's numbers for league B's.
  run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    MARKET_SOURCE_KEY, JSON.stringify({
      league_row_id: leagueRowId, espn_league_id: lg.league_id, season, fetched_at: now, rows: n
    }));
  return { synced: n, fetched_at: now };
}

/** ESPN market rows keyed by OUR player id, for the board. */
export function espnMarketByPlayerId() {
  const out = new Map();
  for (const r of rows(`SELECT p.id AS player_id, m.* FROM espn_player_market m JOIN players p ON p.espn_id = m.espn_id`)) {
    out.set(r.player_id, r);
  }
  return out;
}

/**
 * How old this table's contents are, read from the table's OWN stamps.
 *
 * Deliberately not from `sync_log` or a scheduler record: a job that ran and
 * wrote nothing, or wrote and was rolled back, leaves a log entry and no rows.
 * The only honest answer to "how fresh is this market" is the newest
 * `fetched_at` actually sitting in it.
 *
 * `collected` is false when the table is empty, which is the state the board
 * shows as "never collected" — as opposed to "collected and stale", which is a
 * different sentence and a different decision.
 */
export function espnMarketFreshness() {
  const r = row(`SELECT COUNT(*) AS n, MAX(fetched_at) AS fetched_at FROM espn_player_market`);
  const collected = (r?.n ?? 0) > 0;
  let source = null;
  try {
    const raw = row(`SELECT value FROM app_settings WHERE key = ?`, MARKET_SOURCE_KEY)?.value;
    source = raw ? JSON.parse(raw) : null;
  } catch { source = null; }   // a malformed record is an unknown source, not an outage

  // Three states, not two. "Never collected" and "collected, stale" lead to
  // different decisions, and a third — collected by a sync that predates this
  // record — must not be allowed to read as either of the first two.
  const label = !collected
    ? 'ESPN market: never collected'
    : source?.espn_league_id
      ? `ESPN market: as collected for league ${source.espn_league_id}, ${r.fetched_at}`
      : `ESPN market: as of ${r.fetched_at} — which league's sync wrote these rows is not recorded`;

  return { ...r, collected, as_of: r?.fetched_at ?? null, source, label };
}
