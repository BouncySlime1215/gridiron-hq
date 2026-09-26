/**
 * COACH-LANES, the drawer: an answer built from both lanes shows a small "Numbers + People"
 * toggle, collapsed by default; open, it shows what each lane said, and a disagreement is one
 * highlighted line. An answer with no people lane shows no toggle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, domRenderer, click, textOf, one, waitFor } from './helpers/warroom-render.js';

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
const reply = lanes => ({ who: 'coach', text: 'x', question: 'is he likely to bite?', claims: [{ text: 'The offer stands.', cites: [] }], refusals: [], lanes });

test('both lanes: a collapsed "Numbers + People" toggle and the disagreement line', async () => {
  const lanes = { numbers: { claims: ['The offer stands.'] }, people: { claims: ['His profile lists P21 (WR) as a want.'], label: 'chat read (ungraded)' },
    disagreement: 'Numbers say the offer stands; chat suggests he wants P21 himself because his profile lists him.', action: 'Send the served offer as it is.' };
  const ui = mount(React.createElement(CoachDrawer, { coach: coachWith([{ who: 'nick', text: 'is he likely to bite?' }, reply(lanes)]), open: true, onClose() {} }));
  await waitFor(() => one(ui.container, 'data-testid', 'coach-answer'), 2000, 'the answer');
  const box = one(ui.container, 'data-testid', 'coach-lanes');
  assert.ok(box, 'the toggle shows');
  assert.match(textOf(box), /Numbers \+ People \(they disagree\)/);
  assert.match(textOf(one(box, 'data-testid', 'coach-lanes-disagree')), /^Numbers say .*chat suggests/);
  assert.equal(one(box, 'data-testid', 'coach-lanes-detail'), null, 'collapsed by default');
  click(one(box, 'aria-expanded', 'false'));
  await waitFor(() => one(box, 'data-testid', 'coach-lanes-detail'), 2000, 'the lanes open');
  const detail = one(box, 'data-testid', 'coach-lanes-detail');
  assert.match(textOf(detail), /Numbers.*The offer stands\..*People.*chat read \(ungraded\).*P21/);
  ui.unmount();
});

test('Jev led lane 2: the toggle says "Claude + Jev" and the lanes are named Claude and Jev', async () => {
  const lanes = { title: 'Claude + Jev', numbers: { claims: ['The offer stands.'] },
    people: { source: 'jev', claims: ['Jev: 31% he takes it as sent (chat read, ungraded).'], label: 'Jev, chat read (ungraded)' },
    disagreement: 'Numbers say send it; Jev reads wait because of his price.', action: null };
  const ui = mount(React.createElement(CoachDrawer, { coach: coachWith([{ who: 'nick', text: 'q' }, reply(lanes)]), open: true, onClose() {} }));
  await waitFor(() => one(ui.container, 'data-testid', 'coach-lanes'), 2000, 'the toggle');
  const box = one(ui.container, 'data-testid', 'coach-lanes');
  assert.match(textOf(box), /^Claude \+ Jev \(they disagree\)/);
  click(one(box, 'aria-expanded', 'false'));
  await waitFor(() => one(box, 'data-testid', 'coach-lanes-detail'), 2000, 'the lanes open');
  assert.match(textOf(one(box, 'data-testid', 'coach-lanes-detail')), /Claude \(numbers\).*Jev \( ?chat read, ungraded ?\).*31%/);
  ui.unmount();
});

test('no people lane: no toggle', async () => {
  const lanes = { numbers: { claims: ['The offer stands.'] }, people: { skipped: 'nobody in focus has a stored people signal' } };
  const ui = mount(React.createElement(CoachDrawer, { coach: coachWith([{ who: 'nick', text: 'q' }, reply(lanes)]), open: true, onClose() {} }));
  await waitFor(() => one(ui.container, 'data-testid', 'coach-answer'), 2000, 'the answer');
  assert.equal(one(ui.container, 'data-testid', 'coach-lanes'), null);
  ui.unmount();
});
