# TDD evidence: grading the person variables (2026-09-20)

**Item:** Nick, 2026-09-20 04:30Z — "I want real data on how to negotiate with all types
of people … scored on TONNSSS of physiology variables." And, 01:09Z — "I want this model
to be smart … Do we guess or is that fr tested."
**Slice:** 7 of the Coach rebuild — the check that decides whether any of the forty
person variables may be priced with, and the two run sheets that produce and grade them.
**Files:** `server/services/coach/people/grading.js`,
`scripts/build-person-profiles.mjs`, `scripts/grade-person-profiles.mjs`; tests
`test/coach-person-grading.test.js`, `test/coach-person-profile-script.test.js`.
**Commits:** RED `b2254df`, GREEN `80533b4`, the run sheet and its test `f62896e`.
**LLM spend:** $0. Nothing here calls a model.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0). **The real chat corpus is not on this machine and was not read.** Both
fixtures are synthetic, and what they prove is stated narrowly below.

## 1. Audit: what "scored on variables" has to survive to be worth anything

Slice 6 produced forty numbers per person, every one shipping `priceable: false`. That
flag is the whole of this slice's subject: something has to be allowed to change it, and
nothing else may.

The temptation is to skip this. The variables are counted from real messages, the
arithmetic is tested, and it would be easy to call that enough and let
`counterparty-pricing` read them. This codebase has already been through exactly that
argument and come out the other side: `manager-signals.js:73-76` records that **no draft
metric survived its repeatability test**, which is why none of them is in the app. The
metrics were real counts of real drafts too.

So the question is not whether the numbers are computed correctly — slice 6 tested that
— but whether they describe a person or a fortnight.

**There are no labels, and this file does not pretend otherwise.** Nothing in this
database says whether a trade was accepted because the counterparty replies quickly.
Manufacturing a label would be the invention the whole Coach rebuild exists to remove,
and it would be the most damaging kind, because a number with a fabricated validation
behind it is harder to dislodge than one with none.

## 2. What was built

**The test is repeatability.** Split each person's chain in time, measure the variable on
the early part, and ask whether that predicts the same variable measured on the late
part, across people, better than guessing the population average.

**Two numbers, and a variable needs both.**

- `skill` = 1 − MSE(early → late) / MSE(population mean → late). Above zero means knowing
  this person's early value beats knowing nothing about him.
- `spearman` = rank correlation between early and late across people. Skill can be
  carried entirely by two extreme people while everyone in the middle is noise; rank
  cannot. It asks the question a human actually has — do people keep their order.

A pass needs `skill > 0` **and** `spearman >= 0.5`, over at least `GRADE_MIN_PEOPLE = 8`
people with a value in both halves. Eight is the number of managers in the smallest
league here that anyone actually trades in; it is a floor, not a sufficiency.

**The split is on time, not on message count.** A count split puts a chatty person's
early half months after a quiet person's, and then the halves are not comparable between
people — half the signal would be the calendar. One cut, the same date for everyone, at
0.7 of the corpus's own span, and the report says where it fell.

**Three outcomes are said rather than quietly failed**, because each is a different
thing and collapsing them into "fail" would retire working variables:

- `not_gradeable` — the thirteen read from `manager_chat_profile` are one row per person
  for the whole chain, so there is no early half of them to split off. A property of the
  storage, not of the variable.
- `not_enough_data` — fewer than the floor of people have a value in both halves.
  Nothing has been measured about it either way.
- `not_enough_data`, second form — every person has the same late value, so there is
  nothing for the variable to tell apart and no skill score exists.

**Applying is a separate call**, and it resets every row to not-priceable before setting
anything. A variable that passed last month and fails today loses the flag rather than
keeping it. Grading tells you something; acting on it is a decision, and running the
harness must never quietly change what the platform may price.

**Two run sheets**, both tested end to end rather than merely written, because a script
that has never run is a script that fails in front of someone at six in the morning:

- `scripts/build-person-profiles.mjs` — reads every message of the real corpus, counts
  the forty variables, loads `coach_person_variables`. Dry run by default. It is one
  script rather than a compute step and a load step, deliberately: splitting them would
  mean an intermediate file holding exactly the data that must not leave the Mac.
- `scripts/grade-person-profiles.mjs` — grades and prints; `--apply` sets priceable.

## 3. RED and GREEN

RED `b2254df`: the suite written against a module that does not exist; 0 pass.
GREEN `80533b4`: **12 pass, 0 fail**, after the mutation run below and the four tests it
forced. The run sheet's own suite is 5 pass, 0 fail (`f62896e`).

