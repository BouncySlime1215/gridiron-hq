# TDD evidence: one name per stat, with an explanation that helps (2026-09-20)

**Item:** Nick's binding rules for the redesign, 2026-09-20 — stat explanations written
for someone who never deals with stats, "detailed not wtf"; one normalised name per stat
everywhere on the platform. Also 04:30Z — Coach must "defend those answers with stats".
**Slice:** 5 of the Coach rebuild — the single list of what every number means.
**Files:** `server/services/coach/stat-names.js`; tests `test/coach-stat-names.test.js`.
**Commits:** RED `28bb577`, GREEN `426d80e`, this file after the mutation run.
**LLM spend:** $0.
**Environment:** cloud container, fresh clone of `origin/main` at `791b131`, `npm ci`
run (exit 0). Every `table.column` below is checked against the schema the app creates
on first import, by test, rather than by reading.

## 1. Audit: the same quantity, three names, no definition

Today each screen names its own numbers, because each screen was built on its own. The
result is that the same stored column is presented under different words in different
places and no screen says what any of them mean. A reader who does not already know what
WOPR is learns nothing from a page that prints "WOPR 0.61", and a reader who does know
cannot tell whether this page's "air yards share" is the same quantity as another page's.

For Coach the problem is sharper than presentation. A model asked to "defend those
answers with stats" will happily define a stat from training — and training's definition
of yards per route run is correct in general and false here, because this database
cannot produce it. A confident definition of a number the app does not have is a
hallucination with no digits in it, so the grounding check from slice 2 would not catch
it. The fix is not a better prompt; it is a list.

## 2. What was built

**38 concepts.** Each is an id (internal), a `name` (what a person reads, the same on
every screen), and four fields that do the work:

```js
target_share: concept('Target share', 'share of 1', 'higher',
  'Of every pass his team threw, the fraction thrown at him. 0.28 means 28 of every 100.',
  'It separates a player who is genuinely first in line from one who happened to get eight
   targets in a game where his team threw fifty.'),
```

`plain` says what the number is, with no jargon in it. `why` says why it matters, in
fantasy terms. `better` says which direction is good, because a number with no direction
is just a number — and it is `'neither'` where neither direction is good, which is the
honest answer for a handful of them.

**44 field mappings.** `STAT_FIELDS` maps `table.column` to a concept, so a screen
labels a number by asking rather than by hard-coding a string. Two different columns can
map to the same concept — `player_week_snaps.offense_pct` and `nfl_snaps.offense_pct`
are both snap share — which is the point: one concept, one name, however many places
store it. A test asserts every mapped column exists in the real schema (M43) and that no
two concepts share a display name (M44).

**Four stats this app does not have, named on purpose.** `NOT_STORED` carries Yards per
route run, Touchdown rate, Route participation and Red-zone share, each with `plain`,
`why`, and a `needs` sentence saying exactly what is missing:

> **Yards per route run.** A routes-run count per player per week. Nothing in this
> database has one — not `player_week_usage`, not `nfl_snaps`, not the `off_*` season
> tables — and it is not derivable from snap counts, because a snap is not a route. It
> would need a charting feed (PFF, Fantasy Points Data or similar), which is a paid
> source.

The four are not equivalent and the entries say so. Red-zone share is *missing rather
than impossible* — `nfl_play_by_play` holds the plays and nothing aggregates them per
player per week, so it is buildable here. Touchdown rate can be computed per player
through the ledger but should not be shown as a stored stat until the red-zone split
exists. Yards per route run and route participation both need the same paid feed and are
therefore a purchasing decision, not an engineering one.

**`availability_basis`** is in the list as three values — fitted, durability prior,
default durability — with the last written as "not a measurement", adopted from the
scheduler thread's reading of how the availability fit falls back. A default that reads
like a measurement is the same failure as a missing stat that reads like a present one.

## 3. RED and GREEN

RED `28bb577`: suite written against a module that does not exist; 0 pass.
GREEN `426d80e`: 11 pass, 0 fail. No injection in this slice survived, so none forced a
test; one test was added afterwards for the emitted artifact described below, and the
suite stands at **12 pass, 0 fail**.

## 4. Mutation table — every injection APPLIED, by hash

