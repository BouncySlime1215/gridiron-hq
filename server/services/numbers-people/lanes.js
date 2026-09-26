/**
 * NUMBERS-PEOPLE: the two lanes, asked once per run about every key item, and the comparison.
 *
 *   Lane 1, "Claude" (numbers)   Claude reads the plan's FACTS for every item at once (one call)
 *                                and gives a stance, the basis that decides it, a one-line why
 *                                and the fact keys it relied on.
 *   Lane 2, "Jev" (people)       "Claude -> Jev": Claude's read of each item is fed to Jev with
 *                                the STORED people signals for the league-mates on it
 *                                (coach/lanes.js#peopleSignals: labels, counts, ids; speech-shaped
 *                                values already dropped), and Jev leads the lane with its own take
 *                                (jev-lane.js). An item with no stored signal is not sent to Jev.
 *   Compare                      deterministic: a different stance is DIFFER; the same stance on
 *                                the same basis is AGREE; the same stance on a different basis is
 *                                SAME_BUT ("same call, different reasons").
 *
 * Claude's why may not carry a number: numbers are shown from the cited facts, which the plan
 * produced; a why that states one anyway is withheld, never trusted. Spend: Claude in ai_usage as
 * numbers_people:lane_claude (numbers_people daily budget), Jev as numbers_people:jev (no cap).
 */
import { callClaude, parseJson } from '../claude.js';
import { LANE_MODELS, PEOPLE_LABEL, safeSignal } from '../coach/lanes.js';
import { createJevLane } from './jev-lane.js';
import { factLabel, itemKey } from './items.js';

export const STANCES = Object.freeze(['go', 'wait', 'avoid']);
export const BASES = Object.freeze(['title_gain', 'price', 'willingness', 'roster_fit', 'risk', 'timing']);
export const VERDICTS = Object.freeze(['agree', 'differ', 'same_but', 'no_people_read']);
export const NP_FEATURES = Object.freeze({ claude: 'numbers_people:lane_claude', jev: 'numbers_people:jev' });
/** Jev calls in flight at once (one per item with a people signal). */
const JEV_CONCURRENCY = 4;
const OUTPUT_TOKENS = 6000;
const MAX_WHY = 160;

const READS_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['reads'],
  properties: {
    reads: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'stance', 'basis', 'why', 'cites'],
      properties: { key: { type: 'string' }, stance: { enum: [...STANCES] }, basis: { enum: [...BASES] },
        why: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } } } }
  }
});

const COMMON = `For EACH item decide Nick's stance right now: "go" (act on it this week), "wait" (not yet, keep watching) or "avoid" (do not pursue).
Pick the ONE basis that decides it: title_gain (what it does to the odds the plan chases: title, or playoffs in a playoffs league), price (what it costs him in value), willingness (whether the other manager will deal), roster_fit (his lineup need), risk (injury, volatility, a guess too weak to lean on) or timing (why now or not now).
"why" is one plain sentence under 20 words that a friend would say out loud. It contains NO digits, NO ids, NO field names and NO names: say "this move", "this target", "this manager".
"cites" lists the keys you relied on, copied exactly.
Return one read per item key given, and nothing for anything else. Never suggest sending anything and never invent a trade.
Reply with ONLY the JSON object in the schema.`;

const NUMBERS_SYSTEM = `You are Claude, the numbers lane of Coach, a personal fantasy-football app. You read only the plan's FACTS for each item (title-odds gains, chances, value edges, labels). Chances marked as a guess are guesses.

${COMMON}`;

/** The facts block for one item: key -> value, the label beside it so the model reads meaning, not a column. */
const factsFor = item => Object.fromEntries(Object.entries(item.facts).map(([k, v]) => [k, { value: v, means: factLabel(k, item.units?.[k]) }]));

/**
 * Signal rows for each item, numbered across the whole prompt (s0, s1, ...).
 * `signalsFor(roster, players)` returns coach/lanes.js#peopleSignals' shape or null.
 */
export function peopleBlocks(items, signalsFor) {
  const refs = new Map();
  const blocks = new Map();
  let n = 0;
  for (const item of items) {
    const rows = [];
    for (const roster of item.rosters) {
      const got = signalsFor(roster, item.players);
      for (const r of got?.rows ?? []) {
        const clean = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safeSignal(v)]).filter(([, v]) => v != null));
        const ref = `s${n++}`;
        refs.set(ref, clean);
        rows.push({ ref, ...clean });
      }
    }
    if (rows.length) blocks.set(itemKey(item), rows);
  }
  return { refs, blocks };
}

export function numbersPrompt(items) {
  return `ITEMS:\n${JSON.stringify(items.map(i => ({ key: itemKey(i), kind: i.item_type, facts: factsFor(i) })))}`;
}

