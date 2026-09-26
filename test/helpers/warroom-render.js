/**
 * A small DOM for node:test, enough for react-dom/client to mount the War Room and for a
 * test to click, type and submit through React's real event system. No new dependency:
 * the repo has react-dom but no jsdom, and the War Room tests so far could only render
 * static markup (renderToStaticMarkup), so no button was ever pressed.
 *
 *   const dom = installDom();                  // before react-dom/client is loaded
 *   const { mount } = await domRenderer();     // react-dom/client, on this DOM
 *   const ui = mount(React.createElement(App)); // ui.container, ui.unmount()
 *   click(button(ui.container, 'Next →'));
 *   await waitFor(() => textOf(ui.container).includes('2 of 5'));
 *
 * What it models: element/text nodes, attributes, inline style, the event path
 * (capture then bubble, through the container React listens on), focus, and the
 * window bits WarRoom.tsx touches (matchMedia, keydown listeners, timers). It is not a
 * browser: no layout, no CSS, no scrolling. Tests assert structure and requests only.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML_NS = 'http://www.w3.org/1999/xhtml';

class Node {
  constructor(doc, nodeType, nodeName) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = [];
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    const sib = this.parentNode?.childNodes;
    return sib ? sib[sib.indexOf(this) + 1] ?? null : null;
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (i < 0) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: not a child of this node');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent() {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue;
    return this.childNodes.map(c => (c.nodeType === 8 ? '' : c.textContent)).join('');
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  addEventListener(type, fn, opts) {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    if (!this._listeners.some(l => l.type === type && l.fn === fn && l.capture === capture)) this._listeners.push({ type, fn, capture });
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    this._listeners = this._listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture));
  }
}

class Text extends Node {
  constructor(doc, text) { super(doc, 3, '#text'); this.nodeValue = text; }
  get data() { return this.nodeValue; }
  set data(v) { this.nodeValue = v; }
}

class Comment extends Node {
  constructor(doc, text) { super(doc, 8, '#comment'); this.nodeValue = text; }
}

class Style {
  setProperty(k, v) { this[k] = v; }
  removeProperty(k) { delete this[k]; }
  getPropertyValue(k) { return this[k] ?? ''; }
}

class Element extends Node {
  constructor(doc, tag, ns = HTML_NS) {
    super(doc, 1, ns === HTML_NS ? tag.toUpperCase() : tag);
    this.localName = tag;
    this.namespaceURI = ns;
    this._attrs = new Map();
    this.style = new Style();
  }
  get tagName() { return this.nodeName; }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  setAttributeNS(_ns, k, v) { this.setAttribute(k, v); }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  hasAttribute(k) { return this._attrs.has(k); }
  removeAttribute(k) { this._attrs.delete(k); }
  removeAttributeNS(_ns, k) { this.removeAttribute(k); }
  get className() { return this.getAttribute('class') ?? ''; }
  /** A browser's default input type is "text" (React's change plugin reads it). */
  get type() { return this.getAttribute('type') ?? (this.localName === 'input' ? 'text' : this.localName === 'button' ? 'submit' : ''); }
  set type(v) { this.setAttribute('type', v); }
  get id() { return this.getAttribute('id') ?? ''; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  scrollTo() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  /** Attribute selectors only (`[name="value"]`, `[name]`, comma lists of them), in document order. */
  querySelectorAll(sel) {
    const parts = String(sel).split(',').map(p => {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p.trim());
      if (!m) throw new Error(`test DOM: querySelectorAll supports [attr] and [attr="value"] (comma lists too) only, not ${sel}`);
      return m;
    });
    const hit = c => parts.some(m => (m[2] === undefined ? c.hasAttribute(m[1]) : c.getAttribute(m[1]) === m[2]));
    const out = [];
    const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { if (hit(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
// React feature-detects `on<event> in document` (isEventSupported); a browser has these.
for (const proto of [Element.prototype]) for (const e of ['oninput', 'onchange', 'onclick', 'onsubmit', 'onkeydown']) proto[e] = undefined;

class Document extends Node {
  constructor(win) {
    super(null, 9, '#document');
    this.ownerDocument = null;
    this.defaultView = win;
    this.documentElement = this.appendChild(new Element(this, 'html'));
    this.documentElement.ownerDocument = this;
    this.body = this.documentElement.appendChild(this.createElement('body'));
    this.activeElement = this.body;
    this.oninput = null;
    this.onchange = null;
  }
  createElement(tag) { return new Element(this, String(tag).toLowerCase()); }
  createElementNS(ns, tag) { return new Element(this, tag, ns); }
  createTextNode(text) { return new Text(this, text); }
  createComment(text) { return new Comment(this, text); }
}

/** One DOM event, dispatched by fire(). */
export class DomEvent {
  constructor(type, init = {}) {
    Object.assign(this, { bubbles: true, cancelable: true, ...init });
    this.type = type;
    this.defaultPrevented = false;
    this.timeStamp = Date.now();
    this._stop = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
  getModifierState() { return false; }
}

let installed = null;

/**
 * Install window/document globals (idempotent). Must run before react-dom is first
 * required, because React decides at load time whether it has a DOM.
 */
export function installDom() {
  if (installed) return installed;
  const win = {
    location: { protocol: 'http:', href: 'http://127.0.0.1/trade-brain?view=war-room', pathname: '/trade-brain' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (...a) => setTimeout(...a), clearTimeout: t => clearTimeout(t),
    setInterval: (...a) => setInterval(...a), clearInterval: t => clearInterval(t),
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0), cancelAnimationFrame: t => clearTimeout(t),
    HTMLIFrameElement: class HTMLIFrameElement {},
    HTMLElement: Element, Element, Node, Text,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    event: undefined,
  };
  const winTarget = new Node(null, 0, '#window');
  win.addEventListener = winTarget.addEventListener.bind(winTarget);
  win.removeEventListener = winTarget.removeEventListener.bind(winTarget);
  win._node = winTarget;
  win.top = win; win.self = win; win.window = win;
  const doc = new Document(win);
  win.document = doc;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.HTMLIFrameElement = win.HTMLIFrameElement;
  globalThis.HTMLElement = Element;
  installed = { window: win, document: doc };
  return installed;
}

/** react-dom/client on the installed DOM (the repo's copy: the same React the modules render with). */
export async function domRenderer() {
  const { document: doc } = installDom();
  const req = createRequire(path.join(REPO, 'package.json'));
  const React = req('react');
  const { createRoot } = req('react-dom/client');
  const mount = element => {
    const container = doc.body.appendChild(doc.createElement('div'));
    const root = createRoot(container);
    root.render(element);
    return { container, root, unmount: () => { root.unmount(); doc.body.removeChild(container); } };
  };
  return { React, mount };
}

/** Dispatch `event` at `target`: capture from the window down, then bubble back up. */
export function fire(target, event) {
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  path.push(installed.window._node);
  event.target = target;
  const prev = installed.window.event;
  installed.window.event = event;
  try {
    for (let i = path.length - 1; i >= 0 && !event._stop; i--) run(path[i], event, true);
    for (let i = 0; i < path.length && !event._stop; i++) {
      if (i > 0 && !event.bubbles) break;
      run(path[i], event, false);
    }
  } finally { installed.window.event = prev; }
  return !event.defaultPrevented;
}
function run(node, event, capture) {
  event.currentTarget = node;
  for (const l of [...node._listeners]) if (l.type === event.type && l.capture === capture) l.fn.call(node, event);
}

export const click = el => { if (!el) throw new Error('click: no element'); return fire(el, new DomEvent('click', { button: 0, detail: 1 })); };
export const submit = form => fire(form, new DomEvent('submit'));
export const keydown = (key, target = installed.document.body) => fire(target, new DomEvent('keydown', { key }));
/** Type into a controlled input: set its value, then the input event React listens for. */
export function type(input, value) {
  input.value = value;
  return fire(input, new DomEvent('input'));
}

/** Every element under `root` (depth first) that passes `pred`. */
export function all(root, pred = () => true, out = []) {
  for (const c of root.childNodes) {
    if (c.nodeType !== 1) continue;
    if (pred(c)) out.push(c);
    all(c, pred, out);
  }
  return out;
}
export const byAttr = (root, name, value) => all(root, e => (value === undefined ? e.hasAttribute(name) : e.getAttribute(name) === String(value)));
export const one = (root, name, value) => byAttr(root, name, value)[0] ?? null;

/** Visible text, with a space between nodes (so "1" + "of" + "5" reads "1 of 5"). */
export function textOf(node) {
  const parts = [];
  const walk = n => {
    if (n.nodeType === 3) parts.push(n.nodeValue);
    else if (n.nodeType === 1) {
      if (n.localName === 'title' && n.namespaceURI !== HTML_NS) return; // svg tooltips are not visible text
      n.childNodes.forEach(walk);
    }
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The button under `root` whose own text is `label` (exact, trimmed) or matches a RegExp. */
export function button(root, label) {
  const hits = all(root, e => e.localName === 'button' && (label instanceof RegExp ? label.test(textOf(e)) : textOf(e) === label));
  return hits[0] ?? null;
}

/** Poll until `fn()` is truthy (or returns without throwing); fail with the last error after `ms`. */
export async function waitFor(fn, ms = 3000, what = 'condition') {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = new Error(`waitFor: ${what} still false`);
    } catch (e) { last = e; }
    if (Date.now() - start > ms) throw last;
    await new Promise(r => setTimeout(r, 10));
  }
}
