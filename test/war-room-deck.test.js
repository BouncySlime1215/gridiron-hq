/**
 * WR-2 + FIX-04: the NEXT MOVE swipe deck (client/src/components/warroom/{deck.ts,
 * NextMoveDeck.tsx,requests.ts}), compiled with the repo's TypeScript and rendered with React.
 *
 *  - the deck is alternatives.value: the head is card 1 even when it differs from alternatives[1];
 *  - Next advances the deck and logs the skip; Back restores the skipped card;
 *  - one skip posts exactly one deck.skip request (with its reason when tapped);
 *    "I sent it" posts offer.sent once; a logged reply posts offer.reply;
 *  - the card on screen says "2 of 5" and shows the card the deck points at;
 *  - a number the producer did not write reads "not computed yet", never 0;
 *  - a failed deck is hidden with its reason and shows no digits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { deckReducer, initialDeck, SKIP_REASONS } = await wr.mod('deck');
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');
const { flushOutbox, postWarRoomRequest, requestPath, targetApprove } = await wr.mod('requests');
const { default: TargetPicker } = await wr.mod('TargetPicker');

const ON = { enabled: true, preview: false };
const plansOf = leagues => ({ status: 'ok', entries: leagues, as_of: '2026-09-24T06:00:00.000Z', id: 'plans@1',
  head: { schema: producer.schema, producer: producer.producer, producer_version: producer.producer_version } });
const viewOf = (leagueId = 1, mutate) => {
  const leagues = structuredClone(producer.leagues);
  if (mutate) mutate(leagues[0]);
  return buildWarRoomView(leagueId, plansOf(leagues), ON);
};

/** A view whose deck has five distinct moves (partners Team 11..15), head first. */
function fiveCardView(mutate) {
  return viewOf(1, l => {
    const base = l.alternatives.value[1];
    l.alternatives.value = [11, 12, 13, 14, 15].map((t, i) => {
      const m = structuredClone(base);
      m.move_id = `L1-m${i + 1}`;
      m.rank = i + 1;
      m.steps[0].partner = String(t);
      m.steps[0].p_yes.value = 0.2 + i / 100;
      return m;
    });
    l.next_move.value = structuredClone(l.alternatives.value[0]);
    if (mutate) mutate(l);
  });
}
const render = (props) => {
  const html = renderToStaticMarkup(React.createElement(NextMoveDeck, { big: true, ...props }));
  return { html, text: textOf(html) };
};

test('the head of alternatives is card 1, even when it differs from alternatives[1] (D3/U1)', () => {
  const v = viewOf();
  const [head, second] = v.alternatives.value;
  assert.notEqual(head.steps[0].partner, second.steps[0].partner, 'control: the two cards differ');
  const { text } = render({ view: v });
  assert.match(text, /1 of 2/);
  assert.match(text, /Send this to Team 7/, 'card 1 is the head (Team 7), not alternatives[1] (Team 2)');
  assert.match(text, /M\. Oduya \(WR\) \+ T\. Kline \(TE\)/);
  assert.match(text, /38%/);
  const s = deckReducer(initialDeck(), { type: 'next', total: 2, card: head.move_id, at: 1 });
  assert.match(render({ view: v, initialState: s }).text, /Send this to Team 2/, 'Next shows alternatives[1]');
});

test('a skip posts one deck.skip request, with its reason when one is tapped', async () => {
  let s = deckReducer(initialDeck(), { type: 'next', total: 5, card: 'L1-m1', at: 1 });
  assert.deepEqual(s.outbox, [], 'nothing posts while the optional reason is on offer');
  s = deckReducer(s, { type: 'skip_reason', reason: 'cost', card: 'L1-m1', at: 2 });
  assert.deepEqual(s.outbox, [{ kind: 'deck.skip', payload: { move_id: 'L1-m1', reason: 'cost' } }]);
  s = deckReducer(s, { type: 'skip_reason', reason: 'manager', card: 'x', at: 3 });
  assert.equal(s.outbox.length, 1, 'no second request without a new skip');

  const calls = [];
  const post = async (p, init) => { calls.push([p, init.method, JSON.parse(init.body)]); return { ok: true }; };
  const sent = await flushOutbox(4, s.outbox, 0, post);
  assert.equal(sent, 1);
  assert.deepEqual(calls, [['/warroom/4/requests', 'POST', { kind: 'deck.skip', payload: { move_id: 'L1-m1', reason: 'cost' }, source: 'nick' }]]);
  assert.equal(await flushOutbox(4, s.outbox, sent, post), 1, 'a flushed request is not posted twice');
  assert.equal(calls.length, 1);

  // Ignoring the prompt still posts the skip, once, without a reason.
  const ignored = deckReducer(deckReducer(initialDeck(), { type: 'next', total: 5, card: 'L1-m2', at: 1 }), { type: 'dismiss_reason' });
  assert.deepEqual(ignored.outbox, [{ kind: 'deck.skip', payload: { move_id: 'L1-m2' } }]);
  // Two skips in a row: the first posts when the second starts.
  let two = deckReducer(initialDeck(), { type: 'next', total: 5, card: 'L1-m1', at: 1 });
  two = deckReducer(two, { type: 'next', total: 5, card: 'L1-m2', at: 2 });
  assert.deepEqual(two.outbox.map(r => r.payload.move_id), ['L1-m1']);
  // Back while the reason is on offer undoes the skip: nothing posts.
  const undone = deckReducer(deckReducer(initialDeck(), { type: 'next', total: 5, card: 'L1-m1', at: 1 }), { type: 'back', card: 'L1-m1', at: 2 });
  assert.deepEqual(undone.outbox, []);
  assert.equal(undone.index, 0);
});

