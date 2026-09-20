# TDD evidence: the ESPN market sync read anonymously and wrote it down as a league's own

**Change.** `claude/project-thread-5f9c3y-espn-market-auth-hold`, off `791b131`.
One commit plus this file. Found by the scheduler thread's read of PR #50
against main; verified here against the code before acting.

**Merge order: this must land before #50.**

## Defect

`server/services/espn-market.js`:

```js
  const headers = { ...BROWSER_HEADERS, 'x-fantasy-filter': JSON.stringify(filter) };
  if (lg.espn_s2 && lg.swid) headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
  const url = `${BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}?view=kona_player_info`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
```

The cookie header is set when it can be and the request goes out either way.
ESPN answers a bare request — with a thin **public** payload — and the loop
below writes it into `espn_player_market` with `fetched_at` set to now.

The module's own docstring says the fetch is "from the league's own URL so
`appliedTotal` is in the league's scoring". An unauthenticated read cannot
deliver that, and nothing downstream can tell the two apart afterwards: the
row shape is identical and the stamp is fresh. The draft board would say
"collected, minutes ago" over public ADP.

**Why it has not bitten yet, and why that ends.** Nothing on `main` imports
this module; `syncEspnMarket` has no caller at all (recorded separately in
`docs/tdd/consensus-season.tdd.md`). PR #50 registers `refreshEspnMarket` on
the growth tier at `scheduler.js:1216`, 12-hourly — the first deployed writer
of that table. From that merge, every league without stored cookies would have
public ADP and ranks written as its own market twice a day.

## Fix

Refuse before the fetch, with the league named:

```js
  if (!lg.espn_s2 || !lg.swid) throw new EspnCredentialsMissing(leagueRowId, lg.league_id);
  headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
```

