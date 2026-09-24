import { useApi } from '../../api';
import type { WarRoomView } from './types';

/**
 * The only fetch for the War Room (WAR-ROOM-UI.md 2.1). When the engine view lands
 * (EA-03) this becomes useEngineView('war_room', leagueId): a one-file switch.
 */
export function useWarRoom(leagueId: number | null) {
  return useApi<WarRoomView>(leagueId ? `/trades/${leagueId}/war-room` : null);
}

/** SELF-01b: RED stub. */
export function useWarRoomSelf(_leagueId: number | null) {
  return useApi<unknown>(null);
}
