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

Refuse before the fetch, with the league named. Quoted verbatim from
`server/services/espn-market.js:80-81` at `9a38670`, the commit that made the
code read this way:

```js
  if (!lg.espn_s2 || !lg.swid) throw new EspnMarketCredentialsMissing(leagueRowId, lg.league_id);
  headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
```

`EspnMarketCredentialsMissing` is defined in this file on purpose, and the
name is deliberately distinct from the shared resolver's
`EspnCredentialsMissing` (`platform/espn-credentials.js`, PR #48) rather than
merely different: two classes exported under one name cannot be told apart by
a `catch`, which is the fault §1 measures. The shared resolver is not on main
and this refusal must not wait on it. **Adopting the resolver is not a
one-line swap** — what it actually costs is measured in §1 and stated in §3,
and anyone planning that work should read §3 before budgeting for it.

Against the previous commit on this branch the only observable difference is
`err.name`. The message is byte-identical, the status is still 409, and the
constructor and `leagueRowId` are unchanged. So this is not "nothing moves":
the one thing that moves is the one thing the change exists to move, and a
changed name in a log is deliberate.

`espnMarketFreshness` now answers `collected`, `as_of` and a `label` from the
table's **own** stamps — never a job log. A job that ran and wrote nothing, or
wrote and rolled back, leaves a log entry and no rows, so the only honest
answer to "how fresh is this market" is the newest `fetched_at` actually in it.
"Never collected" and "collected and stale" are different sentences leading to
different decisions, so they are different states rather than one empty value.

## RED, by injection — five, each verified applied

**Re-measured at `943d2c5`, this branch's head.** The first version of this
section was measured when the test file held six cases; `0055a89` added two
more, and nothing here said which commit the numbers came from. A pass/fail
count is the evidence that an injection is caught, and with two extra cases the
counts move even where the same injection is still caught — so a stale number
is worse than no number, and labelling it would have preserved a figure the
reader cannot use. It is a six-second run. It was re-run.

Run on a clean committed tree; the harness refuses to start on a dirty one.
Base: `server/services/espn-market.js` at SHA-256 `4e40b94591c0`. Each row
applied **alone** from that base and restored before the next, with the file
hashed before and after, because a pattern that silently matches nothing
reports as a pass and records a row as caught when nothing was mutated.

| row | injection | after | +/- | pass / fail of 8 | caught by |
|---|---|---|---|---|---|
| e1 | restore the original: fetch anyway when there is no pair | `e0981665d728` | 1+ 2- | 4 / **4** | 1, 2, 3, 4 |
| e2 | accept half a pair (s2 alone is enough) | `b7059ac551b6` | 1+ 1- | 7 / **1** | 4 |
| e3 | throw after the fetch instead of before it | `0bd3a7d3b1cc` | 4+ 4- | 6 / **2** | 2, 4 |
| e4 | report collected whenever the query returns a row | `94dcb22e5da8` | 1+ 1- | 6 / **2** | 3, 6 |
| e5 | fall back to a plausible as-of when the table is empty | `64aff9036262` | 1+ 1- | 7 / **1** | 3 |

All five APPLIED — five distinct after-hashes, none equal to the base.

**NO-OP CONTROL** `f104d9f6dfb0`: a comment appended to the `syncEspnMarket`
signature line. Applied, 8 / 0. A real edit that changes no behaviour reports
green, so a green row means the edit landed and broke nothing rather than that
nothing was edited.

**KILL CONTROL** `250094348c4f`: `syncEspnMarket` returns `{ written: 0 }`
immediately. Applied, 0 / **8** — every case in the file. These tests can fail.

Tests named by title, not ordinal: 1 *a league with no cookie pair is refused,
by name*; 2 *and no request is made at all*; 3 *and nothing is written, so the
board still says never collected*; 4 *half a pair is not a pair*; 5 *a league
WITH cookies still syncs, and sends them*; 6 *once a row exists the freshness
reads the table, not a job log*; 7 *the label names whose market it is, because
the table can only hold one*; 8 *rows from before this record existed say so
rather than guessing*.

### Exact text, per row

e1, the defect itself, restored:

```js
-  if (!lg.espn_s2 || !lg.swid) throw new EspnMarketCredentialsMissing(leagueRowId, lg.league_id);
-  headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
+  if (lg.espn_s2 && lg.swid) headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
```

e2, half a pair accepted:

```js
-  if (!lg.espn_s2 || !lg.swid) throw new EspnMarketCredentialsMissing(leagueRowId, lg.league_id);
+  if (!lg.espn_s2) throw new EspnMarketCredentialsMissing(leagueRowId, lg.league_id);
```

e3, the throw moved below the request — the four-line block is reordered, the
throw line moving from above `headers.Cookie` to below the `await fetch`.

e4, `collected` from the row's existence rather than its count:

```js
-  const collected = (r?.n ?? 0) > 0;
+  const collected = !!r;
```

e5, an as-of invented when the table is empty:

```js
-  return { ...r, collected, as_of: r?.fetched_at ?? null, source, label };
+  return { ...r, collected, as_of: r?.fetched_at ?? new Date().toISOString(), source, label };
```

e3 is the one worth reading: throwing *after* the request still refuses, still
writes nothing, and is still wrong — an unauthenticated request left the
process. Test 2 catches it by asserting on the recorded call list rather than
on the outcome, which is why `fetch` is a counting stub here and not a module
mock. e2 and e3 both redden test 4 by different routes, which is how a guard
with two ways past it looks in a table.

## GREEN

At `943d2c5`:

```
test/espn-market-refuses-anonymous.test.js
# tests 8   # pass 8   # fail 0
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
tests.** At `0055a89`, the commit before the rename, they depended on the
class identity three times: `err instanceof EspnCredentialsMissing` at
`test/espn-market-refuses-anonymous.test.js:74`, and
`assert.rejects(..., EspnCredentialsMissing)` at :111 and :112. Those three
sites are still there at the same line numbers in the current tree; they now
name `EspnMarketCredentialsMissing`, which is what this change did. The shape that
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

## Numbers, and the commits they were measured on

Every figure in this file, with the commit it was taken on. A figure ages into
a document unless something re-points it, so the commit is part of the figure.

| figure | value | measured at |
|---|---|---|
| this file's suite | 8 tests, 8 pass, 0 fail | `943d2c5` |
| five injections + two controls | table above, base hash `4e40b94591c0` | `943d2c5` |
| full `npm run check` | **2,958 tests · 2,917 pass · 0 fail · 41 skipped**, exit 0, 875 JS files syntax-checked, build 3.10s, `start:smoke` passed, zero `not ok` | `9a38670` |

**Why the full-check figure taken at `9a38670` honestly describes `943d2c5`.**
`943d2c5` is a documentation-only commit:
`git diff --stat 9a38670 943d2c5 -- server test scripts client fly.toml package.json`
is empty, so the code tree is byte-identical. And no stage of `npm run check`
reads `docs/` — checked stage by stage rather than assumed:

- `typecheck` is `tsc --noEmit` and `tsconfig.json`'s `include` is `["client/src"]`;
- `lint` is `scripts/lint.mjs`, whose `roots` are `['server', 'scripts', 'test']`
  and which collects only `.js` and `.mjs`;
- `test` globs `test/*.test.js`, and no test reads a file under `docs/` from
  disk — several name a docs path, every one of them inside a comment;
- `build` is `vite build --config client/vite.config.ts`;
- `start:smoke` boots the server.

So a documentation commit cannot move that number, and reusing it is a fact
about the check rather than an assumption about the commit. If a later commit
on this branch touches any path above, the figure has to be re-measured and
this table updated — that is the condition, stated so the next reader can test
it rather than trust it.

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
