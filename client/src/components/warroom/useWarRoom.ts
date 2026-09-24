import { useApi } from '../../api';
import type { WarRoomView } from './types';
import type { Negotiations } from './negotiate';

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
