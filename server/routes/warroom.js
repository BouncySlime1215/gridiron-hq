/**
 * WR-3 + WR-COACH: the War Room's write side. Records only.
 *
 *   POST /api/warroom/:leagueId/requests          record one of Nick's inputs (objective, approve,
 *                                                 "I sent it", reply + decline reason, skip reason,
 *                                                 risk mode, tolerance, add/remove stop, retract)
 *   GET  /api/warroom/:leagueId/requests          this user's recent requests for the league
 *   GET  /api/warroom/layout                      this user's latest saved layout (null = default)
 *   PUT  /api/warroom/layout                      save a new layout version
 *   POST /api/warroom/:leagueId/action-log        log one Coach UI action
 *   GET  /api/warroom/:leagueId/action-log        this user's action log for the league
 *
 * No handler reads a plan, prices anything or replans. The offline campaign
 * producer reads warroom_requests and does that work. Flag off -> every route
 * answers { enabled: false } and records nothing.
 */
import { Router } from 'express';
import { assertLeagueMember } from '../platform/auth.js';
import {
  warRoomEnabled, warRoomPreview, recordRequest, listRequests, saveLayout, latestLayout,
  logAction, listActionLog
} from '../services/warroom-actions/store.js';
import { loadPlans } from '../services/war-room-view.js';

const r = Router();

r.use((req, res, next) => {
  if (!warRoomEnabled()) return res.json({ enabled: false });
  next();
});

function leagueOf(req) {
  const leagueId = Number(req.params.leagueId);
  if (!Number.isInteger(leagueId) || leagueId < 1) {
    const err = new Error('leagueId must be a positive whole number');
    err.status = 400;
    throw err;
  }
  assertLeagueMember(req.auth.userId, leagueId);
  return leagueId;
}

const fail = (res, e, next) => (e?.status && e.status < 500 ? res.status(e.status).json({ error: e.message }) : next(e));

const CARD_KINDS = new Set(['offer.sent', 'deck.skip']);

r.post('/:leagueId/requests', async (req, res, next) => {
  try {
    const leagueId = leagueOf(req);
    const body = req.body ?? {};
    // Only a request that names a card reads the plans file (one cached read).
    const plans = CARD_KINDS.has(body.kind) ? await loadPlans() : null;
    const request = recordRequest({
      userId: req.auth.userId, leagueId, kind: body.kind, payload: body.payload ?? {},
      source: body.source ?? 'nick', confirmed: body.confirmed === true, plans
    });
    if (request.already_sent) {
      res.json({ enabled: true, ...warRoomPreview(), request: null, already_sent: true,
        trade_outcome: request.trade_outcome, note: 'Already marked sent; nothing new recorded.' });
      return;
    }
    res.status(201).json({ enabled: true, ...warRoomPreview(), request,
      ...(request.trade_outcome ? { trade_outcome: request.trade_outcome } : {}),
      note: 'Recorded. The planner picks this up on its next run; usually a few minutes.' });
  } catch (e) { fail(res, e, next); }
});

r.get('/:leagueId/requests', (req, res, next) => {
  try {
    const leagueId = leagueOf(req);
    res.json({ enabled: true, ...warRoomPreview(),
      requests: listRequests({ userId: req.auth.userId, leagueId, limit: Number(req.query.limit) || 50 }) });
  } catch (e) { fail(res, e, next); }
});

r.get('/layout', (req, res, next) => {
  try {
    res.json({ enabled: true, ...warRoomPreview(), saved: latestLayout({ userId: req.auth.userId }) });
  } catch (e) { fail(res, e, next); }
});

r.put('/layout', (req, res, next) => {
  try {
    res.json({ enabled: true, saved: saveLayout({ userId: req.auth.userId, layout: req.body?.layout }) });
  } catch (e) { fail(res, e, next); }
});

r.post('/:leagueId/action-log', (req, res, next) => {
  try {
    const leagueId = leagueOf(req);
    const b = req.body ?? {};
    res.status(201).json({ enabled: true, logged: logAction({
      userId: req.auth.userId, leagueId, action: b.action, outcome: b.outcome, asked: b.asked, detail: b.detail
    }) });
  } catch (e) { fail(res, e, next); }
});

r.get('/:leagueId/action-log', (req, res, next) => {
  try {
    const leagueId = leagueOf(req);
    res.json({ enabled: true,
      log: listActionLog({ userId: req.auth.userId, leagueId, limit: Number(req.query.limit) || 50 }) });
  } catch (e) { fail(res, e, next); }
});

export default r;
