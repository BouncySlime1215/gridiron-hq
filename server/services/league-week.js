/**
 * The league's current week, the way ESPN sees it.
 *
 * Order of truth: the `current_week` column written at the last league sync
 * (ESPN `status.currentMatchupPeriod`), then the same field parsed from the
 * stored payload (leagues synced before the column existed), then the NFL
 * schedule/scores-derived week. Never a hard-coded 1 — that is how the app
 * spent two weeks showing week-1 lineups (2026-09-17).
 */
import { currentNflWeek } from './weekly-learning.js';

export function leagueCurrentWeek(lg) {
  const fromColumn = Number(lg?.current_week);
  if (fromColumn >= 1) return Math.min(18, fromColumn);
  try {
    const status = typeof lg?.payload === 'string' ? JSON.parse(lg.payload)?.status : lg?.payload?.status;
    const fromPayload = Number(status?.currentMatchupPeriod);
    if (fromPayload >= 1) return Math.min(18, fromPayload);
  } catch { /* fall through */ }
  return Math.max(1, Math.min(18, Number(currentNflWeek(lg?.season || undefined)?.week) || 1));
}

/** The most recent completed week for a league — what a postmortem is about. */
export function leagueLastCompletedWeek(lg) {
  return Math.max(1, leagueCurrentWeek(lg) - 1);
}
