import { useApi } from '../../api';
import type { NewsStory } from './NewsHub';

/** Raw shape of a row from GET /api/news (server/routes/news.js, `SELECT n.*`). */
interface RawNewsItem {
  id: number; date: string; headline: string; body: string | null;
  ai_analysis: string | null; fantasy_impact: string | null; importance: number;
  source: string | null; source_url: string | null; source_type: string | null;
  author: string | null; published_at: string | null; canonical_url: string | null;
  entities_json: string | null; reliability_json: string | null; confidence: number | null;
}

function parseJsonSafe<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function mapNewsItem(raw: RawNewsItem): NewsStory {
  return {
    id: raw.id,
    headline: raw.headline,
    summary: raw.body,
    // Ingested rows are always attributed by server/news/ingest.js; only
    // legacy/manual rows created before that wiring can lack a real source.
    source: raw.source ?? 'Unattributed (legacy entry)',
    source_url: raw.source_url ?? raw.canonical_url ?? '#',
    source_type: raw.source_type ?? 'unattributed',
    published_at: raw.published_at ?? raw.date,
    canonical_url: raw.canonical_url ?? raw.source_url ?? '#',
    fantasy_impact: raw.fantasy_impact ?? undefined,
    confidence: raw.confidence,
    reliability: parseJsonSafe(raw.reliability_json, undefined),
    entities: parseJsonSafe(raw.entities_json, undefined),
    ai_analysis: raw.ai_analysis
  };
}

/** Reads the live, normalized News Hub feed — never falls back to fixtures. */
export function useNewsFeed() {
  const { data, loading, error, refetch } = useApi<RawNewsItem[]>('/news');
  return {
    stories: (data ?? []).map(mapNewsItem),
    loading, error,
    refreshedAt: data ? new Date().toISOString() : null,
    refetch
  };
}
