---
name: basis-fields-served-never-rendered
description: Three separate 2026-09-19 PRs each added a "where this number came from" field to an API response and none of them rendered it, so the app still cannot tell a measured number from a placeholder on screen.
metadata:
  type: project
  modified: 2026-09-19T21:02:02.374Z
---

Found 2026-09-19 by the UI-rebuild thread while inventorying the client against
the merge train. This is the shape of the fantasy UI work, not a one-off bug.

**The pattern.** Several threads independently reached the same correct
conclusion — a number must say what it rests on — and each added a field to a
server response. None added the rendering. The client has **zero** references to
any of them.

| field | added by | surface | rendered? |
|---|---|---|---|
| `availability_basis`, `availability_note` | #27 | Start/Sit | **yes**, #27 also did the page |
| `availability_basis`, `availability_note` | #21 (`waiver-wire.js`) | waiver board | **yes, PR #43** — chips marked "(assumed)" |
| `availability_basis` on `model_context` | assetUniverse | Trade Lab | **yes, PR #43** — chip plus a fallback line |
| `active_probability` per call | the fit | Start/Sit rows | **yes, PR #43** — the number itself, per row |
| `playoff_rounds`, `playoff_basis` | #40 | playoff/title odds | no — #40 not landed |
| projection basis (weekly vs season-long) | — | playoff/title odds, Trade Lab ranking | no — blocked on `season-sim.js`/`routes/model.js` |

**Closed 2026-09-19 by PR #43** (UI-rebuild thread): the three availability
fields above. What is left is the odds, and it is blocked on file ownership,
not on anyone disagreeing about it.

**Why this keeps happening.** A thread fixing a server-side correctness bug
naturally stops at the response boundary; the field is "done" from where it is
standing. Nobody owns the screen. The result is the project's standing failure
mode in its purest form: the honest data exists and the user cannot see it.

**The rule worth keeping:** a basis field that no page reads has not fixed
anything. When a PR adds one, either render it in the same PR or hand it to
whoever owns that surface. #27 is the model — it added the field *and* the
two-state rendering (a panel with reason/effect/fix when degraded, a quiet line
when fitted).

**Naming is already inconsistent and should be settled before more are added.**
`#27` uses a nested `availability_basis: {basis, missing, stamp}`; `#40` uses a
flat `playoff_basis: 'league_schedule' | 'default_weeks_15_17' | …`. Two shapes
for one idea, and on the season-sim response they would sit side by side.

**The reasoning that justifies all of it**, from #27's own test comment — worth
quoting rather than paraphrasing, because it is the argument:

> a percentage that IS measured and goes unlabelled is the same defect waiting
> for the next time the tables go missing, because the reader has no way to tell
> the two apart from the number alone.

See [[availability-unfitted-positions]] for the case a page-level basis cannot
express at all, and [[availability-fit-before-after]] for which consumers move.
