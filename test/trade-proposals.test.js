/**
 * sendable-proposals: the AI pass that turns numeric trade ideas into messages
 * Nick can actually send — and the verifier that stops it inventing anything.
 *
 * Master plan D4: "once per league per day, Sonnet 5 turns the top ~12 numeric
 * ideas into 5-8 sendable proposals ... It may drop or merge ideas; it may not
 * invent players or numbers (verified after the call). Cached per league-day."
 *
 * Gates pre-registered in docs/tdd/sendable-proposals.tdd.md BEFORE this file
 * was written (G1-G6). No model is called anywhere below: the caller is
 * injected, so every test is deterministic and costs $0.
 *
 *  G1 nothing invented — a proposal naming a player or a number the source
 *    ideas do not contain is REJECTED WHOLE, never quietly repaired.
 *  G2 the call is bounded — one call per slate, budget key
 *    trade_proposals:league-<id>, a budget refusal propagates as a refusal.
 *  G3 the cache is content-keyed — unchanged slate hits, changed slate or
 *    changed prompt version misses.
 *  G4 honest degradation — no ideas / no key / malformed response each give a
 *    stated reason and no proposals, never a partial parse.
 *  G5 the edge test survives — every proposal traces to a source idea by id.
 *  G6 the shape D4 asks for — a missing required field rejects that proposal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyProposals, cacheKeyFor, proposalsFor, proposalsPrompt, liveCaller,
  PROMPT_VERSION, REQUIRED_PROPOSAL_FIELDS, FAILED_SLATE_TTL_MS, RESPONSE_PROBLEMS,
} from '../server/services/trade-proposals.js';
import { budgetKeyFor, DEFAULT_DAILY_BUDGETS_USD, PRICING } from '../server/services/llm-budget.js';

/* ------------------------------------------------------------- fixtures */

const idea = (over = {}) => ({
  id: 'idea-1',
  partner: 'Raj', partner_id: '3',
  i_give: [{ name: 'Jaylen Waddle', value: 3200 }],
  i_get: [{ name: "De'Von Achane", value: 3400 }],
  me: { ppg_delta: 2.4 },
  their_value_pct: 6,
  acceptance: { band: { low: 0.18, mid: 0.31, high: 0.44 } },
  ...over,
});

const proposal = (over = {}) => ({
  idea_ids: ['idea-1'],
  package: { i_give: ['Jaylen Waddle'], i_get: ["De'Von Achane"] },
  why_they_say_yes: 'He has wanted Waddle since the draft.',
  opener: 'Yo — would you do Waddle for Achane straight up?',
  ask: 'Waddle', fair: 'Waddle', floor: 'Waddle plus a bench flier',
  timing: { send: 'now', reason: 'he answers fastest on Thursday nights' },
  risk: 'Achane is the better player if his role holds.',
  data_used: ['ppg_delta', 'acceptance band'],
  ...over,
});

const universe = ['Jaylen Waddle', "De'Von Achane", 'Patrick Mahomes', 'Tyler Warren'];

/* ------------------------------------------------------- G1 nothing invented */

test('G1 a proposal naming a player who is in no source idea is rejected whole', () => {
  const bad = proposal({ package: { i_give: ['Jaylen Waddle'], i_get: ['Patrick Mahomes'] } });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, 'it does not survive');
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0].violations.some(v => /Patrick Mahomes/.test(v)),
    'the violation names the invented player');
});

test('G1 an invented player in the PROSE is caught, not just in the package', () => {
  const bad = proposal({ opener: "Would you do Waddle for Achane? I'd even add Tyler Warren." });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, 'a package sneaked into the opener is still a package');
  assert.ok(r.rejected[0].violations.some(v => /Tyler Warren/.test(v)));
});

