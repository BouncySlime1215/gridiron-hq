/**
 * CARD-CLARITY: the next-move card Nick sees first must be unambiguous (coordinator browser
 * audit of league 4). Plans are written by the REAL producer on the made-up league
 * (test/fixtures/warroom-contract/make-producer-plans.mjs, the fixture behind
 * producer-plans.json, plus one league whose managers all declined an offer an hour ago),
 * served through the real view builder and drawn by the real NextMoveDeck.
 *
 * Metrics (each counted over every card / league, target 0):
 *   (a) cards whose message is built from a package that differs from the step's package
 *       (step.opening.give != step.give) but carry no "opening ask" label;
 *   (b) served send_when strings containing an ISO timestamp;
 *   (c) attention reasons that claim a move worth X pts when next_move is not ok;
 *   (d) retired with the league rail (Trades cleanup part 2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWarRoom, textOf } from './helpers/warroom-tsx.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-card-clarity-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
delete process.env.GRIDIRON_WARROOM_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;

const { makeProducerPlans, OBJECTIVES, BRAIN } = await import('./fixtures/warroom-contract/make-producer-plans.mjs');
const { buildPlansFile } = await import('../scripts/campaign/produce-plans.mjs');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { leverage, rankAttention } = await import('../server/services/campaign/attention.js');
const { sendWhenText } = await import('../server/services/campaign/view.js');

const wr = await loadWarRoom();
test.after(() => { wr.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');
const { initialDeck } = await wr.mod('deck');

/* ------------------------------------------------------------- the plans (real producer) */
const doc = await makeProducerPlans();
// League 7: league 4's objective, every manager declined Nick's last offer an hour before the run.
const DECLINED_AT = '2026-09-24T05:00:00.000Z';
const UNTIL = '2026-09-25T05:00:00.000Z'; // 24 h after the decline
const WAIT = { when: 'wait', until: UNTIL, why: 'he declined your last offer 1 hour ago — inside 24 hours another one reads as pestering, not as a new idea' };
const L7 = async () => {
  const a = makeAdapter({ managerExtra: { 2: { send_when: WAIT }, 3: { send_when: WAIT }, 4: { send_when: WAIT } } });
  a.league = { ...a.league, id: 7 };
  return { adapter: a };
};
const waitFile = await buildPlansFile([{ id: 7, load: L7 }], { generated_at: '2026-09-24T06:00:00.000Z',
  objectives: { 7: OBJECTIVES[4] }, clock: () => 0, brain: BRAIN });
assert.ok(DECLINED_AT < UNTIL);
const entries = [...doc.leagues, ...waitFile.leagues].filter(e => !e.error);

const ON = { enabled: true, preview: false };
const viewOf = e => buildWarRoomView(e.league, { status: 'ok', entries: [structuredClone(e)], as_of: '2026-09-24T06:00:00.000Z', id: 'plans@1' }, ON);
const render = el => renderToStaticMarkup(el);
const same = (a, b) => [...a].sort().join('|') === [...b].sort().join('|');

/** Every deck card of every league, rendered big with that card on screen. */
function cards() {
  const out = [];
  for (const e of entries) {
    const view = viewOf(e);
    if (view.alternatives?.status !== 'ok') continue;
    view.alternatives.value.forEach((m, i) => {
      const html = render(React.createElement(NextMoveDeck, { view, big: true, initialState: initialDeck(i) }));
      out.push({ league: e.league, move: m, step: m.steps[0], html, text: textOf(html) });
    });
  }
  return out;
}
const CARDS = cards();

