/** Measure verified-news latency against preserved bookmaker snapshots. */
import { rows } from '../db/index.js';

const r2 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(2);
import { normalizeToken as normalize } from './team-codes.js';
const minutes = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// `nfl_line_snapshots.home_team`/`away_team` come from the Odds API and are
// always full names ("New England Patriots"), never abbreviations, so the
// two-letter code is not a useful probe against them — it was the source of
// the false match, since a bare "NE" is a substring of "miNNEsota",
// "teNNEssee" and "NEworleans". Match on the full name only.
function teamAliases() {
  return new Map(rows('SELECT abbr,name FROM nfl_teams').map(team => [team.abbr, normalize(team.name)]));
}

function matchesTeam(snapshot, alias) {
  if (!alias) return false;
  const home = normalize(snapshot.home_team), away = normalize(snapshot.away_team);
  return home.includes(alias) || away.includes(alias);
}

/** Pair each book/market/side with the last pre-claim and first post-claim quote. */
export function quoteReaction(claim, snapshots, alias) {
  const eligible = snapshots.filter(snapshot => matchesTeam(snapshot, alias)
    && new Date(snapshot.commence_time) > new Date(claim.published_at)
    && new Date(snapshot.captured_at) < new Date(snapshot.commence_time));
  const groups = new Map();
  for (const quote of eligible) {
    const key = `${quote.event_id}|${quote.book}|${quote.market}|${quote.side}`;
    const group = groups.get(key) ?? []; group.push(quote); groups.set(key, group);
  }
  const pairs = [];
  for (const quotes of groups.values()) {
    quotes.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
    const prior = [...quotes].reverse().find(quote => new Date(quote.captured_at) <= new Date(claim.published_at));
    const after = quotes.find(quote => new Date(quote.captured_at) > new Date(claim.published_at));
    if (!after) continue;
    const lineMove = prior && Number.isFinite(prior.line) && Number.isFinite(after.line) ? after.line - prior.line : null;
    const priceMove = prior && Number.isFinite(prior.price) && Number.isFinite(after.price) ? after.price - prior.price : null;
    pairs.push({ event_id: after.event_id, book: after.book, market: after.market, side: after.side,
      publication_to_capture_minutes: r2(minutes(claim.published_at, after.captured_at)),
      had_pre_news_quote: Boolean(prior), line_move: r2(lineMove), price_move: r2(priceMove),
      reacted: Boolean(prior && ((lineMove != null && Math.abs(lineMove) >= 0.5) || (priceMove != null && Math.abs(priceMove) >= 5))),
      before: prior ? { captured_at: prior.captured_at, line: prior.line, price: prior.price } : null,
      after: { captured_at: after.captured_at, line: after.line, price: after.price } });
  }
  return pairs;
}

export function nflNewsMarketLatency({ limit = 500 } = {}) {
  const claims = rows(`SELECT news_id,player_name,team,signal_type,status,confidence,published_at,source,source_url
    FROM nfl_news_signals WHERE verification_state='verified' AND team IS NOT NULL
    ORDER BY published_at DESC LIMIT ?`, limit);
  const snapshots = rows(`SELECT captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price
    FROM nfl_line_snapshots ORDER BY captured_at`);
  const aliasMap = teamAliases(), examples = [];
  for (const claim of claims) {
    const alias = aliasMap.get(claim.team) ?? normalize(claim.team);
    const pairs = quoteReaction(claim, snapshots, alias);
    if (!pairs.length) continue;
    const captures = pairs.map(pair => pair.publication_to_capture_minutes).filter(value => value >= 0);
    const reactions = pairs.filter(pair => pair.reacted);
    examples.push({ claim: { ...claim }, quote_pairs: pairs.length, books: new Set(pairs.map(pair => pair.book)).size,
      median_capture_lag_minutes: r2(median(captures)), reacted_pairs: reactions.length,
      first_reaction_minutes: reactions.length ? r2(Math.min(...reactions.map(pair => pair.publication_to_capture_minutes))) : null,
      pairs: pairs.slice(0, 8) });
  }
  const captureLags = examples.map(example => example.median_capture_lag_minutes).filter(Number.isFinite);
  const reactionLags = examples.map(example => example.first_reaction_minutes).filter(Number.isFinite);
  const totalBooks = new Set(examples.flatMap(example => example.pairs.map(pair => pair.book))).size;
  return { claims_considered: claims.length, claims_with_quote_pair: examples.length, snapshots: snapshots.length,
    books: totalBooks, median_news_to_capture_minutes: r2(median(captureLags)),
    claims_with_observed_reaction: reactionLags.length, median_news_to_reaction_minutes: r2(median(reactionLags)),
    research_eligible: examples.length >= 100 && totalBooks >= 3,
    authority: 'latency measurement only; a reaction is not proof the claim caused the move',
    next_gate: examples.length < 100 ? `${100 - examples.length} more verified claims with pre/post quote pairs` : 'run direction and placebo audit',
    examples: examples.slice(0, 25) };
}

