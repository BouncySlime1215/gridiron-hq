# The freshness check that never asked

RED `4ea6afc` (server contract) · RED `e15d31f` (banner) · GREEN `138bf48`

## 1. The defect

`servedTables()` (#96) emits each table's current-data rule as
`{ sql, params, text }` — a complete query returning 1 or 0.
`data-freshness.js` was written against `{ predicate, bind, description }` — a
bare `WHERE` fragment. Neither shape is wrong on its own. The mismatch is, and
it fails in the worst available direction, because nothing in the path throws:

```
rule.predicate                     -> undefined -> predicate = ''
rule.bind                          -> undefined -> bind = []
placeholders (0) === bind.length (0)           -> the arity guard PASSES
predicate falsy                    -> currentCount = base.row_count
row_count > 0                      -> status = 'fresh'
```

So every table holding any row reported `fresh`, whatever season those rows
were from, and `stale` became unreachable. The check answered a question it
had never asked.

The sharpest way to state it: with the FALLBACK registry, today's data reads
`stale`, which is correct. Loading the real registry would have made the light
*less* truthful than having no registry at all — and it would have done so
silently, at the moment the feature was finished rather than while it was
obviously half-built.

This is the same fault the whole feature exists to end, one layer down. The
banner it replaced read `last_status === 'never run'` and called a job that ran
and wrote zero rows "healthy". This read `row_count > 0` and called a table it
had never queried "current". Both say yes because they could not say no.

## 2. The specimen

Scheduler's measurement on a real migrated database, pinned as the RED case:
`player_week_usage` loaded for 2021-2025, nothing for 2026, asked about 2026
week 3. The honest answer is `stale` — there are rows, but none for the season
being played. Before the fix the test read `actual: 'fresh'`.

## 3. The fix

**Both shapes are evaluated.** `ruleShape()` returns `'sql'`, `'predicate'` or
`null`; `askRule()` runs whichever it got. Values are bound by name in either
shape (`season`, `week`), never interpolated. The rule TEXT in either shape
comes only from the code registry; the table and column NAMES are still the
only identifiers this file splices into SQL and are still validated against
`/^[A-Za-z_][A-Za-z0-9_]*$/`.

**An unaskable rule is a fault, not a verdict.** A fourth status, `unknown`:

- rule absent, `{}`, or in a shape this file does not recognise → `unknown`,
  note `no usable current-data rule for this table — freshness was not checked`
- rule throws while running (bad bind name, SQL error) → `unknown`, note
  `current-data rule could not be evaluated: <reason>`

"I could not ask" and "the answer is yes" are now different words. The catch is
the one place in this module where an error is swallowed rather than allowed to
propagate, and it is not swallowed — it is reported into the row the user reads,
with the reason attached. The reason it is caught at all is blast radius: a
registry arriving from another module must not be able to take the whole panel
down over one malformed entry.

**The arity pre-flight still throws**, for the `predicate` shape only. That
shape is a literal in this file's own `FALLBACK_REGISTRY`; a mismatch there is
catchable without touching the database and should never ship. The line the
defect turned on — a guard that passed because both sides were empty — now only
runs when there is a predicate to guard.

**`all_fresh` needed no change.** The route computes
`tables.every(t => t.status === 'fresh')`, so the new status fails closed there
already. That is worth stating rather than assuming: it is the one place a
fourth status could have leaked through as a pass.

**The banner** gains a slate `Not checked` chip, and counts unchecked sources
apart from behind ones. They are different problems: a late feed needs
re-running, an unchecked one needs its registry entry repaired. Without the
split the headline would have told the user a fact nobody established — that
the source is not current — when what happened is that nobody looked.

## 4. A real gap the sweep found

M9 survived the first pass. The banner test asserted that `status === 'unknown'`
appeared in the file and that some form of "not checked" appeared in it. Folding
the fourth status back into `t.status !== 'fresh'` leaves both true: the phrase
survives in the per-row sentence, the chip survives in `STATUS_STYLE`. The test
passed while the headline lied.

Re-anchored on the two filter expressions — the known-wrong shape must be
absent, the separate count must be present — and the whole sweep re-run rather
than the one row patched. There is no DOM harness here, so the shape of the
split is what can be pinned.

This is the second time in this thread a sweep has caught an assertion that
matched a string surviving elsewhere in the same file. The pattern is worth
naming: an assertion on a word is not an assertion on the behaviour the word
belongs to.

## 5. Mutation sweep

`python3 docs/tdd/sweeps/mutation-runner.py docs/tdd/sweeps/data-freshness-rule-contract.mutations.json <out>`
on `138bf48`. 9 mutations, 7 tests, every test has a killing row. Two controls
with designed outcomes. All rows restored; every applied row's hash moved.

| Row | Aimed at | Applied | Hash before → after | pass/fail | Killed by |
|---|---|---|---|---|---|
| M1 the fail-open returns: no rule falls back to row_count | T3 missing rule, T5 fault distinguishable | yes | `c8986366a0ad` → `31285fcc1fb1` | 21/1 | `a missing rule is a fault, never a pass` |
| M2 the shipped {sql,params} shape stops being recognised | T1 shipped rule evaluated, T2 fresh when current | yes | `c8986366a0ad` → `4c27c24d4b7d` | 19/3 | `a shipped-shape rule is evaluated, so an unplayed season reads stale`; `the same table reads fresh once the current season has rows`; `fault is distinguishable from every other state` |
| M3 the sql rule is asked but its answer is ignored | T1 shipped rule evaluated | yes | `c8986366a0ad` → `64673648ccf0` | 21/1 | `a shipped-shape rule is evaluated, so an unplayed season reads stale` |
| M4 an unrunnable rule is reported as a pass | T4 unusable rule, T5 fault distinguishable | yes | `c8986366a0ad` → `8a76cc39bfec` | 21/1 | `an unusable rule is a fault rather than a thrown page` |
| M5 an unrunnable rule is filed as merely stale | T4 unusable rule | yes | `c8986366a0ad` → `93d6c589696d` | 21/1 | `an unusable rule is a fault rather than a thrown page` |
| M6 the fault is reported with no reason attached | T3 missing rule note, T4 unusable rule note | yes | `c8986366a0ad` → `1aa929f2c864` | 21/1 | `a missing rule is a fault, never a pass` |
| M7 an evaluation failure is rethrown, taking the panel down | T4 unusable rule degrades rather than throws | yes | `c8986366a0ad` → `ed31f8658d5d` | 21/1 | `an unusable rule is a fault rather than a thrown page` |
| M8 the banner loses its rendering path for unknown | T6 renders the unknown verdict | yes | `d694b0d1c161` → `3cd7051bdb24` | 7/1 | `the banner renders the unknown verdict instead of crashing on it` |
| M9 unchecked is folded back into not-current | T7 unchecked is not reported as stale | yes | `d694b0d1c161` → `00c003cefecf` | 7/1 | `an unchecked source is not reported to the user as a stale one` |
| C1 control: a comment is rewritten, nothing behavioural | nothing — this row must SURVIVE | yes | `c8986366a0ad` → `1d590e917124` | 22/0 | **SURVIVED** |
| C2 control: an anchor that does not exist | nothing — this row must report NOT APPLIED | **NOT APPLIED** (anchor ×0) | — (no edit) | — | — |

Per-test coverage: T1 ← M2, M3 · T2 ← M2 · T3 ← M1, M6 · T4 ← M4, M5, M7 ·
T5 ← M2 · T6 ← M8 · T7 ← M9.

## 6. The full check

`npm run check` (typecheck && lint && test && build && start:smoke) on
`138bf48`, tree `c32e241272e9214ed4dd52ba33bff6bef7dceb31`:

```
rc=0
# tests 3046
# pass 3005
# fail 0
# skipped 41
# duration_ms 322550
Application startup smoke passed on isolated database (32 teams).
```

`git status --porcelain` empty before and after; the tree hash is identical
after the run. The post-run `find -newermt` lists 25 files, all under
`client/dist/` — gitignored build output, which is the expected clean-run
noise and the reason the `find` exists at all: porcelain cannot see it.

This file is the only change after that measurement. `git diff --stat` between
the measured commit and this one touches `docs/tdd/` only.

## 7. What this does not settle

- **Nothing is live.** `/api/data-freshness` is still not mounted —
  `server/index.js` belongs to the scheduler thread and owes two mount lines.
  Until then the running app 404s this request and gets the banner's
  could-not-check bar, which is now the honest outcome rather than a blank
  page, but it is not the feature working.
- **`servedTables()` is still not exported.** This reads the fallback registry
  at runtime. The `sql` path is proven by test against the shape #96 emits, not
  by having consumed #96's actual output.
- **The evaluator is duplicated.** Scheduler is exporting one from
  `source-registry.js`; when it lands, `askRule()` should delegate to it rather
  than stay a second implementation of the same contract. Two evaluators that
  drift is the next version of this same bug.
- **`unknown` has no alerting.** It shows on the panel. Nothing counts how often
  it happens, so a registry entry that is permanently unaskable would sit there
  looking like a normal row.

## The five questions

- **Well built?** The failure mode is now the reverse of what it was: the check
  reports a fault where it used to report a pass, and the one place it catches
  an error puts the reason in front of the user instead of hiding it. The arity
  guard that the defect slipped through now only runs when there is something to
  guard.
- **Stats or made up?** Neither — this is a contract defect, and the evidence is
  the specimen: 5 seasons × 3 weeks loaded, 2026 week 3 asked, `actual: 'fresh'`
  before and `stale` after. The one number that matters is that `stale` was
  reachable in 0 of the cases it should have covered.
- **How do we know?** 9 mutations, all 7 tests killed, two controls with
  designed outcomes, SHA-256 either side of every edit, all restored. One
  mutation survived the first pass, exposed a real gap in the banner test, and
  the sweep was re-run whole. Full check green on the tree being pushed, not on
  an earlier one.
- **Pointed anywhere else on the platform?** The same shape — a guard that
  passes because both sides are empty, then a fallback that reads as success —
  is worth looking for wherever a registry crosses a module boundary.
  `source-registry.js` is the immediate neighbour, and it is not this thread's
  file.
- **How does it unify?** Third time on this branch: absent is not zero, a
  failed check is not an all-clear, and an unasked question is not a yes. Each
  was the same edit — give the "I don't know" case its own word instead of
  letting it share one with "fine".
