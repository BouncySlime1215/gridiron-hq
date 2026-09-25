/**
 * COACH-NEGOTIATE: Coach as the live negotiation copilot (COACH-ANCHOR.md job 2).
 *
 * Nick pastes the partner's reply to the next move's step (or taps what kind of
 * reply it was). Coach classifies it (accept / counter / decline / stall /
 * silence), shows the step's pre-planned row from the plan's reply_table, and
 * for a counter re-prices his package with the ENGINE, then says take it /
 * counter with X / walk, with the plan's walk-away line. It drafts; it never
 * sends.
 *
 * Five rules.
 *
 * WORDS -> A KIND, DETERMINISTICALLY. `classifyReply` is rules, not a model
 * call: a counter names players and asks for a package; a stall defers; a
 * decline says no; an accept says yes. A tap (`reply_kind`) beats the words.
 * Players are resolved only from the plan's own `names`; whose player each one
 * is comes from the engine's rosters, else from the step itself.
 *
 * PRICES FROM THE ENGINE, NEVER COMPUTED HERE. A counter's title-odds change is
 * the campaign adapter's rescore (scripts/campaign/league-adapter.mjs: the
 * world is season-sim.js#tradeImpactWorld and the rescore is season-sim.js
 * #tradeImpact on it, the same dice as every title-odds surface). His P(yes) is
 * the adapter's priceStep: counterparty-pricing.js#readDeal ->
 * trade-acceptance.js#acceptanceBand midpoint, which is exactly what the ONE
 * counterpart model (people/counterpart.js, PR #313) serves, since it gives chat
 * features zero weight in P(accept) until EVAL E1 grades one. The engine's cells
 * go into the turn's ledger as a `what_if` entry and every claim cites them.
 * The only thing done to a number is writing a fraction as a percentage, which
 * verify.js accepts as the same number. No engine: the counter is said to be
 * not re-priced and is judged on the plan's walk-away alone.
 *
 * THE WALK-AWAY RULE IS THE PLAN'S. The step's reply_table counter row says:
 * accept if his ask is no richer than the walk-away package, walk if it is
 * richer (your backup plan is worth more), and names the counter to make. Here:
 *   - he asks for a player of yours outside walk_away.max_give -> walk.
 *   - inside the walk-away, he still gives what the step gets, and the engine
 *     re-price leaves title odds above the backup's (the decline row's
 *     odds_after) -> take.
 *   - otherwise (a lowball: he gives less, or the re-price falls below the
 *     backup) -> counter with the plan's counter (the reply table's
 *     counter_with: the next rung, else the opening), priced by the engine too.
 *   accept -> take; decline -> walk to the backup (the decline row); stall or
 *   silence -> wait, then the silence row's nudge.
 * P(yes) is labelled unproven while the report card's E1 is not passing.
 *
 * DRAFT ONLY. The draft goes to the War Room dock as a `draft_message` UI
 * action (words only, no digits; the dock puts it in the message box and Nick
 * copies it). Nothing here writes a row, calls the network or logs an offer:
 * `sends` is always 0.
 *
 * GROUNDED. Every claim cites plan_read rows or the engine's what_if rows in the
 * turn's ledger and ships only after verify.js#verifyAnswer passes it.
 *
 * Behind GRIDIRON_COACH_NEGOTIATE (default off; the preview switch turns it on
 * through preview-mode.js; GRIDIRON_COACH_NEGOTIATE=0 vetoes preview).
 */
import fs from 'node:fs';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { row, rows } from '../../db/index.js';
// RULES-EVERYWHERE: Nick's hard rules, the one gate (campaign/never-give.js).
import { ruleGate } from '../campaign/never-give.js';
import { previewUnconfirmed } from '../preview-mode.js';
import { validateAction } from '../warroom-actions/schema.js';
import { planRead, plansPath } from './brain-tools.js';
import { verifyAnswer, groundAnswer } from './verify.js';
import { newLedger } from './ledger.js';

export const NEGOTIATE_ENV = 'GRIDIRON_COACH_NEGOTIATE';

/** On with its own flag or preview mode; its own flag set to '0' vetoes preview. */
export function negotiateOn() {
  const own = process.env[NEGOTIATE_ENV];
  if (own === '1') return true;
  if (own === '0') return false;
  return previewUnconfirmed();
}

export class NegotiatorError extends Error {
  constructor(message) { super(message); this.name = 'NegotiatorError'; }
}

export const REPLY_KINDS = Object.freeze(['accept', 'counter', 'decline', 'stall', 'silence']);

/* ------------------------------------------------------------ engine */

/**
 * The default engine: the campaign producer's own adapter for the league
 * (scripts/campaign/league-adapter.mjs#buildAdapter, finder off), built once per
 * league sync and kept, ALL OFF THE REQUEST THREAD.
 *
 * Cost, measured on a local copy of league 4 (2026-09-24): the build is
 * season-sim.js#tradeImpactWorld, ~35-40 s of synchronous work (the same build
 * the Title-impact tab pays); every counter after that on the same sync is one
 * rescore plus one price, ~1-2 s. A synchronous 35-40 s on the Express thread
 * would freeze every request (the WR-FREEZE class, #312), so:
 *   - the adapter lives in one worker thread (`engineWorker`), which imports the
 *     modules and builds each league's world there;
 *   - the first reply of any kind for a league starts that build and returns at
 *     once; until it lands, a counter is said to be not re-priced yet (the
 *     request thread never waits on a build);
 *   - once built, a counter's rescore and price are one synchronous round trip
 *     to the worker (Atomics.wait on a shared flag + receiveMessageOnPort),
 *     bounded by ENGINE_CALL_MS; past that the counter is said to be unpriced.
 *     runCoachTool is synchronous (ask.js), so this round trip is the one wait
 *     left on the request thread: the ~1-2 s rescore, never the build.
 */
export const ENGINE_CALL_MS = 8000;

