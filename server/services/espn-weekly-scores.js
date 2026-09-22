/**
 * The weekly scores ESPN has been storing in `leagues.payload` all along.
 *
 * WHY THIS FILE EXISTS. `routes/leagues.js:125` requests `view=mMatchup` and `:160` stores
 * the entire ESPN response, so `schedule[].home.totalPoints` has been sitting in the
 * database, unparsed, since the first league sync. No table in this database holds per-week
 * fantasy team scores -- checked against `core-and-fantasy.js` and every migration -- and
 * several readers want them: the Team Outlook panel, the luck read, and four thresholds that
 * currently have no per-week scores to compute against. A table would need a writer, a
 * migration and a backfill to hold what is already stored, so this parses instead.
 *
 * It is one file with one exported function and no model imports, deliberately: it takes a
 * league row and returns rows. Nothing that reads weekly scores should have to import a
 * model to get them, and nothing should write a second parser -- that is how two numbers
 * for the same quantity end up on two pages.
 *
 * THE ROW THAT MUST NOT EXIST. ESPN returns the WHOLE season's schedule, including weeks not
 * yet played, and an unplayed matchup comes back with `totalPoints: 0` and
 * `winner: 'UNDECIDED'`. A zero admitted as a real score is the worst available outcome for
 * any consumer that standardises: it drags the league's mean and standard deviation down, so
 * every OTHER week's z-score is wrong too, and the team with the most unplayed weeks looks
 * like the worst team in the league. So a period is admitted only when it is decided AND
 * both sides carry a number AND at least one of them is above zero -- three conditions
 * because each catches a case the others do not: a completed week really can have a 0 on one
 * side, and `winner` is absent from some payloads.
 *
 * `made_playoffs` and `champion` are outcomes, and for a season in progress they have not
 * happened. They are null rather than 0, and every row carries `outcome_known: false`. A 0
 * would have read as "did not qualify" to anything fitting on these rows, silently.
 */


/** ESPN's marker for a period that has not been played. */
const PLAYED_UNDECIDED = 'UNDECIDED';

/**
 * Whether a head-to-head period has actually been played, and why not when it has not.
 *
 * ONE RULE, TWO READERS. `espnWeeklyRows` below is not the only thing in this app that decides
 * whether a period counts: `season-sim.js#initialRecords` reads the same schedule to carry a
 * league's real record into a simulation, and it used a weaker rule -- both sides carry a finite
 * number -- so every unplayed 0-0 period before the simulated window became a TIE and awarded
 * half a win to each team. Measured on a four-team fixture with two weeks played and the window
 * opened at week 14: every team gained 5.5 wins it had not earned, while points-for stayed
 * honest, so the record and the points disagreed and the standings read as a four-way tie.
 *
 * Two readers of one quantity with two rules is how a league ends up with two records, so the
 * rule lives here, once, and both import it.
 *
 * `winner` is optional: some payloads carry no such key, and Sleeper matchups have none at all.
 * A period is played when it is DECIDED and BOTH sides carry a number and AT LEAST ONE is above
 * zero. The three are not redundant -- `decided` is the only one that catches a week IN PROGRESS,
 * whose points are real but partial; `bothScored` is the only one that catches a side with no
 * total, which `anyPoints` would read as a zero; and `anyPoints` catches a future 0-0 in a
 * payload with no `winner` key. It is `||` and not `&&` because a real shutout is a result.
 */
export function periodPlayed({ winner, homePoints, awayPoints }) {
  const decided = winner == null || String(winner).toUpperCase() !== PLAYED_UNDECIDED;
  if (!decided) return { played: false, reason: 'the period is still being played' };
  const hp = Number.isFinite(homePoints) ? homePoints : null;
  const ap = Number.isFinite(awayPoints) ? awayPoints : null;
  if (hp == null || ap == null) return { played: false, reason: 'one side carries no score' };
  if (!(hp > 0 || ap > 0)) return { played: false, reason: 'neither side has scored' };
  return { played: true, reason: null };
}

