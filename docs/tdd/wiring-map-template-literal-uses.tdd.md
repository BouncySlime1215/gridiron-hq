# TDD evidence: template-literal interpolations count as uses of a value

**Commits.** RED `06e3779`, GREEN the commit that follows it. Rule affected:
`value-computed-never-used` in `scripts/wiring-map.mjs`. Report-only — it is
not in `GATING` or `NEW_ORPHAN` and has never failed CI.

## How it was found

Not by reading the checker, and not by any test written for it. It surfaced
running the map against a tree this thread did not build: the merge of the UI
thread's #43 (`43379c9`) and #46 (`cb312f76`) onto the wiring-map head
`f6efa84`, taken as a delta run to see what those two PRs changed in the graph.

The run reported:

```
value-computed-never-used  startingSlotCount (server/services/lineup-posture.js)
    assigned once and never referenced again anywhere in the repository
```

`server/services/lineup-posture.js` on `43379c9`:

```
219:  const startingSlotCount = slots.length + unmodelledSlots.reduce((n, s) => n + s.count, 0);
371:      ? `modelled starting slots only (${slots.length} of ${startingSlotCount}); ` +
```

Line 371 reads it. The finding was false.

This is the practice recorded in team memory after the 22:07Z check-in — the
author is the least reliable reviewer of their own checker, and a checker is
trusted only once a second tree has been run through it. The author's own tree
would never have shown this, because nothing in it happened to use a value
solely inside a message.

## Cause

`scan()` in `scripts/wiring-map.mjs` blanks the entire body of a template
literal out of the code view, interpolations included. Its own comment says so
and is right to: it keeps the body whole as one string for SQL purposes. But
`identifierCounts(f.code)` was the input to the liveness count, so a value
whose only other use sat inside a `${...}` was invisible, and the rule reported
the declaration with nothing after it.

## RED

`test/wiring-map.test.js`, two tests added at `06e3779`. That commit renames
the rule's input to `valueUsageCounts` and changes no behaviour, so the failure
is the real defect and not a missing export:

```
not ok 14 - a value used only inside a template literal is not "computed and never used"
  name: 'AssertionError'
  expected: 2
  actual: 1
# pass 35
# fail 1
```

The second test is the half that must not regress: `abandoned` declared once,
with the word `abandoned` appearing as prose inside a template literal, must
still count 1. Text in a literal is not a use. It passed at RED and still
passes, which is what stops the fix from being "count every word in every
string".

## GREEN

`valueUsageCounts` adds the `${...}` bodies back in, brace-matched so an
interpolation holding an object literal or a nested ternary ends at the last
brace rather than the first.

```
# pass 36
# fail 0
```

Gate re-run on the branch: exit 0.

## Blast radius, measured

Re-running the same merged tree with the fix in:

| | findings under `value-computed-never-used` |
|---|---|
| before | 95 |
| after | 23 |

72 of 95 — three quarters of everything that rule has ever reported — were
values used to build a message. Nothing was blocked, because the rule does not
gate. It was simply wrong at scale, in the report and on the published map.

## Residual imprecision, and its chosen direction

A nested template's own interpolation is reached on a later pass of the scan,
so the counts are additive rather than exact. Over-counting a name only ever
silences this rule. That is deliberate: a value wrongly called abandoned costs
someone a real investigation into working code, and one wrongly left alone
costs a missed finding. The cheap error is the one to prefer.

## What the delta run itself returned

With the fix in, #43 and #46 introduce no new findings. #46 resolves four:
`GET /api/auth/invites`, `POST /api/auth/invites`,
`DELETE /api/auth/invites/:id` and `POST /api/auth/accounts/:id/disabled` each
had no caller, which is the "an API shipped with no screen" shape this project
has hit before. Those four routes now have one.
