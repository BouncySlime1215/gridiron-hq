# The mount, the grain vocabulary, and one evaluator instead of two

RED `3cd5104` (grain) · GREEN `5af541c`

Three seams between `data-freshness.js` and `source-registry.js`, closed in one
commit because they are one seam seen from three angles: two modules that had to
ship before they could agree on anything.

## 1. The mount

`GET /api/data-freshness` is now wired up. Two lines, and they arrived as an
explicit handover rather than as my own edit, because `server/index.js` belongs
to the Scheduler thread under the one-editor rule.

**Why that thread could not add them itself.**
`git cat-file -e 654ff93:server/routes/data-freshness.js` → does not exist. The
route file exists only on this branch. A mount on any branch cut from `main`
imports a missing module, the app fails to boot, and `start:smoke` goes red. The
mount has to live on a tree that already carries the route, and this is the only
one that does. That is a fact about the trees, not a preference.

**Verified before applying, rather than pasted on trust.** The handover named a
path, and a path mismatch is the same class of defect this branch exists to fix,
so all four were checked:

| Claim | Checked |
|---|---|
| `/api/data-freshness` is the path the client asks for | `useApi` fetches `` `/api${path}` `` (`client/src/api.ts:56`); the banner asks for `/data-freshness` |
| the destructured default import is right | `server/routes/data-freshness.js:38` is `export default r` |
| the gate is spread, not passed | `legacyAuthenticated` destructured at `server/index.js:57`, spread at `:105-107`, `:134` |
| gating is what the route asks for | its own header asks for the same gate as every other data route |

`start:smoke` in the full check below boots the app with the mount in place, so
this is not a static argument: the process starts and serves.

Mounted is still not live. The deploy is a separate milestone and Nick's word.

## 2. Grain: the producer's vocabulary, not this file's

`source-registry.js` emits `grain` as `'week' | 'season' | 'static' | 'fit'`
(verified on `claude/project-thread-o3wt2p-freshness-evaluator` @ `e3a8676`,
`evaluateServedTable` line 623). This file had invented `'feed' | 'fit'` before
that contract existed.

Two vocabularies for one field is the rule-shape mismatch again, one field over,
and it fails the same quiet way: `'week'` arrives, nothing matches `'fit'`, and
every non-fit table gets the sentence *"has not been updated for the current
week"* — right by accident for `'week'`, wrong for a season-grained table that is
a year out, and meaningless for a static one with no weekly cadence at all.

So the four are adopted, and the banner says something different for each,
because they are four different failures:

- **week** — this feed missed a week.
- **season** — this table holds nothing for the season being played.
- **static** — this table has stopped being refreshed.
- **fit** — a *named* model is answering on a fallback right now.

**The fifth case is the one worth the care.** An entry that states no grain now
gets `null`. It used to get `'feed'`, and that was wrong rather than merely
superseded: `'feed'` is not in the producer's vocabulary at all, so the default
put a claim on the panel that nobody had made — it told the reader *this is a
feed* on no evidence. `null` renders as a sentence that names no cadence.
`FALLBACK_REGISTRY`'s one entry now states `grain: 'week'` rather than inheriting
a default, so the shipped entry says what it is.

This changed an existing passing test, which is worth naming rather than burying.
`data-freshness.test.js`'s "defaults to feed" assertion encoded a decision made
before the shared contract existed, and the contract makes it wrong. The test was
rewritten with the reason in it, not deleted.

## 3. One evaluator, not two

`evaluateServedTable(entry, { season, week, database })` **is** the definition of
what a current-data rule means. `askRule` here implements the same contract
independently, because it had to ship before the evaluator existed.

Two implementations of one contract is how the next drift happens. The first
version of this bug was two modules disagreeing about a rule's **shape**; the
second would be two disagreeing about what a rule **means**, which is harder to
see because nothing errors and both sides look reasonable in isolation.

So `askRule` delegates. Feature-detected (`typeof
registry.evaluateServedTable === 'function'`) rather than imported outright,
exactly as `servedTables()` already is, because the evaluator lands on a
different branch and a hard import would make this module unloadable until that
branch merges. The borrowed evaluator throws on any rule it cannot run; that
throw becomes this module's `unknown` carrying the reason, so the two contracts
meet rather than merely coexist.

**The export was read, not taken on report.** `git fetch` of that branch, head
`e3a8676` matching what was claimed, and the three exports confirmed present at
lines 346, 623 and 684 before any code was written against them. This project has
already built against a field that a handoff said was shipped and that existed on
0 of 155 branches.

**Feature detection is exactly the code that silently never fires**, so it is
tested from both sides with `mock.module` rather than assumed: the delegation
happens, the borrowed verdict is what reaches the row both ways, a throw becomes
`unknown` with its reason intact, and the predicate-shape path still runs locally.

## 4. TDD order, stated plainly

The grain change is RED (`3cd5104`, 5 failing) then GREEN (`5af541c`). The
**delegation tests were written after their code**, which is out of order. Their
RED is mechanical rather than a commit: sweep row D1 forces the feature detection
false and four of the five fail. That is a weaker guarantee than a RED commit and
is recorded as such rather than presented as the same thing.

