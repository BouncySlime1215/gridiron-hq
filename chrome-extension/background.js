'use strict';
/**
 * Gridiron HQ draft capture — background service worker.
 *
 * Everything the bookmarklet made Nick do by hand (open Settings, generate a
 * pairing/ingest key, copy it into a URL) happens here automatically, because
 * this extension only ever talks to the SAME MACHINE it runs on. A fetch to
 * http://localhost:5177 from this service worker originates from 127.0.0.1,
 * which is exactly what server/routes/local-auth.js's isDirectLoopback()
 * checks for — the same rule that already lets the desktop browser sign
 * itself in with no password. So: no tunnel, no pairing code, no ingest key
 * to copy — just "is Gridiron HQ running on this Mac right now".
 */
const API_BASES = ['http://localhost:5177', 'http://127.0.0.1:5177'];
const KEY_TTL_MS = 6 * 60 * 60 * 1000;   // re-mint well inside the server's own 12h/draft_at+8h expiry
const DRAFT_RECHECK_MS = 20 * 1000;      // cheap enough to just re-ask; catches a newly linked draft fast

let cache = { apiBase: null, token: null, draft: null, draftAt: 0, ingestKey: null, ingestKeyDraftId: null, keyAt: 0 };

async function loadCache() {
  const stored = await chrome.storage.local.get('ghqCache');
  if (stored.ghqCache) cache = { ...cache, ...stored.ghqCache };
}
async function saveCache() { await chrome.storage.local.set({ ghqCache: cache }); }

async function findApiBase() {
  if (cache.apiBase) return cache.apiBase;
  for (const base of API_BASES) {
    try {
      const r = await fetch(base + '/api/teams', { signal: AbortSignal.timeout(2000) });
      if (r.ok) { cache.apiBase = base; await saveCache(); return base; }
    } catch { /* try the next base */ }
  }
  throw new Error('Gridiron HQ is not running on this Mac — open it once (npm start) and reload the ESPN tab');
}

async function ensureToken(force) {
  const base = await findApiBase();
  if (cache.token && !force) return cache.token;
  const res = await fetch(base + '/api/auth/local-session', { method: 'POST' });
  if (!res.ok) throw new Error('could not sign in to Gridiron HQ (' + res.status + ')');
  const body = await res.json();
  cache.token = body.token;
  await saveCache();
  return cache.token;
}

