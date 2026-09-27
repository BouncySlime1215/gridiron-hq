---
name: gridiron-cite-the-shipping-tree
description: Never read a line number for the Gridiron HQ deploy off a working tree — and never restate another session's reason in your own words without checking it, because the plausible version you invent is the one nobody re-reads.
metadata:
  type: feedback
  modified: 2026-09-19T21:15:37.158Z
---

**Every line number cited about what the deploy does must be read from the
merged tree, never from a checked-out working tree.**

The release-train branch `claude/release-train-2yv3x6` carries the *plan
document*. Its `server/` is essentially `main`'s — the code that is being
replaced. On 2026-09-19 `contingency.js` was **323 lines there and 1,093 lines
on the proved tree**, so every offset past the first few hundred lines is wrong
by hundreds of lines while still pointing at plausible-looking code.

Read from the tree that ships:

```
git show scratch/release-proof-5:server/services/contingency.js | grep -n ...
```

and after the train lands, from `origin/main`.

**How it actually went wrong.** I grepped my own working tree, got
`weeklyAvailability` at `contingency.js:114` and the K/DEF `0.92` at
`trade-engine.js:181`, and told the coordinator that two other threads —
which had read the merged tree and reported `:885` and `:346` — were "reading
different heads" and had their numbers wrong. They were right. I was about to
overwrite correct line numbers in [[gridiron-availability-fit]] with main's.
Correct values on the shipping tree: `weeklyAvailability` `contingency.js:885`,
position filter `:889`, fallback `:901`; `trade-engine.js:346`;
`season-sim.js:226` with `SCORED` at `:32`; `history()` `projections.js:285`.

**Why it is worth a file.** A wrong line number is worse than a wrong function
name: it sends the reader to real code that looks close enough to be believed,
and it fails silently both ways — grep succeeds, the code reads sensibly,
nothing errors.

**How to apply.** Cite function names in prose and line numbers only alongside
the tree they were read from. Before writing any `file.js:NNN` into a runbook
or a deploy sheet, confirm the file's line count matches the shipping tree. When
another session's number disagrees with yours, check which tree each of you read
*before* asserting one is stale — the one with the larger file is usually the
merged one.

## The same mistake in its second form: a restated *reason*

A line number sends the reader to the wrong code. **A restated mechanism sends
them to the wrong kind of failure**, which is worse, because the kind decides
whether anyone looks.

2026-09-20, twice in one night. Told by relay that `#60` had to merge after
`#57`, I wrote the reason in my own words as "its call sites would not compile
against today's `main`". Checked afterwards: `tradeWeekContext()` takes **no
parameters** (`trade-engine.js:172`, `791b131`), so `tradeWeekContext(lg)` is
valid JavaScript that **discards the argument**. It compiles, lints and
typechecks; the league is silently ignored and every league gets the NFL's week.
Only three of that PR's own tests catch it.

**I had turned a ships-wrong failure into a won't-start failure** — in a runbook
whose purpose is naming the failures that look like nothing. The same hour, the
same shape: a relayed claim that two writers both held a long transaction, where
one of them (`nfl-event-archive.js:150-199`) has **no `BEGIN` anywhere in the
file** and autocommits per row, which blocks harder and locks nothing.

**How to apply.** When you restate someone else's reason in your own words, the
restatement carries your name and needs your check — a relay's one line is a
pointer, not a citation. And when you find yourself reaching for "it wouldn't
build" or "it would error", ask whether the code would in fact be *happy*: the
safe-sounding mechanism is the one to distrust, in a codebase whose recurring
failure is [[gridiron-release-train-2026-09-19]]'s healthy-looking and not
working.
