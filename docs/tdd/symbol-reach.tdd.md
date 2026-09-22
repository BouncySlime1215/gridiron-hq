# TDD evidence: symbol-level reach (PR #99)

Source: `docs/inventory/CONTRACT.md` §1 — "the unit of a row is a path, not a
file" — and `docs/tdd/reach-grader.tdd.md`, which names the file/symbol gap as
the first thing the file-level grader does not settle. Nothing was deployed, no
live database was touched, no network call was made. LLM spend: $0.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u /tmp/gridiron-test-XXXXXX).sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test test/symbol-reach-two-counts.test.js

New files only — `scripts/symbol-reach.mjs` and
`test/symbol-reach-two-counts.test.js`. The one edited file is
`docs/inventory/CONTRACT.md`, written by this thread.

**14 guarded rules, 8 mutations shown failing.**

## What this makes executable

Two rules in the contract were prose with nothing able to detect a violation,
and both had already produced or nearly produced a false row.

**§3, the two-counts rule.** `git grep SYMBOL | grep -v <defining file>` answers
*is this imported*. Read as *is this used* it deletes the evidence, because a
symbol used where it is defined is exactly what the exclusion throws away.
`SEASON_ENDING_RE` and `RELEASED_RE` (`player-availability.js:19-20`) were
reported dead on that count alone and withdrawn; they are called at `:77` and
`:152` inside functions with production consumers. `consumerCounts` computes
both and `gradeSymbol` carries both. There is no argument that asks for one.

**Internal use on a reached path.** Five `contingency.js` exports with no
importer were nearly filed `dead`; they are called inside their own file, in
functions production reaches. `dead` is a deletion candidate. "Exported and
never imported" is a tidy-up. The grade is `internal-only` and its reason names
the **export keyword** as the unused thing, not the code path.

## Parsing is the TypeScript compiler, not a regex

`typescript` is already a devDependency — `npm run typecheck` runs it — and it
is used here for positions and parent links. Two reasons, both from failures in
this repository:

- This codebase is full of regex literals, and a `/` cannot be told from
  division without being a parser. `player-availability.js`, the file the §3
  rule came from, is one of them.
- The first hand-rolled attributor tracked only `export function`, so a private
  function was not in its declaration list at all and its body was credited to
  the export above it.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| The file/symbol gap | `reach-grade.mjs` grades a file. A file graded `wired` means only that *something* in it is, and §1 files rows against symbols. | Build the symbol grader, with the file grade as its **ceiling**: a use on a path nothing reaches is not evidence of life. |
| Symbol grade vs file grade | A file wired through `routes/model.js` can still export a symbol only betting imports. Taking the file's grade would call that symbol `wired`. | A symbol takes the grade of the entry points **its own importers** reach. |
| Test importers | Running the finished tool against `contingency.js` returned symbols graded as reached whose only importer was their own test. CONTRACT.md says so in as many words under `decoration` — "Tests do not count as consumers" — and names the case: `availability-basis.js`, six exports, ten tests, four exports with no production consumer at all. | **Tests are counted and reported as their own number, and never set a grade.** Found by running the tool, not by reading the contract. |
| Name collision | Several modules here define their own `FEATURE_NAMES` and `fitRidge`. A grep hit is not a consumer. | The import specifier is resolved and compared to the defining file; a renamed import is followed by its original name. |
| `scripts/fit-availability.mjs` | No `package.json` entry, no importer — so hand-run. But `contingency.js` names it five times, which a "named nowhere in `server/`" test reads as wiring. All five are a comment, an assertion message and a `fix:` string. | **Contract tightened**: named means *called*. The mention that reads most like wiring is `contingency.js:516`, which says the script **has never run**. |

## The measured case, reproduced

`contingency.js` grades `wired` as a file. Its 28 exports:

| grade | exports |
|---|---|
| `wired` | 6 |
| `hand-run-script` (all via `scripts/fit-availability.mjs`) | 15 |
| `internal-only` | 6 |
| `unused-in-code` | 1 |

The six `internal-only` are the ones nearly filed `dead` on 2026-09-22 —
`weekDesignation`, `liveEspnStatuses`, `ROLE_MAX_GAP`, `roleTier`, `gapBucket`,
`ESPN_DESIGNATION_LABEL` — each returned with the declaration it is used inside.
`resetAvailabilityCache` is the one that is genuinely unused in code, which is
the same answer the hand trace reached. **Grading these 28 rows by the file they
live in would have called every one of them `wired`.**

## RED -> GREEN, by mutation

Each row edits `scripts/symbol-reach.mjs`, runs the file, then restores.

