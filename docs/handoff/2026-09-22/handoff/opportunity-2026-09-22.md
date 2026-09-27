# Handoff — Player opportunity thread (w45mur) — 2026-09-22

Written on Nick's 17:57Z instruction to save all work. Everything described
here is on `origin`; nothing of value lives only in this container.

---

## THREAD

**Player opportunity**, thread `w45mur`, session `session_01BvuTs792dFTGix8BixBJWv`.

Designated branch: `claude/project-thread-w45mur`. Five working branches were
cut from it, all pushed:

| branch | head | PR |
|---|---|---|
| `claude/project-thread-w45mur` | `31f841f5` | — (base branch) |
| `claude/project-thread-w45mur-reach-ladder` | `1d5076fe` | **#135** |
| `claude/project-thread-w45mur-symbol-reach-namespace` | `6dfc123d` | **#116** |
| `claude/project-thread-w45mur-wiring-names-hold` | `69909edd` | **#85** |
| `claude/project-thread-w45mur-cascade-grade` | `ffe83637` | **#72** |
| `claude/project-thread-w45mur-inventory-contract` | `605ab3f6` | merged as #99 |

Plus two **archive** refs, pushed for preservation only, described under
FILES below. They are not merge candidates.

**The through-line of everything here:** make `docs/inventory/CONTRACT.md`'s
reachability rules executable, because by the contract's own test *a rule
with no consumer that can detect its violation is decoration*.

---

## SHIPPED

**#99 — the two reach graders.** Squash-merged to `main` as **`c5ee3b54`**.
`scripts/reach-grade.mjs` and `scripts/symbol-reach.mjs`. This is the
foundation everything below stands on, and it is unchanged since.

One thing to know about that merge: the squash landed on a `main` that had
moved while I held a stale `origin/main`, so **`c5ee3b54`'s tree is not the
tree I tested** (`5c6cce90` vs `1da962d3`). Nothing was lost, but do not
assume a merge sha's tree equals the branch's.

---

## OPEN

### #135 — A command for CONTRACT.md's reach ladder, which had none
- head **`1d5076fe`**, base `main` `c90d2834`, draft, 3 files / +738.
- RED `5f2433dc` → GREEN `1d5076fe`.
- **Gate state: a run on this exact head was in flight when this was written.**
  The PR body says so at the top and says plainly not to merge on the earlier
  run. The pre-rebase head `83b67b82` returned `check` exit 0 (3,547 tests,
  3,506 pass, 0 fail, 41 skipped) and `check:wiring` exit 1 with three
  findings that are #129's false positives, all three reproducing on bare
  `main`. That run does **not** transfer: `git diff 83b67b82 1d5076fe` is ten
  files, because the rebase pulled in #129 itself and the gate definition
  changed underneath the branch.
- **Left before merge:** post the rebased exit codes on the PR; Evidence
  Auditor ruling (pre-ruled R59, three points, all carried into the body).

### #116 — symbol-reach misses namespace imports
- head **`6dfc123d`**, base `main` `f620a120` (**stale — needs main merged in**).
- **Ruled REAL.** Queued behind #94.
- **Left before merge:** rebase/merge onto `c90d2834`, one guarded run, merge.

### #85 — one vocabulary for what priced a chance to play
- head **`69909edd`**, base `main` `f620a120` (**stale**).
- Verified. Was parked since Saturday on a reason that had expired.
- **Do not rebase this branch.** It carries an add/extend/revert/revert round
  trip, so replaying it onto current `main` replays two *reverts* of the
  `CONTRACT.md` that #99 landed — it would delete a live document. It also
  has a different GitHub author. **Merge `main` into it, never rebase.** I hit
  two permission gates trying to `git rebase --skip` through this and aborted
  cleanly rather than working around them; that was the right call and the
  next session should not retry it.

### #72 — stop publishing a teammate-absence multiplier resting on one target
- head **`ffe83637`**, base `main` `791b131f` (**very stale**), 7 files / +1049.
- Body corrected at 17:56Z: it had claimed *"CI is not run: the repository's
  one workflow is disabled while the Actions allowance is exhausted."*
  **That was false and is now withdrawn under a visible "Retracted" heading.**
  Workflow `357164314` is active with completed `main` runs (2026-09-19, and
  two on 2026-09-22). The true, narrower statement: `list_workflow_runs`
  filtered to this branch returns **zero runs** and head `ffe83637` carries
  **zero check runs**. The claim was only ever in the PR body — it is in no
  committed file, so no push was needed to fix it.
- **Left before merge:** merge `main` in, push, get this branch's first-ever
  CI signal, then audit.

