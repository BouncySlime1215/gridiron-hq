/**
 * WR-SWIPE: the NEXT MOVE swipe deck, driven through React's real event system
 * (WAR-ROOM-UI.md v3 + v2 section 4). Mounted with react-dom/client on a small in-file DOM
 * (the repo has no jsdom; PR #330's shared helper is not on main yet, so this file carries
 * the same minimal DOM and can switch to test/helpers/warroom-render.js once it lands).
 *
 * Fixture: league-4-shaped. The UI contract's league-1 move, re-keyed to league 4 with its
 * scrubbed "Player <id> (POS)" names and five ranked alternatives (partners Team 7, 10, 11,
 * 2, 1), next_move = alternatives[0], plus league 4's all-in risk-mode row and catch-up line.
 *
 *  - phone (big=false): swipe left walks the five cards in deck order, "k of 5" each time;
 *  - desktop (big=true): left arrow and the Next button do the same; right arrow / Do it opens
 *    the card's actions (I sent it);
 *  - a skip with a tapped reason posts exactly one deck.skip carrying that reason;
 *  - swipe right, then "I sent it", posts exactly one offer.sent;
 *  - the last card leads to "That's every option that cleared; see near-misses", which opens
 *    the near-miss card; nothing past the end is ever drawn (no invented cards);
 *  - no layout shift at 375x812: the in-flow box tree of the deck is identical on every card,
 *    with the skip reasons open, mid-exit and at the end; the exiting card sits in an absolute
 *    layer, the reasons in a reserved row, and motion is transform/opacity only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadWarRoom, WARROOM_DIR } from './helpers/warroom-tsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

/* ------------------------------------------------------------ a minimal DOM */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
class Node {
  constructor(doc, nodeType, nodeName) { Object.assign(this, { ownerDocument: doc, nodeType, nodeName, parentNode: null, childNodes: [], _l: [] }); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, before) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this; return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i < 0) throw new Error('not a child'); this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() { return this.nodeType === 3 || this.nodeType === 8 ? this.nodeValue : this.childNodes.map(c => (c.nodeType === 8 ? '' : c.textContent)).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
  addEventListener(type, fn, o) { const capture = typeof o === 'boolean' ? o : !!o?.capture; if (fn && !this._l.some(l => l.type === type && l.fn === fn && l.capture === capture)) this._l.push({ type, fn, capture }); }
  removeEventListener(type, fn, o) { const capture = typeof o === 'boolean' ? o : !!o?.capture; this._l = this._l.filter(l => !(l.type === type && l.fn === fn && l.capture === capture)); }
}
class Text extends Node { constructor(d, t) { super(d, 3, '#text'); this.nodeValue = t; } get data() { return this.nodeValue; } set data(v) { this.nodeValue = v; } }
class Comment extends Node { constructor(d, t) { super(d, 8, '#comment'); this.nodeValue = t; } }
class Style { setProperty(k, v) { this[k] = v; } removeProperty(k) { delete this[k]; } getPropertyValue(k) { return this[k] ?? ''; } }
class Element extends Node {
  constructor(doc, tag, ns = HTML_NS) { super(doc, 1, ns === HTML_NS ? tag.toUpperCase() : tag); Object.assign(this, { localName: tag, namespaceURI: ns, _a: new Map(), style: new Style() }); }
  get tagName() { return this.nodeName; }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  setAttribute(k, v) { this._a.set(k, String(v)); }
  setAttributeNS(_n, k, v) { this.setAttribute(k, v); }
  getAttribute(k) { return this._a.has(k) ? this._a.get(k) : null; }
  hasAttribute(k) { return this._a.has(k); }
  removeAttribute(k) { this._a.delete(k); }
  removeAttributeNS(_n, k) { this.removeAttribute(k); }
  get className() { return this.getAttribute('class') ?? ''; }
  get type() { return this.getAttribute('type') ?? (this.localName === 'input' ? 'text' : this.localName === 'button' ? 'submit' : ''); }
  set type(v) { this.setAttribute('type', v); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}
for (const e of ['oninput', 'onchange', 'onclick', 'onsubmit', 'onkeydown', 'ontouchstart']) Element.prototype[e] = undefined;
class Document extends Node {
  constructor(win) {
    super(null, 9, '#document');
    this.defaultView = win;
    this.documentElement = this.appendChild(new Element(this, 'html'));
    this.body = this.documentElement.appendChild(this.createElement('body'));
    this.activeElement = this.body;
  }
  createElement(t) { return new Element(this, String(t).toLowerCase()); }
  createElementNS(ns, t) { return new Element(this, t, ns); }
  createTextNode(t) { return new Text(this, t); }
  createComment(t) { return new Comment(this, t); }
}
class DomEvent {
  constructor(type, init = {}) { Object.assign(this, { bubbles: true, cancelable: true, ...init, type, defaultPrevented: false, timeStamp: Date.now(), _stop: false }); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
  getModifierState() { return false; }
}
const winNode = new Node(null, 0, '#window');
const win = {
  location: { protocol: 'http:', href: 'http://127.0.0.1/trade-brain', pathname: '/trade-brain' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  setTimeout: (...a) => setTimeout(...a), clearTimeout: t => clearTimeout(t),
  requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0), cancelAnimationFrame: t => clearTimeout(t),
  HTMLIFrameElement: class {}, HTMLElement: Element, Element, Node, Text,
  addEventListener: winNode.addEventListener.bind(winNode), removeEventListener: winNode.removeEventListener.bind(winNode),
};
win.window = win.self = win.top = win;
const doc = new Document(win);
win.document = doc;
Object.assign(globalThis, { window: win, document: doc, HTMLElement: Element, HTMLIFrameElement: win.HTMLIFrameElement });

function fire(target, ev) {
  const p = [];
  for (let n = target; n; n = n.parentNode) p.push(n);
  p.push(winNode);
  ev.target = target;
  const run = (node, capture) => { ev.currentTarget = node; for (const l of [...node._l]) if (l.type === ev.type && l.capture === capture) l.fn.call(node, ev); };
  for (let i = p.length - 1; i >= 0 && !ev._stop; i--) run(p[i], true);
  for (let i = 0; i < p.length && !ev._stop; i++) { if (i > 0 && !ev.bubbles) break; run(p[i], false); }
  return !ev.defaultPrevented;
}
const click = el => { assert.ok(el, 'click: no element'); return fire(el, new DomEvent('click', { button: 0, detail: 1 })); };
const key = (k, target = doc.body) => fire(target, new DomEvent('keydown', { key: k }));
const pt = (x, y) => [{ clientX: x, clientY: y, identifier: 0 }];
/** A horizontal finger drag of `dx` px on `el` (touchstart, two moves, touchend). */
function swipe(el, dx, dy = 0) {
  assert.ok(el, 'swipe: no card');
  fire(el, new DomEvent('touchstart', { touches: pt(200, 400), changedTouches: pt(200, 400) }));
  fire(el, new DomEvent('touchmove', { touches: pt(200 + dx / 2, 400 + dy / 2), changedTouches: pt(200 + dx / 2, 400 + dy / 2) }));
  fire(el, new DomEvent('touchmove', { touches: pt(200 + dx, 400 + dy), changedTouches: pt(200 + dx, 400 + dy) }));
  fire(el, new DomEvent('touchend', { touches: [], changedTouches: pt(200 + dx, 400 + dy) }));
}
const all = (root, pred, out = []) => { for (const c of root.childNodes) { if (c.nodeType !== 1) continue; if (pred(c)) out.push(c); all(c, pred, out); } return out; };
const byTestId = (root, id) => all(root, e => e.getAttribute('data-testid') === id);
const hasClass = (e, c) => e.className.split(/\s+/).includes(c);
function textOf(node) {
  const parts = [];
  const walk = n => { if (n.nodeType === 3) parts.push(n.nodeValue); else if (n.nodeType === 1) n.childNodes.forEach(walk); };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
/** The live (not exiting, not aria-hidden) button under `root` with this text. */
function button(root, label) {
  const hidden = e => { for (let n = e; n && n !== root; n = n.parentNode) if (n.getAttribute?.('aria-hidden') === 'true') return true; return false; };
  return all(root, e => e.localName === 'button' && !hidden(e) && (label instanceof RegExp ? label.test(textOf(e)) : textOf(e) === label))[0] ?? null;
}
async function waitFor(fn, what = 'condition', ms = 3000) {
  const start = Date.now();
  let last;
  for (;;) {
    try { const v = await fn(); if (v) return v; last = new Error(`waitFor: ${what}`); } catch (e) { last = e; }
    if (Date.now() - start > ms) throw last;
    await new Promise(r => setTimeout(r, 5));
  }
}
const settle = () => new Promise(r => setTimeout(r, 20));

/* ------------------------------------------------------------ modules + fixture */

const req = createRequire(path.join(REPO, 'package.json'));
const React = req('react');
const { createRoot } = req('react-dom/client');
const wr = await loadWarRoom();
test.after(() => wr.cleanup());
const { default: NextMoveDeck } = await wr.mod('NextMoveDeck');
const Swipe = await wr.mod('SwipeDeck');
const { buildWarRoomView } = await import('../server/services/war-room-view.js');
const { validateLeague } = await import('../server/services/campaign/plans-schema.js');

const producer = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'warroom-contract', 'ui-contract-plans.json'), 'utf8'));
const POS = { 15: 'RB', 132: 'RB', 134: 'WR', 290: 'WR', 367: 'RB', 368: 'WR', 379: 'RB', 171: 'RB', 197: 'RB', 43: 'WR', 44: 'WR', 56: 'WR', 69: 'WR', 82: 'WR', 146: 'RB', 159: 'RB', 5: 'WR' };
/** League 4's five ranked moves: [partner, give, get]. Card 1 is league 4's all-in first step. */
const DECK = [['7', ['367', '379'], ['290']], ['10', ['43'], ['134']], ['11', ['44', '146'], ['132']], ['2', ['56'], ['15']], ['1', ['69', '159'], ['171']]];