| Mutation | Result | Rule that caught it |
|---|---|---|
| Attribute a use to the last declaration *starting above* it | 13 pass, **1 fail** | containment, not "last start above" |
| Drop the defining-file half of the two counts | 12 pass, **2 fail** | both counts carried // `SEASON_ENDING_RE` smoke |
| Call an unimported symbol `dead` instead of `internal-only` | 12 pass, **2 fail** | internal use is never `dead` // `SEASON_ENDING_RE` smoke |
| Count test importers as production consumers | 12 pass, **2 fail** | tests are not consumers // a test never upgrades a betting-only symbol |
| Grade a symbol by the file it lives in | 12 pass, **2 fail** | the symbol's own importers decide // as above |
| Ignore the file grade as a ceiling | 13 pass, **1 fail** | a use on an unreached path is not life |
| Count `obj.NAME` property access as a reference | 13 pass, **1 fail** | a property is not the binding |
| Match an import by name alone, ignoring its module | 13 pass, **1 fail** | name collision is not reach |

**The first mutation survived the first sweep**, and that is worth recording
rather than tidying away. The original fixture — a private function below an
exported one — does not discriminate: the nearest declaration *starting above*
the use is also the one containing it, so both implementations agree on it. A
use at **module scope** separates them, because it is inside no declaration and
a "last start above" walk credits it to the function before it. That case was
added and the mutation dies. A fixture drawn from the bug is not automatically a
test of the fix.

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/symbol-reach-two-counts.test.js` | 14 | a private function's body is attributed to it, not the export above; containment rather than "last start above", via a module-scope use; every declaration form, exported and not; the declaration, export specifier and `obj.NAME` are not uses; both counts are reported and differ exactly where §3 says; no importer + internal use -> `internal-only`, never `dead`; no importer + no use -> `unused-in-code`, still not dead-in-data; an internal use inside an unreached file stays `unreached`; a symbol takes its importers' grade, not its file's; both counts always present; a renamed import is followed and a same-named export elsewhere is not; a test-only importer is `unused-in-code` with the test count reported separately; a test importer never upgrades a betting-only symbol; and the `SEASON_ENDING_RE` repo smoke. |

## The five questions

1. **Well built?** The hard part is attribution, and it is delegated to the
   TypeScript parser rather than hand-lexed. The remaining judgement — which
   identifier nodes count as references — is enumerated in one place and pinned
   by three rules. The file grade caps the symbol grade, so the tool cannot
   report a symbol as more reachable than its file.
2. **Stats or made up?** Neither. Graph and syntax questions with exact answers;
   no constant is fitted and none is hand-set.
3. **How we know.** 8 mutations, each shown failing with the rule that caught
   it; 14 rules green; the `contingency.js` tally reproduces the hand trace of
   2026-09-22 including which single export is genuinely unused. **Code only** —
   a caller can exist whose condition is never true against real rows, and
   nothing here ran a query, which is why the grade is `unused-in-code` and
   never `dead`.
4. **Pointed anywhere else?** Yes. Every `dead`, `decoration` and
   `exported and never imported` note already filed in `docs/inventory/` was
   produced by hand from one count and should be re-run through this.
   `scripts/data-lineage-inventory.mjs` answers the data half and the two
   belong side by side before any row says `dead`.
5. **How it unifies.** One executable definition of "used" for the whole
   inventory, at the unit rows are actually filed against, so two threads
   grading two files cannot mean two different things by it.

## What this does NOT settle

- **Dead in data.** No query was run. `unused-in-code` is the whole claim.
- **Dynamic and computed reach.** `importersOfSymbol` reads literal import
  specifiers and destructured `await import()`. A symbol reached through a
  namespace import, a re-export chain, or a computed property is invisible to
  it and would read as unused while being live. A row filed `unused-in-code`
  should be checked for those three before anything is deleted.
- **Shadowing.** A local variable with the same name inside another function
  counts as a reference. This inflates the internal count and can only push a
  symbol away from `unused-in-code`, never toward it — the safe direction, but
  not a correct one.
- **Whether the 15 hand-run exports should be hand-run.** That is a product and
  scheduling call. `contingency.js:516` says the script has never run.

## Addendum, 2026-09-22: namespace imports are no longer a blind spot (#116)

The "Dynamic and computed reach" bullet above was true when written, and it stays unedited because merged evidence files are never rewritten. Since #116 (merged as d6d7bd5a), `importersOfSymbol` also counts a namespace import (`import * as ns`, `const ns = await import()`, `const ns = await import().catch()`), but only where the target property is actually read off `ns`. The liveness record is in `docs/tdd/symbol-reach-namespace.tdd.md`: 18/18 with the fix vs 15/18 without.

Still invisible, so still check before deleting an `unused-in-code` row:
- re-export chains (`export * from`, `export { x } from`);
- computed property reads (`ns[name]`);
- a namespace object passed to another function that reads the property there.
