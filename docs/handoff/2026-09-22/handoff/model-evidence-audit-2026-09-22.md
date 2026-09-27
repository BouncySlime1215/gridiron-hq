# Handoff — Model evidence audit
**Written 2026-09-22 ~18:00Z.** Session `session_01RaKeP3tXctv8SXVFaMRZdd`.
Everything below is checkable on a tree named in it. Where a number has no tree,
it is marked as such.

---

## THREAD AND BRANCH

- **Thread:** Model evidence audit. Reports to the coordinator session, never
  to Nick directly.
- **Designated branch:** `claude/project-thread-w0gpjt`. It is the only branch
  this thread holds. Head **`91ed5f1a`**, tree **`f5969717`**, base
  `origin/main` @ **`c90d2834`**, pushed.
- **Job of the thread:** grade the model's own claims. Not to build features —
  to decide whether a number the model produces is evidence or decoration, and
  to leave a written record either way.

---

## SHIPPED

### #68 — merged as `26a5002a`
*"The target-share prior, graded"*. What actually landed:

- A per-position target-share prior (`positionalPriors()`), **default-off
  behind the `sharePrior` flag**, because the Auditor refused the default (R35)
  and the evidence says he was right to.
- `server/services/projections.js` carries the whole finding as a comment block
  at the prior: the measured means, the QB correction, the graded result with
  the DNP null, **THE RULING** (the prior and the availability multiplier are
  one finding and neither ships alone), and `K.share = 6` left open on purpose.
- `test/target-share-prior.test.js`, 5 tests. **Test 4 pins the DEFAULT** and
  carries the argument in its own body: *if this test starts failing, that grade
  is what is owed — not a change to the assertion.*
- `docs/evidence/2026-09-22/target-share-prior-result.md` — the graded result.

**The finding itself, in one line:** the prior wins **+0.1044 targets of MAE**
on weeks played (observed; bootstrap 90% CI [+0.0661, +0.1460]) and is a **null**
once missed weeks count (**−0.0136**, [−0.0499, +0.0225]).

**Why, and this is the part that matters:** the legacy `0.06` under-projected
every pass-catcher (mean signed error **−0.9764** targets). **A systematically
low projection is an accidental hedge against the weeks a player does not
play.** De-biased, the prior wins on *both* metrics, so it carries real
information; what the DNP metric exposes is not a bad prior but a **missing
availability term**. That is the whole reason the next unit is coupled.

---

## OPEN

### PR #121 — draft, `claude/project-thread-w0gpjt`
*"Pre-register the coupled grade, strike a verdict that measured the wrong
thing, and correct two of our own claims"*

- **Head `91ed5f1a`** (tree `f5969717`), base `main` @ `c90d2834`, **pushed**.
- **Three files, no behaviour change.** The only server change is a comment
  block.
  1. `docs/evidence/2026-09-22/coupled-prior-and-availability-preregistration.md`
     — new. The coupled grade, pre-registered.
  2. `server/services/projections.js` — the QBR verdict struck in place.
  3. `docs/evidence/2026-09-22/target-share-prior-result.md` — the R51.2
     observed-vs-bootstrap correction.
- **Gate state: GREEN on the pushed head.** `npm run check` on `91ed5f1a`
  (tree `f5969717`): **exit 0 — 3,553 tests / 3,512 pass / 0 fail / 41
  skipped / 0 cancelled / 0 todo**. `npm run check:wiring`: **exit 0**, run a
  second time explicitly in the same guard because as of `c90d2834` the wiring
  gate is *inside* `npm run check`, and the explicit run confirms the inclusion
  rather than assuming it. Guard captured inside the same command either side:
  `git status --porcelain` empty both sides, `git write-tree` stable at
  `f5969717` and equal to `HEAD^{tree}`, `HEAD` unmoved, `node_modules` mtime
  unchanged, no non-dist writes in the window. **This is the first run on this
  branch that exercises everything CI exercises.**
