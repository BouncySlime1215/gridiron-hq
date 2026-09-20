# The ESPN transaction collector becomes a scheduled job

2026-09-20. Scheduler thread. Branch `claude/project-thread-o3wt2p-growth-offthread`.

## What was wrong

`league_transactions_raw` had exactly one writer in the tree:
`scripts/collect-league-transactions.mjs`, which created the table itself at
`:21` and upserted at `:34`. It was reachable from one place,
`scripts/refresh-live-data.mjs:99`, which spawns it as a child process — and
that refresh loop runs on Nick's machine. `Dockerfile:25` is
`CMD ["node", "server/index.js"]` and `fly.toml` declares no other process, so
**nothing on the deployed app has ever written that table.**

Six server modules read it, and none of them writes: `manager-archetypes.js`,
`manager-signals.js`, `bluff-detector.js`, `counterparty-pricing.js`,
`trade-engine.js`, `trade-tactics.js`. Every manager read, archetype and
counterparty price on the live app is computed from whatever a hand-run last
left behind.

That is worse than ordinary staleness, and the repository already said why, in
`refresh-live-data.mjs:96` — a comment written by whoever added the call:

> ESPN only answers with the last ~3 days, so this must run every tick or the
> proposals are lost.

A window that closes after three days leaves nothing to catch up on. A proposal
that was not observed inside it is gone from the source permanently. So the gap
is not "the numbers are old", it is "the evidence was never collected", and no
later run repairs it.

It also fails silently in both directions. The reads succeed, the numbers come
out, nothing reports an age, and a failed hand-run is invisible unless somebody
reads the terminal it was typed into.

## Why not the two options that were on the table

The decision was framed as **a second Fly process on a schedule** versus **a
cron on Nick's machine**. Both are wrong, on evidence in this repository.

- **A cron on Nick's machine** is a data-loss design, not a cheaper option.
  The window is three days and it closes for good; a laptop that is asleep,
  travelling or off does not lose freshness, it loses rows.
- **A second Fly process group cannot see the database.** `fly.toml` on
  `791b131` has one `[[mounts]]` (`gridiron_data` -> `/data`) and no
  `[processes]` section. A process group is a separate machine, and the single
  volume carrying `data.sqlite` attaches to one. The second group would run
  against no database at all.

The work itself is ordinary registry work — a `fetch` per league and an upsert.
It lived in a script only because it predates anyone putting it in the
registry.

## What was built

| Piece | File |
| --- | --- |
| The table, as real schema | `server/migrations/066_league_transactions_raw.js` |
| The body | `server/services/league-transactions.js` |
| The registration | `server/services/scheduler.js`, `JOBS.league_transactions` |
| The hand-run, now a wrapper | `scripts/collect-league-transactions.mjs` |
| The tests | `test/league-transactions-job.test.js` |

