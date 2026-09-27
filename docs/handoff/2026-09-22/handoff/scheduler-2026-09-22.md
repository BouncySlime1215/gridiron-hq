# Handoff — Scheduler thread, 2026-09-22

Written at 18:10Z, on `origin/main` **c90d2834**. Everything below was read off
a tree or a tool result, not recalled. Where a number came from a relay rather
than from something I ran, it says so.

---

## THREAD

**Scheduler.** The scheduler, its job registry, which thread each job runs on,
what the boot pass and the timers actually fire, and the honesty of what a job
reports when it does nothing.

Designated branch prefix: `claude/project-thread-o3wt2p-*`. Thirty-four exist
on the remote; the ones that matter are named under OPEN and FINDINGS. The rest
are merged or superseded.

---

## SHIPPED

Merged by this thread today, with the merge sha, each read from the merge
rather than assumed:

| PR | What | Merge sha |
| --- | --- | --- |
| #95 | live-tier jobs off the request thread | `eb861feb` |
| #112 | depth-chart zero-row guard, pinned | `a1e661fc` |
| #119 | a growth cycle whose download threw stops reporting itself as ok | `f620a120` |

Other PRs merged into main today came from other threads or from the
coordinator's merge round; the board in project memory is the record for those,
not this file.

**#119 carries a defect found after it merged** — see FINDINGS.

---

## OPEN

### MLB removal — `claude/project-thread-o3wt2p-remove-mlb`, PR #128

Head `8e2667bc` at the time of writing, base `main`, draft, **not yet pushed**
past `e6631e4b` (the census). The full gate is running on `8e2667bc`; the head
and exit codes go to the coordinator the moment it returns.

What it does: removes MLB from the product on Nick's word ("get rid of MLB
btw", 17:24:12Z). `server/routes/mlb.js` and its 28 endpoints, the mount at
`server/index.js`, eight MLB services (1,898 lines), five scheduled jobs and
their bodies, `scripts/bootstrap-mlb.mjs`, `test/mlb-nrfi-shrinkage.test.js`,
the MLB assertions in three shared test files, and — on Nick's 17:59Z word —
the MLB reads left without a writer: `mlbMarketMovement()`,
`mlbIntelligence()`, `bookHold`'s `sport` option, `GET /hold`'s MLB comparison,
and `server/services/parlay-api.js` with its test.

**No table is dropped and no row deleted.** The eleven `mlb_*` tables stay
declared in `server/db/schema/mlb-model-misc.js`; a test asserts that and that
no migration drops one. None of the deleted files is a migration and none
contains `DROP TABLE`, `DROP INDEX`, `DELETE FROM` or `TRUNCATE` — grepped, all
zero.

Left for Wiring map, listed and untouched: `scripts/wiring-map.mjs:2164-2165`
(`BETTING_FILE` matches `mlb`; `BETTING_TABLE` matches `mlb_` and **must
stay**, because the tables remain on disk) and `docs/inventory/CONTRACT.md`'s
mlb column — the `wired-mlb-only` grade at `:126` and `:162`, the surface label
at `:199`, the grade definition at `:205`, and the 172 figure at `:182`, which
the `/api/mlb` label produced by moving 24 files out of fantasy `wired`.

**Consequence to expect:** `wired-mlb-only` files are NFL modules reached only
through `/api/mlb` (`CONTRACT.md:348-349` names
`nfl-auto-picks.js <- model-intelligence.js <- routes/mlb.js`). Deleting the
route moves them to **`unreached`**, so the unreached count rises.

### #126 — `claude/project-thread-o3wt2p-refresh-lastline`

Head `6b4d9ee2`, base main, draft, subscribed. A child that never reported is
no longer logged as a success. Gate on `018c1ac9`: `npm run check` exit 0, 3550
tests / 3509 pass / 0 fail. Its `check:wiring` failure was **main's** — proved
by running `f620a120` in a clean worktree and diffing byte-identical findings —
and main is green since #129 merged as `c90d2834`, so it needs a re-run on a
merge of current main before merging.

### #77 — `claude/project-thread-o3wt2p-mainthread-holds`, head `3902ba78`