---

## BLOCKED

1. **#135 on the Evidence Auditor.** It cannot rule until the head is on
   `origin` — it now is (pushed 17:5xZ). Needs the rebased gate exit codes
   posted, which the next session should read from `/tmp/checkL3.log` if this
   container still lives, or simply re-run.
2. **#116 and #85 on a merge slot.** Both are stale-based and both need
   `main` merged in first. #116 is behind #94 in the Auditor queue.
3. **#72 on nothing but attention.** It has no CI signal at all and has sat
   since 2026-09-20. It is also costing every other branch a warning: the
   wiring gate reports `server/services/cascade-grade.js — names a file that
   is not in this tree` as an accept-list entry that has outlived its reason,
   and that keeps firing until #72 lands.
4. **Not blocked on Nick for anything.** No question is outstanding to him
   from this thread.

---

## FINDINGS HANDED OFF, NOT BUILT

- **The live cookie read** for the capture-trigger probe — needs Nick, was
  never run. Owner: Scheduler thread.
- **`nfl-capture-dispatch.js`**: `enqueueRecentNewsTriggers` only INSERTs
  `state='pending'`; `dispatchTriggeredCapture` (job-only, two scheduler
  importers) is the only writer of `attempted_at` / `deferred` / `captured` /
  `failed`. Owner: Scheduler thread.
- **The `178 → 172` CONTRACT.md correction**, plus withdrawing the `178`
  column's printed total (it sums to 325 against a population of 319).
  Deliberately **not** in #135 — CONTRACT.md is Wiring map's file, and the
  command should be audited before a document is edited on its output.
  Owner: Wiring map thread; it appears to be **#137**.
- **The call-graph measurement.** Pre-registered and cleared, sequenced after
  the ladder, not started. `/mnt/project-files/w45mur-callgraph-PREREGISTRATION.md`.
  The pre-registration commits to hand-classifying a 20-file held-out sample
  **before** running any tool. Owner: unassigned.

---

## RULES AND LESSONS A NEW SESSION MUST KNOW

**The ladder. `node scripts/reach-ladder.mjs` is now the only legitimate
source of a reach figure.** On current `main`, population 321:

- **169 of 321** `wired` counting **only module-scope imports** (run at load).
- **225 of 321** `wired` counting **module-scope and in-function imports
  together** (the second kind runs only when its function is called).

**Never quote one of those as "the" wired count.** They are two answers to
two questions, not a range around an estimate. On the falsification tree
`b0c1616d` the same pair is **172 / 228** of 319, reproducing the Auditor's
R54.1 run cell for cell.

**These numbers are unreproducible and must not be requoted: `183`, `116`,
`67`, `53`, `14`, `178`.** No command produces any of them. `178` announces
its own defect: its column sums to 325 against a population of 319.

**Two axes, never conflated.** EDGE MECHANISM (module-scope vs in-function
import) is the bracket. ENTRY TYPE (mounted route vs package.json script) is
**not** a bracket — it is one graph, two kinds of entry. Conflating them is
what produced `116 / 67`. A third notion is separate again: package.json
scripts the scheduler *spawns* via `execFile` are not "job reach".

**M1, the lesson with the widest reach.** A rule that tests a function
*taking* a predicate is **not** a rule about the predicate. After the entry
split was fixed, deleting the betting exclusion from `measure()`'s call site
**survived the entire suite** — the `entrySplit` rule injects its own
predicate, so it pinned the unit and said nothing about the wiring. The
suite would have certified the bug just repaired. Fixed by exporting
`routeEntryPredicate` and pinning it directly. **Keep M1 as a standing
call-site mutant**: the pin kills it, but re-running it is what proves the
pin still reaches the call site.

**Cite the population subtree, not the commit `write-tree`.** A document that
cites its own `write-tree` invalidates that citation the moment the document
is edited — this happened here, the fix went stale while being typed. Cite
`git rev-parse HEAD:server/services` (`2c900fff`) and `…:server/modeling`
(`6bbd8e6a`). Those move only when the measured code moves.

**A line number is only a fact about the tree it was read on.** This thread
cited `scheduler.js:714-721`, which is *correct at `b0c1616d`* and wrong at
`f620a120` (there: `:737-742`, docblock `:728`). A cite that outlived its
tree is a different defect from a fabricated one.

**`npm run check` did not run CI's wiring gate** — every clean local run this
thread quoted before 17:10Z missed it. **#129 has now folded `check:wiring`
into `check`**, so on `c90d2834` and later, `npm run check` is sufficient.

