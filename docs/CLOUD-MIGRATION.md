# Running this in the cloud, with the laptop shut

Written 2026-09-18, for Nick's "make everything be cloud — take what's not on
cloud and move it there."

**Read this first — corrected 2026-09-18 after testing in a real cloud box.**

An earlier version of this document said you could connect ESPN from a cloud
session's Settings page. You cannot, and the reason kills more than that one
step: **a Claude Code cloud session has no browser-reachable URL.**
`SESSION_INGRESS_URL` resolves to `api.anthropic.com`, the session record
carries no preview URL, and the container is reclaimed after inactivity. There
is no address you can point a browser, a bookmarklet, or a `curl` from your Mac
at.

So what "laptop closed" buys today is narrower than the rest of this document
originally implied:

| | Laptop closed, today |
|---|---|
| Claude sessions doing repo work — engine changes, tests, builds, the whole Trade Brain build | **Yes**, with the keys in the environment |
| The app actually *running* — scheduler, refresh loop, UI, live league sync | **No** |
| Pulling the league chat | **No** — needs the Mac, by design |

The real prerequisite for the full thing is **hosting the app** — WF / Phase 11
in the master plan (Fly.io, Google sign-in, per-user Claude keys). Once it has a
permanent URL, everything below works as written, including the bookmarklet and
the corpus upload. Until then, a cloud session is a very capable *build*
machine, not a place the app lives.

The rest of this document is accurate about what moves and how. Just read
"cloud box" as "the machine the app will eventually run on" rather than "this
Claude session."

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

You don't need to move this one, and you shouldn't want to — it has your cookies
in it.

**The normal path is on the Mac**, and always was: open Settings → **Connect
ESPN**, run the bookmarklet from ESPN's own page. The bookmarklet posts back to
whatever host served it (`originFor()` in `server/routes/espn-connect.js`
derives it from the request), so this also works against any *hosted* instance —
it is only a Claude cloud session, with no reachable address at all, where it
cannot work.

Then `node scripts/bootstrap-data.mjs` pulls rosters, projections, market prices
and the weekly boxscores from the live feeds, and you sync leagues as normal.

#### The cloud fallback, if you ever need it

There is one CLI route in, and it is worth knowing about because it is the only
way to hand ESPN cookies to a machine with no browser access. `POST
/api/espn-connect/cookies` is deliberately **not** session-guarded — the
bookmarklet runs on espn.com and cannot carry the app's token, so the route is
mounted without the auth wrapper (`server/index.js`, `app.use('/api/espn-connect',
espnConnectRouter)` with no `legacyAuthenticated`). It takes the same blob the
paste box takes:

```bash
# inside the box, with the server running on its own loopback port
curl -X POST http://localhost:5177/api/espn-connect/cookies \
     -H 'Content-Type: application/json' \
     -d '{"raw":"espn_s2=…; SWID={…}"}'
```

It validates against ESPN before writing anything, so a bad paste changes
nothing.

