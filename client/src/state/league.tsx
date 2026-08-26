import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../api';

/**
 * Which of the user's connected leagues is "active" right now, shared across every
 * page. Before this, Trade Lab kept its own league dropdown, the Prediction Engine
 * silently always used the first league, and My Team didn't support multiple leagues
 * at all — so switching leagues meant re-picking it on every page, or not being able
 * to at all. One picker in the header now drives all of them.
 */

interface League {
  id: number;
  platform: 'espn' | 'sleeper';
  league_id: string;
  season: number;
  name: string | null;
  my_team_id: string | null;
  team_count: number | null;
  connection_status?: 'connected' | 'needs_reconnect' | 'sync_failed';
  sync_error?: string | null;
  [key: string]: any;
}

interface LeagueContextValue {
  leagues: League[];
  loading: boolean;
  // Was silently absent before — every page reading `leagues.length === 0` on a
  // failed fetch (network down, server error) looked identical to "genuinely no
  // leagues connected yet," with no way for a page to tell the two apart.
  error: string | null;
  activeId: number | null;
  active: League | null;
  setActiveId: (id: number | null) => void;
  refetch: () => void;
}

const STORAGE_KEY = 'gh:activeLeague';
const LeagueContext = createContext<LeagueContextValue | null>(null);

export function LeagueProvider({ children }: { children: ReactNode }) {
  const { data: leagues, loading, error, refetch } = useApi<League[]>('/leagues');
  const [activeId, setActiveIdState] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  // Once the league list is in, make sure activeId points at something real. Covers
  // first load (nothing stored yet) and a stored id that no longer exists (that league
  // was removed on another visit) by falling back to the first connected league.
  useEffect(() => {
    if (!leagues) return;
    if (activeId != null && leagues.some(l => l.id === activeId)) return;
    setActiveIdState(leagues[0]?.id ?? null);
  }, [leagues]); // eslint-disable-line react-hooks/exhaustive-deps

  const setActiveId = (id: number | null) => {
    setActiveIdState(id);
    if (id == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(id));
  };

  const active = useMemo(() => leagues?.find(l => l.id === activeId) ?? null, [leagues, activeId]);

  const value: LeagueContextValue = {
    leagues: leagues ?? [], loading, error, activeId, active, setActiveId, refetch
  };
  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeague() {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error('useLeague() must be called inside a <LeagueProvider>');
  return ctx;
}
