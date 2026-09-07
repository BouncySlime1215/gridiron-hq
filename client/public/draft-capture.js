/*
 * Gridiron HQ - ESPN draft-room WebSocket capture.
 *
 * Loaded into the fantasy.espn.com draft tab by a bookmarklet (see
 * server/routes/draft-capture.js and docs/DRAFT_CAPTURE.md). It taps the draft
 * room's existing WebSocket PASSIVELY - no extra requests to ESPN, no second
 * socket, no reload - and forwards raw frames to our server over the tunnel.
 *
 * Plain ES5 on purpose: no build step, runs as-is in any browser. Every hook is
 * wrapped so a page quirk can never break ESPN's own handlers: the original
 * getter / send / constructor always run.
 *
 * The same file is loaded by test/draft-capture-client.test.js inside a vm
 * sandbox (it exposes createCapture through module.exports there).
 */
(function (root) {
  'use strict';

  var TAG = 'GHQ';
  var HOST_MATCH = 'fantasydraft.espn.com';
  var BATCH_MS = 2000;
  var HEARTBEAT_MS = 10000;
  var MAX_BODY_BYTES = 48 * 1024;
  var MAX_FRAME_BYTES = 44 * 1024;
  var MAX_FRAMES_PER_BATCH = 200; // mirrors server/services/draft-ingest.js; more is a 400
  var BACKOFF_STEPS = [2000, 4000, 8000, 20000];
  var URGENT = /^(SELECTED|INIT|UNDONE)\b/;
  var SWID = /\{[0-9A-Fa-f-]{36}\}/g;

  function log() {
    try {
      var c = root.console;
      if (c && c.log) c.log.apply(c, [TAG + ':'].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* ignore */ }
  }

  function byteLength(str) {
    try { return new root.TextEncoder().encode(str).length; } catch (e) { return str.length * 2; }
  }

  function isCapturedUrl(url) {
    return typeof url === 'string' && url.indexOf(HOST_MATCH) !== -1;
  }

  function scrubSwid(text) {
    return typeof text === 'string' ? text.replace(SWID, '{SWID}') : text;
  }

  /** Coerce a socket payload to text; binary frames are noted, not shipped. */
  function toText(data) {
    if (typeof data === 'string') return data;
    if (data == null) return null;
    try {
      if (root.ArrayBuffer && data instanceof root.ArrayBuffer) return '[GHQ binary ' + data.byteLength + ' bytes]';
      if (root.Blob && data instanceof root.Blob) return '[GHQ blob ' + data.size + ' bytes]';
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Read how many picks the ESPN DOM shows as already made. Null if unknown. */
  function readBaseline(doc) {
    if (!doc || !doc.querySelectorAll) return null;
    try {
      var clock = doc.querySelector('[data-testid="current-pick"]');
      if (clock) {
        var m = /pick\s*#?\s*(\d+)/i.exec(clock.textContent || '');
        if (m) return Math.max(0, Number(m[1]) - 1);
      }
      var rowsWithPlayer = doc.querySelectorAll('[data-pick-number]');
      if (rowsWithPlayer.length) {
        var filled = 0;
        for (var i = 0; i < rowsWithPlayer.length; i++) {
          var row = rowsWithPlayer[i];
          var text = (row.textContent || '').replace(/\s+/g, ' ').trim();
          // A completed row names a player; an empty slot is just the number / team.
          if (row.querySelector('[data-player-id], .player-name, .playerinfo__playername') ||
              /[A-Za-z]{2,}\s+[A-Za-z'.-]{2,}/.test(text.replace(/^\d+\s*/, ''))) filled++;
        }
        return filled;
      }
      var history = doc.querySelectorAll('.pick-history-tables tr, .pick-history-tables li, .pick-history-tables [class*="pick"]');
      if (history.length) return history.length;
    } catch (e) { log('baseline read failed', e && e.message); }
    return null;
  }

  /**
   * The testable core. `env` supplies everything with a side effect:
   *   { win, doc, fetch, now, setTimeout, clearTimeout, config:{draftId,key,origin}, autoStart }
   */
  function createCapture(env) {
    var win = env.win || root;
    var doc = env.doc || (win && win.document) || null;
    var now = env.now || function () { return Date.now(); };
    var fetchImpl = env.fetch || (win && win.fetch);
    var setT = env.setTimeout || function (fn, ms) { return win.setTimeout(fn, ms); };
    var clearT = env.clearTimeout || function (id) { return win.clearTimeout(id); };
    var config = env.config || {};

    var state = {
      captureId: config.captureId || (String(now()) + '-' + Math.random().toString(36).slice(2, 8)),
      seq: 0,
      pending: [],        // frames awaiting batching
      outbox: [],         // ready batches; index 0 is next to send
      inflight: false,
      backoffIndex: -1,
      blockedUntil: 0,
      lastSendAt: 0,
      lastOkAt: 0,
      framesSent: 0,
      framesSeen: 0,
      lastError: null,    // { status, message } for the pill
      fatal: false,       // a 4xx: key rejected etc.
      lastBaseline: null,
      baselineDirty: true,
      sockets: 0,
      timer: null,
      dismissed: false,
      stopped: false
    };

    function endpoint() {
      return String(config.origin || '').replace(/\/+$/, '') + '/api/drafts/' + encodeURIComponent(config.draftId) + '/capture';
    }

    function currentBaseline() {
      var picks = readBaseline(doc);
      if (picks == null) return null;
      if (state.lastBaseline != null && picks - state.lastBaseline > 1) {
        state.baselineDirty = true;
        log('DOM pick count jumped', state.lastBaseline, '->', picks, '(resync hint)');
      }
      state.lastBaseline = picks;
      return picks;
    }

    function enqueueFrame(dir, url, data) {
      var text = toText(data);
      if (text == null) return false;
      text = scrubSwid(text); // never ship the user's SWID in either direction
      if (byteLength(text) > MAX_FRAME_BYTES) {
        var keep = text.slice(0, MAX_FRAME_BYTES / 2);
        text = keep + ' [GHQ truncated ' + (text.length - keep.length) + ' chars]';
        log('frame truncated to fit batch budget');
      }
      state.framesSeen++;
      state.pending.push({ seq: ++state.seq, ts: now(), dir: dir, url: String(url || ''), data: text });
      if (URGENT.test(text)) buildBatches();
      return true;
    }

    function makeBatch(frames, heartbeat) {
      var picks = currentBaseline();
      var includeBaseline = state.baselineDirty && picks != null;
      var body = {
        ingest_key: config.key,
        capture_id: state.captureId,
        frames: frames,
        baseline: includeBaseline ? { picks_on_board: picks } : null,
        heartbeat: !!heartbeat
      };
      if (includeBaseline) state.baselineDirty = false;
      return body;
    }

    /** Move pending frames into <48 KB batches on the outbox. */
    function buildBatches() {
      while (state.pending.length) {
        var frames = [];
        var size = 256; // envelope + key headroom
        while (state.pending.length) {
          var f = state.pending[0];
          var fsize = byteLength(JSON.stringify(f)) + 1;
          if (frames.length && (size + fsize > MAX_BODY_BYTES || frames.length >= MAX_FRAMES_PER_BATCH)) break;
          frames.push(state.pending.shift());
          size += fsize;
        }
        state.outbox.push(makeBatch(frames, false));
      }
    }

    function backoffMs() {
      return BACKOFF_STEPS[Math.min(state.backoffIndex, BACKOFF_STEPS.length - 1)];
    }

    /** Send the head of the outbox. Resolves when that attempt settles. */
    function flush() {
      if (state.inflight || state.fatal || !state.outbox.length) return Promise.resolve(false);
      if (now() < state.blockedUntil) return Promise.resolve(false);
      var batch = state.outbox.shift();
      state.inflight = true;
      state.lastSendAt = now();
      var done = function (ok, status, message) {
        state.inflight = false;
        if (ok) {
          state.backoffIndex = -1;
          state.blockedUntil = 0;
          state.lastOkAt = now();
          state.lastError = null;
          state.framesSent += batch.frames.length;
          return true;
        }
        if (status >= 400 && status < 500 && status !== 429) {
          state.fatal = true;
          state.lastError = { status: status, message: message || ('server rejected the batch (' + status + ')') };
          log('dropping batch, HTTP', status, message);
          return false;
        }
        // 5xx / 429 / network: back to the FRONT, then back off.
        state.outbox.unshift(batch);
        state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_STEPS.length - 1);
        state.blockedUntil = now() + backoffMs();
        state.lastError = { status: status || 0, message: message || 'network error' };
        log('retrying in', backoffMs(), 'ms after', status || message);
        return false;
      };
      // Dry run (?dry=1 on the script src): capture and log everything, post
      // nothing — for verifying the tap in an ESPN mock draft without a
      // single frame reaching a real draft board.
      if (config.dry) {
        log('DRY batch', batch.frames.length, 'frames', batch.frames.map(function (f) { return f.dir + ':' + String(f.data).slice(0, 40); }));
        return Promise.resolve(done(true, 200));
      }
      var p;
      try {
        p = fetchImpl(endpoint(), {
          method: 'POST',
          mode: 'cors',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch)
        });
      } catch (e) {
        return Promise.resolve(done(false, 0, e && e.message));
      }
      return Promise.resolve(p).then(function (res) {
        if (res && res.ok) return done(true, res.status);
        var msg = '';
        try {
          return Promise.resolve(res.text ? res.text() : '').then(function (t) {
            try { msg = JSON.parse(t).error || t; } catch (e2) { msg = t; }
            return done(false, res ? res.status : 0, String(msg).slice(0, 200));
          }, function () { return done(false, res ? res.status : 0, ''); });
        } catch (e) { return done(false, res ? res.status : 0, ''); }
      }, function (err) {
        return done(false, 0, err && err.message);
      });
    }

    /** One scheduler step: batch pending frames, add a heartbeat if due, send. */
    function tick() {
      if (state.stopped) return Promise.resolve(false);
      buildBatches();
      var idle = now() - Math.max(state.lastSendAt, 0) >= HEARTBEAT_MS;
      if (idle && !state.outbox.length && !state.inflight) state.outbox.push(makeBatch([], true));
      var p = flush();
      renderPill();
      return p;
    }

    function schedule() {
      if (state.stopped) return;
      state.timer = setT(function () {
        Promise.resolve(tick()).then(function () {
          // A successful send may have left more batches queued; drain sooner.
          schedule();
        }, schedule);
      }, state.outbox.length && !state.inflight && now() >= state.blockedUntil ? 50 : BATCH_MS);
    }

    // ------------------------------------------------------------ WS patches

    function isDraftSocket(target) {
      try {
        return !!target && typeof target.url === 'string' && isCapturedUrl(target.url) &&
          (!win.WebSocket || target instanceof win.WebSocket || typeof target.send === 'function');
      } catch (e) { return false; }
    }

    function installPatches() {
      var registry = win.__GHQ_CAPTURE__;
      if (registry && registry.patched) {
        registry.onFrame = onFrame; // re-point the hooks at the newest instance
        return false;
      }
      registry = win.__GHQ_CAPTURE__ = { patched: true, onFrame: onFrame, seen: null };
      try { registry.seen = new win.WeakSet(); } catch (e) { registry.seen = null; }

      function emit(dir, target, data) {
        try { registry.onFrame(dir, target && target.url, data); } catch (e) { log('hook error', e && e.message); }
      }
      function teeEvent(ev) {
        try {
          if (registry.seen) { if (registry.seen.has(ev)) return; registry.seen.add(ev); }
          else if (ev.__ghqSeen) return; else { try { ev.__ghqSeen = true; } catch (e) { /* ignore */ } }
        } catch (e) { /* ignore */ }
        if (isDraftSocket(ev.target)) emit('in', ev.target, registry.origData.call(ev));
      }

      // (1) Late attach: the socket already exists, so read frames as ESPN reads them.
      try {
        var ME = win.MessageEvent;
        var desc = ME && Object.getOwnPropertyDescriptor(ME.prototype, 'data');
        if (desc && desc.get && desc.configurable) {
          registry.origData = desc.get;
          Object.defineProperty(ME.prototype, 'data', {
            configurable: true,
            enumerable: desc.enumerable,
            get: function () {
              var value = registry.origData.call(this);
              try {
                if (isDraftSocket(this.target)) {
                  if (registry.seen ? !registry.seen.has(this) : !this.__ghqSeen) {
                    if (registry.seen) registry.seen.add(this); else { try { this.__ghqSeen = true; } catch (e) { /* ignore */ } }
                    emit('in', this.target, value);
                  }
                }
              } catch (e) { /* never break ESPN */ }
              return value;
            }
          });
        } else {
          log('MessageEvent.data is not patchable here; only sockets opened after attach are captured');
          registry.origData = function () { return undefined; };
        }
      } catch (e) { log('MessageEvent patch failed', e && e.message); }

      // (2) Outgoing text.
      try {
        var WS = win.WebSocket;
        if (WS && WS.prototype && typeof WS.prototype.send === 'function') {
          var origSend = WS.prototype.send;
          registry.origSend = origSend;
          WS.prototype.send = function (data) {
            try { if (isDraftSocket(this)) emit('out', this, data); } catch (e) { /* ignore */ }
            return origSend.apply(this, arguments);
          };
        }
      } catch (e) { log('send patch failed', e && e.message); }

      // (3) Reconnects: wrap the constructor so a NEW draft socket is captured from
      // its first frame even if ESPN's code never reads event.data.
      try {
        var Orig = win.WebSocket;
        if (typeof Orig === 'function') {
          registry.origWebSocket = Orig;
          var Patched = function WebSocket(url, protocols) {
            var ws = arguments.length > 1 ? new Orig(url, protocols) : new Orig(url);
            try {
              if (isCapturedUrl(String(url))) {
                registry.onSocket && registry.onSocket(ws);
                ws.addEventListener('message', teeEvent);
              }
            } catch (e) { /* ignore */ }
            return ws;
          };
          Patched.prototype = Orig.prototype;
          var statics = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
          for (var i = 0; i < statics.length; i++) {
            try { Object.defineProperty(Patched, statics[i], { value: Orig[statics[i]], enumerable: true }); } catch (e) { Patched[statics[i]] = Orig[statics[i]]; }
          }
          for (var k in Orig) { if (!(k in Patched)) { try { Patched[k] = Orig[k]; } catch (e2) { /* ignore */ } } }
          win.WebSocket = Patched;
        }
      } catch (e) { log('constructor patch failed', e && e.message); }
      return true;
    }

    function onFrame(dir, url, data) {
      if (state.stopped) return;
      enqueueFrame(dir, url, data);
    }

    function onSocket() {
      state.sockets++;
      state.baselineDirty = true; // reconnect => INIT follows; hint the server
      log('new draft socket observed (#' + state.sockets + ')');
    }

    // ----------------------------------------------------------------- pill

    function relTime(ts) {
      if (!ts) return 'never';
      var s = Math.max(0, Math.round((now() - ts) / 1000));
      return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago';
    }

    function renderPill() {
      if (!doc || !doc.body || state.dismissed) return;
      try {
        var el = doc.getElementById('ghq-capture-pill');
        if (!el) {
          el = doc.createElement('div');
          el.id = 'ghq-capture-pill';
          el.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;' +
            'color:#111;background:#e6f4ea;border:1px solid #9bd0a8;border-radius:999px;padding:6px 10px 6px 12px;box-shadow:0 2px 8px rgba(0,0,0,.18);' +
            'display:flex;align-items:center;gap:8px;max-width:70vw;pointer-events:auto;');
          var text = doc.createElement('span');
          text.id = 'ghq-capture-pill-text';
          var close = doc.createElement('button');
          close.type = 'button';
          close.textContent = '×';
          close.title = 'Hide (capture keeps running)';
          close.setAttribute('style', 'border:0;background:transparent;font-size:14px;cursor:pointer;color:#555;padding:0 2px;line-height:1;');
          close.onclick = function () { state.dismissed = true; try { el.parentNode.removeChild(el); } catch (e) { /* ignore */ } };
          el.appendChild(text);
          el.appendChild(close);
          doc.body.appendChild(el);
        }
        var bad = state.fatal || (state.lastError && state.backoffIndex >= 1);
        el.style.background = state.fatal ? '#fde8e8' : bad ? '#fff4d6' : '#e6f4ea';
        el.style.borderColor = state.fatal ? '#e59a9a' : bad ? '#e6c56d' : '#9bd0a8';
        var status = state.fatal ? 'STOPPED · ' + (state.lastError.message || 'rejected') :
          state.lastError ? 'retrying (' + (state.lastError.status || 'net') + ')' : 'listening';
        var t = doc.getElementById('ghq-capture-pill-text');
        if (t) t.textContent = 'Gridiron HQ · ' + status + ' · ' + state.framesSeen + ' frames · last ' + relTime(state.lastOkAt) +
          (state.outbox.length ? ' · ' + state.outbox.length + ' queued' : '');
      } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------- boot

    function start() {
      var fresh = installPatches();
      try { win.__GHQ_CAPTURE__.onSocket = onSocket; } catch (e) { /* ignore */ }
      state.lastBaseline = readBaseline(doc);
      state.baselineDirty = true;
      log(fresh ? 'attached' : 're-attached (already patched)', 'draft', config.draftId, '->', endpoint(),
        'baseline picks_on_board =', state.lastBaseline);
      // First batch immediately: a heartbeat carrying the DOM baseline.
      state.outbox.push(makeBatch([], true));
      renderPill();
      if (env.autoStart !== false) {
        flush().then(schedule, schedule);
      }
      return api;
    }

    function stop() {
      state.stopped = true;
      if (state.timer != null) { try { clearT(state.timer); } catch (e) { /* ignore */ } }
    }

    var api = {
      start: start, stop: stop, tick: tick, flush: flush, buildBatches: buildBatches,
      enqueueFrame: enqueueFrame, readBaseline: function () { return readBaseline(doc); },
      renderPill: renderPill, state: state, endpoint: endpoint
    };
    return api;
  }

  var exported = { createCapture: createCapture, scrubSwid: scrubSwid, isCapturedUrl: isCapturedUrl, readBaseline: readBaseline };

  // Node / vm test harness.
  if (typeof module === 'object' && module && module.exports) { module.exports = exported; return; }
  if (!root || !root.document) return;

  // Browser: read our own config from the script src query string.
  try {
    var script = root.document.currentScript;
    var src = script && script.src;
    if (!src) {
      var all = root.document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) { if (/draft-capture\.js/.test(all[i].src || '')) { src = all[i].src; break; } }
    }
    var q = {};
    var qs = String(src || '').split('?')[1] || '';
    qs.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv[0]) q[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    });
    var origin = q.origin || (src ? src.replace(/\/draft-capture\.js.*$/, '') : '');
    if (!q.draft || !q.key || !origin) {
      log('missing draft / key / origin in script src; not attaching', src);
    } else if (root.__GHQ_CAPTURE_INSTANCE__ && root.__GHQ_CAPTURE_INSTANCE__.state && !root.__GHQ_CAPTURE_INSTANCE__.state.stopped &&
               root.__GHQ_CAPTURE_INSTANCE__.config && root.__GHQ_CAPTURE_INSTANCE__.config.draftId === q.draft) {
      log('already running for draft', q.draft, '- not attaching twice');
      root.__GHQ_CAPTURE_INSTANCE__.state.dismissed = false;
      root.__GHQ_CAPTURE_INSTANCE__.renderPill();
    } else {
      if (root.__GHQ_CAPTURE_INSTANCE__) { try { root.__GHQ_CAPTURE_INSTANCE__.stop(); } catch (e) { /* ignore */ } }
      var cfg = { draftId: q.draft, key: q.key, origin: origin, dry: q.dry === '1' || q.dry === 'true' };
      var instance = createCapture({ win: root, config: cfg });
      instance.config = cfg;
      root.__GHQ_CAPTURE_INSTANCE__ = instance;
      instance.start();
    }
  } catch (e) { log('boot failed', e && e.message); }
})(typeof window !== 'undefined' ? window : this);
