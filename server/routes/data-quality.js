import { Router } from 'express';
import { db } from '../db/index.js';
import { dataQualityFlag, readDataQuality } from '../services/data-quality.js';
import { dataFreshness, servedTablesRegistry } from '../services/data-freshness.js';
import { loadDecidedOffers } from '../services/eval/decided-offers.js';
import { readNumberHealthTrend } from '../services/number-audit.js';
import { loadPlans } from '../services/war-room-view.js';
import { currentNflWeek } from '../services/weekly-learning.js';

const r = Router();

/**
 * DATA QUALITY PANEL (Batch D item 35): Settings -> Health's one read of freshness per source,
 * offer orphans, the number-health trend and last-good fallbacks. Read-only: every section comes
 * from its existing producer (services/data-quality.js names each one); nothing is recomputed.
 *
 * Behind GRIDIRON_DATA_QUALITY (off by default). Off, it answers `{ enabled: false, reason }`
 * and reads nothing.
 */
r.get('/', async (_req, res, next) => {
  try {
    const flag = dataQualityFlag();
    if (!flag.enabled) return res.json(flag);
    const week = currentNflWeek();
    const plans = await loadPlans();
    res.json(readDataQuality({
      database: db, currentSeason: week.season, currentWeek: week.week, plans,
      dataFreshness, registry: servedTablesRegistry(), loadDecidedOffers, readNumberHealthTrend,
    }));
  } catch (e) { next(e); }
});

export default r;
