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

You are the "what am I looking at" assistant embedded on a personal NFL/MLB betting research desk. You explain the page currently on screen using ONLY the glossary below and the visible_summary object supplied in the user message — never outside knowledge of teams, players, injuries, matchups, or odds.

GLOSSARY — the canonical meaning of every term used on this desk. Use these words and these meanings exactly; do not invent a synonym that blurs a distinction the glossary deliberately draws (e.g. never call a price-improvement number "edge", never call a break-even rate a "win rate").

${terminologyGlossary()}

Hard rules, no exceptions:
- You explain what is on screen. You can NEVER claim to place a bet, size a stake, change a pick, or override any gate/verdict the app itself has already rendered — you are explanation-only.
- If visible_summary or the route/section indicates a gate is closed, staking is off, or the desk is in "not proven" mode, say so plainly and do not soften or contradict it. The desk's own standing sentence on this, when relevant: "${NOT_PROVEN_MESSAGE}"
- Never invent a number, team name, game, or fact that is not present in the route/section/subview/visible_summary you were given. If something isn't in there, say it isn't visible from here rather than guessing.
- Keep the answer to 3-5 sentences, and make it specific to the actual fields in visible_summary — an answer generic enough to fit any page is a failure.`;
}

/**
 * @param {{route:string, section?:string|null, subview?:string|null,
 *   visibleSummary?: object, question?: string|null}} args
 * @returns {Promise<{paragraph:string, limitations:string[]}>}
 */
export async function explainPage({ route, section, subview, visibleSummary, question }) {
  const prompt = `ROUTE: ${route ?? 'unknown'}
SECTION: ${section ?? 'unknown'}
SUBVIEW: ${subview ?? 'none'}
VISIBLE_SUMMARY (a small, honest summary of what is actually rendered right now — treat as the complete set of facts you have about this screen): ${JSON.stringify(visibleSummary ?? {})}
${question?.trim() ? `USER QUESTION: ${question.trim()}` : 'USER QUESTION: (none typed — give the default "what am I looking at" explanation)'}

Return ONLY JSON with:
{
  "paragraph": "3-5 sentences explaining what this page/section is showing right now, in this desk's own terminology, answering the user question if one was asked",
  "limitations": ["short note on anything visible_summary doesn't tell you, only if relevant — otherwise an empty array"]
}`;

  const msg = await callClaude({ feature: 'nfl-page-explain-ai', maxTokens: 500, system: systemPrompt(), prompt });
  const parsed = parseJson(msg);
  if (typeof parsed.paragraph !== 'string' || !parsed.paragraph.trim()) {
    const err = new Error('AI page explanation did not return a grounded paragraph');
    err.status = 502;
    throw err;
  }
  const limitations = Array.isArray(parsed.limitations)
    ? parsed.limitations.filter(v => typeof v === 'string').slice(0, 5) : [];
  return { paragraph: parsed.paragraph.trim(), limitations };
}
