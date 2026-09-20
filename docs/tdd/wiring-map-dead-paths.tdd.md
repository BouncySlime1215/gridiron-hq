# Four things this app recorded and never showed, and one it showed twice

2026-09-20. Scheduler thread. Branch `claude/project-thread-o3wt2p-growth-offthread`.

The wiring map's sweep handed this thread six findings across six files. Two of
them were wrong, and saying which is most of the value here — a scan that
reports dead code is only useful if somebody checks before deleting.

## Finding 3 was wrong, and acting on it would have broken two live paths

> `server/scripts/run-nfl-ai-replay.js` and `sync-history.js` are imported by
> nothing: delete or name the caller.

Both halves are false in the only sense that matters.

- `run-nfl-ai-replay.js` is spawned at `server/services/nfl-ai-replay.js:376`:
  `fork(new URL('../scripts/run-nfl-ai-replay.js', import.meta.url), [String(id)],
  { detached: true, stdio: 'ignore', execArgv: [] })`. It is the detached worker
  the AI replay feature runs its reconstruction in.
- `sync-history.js` is `package.json:27`, the `sync:history` npm script.

Neither is reached by an `import`, which is exactly why an import-graph scan
called them orphans. **"Imported by nothing" was true of both and meant
nothing**: a `fork()` by URL and an npm script are entry points. Nothing was
deleted; the rule is being re-run with those as roots.

## Finding 1: four uncalled routes on `/api/dev`, and they are not alike

Confirmed uncalled, by grepping `client/src`, `scripts` and `test` for each
path: `/dev/usage`, `/dev/sources`, `/dev/player-identity/gsis-conflicts`,
`/dev/player-identity/team-position-duplicates`. (`/dev/player-identity/repair-plan`
is called — `DevHub.tsx:228`, the "Run dry-run" button.)

**One of them was a duplicate and is gone.** `GET /dev/usage` answered
`usageSummary(Number(req.query.days) || 30)`, and `GET /dev/status` has always
answered `usage: usageSummary(30)` — the same call, the same default. The only
thing the second route added over the first was the `?days=` parameter, which
is the "one parameter never passed at :58" the finding also names. It is the
same defect twice, and deleting the route removes both.

**The other three are kept, on purpose.** Deleting a read-only diagnostic
because nothing calls it today is how an install loses the tool in the hour it
needs it. None of them writes anything. `/dev/sources` in particular is the
only inventory in the app of every source with its staleness — it is already
the answer to the question Finding 7 asks, which makes "nothing calls it" an
argument for wiring a page to it, not for deleting it.

What an uncalled route is genuinely at risk of is rotting unwatched, so all
four surviving diagnostics are now exercised by `test/dev-routes.test.js`.

## Finding 2: fields attached and never read

Three of these, and they are the same shape as the restart loop this thread has
been fixing all night: something is maintained carefully and read by nobody.

**`scheduler.js`, `refreshLeagueRosters` — the one with a consequence.** Each
league paused for a live draft pushed `{ ok: true, skipped: true }`, and the
return read only `leagues` and `failed`. So a sweep that touched nothing
recorded `{ leagues: 7, failed: 0 }` — **character for character what a sweep
that synced all seven records.** That object is the `sync_log` detail and
`schedulerStatus()` serves it verbatim, so the single case where this job
deliberately does no work was the single case no reader could see. It now
reports `skipped` and `synced` alongside `failed`, and the three partition the
league set. Same contract as `league-transactions.js`, which separates them for
the same reason: a skip and a success are not the same event, and only a
failure should back a job off.

**`platform/jobs.js` — a status surface with no reader at all.** The module
maintains `status`, `lastRunAt`, `lastError` and `runCount` on every tick.
`registerJob` has two callers (`routes/drafts.js`: the draft auto-pick clock
and the finalize watch). `jobStatus` and `listJobs` had **none**. The module's
own header said this was "what the Dev Hub's background job status ... actually
need", which was not true of the code. The field that mattered is `lastError`:
a draft auto-pick clock could fail on every tick, during a live draft, and say
so to nobody. `GET /dev/status` now serves `listJobs()`, so the header's claim
is true, and the header records that it was not.

**`cancelJob` wrote a status nothing could observe.** `state.status =
'cancelled'` was set on an object dropped from the map on the very next line.
No reference survived, so `jobStatus(name)` answered `null` from then on and
the value existed only to be believed later. Removed; a cancelled job is
visible by its absence, which is the honest signal.

**`paths.js:67`, `:70` — two unused helpers, removed.** `dataPath()` and
`docsPath()` were `path.join` wrappers with no caller in `server`, `client`,
`scripts` or `test`. The argument for keeping an unused export in that module
is its own header — it exists so a packaging test can ask where things resolved
to — but that argument is discharged by `resolvedRoots()`, which names every
root and is walked by the module's test. It does not extend to two wrappers
that answer nothing `DATA_ROOT` and `DOCS_ROOT` do not, and both roots are
still exported.

