# TDD evidence (retroactive): every surface names the model that priced it

**What this is.** PR #43 (head `e36ad08`, plus the test commit below) changed
`news-fantasy-impact.js`, `routes/news.js`, `lineup-brain.js`,
`lineup-posture.js` and four client files, and committed
`test/news-availability-basis.test.js` (6, now 7),
`test/lineup-slots-not-modelled.test.js` (9), 3 added tests in
`test/availability-honest-degradation.test.js` and 1 (now 2) in
`test/lineup-floor-objective.test.js`.

There is no RED commit. The defect was shipped behaviour found by reading
`contingency.js` against what the surfaces printed, not from a specification.
A RED commit written afterwards would prove only that a test can be written to
fail against code already known to be wrong.

**How the retroactive RED was shown.** Each guarded rule was reverted in the
shipped source — one mutation at a time, a real edit, run, then restored. Run
at `e36ad08` on 2026-09-20.

| Guarded rule | Mutation | Test that failed |
|---|---|---|
| A card is marked by the model that priced THAT player | `basisForRow(availabilityRow)` → the process `basis` | news 1, 2, 3, 5, 6 |
| A position the fit does not cover is its own case | `'unfitted_position'` → `'constants'` | news 3 |
| The page-level basis is served even with no cards | the key deleted from the tracker's return | news 1, 2, 4, 5 |
| Bench, taxi and IR depth is never a starting slot | `NON_STARTING_SLOTS.has(s)` dropped from the filter | slots 1, 2, 3, 5, 8, 9 |
| A corrupt `roster_positions` degrades, never throws | the `try/catch` removed | slots 7 |
| **The page-level basis survives the route** | `availability_basis` deleted from `/news` | **nothing — see below** |
| **The disclosure reaches the caller** | `slots_not_modelled` deleted from the response | **nothing — see below** |

## The two mutations that changed nothing

Both are the same shape, and it is this repository's standing failure shape: a
field computed correctly, covered thoroughly **where it is computed**, and then
droppable on the way out with nothing failing.

```text
### h4 (routes/news.js: the field dropped on the wire)
# tests 6
# pass 6
# fail 0

### h8 (lineup-brain.js: slots_not_modelled deleted from the response)
   run against ALL of this PR's four test files
# tests 34
# pass 34
# fail 0
```

Every test in `news-availability-basis` calls `newsFantasyTracker` directly and
none goes near the route. Every test in `lineup-slots-not-modelled` calls the
pure `slotsNotModelled` and none goes near the surface. So the two fields that
actually reach a reader could each be deleted in one line, in silence.

What those two fields are is why this matters rather than being a tidiness
point. `availability_basis` on the `/news` response is the only thing News.tsx's
degradation note reads, so deleting it silences exactly the sentence that exists
to say the numbers on screen are degraded. `slots_not_modelled` is the K/D-ST
disclosure — the thing that stops Start/Sit rendering a seven-slot lineup for a
nine-slot league without comment, and the field the wiring-map thread
specifically warned must survive the #43/#60 merge.

**Both holes are closed** by the commit `test: close two holes mutation testing
found in this PR's own coverage`, and the two new tests are deliberately not the
same kind of test.

The lineup one runs the real `lineupCall` against a league whose
`roster_positions` carry DEF, K, two bench seats and an IR slot, and asserts the
field on the response: the two slots with their counts, a non-empty reason, a
lineup still seven long, and bench and IR absent. It fails against h8 and passes
against the shipped code.

```text
### h8 re-run against the new test
not ok 5 - the slots nobody models reach the caller, with the sentence that explains them
# tests 5
# pass 4
# fail 1
```

The news one is a source check over `routes/news.js` and `News.tsx`, because the
route has no test harness here and building one for a single field would cost
more than it pins. It fails against h4:

```text
### h4 re-run against the new test
not ok 7 - both bases survive the route, which is the only way either reaches the page
  error: 'the /news response stopped carrying the page-level basis'
# tests 7
# pass 6
# fail 1
```

**And its limit is recorded in the test itself**, because four assertions invite
more confidence than they earn. It pins the wire, not the rendering. A page that
reads the field and then ignores what it says still passes: replacing one of the
two branch arms in `News.tsx` with a constant was tried, and the test did not
notice, because the other arm keeps the string present. Catching that needs a
rendered DOM, which this repository has no harness for. What it does catch is
the case that was previously undetectable — the field never arriving at all.

## Mutation output, pasted

### h1 — the process basis reported per card

```text
not ok 1 - a card priced by the fitted role layer says so, and is not marked assumed
not ok 2 - with no fit on file the same card carries the basis that priced it
not ok 3 - a position the fit does not cover is named, not quietly priced at the constant
not ok 5 - a player the role layer did not price is not labelled with the process basis
not ok 6 - a player with no fit of any kind reads as constants, not as the process basis
# tests 6
# pass 1
# fail 5
```

This is the defect, exactly. `playerActiveProbability` reaches the fitted role
cell only when the player has a `gap_bucket` AND the cell lookup hits; everyone
else falls to the pooled rates and past those to the hand-set chain. So a
process whose basis is `'role'` still prices some players pooled, and reporting
the process basis per card is the same overstatement the field exists to remove,
one level up.

### h2 — an uncovered position folded into the constants

```text
not ok 3 - a position the fit does not cover is named, not quietly priced at the constant
# tests 6
# pass 5
# fail 1
```

`weeklyAvailability` selects QB, RB, WR and TE only. A kicker is not an
assumption about that kicker; there is no guess, there is nothing.

### h3 — the page-level basis removed from the tracker

```text
not ok 1, 2, 4, 5 — "Cannot read properties of undefined (reading 'basis')"
# tests 6
# pass 2
# fail 4
```

### h6 — depth counted as an unmodelled starting slot

```text
not ok 3 - bench, taxi and IR depth is never reported as an unmodelled starting slot
  error: 'BENCH is depth, not a starting slot'
not ok 8 - starting slots and roster slots are different counts, and the scope uses the first
  error: |-
    17 !== 9
# tests 9
# pass 3
# fail 6
```

Test 8 is the one to read: 17 is the old denominator, which counted seven bench
seats and an IR slot as if they were starters. The matchup card said "7 of 17
roster slots", which reads as ten missing starters when two are missing.

### h7 — a corrupt `roster_positions` allowed to throw

```text
not ok 7 - a corrupt roster_positions value degrades to nothing, never to a throw
  error: "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
# tests 9
# pass 8
# fail 1
```

CLAUDE.md's rule is that errors are handled or they throw, and a bare `catch {}`
that swallows a fault is forbidden. This catch is the allowed kind and the file
says which: an unparseable roster list means the disclosure cannot be computed,
so it reports nothing, and the lineup — which does not depend on it — still
renders. A throw here would take down a page over a field it only annotates.

## What this does not claim

`test/lineup-slots-not-modelled.test.js` test 9 is the file's own broken-copy
check and was already there: it hands `slotsNotModelled` a modelled-slot list
that wrongly claims to cover the kicker and requires the kicker to disappear
from the report. It is not evidence about the mutations above; it is the
guarantee that the other eight are not decoration.

No live read backs any of this. Every test builds its own isolated temp SQLite
database.
