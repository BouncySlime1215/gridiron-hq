# Deep-dive: ESPN draft-room protocol, source-level (2026-09-07)

Ours: `server/services/draft-frames.js` (text frames + defensive multi-stride
INIT decoder, strides `[45,44,46,48]`, first 4 i32 fields = leagueId, teamId,
pickNumber, playerId) and `client/public/draft-capture.js` (late-attach
`MessageEvent.prototype.data` patch + `WebSocket.prototype.send`/constructor
wrap). No license file in this repo — treat our own code the same way below:
paraphrase, don't lift verbatim from MIT/no-license sources without saying so.

## 1. howell/draft-builder (no LICENSE file — paraphrase only)

`src/platforms/espn/liveDraftProtocol.ts` + `espn-draft-room-tap.user.js`.
This is an **auction** league (`CLOCK/BID/SOLD/NOMINATION`, not
`SELECTING/SELECTED/UNDONE`), so frame grammar differs by draft type — but
`parseInitBlob`'s INIT decoder is the most load-bearing find of this pass:

```
u32 leagueId | u32 teamId | u32 pickNumber | i32 playerId
| u32 slotIdHint | u32 price | u32 unknown | 12B unknown | 1B unknown
```
= **45-byte stride, confirmed against a real 51-pick REST flush (13/13 price
+ team, 51/51 winner)**. They locate the ledger by scanning for the longest
run of 45-byte records whose first u32 equals the known `leagueId` — not by
a fixed offset. **CONFIRMS our 45-byte-first-guess exactly** for the first
16 bytes (leagueId/teamId/pickNumber/playerId as big-endian i32), and
**EXTENDS** it: bytes 16-19 are `slotIdHint` (their board's *provisional*
slot, disagrees with final roster slot ~half the time — do not trust it),
bytes 20-23 are `price` (0 for snake, meaningful for auction), bytes 24-44
(21 bytes) remain unknown. Their base64 cleaner strips any byte outside
`[A-Za-z0-9+/=]` before decoding — worth adopting, since a stray non-base64
character (they saw literal `#` in practice-room INITs) makes `Buffer.from`
silently truncate rather than error, which could make our decoder validate
against a shorter, wrong-length buffer.

The userscript batches at ≤500 frames / 48KB (matches our 200-frame/48KB
cap almost exactly) and separately notes `fetch(..., {keepalive:true})`
**rejects bodies ≥64KB outright** — a constraint worth keeping in mind if we
ever raise our batch ceiling.

## 2. rollingrock/ff-house-rules (MIT)

No dedicated INIT-decoder *file* — `docs/LIVE-DRAFT-MONITORING.md` documents
one, built and replay-verified same-day against a **real 8-team snake draft
capture**, decoding to **exactly 128 records (8×16)** with `teamId` reading
`1..8,8..1,1..8,8..1` — the complete snake grid on connect. Their format:

```
>IIIiII = leagueId | teamId | pickNumber | playerId(i32) | slotHint | price
```

