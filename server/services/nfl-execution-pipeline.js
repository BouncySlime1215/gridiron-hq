/**
 * Connect the existing selected spread candidates to exact-contract execution records.
 * Resolve one scheduled provider event and the latest usable decision-time quote.
 * Live delay previews stay pending; this connector does not confirm a fill.
 * Full abstention persistence and T−60 forecast freezing remain separate work packages.
 */
import { row, rows } from '../db/index.js';
import { contractKey } from './nfl-contract-key.js';
import { teamResolver } from './team-codes.js';
import { nflKickoffDate } from './date-util.js';
import { autoPickDecisionBoard } from './nfl-auto-picks.js';
import { NFL_PRODUCTION_POLICY } from './nfl-policy.js';
import { openOpportunity, recordObserved, recordDecision, settleOpportunity,
  listOpportunities } from './nfl-execution-lifecycle.js';
import { replayDelayLadder, timelineFromQuoteTape, DEFAULT_MAX_STALENESS_SECONDS } from './nfl-execution-replay.js';
import { executionTime, validAmericanPrice, spreadContractTerms } from './nfl-execution-validation.js';

export const EXECUTION_PIPELINE_VERSION = 'nfl-execution-pipeline-v2';
export const PIPELINE_MARKET = 'spread'; // nfl-auto-picks.js's own convention (singular); contractKey() normalizes to 'spreads'.

/** 'home' or 'away', from whichever team the candidate actually selected. */
function sideFor(candidate) {
  if (candidate.selection === candidate.home_team) return 'home';
  if (candidate.selection === candidate.away_team) return 'away';
  return null;
}

/**
 * The quote this opportunity is opened against, and how much to trust it.
 * Real multi-book history if the quote tape happens to cover this event;
 * otherwise the single snapshot the decision board itself already captured
 * from `game_lines`, honestly labeled as a single sample rather than a real
 * timeline. `sideKey`/`market` follow nfl-quote-tape.js's own conventions
 * (spreads/totals/h2h, home/away/over/under) — the same ones `contract.side`
 * and `contract.market` already resolve to, since contractKey() normalizes
 * onto the identical vocabulary.
 */
function resolveQuoteBasis(candidate, contract, { decisionAt = new Date().toISOString(),
  maxStalenessSeconds = DEFAULT_MAX_STALENESS_SECONDS, allowHistorical = false } = {}) {
  const decisionTime = executionTime(decisionAt);
  if (!Number.isFinite(decisionTime) || typeof candidate.book !== 'string' || !candidate.book.trim()) return null;
  const resolve = teamResolver();
  const matches = rows(`SELECT DISTINCT provider,provider_event_id,home_team,away_team
    FROM nfl_quote_tape WHERE julianday(commence_time)=julianday(?)`, contract.kickoff)
    .filter(e => resolve(e.home_team)?.abbr === contract.home && resolve(e.away_team)?.abbr === contract.away);
  const identities = new Map(matches.map(e => [`${e.provider}|${e.provider_event_id}`, e]));
  if (identities.size > 1) return { error: 'ambiguous_provider_event' };
  const event = [...identities.values()][0];
  let timeline, provenance, providerEventId = null;
  if (event) {
    providerEventId = event.provider_event_id;
    timeline = timelineFromQuoteTape({ providerEventId, provider: event.provider,
      commenceTime: contract.kickoff, period: contract.period,
      market: contract.market, sideKey: contract.side, book: candidate.book, line: contract.line,
      clock: allowHistorical ? 'snapshot' : 'received', mode: allowHistorical ? null : 'current' });
    provenance = allowHistorical ? 'quote_tape_historical_diagnostic' : 'quote_tape';
    // Covered event with no matching book/period/clock is a gap, not permission to use a fallback.
    if (!timeline.length) return { error: 'no_compatible_quote_history' };
  } else {
    if (!validAmericanPrice(candidate.american_price) || !Number.isFinite(executionTime(candidate.quote_at))) return null;
    const at = new Date(executionTime(candidate.quote_at)).toISOString();
    timeline = [{ snapshot_at: at, type: 'quote', price: candidate.american_price,
      line: contract.line, quote_id: null }];
    provenance = 'decision_board_single_sample';
  }
  const eligible = timeline.filter(q => executionTime(q.snapshot_at) <= decisionTime);
  const latestAt = eligible.at(-1)?.snapshot_at;
  const latest = eligible.filter(q => q.snapshot_at === latestAt);
  if (latest.length > 1 && new Set(latest.map(q => `${q.type}|${q.line}|${q.price}`)).size > 1) {
    return { error: 'ambiguous_decision_quote' };
  }
  const quote = latest.at(-1);
  if (!quote || quote.type !== 'quote') return { error: quote ? 'contract_unavailable' : 'no_decision_quote' };
  if (!validAmericanPrice(quote.price)) return { error: 'invalid_decision_price' };
  if (quote.book_updated_at && (!Number.isFinite(executionTime(quote.book_updated_at))
      || executionTime(quote.book_updated_at) > decisionTime)) return { error: 'invalid_book_update_time' };
  if ((decisionTime - executionTime(quote.snapshot_at)) / 1000 > maxStalenessSeconds) return { error: 'stale_decision_quote' };
  return { timeline: eligible, quote, provenance, provider_event_id: providerEventId };
}