`EspnCredentialsMissing` is defined in this file on purpose. The shared
resolver (`platform/espn-credentials.js`, PR #48) is not on main, and this
refusal must not wait on it; when #48 lands the throw site is a one-line swap
to `credentialsForLeague` and the local class goes.

`espnMarketFreshness` now answers `collected`, `as_of` and a `label` from the
table's **own** stamps — never a job log. A job that ran and wrote nothing, or
wrote and rolled back, leaves a log entry and no rows, so the only honest
answer to "how fresh is this market" is the newest `fetched_at` actually in it.
"Never collected" and "collected and stale" are different sentences leading to
different decisions, so they are different states rather than one empty value.

## RED, by injection — five, each verified applied

Run on a clean committed tree; the harness refuses to start on a dirty one.

```
### e1 restore the original: fetch anyway when there is no pair  APPLIED 1+ 2-   # pass 2 # fail 4
### e2 accept half a pair (s2 alone is enough)                   APPLIED 1+ 1-   # pass 5 # fail 1
### e3 throw after the fetch instead of before it                APPLIED 1+ 1-   # pass 4 # fail 2
### e4 report collected whenever the query returns a row         APPLIED 1+ 1-   # pass 4 # fail 2
### e5 fall back to a plausible as-of when the table is empty    APPLIED 1+ 1-   # pass 5 # fail 1
```

e1 is the defect itself. e3 is the one worth reading: throwing *after* the
request still refuses, still writes nothing, and is still wrong — an
unauthenticated request left the process. The test that catches it asserts on
the recorded call list rather than on the outcome, which is why `fetch` is a
counting stub here and not a module mock.

## GREEN

```
test/espn-market-refuses-anonymous.test.js
# tests 6   # pass 6   # fail 0
```

Test 5 is the control: a league **with** cookies still syncs and still sends
them, so a refusal that broke the working path could not pass.

## Two things found while verifying, neither fixed here

1. **`espn_player_market` is not per-league, despite the docstring.** Its
   primary key is `espn_id` alone (`db/schema/core-and-fantasy.js:596`), so
   syncing league A and then league B overwrites A's league-scoped
   `appliedTotal` with B's. The table describes itself as ESPN's market "per
   league" and cannot hold more than one. Fixing it is a migration on a shared
   schema file and a decision about whether the board wants one market or
   several — routed, not taken.

   **The interim, which IS in this change.** A successful sync records the
   league it read (`app_settings.espn_player_market_source`), and the freshness
   label says so: *"ESPN market: as collected for league &lt;id&gt;, &lt;as_of&gt;"*.
   A reader can no longer take league A's ADP for league B's without the page
   saying whose it is. Rows written before that record existed are a third
   state and say *"which league's sync wrote these rows is not recorded"*
   rather than being labelled with the most recent league, which would be a
   fabrication — the one thing worse than not knowing. This is a label, not a
   fix: the overwrite still happens until the table is keyed per league.
2. **Nothing imports this module on main**, so the board's heaviest weighted
   market input (ESPN 2, FFC 1, Sleeper 1) reads a table with no writer. #50
   is the fix for that half; this change makes sure what it writes is real.

## Three findings from the Google sign-in thread, read against #48

That thread owns `platform/espn-credentials.js` and read this branch against
#48. Zero shared files, so mechanically clean. Three findings, all of which I
re-verified against both branches' source rather than taking on report, and all
three hold.

### 1. One exported name over two incompatible classes — FIXED HERE

`platform/espn-credentials.js:37` on #48 exports a class called
`EspnCredentialsMissing`. So did this module, at `espn-market.js:29`. They are
not interchangeable:

| | theirs (#48) | this module's (before) |
|---|---|---|
| constructor | `(message)` | `(leagueRowId, leagueId)` |
| carries | `code: 'espn_not_connected'` | `leagueRowId` |
| `status` | 409 | 409 |
| `instanceof` the other | false | false |

A catch block written against one and reached by the other does not match. It
falls through to whatever handles an unrecognised error, which turns a 409 the
caller could act on — connect ESPN, then sync again — into a 500 it cannot,
with nothing in any log to say a credential was the problem.

**The collision was live, not latent, and the proof is in this branch's own
tests.** They depend on the class identity three times: `err instanceof
EspnCredentialsMissing` at `test/espn-market-refuses-anonymous.test.js:74`, and
`assert.rejects(..., EspnCredentialsMissing)` at :111 and :112. The shape that
would silently miss is one already written here twice, before any other caller
exists. An earlier version of the comment above the class said it "can go when
the resolver lands", which is an intent; the collision was exported anyway,
which is the mechanism. An intent is not a mechanism.

Renamed to `EspnMarketCredentialsMissing`, `this.name` with it, `status` left
at 409 so no behaviour moves. Nothing imports both today, so nothing was broken
yet — a name that is already wrong and not yet harmful is the cheapest moment
to change it.

### 2. After #48 this guard refuses a league the resolver could serve

`credentialsForLeague` reads the `leagues` row first, and when its pair is bare
falls back through `league_memberships JOIN espn_credentials` to a connected
member, commissioner first then lowest user id. The guard in this module reads
only `lg.espn_s2 || lg.swid` off the `leagues` row.

So once #48 is on main there is a league this module refuses that the resolver
could have served: a bare `leagues` row whose commissioner is connected.

That is a **false refusal, not a leak**. It declines to fetch rather than
fetching wrongly, so it is strictly safer than the anonymous read it replaces —
which is the whole defect this branch exists to fix. And it is inert today only
because `syncEspnMarket` still has no caller anywhere in the repository.

**It is acceptable only while that stays true.** Wiring a caller to this module
means doing the resolver swap in the same change, not after it. A caller plus
this guard is a sync that refuses leagues it should serve, and the person who
sees it will read "no stored ESPN cookies" and go looking at the league row,
which is the one place the answer will not be.

### 3. What the resolver swap actually costs

An earlier comment here said the throw site becomes "a one-line swap to
`credentialsForLeague`". True of the line, false of the change.

Four of this module's eight tests are written against a bare or half `leagues`
row, and a bare row stops being a refusal case on the day the resolver lands —
it is a refusal only when no member is connected either. Those four do not
survive the swap unchanged; they change meaning:

- `a league with no cookie pair is refused, by name`
- `and no request is made at all`
- `and nothing is written, so the board still says never collected`
- `half a pair is not a pair`

And a fifth case appears that **cannot be written today**, because the join it
needs does not exist on main: a bare row with a connected member, which must
sync on that member's pair and report `source: 'member'`.

So the swap is one line of source, four rewritten tests and one new one. The
comment now says that, because a comment that under-quotes the cost of a change
is how the change gets scheduled into an afternoon that cannot hold it.

## The five questions

- **Is it well built?** It refuses in the place the decision is made, before
  any side effect, and names the league so a caller can act on it.
- **Stats, or made up?** Neither is being computed. The point is the opposite:
  stopping unlabelled public numbers from entering as measured league ones.
- **How do we know?** Five applied injections, all biting; the strongest test
  asserts no request was made at all, not merely that the answer was discarded.
- **Should this data point anywhere else?** Yes — `espnMarketFreshness`'s
  `label` is built for the draft board's market block
  (`draft-assist.js:585`), which is another thread's file; the one-line read is
  routed there.
- **How does it unify?** It puts this module on the same footing as the rest of
  the app's credential reads: a league that cannot be read says so, rather than
  quietly becoming a league with different data.
