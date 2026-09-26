---
name: gridiron-fourth-down-ui-workaround
description: UI's interim local workaround for football-context.js's fourth-down trait line while the consumer swap is blocked on the producer fix's push.
metadata:
  type: project
  modified: 2026-09-22T05:16:53.305Z
---

Linked from [[gridiron-fourth-down-consumer-routing-2026-09-22]] and
[[fourth-down-rate-unit-mismatch]].

**2026-09-22 ~05:15Z:** the football-context.js:195 swap (from
`off_fourth_down_rate` to `off_fourth_down_go_rate`) is blocked pending
the producer fix being pushed to a fetchable remote branch — see
[[gridiron-fourth-down-consumer-routing-2026-09-22]] for why.

Rather than wait on the swap, UI is relabeling the trait line locally to
describe the quantity `off_fourth_down_rate` actually measures
(conversion rate) instead of aggression/go-rate, under its own RED/GREEN.
This is an in-progress workaround, not the real fix — it changes the copy
to be accurate about what's being measured today, but does not add the
new go-rate field or resolve the underlying consumer-routing swap. Once
the producer field is confirmed live, football-context.js still needs the
full swap described in [[gridiron-fourth-down-consumer-routing-2026-09-22]].

**Status as of ~05:15Z:** in progress, no RED/GREEN commit hashes
recorded yet in this memory.
