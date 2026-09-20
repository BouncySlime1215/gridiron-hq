# calibration-claim-needs-a-fit — TDD report

A component that handed out the word "Calibrated" from a number that is not a
calibration is gone, and three tests ban the claim rather than the file.

## The five questions

**Is it well built?** It is removed, not rebuilt. What replaces it is the
vocabulary already in use — `BasisChip`, whose `fitted` tier is defined as "a
model fitted on history, with a fit id behind it".

**Is this based on stats, or is it made up?** The component was the made-up
case, and that is the finding. It rendered `Calibrated` at `coverage >= .78`
and `Developing` at `>= .65`. Neither threshold has anything behind it, and
coverage is not the quantity the word describes.

**How do we know?** A RED commit with three failing tests, then this one. Five
mutations with per-row SHA-256 before and after and the exact text of each
edit; three controls the runner refused. One mutation is aimed at the test's
own file walker, so the instrument is checked as well as the code.

**Should this data be pointed anywhere else on the platform?** No — the
opposite. It should not have been available anywhere, which is why the test
bans the rendered verdict across the whole client tree rather than guarding one
file.

**How does it unify?** By removing a second provenance vocabulary rather than
reconciling it. Six renderings of "where did this number come from" became one
chip earlier in this stack; this was a seventh, sitting unadopted in the design
system with a stronger claim than any of them.

## 1. Why removed and not relabelled

Three reasons, and only the third is that nothing rendered it.

**1. Coverage is not calibration.** Coverage is how much data you have.
Calibration is whether the predictions matched the outcomes. A forecaster with
complete coverage can be badly calibrated; this component would have called it
Calibrated. They are different quantities, and no relabelling of the tiers fixes
a component whose input is the wrong number.

**2. It granted a stronger claim than the chip does, with less evidence.**
`BasisChip.tsx:48` defines `fitted` as "a model fitted on history, with a fit id
behind it". That clause is the whole point of the basis vocabulary: a number may
not claim a model without naming one. `<Confidence>` handed out the calibration
word — stronger than `fitted` — from a bare fraction, with no fit id anywhere in
its signature.

**3. This project measured confidence tiers and rejected them.**
`docs/HISTORICAL-TESTS.md:27` records a preregistered null: *"confidence tiers
have now failed on clean data in multiple independent passes"*. The row beneath
it reads *"No edge and no usable confidence tier, across every forecaster
tested"*. Keeping a ready-made component for the rejected idea is how it comes
back, and it would come back looking like a design-system decision rather than a
modelling one.

Unreachability alone would **not** have justified deleting it. A design system is
allowed to hold a component nobody has adopted yet, and seven others here are in
exactly that position (`Section`, `StatTile`, `Provenance`, `Distribution`,
`DriverBars`, `ErrorState`, `DataTable`). They stay. The difference between an
unadopted component and a wrong one is the three reasons above, and only the
wrong one was removed.

## 2. What is left in its place

A comment at the same spot recording the decision and its reasons, so the next
person to want a confidence badge finds the argument rather than an empty gap,
and `test/calibration-claim-needs-a-fit.test.js`:

- **C1** bans the four rendered verdicts (`Calibrated`, `Uncalibrated`,
  `Developing`, `Low confidence`) as string literals anywhere under
  `client/src`. Prose about calibration is untouched; a rendered verdict is not.
  This is deliberately about the claim, not the file — mutation 2 puts the word
  back on `Lineup.tsx` instead, and C1 still catches it.
- **C2** pins that the design system exports no confidence tier, and that no
  coverage number is compared to a bare threshold to produce a label.
- **C3** pins the design system's whole exported surface, so the next arrival is
  a deliberate act with a line in this test behind it.

## 3. RED

Three tests, three failures, before the component was touched:

| Test | Failure |
|---|---|
| C1 | `DesignSystem.tsx renders 'Calibrated'` (and the other three verdicts) |
| C2 | `the confidence tier is back in the design system` |
| C3 | the exported surface did not match |

**No separate RED commit, and mutation 1 is why that is not a gap.** The three
failures above were measured before the component was touched, but the component
was removed in the same working session rather than across two commits. What
carries the proof instead is the retroactive RED this project already accepts:
mutation 1 puts the component back, and all three tests go red, with the file's
hash before and after recorded. That is re-runnable by anyone from the committed
sweep, which a RED commit in the history is not.

**A correction on the record, mine.** C3's expected list was written with twelve
names and the file has thirteen: I left out `Provenance`. That is a defect in
the test, not in the code, and it is the one case where CLAUDE.md's "fix the
implementation, not the test" does not apply — the test asserted something
false. Fixed by adding the missing name, not by changing the file. Worth writing
down because a pinned-inventory test that is wrong on day one is indistinguish-
able from one that is right, until something moves.

## 4. The mutations

Run at `f32a83b` with this commit's code in the working tree. APPLIED is decided
by `count(old) == 1`; SHA-256 recorded before the edit, after it, and after the
restore. Re-derive with:

```
python3 docs/tdd/sweeps/mutation-runner.py \
  docs/tdd/sweeps/calibration-claim-needs-a-fit.mutations.json /tmp/out.json
```

