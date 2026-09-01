/**
 * What changed between seasons, and what it should do to a projection.
 *
 * The engine adapts well WITHIN a season: role memory decays on a five-week
 * half-life, the weekly ensemble reweights per position, and
 * `role-changepoint.js` promotes a sustained usage shift once snap share
 * corroborates it. Across the offseason it does much less. It reads a
 * player's CURRENT team label and discounts prior seasons heavily
 * (`WEEKLY_ROLE_RECENCY.seasonDecay = 0.05`), but nothing anywhere asks the
 * question that actually matters in August:
 *
 *   this player's history was produced inside a different offense —
 *   what does the new one imply?
 *
 * Heavy season decay is a blunt substitute. It correctly distrusts old data,
 * but it distrusts a returning three-year starter exactly as much as a player
 * who just changed teams, and it says nothing about the opportunity a
 * departing teammate left behind.
 *
 * Two quantities are derived here, both from `player_week_usage`, which
 * already carries per-week team assignment — no new data source:
 *
 *   changedTeam    did this player's team change between seasons
 *   vacatedShare   what fraction of a team's prior-season targets/carries
 *                  belonged to players who are no longer on the roster
 *
 * Vacated opportunity is the causal mechanism behind most real breakouts: a
 * receiver's target share rises because the man ahead of him left, not
 * because he improved. It is observable before Week 1, which is exactly when
 * the model is otherwise blindest.
 *
 * IMPORTANT: nothing here is applied to production. These are candidate
 * adjustments, measured and then run through the same
 * discovery -> significance -> Holm pipeline as every other head. The
 * codebase's own repeated finding is that plausible signals usually fail;
 * this one gets no exemption for being well-motivated.
 */
import { rows } from '../db/index.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { rosterStateAt } from './nfl-player-state.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/**
 * Team assignment per player per season, plus that season's opportunity.
 * `primary team` is the team he took the most opportunity for, so a
 * mid-season trade resolves to where he actually played most.
 */
function seasonTeams(season) {
  const usage = rows(`SELECT player_id, team, position,
                             SUM(COALESCE(targets,0)) targets,
                             SUM(COALESCE(carries,0)) carries,
                             SUM(COALESCE(attempts,0)) attempts,
                             COUNT(*) games
                      FROM player_week_usage
                      WHERE season = ? AND team IS NOT NULL
                      GROUP BY player_id, team`, season);
  const byPlayer = new Map();
  for (const r of usage) {
    const opp = (r.targets ?? 0) + (r.carries ?? 0) + (r.attempts ?? 0);
    const cur = byPlayer.get(r.player_id);
    if (!cur || opp > cur.opportunity) {
      byPlayer.set(r.player_id, { player_id: r.player_id, team: r.team, position: r.position,
        targets: r.targets ?? 0, carries: r.carries ?? 0, attempts: r.attempts ?? 0,
        opportunity: opp, games: r.games });
    }
  }
  return byPlayer;
}

/**
 * Offseason change report for `season`, using only `season - 1` and earlier.
 * Safe to call before Week 1 — it reads no in-season data at all.
 */
