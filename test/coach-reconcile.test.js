/**
 * COACH-V2 unit 4: RECONCILE + the Numbers & People card inline (stand-in client; no paid call).
 *
 * Pinned here:
 *   - ONE vocabulary: the verdict is numbers-people/lanes.js#verdictOf on the two lanes'
 *     stance + basis, and the answer format's basis keys are Numbers & People's BASES
 *   - AGREE (and no lane 2) merges with no model call
 *   - DIFFER / SAME_BUT: one reconcile call (Opus when the lanes DIFFER on a trade question);
 *     it recommends only cited lines and passes verify.js, or gets one correction round, or
 *     falls back to lane 1 with the disagreement built from the stances
 *   - over a 24-case scenario set every DIFFER answer names the disagreement in one sentence,
 *     and 100% of shown answers pass verify.js after one correction or the fallback
 *   - the card is numbers-people view.js's NPItem shape, so the one NumbersPeopleCard renders it
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-coach-reconcile-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { reconcile, laneVerdict, cardFor, disagreementLine, SAME_VOCABULARY, RECONCILE_MODELS } = await import('../server/services/coach/reconcile.js');
const { BASES, VERDICTS } = await import('../server/services/numbers-people/lanes.js');
const { BASIS_KEYS, toAnswer } = await import('../server/services/coach/answer-shape.js');
const { newLedger } = await import('../server/services/coach/ledger.js');
const { verifyAnswer } = await import('../server/services/coach/verify.js');

const usage = { input_tokens: 10, output_tokens: 10 };
const reply = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', usage, cost_usd: 0.01 });
function scripted(...replies) {
  const sent = [];
  let i = 0;
  return { sent, call: async body => { sent.push(body); const r = replies[i++]; if (!r) throw new Error(`out of replies at ${i}`); return r; } };
}

/** A ledger with lane 1's row (r1) and Jev's take (r2), and the two lanes' answers. */
function lanes({ stance = 'go', basis = 'title_gain', jev = { stance: 'wait', basis: 'price' } } = {}) {
  const ledger = newLedger();
  ledger.record({ tool: 'plan_read', tables: ['plan_moves'], columns: ['title_odds_change', 'partner_label'], rows: [{ title_odds_change: 0.101, partner_label: 'Team 2' }] });
  ledger.record({ tool: 'people_read', tables: ['jev_take'], columns: ['p_accept', 'stance', 'basis'], rows: [{ p_accept: 0.31, stance: jev.stance, basis: jev.basis }] });
  const laneOne = toAnswer({ verdict: { text: 'Send Team 2 the served offer tonight.', cites: ['r1#0.partner_label'] }, stance, basis: 'title odds', basis_key: basis,
    why: [{ text: 'Title odds move +10.1 pts if it lands.', cites: ['r1#0.title_odds_change'] }], risks: [], refusals: [], as_of: null });
  const jevClaims = [{ text: 'Jev: 31% he takes it as sent (chat read, ungraded).', cites: ['r2#0.p_accept'] }];
  return { ledger, laneOne, take: jev, jevClaims };
}
const good = (extra = {}) => ({ verdict: { text: 'Send Team 2 the served offer, leading with his need.', cites: ['r1#0.partner_label'] }, stance: 'go', basis: 'title odds', basis_key: 'title_gain',
  why: [{ text: 'Title odds move +10.1 pts if it lands.', cites: ['r1#0.title_odds_change'] }, { text: 'Jev puts his yes at 31% as sent (chat read).', cites: ['r2#0.p_accept'] }],
  risks: [], refusals: [], as_of: null, disagreement: 'Numbers say go; Jev reads wait because of his price.', ...extra });
const unsupported = good({ why: [{ text: 'Title odds move +44.0 pts if it lands.', cites: ['r1#0.title_odds_change'] }] });