**Migration number 066.** Enumerated across every remote branch, not guessed:
`062` ×3 (the known landed duplicates, exempt in
`scripts/migration-name-check.mjs:75`), `063` = `espn_credentials` (#48),
`064` = `league_history_tables` (#47), `065` = `outlook_fit_store` (fantasy
plan). Nothing renumbered. `down()` deliberately does **not** drop the table:
every row in it is outside ESPN's window and has no source to come back from.

**Metered tier, off-thread, 30 minutes.** Metered rather than live because
three days of window against 30 minutes is two orders of magnitude of headroom,
and what is being metered is not a paid API but Nick's own ESPN session.
Off-thread because the body is a `fetch` followed by a synchronous
`BEGIN`/upsert/`COMMIT` over every row in the window, which is exactly the
shape that holds the request thread, and `node:sqlite`'s `DatabaseSync` offers
no way for it not to.

**What "off-thread" does and does not buy.** `job-worker.js` is a
`node:worker_threads` worker, not a child process. It gets its own module graph
and its own `DatabaseSync` handle, and it exits when the job returns. It
isolates the **event loop** and nothing else: it is the same process, so an OOM
kill or the loop watchdog still takes the whole app down with it.

**The live-draft gate.** `liveDraftActive()` is evaluated at the registry entry
and passed in, so the gate has one definition. This is the 2026-09-06 finding
recorded in `scheduler.js`: the hourly league sweep hit ESPN with the same
`espn_s2`/`SWID` Nick's browser was drafting on, and ESPN treated it as
concurrent use of one session. Against a three-day window, waiting out a draft
costs nothing. The wrapper script deliberately has **no** gate — that gate
protects Nick from a server sweep colliding with a draft he is in, and a
hand-run is him, at a keyboard, able to see his own draft.

## The credential seam, and why it is a seam

The instruction was to resolve credentials through
`server/platform/espn-credentials.js` and never fall back to a global cookie.
**That module is PR #48 and is not on this branch or on `main`** — it exists
only on `f377a09`. Importing it would mean stacking this work on #48.

Its interface is more than sufficient: `credentialsForLeague(leagueRowId)`
returns `{ s2, swid, source, userId }` or nulls, with a throwing variant and an
`EspnCredentialsMissing` error type. **The interface is not the problem; its
absence from this base is.**

So `leagueOwnCredentials` implements **rule 1 of that resolver and nothing
else** — the league's own stored pair — behind an injectable parameter whose
contract is already that function's shape: `{ s2, swid, source }`, nulls for
"none", never a throw, never a fallback. When #48 lands, the default is
replaced by `credentialsForLeague` and rules 2 and 3 arrive with it. Nothing
else in the file changes. `espn-credentials.js` is not edited.

Note that rule 1 is also exactly what the script already did, so this move
changes nothing in the direction that would matter: it has never reached for
another league's cookies and it does not start now.

**What did change is the failure.** The script's query was
`WHERE espn_s2 IS NOT NULL AND swid IS NOT NULL`, so an unconnected league was
not skipped — it was never in the list. Invisible, and indistinguishable from a
league with nothing to collect. Now it is a named reason on the result, because
an uncollectable league inside a three-day window is something a person has to
be told about while there is still time to connect it.

## RED / GREEN

Retroactive RED by mutation, per `CLAUDE.md`. Eleven injections, one per
guarded rule. Each was **hash-verified as applied** before its run — a silent
no-op injection reads as a green sweep, which has already happened twice on
this branch. Every injection below changed the file's md5.

Baseline: **9 pass / 0 fail.**

| # | Injection | File | Result | Test that caught it |
| --- | --- | --- | --- | --- |
| 1 | Registry entry removed | scheduler.js | 8 / 1 | the job is registered, metered, off the request thread, with a cadence |
| 2 | Tier moved `metered` → `live` | scheduler.js | 8 / 1 | same |
| 3 | `offThread` flag dropped | scheduler.js | 8 / 1 | same |
| 4 | Unconnected leagues filtered out of the query (the old `WHERE`) | league-transactions.js | 8 / 1 | a league with no stored credential is reported, not silently dropped |
| 5 | Credentials taken from the first league with a pair | league-transactions.js | 7 / 2 | that one, and each request carries that league's own cookies and never another's |
| 6 | Seam returns `null` instead of the nulls shape | league-transactions.js | 7 / 2 | that one, and the credential resolver is a seam with the same shape as the real one |
| 7 | Live-draft gate deleted | league-transactions.js | 8 / 1 | a live ESPN draft stops every request this job would make |
| 8 | `first_seen_at` overwritten on conflict | league-transactions.js | 8 / 1 | a second run updates the row in place and keeps when it was first seen |
| 9 | A failure counted as a skip | league-transactions.js | 8 / 1 | one league failing does not stop the others, and is counted as a failure |
| 10 | `CREATE TABLE` put back into the service | league-transactions.js | 8 / 1 | the service creates no schema and sets no environment |
| 11 | Script's summary line reshaped | collect-league-transactions.mjs | 8 / 1 | the script is a wrapper over the same body, and keeps the line the refresh loop parses |

Injection 11 is the one worth naming. `refresh-live-data.mjs`'s
`transactionsCapture` reads `/failed (\d+)/` off the **last** output line to
decide whether to print `ok` or `ERROR`. Reshaping that line does not break the
refresh loop loudly; it turns every failed collection into a reported success.

One test needed rewriting rather than accepting. The "creates no schema"
assertions first matched raw file text, and failed on the module's own comment
explaining why it does not create the table — which means they would have
passed on a file that deleted the explanation and kept the statement. They now
strip comments and assert on code.

## Ordering: this cannot run yet, and that is not this PR's fault

The metered tier runs on the background interval, which `server/index.js:75`
sets to 5 minutes. **No life of the app has reached five minutes since
22:53Z** — it is restarting roughly every three minutes. So this job cannot
fire at all until the restart cycle is stopped. It merges after step 1 of the
morning block (`SCHEDULER_DISABLED=1`, the fix stack, the unset); merged
before that, it is correct and inert.

## Nick's five questions

**Is this well built?** The mechanism, yes — it is the registry every other job
uses, and eleven injections say the rules are load-bearing rather than
decorative. One part is explicitly provisional and labelled: the credential
resolver is rule 1 behind a seam, because the real resolver is on a PR that is
not merged.

**Is this based on stats, or is it made up?** Neither — it is plumbing, and it
invents no number. The one quantity it depends on is ESPN's ~3 day window, and
that is **measured, not assumed**: the original collector's header records a
real read of 132 rows spanning 2026-09-15 → 09-17, including 36
`TRADE_PROPOSAL`, 9 `ACCEPT`, 6 `DECLINE` and 4 `VETO`. The 30-minute cadence
is a choice with two orders of magnitude of margin against that window, not a
fitted value.

**How do we know?** The writer/reader asymmetry was established by grepping for
writes against the table, for the script's callers, and for the container's
entrypoint — not inferred from the job list, since a job list cannot show a
table nobody writes. The migration was verified to apply and create the table
on a fresh database. What is **not** known: whether the live table is currently
empty or merely old. Nobody has read it on Fly, and this branch does not
(overnight rule: no live DB reads or writes). That is a real gap — it decides
whether the six consumers are pricing off thin data or no data.

**Should this data be pointed anywhere else on the platform?** Yes, and it is
already the answer to an open item. Finding 7 asks how anybody would know these
rows are stale: nothing on any surface shows an age for them. `last_seen_at` is
now maintained on every row by a job with a cadence, which is the first time
that question has had a column to read. The as-of surfacing itself belongs to
Trade Brain and chat sync, whose files those are, and is not done here.

**How does it unify?** It removes a second way of doing things rather than
adding one. There was a registry for scheduled work and one job that sat
outside it in a script; now there is one body with two callers, one `sync_log`
row shared between them — the arrangement `manager_signals` already has with
`scripts/build-manager-signals.mjs` — and one credential rule with one place to
change it.

## Not done, deliberately

- `espn-credentials.js` is not imported and not edited. It is not on this base.
- No live database was read or written. No `flyctl`.
- The as-of surfacing for the six consumers belongs to other threads' files.
- Whether the live `league_transactions_raw` is empty or stale is unanswered.
