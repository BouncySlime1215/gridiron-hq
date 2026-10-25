---
name: a-guard-undone-by-a-later-line
description: Adding a tableExists guard does not fix a silent-absence bug if a later line overwrites the field the guard set with a sentence that presumes the read happened — found in trade-tactics.js after the guard was already in.
metadata:
  type: feedback
  modified: 2026-09-22T02:03:52.924Z
---

**The rule.** A guard at the READ is not enough when a later line writes a
sentence that presumes the read happened. After adding a `tableExists` guard,
grep for every later assignment to the fields the guard sets, in the same
function and in anything it hands the object to.

**Why: measured on Gridiron HQ, 2026-09-22, in `server/services/trade-tactics.js`.**
Two `catch { tx = []; }` blocks around `league_transactions_raw` turned "the
collector has never run on this machine" into `decisions_n: 0` with a null reason
— a claim that we looked at a person and he has never decided anything,
manufactured out of a missing table. The audit thread found those two catches and
was right. Replacing them with the guard `manager-signals.js:167` uses, and having
`blank()` carry the absence sentence, looked like the whole fix.

It was not. Thirty lines further on, the min_n branch unconditionally overwrote
the field:

```js
entry.decisions_reason = `rests on ${lat.length} of the ${MIN_D} decided offers needed `
  + 'before a response time means anything'
```

On a machine with no collector run that re-manufactures the identical false claim,
one loop after the guard removed it. Both min_n sentences now run only when the
store was actually read (`} else if (txPresent) {`).

**The narrower rule inside it: a min_n sentence is only honest about a sample that
was TAKEN.** "Rests on 0 of the 3 needed" asserts a count was made. Where nothing
was counted, the honest field is the absence, not a zero with a threshold beside
it.

**How to apply.**
- Guarding and removing a bare catch are two different fixes. The guard handles
  the one absence you may continue past; removing the catch is what lets a
  programming error (a renamed column, a typo) THROW instead of arriving as
  data. Test both: drop the table for the first, rename a column for the second.
- A test suite that always runs with the table present cannot catch any of this.
  In the case above, thirty-two existing tests all created the fixture table, so
  none of them could fail. Say that, rather than reporting the coverage count.
- When an audit marks a file `silently_broken`, treat the named line as the entry
  point and not the extent.

**Related.** [[unreachable-branch-no-assertion]] — the fixture cannot reach the
branch; here the fixture never reaches the state. [[gridiron-a-prior-must-say-so-where-it-is-read]]
is the same ethic one layer up. [[a-grep-finds-a-pattern-not-a-shape]] is the
search-side twin: the pattern is greppable, the shape is not.
