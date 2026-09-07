import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'client', 'public', 'draft-capture.js');
const DRAFT_URL = 'wss://fantasydraft.espn.com/game-ffl/draft/123?x=1';

/** A minimal browser: WebSocket + MessageEvent with the real getter shape. */
function fakeWindow() {
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.sent = []; this.listeners = {};
      FakeWebSocket.instances.push(this);
    }
    send(data) { this.sent.push(data); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    /** Deliver a frame the way the browser does: listeners get the event object. */
    receive(data) {
      const ev = new FakeMessageEvent('message', { data });
      Object.defineProperty(ev, 'target', { value: this, configurable: true });
      for (const fn of this.listeners.message || []) fn(ev);
      return ev;
    }
  }
  FakeWebSocket.instances = [];
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;

  const store = new WeakMap();
  class FakeMessageEvent {
    constructor(type, init) { this.type = type; store.set(this, init?.data); }
  }
  Object.defineProperty(FakeMessageEvent.prototype, 'data', {
    configurable: true, enumerable: true, get() { return store.get(this); }
  });

  const win = {
    WebSocket: FakeWebSocket, MessageEvent: FakeMessageEvent, WeakSet, TextEncoder, ArrayBuffer,
    console: { log() {} }, setTimeout, clearTimeout, document: null
  };
  return win;
}

function load(win) {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const sandbox = { module: { exports: {} }, window: win, console: win.console, TextEncoder, WeakSet, Date, Math, JSON, Promise, Object, Array };
  vm.runInNewContext(source, sandbox, { filename: 'draft-capture.js' });
  return sandbox.module.exports;
}

/** fetch double: script of responses; each call records its body. */
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = script.shift() ?? { status: 200 };
    if (next.throw) throw new Error(next.throw);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.text ?? '' };
  };
  fn.calls = calls;
  return fn;
}

function setup({ responses = [], config } = {}) {
  const win = fakeWindow();
  const lib = load(win);
  let clock = 1_000_000;
  const fetch = fakeFetch(responses);
  const cap = lib.createCapture({
    win, fetch, now: () => clock, autoStart: false,
    config: { draftId: 42, key: 'k-secret', origin: 'https://tunnel.example', captureId: 'cap-1', ...config }
  });
  const advance = (ms) => { clock += ms; };
  return { win, lib, cap, fetch, advance };
}

test('pure helpers: URL filter and SWID scrubbing', () => {
  const { lib } = setup();
  assert.equal(lib.isCapturedUrl(DRAFT_URL), true);
  assert.equal(lib.isCapturedUrl('wss://chat.espn.com/x'), false);
  assert.equal(lib.isCapturedUrl(undefined), false);
  assert.equal(lib.scrubSwid('SELECTED 3 4 12345 {A1B2C3D4-1111-2222-3333-444455556666}'), 'SELECTED 3 4 12345 {SWID}');
  assert.equal(lib.scrubSwid('SELECTED 3 4 12345 {a1b2c3d4-1111-2222-3333-444455556666}'), 'SELECTED 3 4 12345 {SWID}');
});

test('start sends a heartbeat carrying the baseline, then frames get sequential seq numbers', async () => {
  const { cap, fetch } = setup({ responses: [{ status: 200 }, { status: 200 }] });
  cap.start();
  await cap.flush();
  assert.equal(fetch.calls.length, 1);
  const first = fetch.calls[0];
  assert.equal(first.url, 'https://tunnel.example/api/drafts/42/capture');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.mode, 'cors');
  assert.equal(first.init.keepalive, true);
  assert.equal(first.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(first.body, { ingest_key: 'k-secret', capture_id: 'cap-1', frames: [], baseline: null, heartbeat: true });

  cap.enqueueFrame('in', DRAFT_URL, 'PING');
  cap.enqueueFrame('out', DRAFT_URL, 'PONG');
  cap.enqueueFrame('in', DRAFT_URL, 'PING');
  await cap.tick();
  assert.equal(fetch.calls.length, 2);
  const frames = fetch.calls[1].body.frames;
  assert.deepEqual(frames.map((f) => f.seq), [1, 2, 3]);
  assert.deepEqual(frames.map((f) => f.dir), ['in', 'out', 'in']);
  assert.equal(fetch.calls[1].body.heartbeat, false);
  assert.equal(cap.state.framesSent, 3);
});

