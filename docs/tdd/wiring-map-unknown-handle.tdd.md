# Two confident defaults that took main red

RED `<this branch's test commit>` · GREEN follows · `test/wiring-map-unknown-handle.test.js`, 8 cases.

## What happened

`scripts/wiring-map.mjs --check` landed on main with #108 and immediately exited
1 on `main` itself, so every PR's CI failed that step regardless of its content.

The gate was baselined against main at `ac31922` and verified on the merge of
the branch with `ac31922`. Nine more PRs landed between that verification and
the squash. GitHub squash-merged onto the new tip without conflict, and the gate
had never run against that combination. **A gate whose baseline is taken at one
tip and landed at another** is the same defect class this branch spent the day
finding, applied to itself.

Three blocking findings. All three were false positives, and each is a default
standing in for an answer nobody computed.

## 1. A database handle passed in as a parameter

`td-features.js` is handed both handles by its caller —
`buildTdFeatures({ appDb, nflDb, seasons })` — and queries the nflverse one as
`nflDb.prepare(...)` at `:188` and `:310`. The file opens no handle of its own,
so it is not a foreign-only file, and `handleFor` fell through to `'app'`.

The map already has the right rule for this: `table-in-another-database`, which
is context and does not gate. `foreignOnly` requires *every* reader and writer
to be on a non-app handle, so two entries wrongly labelled `'app'` were enough
to push `play_by_play` and `pbp_participation` into `table-never-written`.

The fallback's own comment justifies it for **a bare call with no receiver** —
"an unattributed WRITE is the app's by construction". That reasoning does not
reach an *explicit* receiver the resolver simply does not recognise. A named,
unrecognised receiver is unknown, and unknown is not `app`.

**Measured before the change, because the obvious fix was dangerous.** `appDb`
is *also* a parameter and genuinely *is* the app, so naming every unknown
receiver could have suppressed real findings. Across the repository, 24 query
sites use an explicit non-`db` receiver and were attributed to the app.
Simulating the change over the whole model: **exactly two tables move**, and
they are the two that were wrong. `appDb`, `app`, `rdb` and `players` sites
change nothing, because every table they touch is also read through the app's
own handle somewhere else — which is precisely what the `every()` in the
foreign-only rule is for.

After the fix both tables are still reported, as
`context/table-in-another-database`. Reclassified, not deleted.

## 2. A function a job registry calls

`producer-with-no-caller` counts syntactic calls, `name(`. A scheduler job is
registered as `run: refreshLeagueRosters` (`scheduler.js:1299`) and invoked by
the runner as `job.run()`, so the name is never followed by a paren anywhere in
the repository.

This is not baselined and must not be: the rule now joins the two facts the map
already held separately — the function, and `league_rosters` among its 63 job
surfaces. `callSites` counts a registration as a call, because something runs it
on a timer.

It is not a weakening. A name that merely appears in prose, or as the prefix of
a longer identifier (`refreshLeagueRostersLater`), still counts zero, and both
are pinned.

Why now: the producer had a direct caller until #95 moved that work off the
request thread. A real product change turned a rule that had always been
incomplete into a red build.

## Not a finding: the stale accept-list entry

`server/services/cascade-grade.js` prints on every run and does **not** gate:
it is written with `console.log` at `:4076`, outside the `blocking` list, and
the only `process.exit(1)` is at `:4089`. The entry is pre-registered for an
unlanded PR and the code comment above it says to report and never gate, so a
merge-order accident cannot fail a build. It stays.

## The five questions

- **Well built?** Two small changes, each at the one place the wrong answer was
  produced. Neither deletes a finding; one reclassifies to the rule that already
  existed for the case, the other counts a call the rule could not see.
- **Stats or made up?** Measured. 24 candidate sites, exactly 2 tables move,
  2519 findings after. The dangerous version of the fix was simulated over the
  whole model before any line was changed.
- **How do we know?** The map was asked directly which file and line it thought
  the reads were at, rather than the source being guessed from the finding text
  — which is how the first two hypotheses (a `columnFamily` label being read as
  a table) were shown to be wrong.
- **Pointed anywhere else on the platform?** Yes. Any handle obtained as a
  parameter is still unresolved — the fix names it honestly rather than
  resolving it, and following an argument to its call site remains undone. And
  any rule counting `name(` misses every registry-dispatched call, of which the
  job table is one.
- **How does it unify?** Third and fourth instances of one shape: `boot:` made
  reachability answer yes always, `CLOSE_HOPS` made it no at the tail, `'app'`
  made every unrecognised handle the app's, and `name(` made every
  registry-dispatched function uncalled. Each is a single answer standing in for
  a question that was never asked.

## Addendum: the false negative naming the receiver would have bought

Raised by the Evidence Auditor (R52.1(b)) before this was pushed, and it was
right. Calling an unrecognised receiver `'app'` was a false positive you could
see. Calling it by its own name and stopping there is a false **negative** you
cannot: the table is filed as belonging to another database,
`table-in-another-database` is `context`, and the gate does not print context.
A real app table read only through a handle the file was handed would have left
the gate's output without a word. Trading a finding you can see for one you
cannot is not an improvement.

So `unresolvedReceivers` reports the resolver's ignorance with a count and the
list on every run — report, never gate, the same posture the stale accept-list
entries have, and for the same reason: a build that fails on it teaches people
to rename their variable `db`.

On this head, 19 sites:

```
scripts/run-historical-leaderboard.mjs  8 sites  `rdb`
server/services/td-features.js          7 sites  `appDb` (5), `nflDb` (2)
test/model-registry-persistence.test.js 4 sites  `upgradeDb`
```

`appDb` and `nflDb` sitting side by side in the same file is the clearest
statement of what this cannot see: the two handles are told apart only at the
call site of `buildTdFeatures`, and following an argument there is work this map
does not do. The list says so out loud instead of guessing.

Both halves are pinned together: the receiver is not the app, **and** it appears
on the list.

## RED / GREEN

- RED `4bab4fd` — *test: RED — a handle passed in as a parameter, and a function
  a job registry calls*. Verified red at its own tree: 3 pass / 5 fail. Failing
  message: `an unrecognised receiver is named, not claimed as the app` —
  `'app' !== 'nflDb'`.
- GREEN `a997747` — *fix: GREEN — an unrecognised handle is not the app, and a
  registration is a call*. 8/8.
- `ae84ac6` — *test: reverse the assertion that pinned the fallback which took
  main red*, with the old assertion quoted in place.
