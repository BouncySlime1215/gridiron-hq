/**
 * Read-only tool set for the page-explain assistant's tool-use loop
 * (nfl-page-explain.js). Every tool here is a pure read-through to an
 * existing, already-correct/already-audited service function — no new
 * business logic, no new tables, no new computation.
 *
 * Structural safety: every input_schema below takes only lookup keys
 * (season/week/team/market/free-text query) — there is no field through
 * which a write, mutation, bet placement, stake change, or gate override
 * could even be expressed — and every implementation only ever reads
 * already-stored rows via the existing service functions. Nothing here is
 * capable of a write, by construction, not just by policy.
 */
import { expertCouncilGame } from './nfl-expert-council.js';
import { latestCoverCalibration } from './nfl-cover-calibration.js';
import { latestTotalCalibration } from './nfl-total-calibration.js';
import { pickWatchBoard } from './nfl-pick-watch.js';
import { catalog } from './nfl-features.js';
import { decayWatchStatus } from './decay-watch.js';

export const TOOLS = [
  {
    name: 'game_projection_breakdown',
    description: 'Get the REAL per-expert model breakdown behind this app\'s NFL spread/total '
      + 'projection for one specific game: every expert\'s forecast residual, uncertainty, '
      + 'authority, and (once settled) whether it was directionally correct, plus the combined '
      + 'decision that was actually used. Use this whenever asked why a specific game is '
      + 'projected the way it is.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        season: { type: 'integer', description: 'e.g. 2026' },
        week: { type: 'integer', description: '1-18' },
        home_team: { type: 'string', description: "The home team's abbreviation, e.g. 'DAL'" }
      },
      required: ['season', 'week', 'home_team']
    }
  },
  {
    name: 'market_calibration_history',
    description: "Get the real, stored calibration metrics (reliability curve, sample size, "
      + "trained-through season) for the NFL spread ('spread') or total ('total') market. Use "
      + "this for questions about how trustworthy or well-calibrated a market's probabilities are.",
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { market: { type: 'string', enum: ['spread', 'total'] } },
      required: ['market']
    }
  },
  {
    name: 'pick_watch_detail',
    description: "Look up the real generation-time vs. current price/line detail for open picks "
      + "on the Pick Watch board, optionally filtered to one matchup and/or market ('spread'|"
      + "'total'). Use this for questions about whether a specific tracked pick's price or line "
      + 'has moved since it was made.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        matchup: { type: 'string', description: "e.g. 'DAL@PHI' — matched as a loose substring" },
        market: { type: 'string', enum: ['spread', 'total'] }
      },
      required: []
    }
  },
  {
    name: 'variable_definition',
    description: 'Look up the real definition of a model variable or term by name or keyword '
      + "from the full variable catalog (the same list VariableCatalog.tsx shows). Use this for "
      + '"what does X mean" questions about model internals.',
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', description: "e.g. 'massey', 'target_share', 'epa'" } },
      required: ['query']
    }
  },
  {
    name: 'decay_watch_status',
    description: 'Get the real current decay-watch status: for each already-approved finding, '
      + 'whether it is still performing out-of-sample or has been flagged as decayed. Use this '
      + "for 'is this still working' questions.",
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

/**
 * Execute one tool call by name. Every branch is a pure read — nothing here
 * can write, mutate, place a bet, size a stake, or override a gate.
 */
export function runTool(name, input) {
  if (!TOOL_NAMES.has(name)) return { error: `Unknown tool '${name}'` };
  try {
    switch (name) {
      case 'game_projection_breakdown': {
        const season = Number(input?.season), week = Number(input?.week), home = String(input?.home_team ?? '').trim();
        if (!Number.isFinite(season) || !Number.isFinite(week) || !home) {
          return { error: 'season, week and home_team are all required' };
        }
        return expertCouncilGame(season, week, home);
      }
      case 'market_calibration_history': {
        const market = String(input?.market ?? '');
        if (market === 'spread') {
          const c = latestCoverCalibration();
          return c ?? { available: false, reason: 'No cover calibration stored yet.' };
        }
        if (market === 'total') {
          const c = latestTotalCalibration();
          return c ?? { available: false, reason: 'No total calibration stored yet.' };
        }
        return { error: "market must be 'spread' or 'total'" };
      }
      case 'pick_watch_detail': {
        const board = pickWatchBoard();
        let picks = board.picks;
        if (input?.market) picks = picks.filter(p => p.market === input.market || p.pick_source === input.market);
        if (input?.matchup) {
          const needle = String(input.matchup).toUpperCase();
          picks = picks.filter(p => String(p.matchup ?? '').toUpperCase().includes(needle));
        }
        return {
          open: board.open, actionable: board.actionable, any_gate_open: board.any_gate_open,
          picks: picks.slice(0, 10).map(p => ({
            matchup: p.matchup, market: p.market, selection: p.selection, side: p.side,
            line_at_generation: p.line_at_generation, price_at_generation: p.price_at_generation,
            book_at_generation: p.book_at_generation, best_book: p.best_book, best_line: p.best_line,
            best_price: p.best_price, direction: p.direction, break_even_at_generation: p.break_even_at_generation,
            break_even_now: p.break_even_now, gate_open: !!p.gate_open, status: p.status
          }))
        };
      }
      case 'variable_definition': {
        const q = String(input?.query ?? '').toLowerCase().trim();
        if (!q) return { error: 'query is required' };
        const matches = catalog().filter(v => v.key.toLowerCase().includes(q) || v.description.toLowerCase().includes(q));
        return { query: q, matches: matches.slice(0, 10) };
      }
      case 'decay_watch_status':
        return decayWatchStatus();
      default:
        return { error: `Unhandled tool '${name}'` };
    }
  } catch (e) {
    return { error: `Tool '${name}' failed: ${e.message}` };
  }
}
