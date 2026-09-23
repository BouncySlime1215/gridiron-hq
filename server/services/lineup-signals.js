/** LS-01 lineup signals: stub for the RED commit. */
export function lineupSignals(leagueId) {
  return { league_id: Number(leagueId), available: false, reason: 'not built', signals: [], by_manager: {} };
}
