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
 * sends an offer.
 *
 * "I sent it" has ONE store: opening a thread records it through the War Room's own
 * request path (warroom-actions/store.js#recordRequest, kind offer.sent ->
 * trade_outcomes.sent_at), which is idempotent, so the deck's own offer.sent post and
 * this one land on the same row; the thread only points at it. Undo takes it back the
 * same way (a retract request).
 *
 * The rescore never runs here: campaign/negotiate-engine.js holds the world in one
 * worker thread. Until it is built for this league sync the answer is
 * { status: 'building', reason }; after that each edit is one awaited round trip,
 * capped at 8 s, so the event loop is never held.
 */
import { Router } from 'express';
import { row, rows } from '../db/index.js';
// RULES-EVERYWHERE: Nick's hard rules, the one gate (campaign/never-give.js).
import { ruleGate } from '../services/campaign/never-give.js';
import { assertLeagueMember } from '../platform/auth.js';
import { previewFields, previewText } from '../services/preview-mode.js';
import { negotiateFlag, NEGOTIATE_PREVIEW_REASON } from '../services/warroom-flag.js';
import { warRoomView, loadPlans } from '../services/war-room-view.js';
import { negotiateEngine } from '../services/campaign/negotiate-engine.js';
import { recordRequest } from '../services/warroom-actions/store.js';
import { unmarkSentOffer } from '../services/trade-outcomes.js';
import {
  REPLY_KINDS, findStep, openThread, closeIfUnsent, getThread, threadsFor, eventsOf, addEvent, closeThread, closesOn,
  addNames, replyTimes, threadView
} from '../services/warroom-negotiate.js';

const bad = (res, error) => { res.status(400).json({ error }); };
const previewed = (flag, text) => (flag.preview && text ? previewText(text) : text);

/**
 * Undo takes "I sent it" back in its one store: a retract of the latest offer.sent
 * request for this move (store.js unmarks trade_outcomes.sent_at). No request row by
 * this user (the deck's post came from elsewhere): unmark the row directly.
 */
function undoSent(userId, leagueId, t) {
  const sentReq = row(`SELECT id FROM warroom_requests WHERE league_id = ? AND user_id IS ? AND kind = 'offer.sent'
                         AND json_extract(payload, '$.move_id') = ? AND json_extract(payload, '$.trade_outcome.id') = ?
                       ORDER BY id DESC LIMIT 1`, leagueId, userId, t.move_id, t.trade_outcome_id);
  if (sentReq) {
    recordRequest({ userId, leagueId, kind: 'retract', payload: { request_id: sentReq.id } });
  } else {
    unmarkSentOffer(t.trade_outcome_id);
  }
}
/**
 * RULES-EVERYWHERE: a reply-table branch suggests packages (a backup deal { give, get }, the next rung and
 * the walk-away give against the step's get). A branch any of whose packages breaks one of Nick's hard
 * rules is dropped (typed unknown, source 'rules'); the count rides on the thread as dropped_by_rule.
 */
export function gateThreadView(gate, v) {
  let dropped = 0;
  const stepGet = v.get ?? [];
  const packagesIn = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const x of node) packagesIn(x, out); return out; }
    if (Array.isArray(node.give) && Array.isArray(node.get)) out.push({ give: node.give, get: node.get });
    for (const key of ['next_rung_give', 'walk_away_give']) if (Array.isArray(node[key])) out.push({ give: node[key], get: stepGet });
    for (const [k, x] of Object.entries(node)) if (k !== 'give' && k !== 'get' && x && typeof x === 'object') packagesIn(x, out);
    return out;
  };
  const branches = (v.branches ?? []).map(b => {
    if (b.plan?.status !== 'ok') return b;
    if (packagesIn(b.plan.value).every(p => gate.ok(p.give, p.get))) return b;
    dropped++;
    return { ...b, plan: { status: 'unknown', source: 'rules', reason: "Dropped: this branch's package breaks one of Nick's hard rules." } };
  });
  return { ...v, branches, dropped_by_rule: dropped };
}

const idList = v => (Array.isArray(v) && v.every(x => /^[A-Za-z0-9_.:-]{1,64}$/.test(String(x))) ? v.map(String) : null);