- **What is left before merge:** the Evidence Auditor's REAL on the pushed head,
  after the Independent Auditor's R57 clearance. Nothing else is known to be
  outstanding.

**R52.2 does not bite on #121** — there is no RED/GREEN pair, because nothing is
implemented. It is a pre-registration, a strike and a correction. R52.2 **will**
bite on the grade's own PR and must be carried there.

---

## BLOCKED

**Nothing, as of this writing.** The two things that were blocking are gone:

- The fleet-wide `check:wiring` red on `main` cleared when **#129 merged as
  `c90d2834`**, and `npm run check` now includes the wiring gate.
- R57's three text items and the QBR strike's false reason are fixed in
  `5fe195bf` and pushed.

The only thing the thread waits on is an auditor's turn-round, which is a queue
position, not a blocker.

---

## FINDINGS HANDED OFF, NOT YET BUILT

Each of these is measured or established. None is implemented.

1. **The coupled grade — prior + availability multiplier, one unit.** Fully
   pre-registered in the document above. **Owner: this thread.** The call site
   is named: `projections.js:605` on `origin/main` @ `c90d2834` — the assignment
   to `targets` whose right-hand side is `tgtShare * tv.pass_att` — multiplying
   **projected targets per game**. The expression, not the line number, is the
   binding anchor.
2. **The QBR signal is UNJUDGED and owes a re-run.** Its dismissal is struck.
   The re-run is a **new pre-registered gate**, not an edit of the old comment,
   and it must run in the configuration the app serves. **Owner: unassigned.**
3. **Configuration B.** `target_share` is a **volume** metric
   (`shrinkage-fit.js:475`) and `activeKVectorFor` withholds every volume entry
   under any non-weekly recency (`:516-521`). **A grade that does not pass
   `roleRecency: WEEKLY_ROLE_RECENCY` explicitly is not grading the fitted k at
   all** — it is grading `K.share = 6` while citing a number that never arrives.
   **Owner: every thread that grades a volume quantity.**
4. **`K.share = 6` against the fitter's ~0.4.** Untouched and open. The prior
   and the weight it carries interact, so they have to be fitted together, and
   **neither may be tuned on 2025.** **Owner: unassigned.**
5. **The `yards_per: 34` split.** `projections.js:97` serves three different
   quantities — ypt, ypc and ypa — from one constant. Evidence base is
   `PACKAGE-K-YARDS-PER-HELDOUT-2026-09-22.md`. **Queued behind the coupled
   grade. Owner: this thread.**
6. **The held three-support confirming check.** Correlate each player's
   understatement against his `n`. Uniform contamination predicts no
   relationship; the n-dependent account predicts a negative one. **Held until
   the Auditor clears the pre-registration**, then runs and is reported either
   way.

---

## RULES AND LESSONS A NEW SESSION MUST KNOW

**1. State which side of an estimator change every figure ran on.**
`positionalPriors()` changed its accumulation gate on 2026-09-22 (`25de210e`,
reversed to default-off in `a2fd9daa`). Figures from either side are **not on
the same estimator**, so a pre/post pair is **not** a candidate-versus-incumbent
delta and must never be reported as one.

**2. Read what production does with the quantity, off the applying line, before
fitting anything against it.** This cost a whole unit. The previous unit's
harness passed `buildProjections({ …, kOverride: null, … })`, and
`kOverride: null` means *force the hardcoded constants regardless of an active
fit*. **Every figure it produced ran on `K.share = 6`, and the fitted
`target_share` k was never in the path** — while the write-up described the
fitted value. A wiring control that reads the k back out of the path, before the
arms run, is what catches this; it is now in the pre-registration and it earned
its place before it was ever run.