function league4() {
  const l = structuredClone(producer.leagues[0]);
  l.league = 4;
  l.me = '5';
  // Every id the contract fixture's other sections name stays, scrubbed the league-4 way.
  const scrub = (id, n) => `Player ${id} (${/\((\w+)\)$/.exec(n)?.[1] ?? 'WR'})`;
  l.names = Object.fromEntries([...Object.entries(l.names).map(([id, n]) => [id, scrub(id, n)]),
    ...Object.entries(POS).map(([id, pos]) => [id, `Player ${id} (${pos})`])]);
  const base = l.alternatives.value[0];
  l.alternatives.value = DECK.map(([partner, give, get], i) => {
    const m = structuredClone(base);
    m.move_id = `L4-m${i + 1}`;
    m.rank = i + 1;
    m.target = '368';
    m.target_owner = '1';
    m.chained = false;
    m.steps = [Object.assign(structuredClone(base.steps[0]), { partner, give, get })];
    m.steps[0].p_yes = { status: 'ok', value: 0.3 + i / 100, source: 'clone.accept' };
    m.steps[0].opening.value = { ...m.steps[0].opening.value, give: give.slice(0, 1), get };
    m.steps[0].walk_away.value = { ...m.steps[0].walk_away.value, max_give: give };
    for (const branch of Object.values(m.steps[0].reply_table.value)) if (branch.value?.move_id) branch.value.move_id = m.move_id;
    return m;
  });
  l.next_move = { status: 'ok', value: structuredClone(l.alternatives.value[0]), source: 'plan.path' };
  const row = (mode, label, active, first_step, expected) => ({
    mode, label, active,
    expected: { status: 'ok', value: expected, source: 'plan.path', unit: 'title_odds' },
    if_complete: { status: 'ok', value: 0.0325, source: 'plan.path', unit: 'title_odds' },
    p_complete: { status: 'ok', value: 0.137, source: 'plan.path', unit: 'probability', guess: true },
    first_step,
  });
  l.risk_modes = { status: 'ok', source: 'plan.path', value: [
    row('safe', 'Safe', false, { partner: '10', give: ['82'], get: ['197'] }, 0.0021),
    row('balanced', 'Balanced', true, { partner: '7', give: ['367', '379'], get: ['290'] }, 0.0031),
    // League 4's all-in row: its first step IS card 1, so it cleared and is no near-miss.
    row('all_in', 'Fuck it, let\'s go', false, { partner: '7', give: ['367', '379'], get: ['290'] }, 0.0044),
  ] };
  l.catch_up = { status: 'ok', source: 'plan.path', value: [
    { text: 'You are behind: the all-in plan reaches +3.3 pts if it lands.', gain: { status: 'ok', value: 0.0044, source: 'plan.path', unit: 'title_odds' }, steps: 2 },
  ] };
  return l;
}
const LEAGUE4 = league4();
const view = () => buildWarRoomView(4, { status: 'ok', entries: [structuredClone(LEAGUE4)], as_of: '2026-09-24T07:29:00.000Z', id: 'plans@1' }, { enabled: true, preview: false });

