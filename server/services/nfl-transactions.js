/**
 * The transaction wire — signings, releases, IR moves, waiver claims.
 *
 * nflverse has no transactions dataset (`load_trades()` covers trades only,
 * not day-to-day roster moves), and NFL.com's own transactions page is not a
 * documented API. ESPN's public site API already used for news
 * (`site.api.espn.com/apis/site/v2/sports/football/nfl/news`) turns out to
 * have a sibling `/transactions` endpoint with the same shape — no key, no
 * scraping, real current data (verified live: 1,299 transactions, most
 * recent from 2026-08-26, team-attributed and paginated).
 *
 * Each transaction is fed through the SAME normalize/typed-extraction
 * pipeline as everything else in this file's family (RSS, tweets) — not a
 * fourth parallel pipeline. Unlike a tweet or a headline, ESPN's transaction
 * description is ALREADY a structured fact ("Waived WR X", "Signed RB Y",
 * "Placed on injured reserve"), so it does not need an LLM to interpret —
 * it needs typed status rules that recognize transaction language, which is
 * why nfl-news-signal.js's STATUS_RULES gained a transaction family rather
 * than routing these through the AI extractor.
 */
import { rows, row } from '../db/index.js';
import { normalizeNewsItem } from '../news/normalize.js';
import { upsertNormalizedNewsItem } from '../news/store.js';
import { loadIdentity } from '../news/ingest.js';
import { recordSync } from './scheduler.js';

const ESPN_TRANSACTIONS = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/transactions';

/**
 * One ESPN "transaction" often bundles multiple moves in one description
 * ("Signed C Sincere Haynesworth. Waived WR Mac Dalena."). Split on sentence
 * boundaries so each move becomes its own typed claim rather than one
 * unparseable blob a rule can't match cleanly.
 */
function splitMoves(description) {
  return (description ?? '').split(/(?<=[.!])\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
}

export async function syncTransactions({ pages = 3 } = {}) {
  const teams = rows('SELECT id, abbr FROM nfl_teams');
  const teamByAbbr = new Map(teams.map(t => [t.abbr, t.id]));
  const identity = loadIdentity();
  let stored = 0, moves = 0, pagesFetched = 0;
  try {
    for (let page = 1; page <= pages; page++) {
      const resp = await fetch(`${ESPN_TRANSACTIONS}?page=${page}`, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`ESPN transactions API ${resp.status}`);
      const data = await resp.json();
      pagesFetched++;
      for (const t of data.transactions ?? []) {
        const teamId = teamByAbbr.get(t.team?.abbreviation) ?? null;
        for (const move of splitMoves(t.description)) {
          moves++;
          const raw = {
            source: 'ESPN Transactions', source_type: 'publisher', author: null,
            source_url: `https://www.espn.com/nfl/team/transactions/_/name/${t.team?.abbreviation?.toLowerCase() ?? ''}`,
            canonical_url: `https://www.espn.com/nfl/transaction/_/id/${t.id}/${encodeURIComponent(move)}`,
            headline: move, summary: null, published_at: t.date,
            reliability: { tier: 'official_wire', score: 0.95 }
          };
          const normalized = normalizeNewsItem(raw, { identity });
          const { inserted } = upsertNormalizedNewsItem(normalized, { teamId, date: normalized.published_at.slice(0, 10) });
          if (inserted) stored++;
        }
      }
      if (!data.pageCount || page >= data.pageCount) break;
    }
    recordSync('nfl_transactions', 'ok', { pages: pagesFetched, moves_seen: moves, stored });
    return { pages: pagesFetched, moves_seen: moves, stored };
  } catch (e) {
    recordSync('nfl_transactions', 'error', e.message);
    throw e;
  }
}
