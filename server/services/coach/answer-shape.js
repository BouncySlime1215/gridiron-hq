/**
 * COACH-V2 section 2: the answer format, and the check that holds it.
 *
 * A model answer is one object, in this order:
 *   verdict  one line, at most 18 words, starting with a verb or "No" (or
 *            "Coach": "Coach does not read that" is a verdict); names the
 *            partner and players; a number only if it is the deciding one
 *   stance   go / wait / avoid / none
 *   basis    the deciding basis in a few words
 *   why      1-3 bullets, at most 22 words each, each with its cited number;
 *            the first is the deciding basis
 *   risks    at most 2 lines ("If no: ...", "Risk: ...")
 *   refusals what Coach could not answer (a refusal replaces Why, never the verdict)
 * Under 120 words before the cards.
 *
 * Every line carries cites and becomes a claim for verify.js exactly as before
 * (the verdict, then the why bullets, then the risks). The shape check runs after
 * verify.js: a broken verdict gets one correction round (COACH-V2 latency: other
 * blocks are not worth a round); then the offending BLOCK is dropped (an extra
 * bullet, a long bullet, extra refusal lines), never the answer.
 */

export const LIMITS = Object.freeze({ verdictWords: 18, whyMax: 3, whyWords: 22, risksMax: 2, riskWords: 22, totalWords: 120 });
export const STANCES = Object.freeze(['go', 'wait', 'avoid', 'none']);
/** COACH-V2 unit 4: the deciding basis as the ONE vocabulary Numbers & People uses (numbers-people/lanes.js BASES). */
export const BASIS_KEYS = Object.freeze(['title_gain', 'price', 'willingness', 'roster_fit', 'risk', 'timing']);

const line = { type: 'object', additionalProperties: false, required: ['text', 'cites'],
  properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } } };

export const SHAPED_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['verdict', 'stance', 'basis', 'basis_key', 'why', 'risks', 'refusals', 'as_of'],
  properties: {
    verdict: line, stance: { enum: STANCES }, basis: { type: 'string' }, basis_key: { enum: BASIS_KEYS },
    why: { type: 'array', items: line }, risks: { type: 'array', items: line },
    refusals: { type: 'array', items: { type: 'string' } },
    as_of: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  }
});

export const SHAPE_PROMPT = `

ANSWER FORMAT. Reply with the JSON object in the schema, filled like this:
- "verdict": ONE line, at most ${LIMITS.verdictWords} words, starting with a verb ("Send", "Hold", "Start", "Target") or "No". Name the partner and players. Put a number in it only if it is the deciding one. When you cannot answer, the verdict says so ("Coach does not read that.").
- "stance": go, wait, avoid, or none when the question is not about acting.
- "basis": the deciding reason in two to four words (for example "title odds gain", "his price", "your floor").
- "basis_key": the same reason as one of: title_gain (the odds the plan chases), price (value given or asked), willingness (whether he will deal), roster_fit (a lineup need), risk (injury, volatility, a weak guess), timing (why now or not now).
- "why": one to ${LIMITS.whyMax} bullets, at most ${LIMITS.whyWords} words each; the first is the deciding reason; each carries ONE cited number with its label. Empty when you refused.
- "risks": at most ${LIMITS.risksMax} lines, "If no: ..." or "Risk: ...", only when the plan has them.
- Never mention tables, columns, fields, schema, queries or any snake_case name, and never guess at them: when a fact is not on file, say so in plain words ("No health update on file yet.").
- "refusals": at most one short line, only for what you could not answer; leave it empty when the verdict and why already answer.
- Aim for about 80 words in all. Do not mention a number the plan does not serve unless Nick asked about it.
- Never write a bare count ("48", "76"): say what it counts ("48 trade paths searched").
- Numbers: probabilities and odds cells are fractions; say them as percents or points ("title_odds_now" 0.43 -> "43% title odds"; a change of 0.0875 -> "+8.8 pts of title odds"). Projections are points. Label every number.
Every line's "cites" follow the evidence rules above. Keep the whole answer under ${LIMITS.totalWords} words.`;

const words = t => String(t ?? '').trim().split(/\s+/).filter(Boolean).length;
const LEAD_NOT_VERB = /^(the|a|an|your|my|his|her|their|this|that|these|those|it|its|there|i|you|he|she|we|they|based|according|overall|right now|currently)\b/i;

