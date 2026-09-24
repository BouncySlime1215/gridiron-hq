# Basis chip and glossary — TDD evidence

Shape required by CLAUDE.md: a RED commit, a GREEN commit, an evidence file.
This is the retroactive form the repository already uses, the one set by
`docs/tdd/week2-numbers.tdd.md`: the RED is produced by mutation against the
shipped source, one guarded rule at a time, because "a test that no mutation can
fail proves nothing".

## What is being guarded, and why it needs guarding

Two files, both of which exist to stop the same defect: a label or a provenance
claim written inline in one component and disagreeing with the same claim in
another.

The defect is live, not hypothetical, and it has two instances on the board
today:

1. **`floor` means two different things on one screen.** The 10th percentile of
   a single week in the trade engine, and the 20th percentile of a season on the
   career line. A manager reading "floor 8.1" beside "floor 11.4" has no way to
   know those answer different questions. `client/src/lib/glossary.ts` gives them
   two entries under two names, `week_floor` ("Quiet week") and `season_floor`
   ("Quiet season"), with different `raw` fields.

2. **Four components answer "where did this number come from" four ways.**
   `Lineup.tsx:180` renders a paragraph when the basis is `role` and a different
   box when it is not; `OddsBasis.tsx` renders a block of sentences; News renders
   a per-card parenthetical; Settings renders a freshness card. They disagree on
   wording, on placement, and on whether the healthy case is mentioned at all.
   `client/src/components/ui/BasisChip.tsx` is the one component they collapse
   into.

The chip renders in the good case too. That is the one design decision here
worth arguing with, and `Lineup.tsx` already made it correctly — its comment says
the fitted path gets a line "quieter, since nothing is wrong, but present". A
reader who only ever sees a provenance line when something is degraded cannot
tell a healthy page from a page that forgot to check.

## The mutations

Each reverts one guarded rule in the shipped source, runs
`test/glossary-and-basis.test.js`, and is then restored. Control run after
restoring: **8 pass, 0 fail**.

| # | Mutation | Result |
|---|---|---|
| m1 | Rewrite one `plain:` sentence to use "percentile" | **7 pass, 1 fail** |
| m2 | Delete `pooled` from `AVAILABILITY_BASIS` | **7 pass, 1 fail** |
| m3 | Give `season_floor` the same display name as `week_floor` | **7 pass, 1 fail** |
| m4 | Define the `pooled` tier's colour as `var(--warn)` | **7 pass, 1 fail** |
| m5 | Remove `if (!tier) return null` from the chip | **7 pass, 1 fail** |
| m6 | Delete `raw:` from a glossary entry | **7 pass, 1 fail** |
| m7 | Remove the chip's `aria-label`, leaving only `title` | **8 pass, 1 fail** |

Each of the six is a defect somebody would plausibly introduce, and each is the
kind that ships looking fine:

- **m1** is the one that erodes. Nick's rule is that an explanation has to "make
  sense to someone who never deals with stats. Detailed but not like wtf." Nobody
  breaks that in one commit; it goes one careless sentence at a time, and a
  banned-word list that is not enforced is a comment.
- **m2** is the silent one. An availability basis the server emits and the chip
  does not map renders **nothing** — the number ships with no provenance at all,
  and the page looks correct. The test reads the server's vocabulary out of
  `contingency.js:574` rather than copying it, so the server changing its tiers
  fails this test instead of quietly dropping a chip.
- **m4** is the palette telling a lie no sentence can undo. A pooled number is
  not a problem with the manager's team; a chip in the warning colour says it is.
- **m7** is the one that only affects people who are not using a mouse. A
  `title` attribute does not exist on a touch screen and is not reliably
  announced, so without the accessible name the chip is a coloured pill reading
  "Rough" with no route to what that means — the decoration this component was
  written instead of. This app is read on a phone.

## Honest limit

These read the TypeScript and TSX as **source text**. This is a `node:test`
suite with no build step and no DOM, so what is pinned is what the files *say*,
not what React renders. A component that imports the glossary and then writes its
own label beside it would pass every test here.

That limit is the same one recorded in `test/news-availability-basis.test.js`,
and it is why the six questions in `docs/design/design-system.md` §5 are written
as a review checklist: "does every label match the glossary" is a human check
until there is a DOM harness in this repository, and there is not one.

## Commands

```
GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr-XXXXXX).sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/glossary-and-basis.test.js
```

Full suite on this branch at the time of the push: see the pull request body.
