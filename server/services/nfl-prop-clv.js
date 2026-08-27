/**
 * Closing-line value for player props — the only evidence that can establish
 * a real betting edge.
 *
 * THE STATE OF THE QUESTION, precisely. Two claims get conflated as "the model
 * has no edge", and only one of them is established:
 *
 *   SPREADS — settled, negative. `game_lines` holds 15,096 closing spreads and
 *   totals back to 1999, all 21 component models have been measured against
 *   them, and 0 of 21 clear the materiality gate. That question is answered
 *   and should not be re-litigated.
 *
 *   PROPS — UNMEASURED. `nfl_prop_quote_snapshots` contains zero rows. The
 *   model has never once been compared to a real prop price. "No edge on
 *   props" is not a finding; it is an absence of data.
 *
 * That distinction matters because props are exactly where the model does have
 * demonstrable skill — 2+ touchdowns at +27.3% Brier skill, any-type TD at
 * +20.6%, rushing TD at +9.5%, all against each market's own climatology.
 * Whether that skill converts into money depends entirely on where books hang
 * the lines, which nobody here has ever looked at.
 *
 * Note what this does NOT assume: beating the market on average is not the
 * bar. A prop bettor needs only a findable subset where the model's number
 * differs from the line by more than the vig. Prop markets are also softer
 * than spreads — lower limits, less sharp money, hundreds of lines per week
 * priced semi-automatically — so the prior for finding such a subset is
 * meaningfully better than it is for sides and totals. That is a hypothesis,
 * and this module exists to test it rather than assert it.
 *
 * Closing-line value is the metric, not realised profit. CLV converges far
 * faster than win rate: whether you beat the closing number is knowable in
 * a few hundred bets, whereas separating a 2% ROI edge from variance takes
 * thousands. Positive median CLV is the standard evidence that a model is
 * finding real mispricing, and `MODEL_OPERATIONS.md` already names it as the
 * promotion requirement.
 */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { hasKey, events, playerProps, flattenAllProps, PROP_MARKETS, usage } from './odds-api.js';
import { playerWeeks } from './nfl-pbp.js';
import { projectWeek } from './nfl-props.js';
import { normalizePlayerName } from './player-identity.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_prop_clv (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL, book TEXT NOT NULL,
    market TEXT NOT NULL, player TEXT NOT NULL, side TEXT NOT NULL,
    line REAL, american_price INTEGER NOT NULL,
    model_probability REAL, implied_probability REAL, edge REAL,
    season INTEGER, week INTEGER,
    closing_line REAL, closing_price INTEGER, clv_cents REAL,
    settled INTEGER NOT NULL DEFAULT 0, actual_value REAL, won INTEGER,
    PRIMARY KEY (captured_at, event_id, book, market, player, side)
  );
  CREATE INDEX IF NOT EXISTS idx_prop_clv_settle ON nfl_prop_clv(settled, season, week);