/** The worker's body (eval'd, CommonJS): builds adapters and answers rescore / price calls. */
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { reply, signal, module: modUrl } = workerData;
const flag = new Int32Array(signal);
const built = new Map();
let mod = null, svc = null;
const ready = (async () => { mod = await import(modUrl); svc = await mod.loadServices(); })();
ready.catch(() => {});
const answer = (id, body) => { reply.postMessage({ id, ...body }); Atomics.add(flag, 0, 1); Atomics.notify(flag, 0); };
const clean = v => (v == null ? null : JSON.parse(JSON.stringify(v)));
parentPort.on('message', async msg => {
  if (msg.op === 'build') {
    try {
      await ready;
      for (const k of [...built.keys()]) if (k.startsWith(msg.leagueId + ':')) built.delete(k);
      const a = mod.buildAdapter(svc, msg.leagueId, { finder: false });
      if (!a || a.fail) { parentPort.postMessage({ op: 'built', key: msg.key, fail: String(a && a.fail ? a.fail : 'no adapter') }); return; }
      built.set(msg.key, a);
      parentPort.postMessage({ op: 'built', key: msg.key, me: String(a.league && a.league.me), seed: a.seed, rosters: a.rosters });
    } catch (e) { parentPort.postMessage({ op: 'built', key: msg.key, fail: String(e && e.message || e) }); }
    return;
  }
  try {
    const a = built.get(msg.key);
    if (!a) throw new Error('engine not built for ' + msg.key);
    if (msg.op === 'rescore') {
      const w = a.world(msg.seed);
      if (!w || w.fail) return answer(msg.id, { value: null });
      const r = w.rescore(msg.state, msg.a, msg.b);
      return answer(msg.id, { value: { me: clean(r && r.me) } });
    }
    if (msg.op === 'price') return answer(msg.id, { value: clean(a.priceStep(msg.team, msg.theyGive, msg.theyGet)) });
    answer(msg.id, { error: 'unknown op ' + msg.op });
  } catch (e) { answer(msg.id, { error: String(e && e.message || e) }); }
});
`;

const DEFAULT_ENGINE_MODULE = new URL('../../../scripts/campaign/league-adapter.mjs', import.meta.url).href;
let engineModule = DEFAULT_ENGINE_MODULE;
let eng = null;
const engineWhy = new Map();

/** The one engine worker (spawned on first use; unref'd, so it never holds the process open). */
function engineWorker() {
  if (eng) return eng;
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const worker = new Worker(WORKER_SRC, { eval: true, workerData: { reply: port2, signal, module: engineModule }, transferList: [port2] });
  const state = { worker, port: port1, flag: new Int32Array(signal), seq: 0, ready: new Map(), building: new Set() };
  worker.on('message', msg => {
    if (msg?.op !== 'built') return;
    state.building.delete(msg.key);
    state.ready.set(msg.key, msg.fail ? { fail: msg.fail } : { me: msg.me, seed: msg.seed, rosters: msg.rosters });
  });
  worker.on('error', () => { if (eng === state) eng = null; });
  worker.on('exit', () => { if (eng === state) eng = null; });
  // After the listeners: attaching a 'message' listener re-refs the worker's port, and a
  // warm worker must never keep a short-lived process (a test, a script) from exiting.
  worker.unref();
  eng = state;
  return state;
}

/** One synchronous call into the worker, bounded by ENGINE_CALL_MS. Throws on error or timeout. */
function callEngine(state, msg) {
  const id = ++state.seq;
  state.worker.postMessage({ ...msg, id });
  const deadline = Date.now() + ENGINE_CALL_MS;
  for (;;) {
    for (let got = receiveMessageOnPort(state.port); got; got = receiveMessageOnPort(state.port)) {
      if (got.message?.id !== id) continue; // a late answer to a call that already timed out
      if (got.message.error) throw new Error(got.message.error);
      return got.message.value;
    }
    const seen = Atomics.load(state.flag, 0);
    const again = receiveMessageOnPort(state.port);
    if (again) {
      if (again.message?.id === id) { if (again.message.error) throw new Error(again.message.error); return again.message.value; }
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`engine call timed out after ${ENGINE_CALL_MS} ms`);
    Atomics.wait(state.flag, 0, seen, left);
  }
}

/** The adapter shape `enginePrice` reads, with rescore and price answered by the worker. */
function workerAdapter(state, key, info) {
  return {
    league: { me: info.me }, seed: info.seed, rosters: info.rosters,
    world: seed => ({ rescore: (st, a, b) => callEngine(state, { op: 'rescore', key, seed, state: st, a, b }) }),
    priceStep: (team, theyGive, theyGet) => callEngine(state, { op: 'price', key, team, theyGive, theyGet })
  };
}

/** Start the engine worker in the background (called when the tool is offered). Never builds on this thread. */
export function warmNegotiator() {
  if (sources.engine !== defaultEngine) return;
  try { engineWorker(); } catch { /* no worker: a counter says it is not re-priced */ }
}

/** Stop the engine worker (tests; a flag flip needs nothing). */
export async function stopNegotiatorEngine() {
  const state = eng;
  eng = null;
  engineWhy.clear();
  if (state) await state.worker.terminate();
}

/** Where the default engine is for a league: 'ready', 'building', 'failed' or null (not started). */
export function negotiatorEngineStatus(leagueId) {
  if (!eng) return null;
  const lg = row('SELECT fetched_at FROM leagues WHERE id = ?', leagueId);
  if (!lg) return null;
  const key = `${leagueId}:${lg.fetched_at ?? ''}`;
  const got = eng.ready.get(key);
  return got ? (got.fail ? 'failed' : 'ready') : eng.building.has(key) ? 'building' : null;
}

function defaultEngine(leagueId) {
  const lg = row('SELECT fetched_at FROM leagues WHERE id = ?', leagueId);
  if (!lg) { engineWhy.set(leagueId, 'the league is not in the database'); return null; }
  const key = `${leagueId}:${lg.fetched_at ?? ''}`;
  let state;
  try { state = engineWorker(); } catch (e) {
    engineWhy.set(leagueId, 'the engine worker could not start');
    return null;
  }
  const got = state.ready.get(key);
  if (got) {
    if (got.fail) { engineWhy.set(leagueId, 'the engine could not build this league'); return null; }
    engineWhy.delete(leagueId);
    return workerAdapter(state, key, got);
  }
  if (!state.building.has(key)) {
    for (const k of [...state.ready.keys()]) if (k.startsWith(`${leagueId}:`)) state.ready.delete(k);
    state.building.add(key);
    state.worker.postMessage({ op: 'build', key, leagueId });
  }
  engineWhy.set(leagueId, 'the engine is still being built for this league in the background (about 40 s after each league sync); ask again in a minute');
  return null;
}

const sources = { engine: defaultEngine };

/**
 * Swap a source (tests). `engine(leagueId)` -> a campaign adapter
 * ({ league: { me }, seed, rosters, world(seed).rescore, priceStep }) or null;
 * null restores the default (worker) engine. `engineModule` points the default
 * engine's worker at another adapter module (a URL exporting loadServices and
 * buildAdapter); it takes effect on the next worker start.
 */
export function setNegotiatorSources({ engine, engineModule: mod } = {}) {
  if (engine !== undefined) sources.engine = engine ?? defaultEngine;
  if (mod !== undefined) engineModule = mod ?? DEFAULT_ENGINE_MODULE;
}

/* ------------------------------------------------------------ words */

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameCore = s => String(s).replace(/\s*\([^)]*\)\s*$/, '').trim();

/** Every way a reply can name a plan player: "K. Knox", "Knox". Longest first. */
function playerMatchers(names) {
  const out = [];
  for (const [id, full] of Object.entries(names ?? {})) {
    const core = nameCore(full);
    if (!core) continue;
    out.push({ id: String(id), pattern: core.toLowerCase() });
    const last = core.match(/^[A-Z]\.\s?(.+)$/)?.[1] ?? core.split(/\s+/).slice(1).join(' ');
    if (last && last.length >= 3) out.push({ id: String(id), pattern: last.toLowerCase() });
  }
  return out.sort((a, b) => b.pattern.length - a.pattern.length);
}

/** Players a reply names, in order, each with where it sits. */
function playersIn(text, names) {
  const found = [];
  const taken = [];
  for (const m of playerMatchers(names)) {
    const rx = new RegExp(`(^|[^a-z0-9])(${escape(m.pattern)})(?=[^a-z0-9]|$)`, 'g');
    for (const hit of text.matchAll(rx)) {
      const at = hit.index + hit[1].length;
      const end = at + hit[2].length;
      if (taken.some(([a, b]) => at < b && end > a)) continue;
      taken.push([at, end]);
      if (!found.some(f => f.id === m.id)) found.push({ id: m.id, at, end });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

const CUES = {
  // A proposal: he asks for a package. Wins whenever it names a player.
  proposal: /\b(how about|what about|would you do|would you take|would you consider|i'?d do|i would do|i'?ll do|i can do|i could do|i'?d take|i'?d give|if you (?:add|throw|include|give|send|swap|put)|throw in|throwing in|instead|make it|counter|swap|rather have|i want|give me|only if|as long as|if you)\b/,
  // "for / add / plus" only say "a package" when nothing in the same sentence says no:
  // "No, I'm not trading Knox for that" repeats the offer, it does not counter it.
  weak: /\b(for|add|plus)\b/,
  stall: /\b(let me think|think about it|think it over|get back to you|maybe|after (?:the )?(?:game|games|weekend|sunday|monday|waivers)|later|not (?:right )?now|busy|hold on|give me (?:a|some) (?:day|time|bit|minute)|sleep on it|idk|not sure yet|circle back|tomorrow)\b/,
  decline: /\b(no|nope|nah|pass|not even|not interested|i'?m good|not for me|not trading|not selling|not giving up|not giving|not doing|not moving|not budging|i'?m keeping|keeping (?:him|them|my)|decline|declined|won'?t|can'?t do|no deal|not happening)\b/,
  accept: /\b(deal|yes|yep|yeah|yup|sure|accept|accepted|accepting|sounds good|let'?s do (?:it|this)|done|i'?m in|works for me|ok|okay|send it)\b/
};

/** "not even if you add Gore" is a no, not a proposal: drop negated proposals before looking for one. */
const unNegated = t => t.replace(/\b(?:not even|never|no way even)\s+(?:if|for|with)\b[^.!?;]*/g, ' ');

/** Sentences (and "but" clauses), each with where it sits, so the LAST thing he said decides. */
function segments(t) {
  const out = [];
  let at = 0;
  for (const m of t.matchAll(/[.!?;\n]+|\bbut\b|\bthough\b|\bhowever\b/g)) {
    out.push({ text: t.slice(at, m.index), start: at, end: m.index });
    at = m.index + m[0].length;
  }
  out.push({ text: t.slice(at), start: at, end: t.length });
  return out.filter(s => s.text.trim());
}

/**
 * A reply that says no somewhere: its last sentence with a cue decides. A "no"
 * there is a decline; players plus "for / add / plus" there (after the no,
 * "Nope. Dell and Gore for Knox though") is a counter.
 */
function noOrCounter(t, players) {
  for (const seg of segments(t).reverse()) {
    if (CUES.decline.test(seg.text)) return 'decline';
    const named = players.some(p => p.at >= seg.start && p.at < seg.end);
    if (named && CUES.weak.test(seg.text)) return 'counter';
  }
  return 'decline';
}

/**
 * Safety (9/24 review of #327): negative words the classifier's cue list misses. A take is
 * never drafted when the LAST thing he said carries one of these or a decline cue:
 * "Dell for Knox? Never." / "Hell no. Knox for Dell alone is a ripoff" are no's, while
 * "No, but Dell for Knox works" ends on the package and stays a counter Coach may take.
 */
const NEGATIVE = /\b(no|nope|nah|never|not a chance|no chance|no way|hell no|don'?t want|do not want|not if|not for|rather not|rip ?off|ripoff|joke|lol no|not happening|not interested|pass|won'?t|can'?t|not trading|not selling|not giving|not doing|not moving|keeping)\b/;
export function endsNegative(text) {
  const t = String(text ?? '').toLowerCase();
  for (const seg of segments(t).reverse()) {
    if (NEGATIVE.test(seg.text)) return true;
    if (CUES.proposal.test(seg.text) || CUES.weak.test(seg.text) || CUES.accept.test(seg.text)) return false;
  }
  return false;
}

/**
 * One reply -> its kind, by rules, in this order:
 *   1. empty -> silence; a tap (`reply_kind`) wins over words.
 *   2. names a player and makes a proposal ("how about", "I'd do", "throw in",
 *      a conditional yes: "yes if you throw in Gore") -> counter.
 *   3. defers -> stall.
 *   4. says no -> decline, unless a LATER sentence names players with a package
 *      word ("No. Dell and Gore for Knox though") -> counter.
 *   5. names a player with "for / add / plus" -> counter.
 *   6. says yes -> accept.  7. names a player only -> counter.  8. else unread.
 * A counter that turns out to be the step's own package is caught in `negotiate`
 * (it is a yes or a no, never a counter to take).
 * @returns {{ kind: string|null, players: {id, at, end}[], basis: string }}
 */
export function classifyReply(text, { names = {}, tap = null } = {}) {
  const raw = String(text ?? '').trim();
  const t = raw.toLowerCase();
  const players = raw ? playersIn(t, names) : [];
  if (tap != null) {
    if (!REPLY_KINDS.includes(tap)) throw new NegotiatorError(`reply_kind must be one of ${REPLY_KINDS.join(', ')}; got ${JSON.stringify(tap)}.`);
    return { kind: tap, players, basis: 'tapped' };
  }
  if (!raw) return { kind: 'silence', players, basis: 'no reply' };
  if (players.length && CUES.proposal.test(unNegated(t))) return { kind: 'counter', players, basis: 'names players and proposes a package' };
  if (CUES.stall.test(t)) return { kind: 'stall', players, basis: 'defers' };
  if (CUES.decline.test(t)) {
    return noOrCounter(t, players) === 'counter'
      ? { kind: 'counter', players, basis: 'says no, then names a package' }
      : { kind: 'decline', players, basis: 'says no' };
  }
  if (players.length && CUES.weak.test(t)) return { kind: 'counter', players, basis: 'names players for a package' };
  if (CUES.accept.test(t)) return { kind: 'accept', players, basis: 'says yes' };
  if (players.length) return { kind: 'counter', players, basis: 'names players' };
  return { kind: null, players, basis: 'no cue Coach reads' };
}

/**
 * A counter's package, as Nick sees it: what he would give and get. `owner(id)`
 * says whose player an id is ('me', 'him' or null). Players after "instead of",
 * "keep", "without", "not" are taken out; "add / throw in / plus / also / too"
 * adds to the step's side instead of replacing it.
 */
export function counterPackage(text, players, step, owner) {
  const t = String(text ?? '').toLowerCase();
  const excluded = new Set(players.filter(p => /\b(instead of|rather than|keep|keeping|without|not|except)\s+(?:your |my |the )?$/
    .test(t.slice(Math.max(0, p.at - 24), p.at))).map(p => p.id));
  const additive = /\b(add|adding|throw in|throwing in|plus|also|as well|too|on top)\b/.test(t);
  const mine = players.filter(p => owner(p.id) === 'me' && !excluded.has(p.id)).map(p => p.id);
  const his = players.filter(p => owner(p.id) === 'him' && !excluded.has(p.id)).map(p => p.id);
  const unknown = players.filter(p => owner(p.id) == null).map(p => p.id);
  const side = (base, named) => {
    const kept = base.filter(id => !excluded.has(id));
    if (!named.length) return kept;
    return additive && !named.some(id => base.includes(id)) ? [...new Set([...kept, ...named])] : named;
  };
  return { give: side(step.give, mine), get: side(step.get, his), unknown, excluded: [...excluded] };
}

/* ------------------------------------------------------------ plan rows */

const safeRecord = (ledger, rows, tool, tables) => ledger.record({ tool, sql: null, params: [], tables,
  columns: Object.keys(rows[0] ?? {}), rows, row_count: rows.length, truncated: false, provenance: {} });

function readSection(ledger, leagueId, section) {
  const rows = planRead({ league_id: leagueId, section });
  const entry = safeRecord(ledger, rows, 'plan_read', ['warroom_plans_file']);
  return { entry, row: rows[0] ?? {} };
}

const citeOf = (sec, col) => (Object.hasOwn(sec.row, col) && sec.row[col] != null ? `${sec.entry.id}#0.${col}` : null);
const pct = v => (v * 100).toFixed(Math.abs(v * 100) < 10 ? 1 : 0);
const pts = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;