/** Mount the deck; `calls` collects every request it posts. */
function mount(props = {}) {
  const calls = [];
  const post = async (p, init) => { calls.push({ path: p, ...JSON.parse(init.body) }); return { ok: true }; };
  const container = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(container);
  root.render(React.createElement(NextMoveDeck, { view: view(), big: false, post, ...props }));
  return { container, calls, unmount: () => { root.unmount(); doc.body.removeChild(container); assert.equal(keysBound(), false, 'unmount unbinds the keys'); } };
}
const liveCard = c => byTestId(c, 'move-card')[0] ?? null;
/** SwipeDeck binds its arrow keys in a passive effect, which can run after card 1 is in the DOM. */
const keysBound = () => winNode._l.some(l => l.type === 'keydown');
/** Mounted = card 1 drawn AND every effect run (the keydown listener is the last one bound). */
const mounted = ui => waitFor(() => cardId(ui.container) === 'L4-m1' && keysBound(), 'card 1 = next_move, keys bound');
const cardId = c => liveCard(c)?.getAttribute('data-move') ?? null;
const counter = c => textOf(byTestId(c, 'deck-count')[0] ?? { nodeType: 8 });

test('the fixture is a valid league-4 entry; the deck is alternatives, head = next_move', () => {
  assert.deepEqual(validateLeague(LEAGUE4, '$').errors, []);
  const v = view();
  assert.equal(v.alternatives.status, 'ok');
  assert.deepEqual(v.alternatives.value.map(m => m.move_id), ['L4-m1', 'L4-m2', 'L4-m3', 'L4-m4', 'L4-m5']);
  assert.equal(v.next_move.value.move_id, v.alternatives.value[0].move_id);
  for (const n of Object.values(LEAGUE4.names)) assert.match(n, /^Player \w+ \(\w+\)$/, 'no real names');
});

