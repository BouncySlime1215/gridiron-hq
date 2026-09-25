/**
 * WR-COACH integration hook: the one thing the War Room dashboard calls.
 *
 *   const coach = useWarRoomCoach({ leagueId, leagues, plans, onLeagueChange });
 *   <CoachDock coach={coach} />
 *   // panels read coach.ui (main slot, layout, filters, sorts, pins, cards,
 *   // deck index, explain highlight, draft text) and call coach.input(...)
 *   // for Nick's own taps ("I sent it", reply, skip reason, approve).
 *
 * `plans` is the league's plans JSON the dashboard already fetched (the
 * WarRoomView or the producer's plans file). This hook never fetches plans
 * and never computes one: trade-off previews are read from
 * plans.stop_tradeoffs, and a missing one says "not computed yet".
 *
 * Writes go to /api/warroom (records only) and questions to /api/coach/ask.
 * Every failure lands in `error` with its cause; nothing is swallowed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
import {
  newSession, dispatch, confirm as confirmPending, cancel as cancelPending, undo as undoLast,
  markRecorded, coachFooter, savedLayoutOf, type CoachSession, type CoachAction, type Outcome
} from './warroomCoach';

export interface CoachMessage {
  who: 'nick' | 'coach';
  text: string;
  outcomes?: Outcome[];
  refusals?: string[];
  footer?: string;
  /** WAR-ROOM-UI v2: the grounded claims with their cites, and the ledger they cite (the route's own). */
  claims?: { text: string; cites: string[]; footer?: boolean }[];
  ledger?: { queries: { id: string; tool?: string | null; tables?: string[]; rows: Record<string, unknown>[] }[];
    derived: { id: string; op?: string; value?: unknown; inputs?: string[]; label?: string }[] };
  /** The question this reply answers. */
  question?: string;
}

interface Options {
  leagueId: number | null;          // the app's league id, for the write routes
  leagues: number[];                // league numbers on the switcher ("league 3")
  plans: any;                       // this league's plans JSON, read only
  onLeagueChange?: (league: number) => void;
}

const LAYOUT_TYPES = new Set(['arrange_layout', 'reset_layout', 'pin_card', 'plug_in', 'undo']);