/** The ids under `<prefix>_<i>` in a flat plan row. */
function idsAt(row, prefix) {
  const out = [];
  for (let i = 0; Object.hasOwn(row, `${prefix}_${i}`); i++) out.push(String(row[`${prefix}_${i}`]));
  return out;
}

/**
 * The league's player names: the plan's own `names` map (every rostered player;
 * for reading who a reply means, not evidence, so not in the ledger), plus the
 * plan_read `_name` cells.
 */
function namesFrom(leagueId, sections) {
  const names = {};
  try {
    const doc = JSON.parse(fs.readFileSync(plansPath(), 'utf8'));
    const entry = Array.isArray(doc?.leagues) ? doc.leagues.find(l => l?.league === leagueId) : null;
    for (const [k, v] of Object.entries(entry?.names ?? {})) if (typeof v === 'string') names[k] = v;
  } catch { /* no readable plans file: plan_read already says so, typed */ }
  for (const sec of sections) {
    for (const [col, v] of Object.entries(sec.row)) {
      const m = col.match(/^(.*)_name$/);
      if (!m || typeof v !== 'string') continue;
      const id = sec.row[m[1]];
      if (id != null) names[String(id)] = v;
    }
  }
  return names;
}

/* ------------------------------------------------------------ engine price */

/** Ids in the adapter's own type (the real adapter keys players by number). */
const asEngineId = (rosters, id) => {
  for (const ids of rosters.values()) for (const x of ids) if (String(x) === String(id)) return x;
  return Number.isFinite(Number(id)) ? Number(id) : id;
};