The first fixture was wrong and the harness caught it, which is the most useful thing
that happened in this slice. It made every person shout identically in the late half, so
all late values were equal, `MSE(population mean → late)` was zero, and the harness
correctly reported "nothing to tell apart" rather than the failure the test expected. The
fixture now reverses the order between halves instead — the person who shouts most early
shouts least late — so both halves have real spread and the failure is one a skill score
can actually see. An unstable variable where everyone converges is not a detectable
failure, and the test was asking for the wrong thing.

## 4. Mutation table — every injection APPLIED, by hash

**Coverage, measured not asserted.** This sweep's 10 injections turn red all 12 tests of
`coach-person-grading.test.js`. Its rows also run `coach-person-profile-script.test.js`,
whose five tests are killed by the person sweep rather than by anything here — the two
specs share a suite, so the count that matters is the union across both files.
Across all eight Coach sweeps the union of red titles covers **159 of the 159 tests** in
the twelve `test/coach-*` suites, from 155 injections. Nothing in these suites is
turned red by nothing. The full check was green on the tree at `e249cc5`: **3,116 tests,
3,075 pass, 0 fail, 41 skipped, 475.3 s**, build and startup smoke on an isolated
database included, `npm run check` exit 0. Reproduce the coverage with the harness's
`--baseline` mode and the spec file beside it.

Every row was re-measured at head `fdfebf5`, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/grading.json

The harness hashes the file, applies one literal substitution, runs the named suites,
restores the file and proves the restore by hashing it again. **The literal text of every
row's injection is quoted in `docs/tdd/sweeps/EDITS.md`**, generated from those same spec
files with a staleness gate in the suite, so the quotation cannot describe an injection
nobody ran. The
SHA-256 pair is the point of the row: a diffstat says something changed, a hash pair says
exactly which bytes the suite was run against, so the row can be reproduced without
guessing at the injection. A row whose anchor is not in the source is reported NOT
APPLIED rather than scoring zero failures — that happened once in this sweep (M12's
anchor had the wrong punctuation) and is the failure mode the control below exists for.

**The last row of the table is a NO-OP control.** It rewords a sentence of the file's own
header: the hash moves, so the harness demonstrably applied it, and no test fails, so a
zero in the "Red" column is a real result rather than a silent non-match. Without it, an
injection that quietly failed to apply would look exactly like an injection the suite
survives.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| M61 | every variable passes | `grading.js` | `ef500418` → `6c2d873a` | 5 | `coach-person-grading.test.js` — a variable that changes between the halves fails, and is named |
| M62 | a positive skill score alone is a pass; the rank check is dropped *(survived the first pass; the test in the last column was written for it)* | `grading.js` | `ef500418` → `eb6d9a28` | 1 | `coach-person-grading.test.js` — beating the average on size is not enough: people have to keep their order |
| M63 | grade a variable however few people have a value in both halves | `grading.js` | `ef500418` → `adf47ebe` | 1 | `coach-person-grading.test.js` — too few people is "not enough data", never a pass and never a fail |
| M64 | grade the extractor's whole-chain aggregates as if they could be split | `grading.js` | `ef500418` → `11a2da37` | 2 | `coach-person-grading.test.js` — the extractor's own aggregates are reported as ungradeable, not as failures |
| M65 | compute a skill score when every late value is identical *(survived the first pass; the test in the last column was written for it)* | `grading.js` | `ef500418` → `9875538a` | 1 | `coach-person-grading.test.js` — a variable nobody differs on is "not enough data", not a failure |
| M66 | applying grades does not reset priceable first *(survived the first pass; the test in the last column was written for it)* | `grading.js` | `ef500418` → `f65bd440` | 1 | `coach-person-grading.test.js` — applying a grade takes priceable away as readily as it gives it |
| M67 | failed variables are made priceable alongside the passing ones | `grading.js` | `ef500418` → `917ae06b` | 2 | `coach-person-grading.test.js` — only a pass may make a variable priceable, and it is a deliberate second step |
| M68 | the split falls at 0.99 of the span rather than 0.7 | `grading.js` | `ef500418` → `e8f237dc` | 7 | `coach-person-grading.test.js` — a variable that is the same in both halves passes |
| M77 | the cut is made on message count rather than on time | `grading.js` | `ef500418` → `c3348c05` | 1 | `coach-person-grading.test.js` — the split is on time, not on message count, and the report says where it fell |
| M78 | the people count comes back as a string, so a caller's arithmetic on it silently concatenates | `grading.js` | `ef500418` → `ba61d7e2` | 2 | `coach-person-grading.test.js` — grading reports every computed variable, with the people behind each grade |
| M69 | drop the per-half sample floor | `grading.js` | — | — | **removed as unreachable, not injected** — see below |
| NC-grading | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `grading.js` | `ef500418` → `2bc22c1d` | **0** | none — and that is the assertion |

