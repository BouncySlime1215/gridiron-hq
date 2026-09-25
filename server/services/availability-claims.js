/**
 * FIX-184-6: the one availability-claim reader for a player-week (tdd section 9 item 9).
 *
 * Two producers turn text into "is he playing this week":
 *   - nfl_news_signals (writer nfl-news-signal.js, STATUS_RULES), from news items;
 *   - live_inactive_claims (writer live-inactive-monitor.js#recordClaim, migration 093),
 *     from watched public Bluesky posts.
 * On the same player-week they disagreed (tdd section 9 item 9 has a W2 case), and
 * Start/Sit read only the second. This module reads both, and the LATEST DEFINITIVE claim
 * made BEFORE THE PLAYER'S OWN KICKOFF wins. The output names the table and the source.
 *
 * Definitive, per producer:
 *   - live: 'inactive' | 'active' (the monitor already refuses hedges).
 *   - news: out / out_for_season / released -> 'inactive'; available_positive -> 'active'.
 *     doubtful / questionable / did_not_practice / limited are designations, not a claim
 *     about the game, and are skipped (the same line the monitor draws on hedges).
 *     Only `verification_state = 'verified'` rows count, the rule playerNewsSignal uses,
 *     and only the current version of each story (view nfl_news_signals_current,
 *     migration 053).
 *
 * Clocks: live claims are timed by first_seen_at (Jetstream's clock); news by
 * published_at. Kickoff is game-cutoff.js#gameCutoff (game_lines); a claim at or after
 * it is ignored. A player with no kickoff on file has no cut (live claims are already
 * scoped to their season/week). News is read back NEWS_LOOKBACK_DAYS before the kickoff
 * (or `now` without one), so last week's "ruled out" is not this week's claim.
 *
 * claimInactiveHook() turns the winners into the SS-01 `inactive` hook
 * (dead-starters.js#deadReason), which lineup-brain.js also reads for its Start/Sit
 * warnings: one set for both surfaces (FIX-184-2). Gated by live-inactive-flag.js.
 */
import { rows } from '../db/index.js';
import { normalizePlayerName } from './player-identity.js';
import { gameCutoff } from './game-cutoff.js';
import { liveClaimsLatest, postUrl } from './live-inactive-monitor.js';
import { liveInactiveFields } from './live-inactive-flag.js';

export const CLAIMS_SOURCE = 'availability_claims';
export const LIVE_TABLE = 'live_inactive_claims';
export const NEWS_TABLE = 'nfl_news_signals';
export const NEWS_LOOKBACK_DAYS = 6;
const NEWS_STATUS = Object.freeze({ out: 'inactive', out_for_season: 'inactive', released: 'inactive',
  available_positive: 'active' });
const NEWS_STATUSES = Object.keys(NEWS_STATUS);

export const CLAIMS_LABEL =
  'Source: the latest pre-kickoff claim from a watched public Bluesky account or a verified news item. ' +
  'This is unconfirmed forward: the W3-W5 forward test against the official inactive list has not run.';

const ms = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/**
 * Map(player_id -> winning claim) for the given players and week.
 * A claim: { player_id, status: 'inactive'|'active', source: LIVE_TABLE|NEWS_TABLE,
 *   source_name, source_url, at, kickoff, detail }.
 * @param players [{ id, name, team_abbr }]
 */
