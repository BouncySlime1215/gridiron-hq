/**
 * ESPN's own projections as carried in a synced ESPN league payload (SIM-KDST), one reader for
 * the season sim (K / D/ST scored at ESPN's projection) and the served week number
 * (trade-engine.js, PROJ-ESPN: K / D/ST are outside the frozen capture). Pure: no database.
 */
/**
 * ESPN's projections for every rostered player in an ESPN league payload, by ESPN
 * player id: `weeks` (NFL week -> projected points) and `perGame` (season
 * projection per game). statSourceId 1 = projection; statSplitTypeId 1 = one
 * scoring period, 0 = the season. appliedTotal / appliedAverage are already in the
 * league's scoring.
 */
export function espnProjections(lg) {
  const out = new Map();
  let payload;
  try { payload = JSON.parse(lg.payload ?? 'null'); } catch { return out; }
  const season = Number(payload?.seasonId ?? lg.season);
  for (const t of payload?.teams ?? []) {
    for (const e of t.roster?.entries ?? []) {
      const pl = e.playerPoolEntry?.player;
      if (pl?.id == null) continue;
      const rec = { weeks: new Map(), perGame: null };
      for (const st of pl.stats ?? []) {
        if (st.statSourceId !== 1 || Number(st.seasonId) !== season) continue;
        const total = Number(st.appliedTotal);
        if (st.statSplitTypeId === 1 && st.scoringPeriodId > 0 && Number.isFinite(total)) {
          rec.weeks.set(Number(st.scoringPeriodId), total);
        } else if (st.statSplitTypeId === 0 && st.scoringPeriodId === 0) {
          const avg = Number(st.appliedAverage);
          rec.perGame = Number.isFinite(avg) ? avg : (Number.isFinite(total) ? total / 17 : null);
        }
      }
      out.set(String(pl.id), rec);
    }
  }
  return out;
}