test('G1 a number the source ideas do not contain is rejected', () => {
  const bad = proposal({ why_they_say_yes: 'It is worth 9.7 points a week to him.' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0);
  assert.ok(r.rejected[0].violations.some(v => /9\.7/.test(v)), 'the violation names the number');
});

test('G1 numbers that ARE in the source ideas pass, in any reasonable formatting', () => {
  const good = proposal({ why_they_say_yes: 'It is +2.4 a week for you and he gets 6% more value.' });
  const r = verifyProposals([good], [idea()], { universe });
  assert.equal(r.rejected.length, 0, `unexpected: ${JSON.stringify(r.rejected)}`);
  assert.equal(r.ok.length, 1);
});

test('G1 a rejected proposal is never returned in a repaired form', () => {
  const bad = proposal({ risk: 'He may counter asking for 12.5 ppg of value.' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0);
  // The rejected entry carries the ORIGINAL, so a reviewer sees what the model
  // actually said rather than a cleaned-up version of it.
  assert.equal(r.rejected[0].proposal.risk, bad.risk);
});

/* --------------------------------------------------- G5 the edge test survives */

test('G5 a proposal citing no source idea is rejected', () => {
  const r = verifyProposals([proposal({ idea_ids: [] })], [idea()], { universe });
  assert.equal(r.ok.length, 0);
  assert.ok(r.rejected[0].violations.some(v => /idea/i.test(v)));
});

test('G5 a proposal citing an idea id that was never supplied is rejected', () => {
  const r = verifyProposals([proposal({ idea_ids: ['idea-99'] })], [idea()], { universe });
  assert.equal(r.ok.length, 0);
  assert.ok(r.rejected[0].violations.some(v => /idea-99/.test(v)),
    'it cannot cite a package that never passed the edge filter');
});

test('G5 merging two real ideas is allowed — D4 permits drop and merge', () => {
  const two = [idea(), idea({ id: 'idea-2', i_give: [{ name: 'Tyler Warren', value: 900 }] })];
  const merged = proposal({ idea_ids: ['idea-1', 'idea-2'],
    package: { i_give: ['Jaylen Waddle', 'Tyler Warren'], i_get: ["De'Von Achane"] } });
  const r = verifyProposals([merged], two, { universe });
  assert.equal(r.rejected.length, 0, `unexpected: ${JSON.stringify(r.rejected)}`);
});

/* ------------------------------------------------------------- G6 the shape */

test('G6 every field D4 asks for is required, and a missing one rejects the proposal', () => {
  assert.ok(REQUIRED_PROPOSAL_FIELDS.length >= 7, 'the D4 field list is declared, not implicit');
  for (const field of REQUIRED_PROPOSAL_FIELDS) {
    const missing = { ...proposal() };
    delete missing[field];
    const r = verifyProposals([missing], [idea()], { universe });
    assert.equal(r.ok.length, 0, `${field} must be required`);
    assert.ok(r.rejected[0].violations.some(v => v.includes(field)),
      `the violation names the missing field ${field}`);
  }
});

/* -------------------------------------------------------------- G3 the cache */

test('G3 the cache key is content-keyed: an unchanged slate keys the same', () => {
  assert.equal(cacheKeyFor(4, [idea()]), cacheKeyFor(4, [idea()]),
    'the same slate must not re-spend');
});

test('G3 a changed slate, a different league, or a bumped prompt version all miss', () => {
  const base = cacheKeyFor(4, [idea()]);
  assert.notEqual(base, cacheKeyFor(4, [idea({ me: { ppg_delta: 9.9 } })]), 'changed numbers miss');
  assert.notEqual(base, cacheKeyFor(5, [idea()]), 'another league is another key');
  assert.notEqual(base, cacheKeyFor(4, [idea(), idea({ id: 'idea-2' })]), 'a longer slate misses');
  assert.match(PROMPT_VERSION, /\S/, 'the prompt version is part of the key by construction');
});

/* --------------------------------- G2 bounded, and G4 honest degradation */

test('G4 no ideas produces no proposals, with a reason, and never calls the model', async () => {
  let called = 0;
  const r = await proposalsFor(4, { ideas: [], universe, call: async () => { called++; } });
  assert.equal(r.proposals.length, 0);
  assert.match(r.reason, /no ideas/i);
  assert.equal(called, 0, 'nothing to propose is not a reason to spend money');
});

test('G2 exactly one model call is made for one slate', async () => {
  let called = 0;
  const call = async () => { called++; return JSON.stringify([proposal()]); };
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(called, 1);
  assert.equal(r.proposals.length, 1);
});

test('G3 a second run on the same slate is served from cache and calls nothing', async () => {
  let called = 0;
  const cache = memCache();
  const call = async () => { called++; return JSON.stringify([proposal()]); };
  await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  const second = await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  assert.equal(called, 1, 'an unchanged slate must not re-spend');
  assert.equal(second.source, 'cache');
  assert.equal(second.proposals.length, 1);
});

test('G2 a budget refusal propagates as a refusal, not as an empty success', async () => {
  const call = async () => { const e = new Error('daily budget for trade proposals is spent'); e.status = 429; throw e; };
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 0);
  assert.match(r.reason, /budget/i, 'it says the budget stopped it');
  assert.equal(r.refused, true, 'a refusal is flagged, not dressed as "no proposals today"');
});

test('G4 a malformed model response is refused, never partially parsed', async () => {
  const call = async () => 'here are your proposals: [{"package": ';
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 0);
  // The alternation this replaces passed on a TRUNCATED answer too: the
  // truncated sentence at trade-proposals.js:681 also contains "could not be
  // read", so the test named for a malformed response never distinguished the
  // two problems it exists to keep apart. `RESPONSE_PROBLEMS` makes them
  // distinguishable in one word, so the code is asserted and the sentence with it.
  assert.equal(r.problem, 'unreadable', `${r.reason}`);
  assert.match(r.reason, /the model response could not be read as JSON/,
    `the reason must be the unreadable one, got ${JSON.stringify(r.reason)}`);
  assert.doesNotMatch(r.reason, /ran out of output room/,
    'and never the truncated one, which is a different problem with a different fix');
  assert.equal(r.refused, true);
});