/* ------------------------------------------------------------------------ (a) */
test('(a) a message built from the opening ask, not the step, is labelled as the opening message', () => {
  const differs = CARDS.filter(c => c.step.opening?.status === 'ok' && !same(c.step.opening.value.give, c.step.give));
  assert.ok(differs.length >= 3, `the fixture has cards whose opening differs from the step (${differs.length})`);
  const unlabelled = differs.filter(c => !/Coach(&#x27;|')s opening ask, lower than the plan/.test(c.html) || !c.text.includes('Opening message'));
  console.log(`# (a) cards with a different opening: ${differs.length}; unlabelled: ${unlabelled.length}`);
  assert.equal(unlabelled.length, 0, `unlabelled: ${unlabelled.map(c => c.move.move_id).join(', ')}`);
});

test('(a) the ladder shows Open with / Plan / Walk away at from the contract fields', () => {
  const c = CARDS.find(x => x.step.opening?.status === 'ok' && !same(x.step.opening.value.give, x.step.give)
    && x.step.walk_away?.status === 'ok');
  assert.ok(c, 'a card with an opening and a walk-away');
  const ladder = c.html.match(/<ol class="wr-ladder"[\s\S]*?<\/ol>/)?.[0];
  assert.ok(ladder, 'the card draws the ladder');
  const t = textOf(ladder);
  const names = ids => ids.map(i => c.move && entries.find(e => e.league === c.league).names[i]).join(' + ');
  const openAt = t.indexOf('Open with'), planAt = t.indexOf('Plan'), walkAt = t.indexOf('Walk away at');
  assert.ok(openAt >= 0 && planAt > openAt && walkAt > planAt, `rows in order: ${t}`);
  assert.ok(t.includes(names(c.step.opening.value.give)), 'Open with lists the opening give');
  assert.ok(t.includes(names(c.step.give)), 'Plan lists the step give');
  assert.ok(t.includes(names(c.step.walk_away.value.max_give)), 'Walk away at lists max_give');
  // UI-POLISH-2: the ladder rung is the only walk-away on the card (the old "Walk away if" tile is gone).
  assert.ok(!c.html.includes('Walk away if'), 'no separate walk-away tile');
});

test('(a) when the opening equals the step, the message is just "Message" and no opening row shows', () => {
  const c = CARDS.find(x => x.step.opening?.status === 'ok' && same(x.step.opening.value.give, x.step.give) && x.step.message?.status === 'ok');
  assert.ok(c, 'the fixture has a card whose opening is the step');
  assert.ok(!c.text.includes('Opening message'), 'not labelled as an opening');
  assert.match(c.text, /\bMessage\b/);
  assert.ok(!c.text.includes('lower than the plan'));
});

/* ------------------------------------------------------------------------ (b) */
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
test('(b) served send_when never carries an ISO timestamp; a wait reads as a human time in ET', () => {
  const served = [];
  for (const e of entries) {
    const v = viewOf(e);
    for (const m of v.alternatives?.status === 'ok' ? v.alternatives.value : []) {
      for (const s of m.steps) if (s.send_when?.status === 'ok') served.push({ league: e.league, text: s.send_when.value });
    }
  }
  const waits = served.filter(s => s.league === 7);
  assert.ok(waits.length > 0, 'league 7 served wait cards');
  const iso = served.filter(s => ISO.test(s.text));
  console.log(`# (b) served send_when: ${served.length}; wait cards: ${waits.length}; with ISO: ${iso.length}`);
  assert.equal(iso.length, 0, iso.map(s => s.text).join(' | '));
  // 2026-09-25T05:00Z is Fri 9/25, 1:00 AM in New York (EDT).
  assert.ok(waits.every(s => s.text.startsWith('Wait until Fri 9/25, 1:00 AM ET: he declined')), waits[0]?.text);
});

test('(b) sendWhenText formats in America/New_York and keeps "Now" rows', () => {
  assert.equal(sendWhenText({ when: 'wait', until: '2026-09-25T15:51:17.498Z', why: 'he declined your last offer 17 hours ago' }),
    'Wait until Fri 9/25, 11:51 AM ET: he declined your last offer 17 hours ago.');
  assert.equal(sendWhenText({ when: 'now', why: 'nothing argues for waiting' }), 'Now: nothing argues for waiting.');
  // A wait with an unreadable time says so rather than printing the raw string.
  assert.equal(sendWhenText({ when: 'wait', until: 'soon', why: 'x' }), 'Wait: x.');
});

test('(b) the card bar says "When to send", not "send by"', () => {
  const c = CARDS.find(x => x.league === 7);
  assert.ok(c);
  assert.ok(c.text.includes('When to send'), c.text.slice(0, 200));
  assert.ok(!/send by/i.test(c.text));
  assert.ok(!ISO.test(c.text), 'no ISO time on the card');
});

/* ------------------------------------------------------------------------ (c) */
test('(c) no attention reason claims a move worth X pts when next_move is not ok', () => {
  const bad = doc.leagues.filter(e => !e.error && e.next_move?.status !== 'ok' && /worth [\d.]+ pts/.test(e.attention?.value?.reason ?? ''));
  const noMove = doc.leagues.filter(e => !e.error && e.next_move?.status !== 'ok');
  assert.ok(noMove.length >= 1, 'league 5 has no move');
  console.log(`# (c) leagues with no move: ${noMove.length}; claiming a move worth pts: ${bad.length}`);
  assert.equal(bad.length, 0, bad.map(e => `${e.league}: ${e.attention.value.reason}`).join(' | '));
  assert.ok(noMove.every(e => e.attention.value.reason.startsWith('no move clears your sliders')));
});

test('(c) leverage words: no move, no move + changed, a move', () => {
  assert.equal(leverage({ hasMove: false }).why, 'no move clears your sliders');
  assert.equal(leverage({ hasMove: false, changed: true }).why, 'no move clears your sliders, changed since last refresh');
  assert.equal(leverage({ hasMove: true, expected: 0.061, changed: true }).why, 'best move worth 6.1 pts, next move changed');
  // Callers that do not pass hasMove keep the old wording.
  assert.equal(leverage({ expected: 0.053 }).why, 'best move worth 5.3 pts');
  const r = rankAttention([{ league: 1, hasMove: false }, { league: 2, hasMove: true, expected: 0.01 }]);
  assert.deepEqual(r.map(x => [x.league, x.rank, x.of]), [[2, 1, 2], [1, 2, 2]]);
});
