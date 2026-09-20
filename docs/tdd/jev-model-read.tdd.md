# The Jev model read — displayed on the counterparty layer, never priced

`manager_archetype_jev` has been written since the archetype build shipped and
**nothing in the trade path read it**. It holds a model's answers to typed
questions over each manager's own draft record — does he overvalue what he
already owns, does he counter or decline outright, would he move a player
cheaply after one bad week — which is close to the list of things
`counterparty-pricing.js` exists to know. The module that prices a trade the way
the other manager sees it priced every deal without ever opening it.

This pass brings it in as a **read of the person**: served on every manager's
layer entry, dated by the pass that made it, and moving no number at all.

Files: `server/services/manager-signals.js` (the accessor and its absences),
`server/services/counterparty-pricing.js` (how it reads), and
`test/valuation-map.test.js` G11a-g.

---

## 1. The decision, and why it is a refusal rather than an omission

Five of the eight questions in `JEV_QUESTIONS` carry `basis: 'inference_only'`.
That is the store's own column saying the record shown to the model contains no
evidence bearing on the answer — there are no trades, no waiver claims and no
timestamps in a draft record — so the model was told to stay near the prior, and
a flat answer there is the *correct* answer.

A prior that moves a price is a number invented about a person. So the read is
displayed and does not price, and that claim is worth exactly what guards it:
**G11d deletes the entire store and asserts that no price, multiplier, factor,
inert entry or receptiveness value changes.** Two injections (J9, J10) wire the
read into receptiveness and into a player's price respectively, and both go red.

If this is ever to price, it needs a decided-proposal sample to fit against,
like every other entry in `VALUATION_SOURCES`. Not a promotion.

## 2. The stamp, which is the part that is easy to get wrong

