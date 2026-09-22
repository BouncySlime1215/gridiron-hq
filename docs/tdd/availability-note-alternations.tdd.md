# Two assertions that accepted three wordings of one string

2026-09-20. `test/availability-honest-degradation.test.js`, against
`server/services/contingency.js` and `server/services/lineup-brain.js`.
Branch `claude/project-thread-w45mur-wiring-names-hold`.

**Run it with `--experimental-test-module-mocks`.** Without the flag this file does not
load at all: `mock.module` is not defined, and the run reports one failure that is not a
test result. That is the same trap CLAUDE.md records under the `Connection error.` story,
and it cost a run here before it was spotted. The command is:

```
node --test --test-concurrency=1 --experimental-test-module-mocks \
  test/availability-honest-degradation.test.js
```

## The fault

Two assertions matched a pipe alternation against a value the fixture pins to exactly one
possibility. That is not closed-set membership, which is legitimate — it is "says
something like this" over a single produced sentence.

- `assert.match(note.effect, /pooled|injury report/i, …)`. `effect` has two possible
  values, chosen by a ternary on the basis, and the fixture is the pooled one. **The
  `injury report` branch could never match anything**: the producer writes
  `injury-report`, hyphenated, and the pattern has a space. A branch that cannot match is
  a claim the author believed and never checked, and it is a sharper tell than the
  looseness of the alternation itself.
- `assert.match(degraded.issue, /not the fitted|not running|pooled/i, …)`. Two branches
  matched, `pooled` never did, so a reworded caveat could slide through on whichever
  branch still happened to hit.

## The split

Five assertions with their own messages, listed in the test file's own header, which is
where the mutation rows live too — beside the assertions, so the two cannot drift apart.
This file is the pointer and the hashes; the header is the table.

## Mutations, re-run after the split

A replacement that a neighbouring clause can satisfy is not a split, so each new assertion
carries its own motivating mutation, re-run against both the old assertions and the new.
Bases: `contingency.js` `28bffcd49d70`, `lineup-brain.js` `7002b98fc00c`. Both restored
and re-verified after the last row.

| # | assertion | mutation, exact | file | sha256 before → after | old | new |
|---|---|---|---|---|---|---|
| 1 | effect names the pooled rate | `pooled injury-report rate` → `pooled rate` | contingency.js | `28bffcd49d70` → `2f4c4bc310f0` | 0 | 1 |
| 2 | effect carries the placeholder read | `known-low placeholder` → `rough placeholder` | contingency.js | `28bffcd49d70` → `252ef4a1b26c` | 0 | 1 |
| 3 | effect is not the constants branch | `basis.basis === 'constants'` → `true` | contingency.js | `28bffcd49d70` → `c97785591dff` | **1** | 1 |
| 4 | the caveat rides with the number | ` — but that is not the fitted number: ` → ` — but that is not running from the fitted layer: ` | lineup-brain.js | `7002b98fc00c` → `8fe828b8e578` | 0 | 1 |
| 5 | the caveat names the inert layer | `is not running (docs/tdd/play-chance.tdd.md)` → `is idle (docs/tdd/play-chance.tdd.md)` | contingency.js | `28bffcd49d70` → `f6649190a2cc` | 0 | 1 |

`old` is the failure count against the two alternations, `new` against the split. Every
row moved the file's hash, so no row is a pattern that silently failed to match.

**Row 3 was published as 0 → 1 and is corrected here to 1 → 1.** That figure was asserted,
not measured: the constants sentence contains neither `pooled` nor `injury report`, so the
old alternation did catch the ternary swap. The split preserves that coverage rather than
adding it, and the assertion is kept because a `doesNotMatch` guard against serving the
wrong branch is worth stating explicitly — not because the alternation was blind to it.
The error is recorded rather than quietly amended, because a table nobody can catch being
wrong is not evidence.

**Row 3 is also not isolated.** Forcing the ternary fails assertions 1 and 2 as well, so
it does not prove the third alone. A contrived edit that only the third catches would have
made the table look cleaner and would have proved less.

**No neighbouring clause can satisfy any of the five.** Each phrase occurs once in the
value under assertion, which is what the `new` column shows: a neighbour that could
satisfy it would read 0 there.

## Checks, with the commit they were measured on

| measured on | npm run check | full suite |
|---|---|---|
| `3c0c9c5` — the split | exit 0 · lint, typecheck, client build clean · start:smoke passed on an isolated database (32 teams) | 2,963 tests · 2,922 pass · 0 fail · 41 skipped |
| `aaace23` — the mutation rows | **no source change**; the file's own suite 8 tests · 8 pass · 0 fail; lint clean | unchanged from `3c0c9c5` |

The commits after `3c0c9c5` change no source file, so the suite figure carries forward;
`git diff --stat 3c0c9c5..HEAD -- server/ client/` being empty is the check on that claim
rather than an assurance.

## The five questions

**Is this well built?** It replaces two patterns that accepted several wordings with five
assertions that each name one thing, and every one is proven killable.

**Is this based on stats, or is it made up?** Measured. Every row is a real edit with the
file's hash before and after and a failure count on both sides of the change.

**How do we know?** Because one of the five came back different from what was claimed, and
that row is corrected in the open above. A table that only ever confirms its author is not
being read.

**Should this data be pointed anywhere else on the platform?** The dead-branch check —
run each branch of an alternation alone against the fixture and flag any that matches
nothing — finds this defect without any judgement about what counts as a closed set. It is
cheap and it applies to every remaining candidate in the suite.

**How does it unify?** One phrase, asserted once, in the one place it is produced. The
alternations were three ways of accepting the same sentence, which is the same
two-quantities-one-name shape this thread's other work removed from the availability
vocabulary.