**3. The three-support mismatch (R39).** The shrink at `projections.js:599`
(`main` @ `c90d2834`) interpolates three quantities that count different weeks:
the observation `a.tgtShare / a.tgtShareW` (`:544`) **includes** zero-target
weeks; the prior includes them since 2026-09-22; the fitted `k`
(`shrinkage-fit.js:329-330`) **excludes** them. **Exactly one has always been the
odd one out; the change moved which one, it did not create the mismatch.**
The sharp form: `n` is `a.tgtShareW`, so **a player who misses games carries a
smaller `n` and is shrunk harder toward the prior** — `n/(n+k)` is already doing
an availability weighting nobody designed, and the contamination is
**n-dependent, not uniform**. A multiplier laid on top would price availability
twice at an unknown, player-varying rate.

**4. `mean_diff` is not the observed difference.** `pairedBootstrapDiff`
(`backtest-significance.js:114`) returns the mean of the **resampled**
differences and **never returns the observed full-sample difference at all**.
One figure in this thread's own merged evidence was quoted as `+0.1273`
(`mean_diff`) when observed is `+0.1269`. They agree to four decimals, which is
how it got past review, and that is **not** why it was fixed — a bootstrap mean
quoted as a point estimate is the wrong quantity whether or not it lands close.
**Quote the observed value as the point estimate; name the interval as the
bootstrap's.**

**5. Bootstrap sign convention.** The house idiom passes `(arm, baseline)`, which
makes the interval `baseline − arm`, so **positive means the arm wins.** State
the convention before any signed error leaves a run.

**6. A comment that gives a false reason is a defect, even when its conclusion
is right.** The QBR strike originally said the verdict failed because
`4.749 vs 4.751` was a *season-long aggregate averaging a weekly effect away*.
That reason was false: the pair is a MAE over **player-weeks pooled across a
season**, which is a weekly metric, and the pooled net **is** the weekly effect.
The real defect is **configuration**: `scripts/verify-qbr-integration.mjs:12-13`
calls `replaySeasonWeekly` with **no `roleRecency`** (forwarded at
`weekly-backtest.js:129`), so `buildProjections` falls back to `RECENCY`
(`projections.js:170`, seasonDecay 0.35, weekHalfLife null) and the fitted volume
k is withheld — while the app serves `WEEKLY_ROLE_RECENCY`
(`weekly-ensemble.js:55`) passed explicitly at `player-week-engine.js:271-273`.
**"Season-long" named a configuration, and the draft turned it into an
aggregation.**

**7. Do not scale an answer through a conversion that is itself an estimate.**
This series has already withdrawn a figure for that shape (the weekly-ceiling
MAE headroom). When the Auditor recommended restating an MDE in points through a
points-per-target figure, the right answer was to refuse and make **targets**
primary, because points run through catch rate, yards per target and touchdown
rate, none of which the change touches. **The Auditor accepted that the
recommendation was wrong (R57.2).** Argue the measurement, not the authority.

**8. The verification gate must be the CI gate.** For a stretch, every thread's
"one clean run" was `npm run check`, which did **not** include `check:wiring`,
while CI ran the wiring gate **first**, as a separate step. Every local clean run
was a strict subset of CI. **As of `c90d2834`, `npm run check` includes it.**
A guarded run means `git status --porcelain`, `git write-tree`,
`HEAD^{tree}`, `HEAD` and `node_modules` mtime captured **inside the same
command** either side of the run, plus `find -newermt` for gitignored writes.
`git write-tree` hashes the **index**, so `status --porcelain` is the
load-bearing half.

**9. "REAL" means the check ran on the tree actually pushed.** Not a similar
tree, not a tree with one more commit on it.

**10. `decision_including_dnp` is a fantasy-POINTS MAE, not targets.**
`weekly-backtest.js:170` is the population rule (in if he had a usage row the
week before; a missed week scores a real `0`); `:239` is the metric. A power
calculation in targets cannot govern a metric in points. This thread's 0.0220 SE
was measured on a **targets** metric that borrows only the population rule.

---

## FILES OWNED OR HELD

