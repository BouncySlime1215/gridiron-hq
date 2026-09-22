import { Router } from 'express';
import { dataFreshness, servedTablesRegistry } from '../services/data-freshness.js';
import { currentNflWeek } from '../services/weekly-learning.js';
import { NFLVERSE_SOURCE } from '../services/nflverse.js';
import { FFOPPORTUNITY_SOURCE } from '../services/ffopportunity.js';

const r = Router();

/**
 * Is the data the app serves actually current, table by table.
 *
 * This replaces the "data healthy" banner that read the sync log and reported
 * healthy while `player_week_usage` held 2021-2025 and nothing for the season
 * being played (see `services/data-freshness.js`). The service reads the tables
 * themselves and is pure over which season and week count as current; the two
 * things only the route can supply are exactly those, resolved here from the
 * schedule via `currentNflWeek`, and reported back in the payload so a reader
 * knows what "current" meant when the verdicts were computed.
 *
 * Mounted behind the same `legacyAuthenticated` gate as every other data route,
 * because it answers with row counts and dates — app data, not a liveness
 * ping. The unauthenticated liveness endpoint stays in `platform/health.js` and
 * still says as little as possible.
 *
 * `sources` names the CC BY 4.0 feeds these tables come from, with the licence
 * link each one requires, so the attribution travels with the report.
 */
r.get('/', (req, res) => {
  const now = currentNflWeek();
  const tables = dataFreshness({
    registry: servedTablesRegistry(),
    currentSeason: now.season,
    currentWeek: now.week
  });
  res.json({
    season: now.season,
    week: now.week,
    all_fresh: tables.every(t => t.status === 'fresh'),
    tables,
    sources: [NFLVERSE_SOURCE, FFOPPORTUNITY_SOURCE]
  });
});

export default r;