/** A model's shaped object -> the answer (claims for verify.js, plus the shape). */
export function toAnswer(parsed) {
  const clean = l => (l && typeof l.text === 'string' && l.text.trim()
    ? { text: l.text.trim(), cites: Array.isArray(l.cites) ? l.cites.filter(c => typeof c === 'string') : [] } : null);
  const verdict = clean(parsed?.verdict);
  const why = (Array.isArray(parsed?.why) ? parsed.why : []).map(clean).filter(Boolean);
  const risks = (Array.isArray(parsed?.risks) ? parsed.risks : []).map(clean).filter(Boolean);
  const refusals = (Array.isArray(parsed?.refusals) ? parsed.refusals : []).filter(r => typeof r === 'string' && r.trim()).map(r => r.trim());
  const shape = { verdict, stance: STANCES.includes(parsed?.stance) ? parsed.stance : 'none',
    basis: typeof parsed?.basis === 'string' ? parsed.basis.trim() : '', basis_key: BASIS_KEYS.includes(parsed?.basis_key) ? parsed.basis_key : null, why, risks };
  return { claims: claimsOf(shape), refusals, as_of: typeof parsed?.as_of === 'string' && parsed.as_of.trim() ? parsed.as_of.trim() : null, shape };
}

/**
 * The claims verify.js checks, in reading order. A verdict with no cite and no
 * digit ("Coach does not read that.") is a plain line; one with a digit is a
 * claim, so an uncited number in it is caught like any other.
 */
export function claimsOf(shape) {
  const out = [];
  if (shape.verdict && (shape.verdict.cites.length || /\d/.test(shape.verdict.text))) out.push({ ...shape.verdict, block: 'verdict' });
  for (const w of shape.why) out.push({ ...w, block: 'why' });
  for (const r of shape.risks) out.push({ ...r, block: 'risk' });
  return out;
}

/** Shape violations: [{ block, index?, rule, detail }]. Empty is a pass. */
export function shapeCheck(answer) {
  const s = answer?.shape;
  const v = [];
  if (!s) return [{ block: 'answer', rule: 'no_shape', detail: 'the answer is not in the answer format' }];
  const verdict = s.verdict?.text ?? '';
  if (!verdict) v.push({ block: 'verdict', rule: 'missing', detail: 'there is no verdict line' });
  else {
    if (words(verdict) > LIMITS.verdictWords) v.push({ block: 'verdict', rule: 'too_long', detail: `the verdict is ${words(verdict)} words (max ${LIMITS.verdictWords})` });
    if (LEAD_NOT_VERB.test(verdict)) v.push({ block: 'verdict', rule: 'lead', detail: 'the verdict must start with a verb or "No"' });
  }
  if (!s.why.length && !answer.refusals?.length) v.push({ block: 'why', rule: 'missing', detail: 'there is no why bullet and no refusal' });
  if (s.why.length > LIMITS.whyMax) v.push({ block: 'why', rule: 'too_many', detail: `${s.why.length} why bullets (max ${LIMITS.whyMax})` });
  s.why.forEach((w, i) => { if (words(w.text) > LIMITS.whyWords) v.push({ block: 'why', index: i, rule: 'too_long', detail: `why bullet ${i + 1} is ${words(w.text)} words (max ${LIMITS.whyWords})` }); });
  if (s.risks.length > LIMITS.risksMax) v.push({ block: 'risks', rule: 'too_many', detail: `${s.risks.length} risk lines (max ${LIMITS.risksMax})` });
  s.risks.forEach((r, i) => { if (words(r.text) > LIMITS.riskWords) v.push({ block: 'risks', index: i, rule: 'too_long', detail: `risk line ${i + 1} is ${words(r.text)} words (max ${LIMITS.riskWords})` }); });
  const total = words(verdict) + s.why.reduce((n, w) => n + words(w.text), 0) + s.risks.reduce((n, r) => n + words(r.text), 0)
    + (answer.refusals ?? []).filter(r => r !== verdict).reduce((n, r) => n + words(r), 0);
  if (total > LIMITS.totalWords) v.push({ block: 'answer', rule: 'too_long', detail: `the answer is ${total} words (max ${LIMITS.totalWords})` });
  return v;
}

/** The correction turn for a shape violation. */
export function shapeCorrection(violations) {
  return `Your answer passed the number check but not the answer format:\n${violations.map(x => `- ${x.detail}`).join('\n')}\n`
    + 'Fix only the format (shorter lines, fewer bullets, a verdict that starts with a verb or "No"); keep every cite exactly as it was. Reply with only the JSON object.';
}

/**
 * After the correction round: drop the blocks that still break the format,
 * never the answer. The verdict stays (shortened answers still need one);
 * extra or over-long bullets and risk lines go. Returns { answer, dropped }.
 */