test('G4 a response whose proposals all fail verification returns none, and says why', async () => {
  const call = async () => JSON.stringify([proposal({ package: { i_give: ['Jaylen Waddle'], i_get: ['Patrick Mahomes'] } })]);
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 0);
  assert.ok(r.rejected.length > 0, 'the rejects are reported, not swallowed');
  assert.equal(r.problem, 'all_rejected', `${r.reason}`);
  assert.match(r.reason, /every proposal failed verification and was rejected/,
    `the reason must say the verifier did its job, got ${JSON.stringify(r.reason)}`);
  assert.match(r.reason, new RegExp(`${r.rejected.length} in total`),
    'and carry the count, so "one bad proposal" cannot read like "the model is broken"');
});

test('G4 a TRANSIENT refusal is not cached, so a later good run can still happen', async () => {
  // Budget spent, no key, the model unreachable: nothing about the slate is
  // wrong, so the next page load is allowed to try again. Contrast G7 below,
  // where the response itself can never parse and re-paying for it is waste.
  const cache = memCache();
  let called = 0;
  const bad = async () => { called++; throw Object.assign(new Error('overloaded'), { status: 529 }); };
  await proposalsFor(4, { ideas: [idea()], universe, call: bad, cache });
  const good = async () => { called++; return JSON.stringify([proposal()]); };
  const r = await proposalsFor(4, { ideas: [idea()], universe, call: good, cache });
  assert.equal(called, 2, 'a transient refusal must not poison the cache entry');
  assert.equal(r.proposals.length, 1);
});

/** A cache with the same two-method shape the DB-backed one exposes. */
function memCache() {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}

/* ======================================================================
 * Adversarial second pass (verify:sendable-proposals, 2026-09-19).
 *
 * Every test below is a way a fabricated player or number reached Nick past
 * the first version of the verifier. They were written as a batch of repros
 * BEFORE the fixes, and each one names the smuggle it closes. The point of
 * this file is not that good proposals pass — it is that bad ones cannot.
 * ====================================================================== */

