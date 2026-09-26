---
name: verify-a-pr-by-content-not-line-number
description: A line number is not evidence a fix landed - lines added above move a call site without changing it, so check a PR by grepping its diff for the symbol, and re-fetch before concluding anything about a head.
metadata:
  type: feedback
---

Learned 02:05-02:25Z 2026-09-20 on gridiron-hq, by getting it wrong and then
getting it right an hour later. Companion to [[gridiron-cite-the-shipping-tree]].

**Why:** the release plan was about to name a PR as the fix that had to merge
before a database write. Naming the wrong one would have authorised the write
on false grounds.

## The trap
A fix was reported for `trade-engine.js:354`. On the pushed head the call had
moved to `:379` — because 25 lines were added **above** it, not because anything
changed. The line was byte-identical to `main`. A line-number check passes here.
A "the PR touches that file" check passes too: the file was touched, four times,
for other reasons.

**The check that works** names the symbol and counts:

```
git fetch origin <branch>
git diff origin/main...FETCH_HEAD -- <file> | grep -c <symbol>
```

Zero means the call site is untouched whatever the line numbers say.

## The second half, which is why the first read was incomplete
An hour later the same branch's head **had** changed (`aca74f9` -> `7c27517`)
and the fix was there. The commits had existed locally the whole time, unpushed,
held back by a push freeze. So: **a negative result dates instantly.** Say
"origin's head at <time> was X and did not contain it", never "the fix does not
exist"; re-fetch before acting on an earlier read.

## And a diff check is not a correctness check
Seeing the argument change proves the call site moved, not that the new value is
right. That needed reading the consumer: the training target, the grading
baseline and the expert list in the called module. Those turned an attributed
claim into a verified one. Do that separately and say which you have.

## How to apply
Verify a PR by content, over a freshly fetched head, and keep "the call site
changed" and "the new behaviour is correct" as two findings, not one.
