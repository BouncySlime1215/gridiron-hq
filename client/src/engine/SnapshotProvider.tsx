import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EngineContext, SNAPSHOT_POLL_MS, createEngineClient, defaultEngineClient,
  type EngineClient, type FetchJson,
} from './useEngineView';

/**
 * One engine snapshot per page load (ENGINE-ARCHITECTURE.md §2.12, §3.5; systems M7).
 *
 * Mount once around a page. Every useEngineView under it reads through one client, so
 * the page makes one /snapshot request per league and every view resolves at that id.
 * Every 60 s it re-reads /snapshot for the leagues its views watch; a new id bumps that
 * league's generation and every view of the league refetches together, never one panel
 * ahead of another. A failed poll keeps the current id (the views keep what they show).
 */
export default function SnapshotProvider({ children, fetchJson }: { children: ReactNode; fetchJson?: FetchJson }) {
  const [client] = useState<EngineClient>(() => (fetchJson ? createEngineClient(fetchJson) : defaultEngineClient()));
  const [generation, setGeneration] = useState<Record<string, number>>({});
  const watched = useRef(new Map<string, { leagueId: number | null; count: number }>());

  const watch = useCallback((leagueId?: number | null) => {
    const key = leagueId == null ? '0' : String(leagueId);
    const entry = watched.current.get(key) ?? { leagueId: leagueId ?? null, count: 0 };
    entry.count += 1;
    watched.current.set(key, entry);
    return () => {
      entry.count -= 1;
      if (entry.count <= 0) watched.current.delete(key);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      for (const [key, { leagueId }] of watched.current) {
        client.refresh(leagueId).then(
          r => { if (r.changed) setGeneration(g => ({ ...g, [key]: (g[key] ?? 0) + 1 })); },
          (e: unknown) => { console.warn(`engine snapshot poll failed for league ${key}:`, e); },
        );
      }
    }, SNAPSHOT_POLL_MS);
    return () => clearInterval(timer);
  }, [client]);

  const value = useMemo(() => ({ client, generation, watch }), [client, generation, watch]);
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}
