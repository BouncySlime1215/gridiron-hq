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

**36 concepts.** Each is an id (internal), a `name` (what a person reads, the same on
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

**40 field mappings.** `STAT_FIELDS` maps `table.column` to a concept, so a screen
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

## 4. Mutation table — every injection APPLIED, with its diffstat

| # | Injection | Applied | Tests failing |
|---|---|---|---|
| M43 | a lexicon field points at a column that does not exist | 1 ins, 1 del | 1 |
| M44 | two concepts ship the same display name | 1 ins, 1 del | 1 |
| M45 | the stat people ask for most is renamed, so nothing finds the gap | 1 ins, 1 del | 2 |
| M58 | a concept is renamed without regenerating the emitted lexicon | 1 ins, 1 del | 2 |

M58 carries a later number because it was added with the generator, after the numbered
pass. M45 renames the `Yards per route run` entry to `YPRR`. It kills two tests rather than
one, which is the behaviour wanted: the gap is looked up by name from more than one
place, so a rename does not quietly orphan it.

## 5. The five questions

**Is this well built?** It is a data file with three small functions over it, and its
whole claim to correctness is that the tests check it against the live schema rather
than against itself. The weakness is that the mapping is written by hand: 40 of the
app's columns are named here and the rest are not, so an unnamed column still gets
whatever the screen calls it. That is a coverage number that should grow, and it is
better than a generator that would invent plausible prose for columns nobody has
thought about.

**Is it based on stats, or made up?** The definitions of third-party stats are those
sources' own — Next Gen Stats, Pro Football Reference and nflverse each define what they
publish, and where a definition is this app's, `source` says so rather than implying
outside authority. The `why` sentences are judgements about fantasy relevance and are
written as such; they make no numerical claim.

**How do we know?** 11 tests and 3 injections, each stated above with its diffstat, all
killed. The strongest of them is the schema check: each of the 40 `table.column` keys in `STAT_FIELDS`
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

## 6. What this slice does not do

Nothing reads it yet. `docs/stat-lexicon.json` is emitted and gated, but the client does
not import it and still labels its own numbers, and Coach does not yet put the plain
sentence beside a cited number in an answer. Coverage is 40 columns of a 215-table schema, chosen as the ones that appear
on screens people look at, so a question about an unnamed column gets a number with no
explanation rather than a wrong one. And `availability_basis` is the only non-stat
concept in the list; the other "how do we know this" fields — fit ids, sample sizes,
as-of stamps — are not in here and arguably belong in a sibling list rather than this
one.