/**
 * Run the connector for one week's decision board. `autoPickDecisionBoard`
 * is cached by content fingerprint (see nfl-auto-picks.js), so calling it
 * here costs nothing extra when the week's lines haven't changed.
 *
 * `policy` defaults to the real production policy. Passing
 * `NFL_HISTORICAL_REPLAY_POLICY` is a labeled diagnostic run — see
 * `nfl-policy.js`'s own `authority: 'diagnostic_only'` — never a live
 * candidate set, and never opened against real exposure by anything that
 * calls this function with it.
 */
export function runExecutionPipeline(season, week, policy = NFL_PRODUCTION_POLICY) {
  const board = autoPickDecisionBoard(season, week, policy);
  const results = [];
  const decisionAt = new Date().toISOString();
  for (const candidate of board.selected) {
    if (candidate.market !== PIPELINE_MARKET) continue; // this phase scopes to spreads only

    const homeRow = row(`SELECT gameday, gametime FROM game_lines
      WHERE season=? AND week=? AND team=? AND opponent=? AND home=1`, season, week, candidate.home_team, candidate.away_team);
    if (!homeRow) { results.push({ matchup: candidate.matchup, error: 'no scheduled game row for kickoff lookup' }); continue; }
    const kickoff = nflKickoffDate(homeRow.gameday, homeRow.gametime);
    if (!kickoff) { results.push({ matchup: candidate.matchup, error: 'could not resolve kickoff time' }); continue; }

    if (policy.authority !== 'diagnostic_only' && kickoff.getTime() <= executionTime(decisionAt)) {
      results.push({ matchup: candidate.matchup, error: 'not_pregame' }); continue;
    }

    const side = sideFor(candidate);
    if (!side) { results.push({ matchup: candidate.matchup, error: 'selection matches neither home nor away team' }); continue; }

    const contract = contractKey({ homeTeam: candidate.home_team, awayTeam: candidate.away_team,
      commenceTime: kickoff.toISOString(), market: 'spreads', side, line: candidate.line });
    if (!contract.ok) { results.push({ matchup: candidate.matchup, error: `contract resolution failed: ${contract.reason}` }); continue; }

    const open = listOpportunities({ eventKey: contract.event_key, market: contract.market })
      .find(o => o.contract_key === contract.key && o.status !== 'settled');
    if (open) { results.push({ matchup: candidate.matchup, contract_key: contract.key, skipped: 'already_open', opportunity_id: open.id }); continue; }

    const basis = resolveQuoteBasis(candidate, contract, { decisionAt, allowHistorical: policy.authority === 'diagnostic_only' });
    if (basis?.error) { results.push({ matchup: candidate.matchup, contract_key: contract.key, error: basis.error }); continue; }
    if (!basis) { results.push({ matchup: candidate.matchup, contract_key: contract.key, error: 'no usable quote to open against' }); continue; }

    // 'quote_tape' is the closest fit in nfl-execution-lifecycle.js's SOURCES
    // enum for both provenance paths: it distinguishes a system-observed
    // price from a user-recorded or settlement one, not provenance quality.
    // Quality is disclosed separately, in `quote_provenance` below.
    // Codex audit finding E4: freeze the model's own forecast here, at the
    // exact moment the opportunity is opened, so attemptAcceptance's
    // corridor/suspect-price gates have real evidence to check against later
    // instead of trusting a client-supplied number (or silently skipping the
    // checks because nothing was ever supplied). candidate.feature_snapshot
    // is the same decision-board record nfl-auto-picks.js persists.
    const opened = openOpportunity({ contract, matchup: candidate.matchup, decisionSource: EXECUTION_PIPELINE_VERSION,
      occurredAt: basis.quote.snapshot_at, book: candidate.book, line: contract.line, price: basis.quote.price,
      quoteId: basis.quote.quote_id ?? null, source: 'quote_tape',
      modelLine: candidate.feature_snapshot?.raw_forecast?.projected_margin ?? null,
      modelProbability: candidate.model_probability ?? null,
      marketLineAtDecision: candidate.feature_snapshot?.raw_forecast?.market_margin ?? null });
    const now = decisionAt;
    recordObserved(opened.id, { occurredAt: now, book: candidate.book, line: contract.line, price: basis.quote.price, quoteId: basis.quote.quote_id ?? null });

    const replay = replayDelayLadder({ timeline: basis.timeline, decisionAt: now, observedThrough: now });
    const decided = recordDecision(opened.id, { occurredAt: now, book: candidate.book, line: contract.line,
      price: basis.quote.price, quoteId: basis.quote.quote_id ?? null,
      detail: { pipeline_version: EXECUTION_PIPELINE_VERSION, quote_provenance: basis.provenance,
        provider_event_id: basis.provider_event_id, quote_id: basis.quote.quote_id ?? null,
        quote_snapshot_at: basis.quote.source_snapshot_at ?? basis.quote.snapshot_at,
        quote_received_at: basis.quote.received_at ?? null, decision_at: decisionAt,
        book_updated_at: basis.quote.book_updated_at ?? null, edge_points: candidate.edge_points,
        policy_id: policy.id, policy_version: policy.version, delayed_execution_preview: replay,
        preview_note: 'Future delay buckets remain pending until observed. A quoted price is not a confirmed fill; ' +
          'the decision-board fallback is a single observation, not multi-book history.'  } });

    results.push({ matchup: candidate.matchup, contract_key: contract.key, opened: true,
      opportunity_id: decided.id, quote_provenance: basis.provenance, replay_preview: replay });
  }
  return { season, week, policy_id: policy.id, policy_version: policy.version,
    pipeline_version: EXECUTION_PIPELINE_VERSION, candidates_selected: board.selected.length, results };
}