export function useWarRoomCoach({ leagueId, leagues, plans, onLeagueChange }: Options) {
  const [session, setSession] = useState<CoachSession>(() => newSession());
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const ref = useRef(session);
  ref.current = session;

  const ctx = useCallback(() => ({ leagues, plans }), [leagues, plans]);
  const report = useCallback((what: string) => (e: unknown) => setError(`${what}: ${e instanceof Error ? e.message : String(e)}`), []);

  useEffect(() => {
    let live = true;
    api<{ enabled: boolean; saved?: { layout: any } | null }>('/warroom/layout')
      .then(res => {
        if (!live) return;
        setEnabled(res.enabled);
        if (res.enabled && res.saved?.layout) setSession(newSession(res.saved.layout));
      })
      .catch(report('Could not load your saved layout (using the default)'));
    return () => { live = false; };
  }, [report]);

  const persist = useCallback((next: CoachSession, types: string[]) => {
    if (!types.some(t => LAYOUT_TYPES.has(t))) return;
    api('/warroom/layout', { method: 'PUT', body: JSON.stringify({ layout: savedLayoutOf(next.ui) }) })
      .catch(report('Could not save your layout'));
  }, [report]);

  const logRemote = useCallback((next: CoachSession, count: number) => {
    if (!leagueId) return;
    for (const entry of next.log.slice(0, count).reverse()) {
      api(`/warroom/${leagueId}/action-log`, { method: 'POST', body: JSON.stringify({
        action: entry.action, outcome: entry.outcome, asked: entry.asked, detail: entry.detail }) })
        .catch(report('Could not write the action log'));
    }
  }, [leagueId, report]);

  const commit = useCallback((next: CoachSession, types: string[]) => {
    const before = ref.current;
    const seen = before.log.length ? next.log.indexOf(before.log[0]) : next.log.length;
    const added = seen < 0 ? next.log.length : seen;
    ref.current = next;
    setSession(next);
    logRemote(next, added);
    persist(next, types);
    if (next.ui.league != null && next.ui.league !== before.ui.league) onLeagueChange?.(next.ui.league);
  }, [logRemote, persist, onLeagueChange]);

  const retract = useCallback((requestId: number | null) => {
    if (!requestId || !leagueId) return;
    api(`/warroom/${leagueId}/requests`, { method: 'POST', body: JSON.stringify({ kind: 'retract', payload: { request_id: requestId } }) })
      .catch(report('Could not take back the plan request'));
  }, [leagueId, report]);

  /** Apply one action (from Coach or a button). Unknown actions are refused by the dispatcher. */
  const apply = useCallback((action: unknown, asked: string | null = null): Outcome => {
    const type = (action as CoachAction | null)?.type;
    if (type === 'undo') {
      const { session: next, outcome, retractRequestId } = undoLast(ref.current, ctx(), asked);
      commit(next, ['undo']);
      retract(retractRequestId);
      return outcome;
    }
    const { session: next, outcome } = dispatch(ref.current, action, ctx(), asked);
    commit(next, type ? [type] : []);
    return outcome;
  }, [commit, ctx, retract]);

  const footer = coachFooter(plans, session.ui);

  const say = useCallback((m: CoachMessage) => setMessages(ms => [...ms, m].slice(-60)), []);

  /** Nick taps Confirm on a trade-off preview: record the plan request, then remember its id for undo. */
  const confirm = useCallback(async () => {
    const { session: next, outcome, request } = confirmPending(ref.current, ctx());
    commit(next, []);
    say({ who: 'coach', text: outcome.message, outcomes: [outcome], footer: coachFooter(plans, next.ui).text });
    if (!request || !leagueId) return;
    try {
      const res = await api<{ request: { id: number } }>(`/warroom/${leagueId}/requests`, {
        method: 'POST', body: JSON.stringify({ ...request, source: 'coach', confirmed: true }) });
      const marked = markRecorded(ref.current, res.request.id, next.history.length - 1);
      ref.current = marked;
      setSession(marked);
    } catch (e) { report('The plan change was not recorded')(e); }
  }, [commit, ctx, leagueId, plans, report, say]);

  const cancel = useCallback(() => {
    const { session: next, outcome } = cancelPending(ref.current, ctx());
    commit(next, []);
    say({ who: 'coach', text: outcome.message, footer: coachFooter(plans, next.ui).text });
  }, [commit, ctx, plans, say]);

  const undo = useCallback(() => {
    const outcome = apply({ type: 'undo' });
    say({ who: 'coach', text: outcome.message, outcomes: [outcome], footer: coachFooter(plans, ref.current.ui).text });
  }, [apply, plans, say]);

  /**
   * Nick's own War Room inputs (WR-3): "I sent it", a reply with its one-tap
   * decline reason, a skip reason, approving a target, setting the goal from
   * the strip. Recorded only; the planner reads them.
   */
  const input = useCallback(async (kind: string, payload: Record<string, unknown>) => {
    if (!leagueId) throw new Error('No league is selected.');
    return api<{ request: { id: number; kind: string } }>(`/warroom/${leagueId}/requests`, {
      method: 'POST', body: JSON.stringify({ kind, payload, source: 'nick' }) });
  }, [leagueId]);

  /** Ask Coach. Screen commands come back as actions; the reply always ends with the footer. */
  const ask = useCallback(async (question: string, extra?: { deck_index?: number; move_id?: string }): Promise<CoachMessage | null> => {
    const q = question.trim();
    if (!q) return null;
    say({ who: 'nick', text: q });
    setBusy(true);
    try {
      const res = await api<any>('/coach/ask', { method: 'POST', body: JSON.stringify({
        question: q, league_id: leagueId ?? undefined,
        context: { surface: 'war_room', route: '/trade-brain?view=war-room', league: ref.current.ui.league, ...(extra ?? {}) } }) });
      const outcomes = (Array.isArray(res.actions) ? res.actions : []).map((a: unknown) => apply(a, q));
      const grounded: { text: string; cites: string[]; footer?: boolean }[] = (res.answer?.claims ?? [])
        .map((c: { text: string; cites?: string[]; footer?: boolean }) => ({ text: c.text, cites: Array.isArray(c.cites) ? c.cites : [],
          ...(c.footer === true ? { footer: true } : {}) }));
      const claims: string[] = grounded.map(c => c.text);
      const text = [...claims, ...outcomes.map((o: Outcome) => o.message)].join(' ')
        || (res.answer?.refusals?.length ? '' : 'Nothing changed.');
      const reply: CoachMessage = { who: 'coach', text, outcomes, refusals: res.answer?.refusals ?? [], footer: coachFooter(plans, ref.current.ui).text,
        claims: grounded, ledger: res.ledger ?? undefined, question: q };
      say(reply);
      return reply;
    } catch (e) {
      report('Coach could not answer')(e);
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply, leagueId, plans, report, say]);

  return {
    enabled, session, ui: session.ui, pending: session.pending, log: session.log, messages, busy, error,
    footer, ask, apply, confirm, cancel, undo, input, clearError: () => setError(null)
  };
}

export type WarRoomCoach = ReturnType<typeof useWarRoomCoach>;