/** Whose player an id is on the engine's rosters: 'me', 'him' (the partner), 'other' or null. */
function engineOwner(adapter, partner) {
  if (!adapter?.rosters) return () => null;
  const me = String(adapter.league?.me);
  return id => {
    for (const [team, ids] of adapter.rosters) {
      if (ids.some(x => String(x) === String(id))) return String(team) === me ? 'me' : String(team) === String(partner) ? 'him' : 'other';
    }
    return null;
  };
}

/**
 * The engine's price for one package: the adapter's rescore of the roster state
 * after it (title odds) and its priceStep (P(yes) band). Nothing is computed:
 * each value is a cell the engine returned.
 */
function enginePrice(adapter, { partner, give, get }) {
  const me = String(adapter.league.me);
  const rosters = adapter.rosters;
  const mine = rosters.get(me) ?? rosters.get(Number(me));
  const his = rosters.get(String(partner)) ?? rosters.get(Number(partner));
  if (!mine || !his) return null;
  const g = give.map(id => asEngineId(rosters, id));
  const r = get.map(id => asEngineId(rosters, id));
  const state = new Map([
    [me, [...mine.filter(x => !g.some(y => String(y) === String(x))), ...r]],
    [String(partner), [...his.filter(x => !r.some(y => String(y) === String(x))), ...g]]
  ]);
  const world = adapter.world(adapter.seed);
  if (!world || world.fail) return null;
  const out = world.rescore(state, me, String(partner))?.me;
  const price = adapter.priceStep(String(partner), r, g);
  if (!out || !Number.isFinite(out.title_after)) return null;
  return {
    title_before: out.title_before, title_after: out.title_after, title_delta: out.title_delta,
    title_delta_se: out.title_delta_se ?? null, title_delta_clears_noise: out.title_delta_clears_noise ?? null,
    p_yes: Number.isFinite(price?.p) ? price.p : null,
    p_yes_low: Number.isFinite(price?.band?.low) ? price.band.low : null,
    p_yes_high: Number.isFinite(price?.band?.high) ? price.band.high : null,
    p_yes_basis: price?.basis ?? null
  };
}