/**
 * Per-team weekly scores for one league row, or a named reason there are none.
 *
 * Returns `{ rows, ok: true, ... }` or `{ rows: [], ok: false, reason }`, never a partial
 * shape: `reason` is a sentence a surface can print. Each row carries `season`,
 * `league_id`, `num_teams`, `playoff_teams`, `roster_id`, `week`, `points`,
 * `opponent_roster_id`, `made_playoffs`, `champion` and `outcome_known`.
 *
 * `regular_periods` is how long the regular season RUNS, which is not how many weeks have
 * been played. Any consumer deriving weeks-remaining needs it, and it is null rather than
 * a guess when the payload does not carry it -- there is no honest substitute for the
 * length of somebody's season.
 *
 * `payload_season` is preferred over `leagues.season` because they differ: syncEspnLeague
 * falls back to last season when the current one returns empty rosters, and migration
 * 062_league_payload_season exists to record which one the payload actually came from.
 */
export function espnWeeklyRows(lg) {
  let payload = null;
  try { payload = typeof lg?.payload === 'string' ? JSON.parse(lg.payload) : lg?.payload; }
  catch { return { rows: [], ok: false, reason: 'league payload is not readable' }; }
  if (!payload) return { rows: [], ok: false, reason: 'league has never been synced' };

  const schedule = Array.isArray(payload.schedule) ? payload.schedule : null;
  if (!schedule?.length) {
    return { rows: [], ok: false, reason: 'league payload carries no schedule (synced without view=mMatchup)' };
  }
  const settings = payload.settings?.scheduleSettings ?? {};
  const regularPeriods = Number(settings.matchupPeriodCount) || null;
  const teams = Array.isArray(payload.teams) ? payload.teams : [];
  const numTeams = teams.length || null;
  const playoffTeams = Number(settings.playoffTeamCount) || null;
  // `payload_season` is what the payload actually came from, which is not always
  // `leagues.season`: syncEspnLeague falls back to last season when the current one returns
  // empty rosters, and migration 062_league_payload_season exists to record that.
  const season = Number(lg?.payload_season ?? lg?.season) || null;

  const sideOf = side => {
    const teamId = side?.teamId ?? null;
    const points = Number(side?.totalPoints);
    return { teamId, points: Number.isFinite(points) ? points : null };
  };

  const rows = [];
  let skippedUnplayed = 0, skippedPostseason = 0;
  for (const m of schedule) {
    const week = Number(m?.matchupPeriodId);
    if (!Number.isFinite(week) || week < 1) continue;
    if (regularPeriods != null && week > regularPeriods) { skippedPostseason++; continue; }

    const home = sideOf(m?.home), away = sideOf(m?.away);
    if (!periodPlayed({ winner: m?.winner, homePoints: home.points, awayPoints: away.points }).played) {
      skippedUnplayed++; continue;
    }

    for (const [self, opp] of [[home, away], [away, home]]) {
      if (self.teamId == null) continue;
      rows.push({
        season,
        league_id: String(lg?.league_id ?? lg?.id ?? 'app'),
        num_teams: numTeams,
        playoff_teams: playoffTeams,
        roster_id: String(self.teamId),
        week,
        points: self.points,
        opponent_roster_id: opp.teamId == null ? null : String(opp.teamId),
        made_playoffs: null,
        champion: null,
        outcome_known: false
      });
    }
  }

  if (!rows.length) {
    return { rows: [], ok: false,
      reason: `no played regular-season weeks in this league's payload (${skippedUnplayed} periods not yet played)`,
      skipped_unplayed: skippedUnplayed, skipped_postseason: skippedPostseason };
  }
  const weeks = [...new Set(rows.map(r => r.week))].sort((a, b) => a - b);
  return {
    rows, ok: true,
    season, num_teams: numTeams, playoff_teams: playoffTeams,
    // How long the regular season RUNS, which is not how many weeks have been played.
    // `weeklyPanel` derives `weeks_left` from the rows it is handed, so for a live league it
    // reports zero at the last played week -- the model told the season is over. A consumer
    // cannot correct that without this number, and it is null rather than a guess when the
    // payload does not carry it. See `league-outlook.js`.
    regular_periods: regularPeriods,
    weeks_played: weeks.length, last_week: weeks[weeks.length - 1],
    skipped_unplayed: skippedUnplayed, skipped_postseason: skippedPostseason
  };
}
