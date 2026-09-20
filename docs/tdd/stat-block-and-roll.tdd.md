# Stat block and number roll — TDD evidence

Same retroactive shape as `docs/tdd/basis-chip-and-glossary.tdd.md` and the
precedent in `docs/tdd/week2-numbers.tdd.md`: the RED is produced by mutation
against the shipped source, one guarded rule at a time.

## What is guarded

Two small files. Both are the kind of small thing that quietly loses its reason,
and neither loses it in a way that breaks a build.

**`StatBlock.tsx`** is the unit a manager clicks. Three rules make it worth
having as a component rather than as a pattern people copy:

1. It takes no `label` prop. The name comes from the glossary, always. A caller
   that *can* pass its own label is a caller that will, and then `floor` means
   the 10th percentile of a week in one place and the 20th of a season in
   another — the exact defect `client/src/lib/glossary.ts` was written to end,
   reintroduced one prop at a time.
2. `basis` is required. `'missing'` is how a caller says it has none, and that
   renders as a chip rather than as nothing. An optional basis would make "no
   provenance" the path of least resistance, which is the state this redesign
   exists to end.
3. It is not a card. No border, no fill, no shadow. This is why it does not
   extend `StatTile` in `DesignSystem.tsx`, which wraps every number in a
   `.card`: six bordered boxes in a row read as six separate objects rather than
   six facts about one thing.

**`useNumberRoll.ts`** answers a question the app currently cannot: *did that
number just change, or was it always this?* A cut is indistinguishable from a
re-render, and `.just-updated` flashing the row behind a number says something
is new without saying which way it went. The roll counts. It is bounded hard —
never on first paint, never under `prefers-reduced-motion`, never for a change
below the number's own display precision, never longer than `--motion-reveal` —
because an animated number is exactly the kind of thing that becomes decoration.

It returns a **number**, not a string. Returning a formatted string would let a
rolling value render at a different precision than a settled one, which is the
same drift the glossary exists to prevent, in motion form.

## The mutations

Each reverts one guarded rule in the shipped source, runs
`test/stat-block.test.js`, and is then restored. Control run after restoring:
**9 pass, 0 fail**.

| # | Mutation | Result |
|---|---|---|
| n1 | Add a `label` prop and render it instead of `t.name` | **8 pass, 1 fail** |
| n2 | Make `basis` optional | **8 pass, 1 fail** |
| n3 | Give `.stat-block` a border | **8 pass, 1 fail** |
| n4 | Move the hover state from `.is-interactive` to every block | **8 pass, 1 fail** |
| n5 | Drop the reduced-motion check from the roll | **8 pass, 1 fail** |
| n6 | Drop the below-precision guard | **8 pass, 1 fail** |
| n7 | Remove the non-finite fallback in `revealMs` | **8 pass, 1 fail** |

n5 and n7 are the two that matter most and neither would ever be noticed in
review. n5 leaves a number counting after the user has asked the whole operating
system to stop moving things. n7 lets a missing or renamed token produce `NaN`,
and a roll whose duration is `NaN` never reaches `t = 1`: the number sits
mid-count forever, showing a value that is not the real one, with nothing in the
console.

## Honest limit

Same as the step before it, and stated for the same reason. This is a
`node:test` suite with no DOM, so these read the source as text. A component that
imports `StatBlock` and then renders its own label beside it passes everything
here. The six questions in `docs/design/design-system.md` §5 are a human review
checklist precisely because there is no DOM harness in this repository.

## Commands

```
GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr-XXXXXX).sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/stat-block.test.js
```

---

## Addendum: the roll was written and never wired

A later sweep flagged `client/src/lib/useNumberRoll.ts` as **imported by
nothing**. The hook, its bounds and its tests all existed; no component called
it. A hook nobody imports is dead code that reads as a feature, and the tests
above passed the whole time because they read the hook's own source rather than
any use of it. That is the same failure as
[[tests-that-slice-on-a-common-token]] one level out: the test watched the
thing, not the thing being used.

It is now wired into `StatBlock`, the one component that owns numbers.

Two decisions came with the wiring, and both are the kind that look like
details and are not:

**The threshold is in wire units, not screen units.** `formatValue` multiplies
a percentage by 100 before rounding, so a quantity displayed to one decimal as
a percentage is significant to *three* decimals on the wire. Passing
`t.precision` straight through would have put the roll's threshold a hundred
times too high and silently suppressed every roll a percentage could make —
which looks exactly like the hook not working, and would have been debugged as
that. `t.unit === 'percent' ? t.precision + 2 : t.precision`.

