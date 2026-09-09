/**
 * Phase 2 of the profitability execution brief: one strategy, connected all
 * the way from a quote through to a settled, exact-contract ledger row with
 * real realized P&L — for the one market this phase scopes to, same-line
 * NFL spreads.
 *
 * This module does not decide anything. `nfl-auto-picks.js#autoPickDecisionBoard`
 * already runs the frozen policy (`nfl-policy.js`) over the week's ensemble
 * and records every candidate AND every abstention with its reason — that is
 * the "frozen policy evaluated -> candidate or abstention recorded" step, and
 * rebuilding it here would be exactly the duplicate-system risk the plan
 * warns against ("provide adapters ... rather than creating a parallel
 * system"). What that system was never built to answer, because its own
 * `units_staked` is deliberately fixed at zero pending the forward gates
 * (see nfl-auto-picks.js's header), is the three things Package H exists
 * for: exact contract identity, a genuine delayed-execution obtainability
 * check, and a real ACCEPT/SETTLE path with actual realized P&L. This module
 * is the connector.
 *
 * The pipeline, per selected candidate:
 *   1. Resolve the exact contract (nfl-contract-key.js) from the candidate's
 *      matchup, market and line. A candidate whose contract cannot be
 *      resolved is reported as an error, never silently dropped.
 *   2. Look for an OPEN (not yet settled) opportunity already addressed by
 *      that exact contract key. If one exists, this run is idempotent —
 *      nothing is re-opened.
 *   3. Otherwise, determine the quote this opportunity is OFFERED and
 *      OBSERVED against. `nfl_quote_tape` (the multi-book, per-poll archive)
 *      is tried first, because it is the honest source with real
 *      market-status history (see nfl-execution-replay.js). It currently
 *      spans one real week (2026-09-02 to 09-07 — see
 *      docs/PROFITABILITY_EXECUTION_PLAN.md), so most weeks fall back to the
 *      single price the decision board itself captured from `game_lines`.
 *      Both paths are labeled on the result (`quote_provenance`); a reader
 *      must never mistake a single-sample fallback for real multi-book
 *      history.
 *   4. Record OFFERED, OBSERVED and DECISION with that provenance.
 *   5. Run a delayed-execution replay (nfl-execution-replay.js) against
 *      whatever timeline was actually available and attach it to the
 *      DECISION event's detail — the "paper execution assessment" the plan
 *      asks for, computed automatically and BEFORE any human decides
 *      whether to accept, never after.
 *
 * Acceptance is deliberately NOT automatic. `nfl-execution-decision.js`'s
 * `attemptAcceptance` — exposure budget, market-line corridor, suspect-price
 * — requires a real stake size a human supplies; this pipeline only ever
 * gets an opportunity to DECISION and stops. See `server/routes/nfl-market.js`
 * for the accept endpoint that calls attemptAcceptance directly against a
 * pipeline-opened opportunity id.
 */
import { row, rows } from '../db/index.js';
import { contractKey } from './nfl-contract-key.js';
import { teamResolver } from './team-codes.js';
import { nflKickoffDate } from './date-util.js';
import { autoPickDecisionBoard } from './nfl-auto-picks.js';
import { NFL_PRODUCTION_POLICY } from './nfl-policy.js';
import { openOpportunity, recordObserved, recordDecision, settleOpportunity,
  listOpportunities } from './nfl-execution-lifecycle.js';
import { replayDelayLadder, timelineFromQuoteTape } from './nfl-execution-replay.js';

