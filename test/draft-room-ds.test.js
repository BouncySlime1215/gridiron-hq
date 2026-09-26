/**
 * The mock draft room (/draft/:id) on the design system (polish backlog: draft room internals):
 * DS header, buttons and chips; panels, the clock and board cells on tokens (dark mode follows);
 * no legacy slate/white/emerald classes; empty board cells readable (the old grey dash was 1.46:1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const room = read('client/src/pages/DraftRoom.tsx');
const render = room.slice(room.indexOf('  return (\n    <div className="draft-room">'));

test('the room renders on DS primitives', () => {
  assert.match(room, /import \{ Button, Card, Chip, PageHeader \} from '\.\.\/components\/ui\/DesignSystem';/);
  assert.match(render, /<PageHeader eyebrow="Draft" title=\{draft\.name\}/);
  assert.equal((render.match(/className="dr-panel"/g) ?? []).length, 3, 'three panels: available, board, my team');
  assert.doesNotMatch(render, /\b(bg|text|border)-(slate|white|emerald|sky)-?\d*\b|btn-ghost|btn-primary|className="card /, 'no legacy palette classes in the room');
});

test('controls explain themselves and the board reads', () => {
  assert.match(render, /title=\{draft\.picks\.length === 0 \? 'No pick to undo yet'/);
  assert.match(render, /aria-label=\{p \? `\$\{p\.position\} \$\{p\.name\}` : `Round \$\{r \+ 1\}, team \$\{slot\}: not picked yet`\}/);
  assert.doesNotMatch(render, /text-slate-300/, 'the unreadable grey dash is gone');
  const css = read('client/src/styles/ui.css');
  for (const c of ['.dr-panel', '.dr-clock', '.dr-pick-go', '.dr-cell-empty']) assert.ok(css.includes(`${c} {`), c);
});

test('the recap is a dialog and Escape closes it', () => {
  const recap = read('client/src/components/DraftRecap.tsx');
  assert.match(recap, /role="dialog" aria-modal="true" aria-label="Draft recap"/);
  assert.match(recap, /if \(e\.key === 'Escape'\) onClose\(\);/);
});

test('the live room (/draft/live/:id) on DS: header, chips, no neutral legacy palette', () => {
  const live = read('client/src/pages/LiveDraft.tsx');
  assert.match(live, /import \{ Button, Chip, PageHeader \} from '\.\.\/components\/ui\/DesignSystem';/);
  assert.match(live, /<PageHeader eyebrow="Live draft" title=\{d\.name\}/);
  assert.match(live, /<Chip key=\{p\} on=\{filter === p\} onClick=\{\(\) => setFilter\(p\)\}>/);
  assert.match(live, /<Chip key=\{t\} on=\{rosterTab === t\} onClick=\{\(\) => setRosterTab\(t\)\}>/);
  assert.match(live, /title=\{live \? 'Syncing with ESPN every 4 seconds; click to pause'/);
  assert.doesNotMatch(live, /\b(bg|text|border|divide)-(slate|white)(-\d+)?\b/, 'neutrals come from tokens');
  assert.doesNotMatch(live, /className=[^>]*(?<![-\w])card\b|ds-ds-/, 'ds-card, not the legacy card');
});