/* ------------------------------------------- V: players, however they are written */

test('V a surname on its own is caught — league-mates are texted by surname, not by full name', () => {
  // The fixture's own opener says "Waddle for Achane". If only full names are
  // matched, the ONE form the model actually writes in is the one that is free.
  const bad = proposal({ opener: 'Waddle for Achane? I can add Mahomes if you need a QB.' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, 'a surname is a name');
  assert.ok(r.rejected[0].violations.some(v => /Mahomes/.test(v)));
});

test('V a name in a different case is caught', () => {
  const bad = proposal({ opener: 'waddle for achane, plus patrick mahomes on my side.' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0);
  assert.ok(r.rejected[0].violations.some(v => /Mahomes/i.test(v)));
});

test('V a name split by a line break or an odd space is caught', () => {
  for (const gap of ['\n', ' ', '  ']) {
    const bad = proposal({ opener: `Waddle for Achane, and I will add Patrick${gap}Mahomes.` });
    const r = verifyProposals([bad], [idea()], { universe });
    assert.equal(r.ok.length, 0, `a ${JSON.stringify(gap)} between the names is still the name`);
  }
});

test('V the surnames of players that ARE in the cited ideas still pass', () => {
  // The strict direction has a cost too: this is the guard that the fix above
  // does not start rejecting every ordinary sentence Nick would actually send.
  const good = proposal({ opener: 'Waddle for Achane straight up?',
    why_they_say_yes: 'Achane is the upside swing and Waddle is the safer week.' });
  const r = verifyProposals([good], [idea()], { universe });
  assert.equal(r.rejected.length, 0, `unexpected: ${JSON.stringify(r.rejected)}`);
});

test('V a typographic apostrophe is the same player, not an invented one', () => {
  // A model writing prose renders De'Von as De’Von. Exact string matching calls
  // that a fabricated player and throws away a correct proposal.
  const good = proposal({ package: { i_give: ['Jaylen Waddle'], i_get: ['De’Von Achane'] } });
  const r = verifyProposals([good], [idea()], { universe });
  assert.equal(r.rejected.length, 0, `unexpected: ${JSON.stringify(r.rejected)}`);
});

test('V the package must be structured, so a swap cannot hide in a prose string', () => {
  const bad = proposal({ package: 'Waddle plus a bench flier for Achane' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, 'an unstructured package skips the name check entirely');
  assert.ok(r.rejected[0].violations.some(v => /package/.test(v)));
});

/* ---------------------------------------------- V: numbers, wherever they are put */

test('V a number returned as JSON rather than inside a sentence is still verified', () => {
  // The prompt asks for "ask / fair / floor" and "which numbers you leaned on".
  // A model answering those with JSON numbers was never checked at all.
  const bad = proposal({ ask: 4800, fair: 4200, floor: 3900 });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, 'a number is a number whether or not it is quoted');
  assert.ok(r.rejected[0].violations.some(v => /4800/.test(v)));
});

test('V a fabricated number nested in data_used is caught', () => {
  const bad = proposal({ data_used: { their_value_gain_pct: 23, my_ppg_gain: 4.8 } });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0);
  assert.ok(r.rejected[0].violations.some(v => /23|4\.8/.test(v)));
});

test('V a real number returned as JSON still passes', () => {
  const good = proposal({ data_used: { my_ppg_gain: 2.4, their_value_pct: 6 } });
  const r = verifyProposals([good], [idea()], { universe });
  assert.equal(r.rejected.length, 0, `unexpected: ${JSON.stringify(r.rejected)}`);
});

test('V nothing hides under a nested idea_ids key', () => {
  // idea_ids is skipped as structure — but only the real one at the top level.
  const bad = proposal({ data_used: { idea_ids: 'He is averaging 27.4 ppg over his last three.' } });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0);
  assert.ok(r.rejected[0].violations.some(v => /27\.4/.test(v)));
});

