# Running this in the cloud, with the laptop shut

Written 2026-09-18, for Nick's "make everything be cloud — take what's not on
cloud and move it there."

The short version: **everything moves except the league chat, and that gets a
button.** One manual step, on the laptop, whenever you want the counterparty
read refreshed. Nothing else needs your Mac.

---

## Why anything is stuck in the first place

The repository is the whole build. The data it runs on is deliberately not in
it — `.gitignore` keeps four things out, each for a different reason:

| File | Size | Why it's not in git |
|---|---|---|
| `server/data.sqlite` | small | holds your ESPN cookies and personal rankings |
| `data/derived/league_chat.sqlite` | small | private iMessage content — *"never commit"* |
| `data/line-history/line_history.sqlite` | 21 GB | far too big, and betting-side only |
| `data/line-history/nflverse.sqlite` | 2.1 GB | too big, and rebuildable from public feeds |
| `.env` | — | secrets |

A fresh cloud box therefore starts with the code and none of the above. The
engine comes up and answers every question — which is the dangerous part,
because the counterparty read silently switches off and the trade cards still
look authoritative. `scripts/check-environment.mjs` exists to stop exactly that.

---

## The four cases, and what each one does

### 1. The archives — never move them

`line_history.sqlite` is betting-side. **The fantasy engine never opens it.**
It stays on the Mac permanently; 21 GB will not fit in a session box anyway.

`nflverse.sqlite` holds the research history (`roster_weekly` 2016-2026 with
IR/PUP status, injuries, play-by-play, participation, FTN, NGS, QBR). The weekly
fantasy engine doesn't read it either — it matters to the injury-return model
(WO / O2) and the historical studies. If a cloud box ever needs it, **rebuild
rather than copy**: it comes from nflverse's public releases, and the loaders are
already in `scripts/`. Budget an hour or so of download and import for the full
2016-2026 span, and don't do it until something actually needs it.

Neither of these blocks anything you'd do with the laptop closed.

### 2. `server/data.sqlite` — re-auth, don't ship the file

You don't need to move this one at all, and you shouldn't want to — it has your
cookies in it.

The ESPN bookmarklet already works against a cloud URL. `server/routes/espn-connect.js`
derives its post-back address from the request that served it:

```js
function originFor(req) {
  const host = req.headers.host || `localhost:${process.env.API_PORT || 5177}`;
  ...
}
```

so the bookmarklet posts to whatever host you loaded Settings from. Hardcoding
localhost was fixed long ago. There's a paste box as a fallback for browsers
where bookmarklets are awkward.

So the cloud path is:

1. Open the cloud app's Settings → **Connect ESPN**, run the bookmarklet from
   ESPN's own page. Cookies land in the cloud box's `app_settings`.
2. `node scripts/bootstrap-data.mjs` — pulls rosters, projections, market prices
   and the weekly boxscores from the live feeds.
3. Sync your leagues as normal.

That reconstructs `data.sqlite` from scratch without the original ever leaving
your machine.

### 3. The league chat — the one real exception

`data/derived/league_chat.sqlite` cannot be fetched from anywhere. It's
extracted from `~/Library/Messages/chat.db` by
`scripts/chat/extract_league_chat.py`, which needs a Mac and Full Disk Access.
There is no API behind Messages.

Everything the Trade Brain knows about *people* comes out of it: who's high on
which player, who has soured, who bluffs about untouchables, how fast each
manager answers an offer, which window they're reachable in.

**So it gets a button.** Settings now has a **League chat** card:

- **On the laptop** it runs the whole pull in one click — incremental extract,
  classify the new messages, rebuild the manager rollups. Clicking it twice is
  cheap and changes nothing; the extractor only reads rows newer than the
  highest one already stored.