export const __test = { quoteReaction, matchesTeam };

/**
 * The same latency measurement over the verified EVENT archive (official
 * injury reports with a modification timestamp, v2 stamps), so the window
 * between a verified fact and the first book move is measured on thousands
 * of events rather than the typed feed's few hundred. Restricted to
 * statuses that move lines (Out, Doubtful, IR) and to events whose game had
 * quotes captured on both sides of the timestamp.
 */
export function verifiedEventMarketLatency({ limit = 2000, since = null } = {}) {
  const events = rows(`SELECT event_key news_id, player_name, team, event_type signal_type, status_after status, 1 confidence,
      available_at published_at, source, source_url, position
    FROM nfl_verified_events WHERE verification_state='verified' AND time_precision='timestamp' AND team IS NOT NULL
      AND (status_after LIKE 'Out%' OR status_after LIKE 'Doubtful%' OR status_after LIKE '%Reserve%')
      ${since ? 'AND available_at>=?' : ''} ORDER BY available_at DESC LIMIT ?`, ...(since ? [since, limit] : [limit]));
  const snapshots = rows(`SELECT captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price
    FROM nfl_line_snapshots WHERE market='spreads' ORDER BY captured_at`);
  const aliasMap = teamAliases(), examples = [];
  for (const claim of events) {
    const alias = aliasMap.get(claim.team) ?? normalize(claim.team);
    const pairs = quoteReaction(claim, snapshots, alias);
    if (!pairs.length) continue;
    const captures = pairs.map(pair => pair.publication_to_capture_minutes).filter(value => value >= 0);
    const reactions = pairs.filter(pair => pair.reacted);
    examples.push({ event: { player: claim.player_name, team: claim.team, position: claim.position, status: claim.status, at: claim.published_at },
      quote_pairs: pairs.length, books: new Set(pairs.map(pair => pair.book)).size,
      median_capture_lag_minutes: r2(median(captures)), reacted_pairs: reactions.length,
      first_reaction_minutes: reactions.length ? r2(Math.min(...reactions.map(pair => pair.publication_to_capture_minutes))) : null });
  }
  const reactionLags = examples.map(example => example.first_reaction_minutes).filter(Number.isFinite);
  const qb = examples.filter(example => example.event.position === 'QB');
  const qbLags = qb.map(example => example.first_reaction_minutes).filter(Number.isFinite);
  return { events_considered: events.length, events_with_quote_pair: examples.length,
    events_with_observed_reaction: reactionLags.length,
    median_event_to_reaction_minutes: r2(median(reactionLags)),
    quarterbacks: { events: qb.length, with_reaction: qbLags.length, median_minutes: r2(median(qbLags)) },
    note: 'Live captures are hourly, so the window is measured to the nearest capture; the archive holds only openers and closes and contributes no path.',
    examples: examples.slice(0, 25) };
}
