/**
 * TELLS-01b tells card — read-only.
 *
 *   GET /api/tells/:leagueId/card   per-manager tells (reply latency, counter
 *                                   style, price they accepted, chat wants),
 *                                   each with n, weight, direction and the
 *                                   E1 grade of the clone they feed
 *
 * Default OFF; see services/tells/card.js for the switch.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { tellsCardResponse } from '../services/tells/card.js';

const r = Router();

r.get('/:leagueId/card', (req, res, next) => {
  try {
    const leagueId = Number(req.params.leagueId);
    if (!Number.isInteger(leagueId) || leagueId <= 0) return res.status(400).json({ error: 'league id must be a positive integer' });
    res.json(tellsCardResponse(db, leagueId));
  } catch (error) {
    next(error);
  }
});

export default r;
