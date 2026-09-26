import { useEffect, useMemo } from 'react';
import { useApi } from '../../api';
import type { WarRoomView } from './types';
import type { Negotiations } from './negotiateModel';
import type { HisScreenData } from './HisScreen';

/**
 * The only fetch for the War Room (WAR-ROOM-UI.md 2.1). When the engine view lands
 * (EA-03) this becomes useEngineView('war_room', leagueId): a one-file switch.
 */
export function useWarRoom(leagueId: number | null) {
  return useApi<WarRoomView>(leagueId ? `/trades/${leagueId}/war-room` : null);
}

/** AJ-PICK: the players Nick would take for A.J. Brown (aj.allow), and the A.J. cards he OK'd. */
export interface AjState { enabled: boolean; status?: string; allow?: string[]; confirmed?: string[] }
export function useAjState(leagueId: number | null) {
  return useApi<AjState>(leagueId ? `/warroom/${leagueId}/aj` : null);
}

/** Negotiation mode's read: this league's open threads (NEGOTIATE-UI). */
export function useNegotiations(leagueId: number | null) {
  return useApi<Negotiations>(leagueId ? `/warroom/${leagueId}/negotiations` : null);
}

/** HIS-SCREEN: one offer as the partner sees it (hisScreenPath), for the deck card's toggle and TradeCard. */
export function useHisScreen(path: string | null) {
  return useApi<HisScreenData>(path);
}

/**
 * WAR-ROOM-UI v2: player pictures. The plans contract carries app player ids only, so the
 * page reads the app's existing player list (GET /api/players, read-only, unchanged) once
 * and keeps id -> headshot. Presentation only; nothing about a trade is read from it.
 */
export function usePlayerHeadshots() {
  return useApi<{ id: number | string; headshot?: string | null }[]>('/players');
}

/** How long a failed player-list read waits before it asks again (a cold server, a 429). */
export const HEADSHOT_RETRY_MS = 4000;

/**
 * id -> ESPN headshot for every mount (Today, Trades). ESPN pictures only; a team defence
 * (negative id) gets none. A failed read is retried a few times instead of leaving initials
 * for the rest of the visit: the live app showed initials after a restart while the list
 * was briefly unavailable.
 */
export function useHeadshotMap(retryMs = HEADSHOT_RETRY_MS): Record<string, string> {
  const players = usePlayerHeadshots();
  const { error, refetch } = players as typeof players & { error?: string | null; refetch?: () => unknown };
  useEffect(() => {
    if (!error || !refetch) return;
    const t = setTimeout(() => { void refetch(); }, retryMs);
    return () => clearTimeout(t);
  }, [error, refetch, retryMs]);
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of players.data ?? []) if (p.headshot && p.headshot.startsWith('https://a.espncdn.com/') && !/\/-\d+\.png$/.test(p.headshot)) out[String(p.id)] = p.headshot;
    return out;
  }, [players.data]);
}
