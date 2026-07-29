import { useCallback, useEffect, useState } from 'react';

export async function api<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    if (!path) return;
    setLoading(true);
    api<T>(path)
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => { refetch(); }, [refetch]);
  return { data, loading, error, refetch };
}

export interface Team {
  id: number; abbr: string; name: string; conference: string; division: string;
  head_coach: string; oc_name?: string; dc_name?: string;
  off_scheme: string; off_scheme_detail?: string;
  def_scheme: string; def_scheme_detail?: string;
  ol_analysis?: string; dl_analysis?: string; lb_analysis?: string;
  secondary_analysis?: string; st_analysis?: string; coach_analysis?: string;
  primary_color: string; secondary_color: string;
  players?: Player[];
}

export interface Player {
  id: number; name: string; position: string; team_id: number | null;
  depth_rank: number; slot_code: string | null; phase: string;
  team_abbr?: string;
}

export interface RankingEntry {
  id?: number; player_id: number; rank: number; tier: number; note: string | null;
  name: string; position: string; team_abbr: string | null; primary_color?: string;
}

export interface Draft {
  id: number; name: string; type: string; team_count: number; rounds: number;
  my_slot: number; ranking_set_id: number | null; status: string;
  picks_made?: number; ranking_set_name?: string;
  picks: DraftPick[]; available: AvailableEntry[];
}

export interface DraftPick {
  pick_number: number; team_slot: number; player_id: number;
  name: string; position: string; team_abbr: string | null; primary_color?: string;
}

export interface AvailableEntry {
  rank: number; tier: number; note: string | null; player_id: number;
  name: string; position: string; team_abbr: string | null; primary_color?: string;
}