**M77 and the test it needed, which is the most serious thing in this file.** The
headline design decision of this slice is that the cut is made on time and not on
message count, and the test named for it asserted only that `split` was 0.7, that
`split_at` was truthy and that it looked like a date. A count-based implementation
satisfies all three. Model audit measured it — `ef500418` → `5de823f7`, twelve pass,
zero fail — and was right: the shipped code was correct and the test was the hole. It
was invisible to this mutation table because every row in it reproduced.

The fix is a third fixture rather than a sharper assertion on the old one. Ninety
messages land inside a single day and ten more over the following ninety-nine, so the
time cut falls around day seventy and the count cut inside the first day: two months
apart, and no coincidence can close the gap. The test now asserts `split_at` equals
`lo + 0.7 × (hi − lo)` computed from the fixture's own bounds, and separately that the
cut is more than sixty days past `lo`, so a failure says which property broke. M77 is
that count-based implementation, and it dies.

**M78 was supplied by Model audit** rather than found here, and it is the second kind of
hole: `n_people` returned as a string. Arithmetic on it concatenates instead of adding,
and the row-shape test was checking the field's presence rather than its type.

**M62, and the fixture it needed.** Dropping the rank requirement changed nothing,
because the fixture's unstable variable already failed on skill — rank was never the
deciding vote. The test that now kills it needed a corpus of its own: ten people
clustered tightly with their order shuffled between halves, and two far-out people who
stay put. The two outliers carry the squared error on their own, so skill comes out
near 0.99 while the rank correlation sits under 0.5 — exactly the shape a skill score
cannot see, and the reason there are two numbers rather than one.

**M65 and M66** each survived because nothing exercised them: no variable in the fixture
had an identical late value for everyone (`dm_share` does, and is now asserted), and
nothing set `priceable = 1` before applying (a test now does, then asserts a failing
variable loses it).

**M69 is not a survivor; it is a deletion.** The per-half `a.n < MIN_N` check could not
be made to fire: `personVariables` already withholds below `MIN_N` and returns `null`,
and the loop skips nulls. It was removed rather than kept, because a guard that cannot
fail is a guard nobody can test and a reader will believe is doing something.

## 5. The five questions

**Is this well built?** The design decision worth defending is requiring two statistics
rather than one, and the M62 fixture is the argument for it: a single skill score passes
a variable that is two outliers and ten coin flips. The thresholds themselves are the
weak part and are stated as such — `skill > 0` is principled (it is the point at which
knowing the person beats not knowing him), but `spearman >= 0.5` and `GRADE_MIN_PEOPLE =
8` are judgement calls, and eight people is a small sample to conclude anything from
even when the arithmetic is right.

**Is it based on stats, or made up?** It is a statistic about statistics, and it is the
narrower of the two claims available. It does not say a variable predicts behaviour. It
says a variable measured on one stretch of a chain predicts itself measured on another,
which is the precondition for the claim anyone actually wants and is not that claim. A
variable that passes has earned the right to be called a property of that person and
nothing more.

**How do we know?** 12 tests here and 5 on the run sheet, 8 injections each stated above
with the file's SHA-256 before and after it, all killed, one no-op control that moves the
hash and kills nothing, and one guard deleted for being unreachable. But the honest headline is the
limitation: **the harness has never run against a real chain.** Every number in this
file comes from a corpus built so the answer was known in advance, which proves the
harness can tell a stable variable from an unstable one and proves nothing whatever
about the forty variables themselves. The correct statement about them today is still
that none is priceable and none has been measured.

**Should this data point anywhere else?** The verdict list is the thing to route, not the
variables. `counterparty-pricing` and `trade-acceptance` belong to another thread and
should read `coach_person_variables.priceable` rather than the variable table directly,
so a variable that fails a later grading stops being priced without that thread changing
anything. And the shape generalises: the same split-and-compare would work on any
per-person quantity this app derives, several of which have never been checked either.

**How does it unify?** It gives the platform one answer to "is this number allowed to
matter", written in the same place the number is stored, and it puts the person
variables under the rule the draft metrics were already held to. Before this there were
two standards: draft metrics had to survive a repeatability test, and everything derived
from chat did not.

## 6. What this slice does not do

It has not graded anything real. It cannot, here. When it runs on Nick's Mac the expected
outcome is that a meaningful fraction of the forty fail — `manager-signals.js` is the
precedent and every draft metric failed there — and the harness is worthless if it
cannot say which by name, which is why the runner prints the failures and their reasons
rather than a score.

It also does not test prediction, and no amount of passing here licenses a claim that it
does. A separate thing would have to be built for that, and it would need trade outcomes
joined to the chain — the same missing join that `NOT_COMPUTED`'s
`concession_after_counter` entry already names.
