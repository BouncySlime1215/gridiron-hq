'use strict';
/**
 * Gridiron HQ draft capture — content script.
 *
 * Same tap as the bookmarklet (client/public/draft-capture.js): patch
 * WebSocket/MessageEvent PASSIVELY so the draft room's own socket is read,
 * never opened twice, never reloaded. The only difference from the
 * bookmarklet is delivery — frames go to the background service worker via
 * chrome.runtime.sendMessage instead of a direct fetch to a tunnel URL, so
 * this file carries no key and no origin: the extension already knows which
 * draft is live and how to reach this Mac's own Gridiron HQ.
 *
 * Runs on every fantasy.espn.com/football/* page at document_start (see
 * manifest.json) — no click, no bookmarklet, no per-draft setup.
 */
(function () {
  var TAG = 'GHQ';
  var HOST_MATCH = 'fantasydraft.espn.com';
  var BATCH_MS = 2000;
  var HEARTBEAT_MS = 10000;
  var MAX_FRAMES_PER_BATCH = 200;
  var URGENT = /^(SELECTED|INIT|UNDONE)\b/;
  var SWID = /\{[0-9A-Fa-f-]{36}\}/g;

  function log() { try { console.log.apply(console, [TAG + ':'].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ } }
  function isCapturedUrl(url) { return typeof url === 'string' && url.indexOf(HOST_MATCH) !== -1; }
  function scrubSwid(t) { return typeof t === 'string' ? t.replace(SWID, '{SWID}') : t; }
  function toText(data) {
    if (typeof data === 'string') return data;
    if (data == null) return null;
    try {
      if (data instanceof ArrayBuffer) return '[GHQ binary ' + data.byteLength + ' bytes]';
      if (typeof Blob !== 'undefined' && data instanceof Blob) return '[GHQ blob ' + data.size + ' bytes]';
    } catch (e) { /* ignore */ }
    return null;
  }

  /** How many picks the ESPN DOM already shows as made — the resync baseline. */
  function readBaseline() {
    try {
      var clock = document.querySelector('[data-testid="current-pick"]');
      if (clock) { var m = /pick\s*#?\s*(\d+)/i.exec(clock.textContent || ''); if (m) return Math.max(0, Number(m[1]) - 1); }
      var rows = document.querySelectorAll('[data-pick-number]');
      if (rows.length) {
        var filled = 0;
        for (var i = 0; i < rows.length; i++) {
          var text = (rows[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (rows[i].querySelector('[data-player-id], .player-name, .playerinfo__playername') || /[A-Za-z]{2,}\s+[A-Za-z'.-]{2,}/.test(text.replace(/^\d+\s*/, ''))) filled++;
        }
        return filled;
      }
      var hist = document.querySelectorAll('.pick-history-tables tr, .pick-history-tables li, .pick-history-tables [class*="pick"]');
      if (hist.length) return hist.length;
    } catch (e) { log('baseline read failed', e && e.message); }
    return null;
  }

  var state = {
    captureId: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    seq: 0, pending: [], outbox: [], inflight: false, lastOkAt: 0, framesSeen: 0,
    lastBaseline: null, baselineDirty: true, lastError: null, fatal: false, dismissed: false, draftName: null
  };

  function enqueueFrame(dir, url, data) {
    var text = toText(data);
    if (text == null) return;
    text = scrubSwid(text);
    state.framesSeen++;
    state.pending.push({ seq: ++state.seq, ts: Date.now(), dir: dir, url: String(url || ''), data: text });
    if (URGENT.test(text)) buildBatches();
  }

  function currentBaseline() {
    var picks = readBaseline();
    if (picks == null) return null;
    if (state.lastBaseline != null && picks - state.lastBaseline > 1) state.baselineDirty = true;
    state.lastBaseline = picks;
    return picks;
  }

  function makeBatch(frames, heartbeat) {
    var picks = currentBaseline();
    var includeBaseline = state.baselineDirty && picks != null;
    if (includeBaseline) state.baselineDirty = false;
    return { capture_id: state.captureId, frames: frames, baseline: includeBaseline ? { picks_on_board: picks } : null, heartbeat: !!heartbeat };
  }

  function buildBatches() {
    while (state.pending.length) {
      var frames = state.pending.splice(0, MAX_FRAMES_PER_BATCH);
      state.outbox.push(makeBatch(frames, false));
    }
  }

  function sendBatch(batch) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'ghq-batch', batch: batch }, function (res) {
          if (chrome.runtime.lastError) { resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message }); return; }
          resolve(res || { ok: false, status: 0, error: 'no response from Gridiron HQ extension' });
        });
      } catch (e) { resolve({ ok: false, status: 0, error: e && e.message }); }
    });
  }

  function flush() {
    if (state.inflight || state.fatal || !state.outbox.length) return;
    var batch = state.outbox.shift();
    state.inflight = true;
    sendBatch(batch).then(function (res) {
      state.inflight = false;
      if (res.ok) { state.lastOkAt = Date.now(); state.lastError = null; if (res.draft) state.draftName = res.draft.name; }
      else {
        state.lastError = { status: res.status, message: res.error || ('rejected (' + res.status + ')') };
        // "no live draft" isn't fatal — a draft can start at any moment, keep listening quietly.
        if (res.status >= 400 && res.status < 500 && res.status !== 0 && res.error !== 'no live draft found in Gridiron HQ right now') state.fatal = true;
        else state.outbox.unshift(batch); // transient: retry this same batch
      }
      renderPill();
    });
  }

  function tick() {
    buildBatches();
    var idle = Date.now() - Math.max(state.lastOkAt, 0) >= HEARTBEAT_MS;
    if (idle && !state.outbox.length && !state.inflight) state.outbox.push(makeBatch([], true));
    flush();
    renderPill();
  }

  // -------------------------------------------------------------- WS patches
  // Identical technique to the bookmarklet (client/public/draft-capture.js):
  // late-attach via the MessageEvent.data getter, patch send() for outgoing
  // frames, and wrap the constructor so a reconnect is captured from its
  // first frame. Every hook falls through to the original — ESPN's own
  // handlers must never see a difference.

  function isDraftSocket(target) {
    try { return !!target && typeof target.url === 'string' && isCapturedUrl(target.url); } catch (e) { return false; }
  }

  function installPatches() {
    if (window.__GHQ_CAPTURE__ && window.__GHQ_CAPTURE__.patched) return;
    var registry = window.__GHQ_CAPTURE__ = { patched: true };
    try { registry.seen = new WeakSet(); } catch (e) { registry.seen = null; }

    function teeEvent(ev) {
      try { if (registry.seen) { if (registry.seen.has(ev)) return; registry.seen.add(ev); } } catch (e) { /* ignore */ }
      if (isDraftSocket(ev.target)) enqueueFrame('in', ev.target.url, registry.origData ? registry.origData.call(ev) : ev.data);
    }

    try {
      var desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
      if (desc && desc.get && desc.configurable) {
        registry.origData = desc.get;
        Object.defineProperty(MessageEvent.prototype, 'data', {
          configurable: true, enumerable: desc.enumerable,
          get: function () {
            var value = registry.origData.call(this);
            try {
              if (isDraftSocket(this.target)) {
                var seen = registry.seen ? registry.seen.has(this) : this.__ghqSeen;
                if (!seen) { if (registry.seen) registry.seen.add(this); else this.__ghqSeen = true; enqueueFrame('in', this.target.url, value); }
              }
            } catch (e) { /* never break ESPN */ }
            return value;
          }
        });
      } else {
        log('MessageEvent.data not patchable here — only sockets opened after this point are captured');
      }
    } catch (e) { log('MessageEvent patch failed', e && e.message); }

    try {
      var origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try { if (isDraftSocket(this)) enqueueFrame('out', this.url, data); } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
      };
    } catch (e) { log('send patch failed', e && e.message); }

    try {
      var Orig = window.WebSocket;
      var Patched = function WebSocket(url, protocols) {
        var ws = arguments.length > 1 ? new Orig(url, protocols) : new Orig(url);
        try { if (isCapturedUrl(String(url))) { state.baselineDirty = true; ws.addEventListener('message', teeEvent); } } catch (e) { /* ignore */ }
        return ws;
      };
      Patched.prototype = Orig.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { try { Object.defineProperty(Patched, k, { value: Orig[k], enumerable: true }); } catch (e) { Patched[k] = Orig[k]; } });
      for (var k in Orig) { if (!(k in Patched)) { try { Patched[k] = Orig[k]; } catch (e2) { /* ignore */ } } }
      window.WebSocket = Patched;
    } catch (e) { log('constructor patch failed', e && e.message); }
  }

  // ------------------------------------------------------------------- pill

  function relTime(ts) { if (!ts) return 'never'; var s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago'; }

  function renderPill() {
    if (!document.body || state.dismissed) return;
    try {
      var el = document.getElementById('ghq-capture-pill');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ghq-capture-pill';
        el.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;' +
          'color:#111;background:#e6f4ea;border:1px solid #9bd0a8;border-radius:999px;padding:6px 10px 6px 12px;box-shadow:0 2px 8px rgba(0,0,0,.18);' +
          'display:flex;align-items:center;gap:8px;max-width:70vw;pointer-events:auto;');
        var text = document.createElement('span'); text.id = 'ghq-capture-pill-text';
        var close = document.createElement('button');
        close.type = 'button'; close.textContent = '×'; close.title = 'Hide (capture keeps running)';
        close.setAttribute('style', 'border:0;background:transparent;font-size:14px;cursor:pointer;color:#555;padding:0 2px;line-height:1;');
        close.onclick = function () { state.dismissed = true; try { el.parentNode.removeChild(el); } catch (e) { /* ignore */ } };
        el.appendChild(text); el.appendChild(close);
        document.body.appendChild(el);
      }
      var waiting = state.lastError && state.lastError.message === 'no live draft found in Gridiron HQ right now';
      el.style.background = state.fatal ? '#fde8e8' : waiting ? '#eef1f5' : state.lastError ? '#fff4d6' : '#e6f4ea';
      el.style.borderColor = state.fatal ? '#e59a9a' : waiting ? '#c7ccd4' : state.lastError ? '#e6c56d' : '#9bd0a8';
      var status = state.fatal ? 'stopped · ' + (state.lastError.message || 'rejected')
        : waiting ? 'waiting for a live draft in Gridiron HQ'
        : state.lastError ? 'retrying (' + (state.lastError.status || 'net') + ')'
        : 'listening' + (state.draftName ? ' · ' + state.draftName : '');
      var t = document.getElementById('ghq-capture-pill-text');
      if (t) t.textContent = 'Gridiron HQ · ' + status + ' · ' + state.framesSeen + ' frames · last ' + relTime(state.lastOkAt);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------- boot

  installPatches();
  state.lastBaseline = readBaseline();
  var timer = setInterval(tick, BATCH_MS);
  tick();
  log('attached, watching for a fantasydraft.espn.com socket');

  // A SPA route change (entering the draft room without a full page load)
  // doesn't create a new content-script instance, but the DOM baseline can
  // go stale; re-read it whenever the URL changes.
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) { lastHref = location.href; state.baselineDirty = true; }
  }, 1500);
})();
