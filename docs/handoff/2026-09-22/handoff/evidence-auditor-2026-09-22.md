# Evidence Auditor — handoff, 2026-09-22

Second Independent Auditor ("Evidence Integrity Auditor"). Mandate: verify that
pushed and claimed test figures, tree hashes and CI results are actually true,
by independent reproduction rather than by trusting a relayed claim. Hard
limits, unchanged all session: no push, no PR, no merge, no deploy, no settings
or secrets change, no feature code, nothing paid. Secrets read for presence
only, never contents. Reports go to the coordinator; builder threads are never
messaged directly.

---

## 1. The bar

A verdict of REAL means: **CI green on the exact current head** (not a head that
has since moved, and not a figure the PR body reports about itself), plus a
**tree-hash spot-check** that the claimed tree is the tree the head actually
points at. For anything touching **model, projection, trade-logic or lineup
code**, and for any body quoting a **mutation-sweep figure**, that is not
enough: the full `npm run check` is reproduced locally in a disposable clone and
the sweep file's existence and counts are checked on the head. Every RED and
GREEN sha cited in the evidence file is confirmed reachable from the reviewed
head (`git merge-base --is-ancestor`), per R52.2 — the PR's own pair only, not
shas inherited through main merges from other threads. Since #129, the wiring
gate is part of `npm run check`, so a post-c90d2834 head reporting `check` exit
0 has run it whether the body says so or not; before that it was a second
command and had to be reported separately.

The bar's own limitation, stated once so nobody over-reads a REAL: CI green on a
branch cannot surface a gate that only misfires against a *moving* main. That is
exactly how #108 passed its own gate and then took main red. A REAL describes
the tree it was measured on and nothing else.

---

## 2. Verdicts issued today, with the head actually read

Figures marked **(mine)** are runs I performed. Others rest on CI's own
execution on that head, confirmed through the API, plus a tree check.

| PR | Head I read | Evidence |
|---|---|---|
| #111 | `670feac91cbd885a71f4821aacdd31d8c05dcde5` | **(mine)** full check 3111/3070/0/41, exit 0; tree matched claim exactly. The fix for the #89/#91 regression. |
| #108 | `1161c16572f21cfe5f99789de44642860c9a725a`, then rebased `a333f449f8fe6476d49c17af07a331426e71c4a4` | **(mine)** full check 3210/3169/0/41 on the first head, exact match to claim. CI red was a stale base, not a defect — diagnosed and written up separately. Rebase later confirmed: main an ancestor of a333f449. |
| #86 | `85caa0d58301219278b6b67785210f38c94913c7` | CI success on the new head; head had moved twice (c8c75e45 → 85caa0d5). Merged as 7eca9a8b. |
| #95 | `3f3ddbaac242298a87faa5ebca8476fc83938ebb` | CI success. Merged as eb861feb. |
| #112 | `fa84d59f47ae4bd951dac0c7c01ea6ae6eb9ea9e` | CI success, mergeable clean. Merged as a1e661fc. |
| #68 | `29b148c7bb8a6390e505be23d65ae44467f134c5` | CI success, clean, non-draft. |
| #109 | `5b27a54065e0a6bd74b669b87b4dd886af242f6b` | CI success. Merged as 4ff3048b. |
| #110 | `311e84ccac0314588a89182ef47f5bdc8778f643` | CI success. Merged as ab01efa8. |
| #87 | `d372fd3c9b7e32436e8aa61421a4fcd03617f3b5` | CI success. Merged as 0c5b7be4. |
| #113 | `8fd27b20a5cc53b7e2a380622615dc1fd62ad8ca` | CI green on the exact head. Its earlier ae81114 figures were the pre-merge commit; the thread re-cited correctly when asked. |
| #99 | `605ab3f66b8fc314e8e18a39d56ef0e4cc4946a4` | CI green, mergeable clean. |
| #115 | `6d637d3db8cca123f5f311eddf958e456c54282f` | CI success. |
| #117 | `38f6f4c5e5ef1d39ebd9381aa6db532db3a7e71a` | CI success. |
| #119 | `225f5ec742280c7d35cd1ba256cae22740793cf4` | CI success, clean. |
| #103 | `08c729e1be6e9db82c2c675a8353f8982dd0aff0` | CI green (run 35756794144). Stacked on #94; lands after it. |
| #94 | `003192290810ebd1af04a076983b8cf07e1d258f` | **(mine)** full check 3261/3220/0/41, exit 0, on `951c70f1…` (tree `46071cbc`), the head immediately prior — the later merge added no diff of #94's own. Mutation sweep file and its M29 row confirmed present. CI red on the head was the inherited gate: **I reproduced `check:wiring` on the actual head and got main's three findings verbatim**, and #94's 8 changed files touch neither `td-features.js` nor `scheduler.js`. |
| #120 | `a1164dd5bbb2410e8821c77ce061d2581219e88f` (tree `9fad5221715b221d7a9dbfe8412ec3743427b908`) | **(mine)** full check 3158/3117/0/41, exit 0 — exact match to the claim, digit for digit. **Caveat recorded at the time:** `check:wiring` does not exist on that tree (base predates #108), so the second gate was unmeasurable. REAL covers its own work only; the rebased head needs both gates. |
| #116 | final `6dfc123da61e2f921c6925d90aad6a5017d420f2` | **(mine)** full check 3537/3496/0/41, exit 0 on `93870a92…` — exact match to claim. `check:wiring` exit 1 with only main's three. Final head verified docs-only over the tested tree (one file, +23/−2, nothing outside `docs/`), and `symbol-reach.mjs` / `symbol-reach-two-counts.test.js` byte-identical from 28b801b8 through the final head. RED `9383c873` / GREEN `28b801b8` both reachable. |
| #92 | `28ff7ae56a10068c8c21d7620a4275a87344e128` (tree `835b222b`) | CI green. **Nuance worth keeping:** my standalone run of its raw tree *reproduced* the known pre-#111 regression, because its base was old main. Its diff touches neither regression file, so it inherited and did not cause. Here CI's merge-ref was the *correct* measurement and my raw-tree run the misleading one — the opposite of #108. Head has since moved; needs re-ruling. |
| #129 | `6432a7685ff43a646f7eddeef8792630fb07db30` (tree `63ebac8a…`) | **(mine)** full check 3553/3512/0/41, exit 0, build and smoke clean; `check:wiring` exit 0, zero blocking findings. All five R52.1 checks run on the pushed head and passed — detail in §4. Merged as **c90d2834**. |