export function enforceShape(answer) {
  const s = answer.shape;
  const dropped = [];
  let why = s.why.filter((w, i) => { const ok = words(w.text) <= LIMITS.whyWords; if (!ok) dropped.push({ block: 'why', index: i, rule: 'too_long' }); return ok; });
  if (why.length > LIMITS.whyMax) { dropped.push({ block: 'why', rule: 'too_many', count: why.length - LIMITS.whyMax }); why = why.slice(0, LIMITS.whyMax); }
  let risks = s.risks.filter((r, i) => { const ok = words(r.text) <= LIMITS.riskWords; if (!ok) dropped.push({ block: 'risks', index: i, rule: 'too_long' }); return ok; });
  if (risks.length > LIMITS.risksMax) { dropped.push({ block: 'risks', rule: 'too_many', count: risks.length - LIMITS.risksMax }); risks = risks.slice(0, LIMITS.risksMax); }
  // Over the total: the risk lines go first, then the last why bullets (the first, deciding one stays).
  let refusals = [...(answer.refusals ?? [])];
  const total = () => words(s.verdict?.text) + why.reduce((n, w) => n + words(w.text), 0) + risks.reduce((n, r) => n + words(r.text), 0)
    + refusals.filter(r => r !== s.verdict?.text).reduce((n, r) => n + words(r), 0);
  // Over the total: extra refusal lines go first (the first stays), then risks, then the last why bullets.
  while (total() > LIMITS.totalWords && refusals.length > 1) { refusals = refusals.slice(0, -1); dropped.push({ block: 'refusals', rule: 'total' }); }
  while (total() > LIMITS.totalWords && risks.length) { risks = risks.slice(0, -1); dropped.push({ block: 'risks', rule: 'total' }); }
  while (total() > LIMITS.totalWords && why.length > 1) { why = why.slice(0, -1); dropped.push({ block: 'why', rule: 'total' }); }
  const shape = { ...s, why, risks };
  return { answer: { ...answer, refusals, shape, claims: claimsOf(shape) }, dropped };
}

/* ------------------------------------------- $0 answers in the same format */

const sentences = t => String(t).match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map(x => x.trim()).filter(Boolean) ?? [String(t)];
const firstFit = (t, max) => { const s = sentences(t)[0] ?? t; return words(s) <= max ? s : null; };
const RISK_LEAD = /^(If he says no|If he counters|If he goes quiet|If they say no|The risk|Risk:|Your walk-away|The backup)/i;

/** A verdict line from a plan answer's first line: the move as an instruction, or "No ..." when nothing clears. */
function verdictFrom(first) {
  const t = String(first ?? '').replace(/^About this offer:\s*/i, '').trim();
  if (/^(No next move|Nothing clears|There is no move|No served move|No move|No fair trade)/i.test(t)) return 'No move clears your rules this week.';
  const offer = /^offer\s+(.+)$/i.exec(t);
  if (offer) { const v = `Send ${offer[1]}`; return words(v) <= LIMITS.verdictWords ? v : 'Send the served offer below.'; }
  const fit = firstFit(t, LIMITS.verdictWords);
  return fit && !LEAD_NOT_VERB.test(fit) ? fit : null;
}

/**
 * A $0 (plan) answer, which is a list of grounded lines, in the answer format:
 * the verdict from its first line, up to 3 why lines, up to 2 risk lines ("If he
 * says no", "The risk"), and the rest kept as `more` (still cited, shown folded).
 * Every line keeps its own cites, so nothing unverified appears.
 */
export function shapeDeterministic(answer) {
  if (answer?.shape) return answer;
  const claims = answer?.claims ?? [];
  const refusals = answer?.refusals ?? [];
  if (!claims.length) {
    const r = refusals[0] ?? '';
    const v = firstFit(r, LIMITS.verdictWords);
    const verdict = v && !LEAD_NOT_VERB.test(v) ? v : 'No answer from your plan on this one.';
    return { ...answer, shape: { verdict: { text: verdict, cites: [] }, stance: 'none', basis: '', why: [], risks: [], more: [] } };
  }
  const v = verdictFrom(claims[0].text);
  const rest = v && /^(No move clears|Send the served)/.test(v) ? claims : claims.slice(1);
  const lead = v ?? 'Here is what your plan says.';
  const why = [];
  const risks = [];
  const more = [];
  for (const c of rest) {
    const short = words(c.text) <= LIMITS.whyWords ? c.text : null;
    if (RISK_LEAD.test(c.text) && risks.length < LIMITS.risksMax && short) risks.push({ text: c.text, cites: c.cites });
    else if (why.length < LIMITS.whyMax && short && !RISK_LEAD.test(c.text)) why.push({ text: c.text, cites: c.cites });
    else more.push({ text: c.text, cites: c.cites });
  }
  // Nothing short enough for a why line: the first sentence of the first line, cited as that line.
  if (!why.length && rest.length) {
    const s = firstFit(rest[0].text, LIMITS.whyWords);
    if (s) why.push({ text: s, cites: rest[0].cites });
  }
  const fromFirst = v != null && !/^(No move clears|Send the served)/.test(v);
  return { ...answer, shape: { verdict: { text: lead, cites: fromFirst ? claims[0].cites : [] }, stance: /^Send/.test(lead) ? 'go' : /^No move/.test(lead) ? 'wait' : 'none',
    basis: 'your plan', why, risks, more } };
}

