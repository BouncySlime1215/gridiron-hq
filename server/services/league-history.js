/**
 * Historical league facts — final standings and weekly scores, per league-season.
 *
 * `league_season_teams` is what the manager layer is built on: it is the only
 * place that says which ESPN member owned which roster id in which season, so
 * manager-archetypes.js reads it to attribute draft picks
 * (manager-archetypes.js:243), to name a member (:819) and to key a league's
 * managers by roster id for the trade finder (:831). `league_week_scores` is
 * the all-play/luck input beside it (scripts/luck-panel.mjs).
 *
 * Until now both tables had exactly one writer — scripts/backfill-league-history.mjs,
 * run by hand — so on any box where nobody had run it the trades surface read an
 * empty table and every manager came back without an owner, which looks the same
 * as a league with nothing measured about it. That is the failure this file
 * exists to end: the logic lives here, the script is a thin CLI over it, and
 * scheduler.js's `league_history` job runs the same code on a timer.
 *
 * ESPN facts established by probing, 2026-09-17 — all four were wrong in the
 * first attempt and each one cost a run:
 *
 *   1. The CURRENT season lives at /seasons/{year}/segments/0/leagues/{id};
 *      PRIOR seasons live at /leagueHistory/{id}?seasonId={year}. Asking the
 *      seasons endpoint for an old year returns 404, which reads like "no
 *      history" when it means "wrong URL".
 *   2. `view=mDraftDetail` is a separate request. The league sync never asked
 *      for it, which is why payload.draftDetail.picks has been empty all along
 *      and why nothing could measure who auto-drafts.
 *   3. `X-Fantasy-Filter` rejects a limit without a sort IN THE SAME object,
 *      and even correctly formed it does not widen the ~3-day transaction
 *      window. Historical transactions are not retrievable; forward capture
 *      (scripts/collect-league-transactions.mjs) is the only path. Recorded
 *      here so nobody burns another hour on it.
 *   4. A league that did not exist in a season 404s. Leagues 3, 4 and 5 are
 *      newer, so coverage is uneven by design, not by failure.
 *
 * Read-only against ESPN with Nick's own cookies. Never logs them.
 */
import { db, rows } from '../db/index.js';
import { BROWSER_HEADERS } from './espn-draft.js';

/**
 * How far back a scheduled run reaches. The what-wins study wants four
 * seasons; a league that did not exist that far back simply 404s (note 4).
 */
export const HISTORY_SEASON_WINDOW = 4;

/**
 * ESPN is being asked with the same espn_s2/SWID Nick's own browser holds, so
 * these requests are paced rather than fired in a burst. 900 ms is what the
 * original backfill used across twenty league-seasons without ever being
 * throttled.
 */
export const PACE_MS = 900;

const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Every ESPN league whose stored cookies make a historical read possible. */
export function historyLeagues(leagueIds = null) {
  const ids = Array.isArray(leagueIds) ? leagueIds.map(Number).filter(Number.isFinite) : null;
  return rows(`SELECT id,name,league_id,season,espn_s2,swid FROM leagues
               WHERE platform='espn' AND espn_s2 IS NOT NULL
               ${ids?.length ? `AND id IN (${ids.join(',')})` : ''} ORDER BY id`);
}

/**
 * Which seasons this run should actually ask ESPN for.
 *
 * The current season is always re-read: standings and weekly scores move every
 * week, and it is the season the trades surface is looking at. A PRIOR season
 * is final the moment it ends, so it is fetched only while nothing is stored
 * for it — which is what turns a four-season backfill into one request per
 * league on a box that has already filled in.
 *
 * A season the league did not exist in is re-attempted on each run, because a
 * 404 is not recorded anywhere. That is at most a handful of requests a day
 * against a league that is already being read for its current season, and the
 * alternative — a table of known-absent league-seasons — is more machinery
 * than the cost it saves.
 */
export function seasonsToFetch(lg, { seasons = null, force = false } = {}) {
  const window = Array.isArray(seasons) && seasons.length
    ? seasons.map(Number).filter(Number.isFinite)
    : Array.from({ length: HISTORY_SEASON_WINDOW }, (_, i) => lg.season - (HISTORY_SEASON_WINDOW - 1) + i);
  if (force) return window;
  return window.filter(season => season === lg.season || !stored(lg.id, season));
}

