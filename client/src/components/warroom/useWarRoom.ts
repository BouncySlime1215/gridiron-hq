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
