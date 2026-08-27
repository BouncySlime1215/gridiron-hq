/**
 * twitterapi.io client with a hard, database-persisted spend cap.
 *
 * This is real money on a prepaid balance ($10, no auto-reload confirmed),
 * not a rate limit that resets — an uncapped bug here is a bill, not a retry.
 * So the cap lives in the database, gets checked BEFORE every call, and is
 * enforced independent of process restarts or cache resets.
 *
 * Pricing (per their docs): $0.15 / 1,000 tweet reads, $0.18 / 1,000 profile
 * reads. Tracked per-call from the actual endpoint hit, not estimated after
 * the fact, and stopped at a SOFT_LIMIT below the real balance so a burst of
 * concurrent requests can't blow through the cap before the running total
 * updates.
 */
import { db, rows, run } from '../db/index.js';

db.exec(`CREATE TABLE IF NOT EXISTS twitterapi_io_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, called_at TEXT NOT NULL,
  endpoint TEXT NOT NULL, items INTEGER NOT NULL, cost_usd REAL NOT NULL,
  purpose TEXT, query TEXT
)`);

const BASE = 'https://api.twitterapi.io';
const COST_PER_1000 = { tweets: 0.15, profiles: 0.18 };
const HARD_BUDGET_USD = Number(process.env.TWITTERAPI_IO_BUDGET_USD ?? 10);
const SOFT_LIMIT_USD = HARD_BUDGET_USD - 0.50;   // stop with headroom, not exactly at the wire

export const hasKey = () => Boolean(process.env.TWITTERAPI_IO_KEY);

export function twitterSpendStatus() {
  const x = rows(`SELECT COALESCE(SUM(cost_usd),0) spent, COUNT(*) calls, MAX(called_at) last
                  FROM twitterapi_io_usage`)[0];
  return {
    spent_usd: +x.spent.toFixed(4), calls: x.calls, last_call: x.last,
    budget_usd: HARD_BUDGET_USD, soft_limit_usd: SOFT_LIMIT_USD,
    remaining_usd: +(SOFT_LIMIT_USD - x.spent).toFixed(4),
    blocked: x.spent >= SOFT_LIMIT_USD
  };
}

function recordSpend(endpoint, items, kind, purpose, query) {
  const cost = (items / 1000) * COST_PER_1000[kind];
  run(`INSERT INTO twitterapi_io_usage (called_at,endpoint,items,cost_usd,purpose,query)
       VALUES (?,?,?,?,?,?)`, new Date().toISOString(), endpoint, items, cost, purpose ?? null, query ?? null);
  return cost;
}

/**
 * Every real call funnels through here so the budget check cannot be
 * bypassed by adding a new endpoint later without threading the check
 * through again.
 */
async function guardedFetch(path, { kind, purpose, query, estimatedItems = 20 } = {}) {
  if (!hasKey()) return { skipped: true, reason: 'no TWITTERAPI_IO_KEY configured' };
  const status = twitterSpendStatus();
  if (status.blocked) {
    return { skipped: true, reason: `spend cap reached: $${status.spent_usd} of $${HARD_BUDGET_USD} soft-limited at $${SOFT_LIMIT_USD}`, status };
  }
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `twitterapi.io ${res.status}: ${text.slice(0, 300)}` };
  }
  const body = await res.json();
  const actualItems = Array.isArray(body?.tweets) ? body.tweets.length
    : Array.isArray(body?.data) ? body.data.length : estimatedItems;
  const cost = recordSpend(path, actualItems, kind, purpose, query);
  return { body, cost_usd: +cost.toFixed(5), items: actualItems };
}

/**
 * Recent tweets matching a search — the actual use case: NFL beat reporters
 * and team insiders on a specific player or team, which is exactly the
 * signal a numeric model structurally cannot reach (a reporter tweeting
 * "hearing X will be a game-time decision" hours before any injury report
 * updates). `queryAddOn` narrows to accounts/hashtags at the call site.
 */
export async function searchRecentTweets(query, { purpose = null, maxResults = 20 } = {}) {
  const q = encodeURIComponent(query);
  return guardedFetch(`/twitter/tweet/advanced_search?query=${q}&queryType=Latest`,
    { kind: 'tweets', purpose, query, estimatedItems: maxResults });
}

/**
 * Verify a candidate handle actually exists and looks like the account it
 * claims to be — cheaply. A profile read is $0.18/1000, i.e. $0.00018 per
 * check, three orders of magnitude cheaper than re-running web research to
 * eyeball a search result. This is the real fix for "we have an unverified
 * handle list": check it against the platform itself before spending real
 * ingestion budget on a dead or wrong account.
 */
export async function verifyHandle(handle, { expectBioContains = [] } = {}) {
  const result = await guardedFetch(`/twitter/user/info?userName=${encodeURIComponent(handle)}`,
    { kind: 'profiles', purpose: 'handle-verification', query: handle, estimatedItems: 1 });
  if (result.skipped || result.error) return { handle, exists: false, ...result };
  const u = result.body?.data ?? result.body;
  if (!u?.id) return { handle, exists: false, cost_usd: result.cost_usd };
  const bio = `${u.name ?? ''} ${u.description ?? ''}`.toLowerCase();
  const bioMatch = !expectBioContains.length || expectBioContains.some(term => bio.includes(term.toLowerCase()));
  return {
    handle, exists: true, name: u.name, verified: !!u.isBlueVerified, followers: u.followers,
    bio: u.description, bio_matches_expectation: bioMatch, cost_usd: result.cost_usd
  };
}

export function twitterSpendHistory(limit = 50) {
  return rows(`SELECT * FROM twitterapi_io_usage ORDER BY called_at DESC LIMIT ?`, limit);
}
