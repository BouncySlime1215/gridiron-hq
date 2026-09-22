# 147 findings under the wrong rule, because a lookbehind window was 220 characters

RED `d5438f3` · GREEN this commit · `scripts/wiring-map.mjs`, `test/module-edges-long-destructure.test.js`

## What was wrong

`moduleEdges` reads the names bound by a destructured dynamic import —
`const { a, b } = await import('./x.js')` — by looking backwards from the
`import(` for a destructuring pattern:

```js
const before = code.slice(Math.max(0, m.index - 220), m.index);
const destructured = before.match(/(?:const|let|var)\s*(\{[^}]*\})\s*=\s*(?:await\s*)?$/);
```

A fixed 220-character window standing in for a balanced walk. When the
destructure is longer, the opening brace falls outside the window, the pattern
matches nothing, and the import is recorded as a file edge **carrying no
names**.

`test/draft-abstention-audit.test.js:17` destructures fourteen names over four
lines: 231 characters from `const` to `import(`. Eleven characters over.

## Why it is a wrong finding, not a missing one

An import with no names does not simply go unnoticed. Its exports fall through
to `export-imported-by-nothing`, whose detail string is *"exported and never
imported"* — and the map already has the accurate rule for this case,
`export-only-tested`. So the map was not silent; it was confidently wrong, in
the direction somebody deletes code on. This repository already has a memory
note about exactly that failure at the symbol level
([[imported-by-nothing-is-not-unused]]); this is the same error made by the
tool that note tells people to trust instead of grepping.

## How it was found

Not by reading the function. By writing a **second, independent import
scanner** — its own file walk, its own specifier resolver, its own regexes —
and asking it to contradict the map's 843 `export-imported-by-nothing`
findings. 25 contradictions came back across five files, and every one was a
destructure over the window.

Two of the contradictions were **my scanner's** errors, not the map's, and
both were checked by hand rather than counted:

- `BEAT_THE_CLOSE_VERSION` is used only inside `beat-the-close.js`. My
  namespace heuristic matched a member read on an unrelated binding.
- `TRUSTED_HISTORY_START` is exported by BOTH `nfl-weekly-feature-store.js`
  and `nfl-weekly-feature-store-v2.js`. My scanner conflated the two; the map
  has `same-name-two-modules` for precisely this.

After the fix the audit finds zero contradictions it can sustain.

## Effect

| rule | before | after |
| --- | --- | --- |
| `export-imported-by-nothing` | 843 | 696 |
| `export-only-tested` | 551 | 693 |

147 findings left the wrong rule. 146 moved to `export-only-tested`, which is
what they always were. **One stopped being a finding at all**:
`server/services/contingency.js#ROLE_GATE`, imported by name at
`scripts/fit-availability.mjs:41-45` in a fifteen-name destructure about 300
characters long. The map had been calling it "exported and never imported"
while a script imported it. `DESIGNATION_ROLE_GATE`, in the same destructure,
moved off `export-only-tested` for the same reason.

Total findings 2449 → 2444. The inventory is unchanged at 880 rows with
identical status counts: this is a findings-level correction, and no row's
status turned on it.

## Two mutations survived, and both were right to

| # | injection | tree | result | killed by |
| --- | --- | --- | --- | --- |
| M1 | restore the 220-character window | `5b407ae900c06a7b` | KILLED 5/3 | *a destructure longer than 220 characters keeps its names too*; *…aliased name…*; *the real file that exposed this reports its fourteen names* |
| M2 | drop the `const`/`let`/`var` guard | `63c111b6bcff443f` | **SURVIVED**, guard then REMOVED | — (see below) |
| M3 | take the first brace found rather than the matching one | `1680540bcd006bae` | **SURVIVED**, then `d8498048186805b9` KILLED 7/1 | *a nested destructure is read from its OUTER brace* |
| M4 | drop the `} =` tail guard | `395c77197a047cac` | KILLED 6/2 | *a dynamic import with no destructure before it still takes no names from one further up* |
| M6 | read the nested key's inner name instead of the outer one | `a5e97aa75d58661f` | KILLED 7/1 | *a nested destructure is read from its OUTER brace* |
| M5 | control, one word of the doc comment | `805dde3f2121d801` | SURVIVED 8/0 | — |

**M2 was not closed with a test. The guarded code was deleted.** The first
draft required `const`, `let` or `var` in front of the pattern. No test
justified it and none could: `({ a, b } = await import('./x.js'))` is a
destructuring ASSIGNMENT to existing bindings, it binds the same names, and the
guard would have skipped it. A guard nothing can justify is not caution, it is
an untested branch. Writing a fixture to keep it would have been writing a test
to protect a mistake. There is now a test asserting the assignment form IS
read.

**M3 was a real gap in the tests.** Every fixture had a flat destructure, so
taking the first `{` while walking back and taking the balancing one landed in
the same place. `const { alpha, beta: { gamma } }` separates them. Fixing it
surfaced a second, smaller bug in the shared name parser: brace-blanking turns
`beta: { gamma }` into `beta:   gamma`, which is not an identifier, so the
outer key was dropped. A `:` cannot appear in a static import clause, so
splitting on it is safe for both shapes. M6 pins which side of the `:` is the
imported name.

That is three surviving mutations on this branch tonight, each a finding about
a test rather than a clean bill for the code, and one of them a finding about
the code being wrong in a way no test should be written to protect.

## The five questions

**Well built?** One helper replacing a windowed regex with a balanced walk,
six behaviours pinned, and the two mutations that survived resolved by
changing the code and the tests rather than by adjusting the mutation.

**Stats or made up?** Measured. 843 → 696 and 551 → 693, one finding
eliminated entirely and named. 231 characters against a 220-character window,
counted. 25 contradictions from an independent scanner, of which 23 were the
map's and 2 were mine, each checked by hand.

**How do we know?** `node --test test/module-edges-long-destructure.test.js`
3/6 at RED, 8/8 at GREEN; `test/wiring-map.test.js` 90/0. Four injections
killed, one control, two survivors resolved as described.

**Pointed anywhere else on the platform?** Yes. `moduleEdges` builds the whole
import graph, so every reachability verdict in the map rests on it — module
rows, surface reach, and the `dead` and `half_done` statuses in the inventory
that depend on them. The status counts did not move here, which is worth
stating plainly: the correction was large in findings and nil in classification.

**How does it unify?** The inventory's job is to say what is decoration. A
tool that reports live code as never imported does not merely fail to help, it
argues for deleting something that works — and it does so in the voice of the
thing built to stop people guessing.