/* ------------------------------------------------------------ the turn */

const ROW_FOR = { accept: 'accept', counter: 'counter', decline: 'decline', stall: 'silence', silence: 'silence' };
const SAID = { accept: 'an accept', counter: 'a counter', decline: 'a decline', stall: 'a stall', silence: 'silence' };

/**
 * One reply turn. Reads the next move's playbook through plan_read (recorded in
 * `ledger`), classifies the reply, re-prices a counter with the engine, applies
 * the walk-away rule, drafts, and verifies every claim. Writes nothing.
 *
 * @returns {{ kind, recommendation: {do, counter_with?, because}|null, reprice: object[],
 *   draft: string|null, answer, verification, actions: object[], sends: 0 }}
 */
export function negotiate({ leagueId, reply = '', replyKind = null, stepIndex = 0, ledger = newLedger() } = {}) {
  const id = Number(leagueId);
  if (!Number.isInteger(id) || id < 1) throw new NegotiatorError(`league_id must be a whole number, got ${JSON.stringify(leagueId)}.`);
  const i = Number(stepIndex ?? 0);
  if (!Number.isInteger(i) || i < 0) throw new NegotiatorError(`step must be a whole number from 0, got ${JSON.stringify(stepIndex)}.`);

  // Start the league's engine build now (in the worker), so it is ready by the time a counter comes.
  if (sources.engine === defaultEngine) { try { defaultEngine(id); } catch { /* priced later or not at all */ } }

  const book = readSection(ledger, id, 'next_move_playbook');
  const next = readSection(ledger, id, 'next_move');
  const brain = readSection(ledger, id, 'brain_report');
  const claims = [];
  const refusals = [];
  // RULES-EVERYWHERE: a take or a counter that breaks one of Nick's hard rules becomes a walk; counted here.
  let droppedByRule = 0;
  const done = (extra = {}) => {
    const generatedAt = book.row.plans_generated_at ?? null;
    const draftAnswer = { claims, refusals, as_of: generatedAt ? `plans file generated ${generatedAt}` : null };
    const verification = verifyAnswer({ answer: draftAnswer, ledger, question: String(reply ?? '') });
    const answer = verification.ok ? draftAnswer : groundAnswer(draftAnswer, verification);
    return { kind: null, recommendation: null, reprice: [], draft: null, actions: [], ...extra,
      answer, verification, sends: 0, dropped_by_rule: droppedByRule };
  };

  const P = `next_move_playbook_steps_${i}_`;
  if (book.row.status !== 'ok' || book.row.next_move_playbook_status !== 'ok') {
    refusals.push(`There is no next move to negotiate for league ${id}: ${book.row.reason ?? book.row.next_move_playbook_reason ?? 'the plan has none'}.`);
    return done();
  }
  if (!Object.hasOwn(book.row, `${P}partner`)) {
    refusals.push(`The next move has no step ${i + 1}.`);
    return done();
  }
  if (book.row[`${P}reply_table_status`] !== 'ok') {
    refusals.push(`Step ${i + 1} has no reply table yet (${book.row[`${P}reply_table_reason`] ?? 'the planner writes one for the chosen move\'s steps'}), so Coach has no pre-planned answer to show.`);
    return done();
  }

  const partner = String(book.row[`${P}partner`]);
  const step = { partner, give: idsAt(book.row, `${P}give`), get: idsAt(book.row, `${P}get`) };
  const names = namesFrom(id, [book, next]);
  const maxGiveIds = idsAt(book.row, `${P}walk_away_value_max_give`);
  const cellFor = pid => {
    for (const sec of [book, next]) {
      for (const [col, v] of Object.entries(sec.row)) {
        if (/_name$/.test(col) && String(sec.row[col.replace(/_name$/, '')]) === String(pid) && typeof v === 'string') {
          return [`${sec.entry.id}#0.${col}`, `${sec.entry.id}#0.${col.replace(/_name$/, '')}`];
        }
      }
    }
    return [];
  };

  let read;
  try {
    read = classifyReply(reply, { names, tap: replyKind });
  } catch (e) {
    if (e instanceof NegotiatorError) { refusals.push(e.message); return done(); }
    throw e;
  }
  if (!read.kind) {
    refusals.push('Coach could not tell whether that is a yes, a no, a counter or a stall. Tap which it was, or paste his exact words.');
    return done({ kind: null });
  }
  let kind = read.kind;
  if (kind === 'counter' && read.basis !== 'tapped') {
    // A "counter" that is exactly the step's own package is not a counter: it is a yes or a no
    // that repeats the offer. Never price it into a "take" (that drafts an acceptance to a no).
    const stepOwner = pid => (step.give.includes(pid) || maxGiveIds.includes(pid) ? 'me' : step.get.includes(pid) ? 'him' : null);
    const same = counterPackage(reply, read.players, step, stepOwner);
    const eq = (x, y) => x.length === y.length && x.every(v => y.includes(v));
    if (!same.unknown.length && eq(same.give, step.give) && eq(same.get, step.get)) {
      const t = String(reply).toLowerCase();
      if (CUES.accept.test(t) && !CUES.decline.test(t)) kind = 'accept';
      else {
        refusals.push('That names the same package you offered, so it is not a counter. Is it a yes or a no? Tap accept or decline.');
        return done({ kind: null });
      }
    }
  }

  // The reply table's row for this kind: the pre-planned answer, shown as the plan wrote it.
  const R = `${P}reply_table_value_${ROW_FOR[kind]}_`;
  const rowDo = citeOf(book, `${R}value_do`);
  if (rowDo) {
    claims.push({ text: `Read as ${SAID[kind]}${read.basis === 'tapped' ? ' (tapped)' : kind !== read.kind ? ' (it repeats your offer)' : ''}. The plan's answer: ${book.row[`${R}value_do`]}`,
      cites: [rowDo] });
  } else {
    refusals.push(`Read as ${SAID[kind]}, but the plan has no ${ROW_FOR[kind]} row for this step.`);
  }

  const walkCite = citeOf(book, `${P}walk_away_value_text`);
  const walkLine = () => { if (walkCite) claims.push({ text: `Walk-away line: ${book.row[`${P}walk_away_value_text`]}`, cites: [walkCite, ...walkNameCites()] }); };
  const maxGive = maxGiveIds;
  const walkNameCites = () => maxGive.flatMap(cellFor);
  const backupCite = citeOf(book, `${P}reply_table_value_decline_value_odds_after_value`);
  const backupAfter = backupCite ? book.row[`${P}reply_table_value_decline_value_odds_after_value`] : null;

  // E1: is "chance he says yes" proven? Read from the plan's copy of the report card.
  let e1 = null;
  for (let k = 0; Object.hasOwn(brain.row, `brain_report_checks_${k}_id`); k++) {
    if (brain.row[`brain_report_checks_${k}_id`] === 'E1') { e1 = k; break; }
  }
  const e1Status = e1 == null ? null : brain.row[`brain_report_checks_${e1}_status`];
  const e1Cites = e1 == null ? [] : [citeOf(brain, `brain_report_checks_${e1}_id`), citeOf(brain, `brain_report_checks_${e1}_status`)].filter(Boolean);
  const proven = e1Status === 'passing';
  const pLabel = proven ? 'E1 is passing on the report card'
    : e1Status ? `unproven: E1 (chance he says yes is calibrated) is ${String(e1Status).replace(/_/g, ' ')} on the report card`
      : 'unproven: the report card is not in the plan';

  const nameOf = pid => nameCore(names[pid] ?? `player ${pid}`);
  const list = ids => ids.map(nameOf).join(' + ');
  const draftAction = text => {
    if (!text) return [];
    const checked = validateAction({ type: 'draft_message', text, tone: 'neutral' });
    return checked.ok ? [checked.action] : [];
  };
  const finish = (recommendation, draft, reprice = []) => {
    const actions = draftAction(draft);
    if (draft && !actions.length) refusals.push('The draft names a number, so it is shown here but not put in the message box (numbers come only from the engine).');
    if (draft) {
      const draftCites = [...new Set([...step.give, ...step.get, ...(recommendation.counter_with ? [...recommendation.counter_with.give, ...recommendation.counter_with.get] : []), ...(reprice[0]?.give ?? []), ...(reprice[0]?.get ?? [])])].flatMap(cellFor);
      const src = recommendation.draft_cites ?? [];
      claims.push({ text: `Draft for you to copy and send yourself (Coach never sends): "${draft}"`,
        cites: [...new Set([...src, ...draftCites, rowDo].filter(Boolean))] });
    }
    const { draft_cites: _, ...rec } = recommendation;
    return done({ kind, recommendation: rec, reprice, draft: draft ?? null, actions });
  };

  if (kind === 'accept') {
    // RULES-EVERYWHERE: never draft an acceptance of a step that breaks one of Nick's hard rules.
    if (!ruleGate({ row, rows }, { leagueId: id }).ok(step.give, step.get)) {
      droppedByRule = 1;
      claims.push({ text: "Recommendation: walk. The step breaks one of Nick's hard rules, so Coach will not accept it.",
        cites: [citeOf(book, `${P}partner`)].filter(Boolean) });
      return finish({ do: 'walk', because: "the step breaks one of Nick's hard rules" }, "Can't do this one after all, so I'll pass. Thanks for looking.");
    }
    return finish({ do: 'take', because: 'he said yes to the step as offered' }, 'Deal. Accepting on my end now.');
  }
  if (kind === 'decline') {
    walkLine();
    return finish({ do: 'walk', because: 'he said no: the plan moves to the backup (the decline row)' }, null);
  }
  if (kind === 'stall' || kind === 'silence') {
    const whenCite = citeOf(book, `${R}value_when`);
    if (whenCite) claims.push({ text: `Wait: the nudge goes after ${book.row[`${R}value_when`]}.`, cites: [whenCite] });
    const msgCite = citeOf(book, `${R}value_message`);
    return finish({ do: 'wait', because: 'no answer yet: the plan nudges once, then switches to the backup',
      draft_cites: [msgCite].filter(Boolean) }, msgCite ? book.row[`${R}value_message`] : null);
  }

  /* counter */
  const engine = sources.engine(id);
  const owner = (() => {
    const fromEngine = engineOwner(engine, partner);
    return pid => fromEngine(pid) ?? (step.give.includes(pid) || maxGive.includes(pid) ? 'me' : step.get.includes(pid) ? 'him' : null);
  })();
  const pkg = counterPackage(reply, read.players, step, owner);
  if (pkg.unknown.length) {
    // Never judge a package with a player left out: dropping him could turn a richer ask into a "take".
    refusals.push(`Coach could not tell whose player ${pkg.unknown.length === 1 ? 'one named player is' : 'some named players are'} (the engine's rosters are not loaded), so it makes no call on this counter. Check it against the walk-away line yourself, or ask again in a moment.`);
    walkLine();
    return done({ kind });
  }
  if (!pkg.give.length || !pkg.get.length) {
    refusals.push('Coach could not read a whole package (who gives whom) from that counter. Paste his exact words, or tap counter and say the players.');
    return done({ kind });
  }

  // The engine's prices, recorded as one what_if entry: his counter, then (if needed) our counter.
  const counterRule = book.row[`${R}value_counter_rules_counter_with`] ?? null;
  const counterRuleCite = citeOf(book, `${R}value_counter_rules_counter_with`);
  const rung = typeof counterRule === 'string' ? counterRule.match(/next rung:\s*([\d\s+]+)/)?.[1] : null;
  const ourGive = rung ? rung.split('+').map(s => s.trim()).filter(Boolean) : idsAt(book.row, `${P}opening_value_give`);
  const ourGet = rung ? step.get : idsAt(book.row, `${P}opening_value_get`);
  const ours = ourGive.length && ourGet.length ? { give: ourGive, get: ourGet } : { give: step.give, get: step.get };

  const richer = maxGive.length ? pkg.give.some(pid => !maxGive.includes(pid)) : pkg.give.some(pid => !step.give.includes(pid));
  const givesStep = step.get.every(pid => pkg.get.includes(pid));
  const priced = [];
  const addPrice = (label, p) => {
    if (!engine) return null;
    let price = null;
    try { price = enginePrice(engine, { partner, ...p }); } catch { price = null; }
    if (!price) return null;
    const row = { package: label, partner, give: p.give, get: p.get, ...price, source: 'campaign adapter: world.rescore (season-sim tradeImpact) + priceStep (counterparty-pricing readDeal -> trade-acceptance band)' };
    priced.push(row);
    return row;
  };
  const hisPrice = addPrice('his_counter', pkg);
  const beatsBackup = hisPrice ? (backupAfter != null ? hisPrice.title_after > backupAfter : hisPrice.title_delta > 0) : null;

  let decision;
  if (richer) decision = 'walk';
  else if (givesStep && (beatsBackup ?? true)) decision = 'take';
  else decision = 'counter';
  // RULES-EVERYWHERE: never recommend taking, or countering with, a package that breaks one of Nick's hard rules.
  const gate = ruleGate({ row, rows }, { leagueId: id });
  const ruleWalk = (decision === 'take' && !gate.ok(pkg.give, pkg.get)) || (decision === 'counter' && !gate.ok(ours.give, ours.get));
  if (ruleWalk) { decision = 'walk'; droppedByRule = 1; }
  const ourPrice = decision === 'counter' ? addPrice('counter_with', ours) : null;

  // The packages as read (Nick's paste, parsed; ids and names only), then the engine's
  // prices as their own entry (arrays stay out: a cite lands on a scalar).
  const pkgRow = (label, p) => {
    const row = { package: label, partner };
    p.give.forEach((pid, k) => { row[`give_${k}`] = pid; row[`give_${k}_name`] = names[pid] ?? `player ${pid}`; });
    p.get.forEach((pid, k) => { row[`get_${k}`] = pid; row[`get_${k}_name`] = names[pid] ?? `player ${pid}`; });
    return row;
  };
  const read2 = safeRecord(ledger, [pkgRow('his_counter', pkg), ...(decision === 'counter' ? [pkgRow('counter_with', ours)] : [])],
    'reply_read', []);
  const pkgCites = (k, p) => [...p.give.flatMap((_, j) => [`give_${j}`, `give_${j}_name`]), ...p.get.flatMap((_, j) => [`get_${j}`, `get_${j}_name`]), 'partner']
    .map(col => `${read2.id}#${k}.${col}`);
  const scalarRows = priced.map(r => Object.fromEntries(Object.entries(r).filter(([, v]) => !Array.isArray(v))));
  const wi = scalarRows.length ? safeRecord(ledger, scalarRows, 'what_if', ['season_sim_trade_impact', 'trade_acceptance_band']) : null;
  const wc = (k, col) => (wi && Object.hasOwn(wi.rows[k], col) && wi.rows[k][col] != null ? `${wi.id}#${k}.${col}` : null);
  const partnerCite = citeOf(book, `${P}partner`);

  claims.push({ text: `His counter: you give ${list(pkg.give)}, you get ${list(pkg.get)} (Team ${partner}).`,
    cites: [...pkgCites(0, pkg), partnerCite].filter(Boolean) });
  if (hisPrice) {
    claims.push({ text: `The engine re-prices it: your title odds ${pct(hisPrice.title_before)}% -> ${pct(hisPrice.title_after)}% (${pts(hisPrice.title_delta)} pts${Number.isFinite(hisPrice.title_delta_se) ? `, noise ${(hisPrice.title_delta_se * 100).toFixed(1)}` : ''}).`,
      cites: [wc(0, 'title_before'), wc(0, 'title_after'), wc(0, 'title_delta'), wc(0, 'title_delta_se')].filter(Boolean) });
    if (backupCite) {
      claims.push({ text: `Your backup (the decline row) leaves title odds at ${pct(backupAfter)}%; this counter ${beatsBackup ? 'beats' : 'does not beat'} it.`,
        cites: [backupCite, wc(0, 'title_after')].filter(Boolean) });
    }
  } else {
    refusals.push(`His counter is not re-priced: the engine is ${engine ? 'unable to price this package' : `not loaded for this league on this server${engineWhy.get(id) ? ` (${engineWhy.get(id)})` : ''}`}, so Coach judges it on the plan's walk-away alone and states no title-odds change for it.`);
  }

  const ruleCite = citeOf(book, `${R}value_counter_rules_${decision === 'walk' ? 'walk_away_if' : decision === 'take' ? 'accept_if' : 'counter_with'}`);
  let draft;
  const recommendation = { do: decision };
  if (decision === 'walk' && ruleWalk) {
    recommendation.because = "the package breaks one of Nick's hard rules";
    claims.push({ text: "Recommendation: walk. That package breaks one of Nick's hard rules, so Coach will not take it or counter with it.",
      cites: [...pkgCites(0, pkg)].filter(Boolean) });
    walkLine();
    draft = "Can't go that far on my end, so I'll pass on this one. Thanks for looking.";
  } else if (decision === 'walk') {
    recommendation.because = 'his ask is richer than the walk-away package';
    claims.push({ text: `Recommendation: walk. ${book.row[`${R}value_counter_rules_walk_away_if`] ?? 'He asks for more than the walk-away package.'}`,
      cites: [ruleCite, ...walkNameCites(), ...pkgCites(0, pkg)].filter(Boolean) });
    walkLine();
    draft = "Can't go that far on my end, so I'll pass on this one. Thanks for looking.";
  } else if (decision === 'take' && read.basis !== 'tapped' && endsNegative(reply)) {
    // Never draft an acceptance to a reply whose last word is a no: ask Nick instead.
    recommendation.do = 'ask';
    recommendation.because = 'his reply ends on a no, so Coach will not draft an acceptance';
    refusals.push('His reply ends on a no, so Coach will not draft "deal". If he really offered that package, tap counter; if it is a no, tap decline.');
    draft = null;
  } else if (decision === 'take') {
    recommendation.because = hisPrice ? 'inside the walk-away and the engine re-price beats the backup' : 'inside the walk-away (not re-priced)';
    claims.push({ text: `Recommendation: take it. ${book.row[`${R}value_counter_rules_accept_if`] ?? 'His ask is inside the walk-away package.'}`,
      cites: [ruleCite, ...walkNameCites(), ...pkgCites(0, pkg)].filter(Boolean) });
    draft = "Deal. Send it over and I'll accept.";
  } else {
    recommendation.because = !givesStep ? 'he offers less than the step gets' : 'the engine re-price falls below the backup';
    recommendation.counter_with = ours;
    const k = ourPrice ? priced.indexOf(ourPrice) : -1;
    const oursCites = pkgCites(1, ours);
    claims.push({ text: `Recommendation: counter. Counter with ${list(ours.give)} for ${list(ours.get)} (the plan's counter: ${counterRule ?? 'the opening'}).`,
      cites: [...oursCites, counterRuleCite].filter(Boolean) });
    if (ourPrice) {
      claims.push({ text: `The engine prices your counter: title odds ${pct(ourPrice.title_before)}% -> ${pct(ourPrice.title_after)}% (${pts(ourPrice.title_delta)} pts).`,
        cites: [wc(k, 'title_before'), wc(k, 'title_after'), wc(k, 'title_delta')].filter(Boolean) });
      if (ourPrice.p_yes != null) {
        const band = ourPrice.p_yes_low != null && ourPrice.p_yes_high != null ? ` (band ${pct(ourPrice.p_yes_low)}% to ${pct(ourPrice.p_yes_high)}%)` : '';
        claims.push({ text: `Chance he says yes to it, from the one counterpart model: ${pct(ourPrice.p_yes)}%${band}; ${pLabel}.`,
          cites: [wc(k, 'p_yes'), wc(k, 'p_yes_low'), wc(k, 'p_yes_high'), ...e1Cites].filter(Boolean) });
      }
    }
    walkLine();
    recommendation.draft_cites = oursCites;
    draft = `Can't do that one. Would you do ${list(ours.give)} for ${list(ours.get)}?`;
  }
  const reprice = priced.map(({ source: _s, ...r }) => r);
  return finish(recommendation, draft, reprice);
}

