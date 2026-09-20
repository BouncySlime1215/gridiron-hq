# TDD evidence (retroactive): the odds say what they were built from

**What this is.** Two commits on PR #58 — `8695375` ("My Team: stop stating a
playoff bracket the odds did not simulate") and `cabd95c` ("Say which
constants produced the odds, including when none did") — added
`client/src/components/OddsBasis.tsx` (83 lines), changed 5 lines of
`client/src/pages/MyTeam.tsx`, and committed
`test/odds-basis-rendered.test.js` (10 tests).

There is no RED commit. The defect was a sentence already on the deployed
page, found by reading what My Team asserted against what `season-sim.js`
returns. A RED commit written afterwards would prove only that a test can be
written to fail against code already known to be wrong.

**How the retroactive RED was shown.** Each guarded rule was reverted in the
shipped source — one mutation at a time, a real edit, run, then restored.
A test no mutation can fail proves nothing, so there is at least one mutation
per rule and every one is caught by the test that exists for it. Run at
`cabd95c` on 2026-09-20.

| Guarded rule | Mutation | Test that failed |
|---|---|---|
| The false sentence is gone from My Team | `<OddsBasis sim={sim} />` → the old hardcoded "real playoff bracket weeks 15–17" | 7 |
| A sentence for every basis the simulator can emit | the `default_weeks_15_17` entry deleted from `BRACKET` | 6, 7 |
| `null` renders as a statement, not as nothing | `if (fit === null) return '…no fitted model is active.'` → `return null` | 8 |
| `undefined` is not `null` | `if (fit === undefined) return null;` deleted | 8 |
| The fitted/hand-set volume split is stated | the `volume_k === 'hand_set'` branch removed, so it falls to "fitted throughout" | 9 |
| The projection basis is never cut | `${sim.projection_basis}` → `${sim.projection_basis.slice(0, 40)}` | 10 |
| The fallback really is a fallback (server) | `basis: 'default_weeks_15_17'` → `'league_schedule'` in season-sim.js | 1, 6 |

7 mutations, 7 caught, 0 that no test noticed.

## The rule this exists to protect

My Team carried a flat sentence: "real playoff bracket weeks 15–17". That is
false for any league whose bracket is not those weeks, and worse when it
happens to be right, because `default_weeks_15_17` is the FALLBACK
`playoffRounds()` takes when the league's schedule could not be read at all.
So the sentence read as a fact about the reader's league while being a fact
about our default. League 4 is a real instance.

`season-sim.js` had always decided and served `playoff_basis`,
`projection_basis` and `odds_interval`, and the page rendered none of them.
A served field nothing renders is not a disclosure.

## The half that needed more than a fit id

`projection_fit.volume_k` is the reason a fit id alone could not answer "which
constants produced these odds". With an active fit the simulator runs on
fitted efficiency constants and hand-set VOLUME constants at the same time:
`activeKVectorFor` withholds the volume entries from every caller not on
weekly-role recency, and the season simulator never is. Its own header says
those callers "keep the hand-picked constants they were validated with. They
are not claimed to be right, only untested with the fitted k." Calling that
"the fitted model" would be false in the half that moves most on a role
change.

`null` and `undefined` are deliberately different. `null` means no fit is
active — the live state today, since `shrinkage_fits` holds zero rows on the
deployed volume — and renders as a sentence, because an absent line reads as
"nothing to say about this". `undefined` means a response that predates the
field, which has told us nothing, and renders nothing.

## Mutation output, pasted

### n1 — the false sentence restored on My Team

```text
not ok 7 - the false sentence is gone, and the fallback is called an assumption
  error: "My Team still states one league's bracket as a fact for every league"
# tests 10
# pass 9
# fail 1
```

### n2 — the fallback's sentence deleted

```text
not ok 6 - the page has a sentence for every basis the simulator can emit
  error: 'OddsBasis has no sentence for default_weeks_15_17'
not ok 7 - the false sentence is gone, and the fallback is called an assumption
  error: 'the fallback is described as an assumption'
# tests 10
# pass 8
# fail 2
```

A basis with no entry renders as nothing at all — which is the silence this
component exists to end, and it would be silent exactly on a new, unhandled
case.

### n3 — no active fit renders nothing

```text
not ok 8 - no active fit is a sentence, not a missing line
  error: 'null renders as a statement about the constants, not as nothing'
# tests 10
# pass 9
# fail 1
```

### n4 — `undefined` conflated with `null`

```text
not ok 8 - no active fit is a sentence, not a missing line
  error: 'a response that predates the field renders nothing, which is different from null'
# tests 10
# pass 9
# fail 1
```

### n5 — the volume split collapsed into "fitted"

```text
not ok 9 - the fitted/hand-set volume split is stated, not collapsed into "fitted"
# tests 10
# pass 9
# fail 1
```

### n6 — the projection basis truncated

```text
not ok 10 - the projection basis is rendered whole
# tests 10
# pass 9
# fail 1
```

The string can read "2026 through week 5, but only 3 of those 5 weeks are in
the usage log". Clipping it deletes exactly the caveat it exists to carry.

### n7 — the server's fallback claims to be a real schedule

```text
not ok 1 - an unreadable league schedule really does fall back, and says so
not ok 6 - the page has a sentence for every basis the simulator can emit
# tests 10
# pass 8
# fail 2
```

`server/services/season-sim.js` belongs to PR #44 and the fantasy-plan
thread, not to this PR; the mutation was applied and restored, never
committed. It is here because tests 1 to 5 run the real `playoffRounds` and
`simProjectionBasis` rather than fixtures, and this shows those five bite
rather than agreeing with whatever the server says. Test 6 catching it too is
the second half of that test working as intended: it compares the bases the
component knows about against the ones the simulator actually emits, so a new
or changed basis on either side is a failure rather than a silent gap.

## What this does not claim

The four basis values are written out by hand in the test rather than scraped
from either side. A check that derives its expectation from the thing it
checks passes the exact defect it exists to catch, and that is the standing
failure shape in this repository.

Tests 1 to 5 are not evidence for this PR's code. They pin behaviour in
`season-sim.js` that this PR's rendering depends on and that #44 introduced;
the evidence for that behaviour belongs with #44.

No live read backs this. Nothing was read from the deployed app for it.