#102 and #114 were docs/evidence-only and did not pass through this gate.

### Main's current state, verified not assumed

Main is `c90d2834b827f32e62117d20ae5e63ff6774b264`, tree
`63ebac8ae3c41769c59f6abcc5ad741c6122d5ec` — **byte-identical to #129's head
tree**, which I ran the full suite against. So main's health is established by a
run I performed rather than inferred from a merge. `check:wiring` exit 0 on main
directly; `npm run check` on main now includes the gate inline.

---

## 3. Queue as of this handoff

Every item below must be rebased onto **c90d2834** and show one guard run with
`npm run check` exit 0 (which now covers wiring) before it is read. Heads listed
are pre-rebase and are expected to move.

| Order | PR | Pre-rebase head | Waiting on |
|---|---|---|---|
| 1 | #94 | `00319229…` | Trade Brain's rebase onto c90d2834 |
| 2 | #116 | `6dfc123d` | rebase; work already verified (§2) |
| 3 | #124 | `db6b0010…` | rebase; its CI red was the inherited gate, cause named |
| 4 | #125 | `0f442fa` | rebase |
| 5 | #85 | `69909edd` | rebase; also carries a lapsed "CI disabled" paragraph |
| 6 | #92 | `4a8085c` | rebase; supersedes the head I ruled on |
| 7 | #100 | `eb813b4d` | rebase |
| 8 | #127 | `43116ab` | rebase. Review note: `deploy.yml` must run only on `workflow_dispatch`, never on push; it stages the brake and fails unless the new image logs "Scheduler disabled"; it never releases the brake. |
| 9 | #130 | `ea03d88` | Feature audit's floorOf extension, then Auditor R50 final |
| 10 | #121 | `57c21a0f` | Auditor R47(B) clearance and the R57 text fixes |
| 11 | #122, #123 | not yet read | Auditor rulings |
| 12 | #131, #132 | not yet read | #132 is UI's ceiling-lineup fix (lineup code → full local repro required) |
| 13 | #103, #120 | `08c729e1`, `a1164dd5` | land after #94; both need both gates re-run on the rebased head |

**Outside the queue and needing action before they can enter it:**

- **#118** — CI green on a full 414-second run, but `mergeable_state: dirty`, a
  real conflict, and its recorded base is behind the others.