**A falsy return read as a real negative** — four defects in one day shared
this shape. A zero, empty set or "success" from bespoke tooling earns one
**contradiction test** (a case you know is non-zero) before it is believed.

**Empty rebase range reports success and empties the branch.** Pass the *old
base* as upstream, never the branch head. Always check
`git diff --stat <base> HEAD` after a rebase.

**Merge, never rebase, someone else's branch.** A merge commit keeps their
checkout valid; a rebase rewrites the shas their PR body cites.

**SQL:** never alias a computed column with the name of a real column in the
same table — SQLite resolves the bare name to the column, silently, and
returns a wrong grouped answer rather than an error.

---

## FILES I OWN OR HOLD GRANTS ON

One editor per server file. Mine:
- `server/services/contingency.js`
- `server/services/opportunity-model.js`
- `server/services/availability-basis.js`
- plus any new file I create.

Created by this thread:
- `scripts/reach-ladder.mjs`, `test/reach-ladder.test.js`,
  `docs/tdd/reach-ladder.tdd.md` (#135)
- `scripts/reach-grade.mjs`, `scripts/symbol-reach.mjs` (merged, #99)
- `server/services/cascade-grade.js`, `scripts/grade-cascade-multipliers.mjs`,
  `docs/tdd/cascade-grade.tdd.md` (#72, unmerged)

**Not mine, explicitly:** `docs/inventory/CONTRACT.md` (Wiring map's).
Betting files are out of scope — findings recorded, files never edited.

**Archive refs** — pushed so nothing is lost when this container is
reclaimed, **not merge candidates and no PR opened for either**:
- `archive/w45mur-data-completeness-check` (`06f7b4e7`)
- `archive/w45mur-wiring-map-5ab50c8` (`5ab50c85`)

Both branched long ago; their diff against current `main` is a **90,529-line
and 50,858-line deletion** respectively, because `main` has moved far past
them. Opening PRs for them would put two destructive merge candidates on the
board during a fleet cut. Read them with `git log`, never merge them.

---

## NEXT THREE STEPS FOR A COLD SESSION

1. **Finish #135.** Run `npm run check` on `1d5076fe` in a clean worktree
   with a guard (`git write-tree` before and after, `git status --porcelain`
   must be 0), post the exit code as a PR comment, and hand the head to the
   Evidence Auditor. Do not edit `CONTRACT.md` — that is #137's.
2. **Unstick #116, then #85.** Merge `main` into each (**merge, never
   rebase** — #85 would delete a live `CONTRACT.md` if replayed, and both
   have foreign authorship), one guarded run each, then merge in queue order.
3. **Give #72 its first CI signal.** Merge `main` in and push. That also
   clears the stale `cascade-grade.js` accept-list entry that is currently
   warning on every branch in the repo.

If anything below is quoted onward, quote it with its tree: the ladder is
169/225 of 321 on `main` `c90d2834`, services subtree `2c900fff`.

---

# ADDENDUM — 18:32Z, written under the usage freeze

Everything above was written at 18:02Z. This addendum is what happened after,
and it is the part a fresh session should read first.

## What landed after 18:02Z

| PR | merge sha | what it was |
|----|-----------|-------------|
| #72 | `3ceb7047` | retires the stale `cascade-grade.js` accept-list entry that was warning on every branch; body's false "CI cannot run" paragraph replaced under a visible **Retracted** heading, not deleted |
| #85 | `c0a051bd` | `git diff origin/main HEAD -- docs/inventory/` = 0 files, confirmed before merge |

Both carried a full merge-gate block (sections 1–5) posted **before** the merge,
CI green on the exact head, RED/GREEN verified as ancestors, and
`package-lock.json` confirmed untouched (which is why `npm ci` was skipped and
said so).

## What is open

**#135 — `scripts/reach-ladder.mjs`** (branch
`claude/project-thread-w45mur-reach-ladder`, head **`554e9b6a`**). Draft,
advisory, waiting on the Auditor. Three pushes after 18:02Z:

- `fee2c700` — R67.1: the bound's scope narrowed. `wired` is a floor;
  `hand-run-script` and `unreached` are **unsettled**, not floors, and the doc
  now says so instead of implying the whole ladder is bracketed.
- `554e9b6a` — R67.2: **225 is exact only on `c90d2834`, subtree `2c900fff`.**
  The command still prints the bound on every tree, because exactness is a
  property of one tree and not of the command. That distinction is the point;
  do not "fix" it by making the command print an exact number.

**#116** — head `4012bd83` (current main merged in, contribution unchanged at
3 files / +302, `af13e262` and `9a41cb61` re-verified as ancestors). **CI was
still running at 18:32Z** — check run `106879195618`, started 18:25:41Z. It is
the one thing left before the merge-gate block and squash-merge. Nothing else
about it is outstanding.

## Preserved, deliberately without PRs

Two orphan branches kept as `archive/w45mur-*` refs. Their diffs against main
are **90,529** and **50,858 line deletions**. They are snapshots, not merge
candidates; do not open PRs for them.

## The two findings that should shape the next PR

**R66 — the high ends are floors, not estimates.**
`buildImporterGraph` at `scripts/reach-grade.mjs:99` matches only `from '...'`
and `import('...')`. A bare side-effect `import './x.js';` is invisible to it,
while `classifyImportEdges` **can** see one. So every high end the ladder
prints is a lower bound. This surfaced by accident: the first rule-15 fixture
used bare imports and produced the impossible result of request+job reaching
*fewer* files than request-only.

**The bracket is two axes, never one number.**
EDGE MECHANISM (module-scope import runs at load vs in-function import runs
only when called) is CONTRACT.md's bracket. ENTRY TYPE (mounted route vs
package.json script) is **not** a bracket. Conflating them is what produced the
discarded `116 / 67`. A third notion exists and is neither: scripts the
scheduler *spawns* via `execFile` are not "job reach", which means the
in-process scheduler's deferred `import()` calls.