export function offseasonChanges(season, { cutoff = new Date().toISOString() } = {}) {
  const prior = seasonTeams(season - 1);
  let current = seasonTeams(season);
  const configuredSeason = Number(process.env.NFL_SEASON) || new Date().getFullYear();
  // Before Week 1 there are no current-season usage rows. For the configured
  // season, reconstruct the roster from dated snapshots + verified moves.
  // Historical seasons keep using their immutable weekly assignments.
  if (season === configuredSeason) {
    const state = rosterStateAt(cutoff);
    if (state.baseline_captured_at) {
      current = new Map([...state.players.values()]
        .filter(player => player.player_id != null && player.team && player.roster_status !== 'free_agent')
        .map(player => [Number(player.player_id), {
          player_id: Number(player.player_id), team: player.team, position: player.position,
          targets: 0, carries: 0, attempts: 0, opportunity: 0, games: 0,
          roster_evidence: player.evidence_kind, roster_effective_at: player.effective_at
        }]));
    }
  }

  // Who moved, and who left the league entirely (no current-season row).
  const playerChange = new Map();
  for (const [playerId, before] of prior) {
    const after = current.get(playerId);
    playerChange.set(playerId, {
      player_id: playerId, position: before.position,
      prior_team: before.team, current_team: after?.team ?? null,
      changed_team: after ? after.team !== before.team : null,
      departed_league: !after,
      prior_targets: before.targets, prior_carries: before.carries, prior_attempts: before.attempts
    });
  }
  for (const [playerId, after] of current) {
    if (playerChange.has(playerId)) continue;
    // No prior-season usage: rookie, or returning from an absent season.
    playerChange.set(playerId, {
      player_id: playerId, position: after.position,
      prior_team: null, current_team: after.team,
      changed_team: null, departed_league: false, is_new: true,
      prior_targets: 0, prior_carries: 0, prior_attempts: 0
    });
  }

  // Per team: how much of last season's opportunity is no longer in the building.
  const teamTotals = new Map();
  for (const [, before] of prior) {
    const t = teamTotals.get(before.team) ?? { targets: 0, carries: 0, attempts: 0,
      vacated_targets: 0, vacated_carries: 0, vacated_attempts: 0 };
    t.targets += before.targets; t.carries += before.carries; t.attempts += before.attempts;
    const after = current.get(before.player_id);
    const gone = !after || after.team !== before.team;
    if (gone) {
      t.vacated_targets += before.targets;
      t.vacated_carries += before.carries;
      t.vacated_attempts += before.attempts;
    }
    teamTotals.set(before.team, t);
  }
  const teams = new Map();
  for (const [team, t] of teamTotals) {
    teams.set(team, {
      team,
      prior_targets: t.targets, prior_carries: t.carries, prior_attempts: t.attempts,
      vacated_targets: t.vacated_targets, vacated_carries: t.vacated_carries,
      vacated_attempts: t.vacated_attempts,
      vacated_target_share: t.targets > 0 ? t.vacated_targets / t.targets : null,
      vacated_carry_share: t.carries > 0 ? t.vacated_carries / t.carries : null,
      vacated_attempt_share: t.attempts > 0 ? t.vacated_attempts / t.attempts : null
    });
  }

  return { season, players: playerChange, teams };
}

/**
 * Per-player offseason context for the season being projected: did he move,
 * and how much opportunity is open on the team he is now on.
 */
export function offseasonContextFor(season, options = {}) {
  const { players, teams } = offseasonChanges(season, options);
  const out = new Map();
  for (const [playerId, change] of players) {
    const team = change.current_team ? teams.get(change.current_team) ?? null : null;
    out.set(playerId, {
      ...change,
      new_team_vacated_target_share: team?.vacated_target_share ?? null,
      new_team_vacated_carry_share: team?.vacated_carry_share ?? null,
      new_team_vacated_attempt_share: team?.vacated_attempt_share ?? null
    });
  }
  return out;
}

/**
 * First-year players: no prior-season usage to decay, so the weekly ensemble
 * runs in `structural_only_no_current_season_history` mode until they build
 * one. Measures what opportunity a first-season player actually receives, by
 * position, so the structural prior for them can be checked against reality
 * rather than assumed.
 *
 * "Rookie" here means "no prior-season usage row", which also catches a
 * player returning from a fully missed season. Called out rather than hidden
 * because it is a real difference from a draft-class definition.
 */