- **#77 — hazard found and since closed; conflict resolution in progress.**
  When swept it was still based on `claude/project-thread-o3wt2p-timer-tier`,
  base sha byte-identical to #63's head (#63 merged 2026-09-21); GitHub had not
  retargeted because this repo deletes no branches, so merging it would have
  merged into a feature branch rather than main, silently. Scheduler retargeted
  it to `main` at 17:47:14Z — **confirmed**: base is now `main`, head
  `3902ba78c7eb0e4980d48f0e3d2f900b0ed6609f`. It now reads `dirty` against the
  new base, which is a genuine conflict this time (it has never been merged with
  main), and is getting a merge of main rather than a rebase. Note its base sha
  is `f620a120`, the pre-#129 main, so it will need main again afterwards.
  **#84 is still stacked on #77's head branch** (base sha byte-identical to
  #77's head, untouched since 2026-09-20) — re-check it once #77 settles.
- **#54, #85** — had zero check runs at sweep time: a stale head awaiting a
  push, not a disabled workflow.
- **#96, #104** — their merge gate's condition is satisfied; see the sweep file.

Full lapsed-hold-reason sweep, with per-thread routing:
`/mnt/project-files/audit-lapsed-hold-reasons-2026-09-22.md` (30 PRs carrying a
false "CI cannot run" reason, grouped across 10 threads, plus 4 lapsed
stacking/merge gates).

---

## 4. R52.1's five checks on #129, for the record

Run against the pushed head `6432a768`, closing the ruling R53.1 left
provisional on an unpushed head.

- **(a) Fails for the right reason — PASS.** RED `4bab4fd` at its own tree:
  **3 pass / 5 fail**, exactly the claimed figure, failing on the assertions
  under test. GREEN `a997747`: **8/8**. The three passing at RED are the
  recognised-receiver cases, which is itself evidence for (d).
- **(b) The split — PASS, pinned from both sides.** "Not the app" at `:45`;
  "reported" at `:101`. The complement is pinned too — `:108` an opened handle
  is *not* on the list, `:115` the app's own queries are *not* on the list,
  `:122` one site with several tables is one entry. The list cannot be gamed
  into reporting everything or nothing.
- **(c) Rename — PASS.** Test now reads *"…an unrecognised receiver is named
  rather than assumed"*; assertion message went from *"not evidence of a second
  database"* to *"reported as itself, not claimed as the app"*.
- **(d) Safety half at full strength — PASS.** The reversal removes exactly two
  lines with the old text quoted in place. Recognised receivers pinned unchanged
  at `:52`, `:60`, `:65`; the `callSites` widening pinned against over-counting
  at `:79` (prose) and `:83` (prefix).
- **(e) Gate green — PASS.** `check:wiring` exit 0 on the pushed head; main an
  ancestor, so GitHub's merge(head, base) build *is* the head tree.

The Auditor's citation-numbering note was already fixed on the pushed head. The
ratchet suggestion — baseline the 19 unresolved receivers, fail only on growth —
remains a good follow-up and is not blocking.

---

## 5. Lessons worth carrying

**A squash can reproduce the tested tree — check, don't assume either way.**
c90d2834's tree is byte-identical to the head I tested. That is not guaranteed
by squashing and it is worth one `rev-parse HEAD^{tree}`: when it holds, the
branch run describes main and nobody needs to re-establish main's health.

**The six steps that caught everything real today.** (1) Fetch the exact head
from origin, never a local mirror. (2) `rev-parse HEAD^{tree}` and compare to
the claimed tree. (3) Confirm base ancestry — *with a deep fetch*. (4) Run the
full check in a disposable clone with `node_modules` symlinked, never touching
the primary tree. (5) Run the wiring gate. (6) Confirm every cited RED/GREEN sha
is reachable from the reviewed head.

**`--depth=1` makes ancestry checks silently wrong.** A shallow fetch pulls the
tip commit with no parents, so `merge-base --is-ancestor` returns a confident
false negative. I nearly reported #108 as un-rebased on exactly this. Use
`--depth=300` or more for any ancestry question.

