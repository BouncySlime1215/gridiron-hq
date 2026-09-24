/**
 * WR-2: the NEXT MOVE swipe deck (client/src/components/warroom/{deck.ts,NextMoveDeck.tsx}),
 * compiled with the repo's TypeScript and rendered with React.
 *
 *  - Next advances the deck and logs the skip; Back restores the skipped card;
 *  - the optional skip reason (4 one-tap choices) is logged to the in-memory log;
 *  - the card on screen says "2 of 5" and shows the card the deck points at;
 *  - a number the producer did not write reads "not computed yet", never 0;
 *  - a failed next move is hidden with its reason and shows no digits.
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
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'war-room-plans.json'), 'utf8'));
const { buildWarRoomView } = await import('../server/services/war-room-view.js');

const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { deckReducer, initialDeck, SKIP_REASONS } = await wr.mod('deck');
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');

/** A view whose deck has five distinct cards (partners Team 11..15). */
function fiveCardView(mutate) {
  const entries = structuredClone(fixture);
  const base = entries[0].acq.best_direct;
  entries[0].acq.alternatives = [11, 12, 13, 14, 15].map((t, i) => {
    const p = structuredClone(base);
    p.steps[0].team = String(t);
    p.steps[0].p = 0.2 + i / 100;
    return p;
  });
  if (mutate) mutate(entries);
  return buildWarRoomView(1, { status: 'ok', entries, as_of: '2026-09-23T00:00:00.000Z', id: 'plans@1' }, { enabled: true, preview: false });
}
const render = (props) => {
  const html = renderToStaticMarkup(React.createElement(NextMoveDeck, { big: true, ...props }));
  return { html, text: textOf(html) };
};

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

test('reducer: the optional skip reason is logged in memory, once, against the skipped card', () => {
  assert.deepEqual(SKIP_REASONS.map(r => r.label),
    ["Don't like the player", 'Costs too much', "Don't trust this manager", 'Not now']);
  let s = deckReducer(initialDeck(), { type: 'next', total: 5, card: 'Offer Team 11', at: 1 });
  s = deckReducer(s, { type: 'skip_reason', reason: 'cost', card: 'Offer Team 11', at: 2 });
  const last = s.log[s.log.length - 1];
  assert.deepEqual({ ...last }, { kind: 'skip_reason', index: 0, card: 'Offer Team 11', reason: 'cost', at: 2 });
  assert.equal(s.asking, null);
  assert.equal(deckReducer(s, { type: 'skip_reason', reason: 'manager', card: 'x', at: 3 }), s, 'no second reason without a new skip');
  const ignored = deckReducer(deckReducer(initialDeck(), { type: 'next', total: 5, card: 'y', at: 1 }), { type: 'dismiss_reason' });
  assert.equal(ignored.asking, null);
  assert.ok(!ignored.log.some(e => e.kind === 'skip_reason'), 'ignoring the prompt logs nothing');
});

test('render: the deck shows "2 of 5", the card it points at, Back, and the skip reasons', () => {
  const v = fiveCardView();
  const cards = v.next_move.value.cards;
  assert.equal(cards.length, 5);
  const first = render({ field: v.next_move });
  assert.match(first.text, /1 of 5/);
  assert.match(first.text, /Send this to Team 11/);
  assert.doesNotMatch(first.text, /← back/, 'nothing skipped yet');

  let s = deckReducer(initialDeck(), { type: 'next', total: 5, card: cards[0].deal_line, at: 1 });
  const second = render({ field: v.next_move, initialState: s });
  assert.match(second.text, /2 of 5/);
  assert.match(second.text, /Send this to Team 12/, 'Next advanced to the second card');
  assert.match(second.text, /← back/);
  for (const r of SKIP_REASONS) assert.ok(second.text.includes(r.label), `skip reason offered: ${r.label}`);
  assert.match(second.text, /Next →/);
  assert.match(second.text, /Do it/);

  s = deckReducer(s, { type: 'back', card: cards[0].deal_line, at: 2 });
  const back = render({ field: v.next_move, initialState: s });
  assert.match(back.text, /1 of 5/);
  assert.match(back.text, /Send this to Team 11/, 'Back restored the first card');

  const out = render({ field: v.next_move, initialState: { ...initialDeck(5), skipped: [0, 1, 2, 3, 4] } });
  assert.match(out.text, /That was every move/);
});

test('render: missing numbers say "not computed yet", never 0', () => {
  const v = fiveCardView(entries => { delete entries[0].acq.alternatives[0].steps[0].p; });
  const card = v.next_move.value.cards[0];
  assert.equal(card.p_yes.status, 'unknown');
  const { html, text } = render({ field: v.next_move });
  const tile = textOf(html.split('Chance he says yes')[1].split('Title odds')[0]);
  assert.match(tile, /not computed yet/);
  assert.doesNotMatch(tile, /\b0%/);
  // The study writes no message, walk-away, levels or reasoning: each says so.
  for (const label of ['Walk away if', 'Case for', 'His side of the table', "Devil's advocate", 'News check', 'Confidence, explained', 'If he counters']) {
    const after = text.split(label)[1] ?? '';
    assert.match(after.slice(0, 40), /not computed yet/, `${label} reads not computed yet`);
  }
  assert.match(text, /Copy the deal/);
  assert.match(text, /Message not written yet/);
  assert.match(text, /Coach never sends offers/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('render: a failed next move is hidden with its reason and no digits', () => {
  const v = buildWarRoomView(2, { status: 'ok', entries: structuredClone(fixture), as_of: 'x', id: 'y' }, { enabled: true, preview: false });
  const { text } = render({ field: v.next_move });
  assert.match(text, /Next move failed its check, so it is hidden\. The planner run failed/);
  assert.doesNotMatch(text, /\d+%|pts/);
});
