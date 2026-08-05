import { Router } from 'express';
import { boardFor, accuracy, predictGame, clearNflMarketCache } from '../services/nfl-market.js';
import { syncCurrentLines } from '../services/gamescript.js';
import { autoPickCandidates, ensurePicksFor, pickResultsFor, allPickResults, standing } from '../services/nfl-auto-picks.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

r.get('/board', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = Number(req.query.week) || 1;
    const out = boardFor(season, week);
    if (out?.error) return res.status(409).json(out);
    res.json({ season, week, board: out });
  } catch (e) { next(e); }
});

r.get('/accuracy', (req, res, next) => {
  try { res.json(accuracy()); } catch (e) { next(e); }
});

r.get('/predict', (req, res, next) => {
  try {
    const { home, away } = req.query;
    if (!home || !away) return res.status(400).json({ error: 'home and away query params required' });
    res.json(predictGame(String(home), String(away)));
  } catch (e) { next(e); }
});

r.get('/picks/history', (req, res, next) => {
  try { res.json({ results: allPickResults(), standing: standing() }); } catch (e) { next(e); }
});

r.get('/picks', (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = Number(req.query.week) || 1;
    res.json({ season, week, picks: pickResultsFor(season, week), standing: standing() });
  } catch (e) { next(e); }
});

/**
 * The weekly workflow: refresh every current-season line (which is also how last
 * week's final scores arrive), grade whatever picks are now settled, then lock in
 * this week's 5 most confident spread edges as new straight bets. Simulation
 * trial count is generous (default 20k per bet) since "how many scenarios were
 * actually run" is the honesty check on this button, not a number to shortcut.
 */
r.post('/sync-and-pick', async (req, res, next) => {
  try {
    const season = Number(req.query.season) || SEASON;
    const week = Number(req.query.week) || 1;
    const trials = Number(req.query.trials) || 20000;

    const synced = await syncCurrentLines(season, 18);
    clearNflMarketCache();

    const lastWeek = week - 1;
    const lastWeekResults = lastWeek >= 1 ? pickResultsFor(season, lastWeek) : [];

    const candidates = autoPickCandidates(season, week);
    const newPicks = ensurePicksFor(season, week, candidates, 5);

    res.json({
      season, week, trials, synced,
      last_week: { week: lastWeek, results: lastWeekResults },
      policy: { model: 'walk-forward ensemble', min_edge: 3, max_disagreement: 4.5 },
      eligible_candidates: candidates.length, new_picks: newPicks,
      standing: standing()
    });
  } catch (e) { next(e); }
});

export default r;
