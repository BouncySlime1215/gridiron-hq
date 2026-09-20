# The manager page's two reads, and the span in the trade explanation

Three fixes, one defect in three sets of clothes: a fact about a store arriving
without the date it was measured, a fault arriving as an empty result, and a
span asserted to a model rather than read from what produced it.

Files: `server/routes/trades.js`, `server/services/counterparty-pricing.js`
(the shared accessor), `test/manager-signals-api.test.js` and
`test/trade-season-span.test.js`.

---

## 1. The explain prompt told the model the wrong season, every time

`season_delta` is the weekly lineup gain multiplied out. The prompt said it
held **"for a full 17-week season"** on every date the page was opened. In week
15 a gain worth three more weeks was handed to the model as seventeen weeks of
it, and the model then reasoned about a number five times the real one — while
being asked, in the same prompt, to sanity-check the engine's arithmetic.

The lineup diff now serves what it actually multiplied by:
`season_delta_weeks`, and `season_delta_basis` saying whether that is the weeks
left or a season-length default (feature audit's D11, names frozen at
`b048c86`). `fmtSeasonSpan` follows them.

**A payload carrying neither keeps the old wording.** That is deliberate and
tested: this branch does not have D11's producer yet, and guessing a count would
be worse than the sentence it replaces. The guard is `Number.isFinite`, not a
null check, so a string where a number belongs also falls back (D1).

A season-length default says it is a default. "Seventeen weeks left" and
"seventeen weeks assumed" are different claims, and the model has no way to tell
them apart unless the sentence does it (D3).

## 2. A read that threw was served as a store that is empty

`archetypesFor` sat inside a bare `catch {}`. A read that **failed** and a store
that is **empty** arrived identical: every manager's `archetype` came back
`null` and the page said the build had not run.

Not hypothetical. `archetypesFor` joins `league_season_teams`, whose only
`CREATE TABLE` is in `scripts/backfill-league-history.mjs` — an off-server
history backfill. Nothing in `server/db/` creates it and no migration adds it,
so on any database where that script has never run the join throws `no such
table` and the page blames the archetype build. Different facts, different
fixes. CLAUDE.md is explicit: if a layer goes inert, the surface must say so.

The store now gets a block of its own beside `transactions` and `chat`, carrying
`archetypesBuilt()` plus `read_failed`. The test renames the table away and
asserts the failure is named; a second test pins that a healthy read reports no
failure, or the sentence would mean nothing (D8).

## 2b. A reporting catch is better than a silent one and is still not the rule

Raised by chat sync after §2 shipped, and right. The catch above names its
failure, and it still absorbs **everything**: a missing table, a corrupt file
and a `TypeError` in the archetype code all become an empty map with a sentence
beside them. A page that says "the archetype read failed: <TypeError>" still
serves a 200, and a caller reads that as data.

Two different kinds of thing were being treated as one:

- **A missing `league_season_teams` is an ABSENCE.** Its only `CREATE TABLE` is
  in an off-server backfill; on a database where that never ran the read cannot
  succeed however correct the code is. This page's own job — serving the
  measured signals — does not depend on it, so it continues and says which state
  it is in.
- **A `no such column` is a FAULT.** The query and the schema disagree, which is
  a bug. A catch wide enough to take that turns every future mistake in the
  archetype code into a quietly empty panel — the exact shape CLAUDE.md names as
  having shipped two real bugs in this project.

So only the absence is absorbed and everything else is rethrown. The predicate
matches on the message because node:sqlite carries no error code for this, and
it is deliberately narrow: `no such column` and `no such function` are faults
and must not match (N2).

The state word is `table_absent`, which is `manager-archetypes.js`'s own word
for it (`identity_state` at `48324ff`), not a second vocabulary for one fact
(N3). `read_state` is the machine-readable half and `read_failed` the sentence
under it.