**A CI red at ~60 seconds means the tests never ran.** The full suite takes
roughly 400 seconds. A one-minute red died at install, typecheck, lint or the
wiring gate — so the figures in that run say nothing about test content, and the
PR has *no test signal at all* rather than a failing one. Three PRs (#121, #124,
#116) were misreadable this way; pulling the job log named the cause in each.

**`list_pull_requests` reports `merged: false` for merged PRs.** #63 and #86 both
show `merged: false` in the listing and `merged: true` via per-PR `get`. Any
thread deciding "is #N merged?" from the list endpoint gets the wrong answer.
Use per-PR `get` and `merged_at`.

**GitHub's `tail_lines` on job logs cuts before the failure.** The TAP summary
is at the end but the `not ok` line is thousands of lines earlier. Fetch the raw
log blob URL (`get_job_logs` with `return_content: false`) and grep it locally.

**`mergeable_state` goes stale.** #116 read `dirty` after a force-push and
retarget forty seconds apart, while git showed main's tip *was* the merge-base
exactly — a fast-forward, conflict impossible. Verify a claimed conflict with
git before asking anyone to resolve it; the resolution would have been an empty
merge commit.

**Which tree a red CI run measured decides whose fault it is, and the answer
flips.** For #108, CI tested the merge and the branch was fine — CI's merge-ref
was the misleading measurement. For #92, CI tested the merge and *that* was
right, while my raw-tree run reproduced a bug the merge would never carry. Same
mechanism, opposite conclusions. Always say which tree a figure describes.

**A mechanical sha sweep punishes the files that handled shas best.** #116's
evidence file cites an unreachable `b885db2b` — deliberately, in a passage
explaining that two rebases orphaned it and that subjects survive what shas do
not. A naive reachability sweep flags that as a broken citation. Scope the check
to the "Commit measured on" pair.

**"Fix the gate" is where a gate usually dies — so check narrowing vs
suppression.** #129 could have been a one-line silencing. It was not: it counts
a job registration as a call (with prose mentions and prefix-sharing names still
counting zero, pinned), reports an unrecognised receiver as itself rather than
assuming the app, measured its own blast radius at 24 sites, and *prints* the
blind spot it cannot resolve instead of passing it silently. That is the shape
to insist on.

**Report-never-gate is a real design, not a dodge.** The stale `cascade-grade.js`
accept-list entry prints via `console.log` outside the blocking path; the only
`process.exit(1)` is reached from `blocking.length`. `wiring-map.mjs` says why
in its own comment: an entry can legitimately run ahead of the file it names,
and failing a build on a merge-order accident teaches people to delete the entry
rather than land the file. I called it "cleanup" once and was wrong; removing it
is precisely what the file was written to prevent.

**Heads move under review, constantly.** #86 moved twice, #116 three times, #94
twice mid-verification, and two heads I was handed (#116's `8ff70768`, #92's
`67b05ef`) did not exist on origin at all — one was a local pre-push tree. Always
re-read the head immediately before issuing a verdict, and say which head the
verdict covers.

---

## 6. Merge ledger — the 18:06Z pass

Role changed at 18:06Z: threads squash-merge their own PRs on CI green on the
exact head plus a self-check block in the body. I no longer re-run suites. My
job for the pass is this ledger, a body-read of every PR before it merges
(self-check block present, cited shas reachable — a read, not a run), and
watching main's own push run after each merge.

**Pass order:** #94 first, then anything green in any order, except #103, #120
and #100 follow #94, and #84 follows #77.

### Merged before the pass (today, pre-18:06Z)

| PR | Merge sha |
|---|---|
| #129 (wiring gate fix) | `c90d2834` — main tree `63ebac8a`, verified green by my own run |
| #95 | `eb861feb` |
| #86 | `7eca9a8b` |
| #112 | `a1e661fc` |
| #109 | `4ff3048b` |
| #110 | `ab01efa8` |
| #87 | `0c5b7be4` |
| #68, #114, #102, #111, #108, #113, #99, #115, #117, #119 | merged; shas not individually recorded here |

### The pass

| # | PR | Head merged | CI run | Merge sha | Main after | Main push run |
|---|---|---|---|---|---|---|
| 1 | #124 Chat sync | `8c66d93e` | — | `9f0b5b66` | `9f0b5b66` | run 35765168683 — **CANCELLED**, not green |
| 2 | #92 Planner | `23b4ddda` | — | `6e722719` | `6e722719` | run 35765300584 — **SUCCESS** 18:17:59Z, all 11 steps |

**Main is green at `6e722719`.** Every step success: typecheck, lint, **wiring
check**, test, build client, fresh-install smoke. Wall clock 8m20s
(18:09:39 → 18:17:59) against `timeout-minutes: 20`, so the headroom #129 bought
is holding with the wiring gate now chained inside `npm run check`. This is the
first verified main since `c90d2834`, and it covers both merges in the burst —
`9f0b5b66` is retroactively covered as an ancestor of a green tip, though it was
never measured on its own.

Main's tip read over git (`git ls-remote`), which spends no REST budget:
`6e7227194a3501aaff1371a0eeb159f5f1442e6e`.

**Finding — a merge burst destroys main's own verification.** CI's concurrency
group cancels an in-flight run when the next push lands. #124's main run was
cancelled at 18:09:36Z by #92's push at 18:09:14Z, 96 seconds after it started,
so **main at `9f0b5b66` was never verified by anything**. This is not new: the
same cancellation hit main's push runs for #117, #115, #113, #99, #110, #87 and
#109 earlier today. The last verified main is `c90d2834` (#129, run
35763448618, success 18:00:52Z). Only the final merge of a burst gets a real
main signal; every merge before it is covered by its own PR run and nothing
else.

