# `server/services/availability-basis.js` — the six export rows, graded

Graded by the wiring-map thread, not by the thread that wrote the module:
`CONTRACT.md` §6 forbids a thread grading its own files. The trace these rows
rest on is Opportunity's, in `docs/inventory/evidence-opportunity.md` at
`ea7a208`; it named the six exports and deliberately left the grade column
empty. This file fills it.

**Where the subject is.** `server/services/availability-basis.js` does not exist
on `main` and does not exist on this branch. It is on
`claude/project-thread-w45mur-wiring-names-hold` (PR #85). Everything below was
re-measured at `70ad930` (PR #85's head), by `git grep` against that ref, not
read off the evidence file. Checking these line numbers out on any other branch
will not find them.

## The grades

| export | line | grade | betting-only? |
|---|---|---|---|
| `AVAILABILITY_FIT_BASIS` | `:84` | **wired** | no |
| `DEFAULT_DURABILITY_PRIOR` | `:101` | **wired** | no |
| `AVAILABILITY_BASIS` | `:40` | **decoration** | n/a — not reached |
| `SERVABLE_AVAILABILITY_BASIS` | `:76` | **decoration** | n/a |
| `DEFAULT_ACTIVE_PROBABILITY` | `:130` | **decoration** | n/a |
| `isAvailabilityBasis` | `:133` | **decoration** | n/a |

Two of six exports are wired. Four are decoration. The module is not dead — it
has a real production importer — and no export of it is betting-only.

## The two wired ones, and why they are not betting-only

Both are imported once, by `contingency.js:22`, and used inside functions that
serve:

- `DEFAULT_DURABILITY_PRIOR` at `contingency.js:923`, inside `weeklyAvailability`.
- `AVAILABILITY_FIT_BASIS` at `contingency.js:578`, inside the **non-exported**
  `fittedAvailability()`, which `weeklyAvailability` calls at `:911` and the
  exported `availabilityBasis()` calls at `:598`.

The all-paths test is what decides the betting question, and it is answered two
independent ways:

1. **Directly, at `70ad930`.** `server/routes/model.js` imports
   `contingency.js` itself — zero hops, a mounted route, not a betting one. Its
   other seven production importers there are `lineup-brain.js`,
   `news-fantasy-impact.js`, `player-week-engine.js`, `role-scenario-engine.js`,
   `season-sim.js`, `trade-engine.js` and `waiver-wire.js`. (Eight importers of
   the *module*; the evidence file's six is the importer count for
   `weeklyAvailability` specifically, a different question.)
2. **From this branch's wiring map**, which enumerates all surfaces reaching a
   module: `contingency.js` has **16 route families, 13 of them non-betting**
   (`/api/model`, `/api/news`, `/api/players`, `/api/trades`, `/api/accolades`,
   `/api/aggregates`, `/api/dev`, `/api/drafts`, `/api/espn`, `/api/leagues`,
   `/api/mlb`, `/api/nfl`, `/api/stats`) and **33 scheduled jobs**.

One non-betting path is enough, and there are 46. Neither export is close to the
betting-only grade.

Neither needs a table: one is a frozen three-string list, the other the number
`0.92`. So `wired` is defensible on the contract's own test — reachable, and
needing no data to be real.

## The four decoration ones

`CONTRACT.md`'s `decoration` test is production consumers = 0 with the defining
file excluded, **and** not reached internally either. Measured at `70ad930`,
both counts, per §3:

| export | uses outside the defining file | internal use |
|---|---|---|
| `AVAILABILITY_BASIS` | 10, all in `test/availability-basis-vocabulary.test.js` | `:134`, inside `isAvailabilityBasis` |
| `SERVABLE_AVAILABILITY_BASIS` | 4, same test file | none |
| `DEFAULT_ACTIVE_PROBABILITY` | 2, same test file | none — `:116` is a docstring |
| `isAvailabilityBasis` | 1, same test file | none |

`AVAILABILITY_BASIS` is the one that needs the §3 rule stated rather than
assumed. It **is** used internally, and §3 exists precisely because an internal
use can rescue a symbol that looks unimported — `SEASON_ENDING_RE` and
`RELEASED_RE` were wrongly called dead that way. It does not rescue this one:
the rule rescues a symbol when its enclosing function has production consumers,
and `isAvailabilityBasis` has none. An unreached function using a constant does
not make the constant reached.

**Not `dead`, and the distinction is the contract's own.** `dead` is a deletion
candidate — "nothing reaches it, and nothing is going to without new code". These
four are correct, tested, and are the vocabulary half of a module whose other two
exports are live; the plausible next code is a consumer, not a deletion.
`CONTRACT.md` names this module as the specimen for `decoration` in its own text
("six exports, ten tests, and four exports with no production consumer at all"),
so the grade is the one the contract was written around.

Each also earns the separate note §3 insists on: *exported and never imported* is
a tidy-up, not a category. For these four the two coincide, because the code path
is not live either.

## For re-check

Opportunity is building a reach-grader script (all entry paths, with a test that
a first-path-only variant mis-grades `player-week-engine.js`). When it lands,
re-run it over these six and diff against the table above. Two things to check
rather than a matching total:

- that it excludes `boot:server/index.js` as an entry point — it mounts every
  route, so counting it makes every module look non-betting-only, and it hid 13
  of 19 real rows in this thread's own sweep;
- that it treats an internal use inside an unreached function as **not** a reach,
  which is the only judgement call in the four decoration rows.

These grades are static-analysis grades. None of the six was observed running.