`);

const quoteCols = new Set(db.prepare('PRAGMA table_info(nfl_prop_clv)').all().map(c => c.name));
for (const [column, type] of [
  ['commence_time', 'TEXT'], ['home_team', 'TEXT'], ['away_team', 'TEXT'],
  ['closing_fair_probability', 'REAL'], ['clv_probability', 'REAL'],
  ['model_match_status', 'TEXT'], ['model_match_reason', 'TEXT'],
  ['matched_player_id', 'TEXT'], ['capture_horizon_hours', 'INTEGER'],
  ['settlement_reason', 'TEXT']
]) {
  if (!quoteCols.has(column)) db.exec(`ALTER TABLE nfl_prop_clv ADD COLUMN ${column} ${type}`);
}

/** American odds -> implied probability, and the no-vig pair. */
export const impliedFromAmerican = p => (p >= 0 ? 100 / (p + 100) : -p / (-p + 100));

/** Decimal price, for CLV in percentage terms. */
const decimalFromAmerican = p => (p >= 0 ? 1 + p / 100 : 1 + 100 / -p);
const HOUR = 3600e3;
export const PROP_CAPTURE_HORIZONS_HOURS = Object.freeze([24, 1]);
const PROP_CREDIT_RESERVE = 50;

const normalizeName = normalizePlayerName;

const MARKET_STAT = {
  player_pass_yds: 'pass_yds', player_rush_yds: 'rush_yds',
  player_reception_yds: 'rec_yds', player_receptions: 'receptions',
  player_anytime_td: 'any_td'
};

export const PROP_DECISION_POLICY = Object.freeze({
  version: 'nfl-prop-shadow-2026.1',
  capture_horizons_hours: PROP_CAPTURE_HORIZONS_HOURS,
  minimum_settled_overall: 200,
  minimum_settled_per_market: 75,
  selection: 'earliest captured board; largest positive model-minus-no-vig edge per event/player/market',
  duplicate_unit: 'event/player/market',
  promotion: 'positive mean and median CLV, week-clustered 90% interval above zero, ECE <= 0.03, slope 0.85-1.15',
  staking: 'zero model-derived units before promotion'
});

export const propDecisionPolicyHash = () => createHash('sha256')
  .update(JSON.stringify(PROP_DECISION_POLICY)).digest('hex');

db.exec(`CREATE TABLE IF NOT EXISTS nfl_prop_policy_archive (
  version TEXT PRIMARY KEY,policy_hash TEXT NOT NULL,policy_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL
)`);

export function freezePropDecisionPolicy() {
  const hash = propDecisionPolicyHash();
  const existing = rows('SELECT * FROM nfl_prop_policy_archive WHERE version=?', PROP_DECISION_POLICY.version)[0];
  if (existing && existing.policy_hash !== hash) {
    throw new Error(`frozen prop policy ${PROP_DECISION_POLICY.version} changed without a version bump`);
  }
  if (!existing) run(`INSERT INTO nfl_prop_policy_archive (version,policy_hash,policy_json,frozen_at)
    VALUES (?,?,?,?)`, PROP_DECISION_POLICY.version, hash, JSON.stringify(PROP_DECISION_POLICY), new Date().toISOString());
  return rows('SELECT * FROM nfl_prop_policy_archive WHERE version=?', PROP_DECISION_POLICY.version)[0];
}

freezePropDecisionPolicy();

function projectionMatch(quote, projections, knownPlayers) {
  if (!MARKET_STAT[quote.market]) return {
    status: 'unsupported_market', reason: `market ${quote.market} is not supported`, projection: null
  };
  if (/(?:\bd\/st\b|\bdefense\b)/i.test(String(quote.player))) return {
    status: 'unsupported_participant', reason: 'team-defense touchdown markets are outside the player event engine', projection: null
  };
  const normalized = normalizeName(quote.player);
  const projection = projections.get(normalized);
  if (projection) return { status: 'modeled', reason: 'canonical normalized-name match', projection };
  const known = knownPlayers.get(normalized) ?? [];
  if (!known.length) return {
    status: 'identity_unresolved', reason: 'sportsbook player name did not resolve to the canonical player universe', projection: null
  };
  const hasHistory = known.some(player => player.gsis_id);
  return {
    status: hasHistory ? 'role_ineligible' : 'projection_missing',
    reason: hasHistory
      ? 'identity resolved, but the pregame role/volume gate abstained for this market'
      : 'identity resolved, but no GSIS history exists for a cutoff-safe projection',
    projection: null, matched_player_id: known[0].gsis_id ?? String(known[0].id)
  };
}

function knownPlayerIndex() {
  const known = new Map();
  const add = player => {
    const key = normalizeName(player.name); if (!key) return;
    const list = known.get(key) ?? [];
    if (!list.some(candidate => String(candidate.gsis_id ?? candidate.id) === String(player.gsis_id ?? player.id))) list.push(player);
    known.set(key, list);
  };
  for (const player of rows('SELECT id,name,gsis_id,position FROM players')) add(player);
  for (const player of rows(`SELECT player_id AS gsis_id,player_name AS name,position
    FROM nfl_player_week_features GROUP BY player_id,player_name,position`)) add(player);
  return known;
}

export function noVigPropProbability(ownPrice, oppositePrice) {
  const own = impliedFromAmerican(ownPrice);
  if (!Number.isFinite(oppositePrice)) return own;
  const opposite = impliedFromAmerican(oppositePrice);
  return own + opposite > 0 ? own / (own + opposite) : null;
}

function attachFairProbabilities(quotes) {
  const index = new Map(quotes.map(q => [[q.event_id, q.book, q.market,
    normalizeName(q.player), q.line ?? '', String(q.side).toLowerCase()].join('|'), q]));
  return quotes.map(q => {
    const side = String(q.side).toLowerCase();
    const oppositeSide = side === 'over' ? 'under' : side === 'under' ? 'over' : null;
    const opposite = oppositeSide ? index.get([q.event_id, q.book, q.market,
      normalizeName(q.player), q.line ?? '', oppositeSide].join('|')) : null;
    return { ...q, implied_probability: noVigPropProbability(q.american_price, opposite?.american_price) };
  });
}

function weekForEvent(event, season, fallbackWeek) {
  const home = rows('SELECT abbr FROM nfl_teams WHERE name=?', event.home_team)[0]?.abbr;
  const away = rows('SELECT abbr FROM nfl_teams WHERE name=?', event.away_team)[0]?.abbr;
  if (!home || !away) return fallbackWeek ?? null;
  const candidates = rows(`SELECT week,gameday FROM game_lines
                            WHERE season=? AND home=1 AND team=? AND opponent=?`, season, home, away);
  if (!candidates.length) return fallbackWeek ?? null;
  const kickoff = new Date(event.commence_time).getTime();
  candidates.sort((a, b) => Math.abs(new Date(`${a.gameday}T17:00:00Z`).getTime() - kickoff)
    - Math.abs(new Date(`${b.gameday}T17:00:00Z`).getTime() - kickoff));
  return candidates[0].week;
}

function probabilityForQuote(quote, projections) {
  const projection = projections.get(normalizeName(quote.player));
  if (!projection) return null;
  if (quote.market === 'player_anytime_td') return projection.projection.any_td_prob;
  const stat = MARKET_STAT[quote.market];
  const samples = projection._sims?.[stat];
  if (!samples?.length || !Number.isFinite(quote.line)) return null;
  const over = samples.filter(value => value > quote.line).length / samples.length;
  return /^under$/i.test(quote.side) ? 1 - over : over;
}

/** Return the closest still-missing capture horizon that is currently due. */
export function duePropCaptureHorizon(commenceTime, priorCaptures = [],
  now = new Date().toISOString(), horizons = PROP_CAPTURE_HORIZONS_HOURS) {
  const kickoff = new Date(commenceTime).getTime(), at = new Date(now).getTime();
  if (!Number.isFinite(kickoff) || !Number.isFinite(at) || at >= kickoff) return null;
  const due = horizons.filter(hours => {
    if (kickoff - at > hours * HOUR) return false;
    const opens = kickoff - hours * HOUR;
    return !priorCaptures.some(capture => {
      const t = new Date(capture).getTime();
      return t >= opens && t < kickoff;
    });
  });
  return due.length ? Math.min(...due) : null;
}

/**
 * Capture the current prop market. Idempotent per (capture, event, book,
 * market, player, side), so running it more often than the market moves
 * simply stores nothing new.
 *
 * Deliberately stores EVERY quote, not only the ones the model likes. Storing
 * only flagged bets would make the archive unusable for measuring calibration
 * across the whole market, and would bake this week's model into the record
 * of what the market offered.
 */
export async function capturePropMarket({ season, week, maxEvents = 12, scheduled = false } = {}) {
  if (!hasKey()) return { skipped: true, reason: 'no ODDS_API_KEY configured' };
  const capturedAt = new Date().toISOString();
  const list = (await events()) ?? [];
  let selected = list;
  if (scheduled) {
    selected = list.filter(event => {
      const prior = rows('SELECT DISTINCT captured_at FROM nfl_prop_clv WHERE event_id=?', event.id)
        .map(row => row.captured_at);
      return duePropCaptureHorizon(event.commence_time, prior, capturedAt) != null;
    });
    if (!selected.length) {
      const next = list.map(event => ({ event: event.id, commence_time: event.commence_time,
        hours_until: (new Date(event.commence_time).getTime() - Date.now()) / HOUR }))
        .filter(x => x.hours_until > 0).sort((a, b) => a.hours_until - b.hours_until)[0] ?? null;
      return { skipped: true, reason: 'no T-24h or T-1h prop capture window is due', next_event: next };
    }
  }
  const budget = usage();
  const affordable = Number.isFinite(budget.requests_remaining)
    ? Math.max(0, Math.floor((budget.requests_remaining - PROP_CREDIT_RESERVE) / PROP_MARKETS.length))
    : maxEvents;
  const eventLimit = Math.min(maxEvents, affordable);
  if (eventLimit < 1) return { skipped: true,
    reason: `credit reserve protected (${budget.requests_remaining ?? 'unknown'} remaining; ${PROP_CREDIT_RESERVE} reserved)`,
    usage: budget };
  selected = selected.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time)).slice(0, eventLimit);
  const insert = db.prepare(`INSERT OR IGNORE INTO nfl_prop_clv
    (captured_at,event_id,book,market,player,side,line,american_price,
     model_probability,implied_probability,edge,season,week,commence_time,home_team,away_team,
     model_match_status,model_match_reason,matched_player_id,capture_horizon_hours)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const knownPlayers = knownPlayerIndex();
  const projectionsByWeek = new Map();
  let stored = 0, seen = 0;
  for (const e of selected) {
    let payload;
    try { payload = await playerProps(e.id, { markets: PROP_MARKETS }); } catch { continue; }
    if (!payload) continue;
    const eventWeek = weekForEvent(e, season, week);
    if (!projectionsByWeek.has(eventWeek)) {
      const projections = Number.isInteger(eventWeek) ? projectWeek(season, eventWeek) : [];
      projectionsByWeek.set(eventWeek, new Map(projections.map(p => [normalizeName(p.name), p])));
    }
    const projectionIndex = projectionsByWeek.get(eventWeek);
    const captureHorizon = duePropCaptureHorizon(e.commence_time, [], capturedAt);
    for (const q of attachFairProbabilities(flattenAllProps(payload))) {
      seen++;
      if (q.commence_time && new Date(q.commence_time).getTime() <= new Date(capturedAt).getTime()) continue;
      const match = projectionMatch(q, projectionIndex, knownPlayers);
      const modelProbability = match.projection ? probabilityForQuote(q, projectionIndex) : null;
      const edge = Number.isFinite(modelProbability) && Number.isFinite(q.implied_probability)
        ? modelProbability - q.implied_probability : null;
      const offeredLine = q.line ?? (q.market === 'player_anytime_td' ? 0.5 : null);
      stored += insert.run(capturedAt, q.event_id, q.book, q.market, q.player, q.side,
        offeredLine, q.american_price, modelProbability, q.implied_probability, edge,
        season ?? null, eventWeek ?? null, q.commence_time ?? e.commence_time ?? null,
        q.home_team ?? e.home_team ?? null, q.away_team ?? e.away_team ?? null,
        match.status, match.reason, match.projection?.player_id ?? match.matched_player_id ?? null,
        captureHorizon).changes;
    }
  }
  const closing = finalizeClosingSnapshots();
  return { captured_at: capturedAt, events: selected.length, quotes_seen: seen,
    modeled: rows('SELECT COUNT(*) n FROM nfl_prop_clv WHERE captured_at=? AND model_probability IS NOT NULL', capturedAt)[0]?.n ?? 0,
    stored, closing, usage: usage(), schedule: scheduled ? { horizons_hours: PROP_CAPTURE_HORIZONS_HOURS,
      credit_reserve: PROP_CREDIT_RESERVE } : null };
}

