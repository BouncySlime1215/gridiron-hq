import { Router } from 'express';
import { syncSeason, syncSeasonSchedule, syncPitcherGameLogs, syncBatterGameLogs, coverage } from '../services/mlb.js';

const r = Router();

/** Games + first-inning results + both game-log tables for one season. */
r.post('/sync', async (req, res, next) => {
  try {
    const season = Number(req.query.season);
    if (!season) return res.status(400).json({ error: 'season query param required' });
    res.json(await syncSeason(season));
  } catch (e) { next(e); }
});

r.post('/sync/schedule', async (req, res, next) => {
  try { res.json(await syncSeasonSchedule(Number(req.query.season))); } catch (e) { next(e); }
});
r.post('/sync/pitchers', async (req, res, next) => {
  try { res.json(await syncPitcherGameLogs(Number(req.query.season))); } catch (e) { next(e); }
});
r.post('/sync/batters', async (req, res, next) => {
  try { res.json(await syncBatterGameLogs(Number(req.query.season))); } catch (e) { next(e); }
});

/** Row counts per season across all three tables — the honest "how much training data" check. */
r.get('/status', (req, res, next) => {
  try { res.json(coverage()); } catch (e) { next(e); }
});

export default r;
