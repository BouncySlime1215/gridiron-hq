/**
 * One of Nick's own leagues, scored against the stored Team Outlook fit.
 *
 * The obvious implementation: load the active fit, build the panel from the league's own
 * weekly scores, score every team at the latest week. This is the version the tests are
 * written against, and the tests say it is wrong in three ways.
 */
import { weeklyPanel } from './history-corpus.js';
import { activeOutlookFit, outlookFitStatus } from './outlook-fit-store.js';
import {
  espnWeeklyRows, featureRow, predictOutlook, verdictFor, decompose, OUTLOOK_FEATURES
} from './team-outlook.js';

const notReady = reason => ({ ready: false, reason });

export function leagueOutlook(lg) {
  const fit = activeOutlookFit();
  if (!fit) return notReady(outlookFitStatus().reason ?? 'no fit');

  const raw = espnWeeklyRows(lg);
  if (!raw.ok) return notReady(raw.reason);

  const week = raw.last_week;
  const panel = weeklyPanel({ rows: raw.rows }).filter(r => r.week === week);

  const teams = panel.map(row => {
    const features = featureRow(row, fit.k);
    const probability = predictOutlook(fit, row);
    return {
      roster_id: row.roster_id,
      probability: probability == null ? null : +probability.toFixed(4),
      verdict: verdictFor(probability, fit.thresholds),
      features: Object.fromEntries(OUTLOOK_FEATURES.map(name => [name, features[name]])),
      decomposition: decompose(fit, row),
      games: row.games, wins_so_far: row.wins_so_far, games_back: row.games_back
    };
  });

  return {
    ready: true, season: raw.season, week,
    weeks_played: raw.weeks_played, weeks_left: raw.regular_periods - week,
    regular_periods: raw.regular_periods,
    num_teams: raw.num_teams, playoff_teams: raw.playoff_teams,
    fit: { id: fit.id, k: fit.k, weeks: fit.weeks, thresholds: fit.thresholds,
      fitted_at: fit.fitted_at, through_season: fit.through_season, basis: 'the stored fit' },
    teams
  };
}