test('"I sent it" posts offer.sent once; a logged reply posts offer.reply; Do it posts nothing', () => {
  let s = deckReducer(initialDeck(), { type: 'do_it', card: 'L1-m1', at: 1 });
  assert.equal(s.chosen, 0);
  assert.deepEqual(s.outbox, [], 'picking a card is not sending it');
  s = deckReducer(s, { type: 'sent', card: 'L1-m1', at: 2 });
  s = deckReducer(s, { type: 'sent', card: 'L1-m1', at: 3 });
  assert.deepEqual(s.outbox, [{ kind: 'offer.sent', payload: { move_id: 'L1-m1' } }]);
  s = deckReducer(s, { type: 'reply', card: 'L1-m1', reply: 'decline', at: 4 });
  assert.deepEqual(s.outbox[1], { kind: 'offer.reply', payload: { move_id: 'L1-m1', reply: 'decline' } });
  assert.equal(requestPath(9), '/warroom/9/requests');
  const v = viewOf();
  const picked = render({ view: v, initialState: deckReducer(initialDeck(), { type: 'do_it', card: 'L1-m1', at: 1 }) });
  assert.match(picked.text, /I sent it/);
  assert.match(picked.text, /He did this/);
  assert.equal(typeof postWarRoomRequest, 'function');
});

test('Approve on a suggested target posts one target.approve request', async () => {
  assert.deepEqual(targetApprove('702'), { kind: 'target.approve', payload: { player_id: '702', source: 'suggested' } });
  const calls = [];
  await postWarRoomRequest(1, targetApprove('702'), async (p, init) => { calls.push([p, JSON.parse(init.body)]); });
  assert.deepEqual(calls, [['/warroom/1/requests', { kind: 'target.approve', payload: { player_id: '702', source: 'suggested' }, source: 'nick' }]]);
  const v = viewOf();
  const html = renderToStaticMarkup(React.createElement(TargetPicker, { field: v.targets, names: v.names, big: true, onRequest: async () => ({}) }));
  const text = textOf(html);
  assert.match(text, /N\. Whitfield \(WR\).*Approve/, 'the suggested, unapproved target offers Approve');
  assert.match(text, /in the plan/, 'the plan target says so instead');
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Approve/, 'Approve is live when the request route is wired');
  const off = renderToStaticMarkup(React.createElement(TargetPicker, { field: v.targets, names: v.names, big: true }));
  assert.match(off, /<button[^>]*disabled=""[^>]*>Approve/, 'control: without a route Approve is disabled');
});

test('reducer: Next advances and logs, Back restores, ends are no-ops', () => {
  let s = initialDeck();
  s = deckReducer(s, { type: 'next', total: 5, card: 'A', at: 1 });
  assert.equal(s.index, 1);
  assert.deepEqual(s.skipped, [0]);
  assert.equal(s.asking, 0, 'the optional reason is offered for the skipped card');
  s = deckReducer(s, { type: 'next', total: 5, card: 'B', at: 2 });
  assert.equal(s.index, 2);
  s = deckReducer(s, { type: 'back', card: 'B', at: 3 });
  assert.equal(s.index, 1, 'back restores the last skipped card');
  assert.deepEqual(s.skipped, [0]);
  s = deckReducer(s, { type: 'back', card: 'A', at: 4 });
  assert.equal(s.index, 0);
  assert.deepEqual(deckReducer(s, { type: 'back', card: '', at: 5 }), s, 'nothing to go back to');
  assert.deepEqual(s.log.map(e => [e.kind, e.index]), [['next', 0], ['next', 1], ['back', 1], ['back', 0]]);
  let end = { ...initialDeck(5) };
  assert.equal(deckReducer(end, { type: 'next', total: 5, card: 'x', at: 1 }), end, 'no card past the end');
  end = deckReducer(initialDeck(2), { type: 'do_it', card: 'C', at: 9 });
  assert.equal(end.chosen, 2);
});

