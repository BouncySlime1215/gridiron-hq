import { createHash } from 'node:crypto';
import { zonedDateTime } from '../services/date-util.js';

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

/**
 * A team's bare abbreviation folds to plain English once lower-cased --
 * "WAS" reads the same as the word "was", "NO" the same as "no" -- which
 * was misattributing every story that merely used either common word to
 * whichever team happens to own that abbreviation (measured against real
 * ingested stories: 192 of the 298 items tagged WAS or NO carried no actual
 * mention of Washington/Commanders or New Orleans/Saints anywhere in their
 * text, only the coincidental word). A real abbreviation is written in
 * capitals ("WAS", "NO"), a sentence-case or lower-case "was"/"no" never is
 * (checked against the full corpus: zero genuine capitalized uses of "WAS",
 * one of "NO", and that one *is* a real abbreviation reference). So a bare
 * abbreviation -- the default alias derived from `entity.abbr`, not a
 * caller-supplied custom alias -- is matched against the ORIGINAL, case-
 * preserved text and must appear in that exact upper-case spelling; a
 * team's full name, and any explicit alias a caller supplies, still match
 * case-insensitively exactly as before.
 */
export function extractEntities(text, identity = { players: [], teams: [] }) {
  const haystack = ` ${normalizedHeadline(text)} `;
  const casedHaystack = ` ${String(text).replace(/[^A-Za-z0-9]+/g, ' ').trim()} `;
  const matches = (entity, alias, isBareAbbreviation) => isBareAbbreviation
    ? casedHaystack.includes(` ${alias} `)
    : haystack.includes(` ${normalizedHeadline(alias)} `);
  const match = entries => entries.filter(entity => (entity.aliases ?? [entity.name, entity.abbr]).filter(Boolean)
    .some(alias => matches(entity, alias, !entity.aliases && alias === entity.abbr)))
    .map(entity => ({ id: entity.id, name: entity.name, confidence: 1, method: 'alias_exact' }));
  return { players: match(identity.players ?? []), teams: match(identity.teams ?? []) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// An RFC 822 date carrying an Eastern zone letter: "Tue, 22 Sep 2026 15:15:32 EST".
const EASTERN_RFC822 = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+E[SD]T$/i;
const pad2 = value => String(value).padStart(2, '0');

/**
 * A feed timestamp as a UTC ISO string.
 *
 * ESPN's RSS feed labels US Eastern *daylight* wall time "EST". JavaScript
 * reads "EST" as the fixed offset -05:00, so every stamp from March to
 * November landed one hour late, and a story fetched within the hour was
 * stored as published after we fetched it (164 of 196 RSS rows on the local
 * copy, 2026-09-22; proof: the same response's <lastBuildDate> in GMT is 51
 * minutes *before* its newest item read literally, 8 minutes after it read as
 * Eastern daylight -- docs/tdd/2026-09-22-news-published-at-timezone.tdd.md).
 *
 * So an EST/EDT label is read as Eastern wall time through the shared
 * zonedDateTime, which supplies the real offset for that date. The letter
 * itself is ignored because the publisher's letter is the part that is wrong.
 * In the repeated autumn hour this resolves to the earlier instant, which can
 * be an hour early but never stamps the future. Every other spelling (GMT,
 * numeric offsets, ISO, the other US zones) keeps the plain Date reading, and
 * an unparseable or impossible date throws RangeError rather than storing a
 * made-up time.
 */
function parsePublishedAt(value) {
  const text = String(value ?? '').trim();
  const eastern = EASTERN_RFC822.exec(text);
  if (!eastern) return new Date(text).toISOString();
  const month = MONTHS.indexOf(eastern[2].toLowerCase()) + 1;
  const at = month ? zonedDateTime(`${eastern[3]}-${pad2(month)}-${pad2(eastern[1])}`,
    `${eastern[4]}:${eastern[5]}:${eastern[6] ?? '00'}`, 'America/New_York') : null;
  if (!at) throw new RangeError(`published_at is not a real Eastern time: ${text}`);
  return at.toISOString();
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
    published_at: parsePublishedAt(raw.published_at), ingested_at: ingestedAt,
    updated_at: parsePublishedAt(raw.updated_at ?? raw.published_at), headline: raw.headline.trim(),
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