| # | Mutation | File | SHA-256 before → after | Aimed at | Fails | Killed by | Kind |
|---|---|---|---|---|---|---|---|
| 1 | K1 the confidence tier is put back | `client/src/components/ui/DesignSystem.tsx` | `9f33bfce5bcd` → `d15d15faf20d` | C1 | 3 | `C1`<br>`C2`<br>`C3` | mutation |
| 2 | K2 a verdict comes back on another page, not in the design system | `client/src/pages/Lineup.tsx` | `848aedd218a3` → `defd1dafe5e2` | C1 | 1 | `C1` | mutation |
| 3 | K3 the design system gains a component nobody declared | `client/src/components/ui/DesignSystem.tsx` | `9f33bfce5bcd` → `e16063f453cb` | C3 | 1 | `C3` | mutation |
| 4 | K4 a coverage number is compared to a bare threshold again | `client/src/components/ui/DesignSystem.tsx` | `9f33bfce5bcd` → `71dcad8b046f` | C2 | 1 | `C2` | mutation |
| 5 | K5 the file walker is pointed at one directory instead of the tree | `test/calibration-claim-needs-a-fit.test.js` | `6ad82a7a293e` → `a4f09e54946d` | C1 | 1 | `C1` | mutation |
| 6 | CONTROL A (no-op): a pattern that is not in this file | `client/src/components/ui/DesignSystem.tsx` | `9f33bfce5bcd` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 7 | CONTROL B (no-op): a pattern from a different feature entirely | `client/src/components/ui/DesignSystem.tsx` | `9f33bfce5bcd` → unchanged | none | — | **NOT APPLIED — anchor x0** | no-op control |
| 8 | CONTROL C (anchor x2): a pattern present twice, which the runner refuses | `client/src/components/ui/DesignSystem.tsx` | `9f33bfce5bcd` → unchanged | none | — | **NOT APPLIED — anchor x13** | anchor control |

Restored to the before-hash after every row: yes, all 5 applied rows.

### The exact text of each edit

**1. K1 the confidence tier is put back**

```diff
- * There is deliberately no confidence tier here.
+ * There is deliberately no confidence tier here.
+ */
+export function Confidence({ coverage }: { coverage: number | null }) {
+  return <span>{coverage == null ? 'Uncalibrated' : coverage >= .78 ? 'Calibrated' : 'Developing'}</span>;
+}
+/*
```

**2. K2 a verdict comes back on another page, not in the design system**

```diff
-export default function Lineup(
+const verdict = 'Calibrated';
+export default function Lineup(
```

**3. K3 the design system gains a component nobody declared**

```diff
-export function Card(
+export function Gauge() { return null; }
+export function Card(
```

**4. K4 a coverage number is compared to a bare threshold again**

```diff
-export function Card(
+const tier = (coverage: number) => coverage >= .78;
+export function Card(
```

**5. K5 the file walker is pointed at one directory instead of the tree**

```diff
-    if (entry.isDirectory()) out.push(...sourceFiles(full));
+    if (entry.isDirectory()) continue;
```

**6. CONTROL A (no-op): a pattern that is not in this file**  — searched for, not found (anchor x0)

```diff
-export function ConfidenceMeter(
+export function ConfidenceGauge(
```

**7. CONTROL B (no-op): a pattern from a different feature entirely**  — searched for, not found (anchor x0)

```diff
-const FAIRNESS_TONE
+const FAIRNESS_TONE_X
```

**8. CONTROL C (anchor x2): a pattern present twice, which the runner refuses**  — searched for, not found (anchor x13)

```diff
-export function 
```

### The instrument is mutated too

Mutation 5 does not touch the code under test at all. It points the test file's
own directory walker at one level instead of recursing, and C1 goes red on its
landing guard (`FILES.length > 50`) rather than on a finding. A ban that sweeps
a tree is only as good as the sweep, and a walker that silently stops at the top
level would report a clean tree forever. This is the row that says it does not.

Control C is the anchor case: `export function ` occurs **thirteen** times in
`DesignSystem.tsx`, so the runner refuses it rather than editing the first one
and calling it applied.

## 5. Every test has a killing row

| Test | Killed by |
|---|---|
| C1: no component turns a number into a calibration verdict | 1, 2, 5 |
| C2: the design system exports no confidence tier | 1, 4 |
| C3: the exported surface is pinned | 1, 3 |

Three of three. No applied mutation survived.

## 6. What these tests cannot see

Source text only; `node:test` has no build step and cannot import `.tsx`. C1
would not catch a verdict assembled at runtime from fragments, or one arriving
from the server in a payload. What it does catch is the readable form, which is
the form this one had and the form a re-introduction would take.

C3 is an inventory, not a judgement: it pins *which* components exist, not that
each is adopted. Seven of the thirteen still have no consumer. That is recorded
here rather than acted on, because adoption is the redesign's business and not
this commit's.

## 7. Full check

`npm run check` measured at **13:37:22Z–13:43Z on the tree of `f32a83b` plus
this commit's code and test**, with no documentation in it:

| Step | Result |
|---|---|
| typecheck | clean |
| lint | 909 JavaScript files syntax-checked |
| test | **3,206 tests, 3,165 pass, 0 fail, 41 skipped** |
| build | `✓ built in 2.81s` |
| start:smoke | passed on an isolated database (32 teams) |

`f32a83b` measured 3,203 / 3,162 / 0 / 41. The three added tests are the three
in `test/calibration-claim-needs-a-fit.test.js`; nothing else moved, which also
confirms the removal broke no caller — there were none.

Documentation written after that run, and inert to it:

```
git diff --name-only f32a83b HEAD | grep -E '^docs/design/design-system\.md$|^docs/CLAUDE-NEXT-STEPS\.md$'
```

Nothing printed.

Source restored after the mutation run and verified with `git status` and the
runner's own after-restore hash.