test('V a ppg delta does not license the same digits as a yardage claim', () => {
  // me.ppg_delta is 2.4, and every number was allowed at n*100 "as a percentage",
  // which quietly made 240 a verified number.
  const bad = proposal({ risk: 'He is averaging 240 receiving yards a game, so this may not hold.' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, '2.4 points a week is not 240 of anything');
  assert.ok(r.rejected[0].violations.some(v => /240/.test(v)));
});

test('V a real RATE may still be written as a percentage', () => {
  const good = proposal({ why_they_say_yes: 'He says yes about 31% of the time on deals like this.' });
  const r = verifyProposals([good], [idea()], { universe });
  assert.equal(r.rejected.length, 0, `0.31 written as 31% is the same number: ${JSON.stringify(r.rejected)}`);
});

test('V a decimal written without its leading zero is read, not skipped', () => {
  const bad = proposal({ why_they_say_yes: 'You win this trade .85 of the time.' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, '.85 is a number even though it does not start with a digit');
});

test('V a real value written with a thousands separator is not read as two numbers', () => {
  const good = proposal({ data_used: ['his value is 3,400 against my 3,200'] });
  const r = verifyProposals([good], [idea()], { universe });
  assert.equal(r.rejected.length, 0, `unexpected: ${JSON.stringify(r.rejected)}`);
});

/* ------------------------------------------------------------- V: the shape (G6) */

test('V an empty required field is as missing as an absent one', () => {
  for (const [field, empty] of [['opener', ''], ['risk', '   '], ['data_used', []], ['timing', {}]]) {
    const r = verifyProposals([proposal({ [field]: empty })], [idea()], { universe });
    assert.equal(r.ok.length, 0, `${field} = ${JSON.stringify(empty)} is not a ${field}`);
    assert.ok(r.rejected[0].violations.some(v => v.includes(field)));
  }
});

/* ----------------------------------------------------- V: the cache and the wiring */

test('V the cache key covers everything the prompt shows the model', () => {
  // A key that hashes a subset of the prompt serves yesterday's answer for a
  // slate whose reasoning has changed — the partner, the tactic, the timing.
  const a = idea();
  const b = idea({ partner: 'Dan', partner_id: '7',
    tactics: [{ key: 'post_loss', why: 'he just lost by 40' }] });
  assert.notEqual(proposalsPrompt([a]), proposalsPrompt([b]), 'the model is shown different things');
  assert.notEqual(cacheKeyFor(4, [a]), cacheKeyFor(4, [b]),
    'so it must not be served the other one from cache');
});

test('V ideas that arrive without a usable id are refused BEFORE the model is called', () => {
  // findTrades' deals carry no `id` (trade-engine.js:1656). Handed those, every
  // proposal is untraceable and rejected — after paying for the call, and the
  // refusal is not cached, so the next page load pays again.
  let called = 0;
  const call = async () => { called++; return '[]'; };
  const noId = { ...idea() }; delete noId.id;
  return proposalsFor(4, { ideas: [noId], universe, call, cache: memCache() }).then(r => {
    assert.equal(called, 0, 'an untraceable slate must not be paid for');
    assert.equal(r.proposals.length, 0);
    assert.equal(r.refused, true);
    assert.match(r.reason, /id/i, 'the reason says what is wrong with the slate');
  });
});

test('V two ideas sharing one id are refused, not silently collapsed', async () => {
  let called = 0;
  const call = async () => { called++; return '[]'; };
  const r = await proposalsFor(4, { ideas: [idea(), idea()], universe, call, cache: memCache() });
  assert.equal(called, 0);
  assert.equal(r.refused, true, 'one id cannot stand for two different packages');
});

test('V a cached row that is not a proposals payload is a miss, not an empty success', async () => {
  let called = 0;
  const cache = { get: () => ({}), set: () => { called += 0; } };
  const call = async () => { called++; return JSON.stringify([proposal()]); };
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  assert.equal(called, 1, 'a corrupt row costs one re-spend, it does not empty Trade Lab');
  assert.equal(r.proposals.length, 1);
  assert.notEqual(r.source, 'cache');
});

test('G2 liveCaller asks for a model we can price, on a key that has a real budget', async () => {
  // If the feature string ever drifts off `trade_proposals:...`, budgetKeyFor
  // resolves to a key with no default budget and reserveBudget becomes a no-op:
  // the daily cap silently stops existing. This pins that it resolves.
  let sent = null;
  await liveCaller(async args => { sent = args; return '[]'; })({ leagueId: 4, ideas: [idea()] });
  assert.match(sent.feature, /^trade_proposals:league-4$/);
  assert.ok(Object.hasOwn(DEFAULT_DAILY_BUDGETS_USD, budgetKeyFor(sent.feature)),
    `budgetKeyFor(${sent.feature}) must be a budgeted key, or the call is uncapped`);
  assert.ok(Object.hasOwn(PRICING, sent.model), `${sent.model} must be a priced model`);
});

/* ======================================================================
 * G7: the envelope a real call actually returns (live bug, 2026-09-19).
 *
 * `callClaude` returns an Anthropic Message — `{ id, type: 'message', role,
 * model, content: [{ type: 'text', text }], stop_reason, usage, cost_usd }` —
 * and `liveCaller` handed that object straight to `proposalsFor`, which is
 * neither a string nor an array, so `Array.isArray(parsed)` failed and every
 * single live request returned "the model response was not a list of
 * proposals" AFTER paying for the call. Thirty-eight passing tests missed it
 * because every one of them stubbed the caller with a JSON STRING.
 *
 * So these drive the real envelope, and each way it can be malformed gets its
 * own distinguishable reason: a truncated answer is a different problem from a
 * model that declined, and Nick has to be able to tell them apart.
 * ====================================================================== */

/** A realistically shaped Anthropic message, as `callClaude` returns it. */
const envelope = (text, over = {}) => ({
  id: 'msg_01LiveEnvelope', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: text == null ? [] : [{ type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 7213, output_tokens: 1180, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0 },
  cost_usd: 0.0262,
  ...over,
});

test('G7 a real Anthropic message through liveCaller produces real proposals', async () => {
  const call = liveCaller(async () => envelope(JSON.stringify([proposal()])));
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 1, `the answer we paid for must not be discarded: ${r.reason}`);
  assert.equal(r.source, 'model');
  assert.ok(!r.refused, 'a good answer is not a refusal');
});

test('G7 proposalsFor also reads a raw message, so a caller wired straight to callClaude works', async () => {
  // Defence in depth: the bug was in liveCaller, but the next caller that
  // forgets to unwrap should not silently burn the budget either.
  const r = await proposalsFor(4, { ideas: [idea()], universe, cache: memCache(),
    call: async () => envelope(JSON.stringify([proposal()])) });
  assert.equal(r.proposals.length, 1, r.reason);
});

test('G7 a leading thinking block and several text blocks are read, not tripped over', async () => {
  const json = JSON.stringify([proposal()]);
  const split = [{ type: 'thinking', thinking: 'Waddle for Achane is the only clean one.', signature: 'sig' },
    { type: 'text', text: json.slice(0, 40) }, { type: 'text', text: json.slice(40) }];
  const call = liveCaller(async () => envelope(null, { content: split }));
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 1, `text blocks join in order, thinking is skipped: ${r.reason}`);
});

test('G7 a fenced ```json answer is read', async () => {
  const call = liveCaller(async () => envelope('```json\n' + JSON.stringify([proposal()]) + '\n```'));
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 1, `a fence is formatting, not a failure: ${r.reason}`);
});