/** Freeze the last book-specific quote before kickoff as the close. */
export function finalizeClosingSnapshots(now = new Date().toISOString()) {
  const pending = rows(`SELECT * FROM nfl_prop_clv
                        WHERE commence_time IS NOT NULL AND commence_time <= ?
                          AND captured_at < commence_time
                          AND closing_price IS NULL`, now);
  const update = db.prepare(`UPDATE nfl_prop_clv
    SET closing_line=?,closing_price=?,closing_fair_probability=?,clv_probability=?,clv_cents=?
    WHERE captured_at=? AND event_id=? AND book=? AND market=? AND player=? AND side=?`);
  let finalized = 0, unmatched = 0;
  for (const quote of pending) {
    const close = rows(`SELECT line,american_price,implied_probability FROM nfl_prop_clv
                        WHERE event_id=? AND book=? AND market=? AND player=? AND side=?
                          AND captured_at < ?
                        ORDER BY captured_at DESC LIMIT 1`, quote.event_id, quote.book,
    quote.market, quote.player, quote.side, quote.commence_time)[0];
    if (!close) { unmatched++; continue; }
    const clv = Number.isFinite(close.implied_probability) && Number.isFinite(quote.implied_probability)
      ? close.implied_probability - quote.implied_probability : null;
    update.run(close.line, close.american_price, close.implied_probability, clv,
      clv == null ? null : clv * 100, quote.captured_at, quote.event_id, quote.book,
      quote.market, quote.player, quote.side);
    finalized++;
  }
  return { finalized, unmatched };
}

