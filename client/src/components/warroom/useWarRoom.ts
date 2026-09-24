import { useApi } from '../../api';
import type { ClonesView, WarRoomView } from './types';

/**
 * The only fetches for the War Room (WAR-ROOM-UI.md 2.1). When the engine view lands
 * (EA-03) these become useEngineView('war_room' | 'clones', leagueId): a one-file switch.
 */
export function useWarRoom(leagueId: number | null) {
  return useApi<WarRoomView>(leagueId ? `/trades/${leagueId}/war-room` : null);
}

/** UI-ENG-4: one row per league-mate. Pass null until the War Room says it is enabled. */
export function useWarRoomClones(leagueId: number | null) {
  return useApi<ClonesView>(leagueId ? `/trades/${leagueId}/war-room/clones` : null);
}
