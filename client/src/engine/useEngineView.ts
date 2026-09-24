import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The one fetcher of engine numbers on the client (ENGINE-ARCHITECTURE.md §2.12, §3.5;
 * EA-03 row; UI-ENG-6). A page reads /api/engine/snapshot once per load (SnapshotProvider)
 * and every view on the page at that snapshot id, so two panels on one page cannot show
 * two cuts of the engine. A new id from the 60 s poll moves every view together.
 *
 * Components render rows as served: value, typed status, producer@version, reason chain.
 * They do no arithmetic on engine values beyond formatting.
 */

export type EngineStatusWord = 'ok' | 'zero' | 'unknown' | 'stale' | 'fallback' | 'thin' | 'degraded' | 'last_good';

export interface ReasonContribution {
  source: string;
  kind: string;
  event_ids: number[];
  state_ids: number[];
  delta: number | null;
  weight: number | null;
  text: string;
}
export interface ReasonChainV2 {
  v: number;
  additive: boolean;
  space: string | null;
  baseline: { value: unknown; source: string; text: string } | null;
  contributions: ReasonContribution[];
  residual: number | null;
  n: number | null;
}

export interface EngineRow {
  entity_type: string;
  entity_id: string;
  league_id: number;
  field: string;
  status: EngineStatusWord | string;
  reason: string | null;
  value: any;
  fallback_used: boolean;
  fallback_field: string | null;
  age_min?: number | null;
  producer: string | null;
  producer_version: string | null;
  as_of: string | null;
  health: { status?: string; inputs_health?: string } | null;
  reason_chain: ReasonChainV2 | null;
  fresh_at: string | null;
  state_id: number | null;
}

export interface EngineSnapshot {
  id: number;
  league_id: number;
  age_sec: number;
  created_at?: string;
  cut?: { max_event_id: number; max_state_id: number };
  version_set?: Record<string, string>;
  fallback_set?: Record<string, string>;
  season?: number | null;
  nfl_week?: number | null;
  world?: string | null;
}
export interface SnapshotResponse {
  status: 'ok' | 'unknown';
  reason?: string | null;
  snapshot: EngineSnapshot | null;
}
export interface EngineView {
  view: string;
  snapshot_id: number | null;
  league_id?: number | null;
  rows: EngineRow[];
  status?: 'unknown';
  reason?: string | null;
}

export interface EngineStatusReport {
  now?: string;
  daemon: { status: string; reason?: string | null; age_sec: number | null; last_beat_at?: string | null };
  lock?: { status: string; reason?: string | null };
  sources?: { source: string; watermark: string | null; updated_at: string }[];
  producers: {
    producer: string;
    version: string;
    status: string;
    last_run_at?: string | null;
    fallbacks: { field: string; fallback_field: string; league_id: number; reason: string }[];
  }[];
  snapshots?: { league_id: number; id: number; age_sec: number | null }[];
  jev: { status: string; reason?: string; spend_usd?: number; balance_usd?: number | null };
}

/** The page polls /snapshot this often; a new id refetches every view on the page together. */
export const SNAPSHOT_POLL_MS = 60000;

export type FetchJson = (path: string) => Promise<any>;

const leagueKey = (leagueId?: number | null) => (leagueId == null ? '0' : String(leagueId));
const snapshotPath = (leagueId?: number | null) =>
  leagueId == null ? '/engine/snapshot' : `/engine/snapshot?league_id=${encodeURIComponent(String(leagueId))}`;

/**
 * One client per page load: one /snapshot request per league, one /view request per
 * (view, snapshot id), one /status request. A failed request is forgotten so the next
 * read retries it; its error reaches the caller.
 */
export function createEngineClient(fetchJson: FetchJson) {
  const snapshots = new Map<string, Promise<SnapshotResponse>>();
  const views = new Map<string, Promise<EngineView>>();
  let status: Promise<EngineStatusReport> | null = null;

  function remember<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const known = map.get(key);
    if (known) return known;
    const p = load();
    map.set(key, p);
    p.catch(() => { if (map.get(key) === p) map.delete(key); });
    return p;
  }

  function snapshot(leagueId?: number | null): Promise<SnapshotResponse> {
    return remember(snapshots, leagueKey(leagueId), () => fetchJson(snapshotPath(leagueId)));
  }

  /** Re-read the league's newest snapshot; `changed` says whether its id moved. */
  async function refresh(leagueId?: number | null): Promise<{ changed: boolean; snapshot: SnapshotResponse }> {
    const key = leagueKey(leagueId);
    const before = snapshots.get(key);
    const prev = before ? await before.catch(() => null) : null;
    const next: SnapshotResponse = await fetchJson(snapshotPath(leagueId));
    snapshots.set(key, Promise.resolve(next));
    return { changed: (prev?.snapshot?.id ?? null) !== (next.snapshot?.id ?? null), snapshot: next };
  }

  async function view(name: string, leagueId?: number | null): Promise<EngineView> {
    const s = await snapshot(leagueId);
    if (!s.snapshot) {
      return { view: name, snapshot_id: null, rows: [], status: 'unknown', reason: s.reason ?? 'no_snapshot_published' };
    }
    const id = s.snapshot.id;
    const q = new URLSearchParams({ view: name, snapshot_id: String(id) });
    if (leagueId != null) q.set('league_id', String(leagueId));
    return remember(views, `${name}|${leagueKey(leagueId)}|${id}`, () => fetchJson(`/engine/view?${q.toString()}`));
  }

  function engineStatus(): Promise<EngineStatusReport> {
    if (!status) {
      const p: Promise<EngineStatusReport> = fetchJson('/engine/status');
      status = p;
      p.catch(() => { if (status === p) status = null; });
    }
    return status;
  }

  return { snapshot, refresh, view, status: engineStatus };
}

export type EngineClient = ReturnType<typeof createEngineClient>;

/** The page's client and the snapshot ids it has pinned, by league key ('0' = global). */
export interface EngineContextValue {
  client: EngineClient;
  generation: Record<string, number>;
  watch: (leagueId?: number | null) => () => void;
}
export const EngineContext = createContext<EngineContextValue | null>(null);

export function defaultEngineClient(): EngineClient {
  return createEngineClient(path => api(path));
}

interface Loaded<T> { data: T | null; error: string | null; loading: boolean }

function useEngineContext(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngineView needs a SnapshotProvider above it: one snapshot per page');
  return ctx;
}

/** A declared view at the page's snapshot. Rows arrive as served; render them with EngineValue. */
export function useEngineView(view: string, leagueId?: number | null): Loaded<EngineView> {
  const { client, generation, watch } = useEngineContext();
  const gen = generation[leagueKey(leagueId)] ?? 0;
  const [state, setState] = useState<Loaded<EngineView>>({ data: null, error: null, loading: true });
  useEffect(() => watch(leagueId), [watch, leagueId]);
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    client.view(view, leagueId).then(
      data => { if (live) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (live) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }); },
    );
    return () => { live = false; };
  }, [client, view, leagueId, gen]);
  return state;
}

/** The engine's own status (the strip). One request per page. */
export function useEngineStatus(): Loaded<EngineStatusReport> {
  const { client } = useEngineContext();
  const [state, setState] = useState<Loaded<EngineStatusReport>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    client.status().then(
      data => { if (live) setState({ data, error: null, loading: false }); },
      (e: unknown) => { if (live) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }); },
    );
    return () => { live = false; };
  }, [client]);
  return state;
}
