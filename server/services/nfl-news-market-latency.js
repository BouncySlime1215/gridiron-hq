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
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
/** Sample standard deviation; null (not zero) below 2 observations -- there is no noise estimate yet, not a zero one. */
const stddev = values => {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
};

/**
 * EVENT-STUDY DESIGN, replacing the old fixed-threshold boolean (>=0.5pt line
 * or >=5c price = "reacted"), which could not tell a genuine news reaction
 * from ordinary leaguewide noise: a vig widening or a slate-wide
 * recalibration moves EVERY game's line/price at once, on Sundays with no
 * news at all, and would cross that same fixed bar for every claim whose
 * capture happened to land in that window.
 *
 * MARKET-MODEL BASELINE: at the exact capture timestamp a claim's own
 * before/after pair spans, every OTHER event's own simultaneous move (same
 * book, same market, any side, pooled) is the cross-sectional peer sample --
 * the "market index" an event study compares one security against. A
 * leaguewide shift shows up coherently across that whole peer set instead of
 * looking like evidence for whichever claim happened to publish near it.
 * abnormal_move = the claim's own move MINUS the peer median move at that
 * same instant (signed, not a boolean).
 *
 * ESTIMATION WINDOW: the same peer-adjusted residual, computed for this
 * exact (event, book, market, side) series at every one of its OWN capture
 * steps strictly BEFORE the claim's publication time -- i.e. how much this
 * specific quote series typically deviates from the peer baseline in
 * ordinary, non-event weeks. Its standard deviation sizes the abnormal move
 * into a z-score, so "reacted" becomes a statistically sized statement
 * ("larger than this series' own normal peer-adjusted noise"), not a bare
 * point estimate compared to an arbitrary constant.
 *
 * Both the market-model baseline and the estimation-window sigma need a real
 * sample to trust: below MIN_PEER_GAMES simultaneous peers, or below
 * MIN_ESTIMATION_OBSERVATIONS pre-claim steps for this exact series, there is
 * not enough data for an abnormal-move estimate, and `quoteReaction` falls
 * back to the original fixed-threshold rule (`reaction_basis:
 * 'raw_threshold_fallback'`) rather than inventing a z-score from too few
 * points -- an honest degraded mode, not a fabricated one.
 */
const Z_THRESHOLD = 2;                 // ~95% two-tailed under a normal null
const MIN_PEER_GAMES = 3;              // minimum simultaneous peer games to trust a market-model baseline
const MIN_ESTIMATION_OBSERVATIONS = 5; // minimum pre-claim steps to trust this series' own noise estimate

/**
 * Index every (event, book, market, side) quote series once: each row's own
 * move from the capture immediately before it (bySeries, for one game's own
 * estimation-window history), and every game's move grouped by the exact
 * (captured_at, book, market) triple it shares with its simultaneously
 * captured peers (byBatch, the market-model cross-section). Built once per
 * top-level call and passed into every `quoteReaction` call for that run,
 * not rebuilt per claim -- this is a single O(n log n) pass over the whole
 * snapshot table regardless of how many claims are scored against it.
 */
export function buildMarketMoveIndex(snapshots) {
  const bySeries = new Map();
  for (const snap of snapshots) {
    const key = `${snap.event_id}|${snap.book}|${snap.market}|${snap.side}`;
    const list = bySeries.get(key); if (list) list.push(snap); else bySeries.set(key, [snap]);
  }
  const byBatch = new Map();
  for (const [key, list] of bySeries) {
    list.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
    const [eventId, book, market] = key.split('|');
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      cur._ownLineMove = Number.isFinite(prev.line) && Number.isFinite(cur.line) ? cur.line - prev.line : null;
      cur._ownPriceMove = Number.isFinite(prev.price) && Number.isFinite(cur.price) ? cur.price - prev.price : null;
      if (cur._ownLineMove == null && cur._ownPriceMove == null) continue;
      const batchKey = `${cur.captured_at}|${book}|${market}`;
      const batch = byBatch.get(batchKey) ?? []; batch.push({ event_id: eventId, line_move: cur._ownLineMove, price_move: cur._ownPriceMove });
      byBatch.set(batchKey, batch);
    }
  }
  return { bySeries, byBatch };
}

/** The peer (market-model) move at one exact capture instant, excluding the claim's own game. */
function peerMove(index, { capturedAt, book, market, excludeEventId }) {
  const peers = (index.byBatch.get(`${capturedAt}|${book}|${market}`) ?? [])
    .filter(peer => peer.event_id !== String(excludeEventId));
  return { line: median(peers.map(peer => peer.line_move).filter(Number.isFinite)),
    price: median(peers.map(peer => peer.price_move).filter(Number.isFinite)),
    peer_games: new Set(peers.map(peer => peer.event_id)).size };
}

/** This exact series' own peer-adjusted noise, from its pre-claim history only. */
function estimationWindow(index, { eventId, book, market, side, beforeIso }) {
  const list = index.bySeries.get(`${eventId}|${book}|${market}|${side}`) ?? [];
  const residuals = { line: [], price: [] };
  for (let i = 1; i < list.length; i++) {
    const cur = list[i];
    if (new Date(cur.captured_at) >= new Date(beforeIso)) break;
    const peer = peerMove(index, { capturedAt: cur.captured_at, book, market, excludeEventId: eventId });
    if (Number.isFinite(cur._ownLineMove) && Number.isFinite(peer.line)) residuals.line.push(cur._ownLineMove - peer.line);
    if (Number.isFinite(cur._ownPriceMove) && Number.isFinite(peer.price)) residuals.price.push(cur._ownPriceMove - peer.price);
  }
  return { line_sigma: residuals.line.length >= MIN_ESTIMATION_OBSERVATIONS ? stddev(residuals.line) : null,
    price_sigma: residuals.price.length >= MIN_ESTIMATION_OBSERVATIONS ? stddev(residuals.price) : null,
    line_n: residuals.line.length, price_n: residuals.price.length };
}

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