/** Map a stored market key to the player-week field that settles it. */
const SETTLE_FIELD = {
  player_pass_yds: 'passing_yards',
  player_rush_yds: 'rushing_yards',
  player_reception_yds: 'receiving_yards',
  player_receptions: 'receptions'
};

/**
 * Settle captured quotes against real outcomes.
 *
 * Only over/under markets on a numeric line are settled here. Anytime-TD is
 * deliberately left for a separate pass because its settlement rule (rushing
 * plus receiving, excluding passing) is a real source of quiet error and
 * should not be buried in a loop that also handles yardage.
 */
export function settlePropQuotes({ season, week } = {}) {
  const pending = rows(`SELECT * FROM nfl_prop_clv
                        WHERE settled = 0 AND season = ? AND week = ?
                          AND market IN ('player_pass_yds','player_rush_yds','player_reception_yds','player_receptions','player_anytime_td')`,
  season, week);
  if (!pending.length) return { settled: 0, unmatched: 0, note: 'nothing pending for that week' };

  const actuals = new Map();
  for (const r of playerWeeks(season).filter(x => x.week === week)) {
    actuals.set(normalizeName(r.player_name), r.features);
  }
  const upd = db.prepare(`UPDATE nfl_prop_clv SET settled=1, actual_value=?, won=?, settlement_reason=?
                          WHERE captured_at=? AND event_id=? AND book=? AND market=? AND player=? AND side=?`);
  let settled = 0, unmatched = 0;
  for (const q of pending) {
    const f = actuals.get(normalizeName(q.player));
    if (!f) { unmatched++; continue; }
    const actual = q.market === 'player_anytime_td'
      ? ((f.rushing_tds ?? 0) + (f.receiving_tds ?? 0)) : f[SETTLE_FIELD[q.market]];
    if (!Number.isFinite(actual) || q.line == null) { unmatched++; continue; }
    // A push (exact line) is neither a win nor a loss; recorded as null.
    const won = actual === q.line ? null
      : /^(over|yes)$/i.test(q.side) ? (actual > q.line ? 1 : 0) : (actual < q.line ? 1 : 0);
    upd.run(actual, won, won == null ? 'push' : 'settled from nflverse player-week result',
      q.captured_at, q.event_id, q.book, q.market, q.player, q.side);
    settled++;
  }
  return { settled, unmatched };
}