test('phone: swipe left walks the deck in order with "k of 5", then the end state', async () => {
  const ui = mount();
  try {
    await mounted(ui);
    const seen = [];
    for (let k = 1; k <= 5; k++) {
      assert.equal(counter(ui.container), `${k} of 5`, `position indicator on card ${k}`);
      const id = cardId(ui.container);
      seen.push(id);
      assert.match(textOf(liveCard(ui.container)), new RegExp(`Send to Team ${DECK[k - 1][0]}\\b`));
      swipe(liveCard(ui.container), -140);
      await waitFor(() => cardId(ui.container) !== id, `left swipe leaves card ${k}`);
    }
    assert.deepEqual(seen, ['L4-m1', 'L4-m2', 'L4-m3', 'L4-m4', 'L4-m5'], 'contract deck order, nothing skipped, nothing invented');
    assert.equal(liveCard(ui.container), null, 'no card past the end');
    const end = byTestId(ui.container, 'deck-end')[0];
    assert.ok(end, 'end-of-deck state');
    assert.match(textOf(end), /That's every option that cleared; see near-misses/);
    assert.match(counter(ui.container), /all 5 seen/);
    // Nothing past the end: more swipes and arrows draw no card and post nothing new.
    swipe(end, -140);
    key('ArrowLeft');
    await settle();
    assert.equal(liveCard(ui.container), null);
    // The last skip posts once its reason prompt closes (ignored here): 5 skips, 5 rows.
    click(button(ui.container, /See near-misses/));
    await waitFor(() => byTestId(ui.container, 'near-miss').length === 1, 'the near-miss card opens');
    const near = textOf(byTestId(ui.container, 'near-miss')[0]);
    assert.match(near, /Offer Team 10 ?: Player 82 \(WR\) for Player 197 \(RB\)/, 'a path that did not clear');
    assert.doesNotMatch(near, /Player 367/, 'card 1 cleared, so it is never shown as a near-miss');
    // Each skip posted when the next one started; the last waits on its optional reason.
    await waitFor(() => ui.calls.length === 4, 'four skips posted');
    click(button(ui.container, 'Not now'));
    await waitFor(() => ui.calls.length === 5, 'the fifth, once its reason is tapped');
    await settle();
    assert.deepEqual(ui.calls.map(c => [c.kind, c.payload.move_id, c.payload.reason]),
      [...['L4-m1', 'L4-m2', 'L4-m3', 'L4-m4'].map(id => ['deck.skip', id, undefined]), ['deck.skip', 'L4-m5', 'not_now']],
      'exactly one deck.skip per card, in deck order');
  } finally { ui.unmount(); }
});

test('a small or vertical drag is not a swipe', async () => {
  const ui = mount();
  try {
    await mounted(ui);
    swipe(liveCard(ui.container), -30);
    swipe(liveCard(ui.container), -90, -200);
    await settle();
    assert.equal(cardId(ui.container), 'L4-m1');
    assert.equal(counter(ui.container), '1 of 5');
  } finally { ui.unmount(); }
});

test('skip with a reason posts exactly one deck.skip carrying the reason', async () => {
  const ui = mount();
  try {
    await mounted(ui);
    swipe(liveCard(ui.container), -140);
    await waitFor(() => button(ui.container, 'Costs too much'), 'the optional reason row');
    for (const label of ["Don't like the player", "Don't trust this manager", 'Not now']) assert.ok(button(ui.container, label), label);
    assert.equal(ui.calls.length, 0, 'nothing posts while the reason is on offer');
    click(button(ui.container, 'Costs too much'));
    await waitFor(() => ui.calls.length === 1, 'one request');
    await settle();
    assert.deepEqual(ui.calls, [{ path: '/warroom/4/requests', kind: 'deck.skip', payload: { move_id: 'L4-m1', reason: 'cost' }, source: 'nick' }]);
    assert.equal(button(ui.container, 'Costs too much'), null, 'the reason row closes');
    assert.equal(cardId(ui.container), 'L4-m2');
    assert.equal(counter(ui.container), '2 of 5');
  } finally { ui.unmount(); }
});

test('phone: swipe right opens the card\'s actions; "I sent it" posts exactly one offer.sent', async () => {
  const ui = mount();
  try {
    await mounted(ui);
    assert.equal(button(ui.container, 'I sent it'), null, 'actions closed until opened');
    swipe(liveCard(ui.container), 140);
    await waitFor(() => button(ui.container, 'I sent it'), 'actions open');
    assert.equal(cardId(ui.container), 'L4-m1', 'a right swipe keeps the card');
    assert.equal(ui.calls.length, 0, 'opening the actions posts nothing');
    click(button(ui.container, 'I sent it'));
    await waitFor(() => ui.calls.length === 1, 'offer.sent');
    click(button(ui.container, /Marked as sent|I sent it/));
    await settle();
    assert.deepEqual(ui.calls, [{ path: '/warroom/4/requests', kind: 'offer.sent', payload: { move_id: 'L4-m1' }, source: 'nick' }]);
  } finally { ui.unmount(); }
});

test('desktop: arrow keys and buttons move through the deck and open the actions', async () => {
  const ui = mount({ big: true });
  try {
    await mounted(ui);
    key('ArrowLeft');
    await waitFor(() => cardId(ui.container) === 'L4-m2', 'left arrow = Next');
    assert.equal(counter(ui.container).startsWith('2 of 5'), true);
    click(button(ui.container, 'Next →'));
    await waitFor(() => cardId(ui.container) === 'L4-m3', 'Next button');
    click(button(ui.container, '← back'));
    await waitFor(() => cardId(ui.container) === 'L4-m2', 'back undoes a skip');
    key('ArrowRight');
    await waitFor(() => button(ui.container, 'I sent it'), 'right arrow = Do it');
    click(button(ui.container, 'I sent it'));
    await waitFor(() => ui.calls.some(c => c.kind === 'offer.sent'), 'offer.sent');
    // Typing never drives the deck.
    const input = ui.container.appendChild(doc.createElement('input'));
    input.focus();
    key('ArrowLeft', input);
    await settle();
    assert.equal(cardId(ui.container), 'L4-m2');
    input.blur();
    for (let i = 0; i < 4; i++) { click(button(ui.container, 'Next →')); await settle(); }
    await waitFor(() => byTestId(ui.container, 'deck-end').length === 1, 'end of deck on desktop');
    assert.match(textOf(byTestId(ui.container, 'deck-end')[0]), /That's every option that cleared; see near-misses/);
    assert.match(textOf(byTestId(ui.container, 'deck-end')[0]), /That was every move/);
    await waitFor(() => ui.calls.filter(c => c.kind === 'deck.skip').length >= 4, 'skips posted');
    const skips = ui.calls.filter(c => c.kind === 'deck.skip').map(c => c.payload.move_id);
    assert.deepEqual(skips.slice(0, 1), ['L4-m1'], 'the undone skip of L4-m2 never posted');
    assert.equal(skips.filter(id => id === 'L4-m2').length, 1);
    assert.equal(ui.calls.filter(c => c.kind === 'offer.sent').length, 1);
  } finally { ui.unmount(); }
});

test('the swipe helpers: thresholds, and keys ignored while typing', () => {
  assert.equal(Swipe.swipeIntent(-140, 0), 'next');
  assert.equal(Swipe.swipeIntent(140, 10), 'open');
  assert.equal(Swipe.swipeIntent(-30, 0), null);
  assert.equal(Swipe.swipeIntent(-90, -200), null);
  assert.equal(Swipe.keyIntent({ key: 'ArrowLeft' }, 'DIV'), 'next');
  assert.equal(Swipe.keyIntent({ key: 'ArrowRight' }, 'BODY'), 'open');
  assert.equal(Swipe.keyIntent({ key: 'ArrowLeft' }, 'INPUT'), null);
  assert.equal(Swipe.keyIntent({ key: 'ArrowLeft', metaKey: true }, 'BODY'), null);
  assert.equal(Swipe.positionLabel(1, 5), '2 of 5');
  assert.equal(Swipe.positionLabel(5, 5), 'all 5 seen');
});

/* ------------------------------------------------------------ layout at 375x812 */

const css = fs.readFileSync(path.join(WARROOM_DIR, 'warroom.css'), 'utf8');
const decl = sel => {
  const m = css.match(new RegExp(`(^|\\n)\\s*${sel.replace(/[.[\]"=()-]/g, c => `\\${c}`)}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
};
/** The in-flow frame of the deck: its rows, and the stage's in-flow slot (absolute layers left out). */
function flowTree(root) {
  const deck = byTestId(root, 'swipe-deck')[0];
  assert.ok(deck, 'the swipe deck is mounted');
  const tag = e => `${e.localName}.${e.className.split(/\s+/).filter(x => x.startsWith('wr-swipe')).join('.')}`;
  return deck.children.map(row => `${tag(row)}${hasClass(row, 'wr-swipe-stage')
    ? `[${row.children.filter(c => !hasClass(c, 'wr-swipe-layer')).map(tag).join(',')}]` : ''}`).join(',');
}

test('no layout shift at 375x812: the deck frame never changes shape; motion is transform-only', async () => {
  const ui = mount();
  try {
    await mounted(ui);
    const frame = flowTree(ui.container);
    assert.match(frame, /div\.wr-swipe-bar/);
    assert.match(frame, /div\.wr-swipe-stage/);
    assert.match(frame, /div\.wr-swipe-foot$/);
    const shapes = [['card 1', frame]];
    swipe(liveCard(ui.container), -140);
    await waitFor(() => button(ui.container, 'Costs too much'), 'reasons open');
    const ghost = all(ui.container, e => hasClass(e, 'wr-swipe-ghost'));
    assert.equal(ghost.length, 1, 'the leaving card is drawn once, in the exit layer');
    assert.equal(ghost[0].parentNode.getAttribute('aria-hidden'), 'true');
    shapes.push(['card 2, reasons open, card 1 exiting', flowTree(ui.container)]);
    click(button(ui.container, 'Not now'));
    await waitFor(() => all(ui.container, e => hasClass(e, 'wr-swipe-ghost')).length === 0, 'the exit finishes');
    shapes.push(['card 2, settled', flowTree(ui.container)]);
    for (let i = 0; i < 4; i++) { swipe(liveCard(ui.container), -140); await settle(); }
    await waitFor(() => byTestId(ui.container, 'deck-end').length === 1, 'end');
    const end = flowTree(ui.container);
    for (const [name, shape] of shapes) assert.equal(shape, frame, `${name}: same in-flow frame as card 1`);
    assert.equal(end.replace('wr-swipe-card', 'X').replace('wr-swipe-end', 'X'), frame.replace('wr-swipe-card', 'X'),
      'the end card takes the card\'s slot');
  } finally { ui.unmount(); }

  // What moves sits in absolute layers; the stage clips it, so nothing pushes the page.
  assert.match(decl('.wr-swipe-stage') ?? '', /position:\s*relative/);
  assert.match(decl('.wr-swipe-stage') ?? '', /overflow:\s*hidden/);
  assert.match(decl('.wr-swipe-layer') ?? '', /position:\s*absolute/);
  assert.match(decl('.wr-swipe-foot') ?? '', /min-height:\s*\d+px/, 'the skip-reason row is reserved, shown or not');
  assert.match(css, /@media \(max-width: 699px\)\s*\{[^@]*\.wr-swipe-foot\s*\{\s*min-height:\s*\d+px/, 'and taller on a phone, where the reasons wrap');
  assert.match(decl('.wr-swipe-bar') ?? '', /min-height:\s*\d+px/, 'the counter row keeps its height with or without Back');
  assert.match(decl('.wr-swipe-pos') ?? '', /tabular-nums/, '"2 of 5" never reflows its row');
  // Keyframes and transitions touch transform/opacity only (no width/height/top/left/margin).
  const frames = [...css.matchAll(/@keyframes (wr-swipe-[\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)];
  assert.ok(frames.length >= 2, 'enter and exit keyframes');
  for (const [, name, body] of frames) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
    assert.deepEqual([...new Set(props)].filter(p => p !== 'transform' && p !== 'opacity' && !p.startsWith('--')), [], `${name} animates transform/opacity only`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*wr-swipe/, 'reduced motion turns the wipe off');
});