## NEXT THREE STEPS, in order

1. **#116**: read its CI once, post the merge-gate block, un-draft,
   squash-merge, record the sha. Do not re-check before ten minutes have
   passed.
2. **The R66/R66.1 grader PR** — fix `buildImporterGraph`'s bare-import
   blindness at `scripts/reach-grade.mjs:99`. The Auditor has already specified
   the RED: **an inline bare-import fixture plus a superset invariant (every
   request edge is in the full graph)**, and per R67.1 the fixture
   `import './x.js'; // note` as the counter's contradiction test. Note
   `reach-grade.mjs` is **not my file** — this needs an allocation before
   editing.
3. **#135** rides its Auditor ruling. It adds no grading logic by design; it
   imports everything from `reach-grade.mjs`. Keep it that way.

## Rules this thread learned the hard way (each cost a real defect)

- **Mutate the call site, not only the unit.** M1 was recorded killed when only
  its unit form was. The call-site mutant
  (`routeEntryPredicate(mounted)` → `e => mounted.has(e)` at
  `reach-ladder.mjs:266`) **survived 14/0** afterwards, and is now a standing
  row (M1b) in `docs/tdd/reach-ladder.tdd.md`. This defect recurred at two
  levels in the same file, the second time to someone who had just written the
  lesson down.
- **Cite the population subtree hash, not `write-tree`.** A document citing its
  own `write-tree` invalidates that citation the moment the document is edited.
  It went stale while being typed.
- **A cite that outlived its tree is not a fabricated cite.** I asserted
  `:714-721` "matches no tree in this history"; it is correct at `b0c1616d`.
  Different defect, different fix.
- **A falsy return from bespoke tooling earns one contradiction test** — a
  known-nonzero case — before it is believed.
- **Check before reporting a cause.** Two hypotheses for the 10/26-vs-11/25
  discrepancy died on inspection: the `NOT_A_CONSUMER` filter difference is
  inert (`git ls-files client/dist` = 0 files), and `isHandRun` is
  character-for-character identical in both files. The first would have been
  reported as the cause.
- **An empty rebase range reports success** and leaves a branch with none of
  its work. Check `git diff --stat <base> HEAD` after every rebase.
- **`git ls-remote` is authoritative for main**, over a local `--contains`
  check or a peer's merge report. The coordinator said main was `bd903669`;
  it was `c0a051bd`.
- **Merge, never rebase, someone else's branch.** Refused a coordinator request
  to rebase #124/#125 — different thread, different GitHub account, would break
  their checkout and invalidate sha citations. The coordinator agreed it was
  its error.

## Usage notes for whoever restarts this thread

One unbounded `git diff --stat` on #72 persisted a **2.1MB** diff to disk and
taught nothing. Read targeted. Do not re-read a file you just wrote. Ending the
turn is how you wait — PR events and relays wake the session on their own.

---

**STOPPED 18:42Z on Nick's order.** #116 head is **`98129cbc`** (current main
merged in, 18 rules pass locally, contribution unchanged at 3 files / +302,
`package-lock.json` untouched) — **merge on CI green is owed** and is the only
thing outstanding in this thread. PR subscriptions for #116 and #135 are
cancelled; this thread created no triggers. Read this file, not the thread
history — that is the whole point of it.
