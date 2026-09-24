import { useApi } from '../../api';
import type { SelfView, WarRoomView } from './types';

/**
 * The only fetch for the War Room (WAR-ROOM-UI.md 2.1). When the engine view lands
 * (EA-03) this becomes useEngineView('war_room', leagueId): a one-file switch.
 */
export function useWarRoom(leagueId: number | null) {
  return useApi<WarRoomView>(leagueId ? `/trades/${leagueId}/war-room` : null);
}

/** SELF-01b: the follow / ignore card. Pass null until the War Room says it is enabled. */
export function useWarRoomSelf(leagueId: number | null) {
  return useApi<SelfView>(leagueId ? `/trades/${leagueId}/war-room/self` : null);
}