- **`server/services/projections.js`** — owned by this thread since 16:11Z
  (moved from Fantasy plan). One editor per file; do not edit it from another
  thread without a grant.
- `test/target-share-prior.test.js`, and everything under
  `docs/evidence/2026-09-22/` written by this thread.
- **Read-only on:** `server/services/shrinkage-fit.js`,
  `server/services/weekly-backtest.js`,
  `server/services/nfl-player-context.js` (branch
  `shrinkage-efficiency-weighting`), `scripts/verify-qbr-integration.mjs`.
  Findings about them are reported, never patched from here.

---

## NEXT THREE STEPS FOR A SESSION PICKING THIS UP COLD

1. **Read `docs/evidence/2026-09-22/target-share-prior-result.md` first, then the
   coupled pre-registration.** The result explains *why* the next unit is
   coupled; the pre-registration is the contract for running it. Do not start by
   reading the code.
2. **Get #121's REAL and merge it.** Head `91ed5f1a`. It is a pre-registration —
   its value is that it was written **before** the run, so every day it sits
   unmerged weakens it.
3. **Run the coupled grade exactly as written**, starting with the held
   three-support confirming check, then the wiring control on the k, then the
   arms. **If the wiring control reads back `K.share = 6`, stop and fix the
   harness — no result from that run may be reported.** Report the realised SE
   with the result; above 0.0281 the unit is underpowered and no null in it may
   be read as evidence of no effect.

---

## THE ONE THING NOT TO UNDO

`sharePrior` defaults to **off**, and `test/target-share-prior.test.js` test 4
pins that default. **It is off because the grade said so, not because the work
is unfinished.** If that test starts failing, the coupled grade is what is owed —
not a change to the assertion.

---

# ADDENDUM — 18:30Z, after #121 merged

## What changed since the body above was written

**#121 is MERGED, squash `fd85caa2`.** The "OPEN" section above is now empty:
this thread holds no open PR. `claude/project-thread-w0gpjt` is fully merged and
carries nothing unlanded.

Between the handoff being written and the merge, the Auditor sent #121 back
twice more. Both rounds were text, both were fixed, and **one of them was a real
design fault rather than a wording problem.** They are recorded here because a
fresh session will read the merged pre-registration and needs to know which
parts are load-bearing.

### R62.5 — where the fitted `k` comes from

**Omitting `kOverride` is necessary and NOT sufficient**, and the document had
said only "omitted". The chain is `projections.js:484` → `activeKVectorFor`
(`shrinkage-fit.js:515`) → `cutoffSafeKVector` (`:540`) → `activeKVector`
(`:449`), and `activeKVector` reads the **database**: `shrinkage_fits WHERE
active = 1`, then `shrinkage_k`. **No active fit → `null` → `pickK`
(`projections.js:211`) takes the hardcoded branch → `K.share = 6`.**

`projections.js:206-209` records that **both tables are empty wherever this code
has run.** So on such a rig, "omitted" resolves to exactly what `kOverride:
null` resolves to, and the unit's own wiring control would have stopped the
grade before any arm ran — the control working, and the declaration still empty.

**Two permitted routes, and the run must say which it took**, with the fit's
`id` and `through_season` and the resolved `target_share`/`ALL` value:
1. **Persisted** — an active fit in the rig's DB with a cutoff-safe
   `through_season` for every graded season (`:538-540`).
2. **Passed** — the fitter's output as `kOverride`, **as the object, never
   `null`, never `undefined`**.

**A trap worth carrying forward:** route 2 **bypasses `activeKVectorFor`
entirely** (`:484` branches before it), including the rule that withholds volume
entries under any non-weekly recency (`:516-521`). Under weekly recency the two
routes agree, so route 2 is safe **there and only there**. Outside it, route 2
hands callers a `k` fitted for a different weighting.

### R64(2) — the grade had no arm that was the model we serve