**This branch only.** Chat sync's `48324ff` makes `archetypesFor` RETURN an
empty map instead of throwing when the table is absent, so once that is on
`main` the absorb branch here stops being reachable for this case and the fact
must be read from their `leagueHistoryState()` instead. Follow-on 4b removes the
branch rather than leaving a dead one; it is not a rename of what is here.

### Mutations

Baseline `server/routes/trades.js` at `024f6cd5d2b3`.

| # | injection | verification | named test | result |
|---|---|---|---|---|
| 1 | absorb every error again, not only the absence | `APPLIED 024f6cd5d2b3 -> 5ca00e53fba1` | went red | **RED** (1 failing) |
| 2 | widen the predicate so a fault reads as an absence | `APPLIED 024f6cd5d2b3 -> e85868f3c0ff` | went red | **RED** (1 failing) |
| 3 | report the state in a word the archetype module does not use | `APPLIED 024f6cd5d2b3 -> 7742c2864ddf` | went red | **RED** (1 failing) |
| 4 | always report the state as present | `APPLIED 024f6cd5d2b3 -> 5753540ebdb1` | went red | **RED** (1 failing) |
| 5 | always report the state as table_absent | `APPLIED 024f6cd5d2b3 -> 750754bc3bbe` | went red | **RED** (1 failing) |
| 6 | CONTROL a pattern that is not in the file | `NO-OP - pattern not found` | — | **-** (0 failing) |

The exact text of every injection, before and after.

**N1 absorb every error again, not only the absence** — `server/routes/trades.js`, APPLIED 024f6cd5d2b3 -> 5ca00e53fba1

```diff
-     if (!isMissingTable(e)) throw e;
- 
+ 
```

**N2 widen the predicate so a fault reads as an absence** — `server/routes/trades.js`, APPLIED 024f6cd5d2b3 -> e85868f3c0ff

```diff
- const isMissingTable = e => /no such table/i.test(String(e?.message ?? ''));
+ const isMissingTable = e => /no such/i.test(String(e?.message ?? ''));
```

**N3 report the state in a word the archetype module does not use** — `server/routes/trades.js`, APPLIED 024f6cd5d2b3 -> 7742c2864ddf

```diff
-     archetypeState = 'table_absent';
+     archetypeState = 'absent';
```

**N4 always report the state as present** — `server/routes/trades.js`, APPLIED 024f6cd5d2b3 -> 5753540ebdb1

```diff
-       read_state: archetypeState, read_failed: archetypeError },
+       read_state: 'present', read_failed: archetypeError },
```

**N5 always report the state as table_absent** — `server/routes/trades.js`, APPLIED 024f6cd5d2b3 -> 750754bc3bbe

```diff
-   let archetypeState = 'present';
+   let archetypeState = 'table_absent';
```

**CONTROL a pattern that is not in the file** — `server/routes/trades.js`, NO-OP - pattern not found

```diff
- const N_NOT_A_REAL_SYMBOL = 1;
+ const N_NOT_A_REAL_SYMBOL = 2;
```

**5 of 5 killed on the first pass**, each by the test it names, control a `NO-OP`.

Full check on `d5fe7f6`, the commit this section describes, `npm run check`
(typecheck, lint, the whole suite, build, startup smoke) exit 0: **3,007 tests,
2,966 pass, 0 fail, 41 skipped, 364.0 s**; lint 877 JavaScript files, which is
exactly `git ls-tree -r d5fe7f6 -- server scripts test` filtered to `.js`/`.mjs`,
so the count is of this commit and not of whatever happens to be on the disk;
build clean; startup smoke 32 teams.

**This catch is correct on this branch and is removed after the merge.** On
`#41`'s own base, `archetypesFor` still throws when `league_season_teams` is
absent, so narrowing the catch is the fix; chat sync's branch makes that call
return an empty map and report the state through `leagueHistoryState()`, and
the post-merge patch removes the catch rather than leaving one nothing can
reach. The two are the same rule at two bases, not a contradiction.

## 3. The undated copy and the dated one were both on the page

