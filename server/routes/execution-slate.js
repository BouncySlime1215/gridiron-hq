/**
 * The AI slate-reasoning endpoint.
 *
 * `POST /api/execution-slate/recommend` — reads the live shopping board and the
 * live teaser execution board, keeps only what the staking gate already permits
 * to size, and runs the bounded propose → simulate → review loop in
 * `execution-slate-reasoning.js`.
 *
 * It returns a RECOMMENDATION. Nothing here transmits a wager or moves money,
 * and no auto-execution path should be added — `nfl-teaser-execution.js` sets
 * the convention this follows: a server validates and records an execution that
 * a human decided to make.
 */
import { Router } from 'express';
import { callClaude, parseJson, getApiKey } from '../services/claude.js';
import { shoppingBoard } from '../services/nfl-shopping-board.js';
import { teaserExecutionBoard } from '../services/nfl-teaser-execution.js';
import { wongHistory } from '../services/nfl-teasers.js';
import {
  SLATE_POLICY, shoppedLineOpportunity, teaserOpportunity, gateOpportunities,
  reasonAboutSlate, proposalPrompt
} from '../services/execution-slate-reasoning.js';

const r = Router();

/**
 * Everything live that came from a PROVEN edge, gated.
 *
 * Exported for the route test and for the docs example so the shape shown to
 * Claude is the shape that was actually measured, not a paraphrase of it.
 */
export function liveOpportunities({ market = 'spreads', limit = 40 } = {}) {
  const candidates = [];
  let history = null;

  try {
    for (const rowIn of shoppingBoard({ market, limit })) {
      const o = shoppedLineOpportunity(rowIn);
      if (o) candidates.push(o);
    }
  } catch (e) {
    console.warn(`[execution-slate] shopping board unavailable: ${e.message}`);
  }

  try {
    history = wongHistory();
    const board = teaserExecutionBoard();
    for (const c of board.candidates ?? []) {
      const o = teaserOpportunity(c, { legRate: history.win_rate, standardError: history.standard_error });
      if (o) candidates.push(o);
    }
  } catch (e) {
    console.warn(`[execution-slate] teaser board unavailable: ${e.message}`);
  }

  return { ...gateOpportunities(candidates), wong_history: history };
}

r.post('/recommend', async (req, res) => {
  try {
    const { offered, blocked, wong_history } = liveOpportunities({
      market: req.body?.market ?? 'spreads',
      limit: Number(req.body?.limit) || 40
    });

    // The API key is only needed once there is something to reason about. An
    // empty slate is a real, common answer and should not require a key.
    if (offered.length && !getApiKey()) {
      return res.status(400).json({
        error: 'No Anthropic API key configured — add one in the Dev Hub to enable slate reasoning.',
        offered, blocked
      });
    }

    const prompt = proposalPrompt(offered);

    const out = await reasonAboutSlate({
      offered,

      propose: async () => {
        const parsed = parseJson(await callClaude({
          feature: 'execution-slate-propose', maxTokens: 1200, prompt
        }));
        return { allocation: parsed.slate, reasoning: parsed.reasoning };
      },

      // The review sees its own first answer as a prior turn, so it is
      // reconsidering its own allocation rather than grading a stranger's.
      // There is no threshold between the simulation and this call: the numbers
      // go over as they came out, and the decision to hold or cut is the
      // model's.
      review: async (briefing, ctx) => parseJson(await callClaude({
        feature: 'execution-slate-review', maxTokens: 900,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: JSON.stringify({
            reasoning: ctx.slate.bets.length ? 'initial allocation' : '',
            slate: ctx.slate.bets.map(b => ({ id: b.id, units: b.units, why: b.rationale }))
          }) },
          { role: 'user', content: briefing }
        ]
      }))
    });

    res.json({
      ...out,
      policy: SLATE_POLICY,
      offered,
      blocked_count: blocked.length,
      blocked,
      wong_history,
      scope_note: 'Allocation across the two edges measured positive in this repository — line ' +
        'shopping and Wong teasers. No game outcome is forecast: the drive simulator is 46.91% ' +
        'directional and is deliberately not in this path.'
    });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
});

/** The gated opportunity list on its own — no AI call, no cost. */
r.get('/opportunities', (req, res) => {
  try {
    res.json({
      ...liveOpportunities({ market: req.query.market ?? 'spreads', limit: Number(req.query.limit) || 40 }),
      policy: SLATE_POLICY
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default r;
