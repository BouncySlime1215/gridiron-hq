import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentDeal } from '../server/services/warroom-actions/cards.js';

// 9/24: 'I sent it' failed with a 500 on every card the real producer wrote. The producer's
// p_yes_band had no basis, cards.js defaulted it to 'campaign.p_yes_band', and the trade_outcomes
// CHECK (migration 067) refuses anything but these three. The FIX-07 tests hid it by adding a basis by hand.
const card = basis => ({
  move_id: 'L4-x', step_index: 0, partner: '7', give: ['404'], get: ['407'],
  p_yes: 0.4, p_yes_band: { low: 0.3, high: 0.5, ...(basis === undefined ? {} : { basis }) }
});

test('a card carrying the acceptance model basis records it verbatim (no invented basis)', () => {
  const d = sentDeal(card('heuristic_anchored'));
  assert.ok(!d.error, d.error);
  assert.equal(d.acceptance?.basis ?? d.deal?.acceptance?.basis, 'heuristic_anchored');
});

test('a card without a basis gets a clear refusal, never a basis the ledger rejects', () => {
  const d = sentDeal(card(undefined));
  assert.match(String(d.error), /acceptance-model basis/);
  const bad = sentDeal(card('campaign.p_yes_band'));
  assert.match(String(bad.error), /acceptance-model basis/);
});