Not an alarm: cancelled is not red. But "main is green" cannot be said of
`9f0b5b66`, and if `6e722719` comes back red the bisect range is two merges
wide, not one.

Green and queued behind it: #131 `3fddc87f`, #125 (after #131, conflict
pre-resolved at `4d2c505`), #121 `91ed5f1a`, #130 `8047ba7`, #132 `929432cc`,
#137 `3a770c6`, #90 `4b7f49ec` pending CI.

### The self-check block — four parts

As of Auditor R63 a body must carry all four:
1. Guard command **and its exit code**.
2. RED and GREEN shas cited per R52.2 (and reachable from the reviewed head).
3. The five questions.
4. **One liveness proof per behaviour change** — the RED fails against unfixed
   code, or a named mutant dies. A test that passes vacuously proves nothing.

### Pre-merge read status

| PR | Head | Reported guard | Notes |
|---|---|---|---|
| #131 Chat sync | `3fddc87f6c0052fd47146292b45ee48c42cb22a8` | check exit 0 | On c90d2834, fast-forward. RED `eedeb64` / GREEN `665cbb2` both reachable. Narrows #113's counter without gutting it; #113's own tests untouched and passing. |
| #92 Planner | `23b4ddd` | check exit 0, 3595/3554/0/41 | merges on CI green |
| #121 Model evidence audit | `91ed5f1a` | check exit 0, 3553/3512/0/41 | plus one R62.5 text line; needs Auditor as well as CI green |
| #130 Feature audit | `8047ba7` | guard exit 0 on `5b8a345`, 3571/3530/0/41 | guard measured one commit below the head, docs commit above — same carry-forward shape as #116, so the docs-only delta wants confirming |
| #90 Coach | `4b7f49ec` | wiring 0, guard running | CI run 35764663301 |
| #137 Wiring map | `3a770c6` | docs-only | |

### Body read — 19 PRs, all four parts (18:07–18:12Z)

A read of the fetched bodies, not a run. Nothing here is a CI verdict.

**Part 4 (R63 liveness proof).** Present and named in 13 of the 19: #94 (33
rows, 32 killed, control survived, re-run on the rebased tree), #118 (14/14),
#132 (7/7), #127 (22/22), #116 (4/4), #92, #85 (mutation tables carrying the
before/after edit text and a file hash each side), #125 ("all 4 tests fail
against the pre-fix source", assertions verbatim), #130 (11/19 server, 5/5
client, plus a reference-inequality check the fix itself cannot satisfy), #100,
#103, #131 (3 of 3 failing at RED).

Thin: **#120** cites RED/GREEN and a lazy-fix argument but never states a
failure count against unfixed code; **#84** says mutation checks "were run" and
points at the evidence files without naming one. Not applicable: #121, #122,
#123, #137 — no behaviour change. **Missing outright: #77.**

**Parts 1–3.** Fully compliant: #94, #124, #125, #100, #127, #131, #132, #103,
#120, #118. Missing something: #77 (all three, plus zero check runs — worst of
the set); #122, #123 (exit code and RED/GREEN; docs-only, so no TDD pair
exists); #116 (RED/GREEN, by explicit choice — cites by subject after two
rebases); #85, #84 (RED/GREEN); #92 (RED/GREEN; five questions present but
unlabelled); #121 (RED/GREEN — none exists, it is a pre-registration plus a
struck comment; the only body carrying both `check` and `check:wiring` exit 0);
#130 (no exit code for the current head — the body says so outright; the codes
it carries are for the orphaned pre-rebase head `ea03d88`).