export function availabilityClaims({ season, week, players, now = Date.now(), kickoffOf = null }) {
  const out = new Map();
  if (!players?.length || season == null || week == null) return out;
  const kickoffs = new Map();
  const kickoff = abbr => {
    if (!abbr) return null;
    if (!kickoffs.has(abbr)) kickoffs.set(abbr, (kickoffOf ?? (t => gameCutoff(season, week, t)))(abbr));
    return kickoffs.get(abbr);
  };
  // The cut is his kickoff. With none on file nothing is cut (the monitor's rule too),
  // and the news lookback is anchored at `now` instead.
  const cutFor = p => ms(kickoff(p.team_abbr));
  const after = (at, p) => { const cut = cutFor(p); return cut != null && at >= cut; };
  const offer = (id, claim) => {
    const prior = out.get(id);
    if (!prior || ms(claim.at) > ms(prior.at)) out.set(id, claim);
  };

  const wanted = new Map(players.map(p => [p.id, p]));
  // Live: already the latest pre-kickoff claim per player (kickoff filter in the monitor).
  for (const [id, c] of liveClaimsLatest({ season, week, kickoffOf })) {
    const p = wanted.get(id);
    if (!p) continue;
    const at = ms(c.first_seen_at);
    if (at == null || after(at, p)) continue;
    offer(id, { player_id: id, status: c.status, source: LIVE_TABLE, source_name: c.source_handle,
      source_url: postUrl(c.source_uri), at: c.first_seen_at, kickoff: kickoff(p.team_abbr), detail: c.status });
  }

  // News: matched on the story's player id, else on the normalised name within the team.
  const byId = new Map(players.map(p => [String(p.id), p]));
  const byKey = new Map();
  for (const p of players) {
    const key = normalizePlayerName(p.name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const ids = [...byId.keys()], keys = [...byKey.keys()];
  const news = rows(`SELECT player_id, player_key, team, status, published_at, source, source_url
      FROM nfl_news_signals_current
     WHERE signal_type = 'availability' AND verification_state = 'verified'
       AND status IN (${NEWS_STATUSES.map(() => '?').join(',')})
       AND (player_id IN (${ids.map(() => '?').join(',')}) OR player_key IN (${keys.map(() => '?').join(',')}))`,
  ...NEWS_STATUSES, ...ids, ...keys);
  for (const n of news) {
    const p = byId.get(String(n.player_id))
      ?? (byKey.get(n.player_key) ?? []).find(x => n.team == null || n.team === x.team_abbr);
    if (!p) continue;
    const at = ms(n.published_at);
    if (at == null || after(at, p) || at < (cutFor(p) ?? now) - NEWS_LOOKBACK_DAYS * 86_400_000) continue;
    offer(p.id, { player_id: p.id, status: NEWS_STATUS[n.status], source: NEWS_TABLE,
      source_name: n.source ?? 'news', source_url: n.source_url ?? null, at: n.published_at,
      kickoff: kickoff(p.team_abbr), detail: n.status });
  }
  return out;
}

/** The sentence the dead-starter card prints after the player's name and slot. */
function sentenceFor(c) {
  return c.source === LIVE_TABLE
    ? `is reported inactive by ${c.source_name} (a public post, not the official inactive list)`
    : `is reported out by ${c.source_name} (a news report, not the official inactive list)`;
}

/**
 * The SS-01 `inactive` hook from the winners whose status is 'inactive'.
 * `fields` defaults to live-inactive-flag.js#liveInactiveFields(); off -> not covered.
 * @returns {{covered, source, reason, ids: Set, byId: Map, claims: Map, label, sentence,
 *   preview?, preview_reason?}}
 */
export function claimInactiveHook({ season, week, players, now = Date.now(), kickoffOf = null,
  fields = liveInactiveFields() }) {
  const base = { source: CLAIMS_SOURCE, label: CLAIMS_LABEL, sentence: null };
  if (!fields.enabled) {
    return { ...base, covered: false, reason: fields.reason ?? null, ids: new Set(), byId: new Map(), claims: new Map() };
  }
  const claims = new Map();
  for (const [id, c] of availabilityClaims({ season, week, players, now, kickoffOf })) {
    if (c.status === 'inactive') claims.set(id, c);
  }
  const byId = new Map([...claims].map(([id, c]) => [id, { source: c.source, sentence: sentenceFor(c), label: CLAIMS_LABEL }]));
  return { ...base, covered: true,
    reason: `latest pre-kickoff claim from ${LIVE_TABLE} and ${NEWS_TABLE}, week ${week}`,
    ids: new Set(claims.keys()), byId, claims,
    ...(fields.preview ? { preview: true, preview_reason: fields.preview_reason } : {}) };
}