**Correction to this thread's own earlier report.** It said `MIGRATIONS_ROOT`
and `EVIDENCE_ROOT` also had zero callers. Wrong: both are named inside
`resolvedRoots()` in the same file. A grep that excludes the defining module
hides same-module use, which is the same class of error as Finding 3.

## Finding 2, the part not acted on: `db/preflight.js:268`

> a table never read

`schema_preflight` has no *runtime* reader, which is true. It does have a
reader: `test/migration-027-populated-upgrade.test.js:332` and `:340`, which
assert the ledger is unchanged across a second preflight — the idempotence
proof. And it is a forensic record of repairs applied to the one class of
damage a migration cannot fix from inside its own transaction. **A ledger
nothing reads at runtime is what a ledger is.** Not deleted, and not
surfaced either, because surfacing it means picking a surface and that decision
is not this thread's to make alone.

## Finding 4: the availability fit stays a run-sheet script

`nfl_availability_rates` / `nfl_availability_role_rates` are hand-fed by
`scripts/fit-availability.mjs`, which looks like the same shape as the
collector. It is not, and the difference is the deciding one.

The collector moved into the registry because **its source window closes**:
ESPN answers with about three days and then the rows are gone for good, so a
missed run is unrecoverable, and that is what forces a cadence.
`fit-availability.mjs` reads data already in this database. A missed run loses
nothing and can be repeated at any time.

**Recoverability settles whether something needs a timer.** That it reprices
three live consumers is why Nick should choose when it runs — it is not why it
needs a schedule.

## RED / GREEN

Ten injections, one per guarded rule, each **hash-verified as applied** before
its run. Baseline across both new test files: **9 pass / 0 fail.**

| # | Injection | File | Result | Caught by |
| --- | --- | --- | --- | --- |
| 1 | `skipped`/`synced` dropped from the report | scheduler.js | 6 / 3 | all three roster tests |
| 2 | A pause counted as a failure | scheduler.js | 8 / 1 | a sweep paused by a live draft reports the pause |
| 3 | `synced` counts the paused leagues too | scheduler.js | 8 / 1 | same |
| 4 | Duplicate `/dev/usage` restored | dev.js | 8 / 1 | the duplicate usage route is gone |
| 5 | `background_jobs` not served | dev.js | 8 / 1 | /dev/status serves the background job status |
| 6 | Job internals serialized into the response | jobs.js | 8 / 1 | same |
| 7 | Cancelled jobs linger with a status | jobs.js | 8 / 1 | a cancelled job is visible by absence |
| 8 | `/dev/sources` deleted | dev.js | 7 / 2 | the uncalled diagnostics still answer; the sources inventory |
| 9 | An identity diagnostic deleted | dev.js | 8 / 1 | the uncalled diagnostics still answer |
| 10 | `dataPath` restored | paths.js | 8 / 1 | paths.js exports the roots, and no unused join helpers |

Injection 1 is the one that says the fix is real: deleting the two new fields
takes all three roster tests down, because without them a paused sweep and a
completed sweep are the same object.

One test harness bug, fixed rather than worked around: `reset()` deleted
leagues before drafts, and a trigger refuses to delete a league with draft
history. It failed on the second test rather than the first, which is how a
harness error looks like a code error.

## Nick's five questions

**Is this well built?** It is subtraction plus one reader. Nothing new is
computed; two duplicates are removed, one dead write is removed, and three
already-maintained fields are given somewhere to be seen. Ten injections say
each rule holds.

**Is this based on stats, or is it made up?** Neither — there is no estimate in
any of it. Every claim is a grep or a run: which paths the client calls, which
functions have callers, what the two return objects actually contain.

**How do we know?** Uncalled-ness was established per path across `client/src`,
`scripts` and `test`, and the two orphan-script claims were checked against the
`fork()` call site and `package.json` rather than against the import graph that
produced them. The roster fix is demonstrated by a test that builds a live
draft row and shows the two results are no longer equal. **What is not known:**
whether any of the four diagnostics has ever been called by hand — there is no
access log — so "uncalled by code" is what is claimed, not "unused by Nick".

**Should this data be pointed anywhere else on the platform?** Yes, and one is
now named rather than guessed at: `/dev/sources` already computes the per-source
staleness that Finding 7 says nothing surfaces. Wiring a page to it is a client
change and belongs to the thread that owns client pages. `background_jobs` is
the same: served now, rendered by nobody yet.

**How does it unify?** `refreshLeagueRosters` and `collectLeagueTransactions`
now report the same way — leagues, synced, failed, skipped, with reasons — so
the two ESPN sweeps can be read side by side instead of each having its own
idea of what a result is.
