/**
 * The one reader of a period's applied points from an ESPN player's stat list.
 * Dependency-free (no DB import) so both scripts/collect-roster-snapshots.mjs (writer of
 * league_roster_snapshots.projected_points / actual_points) and
 * scripts/rnd/espn-projection-poller.mjs read ESPN's projection the same way.
 */
export const round2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** This period's applied points from ESPN's stat list: source 0 = actual, 1 = projection. */
export function periodPoints(stats, season, period, sourceId) {
  const hit = (stats ?? []).find(s => s.seasonId === season && s.scoringPeriodId === period
    && s.statSourceId === sourceId && s.statSplitTypeId === 1);
  return hit ? round2(Number(hit.appliedTotal)) : null;
}