test('reducer: the skip reasons are the shared ids, logged once against the skipped card', () => {
  assert.deepEqual(SKIP_REASONS.map(r => r.id), ['player', 'cost', 'manager', 'not_now']);
  assert.deepEqual(SKIP_REASONS.map(r => r.label),
    ["Don't like the player", 'Costs too much', "Don't trust this manager", 'Not now']);
  let s = deckReducer(initialDeck(), { type: 'next', total: 5, card: 'L1-m1', at: 1 });
  s = deckReducer(s, { type: 'skip_reason', reason: 'cost', card: 'L1-m1', at: 2 });
  const last = s.log[s.log.length - 1];
  assert.deepEqual({ ...last }, { kind: 'skip_reason', index: 0, card: 'L1-m1', reason: 'cost', at: 2 });
  assert.equal(s.asking, null);
});

test('render: the deck shows "2 of 5", the card it points at, Back, and the skip reasons', () => {
  const v = fiveCardView();
  const moves = v.alternatives.value;
  assert.equal(moves.length, 5);
  const first = render({ view: v });
  assert.match(first.text, /1 of 5/);
  assert.match(first.text, /Send this to Team 11/);
  assert.doesNotMatch(first.text, /← back/, 'nothing skipped yet');

  let s = deckReducer(initialDeck(), { type: 'next', total: 5, card: moves[0].move_id, at: 1 });
  const second = render({ view: v, initialState: s });
  assert.match(second.text, /2 of 5/);
  assert.match(second.text, /Send this to Team 12/, 'Next advanced to the second card');
  assert.match(second.text, /← back/);
  for (const r of SKIP_REASONS) assert.ok(second.text.includes(r.label), `skip reason offered: ${r.label}`);
  assert.match(second.text, /Next →/);
  assert.match(second.text, /Do it/);

  s = deckReducer(s, { type: 'back', card: moves[0].move_id, at: 2 });
  const back = render({ view: v, initialState: s });
  assert.match(back.text, /1 of 5/);
  assert.match(back.text, /Send this to Team 11/, 'Back restored the first card');

  const out = render({ view: v, initialState: { ...initialDeck(5), skipped: [0, 1, 2, 3, 4] } });
  assert.match(out.text, /That was every move/);
});

test('render: the playbook and numbers come from the move; missing ones say "not computed yet", never 0', () => {
  const full = render({ view: viewOf() }).text;
  assert.match(full, /Deal\. Sending the next one now\.|Send step 2 to Team 2\./, 'the reply table is the step\'s reply_table');
  assert.match(full, /Switch to the backup plan/);
  const v = viewOf(1, l => {
    const s0 = l.alternatives.value[0].steps[0];
    s0.p_yes = { status: 'unknown', source: 'clone.accept', reason: 'Trade model had no read on this manager.' };
    s0.walk_away = { status: 'unknown', source: 'coach.text', reason: 'Walk-away not priced yet.' };
    s0.message = { status: 'unknown', source: 'coach.text', reason: 'Message not written yet.' };
    l.alternatives.value[0].reasoning = { status: 'unknown', source: 'coach.text', reason: 'Reasoning is off.' };
    l.next_move.value = structuredClone(l.alternatives.value[0]);
  });
  const { html, text } = render({ view: v });
  const tile = textOf(html.split('Chance he says yes')[1].split('Title odds')[0]);
  assert.match(tile, /not computed yet/);
  assert.doesNotMatch(tile, /\b0%/);
  for (const label of ['Walk away if', 'Case for', 'His side of the table', "Devil's advocate", 'News check', 'Confidence, explained', 'If he counters']) {
    const after = text.split(label)[1] ?? '';
    assert.match(after.slice(0, 40), /not computed yet/, `${label} reads not computed yet`);
  }
  assert.match(text, /Copy the deal/);
  assert.match(text, /Message not written yet/);
  assert.match(text, /Coach never sends offers/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('render: a failed deck is hidden with its reason and no digits', () => {
  const v = viewOf(2);
  const { text } = render({ view: v });
  assert.match(text, /Next move failed its check, so it is hidden\. The planner run failed/);
  assert.doesNotMatch(text, /\d+%|pts/);
});


