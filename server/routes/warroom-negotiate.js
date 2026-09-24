/**
 * NEGOTIATE-UI: the War Room's negotiation mode (WAR-ROOM-UI.md v3, new mode 1),
 * mounted at /api/warroom.
 *
 *   GET  /:leagueId/negotiations                  open threads (+ closed in the last day)
 *   POST /:leagueId/negotiations                  "I sent it": { move_id, step_index }
 *   POST /:leagueId/negotiations/:id/reply        { reply, give?, get?, note? } (counter carries his ask)
 *   POST /:leagueId/negotiations/:id/counter-sent { give, get }: Nick sent a counter; the clock restarts
 *   POST /:leagueId/negotiations/:id/follow-up    Nick followed up
 *   POST /:leagueId/negotiations/:id/close        { reason: 'walked_away' | 'undone' }
 *   POST /:leagueId/negotiations/:id/rescore      { give, get, rosters? }: the counter builder
 *
 * Membership first, then the flag (warroom-flag.js#negotiateFlag, off by default, on
 * in preview). Opening a thread reads the step from the served War Room view, never
 * from the request body, so the stored branches are the producer's. Nothing here
 * sends an offer; the rescore is the only computation and it is one fast rescore.
 */
import { Router } from 'express';
import { row } from '../db/index.js';
import { assertLeagueMember } from '../platform/auth.js';
import { previewFields, previewText } from '../services/preview-mode.js';
import { negotiateFlag, NEGOTIATE_PREVIEW_REASON } from '../services/warroom-flag.js';
import { warRoomView } from '../services/war-room-view.js';
import { rescorerFor } from '../services/warroom-rescorer.js';
import {
  REPLY_KINDS, findStep, openThread, getThread, threadsFor, eventsOf, addEvent, closeThread, closesOn,
  addNames, replyTimes, threadView
} from '../services/warroom-negotiate.js';

const bad = (res, error) => { res.status(400).json({ error }); };
const idList = v => (Array.isArray(v) && v.every(x => /^[A-Za-z0-9_.:-]{1,64}$/.test(String(x))) ? v.map(String) : null);

