# Evidence: the served-field deletion check

**Item:** `scripts/served-field-check.mjs` — delete a field a page renders from the
response it is served in, and see whether anything goes red.

**Files owned and changed:** `scripts/served-field-check.mjs`, this document.

**Origin:** the UI thread, on PR #43. Deleting `availability_basis` from the `/news`
response literal left 6 of 6 tests green, and deleting `slots_not_modelled` from what
`lineupCall` returns left 34 of 34 green. Every test called the pure function and none
touched the served surface, so a disclosure the wiring map said must survive the
#43/#60 merge could have been deleted in one line, in silence. UI closed both on #43 at
`8606dc4` and named the pattern `served-field-tested-at-the-wrong-layer`.

---

## What it measures, and what it does not

Per branch: every `key:` the branch adds to a server-side object literal against its
merge base; kept only if the client reads that key by name; the line deleted; the test
files that name the changed modules run; the line restored. Reported: the fields that
stayed **green**.

**A green row is not a bug.** It says only that no test would notice this field going
missing from the wire. That is a smaller and different claim than "this field is wrong",
and it is exactly what makes the field cheap to delete by accident in a merge that
touches the same lines.

## Calibration — the evidence this tool works

There is no RED commit here because there is no defect being fixed: this is a
measurement script, and the thing that has to be shown is that it finds a known answer.
Run against #43's **pre-fix** head `e36ad08`, where the answer was already established
by hand:

```
base 791b131f — 6 added field(s) the client reads, 11 test file(s)
  GREEN  availability_basis        server/routes/news.js:252
  GREEN  slots_not_modelled        server/services/lineup-brain.js:641
  red    slots_not_modelled_reason server/services/lineup-brain.js:642
  red    win_probability_scope     server/services/lineup-posture.js:370
  red    availability_basis        server/services/news-fantasy-impact.js:156
  red    availability_basis        server/services/news-fantasy-impact.js:175
```

Two green, four red, and the two green are exactly the two the UI thread found. The
four reds matter as much as the greens: a tool that called everything unpinned would
have "found" both too, and would be worthless.

`availability_basis` appearing twice as red and once as green is the whole point in one
line — the same field name, pinned where the producer is tested
(`news-fantasy-impact.js`) and unpinned where it is actually served (`routes/news.js`).
That is why producer coverage reads as reassuring while the served surface is bare.

## Stated limits

- **The units are not unit-tested yet.** The calibration above is what stands in for
  that, and it is a weaker claim: it shows the script gets one known case right end to
  end, not that `addedFields`' diff-line arithmetic or `clientKeys`' name matching are
  right in general. Tests to follow; recorded here rather than left implied.
- `clientKeys()` matches any identifier anywhere under `client/src`, so a field whose
  name collides with an unrelated client identifier is included. That over-includes,
  which costs a test run and a row, and cannot hide a field.
- A line that ends in `{` or `[` opens a nested object; deleting it is a syntax error
  rather than a measurement, so those are skipped and are therefore not measured at all.
- The test subset is "files that name the changed module". A field pinned only by a test
  that names neither would be reported green wrongly. Widening the subset costs
  wall-clock, not correctness of the greens it does find.
