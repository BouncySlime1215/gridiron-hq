'use strict';
/**
 * Gridiron HQ draft capture — MAIN-world tap.
 *
 * Why this file exists (2026-09-07, found live, mid-draft): a Chrome content
 * script runs in an ISOLATED world. It shares the page's DOM, but not its
 * JavaScript globals — so `window.WebSocket = Patched` inside content.js only
 * replaced the extension's own copy of WebSocket. ESPN's code kept using the
 * untouched original, and nothing was ever intercepted, while heartbeats kept
 * flowing because those are the extension's own code. The pill sat at
 * "listening · 0 frames" through an entire real draft.
 *
 * The bookmarklet never had this problem: it runs in the page's world. This
 * file is that same tap, declared with `"world": "MAIN"` in manifest.json so
 * it runs where ESPN's socket actually lives. It has no chrome.* APIs there,
 * so it relays every frame to content.js (isolated world, which does have
 * them) with window.postMessage. content.js only trusts messages from its
 * own window that carry the marker below.
 */
(function () {
  if (window.__GHQ_MAIN_TAP__) return;
  window.__GHQ_MAIN_TAP__ = true;

  var HOST_MATCH = 'fantasydraft.espn.com';
  var MARK = '__ghq_frame__';

  function isCapturedUrl(url) { return typeof url === 'string' && url.indexOf(HOST_MATCH) !== -1; }
  function isDraftSocket(target) {
    try { return !!target && typeof target.url === 'string' && isCapturedUrl(target.url); } catch (e) { return false; }
  }
  function toText(data) {
    if (typeof data === 'string') return data;
    if (data == null) return null;
    try {
      if (data instanceof ArrayBuffer) return '[GHQ binary ' + data.byteLength + ' bytes]';
      if (typeof Blob !== 'undefined' && data instanceof Blob) return '[GHQ blob ' + data.size + ' bytes]';
    } catch (e) { /* ignore */ }
    return null;
  }
  function relay(dir, url, data) {
    var text = toText(data);
    if (text == null) return;
    try { window.postMessage({ mark: MARK, dir: dir, url: String(url || ''), data: text }, '*'); } catch (e) { /* never break ESPN */ }
  }

  var seen; try { seen = new WeakSet(); } catch (e) { seen = null; }
  function teeEvent(ev) {
    try { if (seen) { if (seen.has(ev)) return; seen.add(ev); } } catch (e) { /* ignore */ }
    if (isDraftSocket(ev.target)) relay('in', ev.target.url, origData ? origData.call(ev) : ev.data);
  }

  // Late attach: a socket opened before this ran is still read through this
  // getter by ESPN's own handlers, so its frames are copied as they are read.
  var origData = null;
  try {
    var desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    if (desc && desc.get && desc.configurable) {
      origData = desc.get;
      Object.defineProperty(MessageEvent.prototype, 'data', {
        configurable: true, enumerable: desc.enumerable,
        get: function () {
          var value = origData.call(this);
          try {
            if (isDraftSocket(this.target)) {
              var was = seen ? seen.has(this) : this.__ghqSeen;
              if (!was) { if (seen) seen.add(this); else this.__ghqSeen = true; relay('in', this.target.url, value); }
            }
          } catch (e) { /* never break ESPN */ }
          return value;
        }
      });
    }
  } catch (e) { /* ignore */ }

  try {
    var origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { if (isDraftSocket(this)) relay('out', this.url, data); } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  try {
    var Orig = window.WebSocket;
    var Patched = function WebSocket(url, protocols) {
      var ws = arguments.length > 1 ? new Orig(url, protocols) : new Orig(url);
      // Diagnostic that proves the tap is in the right world: every socket the
      // page opens is reported, matched or not, and shows up server-side.
      relay('in', String(url), 'GHQ_DIAG socket_opened matched=' + isCapturedUrl(String(url)));
      try { if (isCapturedUrl(String(url))) ws.addEventListener('message', teeEvent); } catch (e) { /* ignore */ }
      return ws;
    };
    Patched.prototype = Orig.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { try { Object.defineProperty(Patched, k, { value: Orig[k], enumerable: true }); } catch (e) { Patched[k] = Orig[k]; } });
    for (var k in Orig) { if (!(k in Patched)) { try { Patched[k] = Orig[k]; } catch (e2) { /* ignore */ } } }
    window.WebSocket = Patched;
  } catch (e) { /* ignore */ }
})();
