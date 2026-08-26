import { api } from '../api';

/**
 * Client-side contract for ESPN live-draft discovery and setup (Phase 3A).
 *
 * These endpoints are owned by the server team; this file is the single place the
 * client depends on their shape, so a contract change only has to be reconciled here.
 *
 *   GET  /leagues + GET /drafts/live/discovery?league_row_id=:id
 *   POST /drafts/live/link (existing)    -> { draft_id, created, sync }
 */

export type DraftStatus = 'scheduled' | 'active' | 'completed';

export interface DraftFixture {
  league_row_id: number;
  league_id: string;
  season: number;
  name: string;
  status: DraftStatus;
  scheduled_at: string | null;
  team_count: number;
  rounds: number;
  draft_type: string;
  pick_seconds: number;
  roster_positions: Record<string, number>;
  my_team: { espn_team_id: number; name: string } | null;
  my_slot: number | null;
  pick_order: number[] | null;
  ownership_confirmed: boolean;
  local_draft_id: number | null;
}

export function discoverLiveDrafts(): Promise<DraftFixture[]> {
  return api<Array<{ id: number; platform: string }>>('/leagues').then(leagues =>
    Promise.all(leagues
      .filter(league => league.platform === 'espn')
      .map(league => api<DraftFixture>(`/drafts/live/discovery?league_row_id=${league.id}`)))
  );
}

/** Idempotent: starts a fresh draft or resumes the existing one for this league+season. */
export function startOrResumeLiveDraft(leagueRowId: number, confirmedTeamId?: number): Promise<{ draft_id: number; created: boolean; sync: any }> {
  return api('/drafts/live/link', {
    method: 'POST',
    body: JSON.stringify({
      league_row_id: leagueRowId,
      ...(confirmedTeamId == null ? {} : { confirmed_team_id: confirmedTeamId })
    })
  });
}