test('G7 a max_tokens answer cut off mid-array says it was cut off, not that it was malformed', async () => {
  const cut = JSON.stringify([proposal(), proposal()]).slice(0, 180);
  const call = liveCaller(async () => envelope('```json\n' + cut, { stop_reason: 'max_tokens' }));
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 0, 'half a proposal is never trusted');
  assert.equal(r.refused, true);
  assert.equal(r.problem, 'truncated');
  assert.match(r.reason, /ran out of output room part-way through/,
    `the reason has to name the real problem: ${r.reason}`);
  assert.match(r.reason, /cut off mid-answer/,
    'and say what that did to the answer, not only what the model ran out of');
  assert.doesNotMatch(r.reason, /could not be read as JSON/,
    'and it must not be the unreadable sentence, which is a broken model rather than a long one');
});

test('G7 a refusal with no text block says the model declined', async () => {
  const call = liveCaller(async () => envelope(null, { stop_reason: 'refusal', content: [] }));
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.refused, true);
  assert.equal(r.problem, 'declined');
  assert.match(r.reason, /declin/i, r.reason);
});

test('G7 an answer with no text block at all is its own problem, not a parse error', async () => {
  const call = liveCaller(async () => envelope(null,
    { content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] }));
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.refused, true);
  assert.equal(r.problem, 'no_text');
  assert.match(r.reason, /no text/i, r.reason);
});