/**
 * The evidence report. Reports what is actually known, and says plainly when
 * that is nothing — an empty archive must read as "not yet measured", never
 * as "no edge found".
 */
export function propEdgeEvidence() {
  const total = rows(`SELECT COUNT(*) n FROM nfl_prop_clv`)[0].n;
  if (!total) {
    return {
      status: 'not_yet_measured',
      captured_quotes: 0,
      verdict: 'The model has never been compared to a real prop price. This is an absence of ' +
        'evidence, not evidence of absence — distinct from spreads, where 0 of 21 models beating ' +
        '15,096 closing lines is a genuine measured negative.',
      to_start: 'Set ODDS_API_KEY and let the nfl_prop_capture scheduler job run through a slate. ' +
        'Roughly 200 settled bets are needed before median CLV means anything.'
    };
  }
  /*
   * Quotes are not bets. Counting every book, both sides and every hourly
   * snapshot would turn one Josh Allen market into dozens of fake samples.
   * The shadow policy is deterministic: for each event/player/market, freeze
   * the earliest captured board and retain its single largest positive
   * model-vs-no-vig divergence. Later captures exist only to establish CLV.
   */
  const modeled = rows(`SELECT * FROM nfl_prop_clv
                        WHERE model_probability IS NOT NULL
                          AND implied_probability IS NOT NULL
                          AND captured_at < commence_time
                        ORDER BY captured_at,event_id,market,player,edge DESC`);
  const decisions = new Map();
  for (const quote of modeled) {
    const key = `${quote.event_id}|${quote.market}|${normalizeName(quote.player)}`;
    const current = decisions.get(key);
    if (!current || quote.captured_at < current.captured_at
      || (quote.captured_at === current.captured_at && quote.edge > current.edge)) {
      decisions.set(key, quote);
    }
  }
  const shadow = [...decisions.values()].filter(quote => quote.edge > 0);
  const settled = shadow.filter(quote => quote.settled === 1 && quote.won != null);
  const withClv = shadow.map(quote => quote.clv_probability).filter(Number.isFinite);
  const median = a => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const wins = settled.filter(r => r.won === 1).length;
  const roi = settled.length
    ? settled.reduce((s, r) => s + (r.won === 1 ? decimalFromAmerican(r.american_price) - 1 : -1), 0) / settled.length
    : null;
  return {
    status: settled.length >= 200 ? 'measurable' : 'accumulating',
    captured_quotes: total,
    modeled_quotes: modeled.length,
    shadow_decisions: shadow.length,
    settled_bets: settled.length,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    roi: roi == null ? null : +roi.toFixed(4),
    median_clv_probability: median(withClv),
    breakeven_note: 'Prices are real and no-vigged per book. One immutable shadow decision per event/player/market; hourly quotes and both sides are never counted as independent bets.',
    verdict: settled.length < 200
      ? `Only ${settled.length} settled bets. Below ~200 this cannot separate edge from variance; keep accumulating.`
      : 'Sample is large enough to read. Median CLV is the primary signal; ROI is noisier and secondary.'
  };
}