**Retargeted to main at 17:47Z.** Its base was still
`claude/project-thread-o3wt2p-timer-tier` (#63's head, merged yesterday), so
merging it would have merged into a feature branch. Against main it is
**dirty**. Three conflicts, analysed and not yet resolved:

| File | Shape | Resolution |
| --- | --- | --- |
| `server/services/scheduler.js` | one hunk, empty on HEAD, the whole `ON_REQUEST_THREAD` block on main | take main; the branch predates that block, nothing lost |
| `test/abandoned-run-backoff.test.js` | add/add, one hunk | take main; its version is a strict superset (+33 lines, 0 deletions) |
| `test/health-route-single.test.js` | one hunk, **both sides changed the same assertion** | **needs a decision.** HEAD strips `:\d+ → ` off each entry and joins `found`; main uses raw `found` and joins a `where` variable. Read the current wiring-map output before picking: if it no longer emits line numbers, HEAD's normalisation is dead code; if it does, main's version prints them into the assertion. |

After resolving, merge `c90d2834` in as well — the PR's recorded base sha is
still `f620a120`.

### #84 — `claude/project-thread-o3wt2p-scheduled-ingests`, head `8709ec66`

Base is **#77's head branch**, which is a legitimate stack, unlike #77's own
base was. GitHub retargets it when #77 merges. Re-check it once #77 settles.

### #96 — `claude/project-thread-o3wt2p-servedtables`, head `a24692d3`

The served-tables freshness contract. **Its merge gate is lifted**, verified by
reading `server/services/data-freshness.js` on main rather than on report:
`ruleShape()` returns `'sql'` when `rule.sql` is non-empty, and `askRule()`
feature-detects `registry.evaluateServedTable` and falls back to reading the
`sql` shape as "first column of the first row is truthy". That consumer landed
with #86 at 16:59Z. Body rewritten at 17:50Z; its verification numbers are from
base `654ff93` and are **labelled as not describing the tree CI will build**.
Needs a rebase onto `c90d2834` and a re-run.

### #104 — `claude/project-thread-o3wt2p-freshness-evaluator`, head `e3a86764`

Stacked on #96. Still carries a false "CI is disabled" paragraph — remove it on
its next push. Same rebase and re-run.

### #101 — `claude/project-thread-o3wt2p-epoch-fallback-loud`, head `8d7312dc`

Pushed, CI was red only on main's wiring gate, one comment posted saying so.
Main is green now, so it needs a re-run against `c90d2834`.

---

## BLOCKED

Nothing is blocked on a person as of 18:10Z.

- **Wiring map** owes one commit on the MLB branch:
  `scripts/wiring-map.mjs:2164-2165` and `docs/inventory/CONTRACT.md`'s mlb
  column, listed above. The coordinator is arranging it; the MLB PR does not
  wait on it to be reviewed, only to be complete.
- **`#77`'s third conflict** needs somebody to read the wiring-map output and
  say which side of the health-route assertion is right. It is a five-minute
  read, not an escalation.

---

## FINDINGS handed off, not built

| Finding | Owner |
| --- | --- |
| **#119's `ingest_error` note promises a retry that does not happen.** `cycleOutcome()` says "The scheduler retries it on the next cycle"; true for a *required* source, because `coreLag` reopens the gate, and **false for an optional one** whenever the required sources are current on the next tick (`nfl-model-growth.js`, gate at `:222`/`:227`, ingest at `:230-237`). Not live — the deployed image `c5ee3b54` predates #119 — but it is on main, and it is my own merged text. Until the fix, the note must be conditional on the failed step being required, or must stop promising. | **Scheduler (this thread), first unit** |
| **Optional sources never trigger their own sync.** `nfl_snaps`, `nfl_ngs`, `nfl_pfr_adv` and `nfl_depth` are synced only inside `runNflModelGrowthCycle()` with `force=false`, and `nfl-model-growth.js:185` syncs them only when `finalized_week > 0 && (force \|\| coreLag)`, where `coreLag` counts **required** sources only. So they can go stale indefinitely with nothing reported. **GATED:** produce a call-reach trace from a *fantasy* route to those reads first (Auditor R54.4 withdrew its own scope line). Do **not** flip them to `required: true` — a late nflverse release would block the whole cycle. | Scheduler, after the trace |
| **Two snap ingests, two tables, nothing reconciling them.** `nfl-advanced.js:174 syncSnaps` writes `nfl_snaps` keyed on a name string and keeps `defense_snaps`/`defense_pct`/`st_pct`, and is **not scheduled**; `nflverse.js:270 syncSnapCounts` writes `player_week_snaps` keyed by `player_id`, offense only, and **is** scheduled. Both download the same nflverse snap_counts CSV. Defensive and special-teams snap share therefore exist only in the unscheduled table. | Scheduler, same unit |
| **Do not put nflverse depth on a timer.** `scheduler.js:1156-1162`'s own header: the depth_charts CSV was 51 MB in week 2, and on a 2 GB machine "is how the OOM kills come back". For `nfl_depth` the fix is that its consumers know they read a hand-fed table. `scheduler.js:1164-1167` is **not** a second writer of `nfl_depth` — it calls `syncDepthChart` from `routes/nfldata.js:217`, which writes `roster_players.depth_slot`/`depth_order` from ESPN. | Scheduler |
| **A third cause for `nfl_depth = 0`.** On the rebuilt rig `syncDepthCharts` failed with, verbatim: *"Depth charts downloaded but stored 0 rows: game_lines is empty, so seasons through 2024 have no game day to date their charts from. Sync the schedule first."* Attempted, downloaded fine, stored nothing because a prerequisite table was empty. **Read the recorded error text, not just the verdict** — if it names `game_lines` or the schedule, the cause is dependency ordering and the fix belongs with whatever populates `game_lines`. | Explorer → Scheduler |
| **`saveAndVerifyWeeklyFit` has zero callers.** `weekly-weight-store.js:175` saves a promoted fit, re-reads the stored row, and demotes on failure at `:184` — the mechanism its own comment at `:161-173` describes. The scheduled path `runWeeklyLearningCycle → weekly-learning.js:319` calls raw `saveWeeklyFit` with no post-save verification, so **a promoted fit that fails re-read stays promoted**. Do not touch the five promotion gates (`minSettled` 250 at `:224`, the four-way AND at `:310-311`). | Scheduler, third unit |
| **`model.js:598-599` counts rows that are not fitted.** `correlations_fitted` and `gamescript_fitted` use a bare `COUNT(*)` with no `fitted_at` predicate and no both-targets check. Found while building #96; that file belongs to another workstream. | Model thread |
| **The three refresh children still `process.exit` without flushing.** #126 makes a lost report *reported* rather than read as success; it does not fix the producers. One line each in `collect-league-transactions.mjs`, `collect-roster-snapshots.mjs`, `build-manager-signals.mjs`. | Whoever owns those scripts |
| **`ON_REQUEST_THREAD` still holds 22 entries.** The list mixes "this job cannot move" with "nobody has moved this job", and they read alike. The four 3-minute betting jobs are excused on an explicitly **unmeasured** worker cost — that is a measurement somebody could make, not a blocker. | Scheduler, unprioritised |

---

## RULES AND LESSONS a new session must know

**The brake.** `SCHEDULER_DISABLED=1`, set as an app-level Fly secret so it
survives deploys. `fly secrets unset SCHEDULER_DISABLED` lifts it. **Never
touch the `LOOP_WATCHDOG_*` variables — they are not the brake.**

**Deploy.** Nick runs `fly deploy` himself; deploying is his word, never
delegated. The current live image is `deployment-01M3517MWXX3HF7CEPSWB8ZK0M`
on main `c5ee3b54`, machine `84ed41eae1dd68`. Rollback is the previous image,
`deployment-01M2VZ9JRYSXVHCRWJ83V360QH`, and the first step of any rollback is
to re-set the brake. Runbook: `docs/runbooks/deploy-654ff93.md`. **Never delete
`/data/data.sqlite.pre-migration-<stamp>.bak`.**

**Main is nine PRs ahead of the deployed image.** Anything merged today,
#119's `ingest_error` included, is **not** in the running app.

**`npm run check` now includes the wiring gate, and runs it BEFORE the tests**
(`typecheck && lint && check:wiring && test && build && start:smoke`, since
#129 merged as `c90d2834`). A red wiring step means the suite never runs at
all, so a "0 tests" result is not a passing tree.

**Tiers.** `resolveOffThread(job, override)` reads the allow-list, then the
override, then `job.offThread ?? job.tier === 'heavy'`. **Only the heavy tier
goes off-thread by default**, so a `live`, `growth` or `metered` job needs
`offThread: true` on its own definition. Choosing a lighter tier to dodge
`AUTO_HEAVY_SYNC` also puts the job on the request thread, which is almost
never what the author meant.

**`runIfStale` on a name not in `JOBS` returns `{ error: 'unknown job' }`. It
does not throw.** Two route handlers call `refreshInBackground` fire-and-forget
and never read the result. That is why removing a job without its callers is a
silent failure, and why `test/mlb-removed.test.js` asserts every name
`BOOT_JOBS` and `refreshInBackground` can carry is a job that exists.

**`node:sqlite` is fully synchronous.** A job on the request thread blocks
every HTTP request for its whole duration. "A slow job" and "an outage" are the
same event here.

**Measure on the tree you name.** The primary worktree `/home/user/gridiron-hq`
is checked out on a feature branch and was **204 tracked files behind main**
this afternoon. A census run there and labelled with main's sha is worthless. I
shipped that mistake once today and caught it; check `git rev-parse HEAD` in
whatever directory you are grepping.

**When you report a negative, say what you searched.** I asserted "there is no
`CONTRACT.md` in this repository" from a `find` on the stale tree plus a
root-only check on the correct one. `docs/inventory/CONTRACT.md` exists and is
400+ lines. A negative from an unchecked search reads as a finding.

**Verify a mutation applied by md5, before and after — never by grep.** Two
sweeps in this project have reported a clean result from injections that never
changed the file.

**`switch_model` returning success is a request, not a confirmation.** Check
`get_session`'s `session_context.model`, `external_metadata.last_served_model`
and `user_switch_rejected`. Opus 5.5 was rejected fleet-wide today; sessions
move only by restart, and that is Nick's call.

**Run one full check at a time.** The suite has timing-sensitive worker tests,
and concurrent runs are how the `ENOTEMPTY` worker-exit race surfaced.

**Kill a gate run that is on a stale tree** rather than letting it finish and
reporting numbers for a tree you are not pushing.

**`MLB` is also Middle Linebacker**, in `client/src/components/FormationView.tsx`
(beside `LILB`) and five times in `server/routes/nfldata.js`'s depth-chart slot
maps. Pinned by `test/mlb-removed.test.js`.

**Threads report to the coordinator, not to Nick.** Nick's chat gets his-word
items, milestones, and what he asked for.

---

## FILES this thread owns

`server/services/scheduler.js`, `server/services/source-registry.js`,
`server/platform/loop-watchdog.js`, `fly.toml`, `server/index.js`,
`test/scheduler-off-thread.test.js`, `server/services/weekly-weight-store.js`
(for the epoch-fallback unit), and — recorded as unallocated and taken —
`server/services/nfl-model-growth.js` and `server/services/nfl-advanced.js`.

Held but **not** mine: `scripts/wiring-map.mjs` and
`docs/inventory/CONTRACT.md` (Wiring map), `server/routes/nfl-betting.js:1130`
(leave alone), the five weekly-fit promotion gates.

---

## NEXT THREE STEPS for a session picking this up cold

1. **Finish the MLB removal.** Read the gate result in
   `/tmp/claude-0/verify1x-nomlb4.out` (or re-run
   `bash /tmp/claude-0/repro/verify1x-local.sh <head> <tag>`), push
   `claude/project-thread-o3wt2p-remove-mlb`, update PR #128's body to the
   removal rather than the census, and send the coordinator the head and both
   exit codes. `check:wiring` was already exit 0 on `8e2667bc`.
2. **Resolve #77.** Take main's side on `scheduler.js` and
   `test/abandoned-run-backoff.test.js`; read the wiring-map output before
   picking a side on `test/health-route-single.test.js`. Then merge `c90d2834`
   in, run the guard, push, and re-check #84.
3. **Fix #119's note.** It is merged text of this thread's promising a retry
   the code does not perform for an optional source. Make the note conditional
   on the failed step being required, or stop promising, with a RED that pins
   the optional case.

---

## Where the tooling is

- **Guard script:** `/tmp/claude-0/repro/verify1x-local.sh <commit-ish> <tag>` —
  one clean run of `npm run check` then `npm run check:wiring`, with the
  worktree tree asserted equal to the commit's before the run, porcelain and
  write-tree either side, `node_modules` hard-linked (no install), and logs
  outside the repo. Reports both exit codes on their own lines so a wiring
  failure can never be mistaken for a test failure.
- **Gate minus wiring:** `/tmp/claude-0/repro/run-nowiring.sh`, for when a
  wiring finding is out for a decision and you still need a real test number.
- **Post-deploy read:** `/mnt/project-files/POSTDEPLOY-READ-2026-09-22.sh`, a
  single paste-able block, read-only (`new DatabaseSync(SRC, { readOnly: true })`,
  proven unchanged by md5 either side), ten sections covering migrations,
  scheduler runs, depth charts, the freshness registry, growth runs, news
  importance, injuries, table presence, `league_transactions_raw` and
  `nfl_capture_triggers`.

These live in the session container and do not survive it. The guard script is
worth re-creating from this description in a fresh session; it has caught a
stale tree, a dirty worktree and a silently-skipped chain step.

---

# Addendum, 2026-09-22 18:35Z — the MLB removal, and the state at the freeze

Written at the usage freeze (Nick's 5-hour meter went 9% to 16% in ten minutes).
Everything below is the state a fresh session inherits.

## Shipped since the document above

**PR #128 — remove MLB from the product.** Branch
`claude/project-thread-o3wt2p-remove-mlb`, head **`f08bdf42`**, pushed.

Gate on that exact head: `npm run check` **exit 0**, `npm run check:wiring`
**exit 0** run separately, `# tests 3585 # pass 3544 # fail 0 # skipped 41`,
all six chain banners reached, `git write-tree` identical either side, 25 files
written and all of them under `client/dist`.

What came out: `server/routes/mlb.js` (209 lines, 28 endpoints) and its mount at
`server/index.js:138`; eight services, 1,898 lines; five scheduler jobs with
their bodies, three `ON_REQUEST_THREAD` excuses and three `BOOT_JOBS` names;
`refreshInBackground`'s default; the MLB halves of `evidence-daemon.js`,
`market-movement.js`, `model-intelligence.js`, `nfl-shopping-board.js` and
`routes/betting-hub.js`; `services/parlay-api.js` with its test;
`scripts/bootstrap-mlb.mjs` and `test/mlb-nrfi-shrinkage.test.js`.

**No data was deleted.** All eleven `mlb_*` tables are still declared in
`server/db/schema/mlb-model-misc.js`, no migration drops one, and
`test/mlb-removed.test.js` test 4 asserts both so it cannot drift.

**The request thread went 29 → 26** accountable on-thread jobs, measured by
running the module, and the ratchet in `test/growth-jobs-off-thread.test.js`
was lowered to 26 so the gain cannot be given back in silence.

Evidence: `docs/tdd/2026-09-22-remove-mlb.md`. Mutation sweep 8 applied, 8
killed, each verified applied by md5 rather than grep, three of them at the call
site.

## Three findings worth keeping

1. **`MLB` is also Middle Linebacker.** Seven places across
   `client/src/components/FormationView.tsx` and `server/routes/nfldata.js`. A
   grep-and-delete would have broken the formation diagram and the LB depth
   group. Test 5 pins them.
2. **A dangling job name is silent, not loud.** `runIfStale` on a name not in
   `JOBS` returns `{ job, error: 'unknown job' }` — it does not throw — and
   `refreshInBackground` is fire-and-forget from two route handlers that never
   read the result. Test 2 reads `BOOT_JOBS` and `refreshInBackground`'s default
   out of the source and asserts every name resolves. This is the test that
   carries the weight; keep it when the scheduler is next reshaped.
3. **Deleting a writer leaves its readers reading nothing, and they look fine.**
   `mlb-pregame.js` was the only writer of `mlb_market_quotes`. Without the
   wiring gate, `GET /hold` would have shipped reporting `comparison: null`
   against an unwritten table, which reads as "no prop premium found" rather
   than "the source is gone". The wiring gate caught it; both readers were
   severed. **Run `npm run check:wiring` after any deletion, as its own step.**

## Lessons, at cost

- **Assert a negative only from a search that covered the tree.** I said "there
  is no `CONTRACT.md` in this repository" from a `find` on a stale worktree plus
  a root-only check. `docs/inventory/CONTRACT.md` exists, is 400+ lines, and
  carries the `wired-mlb-only` grade this change affects. Retracted in
  `e6631e4b`.
- **Measure on the tree you name.** The first MLB census ran against a worktree
  204 tracked files behind and reported `scheduler.js:1191-1195`; the real lines
  were `:1234-1238`. The footprint happened to be identical, which is luck.
- **`npm run check` changed under us.** Since `#129` merged as `c90d2834` the
  chain is `typecheck && lint && check:wiring && test && build && start:smoke`.
  The wiring gate runs **before** the tests, so a red wiring step means the
  suite never ran, and "0 tests" is not a passing tree. The guard script reports
  both exit codes on separate lines for exactly this reason.
- **The merge gate went to v2 mid-branch.** v1's five questions were never
  Nick's five. v2's are: well built, stats or made up, how we know, pointed
  anywhere else, how it unifies. `f08bdf42` adds them to the evidence file
  rather than silently swapping the old list out.

## Next three steps for the restart, in order

1. **#126 (`claude/project-thread-o3wt2p-refresh-lastline`).** It is red on CI
   at `6b4d9ee2` — main's own wiring findings, since fixed by `#129`. Current
   main is already merged in locally as **`ffecd797`**, clean, no conflicts, in
   the worktree `/tmp/claude-0/wt-lastline` on branch `lastline-work`. **It was
   not pushed and its guard run was cancelled at the freeze.** That container is
   gone on restart: redo the merge, run the guard once, push. This is the first
   step.
2. **#77.** Base was retargeted from `claude/project-thread-o3wt2p-timer-tier`
   (a feature branch) to main at 17:47Z and it is now dirty. Three conflicts:
   take main's side on `server/services/scheduler.js` and
   `test/abandoned-run-backoff.test.js`; **`test/health-route-single.test.js`
   needs a decision** — both sides changed the same assertion. Then merge main
   in, guard, push, and re-check **#84**, which is still stacked on #77's head.
3. **#119's false "retries next cycle" note.** This thread's own merged text. It
   promises a retry that does not happen for an **optional** source —
   `server/services/nfl-model-growth.js` gate at `:222`/`:227`, ingest at
   `:230-237`. Make the note conditional on the failed step being required, or
   stop promising, with a RED that pins the optional case. Do **not** flip
   optional sources to `required: true`: that is gated on producing a call-reach
   trace from a fantasy route first (Auditor R54.4).

Also open, not started: **#96** and **#104** need rebasing onto current main and
#104 carries a false "CI disabled" paragraph to remove; **#101** needs a re-run
now that the wiring gate is green on main; **#144** (child-flush) and **#145**
(mlb-offthread) are pushed drafts with their state stated in their bodies, and
#144 needs main merged and a clean gate run before anything else. A fourth
queued unit: `saveAndVerifyWeeklyFit` has zero callers
(`server/services/weekly-weight-store.js:175`, demote at `:184`) while the
scheduled path at `server/services/weekly-learning.js:319` calls raw
`saveWeeklyFit`; do not touch the five promotion gates.

## Hard stop, 18:42Z — exact state at handover

Stopped mid-flight on Nick's token-spend order. Nothing below is finished; none
of it is broken.

- **#128 (remove MLB) — owed: one merge.** Branch head on the remote is
  **`5f9242d8`**. That is my `f08bdf42` (gate green: `npm run check` exit 0,
  `npm run check:wiring` exit 0, 3585 tests, 0 fail) plus **one commit from the
  Wiring map thread**, `docs: MLB leaves the inventory as an abandoned product,
  not as betting`, touching only `scripts/wiring-map.mjs` (+22) and
  `docs/inventory/CONTRACT.md` (+18/-1) — the two files this thread deliberately
  left to them and reported rather than edited. I verified `f08bdf42` is an
  ancestor of `5f9242d8` and that their commit touches nothing of mine. CI was
  **in progress** on `5f9242d8` at 18:35:58Z
  (run 35768157225) and I did not read the result. **Next session: read that CI
  once; if green, squash-merge #128 and send the sha. Do not re-run the local
  guard — it already passed on `f08bdf42`, and CI on `5f9242d8` is the gate for
  the commit added on top.** The PR body is complete and carries the merge-gate
  sections; the one thing it does not say is that a later commit sits on top of
  the tree the guard ran on. Put that line in the squash-merge commit message
  rather than rewriting a 10KB body.
- **#126 — not pushed.** Current main is merged into it cleanly as `ffecd797`,
  but that commit lives only in the dead container. Redo it: worktree at
  `6b4d9ee2`, `git merge origin/main` (clean, no conflicts when I did it), one
  guard run, push. Its CI red at `6b4d9ee2` is main's old wiring findings, fixed
  on main by `#129`; it is not this PR's defect.
- **PR activity subscriptions: all cancelled** for #101, #126, #128, #144, #145.
  A fresh session that picks one up should re-subscribe to it.
- No triggers of this thread's own exist. The 30-minute update trigger
  (`trig_011nZZwLvza1AqT2LfYuCFwp`, next 18:58Z) belongs to the coordinator
  session and was deliberately left alone.
- **Cost lesson for the restart, since this is what stopped us:** the spend here
  was context re-reads, not work. Three things would have cut it most — start
  cold from this file and read nothing else until a task needs it; one guard run
  per tree and never re-read a result already recorded; and do not let a branch
  head move after a green run unless the change is worth the second run (adding
  Nick's five questions to the evidence file cost a full 9-minute re-run, which
  was correct but should have been batched into the commit before the first).
