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
  verifyProposals, cacheKeyFor, proposalsFor, PROMPT_VERSION, REQUIRED_PROPOSAL_FIELDS,
} from '../server/services/trade-proposals.js';

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
  assert.match(r.reason, /could not be read|malformed|parse/i);
  assert.equal(r.refused, true);
});

test('G4 a response whose proposals all fail verification returns none, and says why', async () => {
  const call = async () => JSON.stringify([proposal({ package: { i_give: ['Jaylen Waddle'], i_get: ['Patrick Mahomes'] } })]);
  const r = await proposalsFor(4, { ideas: [idea()], universe, call, cache: memCache() });
  assert.equal(r.proposals.length, 0);
  assert.ok(r.rejected.length > 0, 'the rejects are reported, not swallowed');
  assert.match(r.reason, /invent|verification|rejected/i);
});

test('G4 a failed run is not cached, so a later good run can still happen', async () => {
  const cache = memCache();
  let called = 0;
  const bad = async () => { called++; return 'not json'; };
  await proposalsFor(4, { ideas: [idea()], universe, call: bad, cache });
  const good = async () => { called++; return JSON.stringify([proposal()]); };
  const r = await proposalsFor(4, { ideas: [idea()], universe, call: good, cache });
  assert.equal(called, 2, 'a refusal must not poison the cache entry');
  assert.equal(r.proposals.length, 1);
});

/** A cache with the same two-method shape the DB-backed one exposes. */
function memCache() {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}