## 5. Mutation sweep

`python3 docs/tdd/sweeps/mutation-runner.py docs/tdd/sweeps/data-freshness-grain-and-delegation.mutations.json <out>`
on `3cd5104` with the GREEN applied. 8 mutations, 13 tests across three files,
every test killed. All rows restored; every applied row's hash moved.

| Row | Aimed at | Applied | Hash before → after | pass/fail | Killed by |
|---|---|---|---|---|---|
| G1 the invented 'feed' default comes back | T3 null not a guess; data-freshness.test.js no-grain test | yes | `3303d7911b98` → `03aba46d2af7` | 20/2 | `an entry that states no grain gets null, not a guessed one`; `an entry with no grain gets null rather than a guessed default` |
| G2 the vocabulary drifts from the producer's | T1 four values | yes | `3303d7911b98` → `1c556811a1a2` | 21/1 | `the registry's four grain values are the ones this module knows` |
| G3 the fallback entry stops stating its grain | T4 fallback states its own grain | yes | `3303d7911b98` → `7643776fadbe` | 21/1 | `the fallback registry states its own grain rather than relying on a default` |
| G4 the season-grain sentence is dropped | T5 a distinct sentence per grain | yes | `e819ec38d95d` → `f616eabfa4f4` | 4/1 | `the banner says something different for each grain it is given` |
| G5 the static-grain sentence is dropped | T5 a distinct sentence per grain | yes | `e819ec38d95d` → `81b447686018` | 4/1 | `the banner says something different for each grain it is given` |
| D1 the delegation never fires (feature detection always false) | delegation T1, T2, T3, T4 | yes | `3303d7911b98` → `7bc77b7200b7` | 1/4 | `a shipped-shape rule is answered by the registry evaluator, not by the local copy`; `the evaluator is handed the entry and the season/week it needs`; `the evaluator's verdict is what reaches the row, both ways`; `a throw from the borrowed evaluator is reported as unknown, not a crash` |
| D2 the borrowed verdict is ignored | delegation T3 both ways | yes | `3303d7911b98` → `a9d3f0f6d09b` | 4/1 | `the evaluator's verdict is what reaches the row, both ways` |
| D3 the predicate shape is handed to the sql evaluator too | delegation T5 local path preserved | yes | `3303d7911b98` → `655c7b9a6a0c` | 4/1 | `the WHERE-fragment shape still runs locally — the evaluator does not take that one` |
| C1 control: a comment reworded, nothing behavioural | nothing — must SURVIVE | yes | `3303d7911b98` → `cd44c26d8bdd` | 22/0 | **SURVIVED** |
| C2 control: an anchor that does not exist | nothing — must report NOT APPLIED | **NOT APPLIED** (anchor ×0) | — (no edit) | — | — |

## 6. The full check

`npm run check` on `5af541c`, tree `8850b4b3aa293e82fab5986f7da2878129bc795f`:

```
rc=0
# tests 3056
# pass 3015
# fail 0
# skipped 41
Application startup smoke passed on isolated database (32 teams).
```

`git status --porcelain` empty before and after; tree hash identical after the
run; the post-run `find -newermt` touched nothing outside `client/dist/`. The
smoke line is the mount's real proof — the app boots with the route on it.

This file is the only change after that measurement; `git diff --stat` between
the measured commit and this one touches `docs/tdd/` only.

## 7. What this does not settle

- **Not pushed.** Held under the standing instruction that nothing pushes until
  Nick restores it. The branch is local at this commit.
- **The delegation has never run against the real evaluator**, only against a
  mock of its verified signature. It activates the moment #104 merges, and the
  first real exercise of it is that merge.
- **`unknown` is still uncounted.** It shows on the panel; nothing tallies it, so
  a permanently unaskable registry entry sits there looking ordinary.
- **Mounted is not live.** `SCHEDULER_DISABLED=1` is on and `main` is undeployed.

## The five questions

- **Well built?** Each of the three takes a decision this file had made alone and
  hands it back to the module that owns it — the route's path to the client, the
  grain vocabulary to the registry, the meaning of a rule to the evaluator. What
  is left here is the part that is genuinely this file's: turning a verdict into
  a row a person can read.
- **Stats or made up?** Neither; these are contract facts, and each was read
  rather than assumed — `654ff93` lacks the route file, `e3a8676` has the three
  exports at named lines, `api.ts:56` prefixes `/api`. The one number is the
  check: 3056 tests, 0 failures, app boots.
- **How do we know?** RED then GREEN on the grain change; 8 mutations killing all
  13 tests with hashes either side and two designed controls; a full check on the
  commit being recorded. The delegation's weaker provenance is stated in §4
  rather than smoothed over.
- **Pointed anywhere else on the platform?** The mount touches `server/index.js`,
  which is another thread's file — two lines, by explicit handover, and nothing
  else in it moved. The grain vocabulary now has one owner, so a fifth value
  added there is a change here too, which is the point.
- **How does it unify?** Same rule as the rest of this branch: when two parts of
  the system can disagree without erroring, one of them has to be the source of
  truth, and the other has to ask rather than guess.