/** GET with one silent retry after a fresh sign-in, in case the cached token was revoked. */
async function authedFetch(path, opts = {}) {
  const base = await findApiBase();
  let token = await ensureToken(false);
  let res = await fetch(base + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  if (res.status === 401) {
    token = await ensureToken(true);
    res = await fetch(base + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  }
  return res;
}

async function ensureDraft() {
  if (cache.draft && Date.now() - cache.draftAt < DRAFT_RECHECK_MS) return cache.draft;
  const res = await authedFetch('/api/drafts/active');
  if (!res.ok) throw new Error('could not look up the active draft (' + res.status + ')');
  const body = await res.json();
  if (!cache.draft || !body.draft || cache.draft.id !== body.draft.id) {
    cache.ingestKey = null; // a different (or no) draft: the old key is meaningless
  }
  cache.draft = body.draft;
  cache.draftAt = Date.now();
  await saveCache();
  return cache.draft;
}

async function ensureIngestKey(draftId) {
  if (cache.ingestKey && cache.ingestKeyDraftId === draftId && Date.now() - cache.keyAt < KEY_TTL_MS) return cache.ingestKey;
  const res = await authedFetch('/api/drafts/' + draftId + '/ingest-key', { method: 'POST' });
  if (!res.ok) throw new Error('could not get a draft key (' + res.status + ')');
  const body = await res.json();
  cache.ingestKey = body.key;
  cache.ingestKeyDraftId = draftId;
  cache.keyAt = Date.now();
  await saveCache();
  return cache.ingestKey;
}

/** Draft + key + base, fully resolved, or {draft:null} if nothing is live right now. */
async function resolveConfig() {
  const draft = await ensureDraft();
  if (!draft) return { draft: null };
  const key = await ensureIngestKey(draft.id);
  return { draft, key, apiBase: await findApiBase() };
}

async function postCapture(draftId, key, base, body) {
  const res = await fetch(base + '/api/drafts/' + draftId + '/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ingest_key: key })
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, body: json };
}

/**
 * Injected into the ESPN page's MAIN world by the Resync button. Self-contained
 * (executeScript serializes it -- no closures). Closes the live draft socket so
 * ESPN's client reconnects and re-sends INIT. Prefers the reference inject.js
 * stashes; on a page loaded before that existed, arms a one-shot on the next
 * frame ESPN reads (CLOCK ticks arrive every few seconds) and closes that.
 */
function resyncInPage() {
  try {
    var ws = window.__GHQ_LAST_SOCKET__;
    if (ws && ws.readyState === 1) { ws.close(4000, 'ghq-resync'); return 'closed'; }
    if (window.__GHQ_RESYNC_ARMED__) return 'armed';
    var desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    if (!desc || !desc.get || !desc.configurable) return 'no-getter';
    var orig = desc.get;
    window.__GHQ_RESYNC_ARMED__ = true;
    Object.defineProperty(MessageEvent.prototype, 'data', {
      configurable: true, enumerable: desc.enumerable,
      get: function () {
        var v = orig.call(this);
        try {
          var t = this.target;
          if (window.__GHQ_RESYNC_ARMED__ && t && typeof t.url === 'string' && t.url.indexOf('fantasydraft.espn.com') !== -1 && t.readyState === 1) {
            window.__GHQ_RESYNC_ARMED__ = false;
            setTimeout(function () { try { t.close(4000, 'ghq-resync'); } catch (e) { /* ignore */ } }, 0);
          }
        } catch (e) { /* never break ESPN */ }
        return v;
      }
    });
    return 'armed';
  } catch (e) { return 'error:' + (e && e.message); }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'ghq-status') {
        try { sendResponse({ ok: true, draft: (await resolveConfig()).draft }); }
        catch (e) { sendResponse({ ok: false, error: e.message }); }
        return;
      }
      if (msg.type === 'ghq-batch') {
        let cfg;
        try { cfg = await resolveConfig(); }
        catch (e) { sendResponse({ ok: false, status: 0, error: e.message }); return; }
        if (!cfg.draft) { sendResponse({ ok: false, status: 0, error: 'no live draft found in Gridiron HQ right now' }); return; }
        try {
          const result = await postCapture(cfg.draft.id, cfg.key, cfg.apiBase, msg.batch);
          // A rejected key is worth forgetting immediately rather than waiting out the TTL.
          if (result.status === 401) { cache.ingestKey = null; await saveCache(); }
          sendResponse({ ok: result.ok, status: result.status, error: result.body && result.body.error, draft: cfg.draft });
        } catch (e) { sendResponse({ ok: false, status: 0, error: e.message }); }
        return;
      }
      if (msg.type === 'ghq-resync') {
        // Make ESPN's draft client reconnect its socket. A reconnect re-sends the
        // full INIT ledger -- every pick made so far, with real pick numbers --
        // which is the only way to backfill picks that happened before the tap was
        // live, without refreshing the draft room (a refresh can cost the seat).
        // Runs in the page's MAIN world because that's where the socket lives.
        const tabs = await chrome.tabs.query({ url: ['https://fantasy.espn.com/football/draft*', 'https://fantasydraft.espn.com/*'] });
        if (!tabs.length) { sendResponse({ ok: false, error: 'no ESPN draft tab is open' }); return; }
        let closed = 0, armed = 0;
        for (const t of tabs) {
          try {
            const results = await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, world: 'MAIN', func: resyncInPage });
            for (const r of results || []) { if (r.result === 'closed') closed++; else if (r.result === 'armed') armed++; }
          } catch (e) { /* a frame we cannot reach; keep going */ }
        }
        const ok = closed > 0 || armed > 0;
        sendResponse({ ok, closed, armed, error: ok ? null : 'no live draft socket found in the ESPN tab' });
        return;
      }
      sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true; // keep the message channel open for the async response above
});

// MV3 service workers are killed when idle; an alarm (unlike setInterval)
// reliably wakes this one back up so draft/key discovery stays warm.
chrome.alarms.create('ghq-refresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'ghq-refresh') resolveConfig().catch(() => {}); });

loadCache().then(() => resolveConfig().catch(() => {}));
