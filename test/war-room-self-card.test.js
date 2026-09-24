/**
 * SELF-01b: the follow / ignore card in the War Room ("You, read from your own moves").
 * It formats what /trades/:id/war-room/self served and computes nothing.
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
const { default: SelfCard } = await wr.mod('SelfCard');
const { default: WarRoom, PANELS } = await wr.mod('WarRoom');
const { useWarRoomSelf } = await wr.mod('useWarRoom');

const F = { producer: 'self-bias', producer_version: 'x', source: 'self.record' };
const view = {
  enabled: true,
  follow: { ...F, status: 'ok', value: { kinds: [
    { kind: 'waiver', label: 'Waiver calls', follow: 2, ignore: 8, no_action: 1, open: 1 },
    { kind: 'start_sit', label: 'Start/sit calls', follow: 8, ignore: 0, no_action: 0, open: 0 },
  ] } },
  flags: { ...F, status: 'ok', value: [
    { category: 'waiver', bias: 'ignores', label: 'You skip waiver calls',
      forward: { n: 4, hits: 4, precision: 1, base_rate: 0.5 } },
  ] },
  held: 2,
  note: 'A flag shows only when it predicted your own later weeks better than the base rate.',
};

const render = (v, big = true) => textOf(renderToStaticMarkup(React.createElement(SelfCard, { view: v, big })));

test('the card shows follow / skip counts per call kind and each shown flag with its forward record', () => {
  const t = render(view);
  for (const s of ['Waiver calls', 'followed 2', 'skipped 8', 'Start/sit calls', 'followed 8',
    'You skip waiver calls', 'right 4 of 4', 'base 50%', '2 more held back']) assert.ok(t.includes(s), `${s} in: ${t}`);
});

test('no flag yet reads as a sentence, not an empty list or a 0%', () => {
  const t = render({ ...view, flags: { ...F, status: 'ok', value: [] }, held: 0 });
  assert.match(t, /No habit has earned a flag yet/);
  assert.doesNotMatch(t, /\b0%|NaN|undefined/);
});

test('unknown follow record names why, with no digits', () => {
  const t = render({ ...view, follow: { ...F, status: 'unknown', reason: 'no shown call has been resolved yet' } });
  assert.match(t, /no shown call has been resolved yet/);
});

test('loading and off states render without numbers', () => {
  assert.match(render(null), /loading/i);
  assert.match(render({ enabled: false }), /off/i);
});

test('the War Room draws the card in its own grid area and asks for the one self route', () => {
  assert.ok(PANELS.some(p => p.id === 'self'));
  const wv = buildWarRoomView(1, { status: 'ok', entries: structuredClone(fixture), as_of: 'x', id: 'y' }, { enabled: true, preview: true });
  const html = renderToStaticMarkup(React.createElement(WarRoom, {
    view: wv, self: view, leagues: [{ id: 1, name: 'League 1' }], activeId: 1, onLeague() {}, onExit() {},
  }));
  assert.match(html, /data-panel="self"[^>]*style="grid-area:self"/);
  assert.ok(textOf(html).includes('You skip waiver calls'));
  globalThis.__warRoomPaths = [];
  const Probe = () => { useWarRoomSelf(3); useWarRoomSelf(null); return null; };
  renderToStaticMarkup(React.createElement(Probe));
  assert.deepEqual(globalThis.__warRoomPaths, ['/trades/3/war-room/self', null]);
});