**The accessible name is the settled value.** A roll is a visual answer to "did
this just change". Renaming the button sixty times a second is not that answer,
and a reader speaking early would announce a number the page never settles on.
`aria-label` reads `settledText`, formatted from the raw prop; only the visible
digits roll.

### Mutation runs

Baseline `test/stat-block.test.js`: 12 tests, 12 pass, 0 fail.

| Mutation | Result | Caught by |
|---|---|---|
| `StatBlock` stops importing the hook (back to unwired) | 11 pass / **1 fail** | the roll is actually used |
| the rolled value is computed and then thrown away | 11 pass / **1 fail** | the roll is actually used |
| the threshold uses screen units, killing every percent roll | 11 pass / **1 fail** | the threshold is in wire units |
| `formatValue` stops scaling percent, so the `+2` goes stale | 11 pass / **1 fail** | the threshold is in wire units |
| the accessible name is read from the rolling value | 11 pass / **1 fail** | the accessible name is the settled value |

The fourth is there because the `+2` is a fact about `formatValue`, not about
`StatBlock`. If someone changes the scaling and leaves the offset, nothing in
`StatBlock` is wrong on its own and the roll goes wrong anyway.

---

## Mutation re-run at the stack tip

Re-run against **one tree**, the tip of this stack at `af7f01a`, so every row
below is measured on the same code rather than on the tree each commit had when
it was written. Each entry records the mutated file's SHA-256 before and after,
which is what proves the mutation was APPLIED: a pattern that does not match
leaves the file unchanged, and the run is then the baseline wearing a
mutation's name. Each entry names the **test title** that turned red, not the
rule it was meant to check — a mutation that lands and kills a different test is
unfinished, not a result. And each quotes the **exact before and after text**,
not a description of the edit, so the mutation can be reproduced from this file
rather than taken on trust.

Files mutated: `client/src/components/ui/StatBlock.tsx`, `client/src/lib/glossary.ts`.

**StatBlock stops importing the roll (hook unwired again)** (`client/src/components/ui/StatBlock.tsx`) — APPLIED `5233ed6bd8a3` → `fc5af49ed4b1` — **RED**, 1 failing · killed by *the roll is actually used, and used by the one component that owns numbers*

```diff
-import { useNumberRoll } from '../../lib/useNumberRoll';
+  (the text is removed)
```

**the rolled value is computed and thrown away** (`client/src/components/ui/StatBlock.tsx`) — APPLIED `5233ed6bd8a3` → `14b42cab619c` — **RED**, 1 failing · killed by *the roll is actually used, and used by the one component that owns numbers*

```diff
-const text = formatValue(id, rolled, { signed });
+const text = formatValue(id, value, { signed });
```

**the roll threshold uses screen units, killing every percent roll** (`client/src/components/ui/StatBlock.tsx`) — APPLIED `5233ed6bd8a3` → `57beeee442c6` — **RED**, 1 failing · killed by *the roll threshold is in wire units, not screen units*

```diff
-t.unit === 'percent' ? t.precision + 2 : t.precision
+t.precision
```

**formatValue stops scaling percent, so the +2 goes stale** (`client/src/lib/glossary.ts`) — APPLIED `651cd69a37a7` → `8df614a9be94` — **RED**, 1 failing · killed by *the roll threshold is in wire units, not screen units*

```diff
-const scaled = t.unit === 'percent' ? value * 100 : value;
+const scaled = value;
```

**the accessible name is read from the rolling value** (`client/src/components/ui/StatBlock.tsx`) — APPLIED `5233ed6bd8a3` → `8674afaaf83d` — **RED**, 1 failing · killed by *the accessible name is the settled value, not the rolling one*

```diff
-${t.name}, ${settledText}. Show where
+${t.name}, ${text}. Show where
```

**NO-OP CONTROL: whitespace added to a comment, nothing else** (`client/src/components/ui/StatBlock.tsx`) — APPLIED `5233ed6bd8a3` → `daabba1342b9` — **green — survived, as intended**

```diff
- * THE UNIT THAT GETS CLICKED.
+ * THE UNIT THAT GETS CLICKED. 
```

5 mutations applied and red, 1 applied and green. The green
row is the deliberate no-op control — an edit that is real (the SHA changes) but
touches nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database. The tree is `af7f01a` plus the working tree of
the commit this section lands in; the source was restored and verified clean
after the run.