export function propClvStatus() {
  const x = rows(`SELECT COUNT(*) quotes, COUNT(DISTINCT captured_at) captures,
                         COUNT(DISTINCT event_id) events, SUM(settled) settled,
                         SUM(model_probability IS NOT NULL) modeled,
                         SUM(closing_price IS NOT NULL) closed,
                         MIN(captured_at) first, MAX(captured_at) latest
                  FROM nfl_prop_clv`)[0];
  return { ...x, has_key: hasKey(), policy_version: PROP_DECISION_POLICY.version,
    policy_hash: propDecisionPolicyHash(), policy_frozen_at: freezePropDecisionPolicy().frozen_at,
    credit_reserve: PROP_CREDIT_RESERVE };
}

/** Explain every modeled and unmodeled quote without relaxing the eligibility gate. */
export function propMatchCoverage() {
  const total = rows('SELECT COUNT(*) n FROM nfl_prop_clv')[0]?.n ?? 0;
  const grouped = rows(`SELECT COALESCE(model_match_status,
      CASE WHEN model_probability IS NOT NULL THEN 'modeled' ELSE 'legacy_unclassified' END) status,
      COUNT(*) quotes,COUNT(DISTINCT event_id||'|'||market||'|'||player) decisions
    FROM nfl_prop_clv GROUP BY status ORDER BY quotes DESC`);
  const modeled = grouped.find(row => row.status === 'modeled')?.quotes ?? 0;
  const unresolved = grouped.filter(row => ['identity_unresolved', 'legacy_unclassified'].includes(row.status))
    .reduce((sum, row) => sum + row.quotes, 0);
  const resolved = total - unresolved;
  return {
    quotes: total, modeled, resolved, unresolved,
    model_rate: total ? +(modeled / total).toFixed(4) : null,
    rate: total ? +(resolved / total).toFixed(4) : null,
    target: 0.95, passed: total > 0 && resolved / total >= 0.95,
    reasons: grouped,
    note: 'Unmatched quotes remain visible and cannot be converted into model coverage by weakening the pregame role gate.'
  };
}

