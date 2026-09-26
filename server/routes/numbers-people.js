/**
 * NUMBERS-PEOPLE: Trades → Numbers & People.
 *
 *   GET  /api/numbers-people/:leagueId          the stored reads (services/numbers-people/view.js).
 *                                               When a run is due (no reads yet, the window has
 *                                               passed, or the plan's key items changed) it starts
 *                                               one in the background and says `refreshing`; the
 *                                               view itself never calls a model.
 *   POST /api/numbers-people/:leagueId/refresh  Nick's Refresh: one run now (budget-gated), then
 *                                               the view. A budget stop is a notice, not an error.
 */
import { Router } from 'express';
import { requireAuthenticated, assertLeagueMember } from '../platform/auth.js';
import { legacyRateLimit } from '../platform/legacy-access.js';
import { db } from '../db/index.js';
import { numbersPeopleView } from '../services/numbers-people/view.js';
import { runForLeague, runLeague, servedEntries, numbersPeopleOn, dueReason, openOfferRosters } from '../services/numbers-people/producer.js';
import { keyItems, inputsHash } from '../services/numbers-people/items.js';
import { lastRun, storeReady } from '../services/numbers-people/store.js';

const r = Router();
const REFRESH_LIMIT_PER_MINUTE = 4;

const leagueParam = req => {
  const id = Number(req.params.leagueId);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('leagueId must be a positive whole number'), { status: 400 });
  return id;
};

/** The league's served plan entry, or null (an unreadable plans file is said in the log, and the view shows the stored reads). */
async function servedEntry(leagueId) {
  try {
    const { entries } = await servedEntries();
    return entries.find(e => String(e.league) === String(leagueId)) ?? null;
  } catch (e) {
    console.warn(`[numbers-people] plans file could not be read: ${e?.message ?? e}`);
    return null;
  }
}

/** Start a due run in the background; true when one was started. */
function startIfDue(leagueId, entry) {
  if (!numbersPeopleOn() || !entry || !storeReady(db)) return false;
  const items = keyItems(entry, { openOffers: openOfferRosters(db, leagueId, entry.me) });
  if (!items.length) return false;
  const why = dueReason({ last: lastRun(db, leagueId, { status: 'ok' }), lastAny: lastRun(db, leagueId), hash: inputsHash(items), force: false, now: Date.now() });
  if (!why) return false;
  runLeague({ leagueId, entry, trigger: why === 'plan_change' ? 'plan_change' : 'view', plansAt: entry.planned_at ?? null })
    .catch(e => console.warn(`[numbers-people] background run for league ${leagueId} failed: ${e?.message ?? e}`));
  return true;
}

r.get('/:leagueId', requireAuthenticated, async (req, res, next) => {
  try {
    const leagueId = leagueParam(req);
    assertLeagueMember(req.auth.userId, leagueId);
    const entry = await servedEntry(leagueId);
    const refreshing = startIfDue(leagueId, entry);
    res.json(numbersPeopleView({ leagueId, entry, refreshing }));
  } catch (e) { next(e); }
});

r.post('/:leagueId/refresh', requireAuthenticated, legacyRateLimit({ limit: REFRESH_LIMIT_PER_MINUTE, windowMs: 60_000 }), async (req, res, next) => {
  try {
    const leagueId = leagueParam(req);
    assertLeagueMember(req.auth.userId, leagueId);
    const result = await runForLeague(leagueId, { force: true, trigger: 'refresh' });
    const entry = await servedEntry(leagueId);
    res.json({ ...numbersPeopleView({ leagueId, entry }), run: { status: result.status } });
  } catch (e) { next(e); }
});

export default r;