`archetypesFor` carried the store's raw `jev` straight onto this payload: the
stored probabilities, with no evaluation date and no statement of which of them
have evidence under them. Nothing rendered it. The dated, basis-honest block
from `docs/tdd/jev-model-read.tdd.md` now reaches the page as `model_read`, and
the raw copy is stripped — two shapes of one answer on one payload is how a page
ends up rendering the one with no date on it.

`managerModelReads(leagueId, rosterIds)` is the shared call, so the page and the
counterparty layer cannot disagree. The page does **not** read it through the
layer: the layer is built from `manager_signals` keys, and a manager with no
signals still has a draft record somebody paid a gateway call to have read.

## 4. Mutations

Baseline `server/routes/trades.js` at `ff55095f19fc`, on the exact tree these
tests pass on. Every row records the file's SHA-256 before and after, so a
pattern that did not match is reported as a `NO-OP` and not counted as a result.
The named test is the ONE test that injection must turn red.

| # | injection | verification | named test | result |
|---|---|---|---|---|
| 1 | accept anything non-null as a week count | `APPLIED ff55095f19fc -> b55cadcaece3` | went red | **RED** (1 failing) |
| 2 | drop the singular | `APPLIED ff55095f19fc -> cd675d5716d6` | went red | **RED** (1 failing) |
| 3 | report a season-length default as the weeks left | `APPLIED ff55095f19fc -> 7acaa9b240fd` | went red | **RED** (1 failing) |
| 4 | swallow the archetype fault again | `APPLIED ff55095f19fc -> 6a07a043ace2` | went red | **RED** (1 failing) |
| 5 | serve the store's raw undated jev beside the dated read | `APPLIED ff55095f19fc -> e8dd18c80e43` | went red | **RED** (1 failing) |
| 6 | drop the dated model read from the manager | `APPLIED ff55095f19fc -> f3d0a3fcaf52` | went red | **RED** (1 failing) |
| 7 | never report a failed archetype read | `APPLIED ff55095f19fc -> 57c4f497776e` | went red | **RED** (1 failing) |
| 8 | report a failure whenever the store is merely healthy | `APPLIED ff55095f19fc -> 5b4587366bed` | went red | **RED** (1 failing) |
| 9 | CONTROL a pattern that is not in the file | `NO-OP - pattern not found` | — | **-** (0 failing) |

The exact text of every injection, before and after. A description of an edit is
not an injection, and a row that cannot be re-applied from what it prints is not
reproducible.

**D1 accept anything non-null as a week count** — `server/routes/trades.js`, APPLIED ff55095f19fc -> b55cadcaece3

```diff
-   if (!Number.isFinite(weeks)) return 'if that weekly gain held for a full 17-week season';
+   if (weeks == null) return 'if that weekly gain held for a full 17-week season';
```

**D2 drop the singular** — `server/routes/trades.js`, APPLIED ff55095f19fc -> cd675d5716d6

```diff
-   const plural = weeks === 1 ? 'week' : 'weeks';
+   const plural = 'weeks';
```

**D3 report a season-length default as the weeks left** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 7acaa9b240fd

```diff
-   return s?.season_delta_basis === 'full_season_default'
+   return false
```

**D4 swallow the archetype fault again** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 6a07a043ace2

```diff
-   } catch (e) { archetypeError = String(e?.message ?? e); archetypes = new Map(); }
+   } catch { archetypes = new Map(); }
```

**D5 serve the store's raw undated jev beside the dated read** — `server/routes/trades.js`, APPLIED ff55095f19fc -> e8dd18c80e43

```diff
-       archetype: withoutRawJev(archetypes.get(id)),
+       archetype: archetypes.get(id) ?? null,
```

**D6 drop the dated model read from the manager** — `server/routes/trades.js`, APPLIED ff55095f19fc -> f3d0a3fcaf52

```diff
-       model_read: modelReads.get(id) ?? null,
+       model_read: null,
```

**D7 never report a failed archetype read** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 57c4f497776e

