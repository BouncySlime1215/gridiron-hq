---
name: gridiron-pr-body-numbers-must-be-rebuildable
description: Three PR bodies in the o3wt2p stack carried figures that could not be rebuilt from the output that survives; the rule and the correction form that came out of it.
metadata:
  type: feedback
---

**The rule.** A number in a PR body, an evidence file or a thread reply has to
be rebuildable from something that still exists — a file, a command, a sha. A
figure that lives only in an earlier message's prose is not a reading, however
confidently it was written. This is Nick's five questions applied to our own
writing: *is this based on stats or is it made up, and how do we know.*

**Three cases found on 2026-09-20**, all in this thread's own PRs:

- **#59** claimed "seven consecutive lives" and then listed six values
  (95, 97, 93, 91, 94, 88). Neither the count nor the values can be rebuilt from
  the surviving probe.
- **#56** quoted a live transcript containing `uptime 12` at 22:19:00,
  `uptime 18` at 22:21:49 and `uptime 97` at 22:23:28. None of those three rows
  appear in the surviving probe output, and the timestamps of the rest are a few
  seconds out. Its derived summary ("about 100 seconds, dark for about 60,
  starts roughly 160 seconds apart") was likewise not computed from it.
- **#63** claimed a full suite of 2979; the head `64f3ef2` measures 2980.

**What the probe actually shows** (`/tmp/claude-0/uptime-poll.txt`, 40 polls
22:16:24Z-22:32:40Z, 25 answered): six lives, last `uptime_s` per life
93, 95, 104, 86, 95, 85; consecutive boots 167, 174, 169, 166 s apart;
73, 70, 83, 71 s between a life's last answer and the next boot. The first
interval, 253 s, is excluded — its dark stretch could hide a whole life.

**Two counting traps, both from the release thread (2026-09-20).**
`fly.toml` sets `grace_period = "60s"`, so a fresh machine is not in the routing
pool and the edge has nothing to route to — **a no-response inside the first 60
seconds of a life is not evidence of blocking**, and #49 takes that window to
five minutes. So publish *last answer of a life to the next life's boot*
(73, 70, 83, 71 s here), which is grace-independent, not *last answer to next
answer* (95, 96, 95, 95 s), which is partly a measurement of `fly.toml`.
Second: the release thread's passive health logs hold reads answered at 104, 106
and **116** seconds of age, the 116 in 0.34 s. That and the 104 in the probe
above agree from two instruments that were not looking for each other: **the app
has served past a hundred seconds of age**, so the onset is later and more
variable than any flat "blocks at 90 seconds" bracket. Publish the weaker claim.

**Counting rule that makes those numbers reproducible:** a restart is where
`uptime_s` **drops**, not where a probe goes dark. A blocked loop stops
answering and answers again inside the same life, so counting dark reads
overcounts. Boot is estimated as a read's timestamp minus its own `uptime_s`.

**The correction form.** Edit the body in place (a body edit notifies nobody, so
it is allowed even under [[gridiron-github-hard-freeze-2026-09-20]]), put the
rebuildable figures in the prose, and add a blockquote headed
**"Correction, <date>"** naming what it previously said, why it was pulled, and
whether the change itself is affected. Never quietly overwrite. State only what
is provable: that figures cannot be reproduced is certain; where they came from
is not, so do not accuse.

**Also state which tree a suite number belongs to.** #61's head is docs-only
against its code tip, verified not assumed: `scripts/lint.mjs` walks only
`server/`, `scripts/`, `test/` and only `.js`/`.mjs`; the test glob is
`test/*.test.js`; tsc and the vite build never reach `docs/`; every `docs/tdd`
string in the repo is inside a comment, with no `readFile`, `readdir`, `import`
or glob against it.

**Re-measured 2026-09-20, all green, `npm test` exit 0:**
#56 `63ca21e` 2956/2915/0/41 · #59 `b5b74b5` 2966/2925/0/41 ·
#61 `a986f37` 2975/2934/0/41 · #63 `64f3ef2` 2980/2939/0/41.

Pairs with [[gridiron-failure-modes]].
