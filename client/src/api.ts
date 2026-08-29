import { useCallback, useEffect, useRef, useState } from 'react';

let localSessionPromise: Promise<string | null> | null = null;

async function provisionLocalSession() {
  if (typeof window === 'undefined') return null;
  if (!localSessionPromise) {
    localSessionPromise = fetch('/api/auth/local-session', { method: 'POST' })
      .then(async res => {
        if (!res.ok) return null;
        const body = await res.json();
        const token = typeof body.token === 'string' ? body.token : null;
        if (token) setAuthToken(token);
        return token;
      })
      .finally(() => { localSessionPromise = null; });
  }
  return localSessionPromise;
}

export async function api<T = any>(path: string, opts?: RequestInit, retried = false): Promise<T> {
  // Self-hosted authentication is provisioned with server/platform/provision-auth.js.
  // Keep the opaque token out of source/config files; callers can persist it once
  // with setAuthToken(), after which every API request authenticates consistently.
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('gridiron_session_token') : null;
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts?.headers
    }
  });
  if (res.status === 401 && !retried && path !== '/auth/local-session') {
    const provisioned = await provisionLocalSession();
    if (provisioned) return api<T>(path, opts, true);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function setAuthToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem('gridiron_session_token', token);
  else window.localStorage.removeItem('gridiron_session_token');
}

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);

  // `loading` only flips while we have nothing to show. Background refetches keep
  // the previous data on screen so views never flash empty mid-update — but only
  // when it's the SAME resource refreshing. If `path` changed to a different
  // resource (e.g. the user switched leagues), the old data belongs to something
  // else now and must not linger under the new path's label.
  const hasData = useRef(false);
  const prevPath = useRef<string | null>(null);
  const requestId = useRef(0);
  const inFlight = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refetch = useCallback(() => {
    if (!path) return;
    if (prevPath.current !== null && prevPath.current !== path) {
      hasData.current = false;
      setData(null);
    }
    prevPath.current = path;
    if (!hasData.current) setLoading(true);
    else setRefreshing(true);
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const id = ++requestId.current;
    inFlight.current++;
    return api<T>(path, { signal: abort.signal })
      .then(d => {
        // Only the newest request may write data — an older response arriving
        // late must not overwrite a newer one.
        if (id !== requestId.current) return;
        hasData.current = true; setData(d); setError(null);
      })
      .catch(e => {
        if (e?.name !== 'AbortError' && id === requestId.current) setError(e.message);
      })
      .finally(() => {
        inFlight.current = Math.max(0, inFlight.current - 1);
        // Clearing `loading` is a DIFFERENT question from who may write data, and
        // conflating the two is what left pages spinning forever with a 200 in
        // the network tab. React's StrictMode mounts, cleans up, and mounts
        // again; the cleanup aborts the first request, so whether the surviving
        // response still matches `requestId` depends on a race. Loading is now
        // tied to whether anything is still in flight, which is what the flag
        // actually means, and to whether data has arrived by any route.
        if (inFlight.current === 0 || hasData.current) {
          setLoading(false); setRefreshing(false);
        }
      });
  }, [path]);

  useEffect(() => {
    refetch();
    return () => controller.current?.abort();
  }, [refetch]);
  return { data, loading, refreshing, error, refetch };
}

/** Headshot URL from whichever platform id we have. */
export function headshotUrl(p: { espn_id?: number | null; sleeper_id?: string | null }) {
  if (p.espn_id) return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.espn_id}.png`;
  if (p.sleeper_id) return `https://sleepercdn.com/content/nfl/players/${p.sleeper_id}.jpg`;
  return null;
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
  // Server-authoritative state machine fields — see server/draft/store.js.
  revision: number;
  order_type: 'snake' | 'linear' | 'third_round_reversal';
  roster_positions: Record<string, number>;
  turn_deadline: string | null;
  paused: 0 | 1;
  queue: { player_id: number; position: number }[];
  total_picks: number;
  on_the_clock: { pick_number: number; round: number; pos_in_round: number; team_slot: number } | null;
}

export interface DraftPick {
  pick_number: number; team_slot: number; player_id: number;
  name: string; position: string; team_abbr: string | null; primary_color?: string;
  espn_id?: number | null; sleeper_id?: string | null;
  projected_points?: number | null; projected_pos_rank?: number | null;
}

export interface AvailableEntry {
  rank: number; tier: number; note: string | null; player_id: number;
  name: string; position: string; team_abbr: string | null; primary_color?: string;
  espn_id?: number | null; sleeper_id?: string | null;
  projected_points?: number | null;
  projected_pos_rank?: number | null;
  last_season_points?: number | null;
}