function stored(leagueId, season) {
  return !!rows(`SELECT 1 FROM league_season_teams WHERE league_id=? AND season=? LIMIT 1`,
    leagueId, season).length;
}

function urlFor(lg, season, views) {
  const q = views.map(v => `view=${v}`).join('&');
  // See note 1 in the header: prior seasons are a different endpoint entirely.
  return season === lg.season
    ? `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${lg.league_id}?${q}`
    : `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${lg.league_id}?seasonId=${season}&${q}`;
}

export async function fetchView(lg, season, views) {
  const r = await fetch(urlFor(lg, season, views), {
    headers: { ...BROWSER_HEADERS, Cookie: `espn_s2=${lg.espn_s2}; SWID=${lg.swid}` },
    signal: AbortSignal.timeout(25_000),
  });
  if (r.status === 404) return null;               // league did not exist that season
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j;              // leagueHistory answers with an array
}

export function saveScores(lg, season, payload) {
  const sched = payload?.schedule ?? [];
  if (!sched.length) return 0;
  const playoffStart = payload?.settings?.scheduleSettings?.matchupPeriodCount ?? 14;
  const stmt = db.prepare(`INSERT INTO league_week_scores
    (league_id,season,week,roster_id,points,opponent_roster_id,is_playoff,captured_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(league_id,season,week,roster_id) DO UPDATE SET
      points=excluded.points, opponent_roster_id=excluded.opponent_roster_id,
      is_playoff=excluded.is_playoff, captured_at=excluded.captured_at`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const m of sched) {
      const wk = m.matchupPeriodId;
      // A bye or an unplayed week has no totalPoints; skip rather than store a
      // zero, which would be indistinguishable from a real shutout in all-play.
      for (const [side, other] of [['home', 'away'], ['away', 'home']]) {
        const s = m[side], o = m[other];
        if (!s?.teamId || s.totalPoints == null) continue;
        stmt.run(lg.id, season, wk, String(s.teamId), s.totalPoints,
          o?.teamId != null ? String(o.teamId) : null, wk > playoffStart ? 1 : 0, now());
        n++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

export function saveTeams(lg, season, payload) {
  const teams = payload?.teams ?? [];
  if (!teams.length) return 0;
  const memberName = new Map((payload.members ?? []).map(m =>
    [m.id, `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.displayName]));
  const stmt = db.prepare(`INSERT INTO league_season_teams
    (league_id,season,roster_id,team_name,owner_name,espn_member_id,wins,losses,ties,
     points_for,points_against,final_rank,playoff_seed,captured_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(league_id,season,roster_id) DO UPDATE SET
      team_name=excluded.team_name, owner_name=excluded.owner_name,
      wins=excluded.wins, losses=excluded.losses, ties=excluded.ties,
      points_for=excluded.points_for, points_against=excluded.points_against,
      final_rank=excluded.final_rank, playoff_seed=excluded.playoff_seed,
      captured_at=excluded.captured_at`);
  db.exec('BEGIN');
  try {
    for (const t of teams) {
      const owner = (t.owners ?? [])[0];
      const rec = t.record?.overall ?? {};
      stmt.run(lg.id, season, String(t.id), t.name ?? t.abbrev ?? null,
        owner ? memberName.get(owner) ?? null : null, owner ?? null,
        rec.wins ?? null, rec.losses ?? null, rec.ties ?? null,
        rec.pointsFor ?? null, rec.pointsAgainst ?? null,
        t.rankCalculatedFinal ?? t.playoffSeed ?? null, t.playoffSeed ?? null, now());
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return teams.length;
}

/**
 * Whether an ESPN draft is happening right now, in which case this must not
 * touch ESPN at all.
 *
 * Imported lazily: scheduler.js is what calls this file, and a static import
 * back the other way would be a cycle. The gate itself is not optional
 * politeness — the 2026-09-06/07 incident was a scheduled sweep using the same
 * espn_s2/SWID Nick's browser was drafting with, and this job reads the same
 * cookies from the same rows. See scheduler.js's liveDraftActive().
 *
 * A failure of the import or of liveDraftActive() itself is NOT "no draft" —
 * scheduler.js's own liveDraftActive() already fails open, but only for the
 * one case it names and justifies (a test harness with no `drafts` table).
 * Anything else here (a real bug, a broken module) means the draft status is
 * unknown, and unknown must read the same as "yes" to this gate: the whole
 * reason it exists is to not guess wrong about Nick's own live cookies.
 */
async function liveDraft() {
  try {
    const { liveDraftActive } = await import('./scheduler.js');
    return { active: !!liveDraftActive(), reason: null };
  } catch (e) {
    return { active: true, reason: `draft status unknown: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/**
 * Refresh standings and weekly scores for every eligible league-season.
 *
 * One league-season's failure never stops the rest: it is caught, counted and
 * reported, the same way the manual backfill printed it.
 */
export async function backfillLeagueHistory({
  leagueIds = null, seasons = null, force = false, paceMs = PACE_MS,
  checkLiveDraft = true, log = null,
} = {}) {
  const draft = checkLiveDraft ? await liveDraft() : { active: false, reason: null };
  if (draft.active) {
    return { skipped: draft.reason ?? 'a league draft is in progress — ESPN is not touched with these cookies during one' };
  }
  const leagues = historyLeagues(leagueIds);
  // `attempted` is what statusFromDetail() in scheduler.js measures `failed`
  // against, and it has to be the whole batch: reporting only the successes as
  // the total makes one failure out of two read as every league-season having
  // failed, which is the difference between 'partial' and 'error'.
  const out = {
    attempted: 0, ok: 0, failed: 0, not_existing: 0, team_weeks: 0, teams: 0, league_seasons: [],
  };
  let first = true;
  for (const lg of leagues) {
    for (const season of seasonsToFetch(lg, { seasons, force })) {
      out.attempted++;
      try {
        // Paced BETWEEN requests, not after each one: a run with a single
        // league-season otherwise sits idle for the pace before returning, and
        // this job holds the event loop's attention for as long as it runs.
        if (!first) await sleep(paceMs);
        first = false;
        const payload = await fetchView(lg, season, ['mTeam', 'mMatchupScore', 'mSettings']);
        if (!payload) {
          out.not_existing++;
          out.league_seasons.push({ league_id: lg.id, season, missing: true });
          log?.(`  ${lg.id}/${season}: league did not exist`);
          continue;
        }
        // A 200 that did not carry mTeam is a failed read, not an empty
        // league-season. fetchView() only returns null on a 404 (counted apart
        // as not_existing) and only throws on !r.ok, so this shape arrives
        // looking exactly like a successful fetch -- and note 2 in this file's
        // header records that a 200 missing a requested view is real behaviour
        // of this API. Counted as a failure rather than as ok-with-zero-rows
        // because statusFromDetail() reads `failed` against `attempted`: left
        // as ok, a run that wrote nothing reports itself healthy and
        // league_season_teams stays empty, which is the state this file exists
        // to end. An empty `schedule` is NOT this case -- a season that has not
        // played yet is real, and its team rows still land below.
        if (!(payload.teams ?? []).length) {
          const error = 'ESPN 200 without the mTeam view — no teams array in the payload';
          out.failed++;
          out.league_seasons.push({ league_id: lg.id, season, error });
          log?.(`  ${lg.id}/${season}: ERROR ${error}`);
          continue;
        }
        const teamWeeks = saveScores(lg, season, payload);
        const teams = saveTeams(lg, season, payload);
        out.ok++; out.team_weeks += teamWeeks; out.teams += teams;
        out.league_seasons.push({ league_id: lg.id, season, team_weeks: teamWeeks, teams });
        log?.(`  ${lg.id}/${season} ${String(lg.name).trim().slice(0, 20).padEnd(21)}`
          + `  team-weeks ${String(teamWeeks).padStart(4)}  teams ${teams}`);
      } catch (e) {
        // The message can only ever be our own `ESPN <status>` or a fetch/SQLite
        // error; the cookies are in the headers, never in the thrown text.
        const error = String(e?.message ?? e).slice(0, 120);
        out.failed++;
        out.league_seasons.push({ league_id: lg.id, season, error });
        log?.(`  ${lg.id}/${season}: ERROR ${error}`);
      }
    }
  }
  return out;
}
