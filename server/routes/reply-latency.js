/**
 * E-LATENCY — read-only.
 *
 *   GET /api/reply-latency?league=4   the reply-time table per manager (team id),
 *                                     the pre-registered grade of the follow-up
 *                                     hint, and a hint per offer still waiting
 *
 * Descriptive only: never a P(yes) input (services/eval/reply-latency.js).
 * Default OFF: on only with GRIDIRON_REPLY_LATENCY=1. Not switched on by
 * preview mode. Every hint says `shadow: true` until the grade passes.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { loadReplyLatency, REPLY_LATENCY_FLAG } from '../services/eval/reply-latency.js';

const OFF_REASON = 'reply-time table is default-off until its follow-up hint passes its pre-registered grade';

const r = Router();

r.get('/', (req, res, next) => {
  try {
    if (process.env[REPLY_LATENCY_FLAG] !== '1') return res.json({ enabled: false, reason: OFF_REASON });
    const league = req.query.league == null ? null : Number(req.query.league);
    if (league != null && !Number.isInteger(league)) return res.status(400).json({ error: 'league must be an integer' });
    res.json({ enabled: true, ...loadReplyLatency(db, { leagueId: league }) });
  } catch (error) {
    next(error);
  }
});

export default r;