export const EXECUTION_PIPELINE_VERSION = 'nfl-execution-pipeline-v1';
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
function resolveQuoteBasis(candidate, contract) {
  // nfl_quote_tape stores whatever team names the Odds API sent ("Kansas City
  // Chiefs"); contract.home/away are always the resolved abbreviation
  // ("KC") -- contractKey()'s own event identity, per nfl-contract-key.js.
  // Comparing the raw strings would never match; both sides are resolved
  // through the same team-codes.js resolver every other cross-source join in
  // this codebase already uses (see odds-archive.js).
  const resolve = teamResolver();
  const candidateEvents = rows(`SELECT DISTINCT provider_event_id, home_team, away_team FROM nfl_quote_tape`);
  const matchedEvent = candidateEvents.find(e =>
    resolve(e.home_team)?.abbr === contract.home && resolve(e.away_team)?.abbr === contract.away);
  const providerEventId = matchedEvent?.provider_event_id ?? null;
  if (providerEventId) {
    const timeline = timelineFromQuoteTape({ providerEventId, market: contract.market,
      sideKey: contract.side, book: candidate.book, line: contract.line });
    if (timeline.length) {
      return { timeline, provenance: 'quote_tape', provider_event_id: providerEventId,
        quote: timeline.find(t => t.type === 'quote') ?? null };
    }
  }
  if (!Number.isFinite(candidate.american_price) || !candidate.quote_at) return null;
  const snapshotAt = new Date(candidate.quote_at.includes('T') ? candidate.quote_at
    : `${candidate.quote_at.replace(' ', 'T')}Z`).toISOString();
  const single = { snapshot_at: snapshotAt, type: 'quote', price: candidate.american_price, line: contract.line };
  return { timeline: [single], provenance: 'decision_board_single_sample', provider_event_id: null, quote: single };
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
  for (const candidate of board.selected) {
    if (candidate.market !== PIPELINE_MARKET) continue; // this phase scopes to spreads only

    const homeRow = row(`SELECT gameday, gametime FROM game_lines
      WHERE season=? AND week=? AND team=? AND home=1`, season, week, candidate.home_team);
    if (!homeRow) { results.push({ matchup: candidate.matchup, error: 'no scheduled game row for kickoff lookup' }); continue; }
    const kickoff = nflKickoffDate(homeRow.gameday, homeRow.gametime);
    if (!kickoff) { results.push({ matchup: candidate.matchup, error: 'could not resolve kickoff time' }); continue; }

    const side = sideFor(candidate);
    if (!side) { results.push({ matchup: candidate.matchup, error: 'selection matches neither home nor away team' }); continue; }

    const contract = contractKey({ homeTeam: candidate.home_team, awayTeam: candidate.away_team,
      commenceTime: kickoff.toISOString(), market: 'spreads', side, line: candidate.line });
    if (!contract.ok) { results.push({ matchup: candidate.matchup, error: `contract resolution failed: ${contract.reason}` }); continue; }

    const open = listOpportunities({ eventKey: contract.event_key, market: contract.market })
      .find(o => o.contract_key === contract.key && o.status !== 'settled');
    if (open) { results.push({ matchup: candidate.matchup, contract_key: contract.key, skipped: 'already_open', opportunity_id: open.id }); continue; }

    const basis = resolveQuoteBasis(candidate, contract);
    if (!basis) { results.push({ matchup: candidate.matchup, contract_key: contract.key, error: 'no usable quote to open against' }); continue; }

    // 'quote_tape' is the closest fit in nfl-execution-lifecycle.js's SOURCES
    // enum for both provenance paths: it distinguishes a system-observed
    // price from a user-recorded or settlement one, not provenance quality.
    // Quality is disclosed separately, in `quote_provenance` below.
    const opened = openOpportunity({ contract, matchup: candidate.matchup, decisionSource: EXECUTION_PIPELINE_VERSION,
      occurredAt: basis.quote.snapshot_at, book: candidate.book, line: contract.line, price: basis.quote.price,
      source: 'quote_tape' });
    const now = new Date().toISOString();
    recordObserved(opened.id, { occurredAt: now, book: candidate.book, line: contract.line, price: basis.quote.price });

    const replay = replayDelayLadder({ timeline: basis.timeline, decisionAt: now });
    const decided = recordDecision(opened.id, { occurredAt: now, book: candidate.book, line: contract.line,
      price: basis.quote.price,
      detail: { pipeline_version: EXECUTION_PIPELINE_VERSION, quote_provenance: basis.provenance,
        provider_event_id: basis.provider_event_id, edge_points: candidate.edge_points,
        policy_id: policy.id, policy_version: policy.version, delayed_execution_preview: replay,
        preview_note: basis.provenance === 'decision_board_single_sample'
          ? 'Single captured price, not a real multi-book timeline — every delay bucket above trivially ' +
            'reads filled_as_decided because there is no later sample to diverge from. This is an honest ' +
            'absence of data, not evidence the price would have held.'
          : 'Computed against the real multi-book quote tape for this event.' } });

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
export function settleExecutionOpportunities() {
  const open = listOpportunities({ status: 'accepted', market: 'spreads', limit: 5000 });
  const settled = [], skipped = [];
  for (const opp of open) {
    const parsed = parseEventKey(opp.event_key);
    if (!parsed) { skipped.push({ id: opp.id, reason: 'unparseable_event_key' }); continue; }
    const selectionTeam = opp.side === 'home' ? parsed.home : opp.side === 'away' ? parsed.away : null;
    if (!selectionTeam) { skipped.push({ id: opp.id, reason: 'unresolved_side' }); continue; }
    const g = row(`SELECT team_score, opp_score FROM game_lines WHERE gameday=? AND team=?`, parsed.gameDate, selectionTeam);
    if (!g || g.team_score == null) { skipped.push({ id: opp.id, reason: 'game_not_final' }); continue; }
    const accepted = rows(`SELECT line FROM nfl_execution_lifecycle_events WHERE opportunity_id=? AND state='accepted'`, opp.id)[0];
    if (!accepted || !Number.isFinite(accepted.line)) { skipped.push({ id: opp.id, reason: 'no_accepted_line' }); continue; }
    const margin = g.team_score - g.opp_score;
    const pushed = margin === -accepted.line;
    const covered = margin > -accepted.line;
    const result = pushed ? 'push' : covered ? 'won' : 'lost';
    // settleOpportunity (not a hand-rolled recordState call) is what actually
    // computes realized P&L -- from the price genuinely recorded as ACCEPTED,
    // never a number re-derived here that could quietly drift from it.
    const record = settleOpportunity(opp.id, { occurredAt: new Date().toISOString(), result });
    settled.push({ id: opp.id, result, realized_pnl_units: record.events.find(e => e.state === 'settled')?.realized_pnl_units ?? null });
  }
  return { settled, skipped };
}


export const __test = { sideFor, resolveQuoteBasis, parseEventKey };