/** Classify legacy/unclassified quotes against the current frozen projection policy. */
export function reconcilePropQuoteMatches({ force = false } = {}) {
  const pending = rows(`SELECT rowid,* FROM nfl_prop_clv
    WHERE model_match_status IS NULL OR model_match_status='legacy_unclassified'
      ${force ? "OR model_match_status<>'modeled'" : ''}`);
  if (!pending.length) return { reviewed: 0, updated: 0, coverage: propMatchCoverage() };
  const knownPlayers = knownPlayerIndex();
  const projectionCache = new Map();
  const update = db.prepare(`UPDATE nfl_prop_clv SET model_match_status=?,model_match_reason=?,
    matched_player_id=?,model_probability=COALESCE(model_probability,?),
    edge=CASE WHEN edge IS NULL AND ? IS NOT NULL AND implied_probability IS NOT NULL
      THEN ?-implied_probability ELSE edge END WHERE rowid=?`);
  let updated = 0;
  for (const quote of pending) {
    const key = `${quote.season}|${quote.week}`;
    if (!projectionCache.has(key)) {
      const projections = Number.isInteger(quote.season) && Number.isInteger(quote.week)
        ? projectWeek(quote.season, quote.week) : [];
      projectionCache.set(key, new Map(projections.map(p => [normalizeName(p.name), p])));
    }
    const projectionIndex = projectionCache.get(key);
    const match = projectionMatch(quote, projectionIndex, knownPlayers);
    const probability = match.projection ? probabilityForQuote(quote, projectionIndex) : null;
    updated += update.run(match.status, match.reason,
      match.projection?.player_id ?? match.matched_player_id ?? null,
      probability, probability, probability, quote.rowid).changes;
  }
  return { reviewed: pending.length, updated, coverage: propMatchCoverage() };
}

/** Coverage at the two pre-registered capture horizons, including missed windows. */
export function propHorizonCoverage(now = new Date().toISOString()) {
  const eventsSeen = rows(`SELECT event_id,MIN(commence_time) commence_time,
      MIN(captured_at) first_capture,MAX(captured_at) last_capture
    FROM nfl_prop_clv WHERE commence_time IS NOT NULL GROUP BY event_id`);
  const horizons = PROP_CAPTURE_HORIZONS_HOURS.map(hours => {
    let eligible = 0, captured = 0, pending = 0, missed = 0;
    for (const event of eventsSeen) {
      const kickoff = new Date(event.commence_time).getTime();
      const at = new Date(now).getTime();
      const opens = kickoff - hours * HOUR;
      if (at < opens) { pending++; continue; }
      eligible++;
      const hit = rows(`SELECT 1 FROM nfl_prop_clv WHERE event_id=?
        AND captured_at>=? AND captured_at<? LIMIT 1`, event.event_id,
      new Date(opens).toISOString(), event.commence_time).length > 0;
      if (hit) captured++; else if (at >= kickoff) missed++; else pending++;
    }
    return { hours_before_kickoff: hours, eligible, captured, pending, missed,
      rate: eligible ? +(captured / eligible).toFixed(4) : null,
      target: 0.9, passed: eligible > 0 && captured / eligible >= 0.9 };
  });
  return { events: eventsSeen.length, horizons };
}

/** Final games that should have settled but still need identity/result attention. */
export function propSettlementHealth(now = new Date().toISOString()) {
  const deadline = new Date(new Date(now).getTime() - 24 * HOUR).toISOString();
  const grouped = rows(`SELECT market,
      SUM(settled=1) settled,
      SUM(settled=0 AND commence_time<=?) overdue,
      SUM(settled=0 AND commence_time>?) pending,
      COUNT(*) total
    FROM nfl_prop_clv GROUP BY market ORDER BY market`, deadline, deadline);
  const final = rows(`SELECT COUNT(*) total,
      SUM(settled=1 OR settlement_reason IS NOT NULL) resolved,
      SUM(settled=0 AND commence_time<=?) overdue
    FROM nfl_prop_clv WHERE commence_time<=?`, deadline, deadline)[0];
  const resolved = final?.resolved ?? 0, total = final?.total ?? 0;
  return { total_due: total, resolved, overdue: final?.overdue ?? 0,
    resolution_rate: total ? +(resolved / total).toFixed(4) : null,
    target: 0.99, passed: total > 0 && resolved / total >= 0.99,
    by_market: grouped };
}

function shadowDecisionRows() {
  const modeled = rows(`SELECT * FROM nfl_prop_clv
    WHERE model_probability IS NOT NULL AND implied_probability IS NOT NULL
      AND captured_at<commence_time
    ORDER BY captured_at,event_id,market,player,edge DESC`);
  const decisions = new Map();
  for (const quote of modeled) {
    const key = `${quote.event_id}|${quote.market}|${normalizeName(quote.player)}`;
    const current = decisions.get(key);
    if (!current || quote.captured_at < current.captured_at
      || (quote.captured_at === current.captured_at && quote.edge > current.edge)) decisions.set(key, quote);
  }
  return [...decisions.values()].filter(quote => quote.edge > 0);
}