/** A why line that is safe to show: short, no digits, no quotes. Null when it is not. */
export function cleanWhy(why) {
  const s = String(why ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /\d/.test(s) || /["“”]/.test(s)) return null;
  const t = s[0].toUpperCase() + s.slice(1);
  return t.length > MAX_WHY ? `${t.slice(0, MAX_WHY - 1).trimEnd()}…` : t;
}

/** One lane's parsed reads, checked against the items it was given. */
export function checkReads(parsed, items, { refs = null } = {}) {
  const byKey = new Map(items.map(i => [itemKey(i), i]));
  const out = new Map();
  for (const r of parsed?.reads ?? []) {
    const item = byKey.get(String(r?.key));
    if (!item || out.has(itemKey(item)) || !STANCES.includes(r.stance) || !BASES.includes(r.basis)) continue;
    const cites = [];
    for (const c of new Set((r.cites ?? []).map(String))) {
      if (Object.hasOwn(item.facts, c)) cites.push({ key: c, label: factLabel(c, item.units?.[c]), value: item.facts[c], unit: item.units?.[c] ?? null });
      else {
        const m = /^(s\d+)\.([a-z_]+)$/.exec(c);
        const row = m && refs?.get(m[1]);
        if (row && Object.hasOwn(row, m[2])) cites.push({ key: c, signal: row.signal ?? null, field: m[2], value: row[m[2]] });
      }
    }
    const why = cleanWhy(r.why);
    out.set(itemKey(item), { stance: r.stance, basis: r.basis, why, ...(why ? {} : { why_withheld: true }), cites });
  }
  return out;
}

/** The comparison step. */
export function verdictOf(a, b) {
  if (!b || !b.stance) return 'no_people_read';
  if (a.stance !== b.stance) return 'differ';
  return a.basis === b.basis ? 'agree' : 'same_but';
}

async function ask({ feature, system, prompt, model }) {
  const msg = await callClaude({ feature, model, maxTokens: OUTPUT_TOKENS, system, effort: 'low',
    messages: [{ role: 'user', content: prompt }], outputSchema: READS_SCHEMA });
  return { parsed: parseJson(msg), cost_usd: msg.cost_usd ?? 0, usage: msg.usage ?? null };
}

/** Jev's numbers as the tab labels them (the view relabels stored rows by key, so old rows read the same). */
export const JEV_CITE_LABELS = Object.freeze({
  p_jev_stance: 'Jev: sure of this call', p_jev_backs_claude: 'Jev: chat backs Claude', p_jev_willing: 'Jev: he deals now'
});

/** Jev's probabilities and the signals it read, as the lane's cited numbers and labels. */
function jevCites(take, rows) {
  const cites = [
    { key: 'p_jev_stance', label: JEV_CITE_LABELS.p_jev_stance, value: take.probabilities?.stance },
    { key: 'p_jev_backs_claude', label: JEV_CITE_LABELS.p_jev_backs_claude, value: take.probabilities?.backs_claude },
    { key: 'p_jev_willing', label: JEV_CITE_LABELS.p_jev_willing, value: take.probabilities?.willing }
  ].filter(c => typeof c.value === 'number').map(c => ({ ...c, value: +c.value.toFixed(4) }));
  const SHOWN = ['in_market', 'wants', 'shopping', 'untouchable', 'p_open_to_trade', 'phrase', 'kind'];
  for (const r of rows) {
    for (const f of SHOWN) {
      if (cites.length >= 5) break;
      if (r[f] != null) cites.push({ key: `${r.ref}.${f}`, signal: r.signal ?? null, field: f, value: r[f] });
    }
  }
  return cites;
}

async function inBatches(list, n, fn) {
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i += n) {
    const part = await Promise.all(list.slice(i, i + n).map((x, k) => fn(x, i + k)));
    part.forEach((v, k) => { out[i + k] = v; });
  }
  return out;
}

/**
 * Lane 1 (Claude, one call), then lane 2 (Jev, one call per item with a people signal, fed
 * Claude's read), then the verdicts. Returns { reads: [{ item, lane_a, lane_b, verdict }],
 * skipped: [keys Claude did not read], cost_usd, prompts, jev: {asked, answered} }.
 * A Claude call that throws (budget, network) rejects the whole run: half a comparison is not
 * stored as if it were one. A Jev call that fails leaves that item without a people read, said so.
 */
export async function readBothLanes(items, { signalsFor, jevLane = createJevLane() }) {
  const { blocks } = peopleBlocks(items, signalsFor);
  const prompts = { numbers: numbersPrompt(items), jev: [] };
  const a = await ask({ feature: NP_FEATURES.claude, system: NUMBERS_SYSTEM, prompt: prompts.numbers, model: LANE_MODELS.numbers });
  const laneA = checkReads(a.parsed, items);
  const toJev = items.filter(i => blocks.has(itemKey(i)) && laneA.has(itemKey(i)));
  const takes = await inBatches(toJev, JEV_CONCURRENCY, async item => {
    const k = itemKey(item);
    const claude = laneA.get(k);
    const input = { item: { key: k, kind: item.item_type }, facts: factsFor(item),
      claude: { stance: claude.stance, basis: claude.basis, why: claude.why }, signals: blocks.get(k) };
    const take = await jevLane(input);
    prompts.jev.push({ key: k, input });
    return [k, take];
  });
  const laneB = new Map(takes);
  const reads = [];
  const skipped = [];
  let jevCost = 0;
  for (const item of items) {
    const k = itemKey(item);
    const ra = laneA.get(k);
    if (!ra) { skipped.push(k); continue; }
    const take = laneB.get(k);
    let rb = null;
    let laneBRow;
    if (take && !take.skipped) {
      jevCost += take.cost_usd ?? 0;
      const why = cleanWhy(take.why);
      rb = { lead: 'jev', stance: take.stance, basis: BASES.includes(take.basis) ? take.basis : null, why, ...(why ? {} : { why_withheld: true }),
        cites: jevCites(take, blocks.get(k)), claude_stance: ra.stance, label: PEOPLE_LABEL };
      laneBRow = rb;
    } else {
      laneBRow = { skipped: !blocks.has(k) ? 'no stored people signal for anyone on it'
        : take?.skipped === 'jev_not_configured' ? 'Jev is not configured on this server' : 'Jev did not answer for it' };
    }
    reads.push({ item, lane_a: ra, lane_b: laneBRow, verdict: verdictOf(ra, rb) });
  }
  return { reads, skipped, cost_usd: a.cost_usd + jevCost, prompts,
    jev: { asked: toJev.length, answered: takes.filter(([, t]) => t && !t.skipped).length } };
}