export function negotiateRouter({
  rescorer = rescorerFor, view = warRoomView, times = replyTimes, clock = () => Date.now()
} = {}) {
  const r = Router();

  /** The league, membership checked, or null with the response sent. */
  function league(req, res) {
    const lg = row('SELECT * FROM leagues WHERE id = ?', req.params.leagueId);
    if (!lg) { res.status(404).json({ error: 'league not found' }); return null; }
    assertLeagueMember(req.auth?.userId, lg.id);
    const flag = negotiateFlag();
    if (!flag.enabled) { res.json({ enabled: false }); return null; }
    return { lg, flag };
  }
  const meta = flag => ({ enabled: true, ...(flag.preview ? previewFields(NEGOTIATE_PREVIEW_REASON) : {}) });

  async function render(lg, flag, t) {
    const dist = await times(lg.id, String(lg.my_team_id), t.partner);
    const v = threadView(t, eventsOf(t.id), dist, clock());
    if (flag.preview && v.countdown) {
      v.countdown.basis = previewText(v.countdown.basis);
      if (v.countdown.reason) v.countdown.reason = previewText(v.countdown.reason);
    }
    return v;
  }

  /** The thread for this league, open, or null with the response sent. */
  function thread(req, res, { open = true } = {}) {
    const t = getThread(req.params.leagueId, Number(req.params.id));
    if (!t) { res.status(404).json({ error: 'negotiation not found' }); return null; }
    if (open && t.status !== 'open') { res.status(409).json({ error: `this negotiation is closed (${t.closed_reason})` }); return null; }
    return t;
  }

  r.get('/:leagueId/negotiations', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      const list = threadsFor(L.lg.id, { now: clock() });
      res.json({ ...meta(L.flag), threads: await Promise.all(list.map(t => render(L.lg, L.flag, t))) });
    } catch (e) { next(e); }
  });

  r.post('/:leagueId/negotiations', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      const moveId = String(req.body?.move_id ?? '');
      const stepIndex = Number(req.body?.step_index ?? 0);
      if (!moveId || !Number.isInteger(stepIndex) || stepIndex < 0) return bad(res, 'move_id and a step_index are required');
      const v = await view(L.lg.id);
      const found = findStep(v, moveId, stepIndex);
      if (!found) return res.status(409).json({ error: 'That move is not on the current plan any more; refresh the War Room.' });
      const id = openThread({ leagueId: L.lg.id, userId: req.auth?.userId ?? null, moveId, stepIndex,
        step: found.step, names: v.names, snapshotId: v.snapshot?.id ?? null, at: new Date(clock()).toISOString() });
      res.status(201).json({ ...meta(L.flag), thread: await render(L.lg, L.flag, getThread(L.lg.id, id)) });
    } catch (e) { next(e); }
  });

  r.post('/:leagueId/negotiations/:id/reply', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      const t = thread(req, res); if (!t) return;
      const kind = req.body?.reply;
      if (!REPLY_KINDS.includes(kind)) return bad(res, `reply must be one of ${REPLY_KINDS.join(', ')}`);
      let give = null, get = null;
      if (kind === 'counter' && (req.body.give != null || req.body.get != null)) {
        give = idList(req.body.give); get = idList(req.body.get);
        if (!give || !get) return bad(res, 'his ask needs give and get as lists of player ids');
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 280) : null;
      const at = new Date(clock()).toISOString();
      addEvent(t.id, { kind: 'reply', reply: kind, give, get, note, at });
      if (closesOn(kind)) closeThread(t.id, closesOn(kind), at);
      res.json({ ...meta(L.flag), thread: await render(L.lg, L.flag, getThread(L.lg.id, t.id)) });
    } catch (e) { next(e); }
  });

  r.post('/:leagueId/negotiations/:id/counter-sent', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      const t = thread(req, res); if (!t) return;
      const give = idList(req.body?.give), get = idList(req.body?.get);
      if (!give?.length || !get?.length) return bad(res, 'a counter needs give and get as lists of player ids');
      addEvent(t.id, { kind: 'counter_sent', give, get, at: new Date(clock()).toISOString() });
      res.json({ ...meta(L.flag), thread: await render(L.lg, L.flag, getThread(L.lg.id, t.id)) });
    } catch (e) { next(e); }
  });

  r.post('/:leagueId/negotiations/:id/follow-up', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      const t = thread(req, res); if (!t) return;
      addEvent(t.id, { kind: 'follow_up', at: new Date(clock()).toISOString() });
      res.json({ ...meta(L.flag), thread: await render(L.lg, L.flag, getThread(L.lg.id, t.id)) });
    } catch (e) { next(e); }
  });

  r.post('/:leagueId/negotiations/:id/close', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      const t = thread(req, res); if (!t) return;
      const reason = req.body?.reason;
      if (!['walked_away', 'undone'].includes(reason)) return bad(res, "reason must be 'walked_away' or 'undone'");
      const at = new Date(clock()).toISOString();
      if (reason === 'undone' && !threadView(t, [], null, clock()).can_undo) {
        return res.status(409).json({ error: 'The undo window has passed; walk away instead.' });
      }
      closeThread(t.id, reason, at);
      res.json({ ...meta(L.flag), thread: await render(L.lg, L.flag, getThread(L.lg.id, t.id)) });
    } catch (e) { next(e); }
  });

  r.post('/:leagueId/negotiations/:id/rescore', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      if (!L.lg.payload) return bad(res, 'league not synced yet — sync it on the My Leagues page');
      const t = thread(req, res); if (!t) return;
      const give = idList(req.body?.give), get = idList(req.body?.get);
      if (!give || !get) return bad(res, 'give and get must be lists of player ids');
      const R = await rescorer(L.lg);
      if (R.fail) {
        return res.json({ ...meta(L.flag), status: 'failed', reason: R.fail, build_ms: R.build_ms });
      }
      const scored = R.score({ partner: t.partner, give, get });
      if (scored.problems.length) return res.status(422).json({ error: scored.problems[0], problems: scored.problems });
      // The walk-away line: the package he'd get at your walk-away, on the same screen.
      const step = JSON.parse(t.step_json);
      const wa = step.walk_away;
      const screen = wa?.status === 'ok' ? R.screenOf(wa.value.max_give ?? [], JSON.parse(t.get_json)) : null;
      const walk_away = wa?.status !== 'ok'
        ? { status: wa?.status === 'failed' ? 'failed' : 'unknown', source: 'clone.price', reason: wa?.reason ?? 'No walk-away was priced for this step.' }
        : Number.isFinite(screen)
          ? { status: 'ok', source: 'clone.price', value: screen, unit: 'percent', text: wa.value.text }
          : { status: 'unknown', source: 'clone.price', reason: 'The walk-away package has no market value to place on his screen.' };
      const labels = Object.fromEntries([...give, ...get].map(id => [id, R.label(id)]));
      addNames(t.id, labels);
      res.json({
        ...meta(L.flag), status: 'ok', partner: t.partner, give, get, names: labels,
        ms: scored.ms, build_ms: R.build_ms, runs: scored.runs, axis: R.axis,
        nick: scored.nick, his: scored.his, walk_away,
        ...(req.body?.rosters ? { rosters: { mine: R.roster(R.me), his: R.roster(t.partner) } } : {})
      });
    } catch (e) { next(e); }
  });

  return r;
}

export default negotiateRouter();