/* ------------------------------------------------------------ tool */

/** Coach's negotiate_reply tool (COACH-ANCHOR.md job 2), run by tools.js#runCoachTool. */
export const NEG_TOOL = Object.freeze({
  name: 'negotiate_reply', kind: 'negotiate', source: 'server/services/coach/negotiator.js#negotiate',
  tables: ['warroom_plans_file', 'season_sim_trade_impact', 'trade_acceptance_band'],
  description: "Live negotiation copilot for the next move. Pass the partner's reply to Nick's offer as `reply` (his " +
    'words as Nick pasted them), or `reply_kind` when Nick tapped what it was (accept, counter, decline, stall, silence). ' +
    "It classifies the reply, shows the plan's pre-planned answer for it, and for a counter re-prices his package with " +
    "the engine (title odds from the rescorer, chance he says yes from the one counterpart model) and says take it, " +
    "counter with a package, or walk, by the plan's walk-away rule. It returns ready-made claims with cites and a draft " +
    'for the message box; put the claims in your answer as they are. Never state a price yourself, and never say an ' +
    'offer was sent: Nick sends it.',
  input_schema: { type: 'object', required: ['league_id'], properties: {
    league_id: { type: 'integer', description: "the user's league id" },
    reply: { type: 'string', description: "the partner's reply, as Nick pasted it" },
    reply_kind: { type: 'string', enum: [...REPLY_KINDS], description: 'what Nick tapped, when he tapped instead of pasting' },
    step: { type: 'integer', description: 'which step of the next move (0 = the first), default 0' } } },
  run(input, { ledger }) {
    return negotiate({ leagueId: input?.league_id, reply: String(input?.reply ?? ''), replyKind: input?.reply_kind ?? null,
      stepIndex: input?.step ?? 0, ledger });
  }
});
