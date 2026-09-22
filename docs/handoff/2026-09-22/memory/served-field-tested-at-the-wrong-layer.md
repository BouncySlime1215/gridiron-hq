---
name: served-field-tested-at-the-wrong-layer
description: Two fields in PR #43 could each be deleted from their response in one line with the whole suite green, because every test called the producer directly; found by mutation on 2026-09-20.
metadata:
  type: feedback
---

**Thorough coverage of a function proves nothing about the field that function's
caller serves.** Measured on 2026-09-20 by deleting one line at a time from the
shipped source of PR #43 and re-running:

- `availability_basis: tracked.availability_basis` deleted from the `/news`
  response (`server/routes/news.js`): **6 of 6 tests still passed.** Every test
  in `test/news-availability-basis.test.js` calls `newsFantasyTracker`
  directly and none goes near the route. That field is the only thing
  `News.tsx`'s degradation note reads, so deleting it silences the exact
  sentence that says the numbers on screen are degraded.
- `slots_not_modelled` deleted from what `lineupCall` returns
  (`server/services/lineup-brain.js`): **34 of 34 tests still passed**, across
  all four of that PR's test files. `slotsNotModelled` is covered nine ways in
  `test/lineup-slots-not-modelled.test.js`, but that file calls the pure
  function and never the surface. That field is the K/D-ST disclosure.

**Why:** a test suite grows where the logic is interesting. The logic is in the
producer; the risk is in the one line of the consumer. Nine tests on the
producer and zero on the response literal is the normal, comfortable shape, and
it leaves the shipped behaviour undefended.

**How to apply:** for any field a page renders, the check is not "is the
function that computes it tested" but **"delete the field from the response
literal — does anything go red?"** Run that deletion before claiming a field is
wired. It takes one minute and it is the only thing that answers the question.
Prefer a test that runs the real surface (`lineupCall` against a fixture
league) over a source-text check; use a source check only where no harness
exists, and then write its limit into the test itself — a source check pins the
wire, not the rendering, and a page that reads a field and ignores it still
passes. Verified: replacing one of `News.tsx`'s two branch arms with a constant
was NOT caught, because the other arm keeps the string present.

This is the same rule as "verify the consumer, not the producer" in the project
index, and it now has a measured instance in this repository. See
[[gridiron-failure-modes]].
