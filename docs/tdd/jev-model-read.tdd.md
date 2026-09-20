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

Baselines: `server/services/counterparty-pricing.js` at `e9fd77999ace`,
`server/services/manager-signals.js` at `bbc1ebea6dab`, on the exact tree these
gates pass on. Every row records the file's SHA-256 before and after, so a
pattern that did not match is reported as a `NO-OP` and not counted as a result.
The named test is the ONE test that injection must turn red; an injection that
lands but kills a different test is unfinished, not a result.

| # | injection | verification | named test | result |
|---|---|---|---|---|
| 1 | J1 serve the LEAGUE's newest evaluation as this manager's own stamp | `APPLIED e9fd77999ace -> 6280134332f4` | went red | **RED** (1 failing) |
| 2 | J2 every answer reported as measured, whatever its basis | `APPLIED e9fd77999ace -> 5f092d525961` | went red | **RED** (2 failing) |
| 3 | J3 drop the flatness threshold — any distribution counts as informative | `APPLIED e9fd77999ace -> 45f65132dc40` | went red | **RED** (1 failing) |
| 4 | J4 take a boolean's stored 'true' row as the whole distribution | `APPLIED e9fd77999ace -> 917cb938c9f8` | went red | **RED** (1 failing) |
| 5 | J5 rank a score question's 'mean' summary as one of its outcomes | `APPLIED e9fd77999ace -> 74431b27b68f` | went red | **RED** (1 failing) |
| 6 | J6 an unevaluated manager borrows the first evaluated manager's read | `APPLIED e9fd77999ace -> b4923e508d68` | went red | **RED** (1 failing) |
| 7 | J7 blank the sentence for a manager the pass never reached | `APPLIED e9fd77999ace -> a6c24c183bf2` | went red | **RED** (1 failing) |
| 8 | J8 give the two different absences one shared sentence | `APPLIED bbc1ebea6dab -> 7ea9c3c37000` | went red | **RED** (1 failing) |
| 9 | J9 let the model read nudge receptiveness | `APPLIED e9fd77999ace -> a06cc1da72ff` | went red | **RED** (1 failing) |
| 10 | J10 let the model read price a player | `APPLIED e9fd77999ace -> 77cf440816d8` | went red | **RED** (4 failing) |
| 11 | J11 scope the read to one league so it stops travelling with the person | `APPLIED bbc1ebea6dab -> fa0a155346c1` | went red | **RED** (1 failing) |
| 12 | CONTROL a pattern that is not in the file | `NO-OP - pattern not found` | — | **-** (0 failing) |

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
