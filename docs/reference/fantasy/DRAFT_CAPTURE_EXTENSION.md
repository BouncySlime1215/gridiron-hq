# Draft capture, zero-click: the Chrome extension

The bookmarklet (`docs/DRAFT_CAPTURE.md`) needs one click per draft — you drag a
bookmark once and click it every time you open a new ESPN draft tab. This
extension needs **zero** clicks, ever, after a one-time load: open the ESPN
draft room and it's already listening. That's possible only because it runs on
the same Mac as Gridiron HQ — it talks straight to `localhost:5177`, not
through a tunnel, so there's no key to copy and no bookmarklet to drag.

## One-time setup (about a minute, never again)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the folder
   `fantasy-football-dashboard/chrome-extension`.
4. Done. Pin it (puzzle-piece icon → pin) if you want the status popup handy.

That's the entire setup. You never touch it again — not tonight, not next
draft, not next season, unless Chrome ever asks you to re-enable it after an
update (rare, and it's the same "Load unpacked" step).

## What happens on draft night

1. Open the ESPN draft room in Chrome, side by side with Gridiron HQ if you
   want (`Cmd+\`` or drag one window to a side). That's it.
2. A small green pill appears in the bottom-right of the ESPN page:
   `Gridiron HQ · listening · <name of your draft>`. That means it found your
   live draft in Gridiron HQ on its own and is already feeding it picks.
3. Draft normally. Gridiron HQ updates itself.
4. If the pill says **"waiting for a live draft in Gridiron HQ"**, it's
   attached and watching, it just hasn't found a draft whose scheduled time is
   within a day of right now — check that the right league is linked in
   Gridiron HQ's Live Draft hub.
5. Click the extension icon any time for a plain status readout.

## Why this can't get you logged out of ESPN

Same rule as everything else in this app: it never opens a second connection
to ESPN. It reads the *existing* WebSocket your own browser tab already opened
to draft — the identical technique as the bookmarklet — so ESPN sees exactly
one session, yours. See `docs/DRAFT_CAPTURE.md` for the full protocol writeup
and `docs/PLAN_2026_09_07.md` for why the REST-polling approach never worked
live in the first place.

## How the auto-config actually works (for the curious / for debugging)

`background.js` (the extension's service worker) does, entirely on its own:

1. `fetch('http://localhost:5177/api/teams')` — is Gridiron HQ even running?
2. `POST /api/auth/local-session` — signs itself in. This works because the
   request originates from 127.0.0.1 on this Mac, the exact same rule that
   lets the desktop browser tab sign in with no password
   (`server/routes/local-auth.js`'s `isDirectLoopback`). It is **not**
   reachable this way from anywhere but this machine — that's deliberate.
3. `GET /api/drafts/active` — "what draft is happening right now?" Only a
   league-linked, active draft whose `draft_at` is within a day of the
   current time counts; otherwise it returns `null` rather than guessing.
4. `POST /api/drafts/:id/ingest-key` — mints the same kind of one-draft,
   picks-only key the bookmarklet flow uses, automatically, because the
   loopback session is commissioner for every league on this install.
5. From then on, `content.js` (running in the ESPN tab) taps the socket and
   relays frames to the background worker, which posts them to
   `/api/drafts/:id/capture` — the identical server-side endpoint and
   reconciler the bookmarklet uses. Nothing about ingest, parsing, or
   reconciliation changed; only how the frames get from your browser to it.

## Limitations, honestly

- **Same Mac only.** If Gridiron HQ isn't running on the machine Chrome is on,
  the pill will say so. This is not a remote/phone solution — see
  `docs/DRAFT_ON_PHONE.md` for that.
- **Not yet verified against a real ESPN draft room.** The WebSocket protocol
  and DOM selectors are from the reverse-engineering research in
  `docs/DRAFT_CAPTURE.md`; dry-run in an ESPN mock draft before relying on it
  live (the bookmarklet has a `?dry=1` mode for exactly this — the extension
  doesn't need one since it only ever talks to your own Mac, never a shared
  tunnel, so a mistaken batch can't reach anyone else's draft).
- **Multiple draft tabs.** If you have two ESPN draft tabs open at once, both
  attach independently; whichever's frames land first wins ties in the
  reconciler (same as two people using the bookmarklet would).
