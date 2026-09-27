# Handoff — Fantasy plan thread, 2026-09-22

Written at 18:03Z by the thread that holds `shrinkage-efficiency-weighting`
(PR #106). Everything below is checked against the tree or the API at that
time. Where something is inferred rather than verified, it says so.

---

## THREAD

**Name:** Fantasy plan thread (the Plan 01 / R25 / shrinkage unit).
**Session:** `session_01U2PQK2qw4VrXdytNqpq5an`. Any PR body in this
repository carrying that session link is this thread's work.

**Designated branch (harness):** `claude/project-thread-f921do`.

**Branches actually held:**

| branch | PR | what it is |
| --- | --- | --- |
| `shrinkage-efficiency-weighting` | #106 | the live branch; everything current is here |
| `claude/project-thread-f921do-season-list` | #66 | stale, open, draft |
| `claude/project-thread-f921do-arm-align-hold` | #79 | stale, open, draft |
| `claude/project-thread-f921do-memo-key-hold` | #80 | stale, open, draft |
| `claude/project-thread-f921do-weekly-scores-hold` | #83 | stale, open, draft |

The `claude/project-thread-f921do` prefix is this thread's. The
`claude/project-thread-n4052e` prefix (#48, #71, #81) is **not** — those carry
`session_01Fvh3EsJ4qTYUfpkB1ArgBM`, the Google sign-in thread, which has
finished.

---

## SHIPPED

**Nothing from this thread has merged.** #106 has never been merged and no
other branch of this thread has. If a later reader finds a merge sha attributed
to this thread, it was not this session's and should be checked rather than
believed.

---

## OPEN

### PR #106 — `shrinkage-efficiency-weighting` → `main`

- **head:** `af60024`
- **base:** `main` at `c90d2834` (merged in at `fe6d73d`, clean, zero conflicts)
- **size:** 25 non-merge commits, 16 files, +2,937 / −23
- **state:** draft. Deliberately unmerged.
- **gate state at handoff:** `npm run check:wiring` **exit 0** on tree
  `669436af`. Full-suite guard was mid-RUN 1 on `af60024` when this was
  written — see GUARD RESULTS below for what is and is not attested.

#### What is on it, in four parts

**Part 1 — the shrinkage efficiency-weighting fix.** `shrinkage-fit.js`'s
efficiency specs weight by RECENCY, not raw opportunity count (`c8939a8`).
Evidence: `docs/tdd/shrinkage-fit-efficiency-weighting-2026-09-22.tdd.md`.

**Part 2 — Plan 01's graded availability.** `fitGradedAvailability` +
`gradedAvailabilityMultiplier` in `server/services/nfl-player-context.js`,
with the §R19.6 conditioning fix (population taken from each entity's
EARLIEST `nfl_feature_revisions` row, not `nfl_injuries`' final value, because
`nfl_injuries` UPSERTs in place and reading it for a Sunday-lock decision is a
look-ahead leak). Evidence: `docs/tdd/injury-participation-term.tdd.md`.

**Part 3 — the R25/R36 level-vs-information decomposition.** Pre-registered
first, then run. See FINDINGS below for the result. Files:
`server/services/level-information-decomposition.js` (deliberately unwired),
`scripts/r25-level-vs-information.mjs`,
`docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-{PREREGISTRATION,RESULTS}.md`,
`docs/evidence/2026-09-22/r25-level-vs-information-output.json`.

**Part 4 — the §R40 kill switch and its §R51.1/§R54.3 conditions.** See
RULES below; this is the part with the most reusable lesson in it.

#### What is left before #106 can merge

1. The full-suite guard on `af60024` has to come back clean (both runs, exit
   0, tree hash unchanged either side). If it does not, that is work, not an
   explanation.
2. CI has to go green on the head. **Note that CI has never run this branch's
   test phase**: `check:wiring` runs *before* the tests in `ci.yml`, so while
   the gate was red the tests never executed. `# tests` appears zero times in
   the job logs for `d4c6e49` and `771bf64`. Every test number quoted for this
   branch comes from the local guard, not from CI. With the gate now at exit 0
   the next run should reach the tests for the first time.
3. The Evidence Auditor has to mark it REAL on the exact head.
4. Plan 01's coupled grade (§R35) — #106 was being held for it, and §R51.1
   released the multiplier half of that hold ("the multiplier half no longer
   holds #106"). Whether anything else of §R35 still holds it is the
   Auditor's call, not this thread's.

### PRs #66, #79, #80, #83 — stale, open, draft

All four are this thread's earlier work, each cut from an old `main`, each with
**zero check runs**. All four had a false paragraph claiming CI could not run
because the Actions allowance was exhausted or the workflow was off. That claim
is retired: `.github/workflows/ci.yml` does run on this repository. The bodies
were corrected in place (body only, no push), each now saying plainly that CI
has not run on that branch and that the earlier claim was wrong. The real
local-run numbers were preserved verbatim.

**They were deliberately not pushed.** Pushing would put four stale branches
into CI for the first time, which is a decision about reviving them, not a
correction. Whoever picks this up should decide keep-or-close on each rather
than inheriting them silently.

The same correction was applied to #48, #71 and #81 at the coordinator's
request, for the finished Google sign-in thread.

---

## BLOCKED

**Nothing is blocked as of 18:03Z.** The two holds that were live all afternoon
have both cleared:

- the wiring-gate hold cleared when #129 merged as `c90d2834`;
- the `docs/wiring/annotations.json` grant arrived from the Wiring map thread
  and is now applied at `af60024`.

The only thing outstanding is **a decision, not a blocker**: Nick is deciding
whether to cut the fleet, and this thread has been told to start no new unit
until the coordinator relays the answer. The queued units below are stopped on
that, not on any technical obstacle.

---

## FINDINGS HANDED OFF, NOT YET BUILT

Each of these is a measured result with nothing built on it. One line each,
with who should own it.

1. **The level correction on the incumbent (Auditor §R46 item 3).** 62% of
   control's apparent 2024 advantage is a calibration constant anyone can
   capture with `m0` (the prediction-weighted median of `actual/pred`) without
   adopting control's weight vector at all. The target is documented at
   `server/services/weekly-ensemble.js:69-77`. Must be pre-registered before
   it is run, in configuration B per §R43. **Owner: this thread, or whoever
   inherits it.** This is the highest-value unbuilt item on the list.

2. **`observed_diff` in `pairedBootstrapDiff` (Auditor §R51.2).**
   `server/services/backtest-significance.js:114` computes `mean_diff` as the
   mean over bootstrap *iterations*, and the function never returns the
   full-sample difference, so any figure quoted off `mean_diff` is
   seed-dependent in its 4th decimal — and `:119` rounds it with
   `toFixed(4)`, which is the same resolution. The fix is additive: return
   `observed_diff` beside `mean_diff` and quote that as the point estimate.
   48 files import the module and 45 call the function, so no existing key's
   value may change. A full plan, including the five tests it needs (one of
   which snapshots every pre-existing key, because that is the additive claim),
   was drafted but not started. **Owner: allocated to this thread; unstarted.**

3. **The sign-convention rule.** `weekly-ensemble.js:85-88` defines mean
   signed error as **predicted − actual** ("the blend sits BELOW the
   conditional mean… negative in every season"). The R25 module reports
   **actual − predicted**. Same direction, opposite sign, and they were never
   in disagreement — but §R46 made stating the convention explicitly a blocking
   condition, and it should be treated as standing: **state the sign convention
   before any signed error leaves a run.** **Owner: everyone.**

4. **`scripts/fit-weekly-coverage.mjs:227` runs `RUNS=300` against
   production's 2,000 draws.** The header at `:27-31` already records
   0.775–0.783 across seeds and draws with 0.778 at 2,000, and says changing
   either is a new gate. Must be pre-registered as a follow-up gate *after*
   the level correction, not run ahead of it. **Owner: this thread.**

5. **The `production()` named-configuration-marker unit.**
   `scripts/fit-weekly-coverage.mjs:72-75` holds a local `production()` helper
   (`{kOverride: undefined, roleRecency: WEEKLY_ROLE_RECENCY, predictionHead:
   ctx => weeklyEnsemblePrediction(ctx, champion.weights)}`) that should be
   promoted to one exported server-side definition. Per §R45 the shape is a
   **named configuration marker, not a required argument**: eight call sites
   are deliberately off on exactly the axis they fit or grade, and a required
   argument cannot tell those from the three that mean nothing by it. Silence
   must still throw. `server/services/nfl-blind-audit.js:263` is a live bug to
   fix in the SAME commit. `scripts/verify-qbr-integration.mjs:12-13` claims
   production and must switch to the marker. Any QBR re-run is a NEW
   pre-registered gate and must never be an edit of the struck paragraph at
   `projections.js:264-270` — **do not touch `projections.js`**, report the
   line instead; it belongs to the Model evidence audit thread. Reference:
   `/mnt/project-files/ROUTING-TABLE-REPLAY-CONFIG-2026-09-22.md` (24 rows).
   **Owner: this thread; unstarted.**

6. **Two pre-existing out-of-order entries in
   `docs/wiring/annotations.json`'s `accepted_orphan_modules`**:
   `vegas-fantasy.js` before `roster-risk.js`, and `week-postmortem.js` before
   `position-liquidity.js`. Cosmetic, not mine to fix. **Owner: the Wiring map
   thread.**

---

## RULES AND LESSONS A NEW SESSION MUST KNOW

### The R25 result: control was NOT promoted, and why

This is the substantive finding of the day and it is easy to get backwards.

A control weight vector appeared to beat the shipped `WEEKLY_ENSEMBLE_WEIGHTS`
on pooled MAE. The decomposition asked whether that gap was **level** (a
calibration constant) or **information** (a better ordering). Measured, on a
method locked before the run:

| season | n | raw delta | raw significant | debiased delta | debiased significant |
| --- | --- | --- | --- | --- | --- |
| 2024 (in-sample for control) | 4,419 | 0.0728 | yes | 0.0274 | **no**, CI `[-0.0570, 0.0037]` |
| 2021 (out of sample) | 4,341 | 0.0441 | yes | 0.0128 | **no** |
| 2022 (out of sample) | 4,359 | 0.0015 | **no** | −0.0572 | **yes, reversed** — shipped beats control |

So: 62% level / 38% information on 2024, the information share's own interval
includes zero, and on 2022 the comparison **reverses significantly in shipped's
favour** once both arms are centred on their own bias — under all three
anchors tried (2023, adjacent 2021, and 2022 in-sample as the most favourable
case available to control). §R46 ruled control **not promoted** and the
information component a failure against the house standard.

**Do not rebuild a promotion case for control's vector on the pooled MAE figure
without first explaining why 2022 disagrees.**

Two numbers that are WITHDRAWN and must not be re-quoted: the −4.6 pts/week
figure and the 80% ordering figure. Direction and qualitative finding stand;
the numbers do not.

The canonical information share for Plan 01 criterion 1b is **14.6%** (21.02%
and 29.82% are superseded).

### Every rig result carries the R37 rider

Verbatim: *"this grades the replay predictor, whose equivalence to
production's is unestablished."* That question is still open. Any figure from
the replay rig carries this line until it is answered.

### The committed-fixture RED form (Auditor §R54.3) — the most reusable lesson

A **guard test** (a test whose job is to fail if some shape appears anywhere in
the tree) has no honest RED by default, and two tempting forms are both
refused:

- a **committed production violation** is refused — it puts the thing you are
  guarding against into the repository's history;
- a **working-tree violation**, introduced and removed, is refused — nobody
  else can reproduce it.

The required form: make the scanner **a function over `{path, source}`
records** rather than over the file system, commit the cases as **inline string
fixtures**, and add a separate test that pins the **real tree scanning clean**.
Then the RED is a real commit and anybody can re-run it.

Applied here at `60dc4f0` (RED, 18 pass / 2 fail) and `d01aac8` (GREEN, 20/20).
The two that failed were an **aliased import**
(`import { gradedAvailabilityMultiplier as gam }`) and a **destructured dynamic
import renamed on the way out** — both invisible to a bare-name paren parse.
That is the §R33 blind spot, and requiring those two cases is what found a real
hole in a scanner that already looked finished.

Three things worth copying into any future scanner:

1. **Strip comments before scanning.** The flag's own docstring spells out
   `gradedAvailabilityMultiplier(..., { enabled: true })` as prose; a scan that
   read comments would report the documentation as the violation, which is the
   kind of false positive that gets a gate switched off.
2. **Strip string bodies too.** The fixtures are violating source held in
   template literals *in the same test file*; a scanner that read string bodies
   would report its own fixtures as real findings.
3. **Commit must-NOT-flag fixtures as well.** A scanner that flags everything
   passes every must-flag case and is still useless. Here: wiring the module in
   without an override (permitted), the override as docstring prose, and the
   override held in a string.

Plus one sanity assertion worth having: in the declaring file, the binding
resolver must find **exactly one** local name. Anything extra means it is
reading a call as an alias, which makes every later finding suspect rather than
merely noisy.

### The §R40 kill switch, and why it is a default rather than a hard block

`GRADED_AVAILABILITY_ENABLED = false` in
`server/services/nfl-player-context.js:537`, exported, with the reason in the
docstring above it at `:506-536`. `gradedAvailabilityMultiplier(...,
{ enabled = GRADED_AVAILABILITY_ENABLED } = {})` returns the neutral
`{ multiplier: 1, known: false, reason: 'graded_availability_disabled' }` for
every input while the flag is off, **before any bucket lookup**.

Zero behaviour change, checked not assumed: `grep -rn
"gradedAvailabilityMultiplier" server/` excluding tests returns one definition
and **zero call sites**.

Why a flag at all when nothing calls it: with no flag, the first caller to wire
it up switches live behaviour in a diff that only looks like wiring. With the
flag, wiring and enabling are two separate one-line changes and the second one
is the reviewable event.

**Why it is a default and not a hard block — this was the design decision the
Auditor accepted.** Gating the function body made three existing tests fail,
because they grade the *enabled* behaviour and they are Plan 01's evidence.
Deleting or weakening them would have been fixing the test instead of the
design. So the flag became a default and those tests opt in explicitly
(`const ENABLED = { enabled: true }`), each naming inline what it would be
grading if the flag were off. §R51.1 accepted this shape and refused the harder
one.

**Where default-on is allowed to happen:** at the coupled grade's named call
site and nowhere else, because that is where §R19.6's as-of refit binds. This
is now enforced mechanically, not promised: the scan permits a caller to *wire*
the multiplier in and fails the build if one passes a 6th argument at all.

### Other standing rules this thread operated under

- **TDD with a written record**: a RED commit, a GREEN commit, an evidence file
  under `docs/tdd/`. Fix the implementation, not the test, unless the test is
  wrong.
- **R52.2 citation rule**: evidence files and PR bodies cite RED and GREEN as
  `#N`, commit subject, sha, with the RED's failing assertion message inline,
  and update shas in the same push that rewrites them. Squash merges make every
  branch sha unreachable from `main`, so `refs/pull/N/head` is what keeps the
  pair readable. Where a RED was *not* a separate commit, say so rather than
  citing a sha that does not exist.
- **Local gate**: `npm run check && npm run check:wiring` under one guard, both
  exit codes quoted against one tree hash. As of `c90d2834`, `npm run check`
  includes the wiring gate; quoting both is still the rule.
- **One clean run, not ritual double-runs** (Nick, 15:17Z). The guard script
  performs 2 runs internally regardless. See SPEED below.
- **A failing test is never "a flake" until proven, and "no API key" is not a
  cause.**
- **Secrets never appear in the repo, a commit, chat, or a screenshot.** Read a
  value's presence, never its content, into a log or a message.
- **Attribution footers stay ON** — `CLAUDE.md` §3 explicitly rejects the
  upstream "attribution disabled globally" rule.
- **Verify a model switch against `last_served_model`, never against the switch
  tool's success message.** The tool reports success when the API has rejected
  the model. This session confirmed a switch that had not happened and had to
  correct it; `get_session` showed `user_switch_rejected:
  "claude-opus-5-5[1m]"`.
- **Threads report to the coordinator, never directly to Nick.**

### The atomic-verification discipline, and where this session broke it

The guard (`bash /mnt/project-files/verify2x-v4.sh <commit-ish> [tag]`) runs the
suite in an isolated detached worktree and prints `GUARD BEFORE` / `RUN N EXIT`
/ `GUARD AFTER` / `DONE`. Its value is the before/after comparison of the
primary repo: same `git status`, same write-tree, same `node_modules` mtime.
**So nothing may touch git or a tracked file in the primary repo while that
window is open.** The script is not executable (`-rw-r--r--`), so it must be
invoked via `bash`.

This session broke that rule once, and it is recorded here rather than left for
someone to trip over: the guard on `771bf64` was judged superseded, an attempt
was made to kill it, the kill did not take, and the merge and the annotations
commit landed in the primary repo while its window was still open. Its `GUARD
AFTER` therefore reports write-tree `669436af` against a BEFORE of `afb20a79`.
**The test results still stand** — both runs happened in the isolated worktree
at the pinned tree, verified identical to `771bf64` at start, and both came
back exit 0 with `3145 tests / 3104 pass / 0 fail / 41 skipped`. What is lost
is the guard's attestation that nothing else moved. The lesson: confirm a kill
took effect before touching the repo, and prefer waiting to racing.

---

## GUARD RESULTS

| tree / head | runs | result | attestation |
| --- | --- | --- | --- |
| `d4c6e49` (tree `93b22df5`) | 2 | exit 0 both, `3135 / 3094 / 0 / 41` | clean; BEFORE == AFTER |
| `771bf64` (tree `afb20a79`) | 2 | exit 0 both, `3145 / 3104 / 0 / 41` | **runs valid, before/after window broken** — see above |
| `af60024` (tree `669436af`) | in flight at 18:03Z | — | `check:wiring` separately **exit 0** on this tree |

`44944a9` and `1a70355` were also guarded clean earlier in the day
(`3133 / 3092 / 0 / 41` and `3122 / 3080 / 1 / 41`, the latter's single failure
being the `trades.js` issue since fixed on `main`).

---

## FILES OWNED OR HELD ON GRANT

**Owned by this thread** (one editor per file):

- `server/services/nfl-blind-audit.js` — has a live bug at `:263`
- `server/services/weekly-backtest.js`
- `scripts/verify-qbr-integration.mjs` — claims production at `:12-13`
- `scripts/fit-weekly-coverage.mjs` — the draws question at `:227`
- `server/services/level-information-decomposition.js` (created here)
- `scripts/r25-level-vs-information.mjs` (created here)
- `server/services/backtest-significance.js` — allocated for the one additive
  `observed_diff` unit only
- `server/services/nfl-player-context.js` and
  `server/services/shrinkage-fit.js`, for the work on #106

**Held on a one-time grant:** one entry in `docs/wiring/annotations.json`. The
file belongs to the Wiring map thread; the grant was for exactly one
`accepted_orphan_modules` path plus its `_PERMANENT_ORPHAN_REASONS` prose, both
now applied at `af60024`. **The grant is spent — do not edit that file again
without a new one.**

**Explicitly NOT this thread's:** `server/services/projections.js` (Model
evidence audit). Report the line, never edit it. In particular the struck
paragraph at `:264-270` is never to be edited; a QBR re-run is a new gate.

---

## NEXT THREE STEPS FOR A SESSION PICKING THIS UP COLD

1. **Read the `af60024` guard log and finish #106.** The log is at
   `<scratchpad>/guard-runs/run-r54merge.log`; if the container is gone, re-run
   `bash /mnt/project-files/verify2x-v4.sh af60024 <tag>`. Quote both exit
   codes against tree `669436af` in
   `docs/tdd/graded-availability-kill-switch.tdd.md` and in #106's body, then
   send head + exit codes to the coordinator for the Evidence Auditor. Watch
   for the first CI run that actually reaches the test phase on this branch.

2. **Decide keep-or-close on #66, #79, #80, #83.** Four stale drafts with zero
   check runs and old bases. Their bodies are now honest about never having been
   through CI. Each needs a rebase-and-push or a close; do not leave them as
   they are.

3. **Pre-register and price the level correction** (FINDINGS item 1). It is the
   one unbuilt item with a measured 62%-of-the-gap case behind it, the target is
   already located at `weekly-ensemble.js:69-77`, and §R46 asked for it
   explicitly. Pre-register the method before running it — that order is what
   made the R25 result hold up when the outcome went against the arm that looked
   like it was winning.

Do not start any new unit until the coordinator relays Nick's decision on
cutting the fleet.

---

## SPEED AND TOKEN SPEND — one measured observation

Nick asked which combination gives the best speed for the lowest token spend.
One concrete data point from this thread rather than an opinion: **the guard
script runs the suite twice internally, and each run takes about 7 minutes**,
so every verification costs ~14 minutes of wall clock. Nick's own 15:17Z rule
is one clean run with the full rundown, and a second run only if something
actually changed. On the five guards this thread ran today, the two runs
returned **identical** counts every single time. The second run has not caught
anything all day. Making the second run conditional rather than automatic would
halve verification wall-clock time at no evidential cost, which is the cheapest
speed win visible from here. It needs a change to
`/mnt/project-files/verify2x-v4.sh`, which this thread does not own.

---

## ADDENDUM — #106 MERGED, 18:36Z

**#106 squash-merged as `b3e79709`.** This supersedes the SHIPPED section
above, which said nothing from this thread had merged.

- Merged head: `fc6c973`, tree `e7bbef7d82e75853fa4055084ce1826322964281`,
  base `main` at `c0a051b`.
- Guard (v4, one run per the verify-once rule): `npm run check` **exit 0**,
  `# tests 3652 # pass 3611 # fail 0 # skipped 41`; `check:wiring` **exit 0`;
  `git write-tree` identical either side; `verify2x-v4.sh` md5
  `7896b6e3b97be1ce1f27964c051746a1` unchanged across the run.
- CI green on the same head (run 35767043741, conclusion success). The earlier
  run on `1bfa0cd` was this branch's first green **and** the first CI run that
  reached the test phase at all — every run before it died at `check:wiring`.
- Body carries merge-gate v2 sections 1 to 5 in full.

**Landed with it, beyond what the OPEN section described:** the R64 fix at
`1bfa0cd` — `shrinkage-fit.js` no longer describes ceiling-lineup as a
season-long caller, since the UI thread's #132 made it pass a mid-season
`throughWeek`.

**One finding sharpened rather than just recorded.** The four remaining names
on that season-long-caller list (preseason-model, season-sim, draft-assist,
week-postmortem) are there on an *assumption*, never an individual check.
ceiling-lineup was on the list for the same reason and turned out to be wrong.
So the finding is not "four callers deserve the same question" — it is that
**the list was built by assumption and has now been shown wrong once**. Each
needs its own answer to what it actually passes and whether the weighting its
evidence accumulates under is the one its k was fitted in. Owner: whoever
inherits this thread.

**Two process lessons from the last hour, both mine:**

1. **`pkill -f` on a guard's script path does not reach its npm children.** The
   parent dies, the run continues headless, and a later "the guard is stopped"
   is simply false. This caused both of today's broken guard windows. Kill by
   PID, then `pgrep` until clear, *then* touch the repository.
2. **Never edit a shared guard script in place while any run may be using it.**
   `verify2x-v4.sh` was rewritten mid-run today; bash reads a script
   incrementally, so the loop body was safe (parsed before the edit) but the
   post-loop block was not. This is now merge-gate v2 §1.7. `verify2x-v5.sh`
   exists with a conditional second run.

**Still true and unchanged:** the NEXT THREE STEPS above, minus step 1 (#106 is
landed). Step 2 is now first: decide keep-or-close on #66/#79/#80/#83. Step 3,
pre-registering and pricing the level correction at `weekly-ensemble.js:69-77`,
remains the highest-value unbuilt item.