export function measureFirstYearOpportunity(seasons) {
  const out = {};
  for (const season of seasons) {
    const prior = seasonTeams(season - 1), current = seasonTeams(season);
    const firstYear = [...current.values()].filter(p => !prior.has(p.player_id) && p.games >= 4);
    const returning = [...current.values()].filter(p => prior.has(p.player_id) && p.games >= 4);
    const rate = list => (list.length
      ? +(list.reduce((s, p) => s + p.opportunity / p.games, 0) / list.length).toFixed(3) : null);
    const byPos = {};
    for (const pos of [...new Set(current.values().map(p => p.position))]) {
      const f = firstYear.filter(p => p.position === pos), r = returning.filter(p => p.position === pos);
      if (!f.length) continue;
      byPos[pos] = { first_year_n: f.length, first_year_opp_per_game: rate(f),
        returning_n: r.length, returning_opp_per_game: rate(r),
        ratio: rate(r) > 0 ? +(rate(f) / rate(r)).toFixed(3) : null };
    }
    out[season] = { first_year_players: firstYear.length, returning_players: returning.length, by_position: byPos };
  }
  return { seasons, by_season: out,
    note: '"First year" = no prior-season usage row, which also includes a player returning ' +
      'from a fully missed season, not only draft rookies. Min 4 games each side.' };
}

/**
 * Coaching and scheme change: recordable going forward, NOT backtestable.
 *
 * `nfl_teams` carries head_coach / oc_name / dc_name / off_scheme, but as a
 * single current snapshot with no season column. There is no record of who
 * coordinated which offense in 2022, so a historical "coordinator changed"
 * effect cannot be measured on this data at all — and an effect that cannot
 * be measured must not be given a coefficient.
 *
 * This snapshots the current staff/scheme per team so that from this season
 * forward a real change history accumulates and becomes testable. Until at
 * least two snapshots separated by an offseason exist, `comparable` is false
 * and nothing downstream should apply a coaching adjustment.
 */
export function coachingSnapshot() {
  const teams = rows(`SELECT abbr, head_coach, oc_name, dc_name, off_scheme, def_scheme FROM nfl_teams`);
  return {
    captured_for: new Date().toISOString().slice(0, 10),
    teams,
    comparable: false,
    why: 'nfl_teams holds one current snapshot with no season dimension, so no prior-season ' +
      'staff exists to diff against. Coaching-change effects are not measurable on this data.',
    to_enable: 'persist one snapshot per season; after two offseasons apart, a change history ' +
      'exists and a coaching-change candidate can go through the normal discovery gate.'
  };
}

/**
 * What actually happens to a player who changes teams?
 *
 * Measured rather than assumed, because "changing teams hurts production" is
 * folk wisdom of exactly the kind this codebase keeps disproving. Compares
 * each player's per-game opportunity in season S against season S-1, split by
 * whether he moved, so the movers are graded against the same year-over-year
 * drift the stayers experience.
 */
/**
 * Does the team-change effect actually improve a forecast, or is it just a
 * true fact that does not help?
 *
 * Those are different questions and this codebase keeps finding the second
 * one. The measured gap is real (movers hold ~0.74-0.90 of prior opportunity
 * against ~0.95-0.99 for stayers, every skill position, every season), but a
 * real effect only earns production authority if applying it beats not
 * applying it out of sample.
 *
 * Scope is deliberately narrow: `WEEKLY_ROLE_RECENCY.seasonDecay` is 0.05, so
 * prior-season evidence is ~95% discounted and by mid-season the projection
 * is driven almost entirely by current-season games. An offseason adjustment
 * can only matter in the first few weeks, before that history exists. Testing
 * it across a full season would dilute a real early-season effect into noise
 * and hide it — so this grades early weeks specifically, and says so.
 *
 * The correction factor is fit on `fitSeasons` and applied to `testSeason`,
 * never both, so the adjustment never sees the games it is graded on.
 */
