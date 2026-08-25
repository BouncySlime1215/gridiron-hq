import { useApi } from '../../api';
import type { NewsStory } from './NewsHub';

/** Raw shape of a row from GET /api/news (server/routes/news.js, `SELECT n.*`). */
interface RawNewsItem {
  id: number; date: string; headline: string; body: string | null;
  ai_analysis: string | null; fantasy_impact: string | null; importance: number;
  source: string | null; source_url: string | null; source_type: string | null;
  author: string | null; published_at: string | null; canonical_url: string | null;
  entities_json: string | null; reliability_json: string | null; confidence: number | null;
  injury_entities_json: string | null; transaction_type: string | null;
  ingested_at: string | null; updated_at: string | null;
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
    injury_entities: parseJsonSafe(raw.injury_entities_json, []),
    transaction_type: raw.transaction_type ?? null,
    ingested_at: raw.ingested_at ?? raw.updated_at ?? raw.published_at ?? raw.date,
    ai_analysis: raw.ai_analysis
  };
}

/** Reads the live, normalized News Hub feed — never falls back to fixtures. */
export function useNewsFeed() {
  const { data, loading, error, refetch } = useApi<RawNewsItem[]>('/news');
  // Requires an authenticated session (server/routes/news.js's /my-players); an
  // anonymous viewer simply gets no "My Players" matches rather than an error
  // that would block the rest of the feed.
  const { data: myPlayers } = useApi<{ names: string[] }>('/news/my-players');
  const stories = (data ?? []).map(mapNewsItem);
  // Freshness is when the data was actually ingested/updated server-side, not
  // when this component happened to render — otherwise stale stored reporting
  // reads as freshly updated every time the page loads.
  const refreshedAt = stories.length
    ? stories.reduce<string | null>((latest, story) => {
        const at = story.ingested_at;
        return at && (!latest || at > latest) ? at : latest;
      }, null)
    : null;
  return { stories, loading, error, refreshedAt, myPlayerNames: myPlayers?.names ?? [], refetch };
}