```diff
- read_failed: archetypeError }
+ read_failed: null }
```

**D8 report a failure whenever the store is merely healthy** — `server/routes/trades.js`, APPLIED ff55095f19fc -> 5b4587366bed

```diff
- read_failed: archetypeError }
+ read_failed: String(archetypeError) }
```

**CONTROL a pattern that is not in the file** — `server/routes/trades.js`, NO-OP - pattern not found

```diff
- const D11_NOT_A_REAL_SYMBOL = 1;
+ const D11_NOT_A_REAL_SYMBOL = 2;
```

**8 of 8 killed on the first pass**, each by the test it names, file restored
clean, control a `NO-OP`.

## 5. Surviving mutations, and the union over a module-absent RED

None survived.

`test/trade-season-span.test.js` is a new file, so its RED was the
`fmtSeasonSpan` import failing — which node reports as one file-level
`not ok 1 - test/trade-season-span.test.js`, red for a single reason and
therefore no evidence about any individual test in it. Where that is the shape
of the RED, the union of the mutation rows has to cover every test in the suite
or the uncovered ones are unguarded:

| test | killed by |
|---|---|
| D11a the weeks left are named, in the plural the count calls for | D2 |
| D11b a season-length default says it is a default | D3 |
| D11c a payload without the fields keeps today's sentence | D1 |

Three tests, three killing rows, union complete — no test is missed and none
needs a stated reason. The three additions to `test/manager-signals-api.test.js`
do not need this: that file and its imports already existed, so each went red on
its own assertion with its own message.

One thing deliberately not guarded: no test asserts the prompt's *wording*
around the span, only that the count and the basis reach it and that the
fallback is the old sentence. Rewording is allowed; dropping the count is not.

## The five questions

**Is it well built?** Three deletions of a false claim and one shared accessor.
The only new code is `fmtSeasonSpan`, which is a sentence, and a helper that
strips a field.

**Is it based on stats, or made up?** The span was made up — a constant asserted
to a model as a fact about this week — and is now read from the process that
multiplied it. The model read says per answer whether it rests on anything.

**How do we know?** Six tests and eight mutations, all killed on the first pass,
each by the test it names, with the exact text of every injection printed above.

**Should this data point anywhere else?** The `archetypes` block belongs
wherever an archetype number is shown, the same way `transactions` and `chat`
already travel; and `model_read` answers "will he counter or just decline" on
the trade card. Neither is taken here — both are other threads' surfaces, and
the data is now on the payload for them to read.

**How does it unify?** One rule, three placements: **a served value carries the
stamp of the process that measured it**, **an absence must say which absence it
is** — a failed read is an absence, and the bare catch made it the wrong one —
and **a value that is a prior, or a default, must say so where it is read**.

## Full check on the exact tree

`npm run check` — typecheck, lint, suite, build, `start:smoke` — exit 0 on
**`7156e8a`** (`claude/project-thread-3xqh5l-accessor-hold`), working tree clean
and nothing else running against it:

- **3,006 tests, 2,965 pass, 0 fail, 41 skipped**, 357.5 s
- lint clean across 877 JavaScript files; typecheck clean
- build 0; startup smoke passed on an isolated database (32 teams)

The file count is stated from the tree, not from the reading:
`git ls-tree -r 7156e8a -- server scripts test` counts 877 `.js`/`.mjs`, which is
exactly what `scripts/lint.mjs` walks. It walks the filesystem, so an untracked
file inflates it — that is how an earlier 877 came to be reported for a commit
containing 876 (`docs/tdd/valuation-panel.tdd.md`).

`npm ci` has not been run in the container these numbers came from. A fresh clone
fails the offline-guard tests with `ERR_MODULE_NOT_FOUND` until it is, which looks
exactly like a regression and is not one. CI is not run: GitHub Actions is out of
minutes until 2026-10-01 and the workflow is disabled deliberately, so red or
missing checks are that and not this branch's content.