export function validateTeamChangeAdjustment({ fitSeasons = [2023, 2024], testSeason = 2025,
  throughWeek = 5 } = {}) {
  const ratioFor = seasons => {
    const measured = measureTeamChangeEffect(seasons);
    const out = {};
    for (const [pos, v] of Object.entries(measured.by_position)) {
      if (!v.moved.median_ratio || !v.stayed.median_ratio) continue;
      // Relative to stayers, so ordinary year-over-year drift is not double counted.
      out[pos] = v.moved.median_ratio / v.stayed.median_ratio;
    }
    return out;
  };
  const factors = ratioFor(fitSeasons);

  const prior = seasonTeams(testSeason - 1);
  const usage = rows(`SELECT player_id, position, team, week,
                             COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0) opp
                      FROM player_week_usage
                      WHERE season = ? AND week BETWEEN 2 AND ? AND team IS NOT NULL`,
  testSeason, throughWeek);

  const rowsOut = [];
  for (const u of usage) {
    const before = prior.get(u.player_id);
    if (!before || before.games < 4) continue;
    const naive = before.opportunity / before.games;   // last season's rate, unadjusted
    if (!(naive > 0)) continue;
    const moved = u.team !== before.team;
    const factor = moved ? (factors[u.position] ?? 1) : 1;
    rowsOut.push({ actual: u.opp, unadjusted: naive, adjusted: naive * factor, moved });
  }
  if (rowsOut.length < 30) return { error: `too few rows (${rowsOut.length})`, factors };

  const errU = rowsOut.map(r => Math.abs(r.unadjusted - r.actual));
  const errA = rowsOut.map(r => Math.abs(r.adjusted - r.actual));
  const test = pairedBootstrapDiff(errU, errA, { iterations: 2000, seed: 11 });
  const movers = rowsOut.filter(r => r.moved);
  const errUM = movers.map(r => Math.abs(r.unadjusted - r.actual));
  const errAM = movers.map(r => Math.abs(r.adjusted - r.actual));
  const moversTest = movers.length >= 30
    ? pairedBootstrapDiff(errUM, errAM, { iterations: 2000, seed: 11 }) : { error: 'too few movers' };

  const mae = a => +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3);
  return {
    fit_seasons: fitSeasons, test_season: testSeason, through_week: throughWeek,
    factors_fit_on: factors,
    n: rowsOut.length, n_movers: movers.length,
    all_players: { unadjusted_mae: mae(errU), adjusted_mae: mae(errA), bootstrap: test,
      improves: test.significant === true && test.mean_diff < 0 },
    movers_only: movers.length >= 30
      ? { unadjusted_mae: mae(errUM), adjusted_mae: mae(errAM), bootstrap: moversTest,
        improves: moversTest.significant === true && moversTest.mean_diff < 0 }
      : moversTest,
    note: `Opportunity per game, weeks 2-${throughWeek} of ${testSeason}, against last season's ` +
      'rate with and without the mover correction. Correction fit on ' + fitSeasons.join('+') +
      ' only. Narrow by design: season decay is 0.05, so an offseason signal can only act early.'
  };
}

export function measureTeamChangeEffect(seasons) {
  const results = [];
  for (const season of seasons) {
    const prior = seasonTeams(season - 1), current = seasonTeams(season);
    for (const [playerId, before] of prior) {
      const after = current.get(playerId);
      if (!after || before.games < 4 || after.games < 4) continue;
      const beforeRate = before.opportunity / before.games;
      const afterRate = after.opportunity / after.games;
      if (!(beforeRate > 0)) continue;
      results.push({ season, player_id: playerId, position: before.position,
        moved: after.team !== before.team, ratio: afterRate / beforeRate,
        before_rate: beforeRate, after_rate: afterRate });
    }
  }
  const summarize = list => ({
    n: list.length,
    median_ratio: list.length
      ? [...list].map(x => x.ratio).sort((a, b) => a - b)[Math.floor(list.length / 2)] : null,
    mean_ratio: list.length ? +mean(list.map(x => x.ratio)).toFixed(4) : null
  });
  const movers = results.filter(x => x.moved), stayers = results.filter(x => !x.moved);
  const byPosition = {};
  for (const pos of [...new Set(results.map(x => x.position))]) {
    byPosition[pos] = {
      moved: summarize(movers.filter(x => x.position === pos)),
      stayed: summarize(stayers.filter(x => x.position === pos))
    };
  }
  return {
    seasons, moved: summarize(movers), stayed: summarize(stayers), by_position: byPosition,
    note: 'Opportunity per game, season S vs S-1, min 4 games each side. Movers are ' +
      'compared against stayers so ordinary year-over-year drift is not attributed to the move.'
  };
}