/** 'nfl|2026-09-13|CHI@CAR' -> { gameDate, away, home }. */
function parseEventKey(eventKey) {
  const m = /^nfl\|(\d{4}-\d{2}-\d{2})\|([A-Za-z]+)@([A-Za-z]+)$/.exec(String(eventKey ?? ''));
  return m ? { gameDate: m[1], away: m[2], home: m[3] } : null;
}

/**
 * Settle every ACCEPTED opportunity this pipeline (or a human, via the same
 * exact-contract ledger) opened, whose game now has a final score in
 * `game_lines`. Reuses the exact settlement convention
 * `nfl-auto-picks.js#gradePick` already established for this market (margin
 * vs. line, from the SELECTED team's own row) so the same game grades
 * identically whether it is read from the auto-picks board or this ledger —
 * two definitions of "won" for the same market would be its own bug.
 */
export function settleExecutionOpportunities({ occurredAt = new Date().toISOString() } = {}) {
  const open = listOpportunities({ status: 'accepted', market: 'spreads', limit: 5000 });
  const settled = [], skipped = [];
  for (const opp of open) {
    const parsed = parseEventKey(opp.event_key);
    if (!parsed) { skipped.push({ id: opp.id, reason: 'unparseable_event_key' }); continue; }
    const selectionTeam = opp.side === 'home' ? parsed.home : opp.side === 'away' ? parsed.away : null;
    if (!selectionTeam) { skipped.push({ id: opp.id, reason: 'unresolved_side' }); continue; }
    const terms = spreadContractTerms(opp.contract_key);
    if (!terms || terms.period !== 'full_game' || terms.overtime !== 'ot_included' || terms.side !== opp.side) {
      skipped.push({ id: opp.id, reason: 'unsupported_settlement_contract' }); continue;
    }
    const opponent = opp.side === 'home' ? parsed.away : parsed.home;
    const games = rows(`SELECT * FROM game_lines WHERE gameday=? AND team=? AND opponent=? AND home=?`,
      parsed.gameDate, selectionTeam, opponent, opp.side === 'home' ? 1 : 0);
    if (games.length !== 1) { skipped.push({ id: opp.id, reason: games.length ? 'ambiguous_game_result' : 'game_not_final' }); continue; }
    const g = games[0];
    const other = row(`SELECT * FROM game_lines WHERE season=? AND week=? AND gameday=? AND team=? AND opponent=? AND home=?`,
      g.season, g.week, parsed.gameDate, opponent, selectionTeam, opp.side === 'home' ? 0 : 1);
    const scores = [g.team_score, g.opp_score, other?.team_score, other?.opp_score];
    if (!scores.every(x => Number.isInteger(x) && x >= 0)) {
      skipped.push({ id: opp.id, reason: 'game_not_final' }); continue;
    }
    if (g.team_score !== other.opp_score || g.opp_score !== other.team_score) {
      skipped.push({ id: opp.id, reason: 'conflicting_game_result' }); continue;
    }
    const kickoff = nflKickoffDate(g.gameday, g.gametime);
    if (!kickoff || kickoff.getTime() >= executionTime(occurredAt)) {
      skipped.push({ id: opp.id, reason: 'game_not_final' }); continue;
    }
    const accepted = rows(`SELECT line FROM nfl_execution_lifecycle_events WHERE opportunity_id=? AND state='accepted'`, opp.id)[0];
    if (!accepted || !Number.isFinite(accepted.line) || accepted.line !== terms.line) { skipped.push({ id: opp.id, reason: 'no_accepted_line' }); continue; }
    const margin = g.team_score - g.opp_score;
    const pushed = margin === -accepted.line;
    const covered = margin > -accepted.line;
    const result = pushed ? 'push' : covered ? 'won' : 'lost';
    // settleOpportunity (not a hand-rolled recordState call) is what actually
    // computes realized P&L -- from the price genuinely recorded as ACCEPTED,
    // never a number re-derived here that could quietly drift from it.
    const record = settleOpportunity(opp.id, { occurredAt, result });
    settled.push({ id: opp.id, result, realized_pnl_units: record.events.find(e => e.state === 'settled')?.realized_pnl_units ?? null });
  }
  return { settled, skipped };
}


export const __test = { sideFor, resolveQuoteBasis, parseEventKey };