**The stale-head problem, which outweighs the missing blocks.** Only #121
(`91ed5f1a`), #120 (`a1164dd5`) and #84 (`8709ec66`) quote a guard run on their
own current head. Mismatches: #94 claims `8406ecbd` vs head `00319229`; #116
`28b801b8` vs `6dfc123d`; #125 `0f442fa` vs `9ed12b95`; #100 `eb813b4d` vs
`29c825cf`; #127 `43116ab` vs `883f4bff`; #130 `5b8a345` vs `8047ba76`; #131
`665cbb2` vs `3fddc87f`; #103 `a830c2b` vs `08c729e1`; #132 `8c04565` vs
`19510ce2`; #124 quotes no sha for its gate at all. A present exit code is not
by itself a statement about the tree that merges.

**Structural, from the same read.** Stacked bases: #103 → `…-3xqh5l-outcome-ledger`
(#94), #120 → `…-3xqh5l-tactics-absence` (#103), #84 → `…-o3wt2p-mainthread-holds`
(#77); #103 and #77 both `dirty`. CI red on the head read: #94, #116, #85,
#118. Zero check runs: #77, #84.

### Not in this pass

`#38`, `#40`, `#44`, `#43`, `#60`, `#15` — old PRs from paused or finished
threads; back in only if an owner sends a head.

`#72`, `#62`, `#74` — need the Independent Auditor's read before merge.

---

## 6b. FINAL STATE — stopped 18:42Z on Nick's usage order

**This thread is stopped.** No triggers were ever created by it and no PR
activity subscriptions were ever opened by it, so there is nothing to cancel or
unsubscribe; if a later session finds one attributed here, it is not this
thread's and should be checked before cancelling.

### Pick up here, in four lines

1. **Main is `6e7227194a3501aaff1371a0eeb159f5f1442e6e`**, verified green by CI
   run 35765300584, all 11 steps, 18:17:59Z. That is the last thing this thread
   measured. Anything merged after it is unverified by this thread.
2. **Merges ledgered:** #124 → `9f0b5b66` (its own main run was cancelled by the
   next push, never measured); #92 → `6e722719` (green, above).
3. **Not landed as of 18:30Z:** #132, #122, #123, #137 were handed to Nick to
   merge by hand while the MCP credential's write limit held (core 15000/15000,
   reset **19:16:42Z**). Expect a burst; only the last of it gets a main run.
4. **Before any merge, read the PR body** — §6 "Body read" above lists exactly
   what each open PR is missing. The single highest-value check is the
   stale-head one: only #121, #120 and #84 quote a guard run on their own
   current head.

### What a fresh auditor needs and nothing more

Read, in this order, and stop: this file's §1 (the bar), §6 (the ledger and the
body read), then `MEMORY.md`. Do not re-read thread history or re-fetch PR
bodies — the 18:07Z sweep output at
`/tmp/claude-0/-home-user-gridiron-hq/1481d0cb-1ceb-5218-b8e8-5e697e516c8e/tasks/aa2b6c8175eb5d710.output`
holds all 19 bodies in full and answered the entire R63 liveness question with
zero API calls. That file is session-local and will not survive the container;
if it is gone, one `pull_request_read` per PR is the fallback, not a sweep.

### The spend lesson this thread actually paid for

The expensive thing was never the tool calls. It was **re-reading context**: a
full suite reproduction per PR, then re-fetching bodies and heads that had
already been fetched. Three changes cut it to near nothing, in order of what
they saved:

1. **Stop re-running suites.** The role change at 18:06Z replaced a ~400s
   reproduction per PR with a body read. That was the single largest cut.
2. **`git ls-remote origin refs/heads/main`** for main's tip. Git over HTTPS
   does not touch the REST hourly budget; `list_workflow_runs` does.
3. **One read per CI run, timed to its finish, never polled.** The suite takes
   ~400s plus build and smoke; a timer costs nothing, a poll loop costs a
   context re-read every time.

Rule 1 is the one worth carrying to another account. Rules 2 and 3 are small by
comparison and only matter once rule 1 is in force.

---

## 7. Artifacts written today

- `/mnt/project-files/audit-lapsed-hold-reasons-2026-09-22.md` — the lapsed
  hold-reason sweep with per-thread routing.
- `/mnt/project-files/audit-pr108-wiring-map-2026-09-22.md` — the stale-base
  diagnosis that first separated "CI is red" from "this branch is broken".
- `/mnt/project-files/audit-refresh-lastline-c79f445-2026-09-22.md` — the
  wrong-commit (not wrong-tree) figure case.
- This file.
