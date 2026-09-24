/**
 * Negotiation mode (WAR-ROOM-UI.md v3, new mode 1): the shapes the server sends
 * (server/routes/warroom-negotiate.js) and the pure pieces Negotiate.tsx draws with.
 * The server computes every number; these place them on the slider, count time down,
 * and hold the package Nick is editing. Nothing here prices a deal.
 */
import type { Field, Num, Reply, ReplyKind } from './types';

export interface Countdown {
  phase: 'waiting' | 'follow_up' | 'move_on' | 'answered';
  from: string;
  follow_up_at: string;
  move_on_at: string;
  typical_min: number | null;
  slow_min: number | null;
  source: string;
  n: number;
  guess: boolean;
  basis: string;
  reason?: string;
}

export interface ThreadEvent {
  kind: 'reply' | 'counter_sent' | 'follow_up';
  reply: ReplyKind | null;
  give: string[] | null;
  get: string[] | null;
  note: string | null;
  at: string;
}

export interface Thread {
  id: number;
  league_id: number;
  move_id: string;
  step_index: number;
  partner: string;
  give: string[];
  get: string[];
  names: Record<string, string>;
  /** trade_outcomes.sent_at, the one "I sent it" store; null once taken back. */
  sent_at: string | null;
  status: 'open' | 'closed';
  closed_reason: 'accepted' | 'declined' | 'walked_away' | 'undone' | null;
  undo_until: string | null;
  can_undo: boolean;
  step: {
    p_yes: Num;
    p_yes_band: { low: number; high: number } | null;
    title_odds_delta: Num;
    title_after: Num;
    message: Field<string>;
    walk_away: Field<{ text: string; max_give: string[] }>;
  };
  branches: { kind: ReplyKind; label: string; plan: Field<Reply>; live: boolean }[];
  events: ThreadEvent[];
  countdown: Countdown | null;
}

export interface Negotiations { enabled: boolean; preview?: boolean; preview_reason?: string; threads?: Thread[] }
export interface ThreadResponse { enabled: boolean; preview?: boolean; preview_reason?: string; thread?: Thread }

export interface RosterPlayer { id: string; label: string; value: number }
export type Pct = Field<number> & { unit?: string; basis?: string; text?: string; band?: { low: number; high: number } };

export interface Rescore {
  enabled: boolean;
  /** 'building': the server's worker is still building this league's world; ask again shortly. */
  status: 'ok' | 'failed' | 'building';
  reason?: string;
  partner?: string;
  give?: string[];
  get?: string[];
  names?: Record<string, string>;
  ms?: number;
  build_ms?: number;
  runs?: number | null;
  axis?: { low: number; high: number };
  nick?: { title_before: Num; title_after: Num; title_odds_delta: Num };
  his?: { screen: Pct; yes_point: Pct; p_yes: Pct };
  walk_away?: Pct;
  rosters?: { mine: RosterPlayer[]; his: RosterPlayer[] };
}

/** Where a screen % sits on the slider, 0-100 (clamped; `off` when outside the axis). */
export function slot(v: number, axis: { low: number; high: number }): { left: number; off: boolean } {
  const span = axis.high - axis.low || 1;
  const raw = ((v - axis.low) / span) * 100;
  return { left: Math.max(0, Math.min(100, raw)), off: raw < 0 || raw > 100 };
}

/** "+12%" / "-8%" on his screen. */
export const screen = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;

/** Minutes as "45 min", "3 h 10 min", "2 d 4 h". */
export function span(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return `${d} d${h ? ` ${h} h` : ''}`;
}

/** Minutes from `now` (ms) until an ISO time; negative once it has passed. */
export const minutesUntil = (iso: string, now: number) => (Date.parse(iso) - now) / 60_000;

/** The countdown line for the thread's current phase. */
export function countdownText(c: Countdown, now: number): string {
  if (c.phase === 'answered') return 'He answered. The clock is stopped.';
  const toFollow = minutesUntil(c.follow_up_at, now), toMove = minutesUntil(c.move_on_at, now);
  if (toFollow > 0) return `Follow up in ${span(toFollow)} if he has not answered`;
  if (toMove > 0) return `Follow up now. Move on in ${span(toMove)}`;
  return `Move on: ${span(-toMove)} past his window`;
}

/** Share of the waiting window gone, 0-1, for the countdown bar. */
export function elapsed(c: Countdown, now: number): number {
  const a = Date.parse(c.from), b = Date.parse(c.move_on_at);
  return b > a ? Math.max(0, Math.min(1, (now - a) / (b - a))) : 1;
}

/* ------------------------------------------------------ the counter package */

export interface Pkg { give: string[]; get: string[] }
export type PkgAction =
  | { type: 'toggle'; side: 'give' | 'get'; id: string }
  | { type: 'set'; pkg: Pkg };

export const MAX_SIDE = 4;

export function pkgReducer(p: Pkg, a: PkgAction): Pkg {
  if (a.type === 'set') return { give: [...a.pkg.give], get: [...a.pkg.get] };
  const list = p[a.side];
  const has = list.includes(a.id);
  if (!has && list.length >= MAX_SIDE) return p;
  // Never empty a side: a package needs at least one player each way.
  if (has && list.length === 1) return p;
  return { ...p, [a.side]: has ? list.filter(x => x !== a.id) : [...list, a.id] };
}

export const pkgKey = (p: Pkg) => `${[...p.give].sort().join(',')}>${[...p.get].sort().join(',')}`;
export const samePkg = (a: Pkg, b: Pkg) => pkgKey(a) === pkgKey(b);