`manager_archetypes` and `manager_archetype_jev` are written by the same script
— but the Jev half runs **only when `--jev` is passed**, which is opt-in and
needs a gateway key (`scheduler.js` already reports the job as "not run —
opt-in"). So the two stamps drift apart by design: the archetype build can run
nightly while the model answers sit untouched for weeks. Dating a Jev answer
with `archetypesBuilt().as_of` would be the exact substitution this family of
accessors exists to prevent, so G11a asserts the two are different values.

And the stamp is returned **per manager, not per league**. `storeJevAnswers`
stamps each member as he is evaluated, and the pass can stop halfway through a
league because it costs a gateway call per manager. A league-wide `MAX()` would
print the newest manager's date under everybody's name (J1).

## 3. Four absences, four sentences

| state | sentence |
|---|---|
| the table is not on this database | the Jev pass has never run here |
| here and empty | the pass has never been run; it is opt-in |
| rows, but none for this league | it is run one manager at a time, so a partial store is normal |
| covers the league, not this manager | who it reached is a fact about the run, not about him |

The last is answered by the consumer from an empty `by_roster` entry. J7 blanks
it and J8 collapses two of them into one sentence; both go red.

## 4. Three readings the shaping has to get right

- **A boolean's other leg.** A boolean is stored as its `true` row alone. Taken
  as the whole distribution it is a single outcome, which has no spread to
  measure — so every boolean, the 0.5 non-answer and a real 0.8 lean alike,
  would come back unmeasurable (J4).
- **A score's summary is not an outcome.** `risk_appetite` stores a `mean` of
  3.2 beside its five level probabilities. Ranked among them, 3.2 beats every
  real probability and the answer reads as "most likely: mean" (J5).
- **A flat answer is not a 33% chance.** `0.34 / 0.33 / 0.33` is what "spread the
  probability evenly" looks like after a model rounds. Served as three numbers it
  invites a bar chart of noise and a reader who concludes he counters slightly
  more often than not. `JEV_FLAT_TVD = 0.05` decides whether a sentence appears,
  never whether a number moves (J3).

## 5. Mutations

Baselines: `server/services/counterparty-pricing.js` at `96e54c44c7ce`,
`server/services/manager-signals.js` at `bbc1ebea6dab`, on the exact tree these
gates pass on. The sweep was re-run after the shared-accessor extraction that
`docs/tdd/manager-page-reads.tdd.md` §3 describes, so the baselines below are
the file as it stands and not a tree that no longer exists. Every row records the file's SHA-256 before and after, so a
pattern that did not match is reported as a `NO-OP` and not counted as a result.
The named test is the ONE test that injection must turn red; an injection that
lands but kills a different test is unfinished, not a result.

| # | injection | verification | named test | result |
|---|---|---|---|---|
| 1 | serve the LEAGUE's newest evaluation as this manager's own stamp | `APPLIED 96e54c44c7ce -> fa3dd37f2d64` | went red | **RED** (1 failing) |
| 2 | every answer reported as measured, whatever its basis | `APPLIED 96e54c44c7ce -> e97dc5b5fad1` | went red | **RED** (2 failing) |
| 3 | drop the flatness threshold — any distribution counts as informative | `APPLIED 96e54c44c7ce -> 334161808b62` | went red | **RED** (1 failing) |
| 4 | take a boolean's stored 'true' row as the whole distribution | `APPLIED 96e54c44c7ce -> e517e7310247` | went red | **RED** (1 failing) |
| 5 | rank a score question's 'mean' summary as one of its outcomes | `APPLIED 96e54c44c7ce -> aa2d9f7a1662` | went red | **RED** (1 failing) |
| 6 | an unevaluated manager borrows the first evaluated manager's read | `APPLIED 96e54c44c7ce -> 25f4abb9d939` | went red | **RED** (1 failing) |
| 7 | blank the sentence for a manager the pass never reached | `APPLIED 96e54c44c7ce -> a82234586a95` | went red | **RED** (1 failing) |
| 8 | give the two different absences one shared sentence | `APPLIED bbc1ebea6dab -> 7ea9c3c37000` | went red | **RED** (1 failing) |
| 9 | let the model read nudge receptiveness | `APPLIED 96e54c44c7ce -> 5799e55c5d51` | went red | **RED** (1 failing) |
| 10 | let the model read price a player | `APPLIED 96e54c44c7ce -> 75630d4ee919` | went red | **RED** (4 failing) |
| 11 | scope the read to one league so it stops travelling with the person | `APPLIED bbc1ebea6dab -> fa0a155346c1` | went red | **RED** (1 failing) |
| 12 | CONTROL a pattern that is not in the file | `NO-OP - pattern not found` | — | **-** (0 failing) |

The exact text of every injection, before and after. A description of an edit is
not an injection, and a row that cannot be re-applied from what it prints is not
reproducible.

**J1 serve the LEAGUE's newest evaluation as this manager's own stamp** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> fa3dd37f2d64

```diff
- as_of: entry.as_of,
+ as_of: read.as_of,
```

**J2 every answer reported as measured, whatever its basis** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> e97dc5b5fad1

```diff
- const measured = a.basis === 'draft';
+ const measured = true;
```

**J3 drop the flatness threshold — any distribution counts as informative** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> 334161808b62

```diff
- const informative = spread != null && spread >= JEV_FLAT_TVD;
+ const informative = spread != null;
```

**J4 take a boolean's stored 'true' row as the whole distribution** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> e517e7310247

```diff
- const dist = outcomes.length === 1 && outcomes[0][0] === 'true'
+ const dist = false
```

**J5 rank a score question's 'mean' summary as one of its outcomes** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> aa2d9f7a1662

```diff
- .filter(([k, v]) => k !== 'mean' && Number.isFinite(v));
+ .filter(([k, v]) => Number.isFinite(v));
```

**J6 an unevaluated manager borrows the first evaluated manager's read** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> 25f4abb9d939

```diff
- const entry = read.by_roster.get(String(rosterId)) ?? null;
+ const entry = read.by_roster.get(String(rosterId)) ?? [...read.by_roster.values()][0] ?? null;
```

**J7 blank the sentence for a manager the pass never reached** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> a82234586a95

```diff
-       reason: read.reason
-         ?? 'the Jev pass has covered this league but not him — it is run one manager at a time and costs a '
-            + 'gateway call each, so who it reached is a fact about the run and not about him' });
+       reason: read.reason ?? '' });
```

**J8 give the two different absences one shared sentence** — `server/services/manager-signals.js`, APPLIED bbc1ebea6dab -> 7ea9c3c37000

```diff
-       reason: 'the Jev pass has never been run: it is opt-in, and `npm run build:manager-archetypes -- --jev` '
-         + 'is what would answer these questions' };
+       reason: 'the Jev pass has covered this league but not him — it is run one manager at a time and costs a gateway call each, so who it reached is a fact about the run and not about him' };
```

**J9 let the model read nudge receptiveness** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> 5799e55c5d51

```diff
-     const [lo, hi] = RECEPTIVENESS_RANGE;
+     if (jevBlocks.get(String(id)).answers.length) score += 0.01;
+     const [lo, hi] = RECEPTIVENESS_RANGE;
```

**J10 let the model read price a player** — `server/services/counterparty-pricing.js`, APPLIED 96e54c44c7ce -> 75630d4ee919

```diff
-   const profile = managerProfile?.negotiation ?? null;
+   const profile = managerProfile?.negotiation ?? null;
+   if ((managerProfile?.jev?.answers ?? []).length) add('luck_self_view', 0.05, 99, 'jev said so', null);
```

**J11 scope the read to one league so it stops travelling with the person** — `server/services/manager-signals.js`, APPLIED bbc1ebea6dab -> fa0a155346c1

```diff
-                          WHERE i.league_id = ?`, leagueId);
+                          WHERE i.league_id = ? AND i.league_id = 21`, leagueId);
```