**Coverage, measured not asserted.** This sweep's 12 injections turn red all 12 tests of
`coach-stat-names.test.js`.
Across all eight Coach sweeps the union of red titles covers **159 of the 159 tests** in
the twelve `test/coach-*` suites, from 155 injections. Nothing in these suites is
turned red by nothing. The full check was green on the tree at `e249cc5`: **3,116 tests,
3,075 pass, 0 fail, 41 skipped, 475.3 s**, build and startup smoke on an isolated
database included, `npm run check` exit 0. Reproduce the coverage with the harness's
`--baseline` mode and the spec file beside it.

Every row was re-measured at head `fdfebf5`, and every row is reproducible:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/lexicon.json

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

**Coverage of this file's own suite: 12 of 12.** The union of the tests these rows turn
red is every test in `coach-stat-names.test.js`, which is the seventh part of the
standard and is stated because the first pass of this table covered 5 of 12. A mutation
table that kills every row it contains still says nothing about the tests it never
touches.

**The last row of the table is a NO-OP control.** It rewords a sentence of the file's own
header: the hash moves, so the harness demonstrably applied it, and no test fails, so a
zero in the "Red" column is a real result rather than a silent non-match. Without it, an
injection that quietly failed to apply would look exactly like an injection the suite
survives.

| # | Injection | File | SHA-256 before → after | Red | The test that must go red |
|---|---|---|---|---|---|
| M43 | a lexicon field points at a column that does not exist | `stat-names.js` | `1fb9399d` → `cddeada0` | 2 | `coach-stat-names.test.js` — every field the lexicon names is a real column of a real table |
| M44 | two concepts ship the same display name | `stat-names.js` | `1fb9399d` → `1276e085` | 2 | `coach-stat-names.test.js` — a display name belongs to exactly one concept, so the same words never mean two things |
| M45 | the stat people ask for most is renamed, so nothing finds the gap | `stat-names.js` | `1fb9399d` → `0680ca25` | 3 | `coach-stat-names.test.js` — a stat we do not store says so, and says what it would take |
| M58 | a concept is renamed without regenerating the emitted lexicon | `stat-names.js` | `1fb9399d` → `e62c7da9` | 1 | `coach-stat-names.test.js` — the emitted lexicon is the module, not a second copy that has drifted |
| M81 | a field points at a concept id nothing defines | `stat-names.js` | `1fb9399d` → `92706bda` | 4 | `coach-stat-names.test.js` — every field points at a concept that exists |
| M82 | a concept gives a direction that is not one of the three the app knows | `stat-names.js` | `1fb9399d` → `8c675ac4` | 2 | `coach-stat-names.test.js` — every concept has a display name, a plain sentence and a direction |
| M83 | the same quantity in two tables is given two different names | `stat-names.js` | `1fb9399d` → `ce788fa3` | 2 | `coach-stat-names.test.js` — the same quantity in two tables resolves to the same name |
| M84 | describeField hands a screen the name alone, with no unit and no direction | `stat-names.js` | `1fb9399d` → `79a589c7` | 1 | `coach-stat-names.test.js` — describeField gives a screen everything it needs to label a number |
| M85 | an unknown field comes back as a guessed label rather than as nothing | `stat-names.js` | `1fb9399d` → `09df6db9` | 1 | `coach-stat-names.test.js` — an unknown field is null, not a guessed label |
| M86 | the lexicon handed to a client carries a function, which JSON drops in silence | `stat-names.js` | `1fb9399d` → `9eec9115` | 1 | `coach-stat-names.test.js` — the lexicon serialises for a client with no Maps and no functions |
| M87 | the basis explanation drops the constant case, so a number with no measurement behind it reads as measured | `stat-names.js` | `1fb9399d` → `aefe01b4` | 2 | `coach-stat-names.test.js` — chance to play cannot be shown without its basis |
| M88 | the field map is handed over as a Map, which survives JSON as an empty object | `stat-names.js` | `1fb9399d` → `d7af2b65` | 2 | `coach-stat-names.test.js` — the lexicon serialises for a client with no Maps and no functions |
| NC-lexicon | NO-OP CONTROL: reword the file's opening line, changing no behaviour | `stat-names.js` | `1fb9399d` → `0fcf1c78` | **0** | none — and that is the assertion |

**M45 turns three tests red, not two**, which is what the table says and what the prose
here used to contradict. Renaming the `Yards per route run` entry to `YPRR` breaks the
two tests that look the gap up by name — the gap is reached from more than one place on
purpose, so a rename cannot quietly orphan it — and a third, the staleness gate, because
the emitted `docs/stat-lexicon.json` no longer matches the module. The third is a
consequence of the generator landing after this row was first measured, and it is
recorded rather than tidied away: a row's red count is a measurement of the suite as it
stands today, not a fixed property of the injection.

