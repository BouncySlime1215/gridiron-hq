import { api } from '../api';

/**
 * Client-side contract for ESPN live-draft discovery and setup (Phase 3A).
 *
 * These endpoints are owned by the server team; this file is the single place the
 * client depends on their shape, so a contract change only has to be reconciled here.
 *
 *   GET  /drafts/live/discover           -> DraftFixture[]
 *   POST /drafts/live/confirm-team       -> { ok: true }
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
  return api<DraftFixture[]>('/drafts/live/discover');
}

export function confirmDraftTeam(leagueRowId: number, espnTeamId: number): Promise<{ ok: true }> {
  return api('/drafts/live/confirm-team', {
    method: 'POST',
    body: JSON.stringify({ league_row_id: leagueRowId, espn_team_id: espnTeamId })
  });
}

/** Idempotent: starts a fresh draft or resumes the existing one for this league+season. */
export function startOrResumeLiveDraft(leagueRowId: number): Promise<{ draft_id: number; created: boolean; sync: any }> {
  return api('/drafts/live/link', { method: 'POST', body: JSON.stringify({ league_row_id: leagueRowId }) });
}