**CONTROL a pattern that is not in the file** — `server/services/counterparty-pricing.js`, NO-OP - pattern not found

```diff
- const JEV_NOT_A_REAL_SYMBOL = 1;
+ const JEV_NOT_A_REAL_SYMBOL = 2;
```

**11 of 11 killed on the first pass**, each by the test it names, every file
restored clean, and the control correctly a `NO-OP`. This is the first clean
first-pass sweep of the night; the previous three pieces produced five survivors
between them and every one was a hole in the test rather than in the code
(`docs/tdd/valuation-panel.tdd.md` §6, `transactions-as-of.tdd.md` Parts 8-9).

## 6. Surviving mutations

None. No mutation is declared equivalent, because none survived.

Two guarantees are deliberately **not** guarded here, and are named so nobody
reads their absence as coverage:

1. **The `why` sentences are asserted by shape, not word for word.** G11b pins
   that a prior says "prior" and a measured answer does not, and that the two
   sentences differ; it does not pin their wording. Rewording them is allowed.
2. **`league_member_identity.confidence` is not consulted.** That gate governs
   attributing CHAT to a roster; an ESPN member id is an ESPN fact, and a manager
   whose chat name Nick never confirmed still has one. No test asserts the gate
   stays out, because the join reads no such column.

## 7. Found while doing this, not fixed here

`manager-archetypes.js` joins `league_season_teams` at three sites —
`teamMembers()` (:243), `managerProfile()` (:819) and `archetypesFor()` (:831).
**That table is created only by
`scripts/backfill-league-history.mjs`** — on any database where that backfill has
never run it is simply absent, and all three throw `no such table` rather than
returning an absence. This accessor joins `league_member_identity` instead,
which `matchIdentities` writes on every league sync, so it is present wherever a
league is. `manager-archetypes.js` is another thread's file; the finding is
routed, not patched here.

## The five questions

**Is it well built?** It adds one accessor in the shape of the three beside it
and one display helper, and it removes a claim rather than adding machinery: the
answers were already being written and are now readable with their date on them.

**Is it based on stats, or made up?** Both, and the point of the whole pass is
that each answer says which. `basis: 'draft'` means the record bears on it;
`basis: 'inference_only'` means it does not and the number is a prior. The one
constant introduced, `JEV_FLAT_TVD`, is hand-set, says so, and gates a sentence
rather than a number.

**How do we know?** Seven gates and eleven mutations, all killed first pass, each
by the test it names, with the SHA-256 of every injection recorded above.

**Should this data point anywhere else?** Yes. The same answers belong on the
manager board and on a trade card's counterparty read, and `trade_style` in
particular is the direct answer to "will he counter or just decline" that the
trade finder currently guesses at from chat rates. None of that is taken here:
they are display surfaces owned by other threads, and the block is now on the
layer entry for them to read. What must NOT happen is any of them turning it
into a weight without a fit.

**How does it unify?** The same rule as the rest of this branch — **a served
value carries the stamp of the process that MEASURED it, never the stamp of a
process that copied, scheduled or reported it**, and **an absence must say which
absence it is.** This adds a third: **a value that is a prior must say so where
it is read, not only where it is stored.** The `basis` column has been in the
store since day one; it had simply never travelled to anywhere a person could
see it.

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
