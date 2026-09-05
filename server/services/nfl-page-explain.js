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
// never turns into an unbounded agent. On the last allowed round `tools` is
// omitted so Claude MUST answer in text — if it still had more lookups queued
// up, that gets surfaced as an honest limitation rather than silently dropped.
const MAX_TOOL_ROUNDS = 4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMINOLOGY_PATH = path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'betting', 'TERMINOLOGY.md');

let cachedTerminology = null;
function terminologyGlossary() {
  if (cachedTerminology != null) return cachedTerminology;
  try { cachedTerminology = fs.readFileSync(TERMINOLOGY_PATH, 'utf8'); }
  catch { cachedTerminology = '(glossary unavailable — explain conservatively and avoid disputed terms)'; }
  return cachedTerminology;
}

// Kept in sync BY HAND with client/src/pages/betting/copy.ts's NOT_PROVEN_MESSAGE.
// The server can't import client TypeScript (separate build), so this is the
// one place the server needs the exact same sentence, verbatim.
export const NOT_PROVEN_MESSAGE =
  "This model hasn't beaten the real betting lines yet, so no real money is at risk — everything below is practice, tracked so we'll know the moment that changes.";

function systemPrompt() {
  return `${GROUNDING_SYSTEM}

You are the "what am I looking at" assistant embedded on a personal NFL/MLB betting research desk. You explain the page currently on screen using the glossary below, the visible_summary object supplied in the user message, and — only when a question needs real backend detail beyond visible_summary — the read-only lookup tools available to you. Never use outside knowledge of teams, players, injuries, matchups, or odds; only the glossary, visible_summary, event_context, and whatever a tool call actually returns.

GLOSSARY — the canonical meaning of every term used on this desk. Use these words and these meanings exactly; do not invent a synonym that blurs a distinction the glossary deliberately draws (e.g. never call a price-improvement number "edge", never call a break-even rate a "win rate").

${terminologyGlossary()}

TOOL USE — every tool is READ-ONLY. There is no tool, and no argument to any tool, that can place a bet, size a stake, change a pick, or override a gate/verdict — they only fetch already-stored facts (a game's real per-expert projection breakdown, a market's real calibration history, a tracked pick's real generation-vs-current price detail, a real variable definition, real decay-watch status). Call a tool when the user's question needs real, specific backend detail that visible_summary/event_context doesn't already give you — e.g. "why do we project this game this way" needs game_projection_breakdown, not a generic guess. Prefer answering directly from visible_summary/event_context when they already contain what's needed; don't call a tool just to confirm something you were already told. You get at most a few tool-call rounds — if you run out before you have everything, say plainly in "limitations" that a lookup was cut short, rather than inventing the rest.

Hard rules, no exceptions:
- You explain what is on screen and, when you use a tool, what that tool actually returned. You can NEVER claim to place a bet, size a stake, change a pick, or override any gate/verdict the app itself has already rendered — you are explanation-only.
- If visible_summary or the route/section indicates a gate is closed, staking is off, or the desk is in "not proven" mode, say so plainly and do not soften or contradict it. The desk's own standing sentence on this, when relevant: "${NOT_PROVEN_MESSAGE}"
- Never invent a number, team name, game, or fact that is not present in route/section/subview/visible_summary/event_context or in an actual tool result. If something isn't in there, say it isn't visible from here rather than guessing.
- If visible_summary is just \`{"page_registered_visible_summary": false}\`, this page hasn't wired up telling you what it specifically renders yet. Say plainly that you can tell the user is on this route/section but this page hasn't told you what's specifically on screen — do not invent page contents to fill the gap. You can still use a tool if the question is answerable from event_context or general backend lookups (a variable definition, decay-watch status) rather than from page-specific detail.
- Keep the final answer to 3-5 sentences, and make it specific to the actual fields you were given or fetched — an answer generic enough to fit any page is a failure.
- Once you are ready to give your final answer (whether or not you used a tool), respond with ONLY the JSON object described below — no other text, and no further tool calls.`;
}

function userPrompt({ route, section, subview, visibleSummary, eventContext, question }) {
  return `ROUTE: ${route ?? 'unknown'}
SECTION: ${section ?? 'unknown'}
SUBVIEW: ${subview ?? 'none'}
VISIBLE_SUMMARY (a small, honest summary of what is actually rendered right now — treat as the complete set of facts you have about this screen unless a tool gives you more): ${JSON.stringify(visibleSummary ?? {})}
EVENT_CONTEXT (identifying info for whatever specific game/pick/market is currently in view, if any — use these exact values as tool arguments rather than guessing): ${JSON.stringify(eventContext ?? {})}
${question?.trim() ? `USER QUESTION: ${question.trim()}` : 'USER QUESTION: (none typed — give the default "what am I looking at" explanation)'}

If you need real backend detail beyond what's above, call one of your tools. Otherwise, return ONLY JSON with:
{
  "paragraph": "3-5 sentences explaining what this page/section is showing right now, in this desk's own terminology, answering the user question if one was asked",
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
      // Tools omitted on the final round so Claude cannot ask for yet another
      // lookup it won't get to run — it must answer in text.
      tools: isFinalRound ? undefined : TOOLS
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