**M58 is the file's most concentrated row and that is worth saying plainly.** It carries
a later number because it was added with the generator, after the numbered pass, and it
is killed by exactly one test: the gate that regenerates `docs/stat-lexicon.json` and
compares. Every other property in this slice is held by two or more assertions. Delete
that one test and a renamed concept ships with a stale emitted lexicon and nothing
anywhere goes red — so the single test is the whole of the guarantee, and anybody
touching `scripts/emit-stat-lexicon.mjs` or its gate should know they are standing on
one plank rather than a floor.

## 5. The five questions

**Is this well built?** It is a data file with three small functions over it, and its
whole claim to correctness is that the tests check it against the live schema rather
than against itself. The weakness is that the mapping is written by hand: 44 of the
app's columns are named here and the rest are not, so an unnamed column still gets
whatever the screen calls it. That is a coverage number that should grow, and it is
better than a generator that would invent plausible prose for columns nobody has
thought about.

**Is it based on stats, or made up?** The definitions of third-party stats are those
sources' own — Next Gen Stats, Pro Football Reference and nflverse each define what they
publish, and where a definition is this app's, `source` says so rather than implying
outside authority. The `why` sentences are judgements about fantasy relevance and are
written as such; they make no numerical claim.

**How do we know?** 11 tests and 4 injections, each stated above with the file's SHA-256
before and after it, all killed, beside a no-op control that moves the hash and kills
nothing. The strongest of them is the schema check: each of the 44 `table.column` keys in `STAT_FIELDS`
is verified to exist by querying `pragma_table_info` on the database the app creates, so
a mapping cannot rot silently when a column is renamed.

**Should this data be pointed anywhere else on the platform?** Yes — this is the slice
with the most to give away, and it should be consumed rather than copied. The UI thread's
redesign needs exactly this for its stat explanations, and it now has it:
`scripts/emit-stat-lexicon.mjs` prints `docs/stat-lexicon.json` from this one module, the
file says at the top that editing it is pointless, and a test runs the generator in
`--check` mode so a rename in the module with a stale artifact beside it fails the suite
(M58). `NOT_STORED` is a purchasing and roadmap input:
two of the four entries are the same paid feed, one is buildable here and has been routed
to the thread that owns the play-by-play aggregates, and one is computable in the ledger
today. None of that is visible anywhere else.

**How does it unify?** It is the mechanism for Nick's "one normalised name per stat
everywhere". Before it, the same column had different labels on different screens and no
screen carried a definition; after it, a screen asks `describeField('player_week_usage.
target_share')` and gets the name, the plain sentence, the reason and the direction, and
Coach cites the same words in an answer. The unification is only real once the screens
call it, which they do not yet.

## 7. Added after the first pass

The UI thread's stat-table work named eleven quantities its depth-chart and
advanced-stats panels need. Eight were already here — target share, air-yards share,
snap share, WOPR, aDOT, RACR, PACR and catch rate (mapped from
`off_ngs_season.catch_percentage`) — and expected points was too, as
`expected_fantasy_points`. Two were genuinely missing and are now in: **Position** and
**Depth-chart rank**, mapped from `players.position`, `players.depth_rank`,
`off_depth_chart.pos_abb` and `off_depth_chart.pos_rank`, which is the case the
one-concept-many-columns design exists for.

Depth-chart rank's `why` says the thing a panel must not leave out: it is a listing
rather than a measurement, so it can be stale or wrong, and snap share is what settles
an argument between them. A rank shown with the same authority as a measured share is
the failure this lexicon is meant to prevent.

## 6. What this slice does not do

Nothing reads it yet. `docs/stat-lexicon.json` is emitted and gated, but the client does
not import it and still labels its own numbers, and Coach does not yet put the plain
sentence beside a cited number in an answer. Coverage is 44 columns of a 215-table schema, chosen as the ones that appear
on screens people look at, so a question about an unnamed column gets a number with no
explanation rather than a wrong one. And `availability_basis` is the only non-stat
concept in the list; the other "how do we know this" fields — fit ids, sample sizes,
as-of stamps — are not in here and arguably belong in a sibling list rather than this
one.
