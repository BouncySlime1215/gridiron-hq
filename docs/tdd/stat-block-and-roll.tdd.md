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