**The caveat is the point, though:** those two cookies are your ESPN session —
anyone holding them is logged in as you. Getting them into a cloud box means
pasting them somewhere, and a chat thread is not a good somewhere. Prefer the
Mac. Use this only for a box you control and intend to keep, and rotate by
signing out of ESPN afterwards if you ever do it casually.

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
# In a Claude cloud session today: get the file into the box by whatever means
# the session offers (an upload into the workspace), then install it.
node scripts/import-league-chat.mjs <path-to-uploaded-file>
node scripts/import-league-chat.mjs --verify
```

The HTTP route exists and is tested, but **it needs a reachable address, which a
Claude cloud session does not have** (see the note at the top). Once the app is
hosted — Phase 11 — this is the one-liner from the Mac after a pull:

```bash
# only once there is a real <cloud-url>
curl -X POST <cloud-url>/api/league-chat/upload \
     -H 'Content-Type: application/octet-stream' \
     --data-binary @data/derived/league_chat.sqlite
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
GRIDIRON_ANTHROPIC_API_KEY=... the Coach, the AI proposal pass, the chat classifier
ODDS_API_KEY=...               The Odds API
PARLAY_API_KEY=...             ParlayAPI (second odds feed)
CFBD_API_KEY=...               CollegeFootballData rookie signals
PFF_API_TOKEN=...              PFF grades
PFF_API_BASE_URL=...           PFF endpoint
SPORTSGAMEODDS_API_KEY=...     SportsGameOdds feed
TWITTERAPI_IO_KEY=...          news / beat-reporter feed
```

Only the Anthropic key blocks anything. The rest each switch one feed off.

#### The Anthropic key needs a different variable name here

Note the name in that list. **A Claude Code cloud box will not pass a variable
called `ANTHROPIC_API_KEY` through to the process.** Those environments
authenticate their own sessions from the signed-in Anthropic account, so they
claim that name; the settings screen says as much right under the box
("*won't be used to authenticate requests*"). The variable is simply absent at
runtime, which from inside the app is indistinguishable from never having
pasted it.

Measured 2026-09-18, in a box where the key had been pasted into the
Environment variables box and saved: `CFBD_API_KEY` added at the same time
showed up in an already-running session about eleven minutes later, while
`ANTHROPIC_API_KEY` stayed unset. Only `ANTHROPIC_BASE_URL` was present under
that prefix. Nothing was wrong with the key or the box.

So `getApiKey()` (`server/services/claude.js`) reads, in order:

1. `GRIDIRON_ANTHROPIC_API_KEY` — the name to use in a cloud box. Nothing
   claims it.
2. `ANTHROPIC_API_KEY` — still the right name on a Mac, a plain server, or in
   a `.env` file.
3. `app_settings`, so pasting the key into Settings in the UI works too. Note
   that writes the database of whichever box you did it in, so doing it on the
   Mac does nothing for a cloud session.

`scripts/check-environment.mjs` accepts either variable and prints which one
actually carried the key.

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

**Measured, not assumed:** a full `npm test` in this cloud box gave
2,609 pass / 14 fail / 41 skipped of 2,667.

**CORRECTED 2026-09-19 — the attribution below was wrong, and the count was not
reproducible.** This paragraph used to read "Eleven of those 14 are this key:
`nfl-news-events.test.js` (7) and `page-explain.test.js` (4), every one of them
`Connection error.` from the Anthropic SDK." The measurement was real; the cause
was not. Those 12 (not 11 — `page-explain` is 5) failed because both files
called `mock.module('node-fetch', { exports: { default: fn } })`, and `exports`
is not an option `node:test`'s `mock.module()` has. It was ignored, the mocked
default became an empty object, and the SDK failed on
`this.fetch.call is not a function` — which it catches and re-reports as its own
generic `Connection error.`, indistinguishable from a real network fault. Fixed
in `de82ee2` by using `defaultExport:`; both files now pass 8/8 and 7/7 **with
no key present**. They never needed one, and re-running them on the Mac would
have failed identically.

Two further corrections to what this section implied:

- **A key in the environment made the suite fail MORE, not less.** Six tests
  (`model-integrity` 3, `nfl-prospective-collection` 3) assert not-configured
  behaviour and only pass where nobody added a key. `test/offline-guard.mjs`
  now clears provider credentials at `--import` time so a box with keys runs
  the same suite as a box without (`982eb46`).
- **"Nothing else in the suite needs a key or a network" was true of intent,
  not of the run.** With the mock inert, those 12 tests made a real request to
  `api.anthropic.com` every time, on every box — which is what the offline
  guard's RED commit (`cc12a22`) caught by capturing a real Anthropic
  `request_id` from inside the suite.

~~The remaining 3 (`prop-clv-free-capture`) are the genuinely pre-existing
failures and are unaffected by any of the above.~~ **WRONG too, corrected the
same day (`b0c6e4f`).** They were green and detonated at
**2026-09-17T12:00:00Z**: `captureFreePropMarket()` scans a window relative to
`Date.now()` while the fixtures are pinned to absolute dates, so 14 days on they
aged out and the function returned `{skipped:true}` with no `stored` key. Also
`53c408e`, cited as their provenance, **does not exist on any ref in this
repo**, and this file's own archive shows all four passing on 2026-09-10
(`docs/evidence/2026-09-10/slice-final/baseline-suite-before.txt:1248`). Fixed;
5/5, and still 5/5 with the clock faked five years forward.

**The method that produced "pre-existing" is the durable finding.** It was:
check out an older tree, run it, see the same failures. That cannot tell a time
bomb from an old bug — a time bomb fails on every older tree, because what
changed is the date, not the code. It proves *not introduced by this diff*,
never *not introduced by time*.

---

## The checklist

Run this in any box and it names every missing file and key, what specifically
breaks without each, and how to get it:

```bash
node scripts/check-environment.mjs
```

It exits non-zero when something genuinely required is absent, so it works as a
startup gate. It reports keys as present or absent and never prints a value.

Order for a fresh box:

1. Paste the keys into the environment's **Environment variables** box (not API
   credentials — see above), using `GRIDIRON_ANTHROPIC_API_KEY` for the Anthropic
   one. This is the whole setup for a Claude session doing repo work, and it
   clears the only *required* key.
2. **On the Mac:** connect ESPN (bookmarklet), then `node scripts/bootstrap-data.mjs`.
3. **On the Mac:** pull the chat with the Settings button.
4. Only if the app is genuinely being hosted somewhere: move `data.sqlite` and
   the corpus to it, per sections 2 and 3.
5. `node scripts/check-environment.mjs` — it will still report `server/data.sqlite`
   missing in a Claude session, and that is correct and expected there. It is a
   build machine, not somewhere the app runs.

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

It does not put the app *online* — that's WF / Phase 11 in the master plan
(Fly.io, Google sign-in, per-user Claude keys, hiding the chat reading from
other accounts), deliberately scheduled last.

And per the correction at the top, that turns out not to be a separate concern
from this document but **its prerequisite**. "Everything runs in the cloud" in
the sense of the app living somewhere with its scheduler and UI up needs a
permanent address, and a permanent address is exactly what Phase 11 delivers.
What this document buys in the meantime is real but narrower: the keys, the
migration mechanics, and the tooling to move each piece — all of which Phase 11
will need anyway, and none of which has to be redone.