test('G7 the four failure modes are told apart, not flattened into one message', async () => {
  const run = async over => {
    const call = liveCaller(async () => (typeof over === 'string' ? envelope(over) : envelope(null, over)));
    return proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  };
  const seen = await Promise.all([
    run('```json\n[{"opener": "half a'.padEnd(30, ' ')),            // unreadable JSON
    run({ stop_reason: 'refusal', content: [] }),                    // declined
    run({ content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }), // no text
    run(JSON.stringify({ proposals: [] })),                          // valid JSON, wrong shape
  ]);
  assert.deepEqual(seen.map(r => r.problem), ['unreadable', 'declined', 'no_text', 'not_a_list']);
  assert.equal(new Set(seen.map(r => r.reason)).size, 4, 'four problems, four reasons');
  for (const r of seen) {
    assert.ok(RESPONSE_PROBLEMS.includes(r.problem), `${r.problem} is a declared problem code`);
  }
  for (const r of seen) assert.equal(r.proposals.length, 0);
});

test('G7 the cost of a wasted call is reported, so a discarded answer is not invisible', async () => {
  const call = liveCaller(async () => envelope('not json at all'));
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.cost_usd, 0.0262, 'the money was spent — say so');
});

/* -------------------------------- G7 fail closed: pay once per broken slate */

test('G7 a structurally broken response does not buy a second call for the same slate', async () => {
  const cache = memCache();
  let called = 0;
  const call = liveCaller(async () => { called++; return envelope(JSON.stringify({ proposals: [] })); });
  const first = await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  const second = await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  assert.equal(called, 1, 'the same unparseable slate must not be paid for twice');
  assert.equal(second.problem, first.problem, 'and the second answer says the same honest thing');
  assert.equal(second.source, 'cache');
  assert.equal(second.refused, true);
  // One producer, one sentence, and both branches of the pattern this replaces
  // matched it — so the assertion proved only that the sentence existed.
  assert.equal(second.problem, 'not_a_list', second.reason);
  // Two facts, asserted as two: the stored sentence the first call produced,
  // and the clause the cached answer adds on top of it. The pattern this
  // replaces had both of its branches inside the first clause alone, so it
  // could not tell a cached answer from a fresh one.
  assert.match(second.reason, /^the model response was not a list of proposals — /,
    `the stored sentence has to survive the cache verbatim, got ${JSON.stringify(second.reason)}`);
  assert.match(second.reason, /was not paid for again/,
    'and the cached answer has to say it was not paid for twice');
  assert.ok(second.retry_after, 'with a stated moment it will be tried again');
});

