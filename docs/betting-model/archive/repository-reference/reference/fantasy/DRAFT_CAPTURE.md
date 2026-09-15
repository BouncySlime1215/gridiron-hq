# Draft-night WebSocket capture (ESPN bookmarklet)

ESPN's REST draft view is frozen while a draft is live; picks flow only over the
draft room's WebSocket (`wss://fantasydraft.espn.com/...`). The bookmarklet taps
that socket **passively** from inside the ESPN tab and forwards raw frames to
Gridiron HQ through the Cloudflare tunnel. It never opens a second socket, never
calls an ESPN endpoint, and never reloads the page (a reload can cost you your
draft seat).

## Draft night, step by step

1. **Start the app and the tunnel**: `npm start`, then `npm run tunnel` in a
   second window. Leave both open. Without a tunnel the bookmarklet points at
   `http://localhost:5177`, which the https ESPN page will refuse to load.
2. In Gridiron HQ, open the draft room. The commissioner mints the ingest key
   (`POST /api/drafts/:id/ingest-key`); the UI then fetches
   `GET /api/drafts/:id/capture-bookmarklet?ingest_key=...` and shows a
   **drag-me-to-your-bookmarks-bar** link. Drag it once. Re-drag it if you mint
   a new key or restart the tunnel (the tunnel hostname changes every run).
3. **Open the ESPN draft room FIRST** at fantasy.espn.com and wait until the
   board is visible.
4. Click the bookmarklet **once**. A small pill appears bottom-right:
   `Gridiron HQ · listening · 12 frames · last 3s ago`.
   - green = healthy; yellow = retrying (tunnel or server hiccup, frames are
     queued and resent in order); red `STOPPED` = the server rejected the key
     (expired or wrong) - mint a new key, re-drag the bookmarklet, click again.
   - The `×` hides the pill; capture keeps running.
5. **Do not reload the ESPN tab.** If it does reload (or you open the room in a
   new tab), click the bookmarklet again - it is safe to run twice.

The Gridiron HQ draft room shows the ingest status
(`GET /api/drafts/:id/ingest-status`): last heartbeat, frames received, picks
reconstructed. A heartbeat goes out every 10 s even with no picks, so a stale
"last heartbeat" means the tab is closed, asleep, or the tunnel died.

## What the script does

`client/public/draft-capture.js` (served at `/draft-capture.js`, also copied
into `client/dist/` by `npm run build`):

- Reads `draft`, `key`, `origin` from its own `<script src>` query string.
- **Late attach**: patches the `MessageEvent.prototype.data` getter so every
  frame ESPN's own code reads from a `fantasydraft.espn.com` socket is copied
  (the original getter always runs). Patches `WebSocket.prototype.send` for
  outgoing text and wraps the `WebSocket` constructor so a reconnected socket
  is captured from its first frame (`INIT`). Idempotent: a second click
  re-points the hooks instead of double-patching.
- Reads a DOM baseline once (the `On the Clock: Pick N` element, else
  completed `[data-pick-number]` rows) and sends `picks_on_board`; re-sends it
  whenever the DOM count jumps by more than one between batches.
- Batches frames every 2 s (immediately for `SELECTED` / `INIT` / `UNDONE`),
  under 48 KB and 200 frames per POST, sequential `seq` per `capture_id` so the
  server can dedupe resends. 5xx / 429 / network errors re-queue the batch at
  the front with 2 s, 4 s, 8 s, 20 s backoff; a 4xx drops it and turns the pill
  red.
- Strips the `{SWID}` GUID from frames before posting. No cookies are sent.
- Logs to the console with a `GHQ:` prefix.

## Security model

- The ingest key is the only credential in the bookmarklet. It authorises one
  thing: posting frames to `/api/drafts/<that draft>/capture`. It cannot read
  anything, touch other drafts, or act as your Gridiron HQ session.
- It expires (draft time + 8 h, or 12 h when the draft has no scheduled time),
  and minting a new one revokes the old one. Repeated bad keys are rate limited.
- The capture endpoint accepts CORS only from `https://fantasy.espn.com`.
- Anyone who sees your bookmarks bar can read the key, so treat the bookmarklet
  like a league password until the draft is over.

## Honest limitations

- **Late attach misses history.** Frames delivered before you click are gone;
  the script only sees frames from that moment. The DOM baseline plus the
  server-side reconciliation against ESPN's REST view (which catches up after
  the draft) cover the gap, and a reconnect yields a fresh `INIT` snapshot.
- If ESPN's code reads `event.data` through a path that bypasses the prototype
  getter (an own-property shim, a worker, or binary frames), a pre-existing
  socket goes uncaptured until it reconnects. The console will show
  `GHQ: MessageEvent.data is not patchable here` in the accessor case; binary
  frames are noted but not shipped.
- A single frame over ~44 KB (a very large `INIT`) is truncated to fit the
  batch budget and marked `[GHQ truncated N chars]`.
- The DOM selectors (`[data-testid="current-pick"]`, `[data-pick-number]`,
  `.pick-history-tables`) come from reverse engineering, not an API. When none
  match, the baseline is `null` and the server relies on frames alone.
- Verify all of the above in an ESPN **mock draft** before the real one.
