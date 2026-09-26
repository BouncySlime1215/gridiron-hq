/**
 * PROJ-DUEL: My team -> ESPN vs our model.
 *   GET /api/proj-duel/:leagueId?week=N   services/proj-duel's rows and scoreboard (read-only, $0).
 */
import { Router } from 'express';
import { requireAuthenticated, assertLeagueMember } from '../platform/auth.js';
import { row } from '../db/index.js';
import { projDuel, duelWeeks } from '../services/proj-duel/index.js';
import { tradeWeekContext } from '../services/trade-engine.js';

const r = Router();

r.get('/:leagueId', requireAuthenticated, async (req, res, next) => {
  try {
    const leagueId = Number(req.params.leagueId);
    if (!Number.isInteger(leagueId) || leagueId < 1) return res.status(400).json({ error: 'leagueId must be a positive whole number' });
    assertLeagueMember(req.auth.userId, leagueId);
    const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
    if (!lg?.payload) return res.status(400).json({ error: 'league not synced yet' });
    const { season, week: current } = tradeWeekContext();
    const weeks = duelWeeks(season);
    const asked = req.query.week != null ? Number(req.query.week) : null;
    const week = Number.isInteger(asked) && asked >= 1 && asked <= 18 ? asked : (weeks.find(w => w <= current) ?? current);
    res.json({ ...(await projDuel(lg, { season, week })), weeks, current_week: current });
  } catch (e) { next(e); }
});

export default r;