test('G7 a slate where every proposal is rejected is not paid for twice either', async () => {
  const cache = memCache();
  let called = 0;
  const invented = proposal({ package: { i_give: ['Jaylen Waddle'], i_get: ['Patrick Mahomes'] } });
  const call = liveCaller(async () => { called++; return envelope(JSON.stringify([invented])); });
  const first = await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  const second = await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  assert.equal(called, 1);
  assert.equal(first.rejected.length, 1);
  assert.equal(second.rejected.length, 1, 'the violations survive, so the page still shows what was wrong');
  assert.equal(second.source, 'cache');
});

test('G7 a changed slate is tried again even while the broken one is remembered', async () => {
  const cache = memCache();
  let called = 0;
  // liveCaller hands callClaude's own arguments down, so the stub reads the
  // slate off the prompt it was asked to send.
  const call = liveCaller(async ({ prompt }) => {
    called++;
    return envelope(prompt.includes('"idea-2"')
      ? JSON.stringify([proposal({ idea_ids: ['idea-2'] })]) : 'not json');
  });
  await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  assert.equal(called, 1, 'the broken slate is remembered');
  const other = idea({ id: 'idea-2' });
  const r = await proposalsFor(4, { ideas: [other], universe, call, cache });
  assert.equal(called, 2, 'a different slate is a different question');
  assert.equal(r.proposals.length, 1, r.reason);
});

test('G7 the short-circuit expires, so a broken slate is not broken forever', async () => {
  const cache = memCache();
  let called = 0;
  let answer = 'not json';
  const call = liveCaller(async () => { called++; return envelope(answer); });
  const t0 = Date.parse('2026-09-19T18:00:00Z');
  await proposalsFor(4, { ideas: [idea()], universe, call, cache, now: t0 });
  await proposalsFor(4, { ideas: [idea()], universe, call, cache, now: t0 + FAILED_SLATE_TTL_MS - 1 });
  assert.equal(called, 1, 'inside the window it is not re-sent');
  answer = JSON.stringify([proposal()]);
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache, now: t0 + FAILED_SLATE_TTL_MS + 1 });
  assert.equal(called, 2, 'after the window one more attempt is allowed');
  assert.equal(r.proposals.length, 1, r.reason);
});

test('G7 a budget refusal is still never remembered — nothing is wrong with the slate', async () => {
  const cache = memCache();
  let called = 0;
  const call = async () => {
    called++;
    if (called === 1) throw Object.assign(new Error('Today\'s trade proposals budget is used'), { status: 429 });
    return envelope(JSON.stringify([proposal()]));
  };
  const first = await proposalsFor(4, { ideas: [idea()], universe, call: liveCaller(call), cache });
  assert.match(first.reason, /budget/i);
  assert.equal(first.problem, 'call_failed');
  const r = await proposalsFor(4, { ideas: [idea()], universe, call: liveCaller(call), cache });
  assert.equal(called, 2, 'tomorrow\'s budget must not be blocked by today\'s');
  assert.equal(r.proposals.length, 1, r.reason);
});

test('G7 a remembered failure from an older parser version is ignored, so a fix takes effect', async () => {
  const cache = memCache();
  const key = cacheKeyFor(4, [idea()]);
  cache.set(`${key}.failed`, { v: 'trade-proposals-parse-v0', problem: 'not_a_list',
    reason: 'stale', attempts: 3, at: Date.now() });
  let called = 0;
  const call = liveCaller(async () => { called++; return envelope(JSON.stringify([proposal()])); });
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache });
  assert.equal(called, 1, 'shipping a parser fix has to clear what the old one could not read');
  assert.equal(r.proposals.length, 1, r.reason);
});

test('G7 verifyProposals is untouched by any of this — a live answer gets no free pass', () => {
  // The safety net stays exactly as strict: this is the same invented-player
  // case as G1, arriving through the live envelope rather than a test string.
  const bad = proposal({ opener: 'Waddle for Achane, and I will throw in Mahomes.' });
  const r = verifyProposals([bad], [idea()], { universe });
  assert.equal(r.ok.length, 0, 'the envelope fix must not have loosened the verifier');
});
