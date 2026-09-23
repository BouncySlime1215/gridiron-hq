/**
 * Grading reads (plan item 13). GET /api/grades/:leagueId/ledger: how many
 * recommendations the ledger holds for a league, per kind (trade, lineup,
 * waiver, scenario) and per disposition (shown, considered_not_shown), and
 * what share of them has been graded. The report card that reads the scores
 * themselves is GR-02; this route is what makes `rec_ledger` reach the app.
 */
import { Router } from 'express';
import { row } from '../db/index.js';
import { assertLeagueMember } from '../platform/auth.js';
import { ledgerSummary } from '../services/rec-ledger.js';

const r = Router();

r.get('/:leagueId/ledger', (req, res, next) => {
  try {
    // Only the id: this route never needs the league's payload or cookies.
    const lg = row('SELECT id FROM leagues WHERE id = ?', req.params.leagueId);
    if (!lg) return res.status(404).json({ error: 'league not found' });
    assertLeagueMember(req.auth?.userId, lg.id);
    res.json(ledgerSummary(Number(lg.id)));
  } catch (e) { next(e); }
});

export default r;
