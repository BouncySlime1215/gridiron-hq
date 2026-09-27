---
name: detecting-branch-vs-deployed-drift
description: How to tell that a running build differs from the branch you are reading — compare the live response's KEY SET against the source's response literal, and never conflate an absent key with a null one.
metadata:
  type: feedback
  modified: 2026-09-19T20:05:00.000Z
---

Found while auditing Gridiron HQ on 2026-09-19, when every code citation was
accurate for the branch and several were wrong about the live app.

**The technique.** Compare a live JSON response's **key set** against the keys
the source's response literal constructs. Not the values — values drift for a
hundred legitimate reasons. A **missing key is structural**: the running code
cannot be the code you are reading.

The worked case: `GET /api/trades/1/lineup` returned `availability_basis` and
did not return `availability_note`. Both are set in the same object literal,
`lineup-brain.js:585` and `:588`. A response carrying 585 and not 588 cannot
come from that source. That was the only hard evidence anyone produced about
what was actually deployed.

**The detail that makes or breaks it: distinguish "key absent" from "key
present and null."** `d.get('x')` returns `None` for both in Python, and
`d?.x` is `undefined` for both in JS. I first reported `availability_note:
null` and spent an hour concluding a function was returning null, when the key
was never emitted at all. Use `'x' in d`, or dump the whole key set. The
distinction is invisible in the obvious formulation.

**What it does NOT tell you.** It says the deployed file predates the line that
adds the key. It does **not** locate the deploy point in the commit graph. I
asserted "the build sits inside `cfa0e6f`" and that was wrong — a build is at a
commit, not partway through one — and squashed commits compress the upstream
history an image was actually built from, so the image may not correspond to
any commit you can see. Only a filesystem read on the machine settles it.

**Related trap, same audit:** tracing what reads a database table by grepping
the **table name** found 2 readers; grepping the **consumer function names**
found 8, including the shared projection engine. Fan-out usually happens one
function deep inside a module whose name gives no hint. See
[[gridiron-availability-fit]] and [[gridiron-deployed-build-bracket]].
