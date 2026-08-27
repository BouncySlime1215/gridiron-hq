/**
 * NFL insider tweets, fed through the SAME normalize/typed-extraction
 * pipeline as RSS — not a parallel one.
 *
 * Beat reporters routinely break injury/role news hours before it reaches an
 * official practice report. That is genuinely information a numeric model
 * cannot reach on its own — the whole reason this exists. But a raw tweet is
 * just more prose, and prose alone was the original News-page problem this
 * session already fixed once (generic AI blurbs with no verifiable claim).
 * So a tweet is treated as exactly one more `news_items` row: it goes through
 * `normalizeNewsItem` for entity resolution and dedup, then through the
 * EXISTING typed extractor (`nfl-news-signal.js`) for a verbatim-evidence-span
 * claim — never a sentiment score, never a number derived straight from tweet
 * text. A tweet earns exactly as much trust as an ESPN story with the same
 * words, no more.
 *
 * Source list is curated to accounts with an actual record of breaking real
 * NFL news, not a keyword search of the whole platform — searching "NFL
 * injury" unfiltered would mostly return reactions and jokes, at real cost
 * per read.
 */
import { searchRecentTweets, twitterSpendStatus, hasKey } from '../services/twitterapi-io.js';
import { normalizeNewsItem } from './normalize.js';
import { upsertNormalizedNewsItem } from './store.js';
import { loadIdentity } from './ingest.js';
import { row } from '../db/index.js';
import { watchTweetForLineMove } from '../services/nfl-tweet-line-correlation.js';

/** Accounts with a real, checkable record of first-breaking NFL news — not a popularity list. */
export const INSIDER_HANDLES = Object.freeze([
  'AdamSchefter', 'RapSheet', 'TomPelissero', 'MikeGarafolo', 'JayGlazer',
  'FieldYates', 'JosinaAnderson', 'AdamCaplan'
]);

const MAX_TWEETS_PER_RUN = 5;   // handles per sync call, cost-bounded

function tweetToRawNews(tweet) {
  return {
    source: `Twitter/${tweet.author?.userName ?? 'unknown'}`, source_type: 'social',
    author: tweet.author?.name ?? tweet.author?.userName ?? null,
    source_url: tweet.url ?? tweet.twitterUrl,
    canonical_url: tweet.url ?? tweet.twitterUrl,
    headline: tweet.text?.slice(0, 280) ?? '',
    summary: tweet.text ?? null,
    published_at: tweet.createdAt,
    // Real engagement is a weak but real reliability proxy for whether an
    // insider's own audience is treating this as a confirmed report versus a
    // half-formed rumor — not used for anything beyond the reliability cap
    // that already exists for every other news source.
    reliability: { tier: 'social_insider', score: 0.75 }
  };
}

/**
 * Pull recent tweets from the curated insider list, normalize, and store.
 * Budget-checked before every call via `searchRecentTweets`'s own guard, so
 * this degrades to "did nothing" rather than erroring once the spend cap is
 * reached mid-run.
 */
export async function ingestTwitterInsiders({ maxHandles = MAX_TWEETS_PER_RUN } = {}) {
  if (!hasKey()) return { skipped: true, reason: 'no TWITTERAPI_IO_KEY configured' };
  const status = twitterSpendStatus();
  if (status.blocked) return { skipped: true, reason: 'spend cap reached', status };

  const identity = loadIdentity();
  const handles = INSIDER_HANDLES.slice(0, maxHandles);
  let stored = 0, skipped = 0, calls = 0;
  const errors = [];

  for (const handle of handles) {
    if (twitterSpendStatus().blocked) break;
    const result = await searchRecentTweets(`from:${handle} (injury OR questionable OR doubtful OR out OR starting OR benched OR practice)`,
      { purpose: 'insider-injury-role-sweep' });
    calls++;
    if (result.skipped) break;
    if (result.error) { errors.push({ handle, error: result.error }); continue; }
    for (const tweet of result.body?.tweets ?? []) {
      try {
        const raw = tweetToRawNews(tweet);
        const normalized = normalizeNewsItem(raw, { identity });
        // Only store tweets that actually name a tracked player — an
        // unresolved tweet is exactly the noise this curation exists to avoid.
        if (!normalized.entities.players.length) { skipped++; continue; }
        const teamEntity = normalized.entities.teams[0]
          ? row('SELECT id, abbr FROM nfl_teams WHERE id = ?', normalized.entities.teams[0].id) : null;
        const { id: newsId } = upsertNormalizedNewsItem(normalized,
          { teamId: teamEntity?.id ?? null, date: normalized.published_at.slice(0, 10) });
        stored++;
        // Link to line movement immediately, using the derived team abbr — no
        // player-only tweet is skipped here just because it lacked a team hashtag.
        const teamAbbr = teamEntity?.abbr ?? (normalized.entities.players[0]?.id
          ? row('SELECT t.abbr FROM players p LEFT JOIN nfl_teams t ON t.id=p.team_id WHERE p.id=?',
            normalized.entities.players[0].id)?.abbr : null);
        if (teamAbbr) watchTweetForLineMove({ id: newsId, team_abbr: teamAbbr,
          headline: normalized.headline, published_at: normalized.published_at });
      } catch (e) { errors.push({ handle, error: e.message }); }
    }
  }
  return { handles_checked: calls, stored, skipped_no_player_match: skipped, errors,
    spend: twitterSpendStatus() };
}