test('one vocabulary: verdicts and basis keys are Numbers & People\'s', () => {
  assert.equal(SAME_VOCABULARY, true);
  assert.deepEqual([...BASIS_KEYS].sort(), [...BASES].sort());
  assert.equal(laneVerdict({ stance: 'go', basis_key: 'price' }, { stance: 'go', basis: 'price' }).verdict, 'agree');
  assert.equal(laneVerdict({ stance: 'go', basis_key: 'title_gain' }, { stance: 'go', basis: 'price' }).verdict, 'same_but');
  assert.equal(laneVerdict({ stance: 'go', basis_key: 'price' }, { stance: 'avoid', basis: 'price' }).verdict, 'differ');
  assert.equal(laneVerdict({ stance: 'go', basis_key: 'price' }, null).verdict, 'no_people_read');
  for (const v of ['agree', 'same_but', 'differ', 'no_people_read']) assert.ok(VERDICTS.includes(v));
});

test('AGREE merges with no model call; the card is the NPItem the one NumbersPeopleCard renders', async () => {
  const l = lanes({ jev: { stance: 'go', basis: 'title_gain' } });
  const s = scripted();
  const r = await reconcile({ question: 'what should I do', ...l, call: s.call });
  assert.deepEqual([r.verdict, r.reconciled, s.sent.length, r.disagreement], ['agree', 'deterministic', 0, null]);
  assert.equal(r.answer, l.laneOne);
  const card = cardFor({ focus: { move_id: 'L4-x', partner: '2' }, laneOne: l.laneOne, take: l.take, jevClaims: l.jevClaims, verdict: r.verdict });
  for (const k of ['key', 'item_type', 'item_id', 'title', 'players', 'numbers', 'people', 'verdict', 'history']) assert.ok(k in card, k);
  assert.deepEqual([card.key, card.numbers.stance, card.numbers.basis, card.people.stance, card.people.label], ['move:L4-x', 'go', 'title_gain', 'go', 'from chat, unverified']);
});

test('DIFFER: one reconcile call; on a trade question it is the strong model', async () => {
  const l = lanes();
  let s = scripted(reply(good()));
  let r = await reconcile({ question: 'is this trade worth sending?', ...l, call: s.call });
  assert.deepEqual([r.verdict, r.reconciled, r.attempts], ['differ', 'model', 1]);
  assert.equal(s.sent[0].model, RECONCILE_MODELS.trade_differ);
  assert.match(r.disagreement, /^Numbers say go; Jev reads wait/);
  s = scripted(reply(good()));
  await reconcile({ question: 'how is my week looking', ...l, call: s.call });
  assert.equal(s.sent[0].model, RECONCILE_MODELS.normal);
});

test('DIFFER without the one-sentence disagreement is corrected; a second miss falls back and still names it', async () => {
  const l = lanes();
  let s = scripted(reply(good({ disagreement: null })), reply(good()));
  let r = await reconcile({ question: 'q', ...l, call: s.call });
  assert.deepEqual([r.reconciled, r.attempts], ['model', 2]);
  assert.match(JSON.stringify(s.sent[1].messages.at(-1).content), /Numbers say X; Jev reads Y because Z/);
  s = scripted(reply(good({ disagreement: null })), reply(good({ disagreement: 'They see it differently.' })));
  r = await reconcile({ question: 'q', ...l, call: s.call });
  assert.equal(r.reconciled, 'fell_back');
  assert.equal(r.answer, l.laneOne, 'lane 1 stands');
  assert.equal(r.disagreement, 'Numbers say go; Jev reads wait because of price (from chat, unverified).');
});

test('an unsupported number in the reconciled answer is corrected or never shown', async () => {
  const l = lanes();
  let s = scripted(reply(unsupported), reply(good()));
  let r = await reconcile({ question: 'q', ...l, call: s.call });
  assert.deepEqual([r.reconciled, r.attempts], ['model', 2]);
  s = scripted(reply(unsupported), reply(unsupported));
  r = await reconcile({ question: 'q', ...l, call: s.call });
  assert.equal(r.reconciled, 'fell_back');
  assert.doesNotMatch(JSON.stringify(r.answer), /44\.0/);
});

