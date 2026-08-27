import { rows } from '../db/index.js';
import { normalizeNewsItem } from './normalize.js';
import { upsertNormalizedNewsItem } from './store.js';

/**
 * Documented, public syndication feeds only — no scraping of paywalled or
 * restricted pages. ESPN publishes this RSS feed for syndication at
 * https://www.espn.com/espn/rss/index (the NFL news channel used here is one
 * of the feeds listed there), which is a different thing from scraping
 * espn.com's HTML pages.
 */
export const RSS_SOURCES = [
  { name: 'ESPN', url: 'https://www.espn.com/espn/rss/nfl/news', sourceType: 'publisher' }
];

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** RSS/XML text nodes are entity-encoded; undo that so headlines don't render literal "&amp;". */
const decodeXmlEntities = value => value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity) => {
  if (entity[0] === '#') {
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  }
  return NAMED_ENTITIES[entity] ?? whole;
});

const unwrapCdata = value => {
  const match = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value.trim());
  return match ? match[1].trim() : decodeXmlEntities(value.trim());
};

const tag = (block, name) => {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return match ? unwrapCdata(match[1]) : null;
};

/** Minimal RSS 2.0 <item> extraction — no XML parser dependency in this project. */
export function parseRssItems(xml) {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  return blocks.map(block => ({
    title: tag(block, 'title'), link: tag(block, 'link'),
    description: tag(block, 'description'), pubDate: tag(block, 'pubDate'),
    creator: tag(block, 'dc:creator')
  })).filter(item => item.title && item.link);
}

export function loadIdentity() {
  return {
    players: rows(`SELECT id, name FROM players WHERE fantasy_relevant = 1`),
    teams: rows(`SELECT id, name, abbr FROM nfl_teams`)
  };
}

export async function ingestRssSource(source, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(source.url);
  if (!res.ok) throw new Error(`${source.name} feed returned HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseRssItems(xml);
  const identity = loadIdentity();
  const ingestedAt = new Date().toISOString();
  const results = [];
  for (const item of items) {
    let normalized;
    try {
      normalized = normalizeNewsItem({
        source: source.name, source_url: item.link, source_type: source.sourceType,
        author: item.creator, headline: item.title, summary: item.description,
        published_at: item.pubDate
      }, { identity, ingestedAt });
    } catch (error) {
      results.push({ ok: false, headline: item.title, error: error.message });
      continue;
    }
    const teamId = normalized.entities.teams[0]?.id ?? null;
    const outcome = upsertNormalizedNewsItem(normalized, { teamId });
    results.push({ ok: true, ...outcome, headline: normalized.headline });
  }
  return {
    source: source.name, fetched: items.length,
    inserted: results.filter(r => r.ok && r.inserted).length,
    updated: results.filter(r => r.ok && !r.inserted).length,
    failed: results.filter(r => !r.ok).map(r => ({ headline: r.headline, error: r.error }))
  };
}

export async function ingestAllSources(opts) {
  const out = [];
  for (const source of RSS_SOURCES) out.push(await ingestRssSource(source, opts));
  return out;
}