function logisticCalibration(points) {
  if (points.length < 20) return { intercept: null, slope: null };
  let a = 0, b = 1;
  for (let iteration = 0; iteration < 30; iteration++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const point of points) {
      const x = Math.log(Math.max(1e-6, point.p) / Math.max(1e-6, 1 - point.p));
      const fitted = 1 / (1 + Math.exp(-(a + b * x))), weight = fitted * (1 - fitted);
      const residual = point.y - fitted;
      g0 += residual; g1 += residual * x; h00 += weight; h01 += weight * x; h11 += weight * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-9) break;
    const da = (g0 * h11 - g1 * h01) / det, db = (g1 * h00 - g0 * h01) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-7) break;
  }
  return { intercept: +a.toFixed(4), slope: +b.toFixed(4) };
}

function clusteredClvInterval(decisions, iterations = 1000) {
  const clusters = new Map();
  for (const decision of decisions) {
    if (!Number.isFinite(decision.clv_probability)) continue;
    const key = `${decision.season}|${decision.week}`;
    const list = clusters.get(key) ?? []; list.push(decision.clv_probability); clusters.set(key, list);
  }
  const weeks = [...clusters.values()];
  if (weeks.length < 2) return null;
  let state = 20260827;
  const random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 4294967296);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const values = [];
    for (let i = 0; i < weeks.length; i++) values.push(...weeks[Math.floor(random() * weeks.length)]);
    samples.push(values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  samples.sort((a, b) => a - b);
  return [+samples[Math.floor(iterations * 0.05)].toFixed(5),
    +samples[Math.floor(iterations * 0.95)].toFixed(5)];
}

/** Forward-only calibration, CLV and abstention state for each independent market. */
export function propMarketScorecards() {
  const decisions = shadowDecisionRows();
  const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)];
  };
  const markets = [...new Set([...Object.keys(MARKET_STAT), ...decisions.map(row => row.market)])];
  return markets.map(market => {
    const offered = decisions.filter(row => row.market === market);
    const settled = offered.filter(row => row.settled === 1 && row.won != null);
    const points = settled.map(row => ({ p: row.model_probability, y: row.won }));
    const brier = points.length ? points.reduce((sum, point) => sum + (point.p - point.y) ** 2, 0) / points.length : null;
    const bins = Array.from({ length: 10 }, () => []);
    for (const point of points) bins[Math.min(9, Math.floor(point.p * 10))].push(point);
    const ece = points.length ? bins.reduce((sum, bin) => {
      if (!bin.length) return sum;
      const predicted = bin.reduce((s, point) => s + point.p, 0) / bin.length;
      const actual = bin.reduce((s, point) => s + point.y, 0) / bin.length;
      return sum + bin.length / points.length * Math.abs(predicted - actual);
    }, 0) : null;
    const calibration = logisticCalibration(points);
    const clv = offered.map(row => row.clv_probability).filter(Number.isFinite);
    const meanClv = clv.length ? clv.reduce((sum, value) => sum + value, 0) / clv.length : null;
    const interval = clusteredClvInterval(offered);
    const gates = {
      sample: settled.length >= 75,
      mean_clv: meanClv != null && meanClv > 0,
      median_clv: median(clv) != null && median(clv) > 0,
      clustered_clv: interval != null && interval[0] > 0,
      ece: ece != null && ece <= 0.03,
      slope: calibration.slope != null && calibration.slope >= 0.85 && calibration.slope <= 1.15
    };
    const promoted = Object.values(gates).every(Boolean);
    return { market, shadow_decisions: offered.length, settled: settled.length,
      brier: brier == null ? null : +brier.toFixed(4), ece: ece == null ? null : +ece.toFixed(4),
      calibration, mean_clv: meanClv == null ? null : +meanClv.toFixed(5),
      median_clv: median(clv), clv_ci90_week_clustered: interval, gates,
      status: promoted ? 'pilot_review_eligible' : settled.length < 75 ? 'accumulating' : 'abstain',
      staking_authority: promoted ? 'capped human-reviewed pilot' : '0u' };
  });
}