test('SAME_BUT reconciles too, and its fallback line says "same call, different reasons"', async () => {
  const l = lanes({ jev: { stance: 'go', basis: 'price' } });
  const s = scripted(reply(good({ disagreement: null, why: [{ text: 'x 99 pts', cites: [] }] })), reply(good({ disagreement: null, why: [{ text: 'x 99 pts', cites: [] }] })));
  const r = await reconcile({ question: 'q', ...l, call: s.call });
  assert.equal(r.verdict, 'same_but');
  assert.equal(r.reconciled, 'fell_back');
  assert.equal(r.disagreement, disagreementLine('same_but', { stance: 'go', basis: 'title_gain' }, { stance: 'go', basis: 'price' }));
  assert.match(r.disagreement, /^Same call, different reasons/);
});

test('league-mates are "they" in every sentence reconcile builds, and the prompt asks for it', async () => {
  const GENDERED_WORD = /\b(he|his|him|himself|he's)\b/i;
  const stances = ['go', 'wait', 'avoid'];
  for (const a of stances) for (const b of stances) for (const ab of BASES) for (const bb of [...BASES, 'unknown']) {
    for (const v of ['differ', 'same_but']) {
      const line = disagreementLine(v, { stance: a, basis: ab }, { stance: b, basis: bb });
      assert.doesNotMatch(line, GENDERED_WORD, line);
      assert.doesNotMatch(line, /ungraded|chat read/i, line);
    }
  }
  const l = lanes();
  const s = scripted(reply(good()));
  await reconcile({ question: 'q', ...l, call: s.call });
  assert.match(s.sent[0].system, /they, them or their, never he, him or his/);
  assert.match(s.sent[0].system, /\(from chat, unverified\)/);
});

test('pass bars over a 24-case scenario set: DIFFER named 100%, shown answers verified 100% after one correction or the fallback', async () => {
  // Each case: the lanes' stances and the stand-in's two replies (first try, correction).
  const stances = [['go', 'title_gain', 'wait', 'price'], ['go', 'title_gain', 'avoid', 'willingness'], ['wait', 'timing', 'go', 'timing'], ['avoid', 'risk', 'go', 'roster_fit'],
    ['go', 'price', 'go', 'willingness'], ['wait', 'risk', 'wait', 'timing'], ['go', 'title_gain', 'go', 'title_gain'], ['avoid', 'price', 'avoid', 'price']];
  const scripts = [[good(), good()], [unsupported, good()], [unsupported, unsupported]];
  let differ = 0, differNamed = 0, shown = 0, verified = 0, firstTry = 0, modelCases = 0;
  for (const [aS, aB, bS, bB] of stances) {
    for (const [first, second] of scripts) {
      const l = lanes({ stance: aS, basis: aB, jev: { stance: bS, basis: bB } });
      const fix = o => ({ ...o, stance: aS, basis_key: aB });
      const s = scripted(reply(fix(first)), reply(fix(second)));
      const r = await reconcile({ question: 'q', ...l, call: s.call });
      if (r.verdict === 'differ') { differ++; if (r.disagreement && /^Numbers say .+; Jev reads .+ because .+/.test(r.disagreement)) differNamed++; }
      if (r.reconciled === 'model') { modelCases++; if (r.attempts === 1) firstTry++; }
      shown++;
      const extra = r.disagreement ? [{ text: r.disagreement, cites: [...l.laneOne.claims.flatMap(c => c.cites), 'r2#0.p_accept'] }] : [];
      if (verifyAnswer({ answer: { ...r.answer, claims: [...r.answer.claims, ...extra] }, ledger: l.ledger, question: 'q' }).ok) verified++;
    }
  }
  assert.equal(shown, 24);
  assert.equal(differNamed, differ, `DIFFER named ${differNamed}/${differ}`);
  assert.equal(verified, shown, `verified ${verified}/${shown}`);
  console.log(`[reconcile] 24 cases: differ ${differ} named ${differNamed}; shown ${shown} verified ${verified}; model-reconciled ${modelCases}, first try ${firstTry} (stand-in replies)`);
});
