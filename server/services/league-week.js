/**
 * The league's current week, the way ESPN sees it: league.week, produced by
 * week.js#leagueWeek (BROKEN-D). This name stays for its readers.
 */
import { leagueWeek } from './week.js';

export const leagueCurrentWeek = leagueWeek;

/** The most recent completed week for a league — what a postmortem is about. */
export function leagueLastCompletedWeek(lg) {
  return Math.max(1, leagueCurrentWeek(lg) - 1);
}
