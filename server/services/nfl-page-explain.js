/**
 * "What am I looking at" explainer for the betting desk — one call that
 * knows every page/section/subview and answers using the desk's own glossary
 * (client/src/pages/betting/TERMINOLOGY.md) plus a small, page-specific
 * `visibleSummary` object the caller already has in hand for rendering.
 *
 * Same "AI explains, never decides" discipline as nfl-pick-explain-ai (see
 * nfl-pick-explanation-audit.js and the /explain/ai route in nfl-betting.js):
 * this can never place a bet, size a stake, or override a gate/verdict shown
 * on screen — it only describes, in plain English and this desk's own
 * vocabulary, what is already there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callClaude, GROUNDING_SYSTEM, parseJson } from './claude.js';
import { TOOLS, runTool } from './page-explain-tools.js';

// Hard cap on the tool-use loop: bounds cost/latency and guarantees this
// never turns into an unbounded agent. On the last allowed round tool_choice is
// "none" so Claude answers in text — if it still had more lookups queued up,
// that gets surfaced as an honest limitation rather than silently dropped. The
// tools stay declared: the history already holds tool_use/tool_result blocks.
const MAX_TOOL_ROUNDS = 4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMINOLOGY_PATH = path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'betting', 'TERMINOLOGY.md');

// The glossary file went with the betting UI teardown. When it is missing the
// prompt says nothing about a glossary at all, rather than promising "these
// meanings exactly" and handing over a placeholder the model fills from training.
let cachedTerminology;
function terminologyGlossary() {
  if (cachedTerminology !== undefined) return cachedTerminology;
  try { cachedTerminology = fs.readFileSync(TERMINOLOGY_PATH, 'utf8'); }
  catch { cachedTerminology = null; }
  return cachedTerminology;
}

// Kept in sync BY HAND with client/src/pages/betting/copy.ts's NOT_PROVEN_MESSAGE.
// The server can't import client TypeScript (separate build), so this is the
// one place the server needs the exact same sentence, verbatim.
export const NOT_PROVEN_MESSAGE =
  "This model hasn't beaten the real betting lines yet, so no real money is at risk — everything below is practice, tracked so we'll know the moment that changes.";

function systemPrompt() {
  const glossary = terminologyGlossary();
  const sources = glossary ? 'the glossary below, visible_summary, event_context' : 'visible_summary, event_context';
  return `${GROUNDING_SYSTEM}

You are the "what am I looking at" assistant embedded on a personal NFL/MLB betting research desk. You explain the page currently on screen from ${sources} and whatever a read-only lookup tool actually returns. Outside knowledge of teams, players, injuries, matchups, or odds is not a source here.
${glossary ? `
GLOSSARY — the canonical meaning of every term used on this desk. Use these words and these meanings exactly; do not invent a synonym that blurs a distinction the glossary deliberately draws.

${glossary}
` : ''}
Keep the desk's distinctions: a price-improvement number is not "edge", and a break-even rate is not a "win rate".

TOOLS. Every tool is read-only: they fetch already-stored facts (a game's per-expert projection breakdown, a market's calibration history, a tracked pick's generation-vs-current price, a variable definition, decay-watch status), and none can place a bet, size a stake, change a pick, or override a gate or verdict. Call one when the question needs backend detail that visible_summary/event_context does not already give you — "why do we project this game this way" needs the projection breakdown, not a guess. You get a few tool rounds; if you run out before you have everything, say in "limitations" that a lookup was cut short.

What the answer must respect:
- You are explanation-only. Describe what is on screen and what a tool returned; do not claim to place a bet, size a stake, change a pick, or override a gate or verdict the app has rendered.
- If visible_summary or the route/section shows a closed gate, staking off, or the desk in "not proven" mode, say so plainly without softening it. The desk's standing sentence on this, when relevant: "${NOT_PROVEN_MESSAGE}"
- Every number, team, game, or fact comes from route/section/subview/visible_summary/event_context or an actual tool result. If something is not there, say it is not visible from here.
- If visible_summary is just \`{"page_registered_visible_summary": false}\`, this page has not wired up telling you what it renders. Say that you can tell which route/section the user is on but not what is specifically on screen, rather than inventing page contents. A tool can still answer questions that event_context or a general lookup (a variable definition, decay-watch status) covers.
- Answer in a short paragraph built from the actual fields you were given or fetched — an answer generic enough to fit any page is a failure.`;
}

function userPrompt({ route, section, subview, visibleSummary, eventContext, question }) {
  return `ROUTE: ${route ?? 'unknown'}
SECTION: ${section ?? 'unknown'}
SUBVIEW: ${subview ?? 'none'}
VISIBLE_SUMMARY (a small, honest summary of what is actually rendered right now — treat as the complete set of facts you have about this screen unless a tool gives you more): ${JSON.stringify(visibleSummary ?? {})}
EVENT_CONTEXT (identifying info for whatever specific game/pick/market is currently in view, if any — use these exact values as tool arguments rather than guessing): ${JSON.stringify(eventContext ?? {})}
${question?.trim() ? `USER QUESTION: ${question.trim()}` : 'USER QUESTION: (none typed — give the default "what am I looking at" explanation)'}

If you need real backend detail beyond what's above, call one of your tools. When you are ready to answer, reply with only this JSON object:
{
  "paragraph": "a short paragraph explaining what this page/section is showing right now, in this desk's own terminology, answering the user question if one was asked",
  "limitations": ["short note on anything you still don't have visibility into, only if relevant — otherwise an empty array"]
}`;
}

/**
 * @param {{route:string, section?:string|null, subview?:string|null,
 *   visibleSummary?: object, eventContext?: object|null, question?: string|null}} args
 * @returns {Promise<{paragraph:string, limitations:string[], toolCalls: {name:string, input:object}[]}>}
 */
