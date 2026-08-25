import { createHash } from 'node:crypto';

const TRACKING = /^(utm_[^=]+|fbclid|gclid)$/i;
export function canonicalUrl(input) {
  const url = new URL(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([key]) => {
    const values = url.searchParams.getAll(key); url.searchParams.delete(key); values.forEach(value => url.searchParams.append(key, value));
  });
  return url.toString();
}

const normalizedHeadline = value => value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function extractEntities(text, identity = { players: [], teams: [] }) {
  const haystack = ` ${normalizedHeadline(text)} `;
  const match = entries => entries.filter(entity => (entity.aliases ?? [entity.name, entity.abbr]).filter(Boolean)
    .some(alias => haystack.includes(` ${normalizedHeadline(alias)} `)))
    .map(entity => ({ id: entity.id, name: entity.name, confidence: 1, method: 'alias_exact' }));
  return { players: match(identity.players ?? []), teams: match(identity.teams ?? []) };
}

export function normalizeNewsItem(raw, { identity, ingestedAt = new Date().toISOString(), classificationVersion = 'rules@1' } = {}) {
  if (!raw.source || !raw.source_url || !raw.headline || !raw.published_at) {
    throw new Error('news requires source, source_url, headline, and published_at');
  }
  if (raw.source.toLowerCase() === 'ai analysis') throw new Error('AI analysis is not a valid reporting source');
  const url = canonicalUrl(raw.canonical_url ?? raw.source_url);
  const entities = extractEntities(`${raw.headline} ${raw.summary ?? ''}`, identity);
  return {
    source: raw.source, source_url: raw.source_url, source_type: raw.source_type ?? 'publisher', author: raw.author ?? null,
    published_at: new Date(raw.published_at).toISOString(), ingested_at: ingestedAt,
    updated_at: new Date(raw.updated_at ?? raw.published_at).toISOString(), headline: raw.headline.trim(),
    summary: raw.summary ?? null, canonical_url: url, entities,
    injury_entities: raw.injury_entities ?? [], transaction_type: raw.transaction_type ?? null,
    reliability: raw.reliability ?? { tier: 'unrated', score: null },
    // Keyed on the canonical URL alone (matching clusterNews' notion of "same
    // story") so a publisher correcting a headline updates the existing row via
    // store.js's ON CONFLICT(duplicate_group_id) path instead of forking a
    // second, stale-headline row for the same URL.
    duplicate_group_id: digest(url),
    user_relevance: raw.user_relevance ?? null, fantasy_impact: raw.fantasy_impact ?? 'unclassified',
    confidence: raw.confidence ?? null, classification_version: classificationVersion,
    attribution_required: true
  };
}

export function clusterNews(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.canonical_url ?? canonicalUrl(item.source_url);
    const group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    id: digest(group[0].canonical_url ?? group[0].source_url),
    preferred: [...group].sort((a, b) => Number(b.source_type === 'official') - Number(a.source_type === 'official') || Date.parse(a.published_at) - Date.parse(b.published_at))[0],
    stories: group
  }));
}