The arms table called arm (a) *"the incumbent — what ships today"* while running
it on the fitted `k`. **Production runs `K.share = 6`** (same empty tables). So
**every comparison in the grade carried an undeclared `k` change**, and a win
for the proposal could have been the fitted `k` rather than the hypothesis, with
nothing in the design able to separate them.

**Fix: a fourth arm and three named comparisons.**

| arm | prior | observation | `k` | multiplier |
|---|---|---|---|---|
| **(a0)** | legacy `0.06` | zeros included | **`K.share = 6`** | none |
| **(a)** | legacy `0.06` | zeros included | fitted | none |
| **(b)** | per-position, zeros excluded | **zeros excluded** | fitted | applied |
| **(c)** | per-position, zeros included | zeros included | fitted | none |

- **`(b)` vs `(a0)` — SHIPPING.** What the decision rule reads.
- **`(b)` vs `(a)` — MECHANISM.** Same `k` both sides; explains why.
- **`(a)` vs `(a0)` — prices the `k` change alone.** If it is large relative to
  `(b)` vs `(a0)`, **most of the effect is the fitted `k`, not the hypothesis,
  and the write-up must say so in those words.**

The wiring control splits: (a), (b), (c) must resolve the fitted `k`; **(a0)
must resolve `K.share = 6`.**

**§5 licence limit, and it governs the next unit:** a pass licenses arm (b)
**only where the fitted `k` is active in the serving path.** Shipping (b) into a
path still on `K.share = 6` would deploy a prior and a multiplier measured
against a different shrink weight. Discharge it by **persisting the fit**, or by
**re-running (a0) and (b) with `K.share = 6` on both sides** and shipping on that
pair. The implementing PR must say which.

### R64(2)(a) — one wrong line number

§1b cited the call site as `:625` in one sentence. On `main`, `:625` is the
**rush-TD shrink**. Corrected to `:605`. Worth noting as a class of error: in a
document whose argument is that the call site binds the build, a wrong line
number is not cosmetic.

## Two process rules learned the hard way today

1. **Never pipe a guard run through a filter.** I piped one through `sed`, which
   buffered its output to nothing, and then committed on top of it while it ran
   — so its closing tree hash could not have matched its opening one. The run
   was discarded, not explained. **The guard script's output goes straight to a
   file.**
2. **Do not spend a suite on a superseded tree.** When `main` moved mid-run, the
   right move was to stop the run, merge, and spend one run on the final tree —
   not to let it finish and then run again. Usage is Nick's #1 priority as of
   18:16Z.

## Skills a fresh session must load

- **`anthropic-skills:gridiron-merge-gate-v2`** — supersedes v1. Note it loads
  **only with the `anthropic-skills:` prefix**; the bare name fails. Its five
  questions are **Nick's five and only those** — v1's second list is gone.
- **`anthropic-skills:gridiron-token-efficiency`** — usage rules; start cold
  from this handoff and read nothing else until a task needs it.
- Both were saved mid-session and were **listed but not yet synced to disk**
  for several minutes, during which `Skill` refused them. If one refuses,
  it is a sync lag, not a missing skill.

## NEXT THREE STEPS, replacing the ones above

1. **The level-correction unit** (the coordinator's next assignment) — the
   Fantasy plan's next model unit is a LEVEL correction on the incumbent at
   `weekly-ensemble.js:69-77`. **State the sign convention before any signed
   error leaves a run.**
2. **The coupled grade itself**, exactly as merged in
   `docs/evidence/2026-09-22/coupled-prior-and-availability-preregistration.md`:
   the held three-support confirming check first, then the wiring control, then
   the four arms. **Pre-register any deviation with the Auditor before running
   it, not after.**
3. **The `yards_per: 34` split** (`projections.js:97` serving ypt, ypc and ypa),
   evidence base `PACKAGE-K-YARDS-PER-HELDOUT-2026-09-22.md`.

Each needs the Auditor's clearance on the pre-registration **before any number
is run**. That ordering is what made every mistake this session a correction
instead of a result.