test('WebSocket patches: late-attach getter, send, and reconnect constructor all capture; originals still run', () => {
  const { win, cap } = setup();
  const OrigWS = win.WebSocket;
  const existing = new OrigWS(DRAFT_URL);       // opened BEFORE the bookmarklet ran
  const other = new OrigWS('wss://chat.espn.com/x');
  cap.start();

  // Late attach: ESPN's handler reads event.data on the pre-existing socket.
  const ev = existing.receive('SELECTED 1 1 4242 {A1B2C3D4-1111-2222-3333-444455556666}');
  assert.equal(ev.data, 'SELECTED 1 1 4242 {A1B2C3D4-1111-2222-3333-444455556666}', 'original getter value unchanged');
  ev.data; ev.data; // repeated reads must not duplicate
  const otherEv = other.receive('hello');
  assert.equal(otherEv.data, 'hello');

  existing.send('JOIN 7');
  assert.deepEqual(existing.sent, ['JOIN 7'], 'original send ran');

  // Reconnect: a socket created after attach is captured even if nobody reads .data.
  assert.notEqual(win.WebSocket, OrigWS);
  assert.equal(win.WebSocket.OPEN, 1);
  const re = new win.WebSocket(DRAFT_URL);
  assert.ok(re instanceof OrigWS);
  assert.ok(re instanceof win.WebSocket, 'instanceof keeps working through the patched constructor');
  re.receive('INIT 99');
  assert.equal(cap.state.sockets, 1);

  // Urgent frames were batched immediately; the outbox holds heartbeat + frames.
  const all = cap.state.outbox.flatMap((b) => b.frames).concat(cap.state.pending);
  // JSON round-trip: arrays built inside the vm realm are not deepStrictEqual to host arrays.
  assert.deepEqual(JSON.parse(JSON.stringify(all.map((f) => [f.dir, f.data]))), [
    ['in', 'SELECTED 1 1 4242 {SWID}'],
    ['out', 'JOIN 7'],
    ['in', 'INIT 99']
  ]);
  assert.ok(all.every((f) => f.url.includes('fantasydraft.espn.com')));
});

test('running the script twice does not double-patch or double-capture', () => {
  const { win, lib, cap } = setup();
  cap.start();
  const patchedWS = win.WebSocket;
  const second = lib.createCapture({ win, fetch: fakeFetch([]), now: () => 1, autoStart: false, config: { draftId: 42, key: 'k', origin: 'https://t' } });
  second.start();
  assert.equal(win.WebSocket, patchedWS, 'constructor wrapped once');
  const ws = new win.WebSocket(DRAFT_URL);
  ws.receive('PING').data;
  ws.send('X');
  assert.equal(second.state.framesSeen, 2, 'newest instance receives frames');
  assert.equal(cap.state.framesSeen, 0, 'old instance is detached');
  assert.deepEqual(ws.sent, ['X']);
});

test('5xx / 429 / network errors re-queue at the front with 2,4,8,20s backoff; 4xx drops and flags fatal', async () => {
  const { cap, fetch, advance } = setup({ responses: [
    { status: 200 },          // initial heartbeat
    { status: 503 }, { status: 429 }, { throw: 'boom' }, { status: 502 }, { status: 500 },
    { status: 200 }, { status: 200 },
    { status: 403, text: '{"error":"ingest key expired"}' }
  ] });
  cap.start();
  await cap.flush();

  cap.enqueueFrame('in', DRAFT_URL, 'A');
  cap.buildBatches();
  cap.enqueueFrame('in', DRAFT_URL, 'B');
  cap.buildBatches();
  assert.equal(cap.state.outbox.length, 2);

  const expectBackoff = [2000, 4000, 8000, 20000, 20000];
  for (const ms of expectBackoff) {
    assert.equal(await cap.flush(), false);
    assert.equal(cap.state.outbox.length, 2, 'failed batch is back at the front');
    assert.equal(cap.state.outbox[0].frames[0].data, 'A');
    assert.equal(cap.state.blockedUntil - (cap.state.lastSendAt), ms);
    assert.equal(await cap.flush(), false, 'blocked during backoff, no request made');
    advance(ms);
  }
  assert.equal(fetch.calls.length, 6);

  assert.equal(await cap.flush(), true);
  assert.equal(cap.state.backoffIndex, -1, 'backoff resets on success');
  assert.equal(await cap.flush(), true);
  assert.equal(cap.state.outbox.length, 0);
  assert.deepEqual(fetch.calls.slice(-2).map((c) => c.body.frames[0].data), ['A', 'B'], 'order preserved');

  cap.enqueueFrame('in', DRAFT_URL, 'C');
  cap.buildBatches();
  assert.equal(await cap.flush(), false);
  assert.equal(cap.state.fatal, true);
  assert.equal(cap.state.outbox.length, 0, '4xx batch dropped');
  assert.match(cap.state.lastError.message, /ingest key expired/);
  cap.enqueueFrame('in', DRAFT_URL, 'D');
  cap.buildBatches();
  assert.equal(await cap.flush(), false, 'fatal: nothing more is sent');
  assert.equal(fetch.calls.length, 9);
});

