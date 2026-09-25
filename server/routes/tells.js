/**
 * TELLS-01b tells card — read-only.
 *
 *   GET /api/tells/:leagueId/card[?as_of=ISO]
 *        the stored per-manager tells card (screen tells and the clone features,
 *        each with n, outcome, q and as_of) and the E1 grade of the clone, as
 *        written by producer 'tells'. Nothing is computed on the request.
 *
 * League members only (assertLeagueMember): a non-member gets 403.
 * Default OFF; see services/tells/card.js for the switch.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { assertLeagueMember } from '../platform/auth.js';
import { tellsCardResponse } from '../services/tells/card.js';

const r = Router();

r.get('/:leagueId/card', (req, res, next) => {
  try {
    const leagueId = Number(req.params.leagueId);
    if (!Number.isInteger(leagueId) || leagueId <= 0) return res.status(400).json({ error: 'league id must be a positive integer' });
    assertLeagueMember(req.auth?.userId, leagueId);
    let asOf = new Date();
    if (req.query.as_of != null) {
      asOf = new Date(String(req.query.as_of));
      if (!Number.isFinite(asOf.getTime())) return res.status(400).json({ error: 'as_of must be an ISO timestamp' });
    }
    res.json(tellsCardResponse(db, leagueId, { asOf }));
  } catch (error) {
    next(error);
  }
});

export default r;