export async function explainPage({ route, section, subview, visibleSummary, eventContext, question }) {
  const messages = [{ role: 'user', content: userPrompt({ route, section, subview, visibleSummary, eventContext, question }) }];
  const toolCalls = [];

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const isFinalRound = round === MAX_TOOL_ROUNDS;
    const msg = await callClaude({
      feature: 'nfl-page-explain-ai', maxTokens: 700, system: systemPrompt(), messages,
      // tool_choice "none" on the final round so Claude cannot ask for yet
      // another lookup it won't get to run — it must answer in text.
      tools: TOOLS,
      toolChoice: isFinalRound ? { type: 'none' } : undefined
    });

    const toolUseBlocks = (msg.content ?? []).filter(block => block.type === 'tool_use');
    if (toolUseBlocks.length && !isFinalRound) {
      messages.push({ role: 'assistant', content: msg.content });
      const toolResults = toolUseBlocks.map(block => {
        toolCalls.push({ name: block.name, input: block.input ?? {} });
        const result = runTool(block.name, block.input);
        // Cap each tool result's size in the conversation — these are small,
        // real JSON read-throughs already, but this keeps token cost bounded
        // even if a lookup returns a wide table.
        return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result).slice(0, 6000) };
      });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const parsed = parseJson(msg);
    if (typeof parsed.paragraph !== 'string' || !parsed.paragraph.trim()) {
      const err = new Error('AI page explanation did not return a grounded paragraph');
      err.status = 502;
      throw err;
    }
    let limitations = Array.isArray(parsed.limitations)
      ? parsed.limitations.filter(v => typeof v === 'string').slice(0, 5) : [];
    // The round cap was actually reached (not just "we happened to finish on
    // the last round") whenever we're forced into a tools-omitted final round
    // after already spending every earlier round on tool calls — say so
    // honestly instead of presenting a possibly-incomplete lookup as complete.
    if (isFinalRound && toolCalls.length) {
      limitations = [...limitations, 'A backend lookup was cut short by the tool-call round cap; this answer may be less complete than a further lookup would have made it.'].slice(0, 5);
    }
    return { paragraph: parsed.paragraph.trim(), limitations, toolCalls };
  }
  // Unreachable in practice: the final round always omits `tools`, so Claude
  // cannot return stop_reason `tool_use` there and the loop above always
  // returns before falling out of the for-loop. Kept as a safe, explicit
  // failure rather than an implicit `undefined`.
  const err = new Error('AI page explanation did not produce a final answer within the tool-call round cap');
  err.status = 502;
  throw err;
}