export function negotiateRouter({
  engine = negotiateEngine, view = warRoomView, plans = loadPlans, times = replyTimes, clock = () => Date.now()
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
    const v = gateThreadView(ruleGate({ row, rows }, { leagueId: lg.id }), threadView(t, eventsOf(t.id), dist, clock()));
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
    if (open && (t.status !== 'open' || t.sent_at == null)) {
      res.status(409).json({ error: `this negotiation is closed (${t.sent_at == null ? 'undone' : t.closed_reason})` });
      return null;
    }
    return t;
  }

  r.get('/:leagueId/negotiations', async (req, res, next) => {
    try {
      const L = league(req, res); if (!L) return;
      const list = threadsFor(L.lg.id, { now: clock() });
      // An open thread means the builder may be opened soon: start its build off-thread now.
      if (L.lg.payload && list.some(t => t.status === 'open' && t.sent_at != null)) engine.warm(L.lg);
      const threads = await Promise.all(list.map(t => render(L.lg, L.flag, t)));
      res.json({ ...meta(L.flag), threads, dropped_by_rule: threads.reduce((n, t) => n + (t.dropped_by_rule ?? 0), 0) });
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
      // RULES-EVERYWHERE: no thread for a move that breaks one of Nick's hard rules.
      if (!ruleGate({ row, rows }, { leagueId: L.lg.id }).ok(found.step?.give ?? [], found.step?.get ?? [])) {
        return res.status(422).json({ ...meta(L.flag), error: "That move breaks one of Nick's hard rules, so it is not served.", dropped_by_rule: 1 });
      }
      // A thread whose sent mark was taken back elsewhere closes first; the new send gets a new thread.
      closeIfUnsent(L.lg.id, moveId, stepIndex, new Date(clock()).toISOString());
      // The one "I sent it" store. Already marked (the deck posted it first) is the same row.
      let sent;
      try {
        sent = recordRequest({ userId: req.auth?.userId ?? null, leagueId: L.lg.id, kind: 'offer.sent',
          payload: { move_id: moveId, step_index: stepIndex }, plans: await plans(), now: clock() });
      } catch (e) {
        if (e?.status && e.status < 500) throw e;
        // The store refused the row (e.g. the ledger's CHECKs): no thread without it, and say why.
        return res.status(409).json({ error: `"I sent it" could not be recorded: ${e?.message ?? e}.` });
      }
      const outcome = sent.trade_outcome;
      if (outcome?.id == null) {
        return res.status(409).json({ error: `"I sent it" could not be recorded: ${outcome?.reason ?? 'no sent-offer row'}.` });
      }
      const id = openThread({ leagueId: L.lg.id, userId: req.auth?.userId ?? null, tradeOutcomeId: outcome.id, moveId, stepIndex,
        step: found.step, names: v.names, snapshotId: v.snapshot?.id ?? null, at: new Date(clock()).toISOString() });
      if (L.lg.payload) engine.warm(L.lg);
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
      if (reason === 'undone') undoSent(req.auth?.userId ?? null, L.lg.id, t);
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
      const step = JSON.parse(t.step_json);
      // RULES-EVERYWHERE: the walk-away is a suggested package too; one that breaks a hard rule is not priced or shown.
      const waRaw = step.walk_away;
      const waBreaks = waRaw?.status === 'ok' && !ruleGate({ row, rows }, { leagueId: L.lg.id }).ok(waRaw.value?.max_give ?? [], JSON.parse(t.get_json));
      const wa = waBreaks ? { status: 'unknown', reason: "The walk-away package breaks one of Nick's hard rules, so it is not shown." } : waRaw;
      const E = await engine.rescore(L.lg, { partner: t.partner, give, get, rosters: !!req.body?.rosters,
        ...(wa?.status === 'ok' ? { walkGive: wa.value.max_give ?? [], walkGet: JSON.parse(t.get_json) } : {}) });
      if (E.status !== 'ok') {
        return res.json({ ...meta(L.flag), status: E.status, reason: previewed(L.flag, E.reason), ...(E.build_ms != null ? { build_ms: E.build_ms } : {}) });
      }
      if (E.problems.length) return res.status(422).json({ error: E.problems[0], problems: E.problems });
      const { scored } = E;
      // The walk-away line: the package he'd get at your walk-away, on the same screen.
      const screen = E.walk_screen;
      const walk_away = wa?.status !== 'ok'
        ? { status: wa?.status === 'failed' ? 'failed' : 'unknown', source: 'clone.price', reason: wa?.reason ?? 'No walk-away was priced for this step.' }
        : Number.isFinite(screen)
          ? { status: 'ok', source: 'clone.price', value: screen, unit: 'percent', text: wa.value.text }
          : { status: 'unknown', source: 'clone.price', reason: 'The walk-away package has no market value to place on his screen.' };
      addNames(t.id, E.labels);
      res.json({
        ...meta(L.flag), status: 'ok', partner: t.partner, give, get, names: E.labels,
        ms: scored.ms, build_ms: E.build_ms, runs: scored.runs, axis: E.axis,
        nick: scored.nick, his: scored.his, walk_away, dropped_by_rule: waBreaks ? 1 : 0,
        ...(E.rosters ? { rosters: E.rosters } : {})
      });
    } catch (e) { next(e); }
  });

  return r;
}

export default negotiateRouter();