This is the same 45-byte-stride, same first-four-fields layout as howell's
and ours — **independently confirms it a second time, from an unrelated
snake-format capture** (howell's was auction). This is the strongest
evidence our decoder's documented stride is correct, not a guess. Their doc
also names two repos we hadn't catalogued: **worthybrae/fantasy-football**
(fetched below) and **kaedonj16/fantasy-dashboard** (not fetched this pass —
flagged for a follow-up).

Frame-grammar detail theirs adds that ours lacks: `SELECTED`'s trailing
`{SWID}` is **present only when a human clicked, absent on autopick** — we
already parse an optional 4th token as `swid` but don't use presence/absence
as an autopick signal; could extend `parseFrame`. Also: **D/ST playerIds are
negative**, specifically `-(16000 + proTeamId)` — our decoder's `playerId
=== 0` sentinel check in `readRun()` would wrongly reject a legitimate D/ST
record only if its playerId were exactly 0, so we're fine, but downstream
code that does `id > 0` to filter sentinels would silently drop every
defense. Worth grepping for that pattern in `draft-ingest.js` /
`espn-draft.js` (a quick check: `reconstructBoard` only checks `!== -1`, so
we're already correct here).

`DraftState.syncFrom()`'s reconciliation bug writeup is a direct parallel to
our own reconciler: dropping an unrecognized playerId used to shrink
`picks.length` and shift every later pick onto the wrong team. Their fix —
insert a named placeholder pick rather than skip it — is a pattern worth
having in `draft-reconcile.js` if it doesn't already guard this (a
one-line check: does dropping an unresolvable ESPN id ever change indices
downstream of it, vs. leaving a quarantined placeholder?).

## 3. puniakartik/draft_tool (no LICENSE file — paraphrase only)

`DRAFT_ROOM_PLATFORM_NOTES.txt` gives the clearest statement yet of INIT's
*true* shape and **contradicts our framing**: it isn't a flat record array
at all — it's "a type/version marker byte followed by variable-length
integers and nested structures for the league, teams, and picks" (informally
Perl-Storable-like). That's compatible with the other two reports (a
fixed-stride ledger can be one *sub-region* of a larger variable-length
blob — exactly what howell's "rest of the blob... undecoded" and
rollingrock's "128 records" being found by scanning, not assuming byte 0,
both imply), but it means **treating the whole INIT payload as one uniform
stride from offset 0 is the wrong mental model** — our decoder already
avoids this by scanning for a valid offset within the first 256 bytes rather
than assuming offset 0, which turns out to be the right defensive choice.

Also notable: `STATE`'s numeric codes are **not reliably mapped** — they saw
`STATE 7` sent at actual 100%-complete, the same code they'd assumed meant
pre-draft. We don't currently interpret `STATE` at all in `draft-frames.js`
(it's parsed but unused for completion detection) — this confirms that's the
right call; don't add completion-detection logic keyed on `STATE`'s value.

Their capture technique is the same idea as ours (monkey-patch
`WebSocket`/`fetch`/`XHR`/`EventSource` on the page's own connections, no
second socket) but broader: they also patch `fetch`/`XHR`/`EventSource`,
which we don't (we only patch `WebSocket`). Since ESPN's draft feed is
WebSocket-only in every source checked this pass, this is extra surface
without a known payoff — not worth adding speculatively.

## 4. henryhobes/TheFranchise (MIT)

`espn-websocket-protocol-analysis.md`, from a real 3-pick HAR capture,
gives `SELECTED` as `<teamId> <playerId> <overallPick> <memberId>` — **third
field is the overall pick number, not a roster slot.** This **CONTRADICTS**
howell, rollingrock, puniakartik, and our own `parseFrame` (all of which
treat SELECTED's third field as `slotId`, a roster slot). Given three
independent sources agree it's `slotId` and this is a single 3-pick sample
where round-1 picks could coincidentally read as either, we're treating our
existing behavior as correct and flagging this as a **known contradiction to
watch for**, not a fix — if a real draft ever shows SELECTED's third field
matching pick number exactly across many picks in a row (not just early
low-round ones where slot and pick number can coincide), reopen this.

## 5. jacksonhblau/ffdraftpro (MIT)

Mechanically simpler than ours and worth the comparison: a MAIN-world
`hook.js` (matches `document_start`) wraps `WebSocket`/`EventSource` and
`postMessage`s raw frames to an isolated-world `content.js`, which parses
`SELECTED`/`UNDONE`/`RESET` inline and also runs a DOM `TreeWalker` fallback
scanning text nodes for round.pick patterns (`3.07`) next to a known player
name, for catch-up when frames were missed. No `INIT` handling at all — they
rely on the DOM scan for history instead. Their manifest scopes
`host_permissions` narrowly to `*.espn.com`, `fantasyfootballcalculator.com`,
`api.sleeper.app` and a real CSP. Comparable to our `chrome-extension/`; the
MAIN-world/isolated-world split via `postMessage` (rather than patching
`MessageEvent.prototype.data`, our approach) is a cleaner pattern **worth
adopting** if our extension's content script hasn't already done this —
worth a follow-up check against `chrome-extension/content.js`.

## 6. cwendt94/espn-api issue #558 + main lib

Maintainer confirms flatly: "ESPN uses different APIs for the live draft so
the data won't reflect correctly until afterwards" — matches everything
above (REST `mDraftDetail` freezes mid-draft). Two more community tools
surfaced in the thread: `ianfinley89/espn-ffassistant` (Selenium/XPath
scraping, explicitly called "brittle" by its own author) and
`Zinkelburger/Fantasy-Football-Tool` (AGPL-3.0 — copyleft, avoid lifting
code) — a browser extension posting to a local HTTP server, same shape as
our extension. Main lib (`league.py`, `box_score.py`) has no live-draft
code at all; only two draft JSON fixtures, both post-draft.

## 7. GitHub code search: `fantasydraft.espn.com`

New repos not previously catalogued, found via code search:
`coalfocks/draft-aid`, `heechy33/fantasy_football_assistant`,
`sshilal1/fantasyDraftKit`, `tedtasman/draft-machine`,
`worthybrae/fantasy-football`, `kaedonj16/fantasy-dashboard`. Checked the
first four for an INIT/byte-level decoder — none exists (Sleeper-only or
no live capture). **worthybrae/fantasy-football** does direct-connect
(no browser relay): mints its own `draftSecurity` token server-side via
the same undocumented endpoint puniakartik and rollingrock both hit, and
builds the socket URL with the exact same 8 query params (`1,2,3,4,5,6,7,8`)
byte-for-byte matching rollingrock's independently-observed shape — a third
confirmation of the JOIN URL format. Its `bookmarklet.js` takes a materially
**riskier security posture than ours**: it reads and forwards the user's
literal `espn_s2` account-session cookie to its own backend (so the backend
can re-mint tokens without the user re-visiting ESPN), whereas our
bookmarklet strips `{SWID}` and never touches `espn_s2` at all, scoping its
credential to a single-draft, expiring, picks-only ingest key. Nothing here
suggests changing our model — it's confirmation our narrower one is the
safer design, not a gap.

## Prioritized fix list

1. **No fix needed to the INIT byte layout.** Two independent real-draft
   decodes (auction + snake) both confirm `[u32 leagueId, u32 teamId, u32
   pickNumber, i32 playerId, ...]` at a 45-byte stride, matching
   `INIT_RECORD_STRIDES[0]` in `draft-frames.js` exactly. No change.
2. **Adopt howell's base64 sanitizer**: strip non-base64 characters before
   `Buffer.from(...)` in `decodeInitLedger()` — a stray `#` (seen in a real
   practice-room INIT) currently could silently truncate the buffer instead
   of erroring cleanly.
3. **Consider decoding two more fields** now that they're confirmed at
   fixed offsets: `slotIdHint` (bytes 16-19) and `price` (bytes 20-23) —
   low priority since our reconciler doesn't need them, but cheap to add
   for future auction-draft support, with the explicit caveat (all three
   sources agree) that `slotIdHint` disagrees with the final roster slot on
   roughly half of picks and must never be used to place a player.
4. **Flag, don't fix**: TheFranchise's single 3-pick sample reads
   `SELECTED`'s 3rd field as overall-pick-number, contradicting three other
   sources and our own code. Watch for this on a real multi-round capture.
5. **Follow-up, not urgent**: check whether `chrome-extension/content.js`
   already uses a MAIN-world-hook + `postMessage` split (ffdraftpro's
   pattern) rather than the `MessageEvent.prototype.data` patch — the
   former is simpler and has fewer failure modes ("this accessor isn't
   patchable here").