/* ------------------------------------------------ no dev text on screen */

/**
 * CLAUDE.md 2b "No dev text on screen", held on every Coach answer: no table, column or
 * schema talk, no snake_case identifiers, no cite ids. Found live 2026-09-26: "nfl_injuries
 * table doesn't have the columns I guessed (injury_status/practice_status)… need the correct
 * column names", with "player_analysis" and "snap_share" as raw names.
 */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const SCHEMA_TALK = /\b(?:columns?|schema|sql|quer(?:y|ies)|field names?|database|ledger|catalog|column names?)\b|\b(?<!on the |off the |to the |at the )tables?\b|\br\d+#\d+\.|\bguess(?:ed|ing)? (?:the |at )?(?:columns?|fields?|names?)\b/i;

/** The dev-text problems in one line, or []. */
export function devText(text) {
  const t = String(text ?? '');
  const out = [];
  const snake = t.match(SNAKE);
  if (snake) out.push(`internal name "${snake[0]}"`);
  const talk = t.match(SCHEMA_TALK);
  if (talk) out.push(`schema talk "${talk[0].trim()}"`);
  return out;
}

/** Every line of an answer that shows dev text: [{ block, index, problems }]. */
export function devTextViolations(answer) {
  const s = answer?.shape;
  const v = [];
  const check = (block, text, index = null) => { const p = devText(text); if (p.length) v.push({ block, index, problems: p }); };
  if (s?.verdict) check('verdict', s.verdict.text);
  (s?.why ?? []).forEach((w, i) => check('why', w.text, i));
  (s?.risks ?? []).forEach((r, i) => check('risks', r.text, i));
  if (s?.disagreement) check('disagreement', s.disagreement);
  (answer?.refusals ?? []).forEach((r, i) => check('refusals', r, i));
  if (!s) (answer?.claims ?? []).forEach((c, i) => check('claims', c.text, i));
  return v;
}

export const DEV_TEXT_CORRECTION = 'Your answer shows internal detail Nick must never see (a table, column, schema or snake_case name). '
  + 'Say it in plain football words. When a fact is not on file, say so plainly ("No health update on file yet."), never why the data is shaped as it is. '
  + 'Keep every cite. Reply with only the JSON object.';

/** The plain line that stands in for a refusal or verdict that could only be said in dev text. */
export const NOT_ON_FILE = 'No record of that on file yet, so Coach is not guessing.';

/**
 * After the correction round: drop the lines that still show dev text; a verdict or
 * refusal that does becomes the plain "not on file" line. Never shows the dev text.
 */
export function stripDevText(answer) {
  const bad = devTextViolations(answer);
  if (!bad.length) return { answer, dropped: [] };
  const has = (block, i) => bad.some(b => b.block === block && b.index === i);
  const s = answer.shape;
  const refusals = (answer.refusals ?? []).map((r, i) => (has('refusals', i) ? NOT_ON_FILE : r)).filter((r, i, all) => all.indexOf(r) === i);
  if (!s) {
    const claims = (answer.claims ?? []).filter((_, i) => !has('claims', i));
    return { answer: { ...answer, claims, refusals: claims.length ? refusals : (refusals.length ? refusals : [NOT_ON_FILE]) }, dropped: bad };
  }
  const why = s.why.filter((_, i) => !has('why', i));
  const risks = s.risks.filter((_, i) => !has('risks', i));
  const verdict = bad.some(b => b.block === 'verdict') ? { text: NOT_ON_FILE, cites: [] } : s.verdict;
  const shape = { ...s, verdict, why, risks, ...(bad.some(b => b.block === 'disagreement') ? { disagreement: null } : {}) };
  return { answer: { ...answer, refusals, shape, claims: claimsOf(shape) }, dropped: bad };
}