test('batches stay under 48 KB; oversized single frames are truncated', () => {
  const { cap } = setup();
  cap.start();
  cap.state.outbox.length = 0;
  for (let i = 0; i < 40; i++) cap.enqueueFrame('in', DRAFT_URL, 'F'.repeat(3000) + i);
  cap.buildBatches();
  assert.ok(cap.state.outbox.length >= 3);
  for (const b of cap.state.outbox) assert.ok(Buffer.byteLength(JSON.stringify(b)) < 48 * 1024);
  const seqs = cap.state.outbox.flatMap((b) => b.frames.map((f) => f.seq));
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq continuous across batches');

  cap.state.outbox.length = 0;
  for (let i = 0; i < 450; i++) cap.enqueueFrame('in', DRAFT_URL, 'PING');
  cap.buildBatches();
  assert.deepEqual(JSON.parse(JSON.stringify(cap.state.outbox.map((b) => b.frames.length))), [200, 200, 50], 'server caps batches at 200 frames');

  cap.state.outbox.length = 0;
  cap.enqueueFrame('in', DRAFT_URL, 'X'.repeat(100_000));
  cap.buildBatches();
  assert.equal(cap.state.outbox.length, 1);
  assert.match(cap.state.outbox[0].frames[0].data, /\[GHQ truncated \d+ chars\]$/);
  assert.ok(Buffer.byteLength(JSON.stringify(cap.state.outbox[0])) < 48 * 1024);
});

test('heartbeat every 10s of silence; binary frames and non-draft sockets are ignored', async () => {
  const { cap, fetch, advance } = setup({ responses: [{ status: 200 }, { status: 200 }, { status: 200 }] });
  cap.start();
  await cap.flush();
  advance(2000);
  await cap.tick();
  assert.equal(fetch.calls.length, 1, 'no heartbeat yet');
  advance(8000);
  await cap.tick();
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].body.heartbeat, true);
  assert.equal(cap.enqueueFrame('in', DRAFT_URL, new ArrayBuffer(4)), true);
  assert.match(cap.state.pending[0].data, /^\[GHQ binary 4 bytes\]$/);
});

test('DOM baseline: current-pick text, pick rows, and resync on a jump', async () => {
  const win = fakeWindow();
  const lib = load(win);
  let picks = 12;
  let rows = null;
  const doc = {
    body: null,
    querySelector: (sel) => sel === '[data-testid="current-pick"]' && picks != null ? { textContent: `On the Clock: Pick ${picks + 1}` } : null,
    querySelectorAll: (sel) => (sel === '[data-pick-number]' && rows ? rows : [])
  };
  const fetch = fakeFetch([{ status: 200 }, { status: 200 }, { status: 200 }]);
  let clock = 0;
  const cap = lib.createCapture({ win, doc, fetch, now: () => clock, autoStart: false, config: { draftId: 1, key: 'k', origin: 'https://t' } });
  cap.start();
  await cap.flush();
  assert.deepEqual(fetch.calls[0].body.baseline, { picks_on_board: 12 });

  picks = 13; // one more pick: no resend
  cap.enqueueFrame('in', DRAFT_URL, 'PING');
  await cap.tick();
  assert.equal(fetch.calls[1].body.baseline, null);

  picks = 16; // jumped by 3: resync hint
  cap.enqueueFrame('in', DRAFT_URL, 'PING');
  await cap.tick();
  assert.deepEqual(fetch.calls[2].body.baseline, { picks_on_board: 16 });

  // Row fallback when no clock element is present.
  picks = null;
  const row = (text, player) => ({ textContent: text, querySelector: () => (player ? {} : null) });
  rows = [row('1 Ja\'Marr Chase', true), row('2 Bijan Robinson', true), row('3', false)];
  assert.equal(cap.readBaseline(), 2);
  rows = null;
  assert.equal(cap.readBaseline(), null);
});