/**
 * Pair each book/market/side with the last pre-claim and first post-claim
 * quote, then size that pair's move against the market-model baseline (the
 * OTHER games captured at that same instant) and this series' own
 * estimation-window noise -- see the block comment above `buildMarketMoveIndex`.
 * `index` is optional and defaults to building one from `snapshots` (so
 * calling this directly on a small, single-game snapshot list -- as the
 * existing unit tests do -- still works; a caller scoring many claims
 * against the same snapshot table should build the index once and pass it in,
 * since rebuilding it per claim would be the expensive part of this function).
 */
export function quoteReaction(claim, snapshots, alias, { index } = {}) {
  const moveIndex = index ?? buildMarketMoveIndex(snapshots);
  const eligible = snapshots.filter(snapshot => matchesTeam(snapshot, alias)
    && new Date(snapshot.commence_time) > new Date(claim.published_at)
    && new Date(snapshot.captured_at) < new Date(snapshot.commence_time));
  const groups = new Map();
  for (const quote of eligible) {
    const key = `${quote.event_id}|${quote.book}|${quote.market}|${quote.side}`;
    const group = groups.get(key) ?? []; group.push(quote); groups.set(key, group);
  }
  const pairs = [];
  for (const [key, quotes] of groups) {
    quotes.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
    const prior = [...quotes].reverse().find(quote => new Date(quote.captured_at) <= new Date(claim.published_at));
    const after = quotes.find(quote => new Date(quote.captured_at) > new Date(claim.published_at));
    if (!after) continue;
    const lineMove = prior && Number.isFinite(prior.line) && Number.isFinite(after.line) ? after.line - prior.line : null;
    const priceMove = prior && Number.isFinite(prior.price) && Number.isFinite(after.price) ? after.price - prior.price : null;

    const [, book, market, side] = key.split('|');
    const peer = peerMove(moveIndex, { capturedAt: after.captured_at, book, market, excludeEventId: after.event_id });
    const hasMarketModel = peer.peer_games >= MIN_PEER_GAMES;
    const abnormalLineMove = hasMarketModel && lineMove != null && peer.line != null ? +(lineMove - peer.line).toFixed(2) : null;
    const abnormalPriceMove = hasMarketModel && priceMove != null && peer.price != null ? +(priceMove - peer.price).toFixed(2) : null;

    const estimation = hasMarketModel && prior
      ? estimationWindow(moveIndex, { eventId: after.event_id, book, market, side, beforeIso: claim.published_at })
      : null;
    const lineMoveZ = estimation?.line_sigma && abnormalLineMove != null ? +(abnormalLineMove / estimation.line_sigma).toFixed(2) : null;
    const priceMoveZ = estimation?.price_sigma && abnormalPriceMove != null ? +(abnormalPriceMove / estimation.price_sigma).toFixed(2) : null;
    const hasEventStudy = lineMoveZ != null || priceMoveZ != null;

    pairs.push({ event_id: after.event_id, book: after.book, market: after.market, side: after.side,
      publication_to_capture_minutes: r2(minutes(claim.published_at, after.captured_at)),
      had_pre_news_quote: Boolean(prior), line_move: r2(lineMove), price_move: r2(priceMove),
      // Cross-sectional market-model baseline: the OTHER games' median move at this same capture instant.
      market_line_move: r2(peer.line), market_price_move: r2(peer.price), peer_games: peer.peer_games,
      // Signed, sized abnormal move: this game's move minus the market-model baseline, and that
      // residual's size against this series' own pre-claim (estimation-window) noise.
      abnormal_line_move: abnormalLineMove, abnormal_price_move: abnormalPriceMove,
      line_move_z: lineMoveZ, price_move_z: priceMoveZ,
      estimation_window_observations: estimation ? Math.max(estimation.line_n, estimation.price_n) : 0,
      reaction_basis: hasEventStudy ? 'market_model_abnormal_move' : 'raw_threshold_fallback',
      reacted: hasEventStudy
        // A real market-model + estimation-window estimate exists: require the
        // abnormal move (not the raw one) to be large relative to this
        // series' OWN normal peer-adjusted noise -- immune, by construction,
        // to a move every game made together.
        ? Math.abs(lineMoveZ ?? 0) >= Z_THRESHOLD || Math.abs(priceMoveZ ?? 0) >= Z_THRESHOLD
        // Too few simultaneous peers or too little pre-claim history for this
        // series to trust a baseline -- fall back to the original fixed
        // threshold on the raw move rather than fabricate a z-score from too
        // few points. Honest degraded mode, not a silently worse one:
        // `reaction_basis` says which rule actually produced this flag.
        : Boolean(prior && ((lineMove != null && Math.abs(lineMove) >= 0.5) || (priceMove != null && Math.abs(priceMove) >= 5))),
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
  // Built once for every claim in this call, not once per claim -- see the
  // block comment above buildMarketMoveIndex.
  const index = buildMarketMoveIndex(snapshots);
  const aliasMap = teamAliases(), examples = [];
  for (const claim of claims) {
    const alias = aliasMap.get(claim.team) ?? normalize(claim.team);
    const pairs = quoteReaction(claim, snapshots, alias, { index });
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

export const __test = { quoteReaction, matchesTeam, buildMarketMoveIndex, peerMove, estimationWindow };

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
  const index = buildMarketMoveIndex(snapshots);
  const aliasMap = teamAliases(), examples = [];
  for (const claim of events) {
    const alias = aliasMap.get(claim.team) ?? normalize(claim.team);
    const pairs = quoteReaction(claim, snapshots, alias, { index });
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
