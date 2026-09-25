/**
 * WAR-ROOM-UI v2, TODAY screen: the WATCHING list and the season-progress facts, picked
 * from fields the view already serves. Nothing is computed; items are chosen and ordered
 * (red, then amber, then grey) and the list stops at five.
 *
 * Sources: open negotiation threads and their countdown phase (the negotiations read),
 * the number audit's broken / warn checks (`number_health`), the brain report's blocks
 * (`brain_report.blocks`), the next move's send-when when it says to wait, and the
 * trade-deadline line of `catch_up`. Injuries are not in the plans contract, so they are
 * not listed here.
 */
import type { WarRoomView } from './types';
import { teamLabel } from './types';
import type { Negotiations } from './negotiateModel';
import { isOk } from './format';

export type WatchTone = 'red' | 'amber' | 'grey';
export interface WatchItem { id: string; tone: WatchTone; text: string; detail?: string }
export const WATCH_MAX = 5;

const RANK: Record<WatchTone, number> = { red: 0, amber: 1, grey: 2 };

export function watchItems(view: WarRoomView, negotiations?: Negotiations | null): WatchItem[] {
  const out: WatchItem[] = [];
  for (const t of negotiations?.enabled ? negotiations.threads ?? [] : []) {
    if (t.status !== 'open') continue;
    const who = teamLabel(t.partner);
    const phase = t.countdown?.phase;
    if (phase === 'move_on') out.push({ id: `thread-${t.id}`, tone: 'red', text: `Move on from ${who}`, detail: 'No reply past his slow time.' });
    else if (phase === 'follow_up') out.push({ id: `thread-${t.id}`, tone: 'amber', text: `Follow up with ${who}`, detail: 'Past his usual reply time.' });
    else out.push({ id: `thread-${t.id}`, tone: 'grey', text: `Waiting on ${who}`, detail: t.countdown?.follow_up_at ? `Follow up after ${new Date(t.countdown.follow_up_at).toLocaleString()}.` : undefined });
  }
  const health = isOk(view.number_health) ? view.number_health.value : null;
  for (const c of health?.checks ?? []) {
    if (c.status === 'broken') out.push({ id: `num-${c.check_id}`, tone: 'red', text: c.title, detail: c.detail });
    else if (c.status === 'warn') out.push({ id: `num-${c.check_id}`, tone: 'amber', text: c.title, detail: c.detail });
  }
  const brain = isOk(view.brain_report) ? view.brain_report.value : null;
  for (const [i, b] of (brain?.blocks ?? []).entries()) out.push({ id: `brain-${i}`, tone: 'amber', text: b });
  const next = isOk(view.next_move) ? view.next_move.value.steps[0]?.send_when : undefined;
  if (next && isOk(next) && /^Wait\b/.test(next.value)) out.push({ id: 'send-when', tone: 'amber', text: next.value });
  const deadline = isOk(view.catch_up) ? view.catch_up.value.find(c => /deadline/i.test(c.text)) : undefined;
  if (deadline) out.push({ id: 'deadline', tone: 'grey', text: deadline.text });
  return out.map((x, i) => ({ x, i })).sort((a, b) => RANK[a.x.tone] - RANK[b.x.tone] || a.i - b.i).map(({ x }) => x).slice(0, WATCH_MAX);
}

/** Stops done and left, as the itinerary lists them (counts only). */
export function stopCounts(view: WarRoomView): { done: number; left: number } | null {
  if (!isOk(view.itinerary)) return null;
  const it = view.itinerary.value;
  return { done: it.stops.filter(s => s.status === 'done').length, left: it.stops_left };
}
