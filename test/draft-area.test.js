/**
 * Draft area (docs/ui/CONSOLIDATION-MAP.md, area 5): one title, views on ?view= (old names kept),
 * Recaps lists finished drafts and opens their recap, "Manual tracker" instead of "Live draft
 * tracker", a live ESPN draft opens the live room. Plus the Players Board's phone step (25 rows).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('one Draft title: the Boards and Live views draw section headings, not their own h1', () => {
  assert.match(read('client/src/pages/DraftHub.tsx'), /<PageHeader eyebrow="Draft" title="Draft"/);
  for (const p of ['client/src/pages/Drafts.tsx']) assert.doesNotMatch(read(p), /<h1/, `${p} draws no h1`);
  const live = read('client/src/pages/LiveDraft.tsx');
  assert.doesNotMatch(live.slice(0, live.indexOf('export default function LiveDraft')), /<h1/, 'the live hub view draws no h1');
});

test('views on ?view=, with the old names still landing', () => {
  const hub = read('client/src/pages/DraftHub.tsx');
  assert.match(hub, /v === 'mock' \? 'boards' : v === 'recap' \? 'recaps'/);
  assert.match(hub, /<Tabs label="Draft views"/);
});

test('Recaps lists finished drafts and opens each recap', () => {
  const hub = read('client/src/pages/DraftHub.tsx');
  assert.match(hub, /d\.picks_made >= d\.team_count \* d\.rounds/, 'finished = every pick made');
  assert.match(hub, /to=\{`\/draft\/\$\{d\.id\}\?recap=1`\}/);
  assert.doesNotMatch(hub, /view === 'recap' \? .*<Drafts/, 'Recaps no longer renders the boards list');
  const room = read('client/src/pages/DraftRoom.tsx');
  assert.match(room, /useState\(\(\) => params\.get\('recap'\) === '1'\)/, 'the room opens its recap on arrival');
});

test('board types: Manual tracker, and an ESPN live draft opens the live room', () => {
  const d = read('client/src/pages/Drafts.tsx');
  assert.match(d, /<option value="live_tracking">Manual tracker<\/option>/);
  assert.doesNotMatch(d, /Live draft tracker/);
  assert.match(d, /to=\{d\.type === 'live' \? `\/draft\/live\/\$\{d\.id\}` : `\/draft\/\$\{d\.id\}`\}/);
});

test('Players Board: a phone starts at 25 rows and steps by 25', () => {
  const b = read('client/src/pages/Projections.tsx');
  assert.match(b, /matchMedia\?\.\('\(max-width: 639px\)'\)\.matches \? 25 : 100/);
  assert.match(b, /setLimit\(l => l \+ step\)/);
});
