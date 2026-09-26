/**
 * NUMBERS-PEOPLE inside Coach: an answer about an item that has a stored read shows the SAME
 * component the Trades tab uses (NumbersPeopleCard), compact: the verdict, Claude's and Jev's
 * stance chips with a one-line why each, and "Details" that opens the cited numbers. An answer
 * with no read shows nothing extra. Made-up names only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, domRenderer, click, textOf, one, button, waitFor } from './helpers/warroom-render.js';

installDom();
globalThis.__warRoomApiCall = async () => ({ model_on: false, spent_today_usd: 0 });
globalThis.__warRoomApi = {};
const { loadWarRoom } = await import('./helpers/warroom-tsx.mjs');
const wr = await loadWarRoom();
const { React, mount } = await domRenderer();
const { CoachDrawer } = await wr.mod('coach/index');
test.after(() => wr.cleanup());

const coachWith = messages => ({
  enabled: true, messages, busy: false, error: null, pending: null, starters: [], log: [],
  session: { history: [] }, ui: { cards: [], drafts: {}, league: 4 },
  footer: { destination: 'Win the title', stops_left: '2', next_move: 'an offer' },
  ask: async () => null, undo() {}, cancel() {}, confirm: async () => {}, clearError() {}, newConversation: async () => {}, doProposal: async () => {}
});
const READ = {
  key: 'move:M1', item_type: 'move', item_id: 'M1', title: 'Get P21 (WR) for P4 (WR)', subtitle: 'With Team Two', partner: '3',
  players: [{ id: '21', name: 'P21 (WR)' }], verdict: 'differ', read_at: '2026-09-25T20:00:00Z', history: [],
  numbers: { stance: 'go', basis: 'title_gain', why: 'The odds gain is worth the price.', cites: [{ label: 'Title odds gain if the whole move lands', value: '+11.6 pts' }] },
  people: { stance: 'avoid', basis: 'willingness', why: 'The chat read cuts against Claude\'s call.', label: 'chat read (ungraded)',
    cites: [{ label: 'Jev: ready to deal now', value: '20%' }] }
};
const reply = numbersPeople => ({ who: 'coach', text: 'x', question: 'why?', claims: [{ text: 'The move lifts your odds.', cites: [] }], refusals: [], numbersPeople });

test('an answer about an item with a read: the shared card, compact, expandable', async () => {
  const ui = mount(React.createElement(CoachDrawer, { coach: coachWith([{ who: 'nick', text: 'why?' }, reply(READ)]), open: true, onClose() {} }));
  await waitFor(() => one(ui.container, 'data-testid', 'coach-numbers-people'), 2000, 'the card');
  const card = one(ui.container, 'data-testid', 'np-card-compact');
  assert.equal(card.getAttribute('data-verdict'), 'differ');
  assert.match(textOf(card), /Numbers & People\s*Differ/);
  assert.match(textOf(one(card, 'data-testid', 'np-compact-numbers')), /^Claude\s*Go\s*The odds gain is worth the price\.$/);
  assert.match(textOf(one(card, 'data-testid', 'np-compact-people')), /^Jev\s*Avoid\s*The chat read cuts against Claude's call\.$/);
  assert.equal(one(card, 'data-testid', 'np-compact-detail'), null, 'details folded by default');
  click(button(card, 'Details'));
  await waitFor(() => one(card, 'data-testid', 'np-compact-detail'), 2000, 'details open');
  assert.match(textOf(one(card, 'data-testid', 'np-compact-detail')), /Claude · numbers.*\+11\.6 pts.*Jev · people · chat read \(ungraded\).*20%/);
  ui.unmount();
});

test('an answer with no read: nothing extra', async () => {
  const ui = mount(React.createElement(CoachDrawer, { coach: coachWith([{ who: 'nick', text: 'why?' }, reply(null)]), open: true, onClose() {} }));
  await waitFor(() => one(ui.container, 'data-testid', 'coach-answer'), 2000, 'the answer');
  assert.equal(one(ui.container, 'data-testid', 'coach-numbers-people'), null);
  ui.unmount();
});

test('one component: the Trades tab and Coach both render NumbersPeopleCard', () => {
  const read = p => fs.readFileSync(new URL(`../client/src/${p}`, import.meta.url), 'utf8');
  assert.match(read('components/trade/NumbersPeople.tsx'), /<NumbersPeopleCard key=\{item\.key\} item=\{item\} variant="full"/);
  assert.match(read('components/warroom/coach/CoachDrawer.tsx'), /<NumbersPeopleCard item=\{slot\.numbersPeople\} variant="compact" \/>/);
  assert.equal(fs.readdirSync(new URL('../client/src/components', import.meta.url), { recursive: true })
    .filter(f => /NumbersPeopleCard\.tsx$/.test(String(f))).length, 1, 'one copy of the card');
});
