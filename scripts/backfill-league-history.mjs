#!/usr/bin/env node
/**
 * Historical league backfill: drafts, weekly scores, final standings.
 *
 * This is step 1 of the what-wins study (docs/WHAT-WINS-STUDY.md). It supplies
 * the two things simulation cannot: the ground truth the replay has to
 * reproduce, and the calibration for what Nick's actual leaguemates do.
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
 * Read-only against ESPN with Nick's own cookies. Never prints them.
 * Usage: node --env-file-if-exists=.env scripts/backfill-league-history.mjs [--league N] [--seasons 2023,2024]
 */
process.env.SCHEDULER_DISABLED = '1';
const { db, rows, run } = await import('../server/db/index.js');
const { BROWSER_HEADERS } = await import('../server/services/espn-draft.js');

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const ONLY_LEAGUE = argOf('--league');
const SEASONS = (argOf('--seasons') ?? '2023,2024,2025,2026').split(',').map(Number);
const PACE_MS = 900;

// league_draft_picks is owned by scripts/collect-league-transactions.mjs's sibling
// collector, which already holds 1,738 picks across 12 league-seasons and keeps
// ESPN's raw autoDraftTypeId. Not recreated here.
db.exec(`CREATE TABLE IF NOT EXISTS league_week_scores (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, week INTEGER NOT NULL,
  roster_id TEXT NOT NULL, points REAL, opponent_roster_id TEXT, is_playoff INTEGER,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, week, roster_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS league_season_teams (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, roster_id TEXT NOT NULL,
  team_name TEXT, owner_name TEXT, espn_member_id TEXT,
  wins INTEGER, losses INTEGER, ties INTEGER, points_for REAL, points_against REAL,
  final_rank INTEGER, playoff_seed INTEGER, captured_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, roster_id))`);

const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function urlFor(lg, season, views) {
  const q = views.map(v => `view=${v}`).join('&');
  // See note 1 in the header: prior seasons are a different endpoint entirely.
  return season === lg.season
    ? `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${lg.league_id}?${q}`
    : `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${lg.league_id}?seasonId=${season}&${q}`;
}

async function fetchView(lg, season, views) {
  const r = await fetch(urlFor(lg, season, views), {
    headers: { ...BROWSER_HEADERS, Cookie: `espn_s2=${lg.espn_s2}; SWID=${lg.swid}` },
    signal: AbortSignal.timeout(25_000),
  });
  if (r.status === 404) return null;               // league did not exist that season
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j;              // leagueHistory answers with an array
}

function saveScores(lg, season, payload) {
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

function saveTeams(lg, season, payload) {
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

const leagues = rows(`SELECT id,name,league_id,season,espn_s2,swid FROM leagues
                      WHERE platform='espn' AND espn_s2 IS NOT NULL
                      ${ONLY_LEAGUE ? 'AND id = ' + Number(ONLY_LEAGUE) : ''} ORDER BY id`);
let totals = { scores: 0, teams: 0, seasons: 0, missing: 0 };
for (const lg of leagues) {
  for (const season of SEASONS) {
    try {
      const payload = await fetchView(lg, season,
        ['mTeam', 'mMatchupScore', 'mSettings']);
      await sleep(PACE_MS);
      if (!payload) { console.log(`  ${lg.id}/${season}: league did not exist`); totals.missing++; continue; }
      const p = rows('SELECT COUNT(*) n FROM league_draft_picks WHERE league_id=? AND season=?', lg.id, season)[0].n;
      const s = saveScores(lg, season, payload);
      const t = saveTeams(lg, season, payload);
      totals.scores += s; totals.teams += t; totals.seasons++;
      console.log(`  ${lg.id}/${season} ${String(lg.name).trim().slice(0, 20).padEnd(21)} picks(existing) ${String(p).padStart(3)}  team-weeks ${String(s).padStart(4)}  teams ${t}`);
    } catch (e) {
      console.log(`  ${lg.id}/${season}: ERROR ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
}
console.log(`\nbackfill: ${totals.seasons} league-seasons | ${totals.scores} team-weeks | ${totals.teams} team rows | ${totals.missing} not-existing`);
process.exit(0);
