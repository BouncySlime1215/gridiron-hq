# Draft night: where you actually sit, and what the phone is for

**Written for the Matta-Kodsi Annual draft, Mon 7 Sep 2026, 7:00 PM ET — 8 teams,
PPR, slot 2.** The DMV League draft already happened; this is the one left.

## The one-paragraph version

You draft on your **laptop**, in **ESPN's own draft room**, exactly as you would
without this app. Gridiron HQ sits in a second tab (or on a second screen) as a
**companion view**: it mirrors ESPN's picks as they land and tells you who to take.
It does **not** draft for you. There is no button in this app that submits a pick to
ESPN, there never has been, and nothing below adds one. Every pick you make, you
make in ESPN's window.

The phone is not the drafting device. It is only useful as a **passive second
screen** — see the last section.

## Before 7:00 PM ET (about five minutes, most of it already done)

**1. Start the app.** In a terminal:

```
npm start
```

Leave it running. It serves on `http://localhost:5177`.

**2. Confirm the Chrome extension is loaded.**

The extension is **unpacked source only** — it is not packed into a `.crx` and it
is not on the Chrome Web Store, and nothing in this repo builds or publishes one
(the whole extension is the five files in `chrome-extension/`). So yes, the
Load-unpacked step is still literally required, and it is still one-time:

1. Open `chrome://extensions`.
2. Turn **Developer mode** on (top-right).
3. **Load unpacked** → select `fantasy-football-dashboard/chrome-extension`.

If you already did this on a previous night, just check that
**Gridiron HQ Draft Capture** is listed and toggled **on**. Chrome sometimes
disables an unpacked extension after an update; re-enabling is the same screen.

*Fallback, only if the extension refuses to load:* the bookmarklet in
`docs/DRAFT_CAPTURE.md` does the same job with one click per draft tab, but it
needs the Cloudflare tunnel running (`npm run tunnel`) because it is injected into
an https ESPN page and can't reach plain `localhost`. The extension needs no
tunnel. Prefer the extension.

**3. Open the Live Draft page for this league** in one Chrome tab:
`http://localhost:5177/draft?view=live` (the sidebar's **Draft** entry, "live" view)
→ *Matta - Kodsi Annual*. You land on `/live-draft/<id>`.
Confirm the header says slot 2 and shows the scheduled time. Leave this tab open.

**4. Open ESPN's draft room** in a second tab at `fantasy.espn.com` and wait for the
board to appear. Within a few seconds a small green pill shows up at the
bottom-right of the ESPN page:
`Gridiron HQ · listening · Matta - Kodsi Annual — 2026 draft`.

That pill is the whole confirmation. It means the extension found the app on
localhost, signed itself in over loopback, asked `/api/drafts/active` which draft
is happening right now, minted its own ingest key, and is already relaying frames.
Zero clicks from you.

If the pill instead says **"waiting for a live draft in Gridiron HQ"**, the app is
reachable but `/api/drafts/active` returned nothing — it only counts a
league-linked, `active` draft whose scheduled time is within a day of now. Check
that the Matta-Kodsi draft is linked in the Live Draft hub. If the pill never
appears at all, the app isn't running or Chrome disabled the extension.

**5. Put the two tabs side by side** (`Cmd+\`` or drag one window to a side) and
draft. Glance right when you're on the clock.

That is the entire pre-draft checklist. Nothing to prepare, no rankings to import,
no homework.

## What you'll be looking at while you glance over

- **Claude's call** — one name, big, with the stat line that justifies it and a
  p20–p80 range bar so you can see the floor/ceiling spread, not just a projection.
- **If you take him now…** — the rest of the draft simulated ~200× per candidate.
- **Take one of these** — the ranked shortlist, with "% gone by your next turn".
  Its header stays pinned while you scroll the list.
- **Off the board** — the pick feed. A new pick **flashes green briefly** as it
  lands, so a board that changed while you were looking at ESPN is visible as a
  change rather than a silent redraw.

## If it desyncs mid-draft

The header shows **⚠ OUT OF SYNC WITH ESPN** when ESPN has more picks than this
board has mirrored. It usually clears itself on the next reconciliation pass. It
does not affect your draft — ESPN is the source of truth and you're picking there
anyway. Worst case the advice is a pick or two stale; ignore it and pick.

Do **not** reload the ESPN tab to fix anything. A reload can cost you your seat in
the room. The extension re-attaches on its own if the socket reconnects.

## Optional: someone else watching on a phone

This is a genuinely separate use case from your own workflow above — it is a
**read-only viewer**, not a way to draft from a phone.

The app already supports exposing itself to a phone through a Cloudflare quick
tunnel with a one-time pairing code (`scripts/tunnel.mjs`,
`server/routes/local-auth.js`, `client/src/pages/Pair.tsx`):

1. On the Mac, in a second terminal: `npm run tunnel`. It prints an
   `https://….trycloudflare.com` address and registers it with the app.
2. On the Mac: **Settings → Phone access → Generate code** (8 digits, good for
   10 minutes, one use).
3. On the phone: open the tunnel address, type the code. That phone stays signed
   in for 30 days.
4. Open the same Live Draft page there. It's the same companion view, laid out for
   a narrow screen — the candidate cards become a swipeable rail.

Notes and limits, honestly:

- The tunnel address is new every time you run `npm run tunnel`, and it dies when
  you Ctrl-C it. Nobody can sign in through it without a code minted on the Mac.
- The phone is a **viewer**. It can't capture picks (the Chrome extension only
  talks to `localhost` on the Mac, deliberately — see
  `docs/DRAFT_CAPTURE_EXTENSION.md`) and it can't submit a pick to ESPN, because
  nothing in this app can.
- Don't rely on this for your own drafting. If the tunnel hiccups at 7:04 PM you'd
  be troubleshooting instead of picking. Your laptop is the plan; the phone is a
  nice-to-have for whoever else is in the room.