- **In the cloud**, where there is no Messages database, the same card becomes a
  staleness read: message counts, how many are classified, and how old the
  corpus is, in plain words (*"3 days old — sentiment and timing reads are from
  before this week"*).

The server decides which of those you get (`extractionCapability()`), not the
client guessing from the hostname, so the button is never offered where it
cannot work and the reason given is always the real one.

Moving the file between boxes:

```bash
# on the Mac, after a pull
curl -X POST <cloud-url>/api/league-chat/upload \
     -H 'Content-Type: application/octet-stream' \
     --data-binary @data/derived/league_chat.sqlite

# or, if you have the file locally in the cloud box already
node scripts/import-league-chat.mjs <uploaded-path>
node scripts/import-league-chat.mjs --verify
```

Both paths validate before they replace anything: a file with no `messages`
table, or an empty one, is refused rather than installed, because installing it
would read downstream exactly like having no chat data at all. The previous
corpus is kept beside the new one either way.

`/api/league-chat/pull` is loopback-only. The tunnel makes this app reachable
from the internet, and that endpoint spawns a process that reads a private
message store — it must never be callable by whoever holds the URL.
`isDirectLoopback` rejects anything carrying a forwarding header, so a tunnelled
request cannot pass for local.

### 4. Keys — the **Environment variables** box, not API credentials

The environment settings screen offers two places to put a secret. Use the
first one:

- **Environment variables** — a `.env`-format box. The values land in
  `process.env`, which is where this code looks. This is the one to use.
- **API credentials** — injects an `Authorization` header into outbound requests
  to whitelisted hosts, and never exposes the value to the process. Better
  mechanism in principle, but see below: it cannot work here without code
  changes.

Paste this into the Environment variables box:

```
ANTHROPIC_API_KEY=...          the Coach, the AI proposal pass, the chat classifier
ODDS_API_KEY=...               The Odds API
PARLAY_API_KEY=...             ParlayAPI (second odds feed)
CFBD_API_KEY=...               CollegeFootballData rookie signals
PFF_API_TOKEN=...              PFF grades
PFF_API_BASE_URL=...           PFF endpoint
SPORTSGAMEODDS_API_KEY=...     SportsGameOdds feed
TWITTERAPI_IO_KEY=...          news / beat-reporter feed
```

Only `ANTHROPIC_API_KEY` blocks anything. The rest each switch one feed off.

`ANTHROPIC_API_KEY` is also readable from `app_settings`, so pasting it into
Settings in the UI works instead of setting the env var.

The box carries a warning that its values are visible to anyone using the
environment. This project is private to Nick, so in practice that is himself.

#### Why the credential injector doesn't fit (checked, not assumed)

Worth recording, because it looks like it should and the reason is one line of
code rather than anything about the feeds.

How each key actually travels:

| Key | Sent as | Injector could carry it? |
|---|---|---|
| `CFBD_API_KEY` | `Authorization: Bearer …` (`cfbd.js:36`) | the header, yes |
| `TWITTERAPI_IO_KEY` | `X-API-Key` (`twitterapi-io.js:53`) | via custom headers |
| `SPORTSGAMEODDS_API_KEY` | `X-Api-Key` (`sportsgameodds.js:41`) | via custom headers |
| `PFF_API_TOKEN` | header (`nfl-roster-strength.js:410`) | via custom headers |
| `ODDS_API_KEY` | query string, `?apiKey=` (`odds-api.js:103`) | no — it isn't a header |
| `PARLAY_API_KEY` | query string | no |
| `ANTHROPIC_API_KEY` | the SDK needs it to construct the client | no |

But the blocker is upstream of all of that. Every one of these feeds gates
itself on the variable being present before it makes a request:

```js
export const hasKey = () => Boolean(process.env.ODDS_API_KEY);   // odds-api.js:21
export const hasKey = () => Boolean(process.env.CFBD_API_KEY);   // cfbd.js:32
```

With the key only in the injector and not in `process.env`, `hasKey()` is false,
the call is never made, and the injector never gets a request to decorate. The
feed reports itself as "not configured" and quietly no-ops.

So: **Environment variables box today.** Moving a feed onto the injector would
mean splitting "is this configured" from "here is the secret" — a real change
worth making if these ever run somewhere less private, and not worth doing now.
Noted in `TASKS.md` under **[WD]** rather than done here.

**Measured, not assumed:** with no `ANTHROPIC_API_KEY` in this cloud box, the
test suite fails in exactly two files — `nfl-news-events.test.js` (7) and
`page-explain.test.js` (4) — every one of them `Connection error.` from the
Anthropic SDK. Nothing else in the suite needs a key or a network.

---

## The checklist

Run this in any box and it names every missing file and key, what specifically
breaks without each, and how to get it:

```bash
node scripts/check-environment.mjs
```

It exits non-zero when something genuinely required is absent, so it works as a
startup gate. It reports keys as present or absent and never prints a value.

Order for a fresh cloud box:

1. Paste the keys into the environment's **Environment variables** box (not API credentials — see above).
2. Connect ESPN from the cloud app's Settings (bookmarklet).
3. `node scripts/bootstrap-data.mjs`
4. Pull the chat on the laptop, upload it (or `import-league-chat.mjs`).
5. `node scripts/check-environment.mjs` — expect a clean bill.

---

## What the degraded state actually costs

Worth being precise, because this is the decision to make before shutting the
laptop for a long stretch. With no league-chat corpus:

**Still works.** Projections, rest-of-season value, start/sit, the lineup
solver, waivers, the season simulator and playoff odds, market values, the
horizon-weighted trade math, `findTrades` and the offer ladders, the edge test,
veto climate, the Coach on everything numeric.

**Switches off.** Every ladder reports *"No counterparty read for this league —
this ladder is priced on our numbers only."* Concretely, you lose:

- **Sell the crush** and **buy the sour** — both read `manager_player_sentiment`.
- **Hype window** — needs the talk-vs-model expectation gap.
- **Post-loss / timing** — needs `timingRead` over the chat corpus.
- **Declared untouchables and the bluff read** — `bluff-detector.js` has nothing
  to score credibility against, so a player someone has called untouchable is
  priced as if he were freely available.
- **Anchor ladder phrasing in their own language**, and the "how Nick looks"
  pacing rules.
- The perception factor, so `score_signed` and `score_unperceived` collapse to
  the same number. (Which is safe — the edge test's `not_only_perception` check
  passes trivially rather than failing open.)

In one line: **the engine still finds trades that are good for you; it stops
knowing which ones the other person will say yes to.** That's the half the whole
Trade Brain was built for, so for a weekend of real trade work, pull the chat
first.

---

## What this does not do

It does not put the app *online* permanently — that's WF / Phase 11 in the
master plan (Fly.io, Google sign-in, per-user Claude keys, hiding the chat
reading from other accounts), deliberately scheduled last. This document is
about running a cloud session with the laptop closed, not about hosting.
