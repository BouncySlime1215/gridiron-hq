---
name: start-sit-warnings-are-priors
description: Nick's own Start/Sit warnings are durability priors, not injuries — and the availability fit should make most of them disappear while pushing the one real designation down. A countable pre-fit check.
metadata:
  type: project
---

Measured against the live app 2026-09-19 20:46Z (pre-deploy), all five leagues.

**Thirteen Start/Sit warnings on Nick's OWN rosters**, basis `constants`:
L1 Achane 74%, Kyren Williams 70%, Javonte Williams 75%. L2 Fannin Jr. 64%,
Chase Brown 75%. L3 Jayden Daniels 57%, Achane 74%, Brown 75%, Bucky Irving 65%.
L4 Daniels 57%, Jonathan Taylor 74%, Tyler Warren 67%. L5 Taylor 74%. Counts per
league: **3 / 2 / 4 / 3 / 1**. QB, RB, TE and FLEX starters — the surface he
actually opens.

**They are mostly NOT injuries.** `active` starts as the durability prior
(`contingency.js:637`). The questionable branch is
`Math.min(0.75, Math.max(0.45, active * 0.70))`, and since `active` is a
probability, `active * 0.70` can never exceed 0.697 — **the 0.75 cap can never
bind, so no reading above 0.697 can come from the questionable path**. That
rules it out for 0.70, 0.74 and 0.75 outright. Those are durability priors on
players with no report. 0.57/0.64/0.65/0.67 are reachable via questionable only
with an implausibly high prior; unresolved without a per-player read, which the
capture does not store (it keeps only a digest of `/rosters`).

The exact reachable set of the questionable path, why its bound is so easy to
state wrongly, and what Nacua's 0.324 floor means are all in
[[designated-band-is-occupied]]. Short version: 0.70, 0.74 and 0.75 are outside
it.


**Two OPPOSITE movements are expected in the same dry run**, both on his screen.
Documented in the repo, not inferred:
- `contingency.js:652-657`, role path validation: healthy starters "actually
  played 94.5%; the old path said 0.708, this 0.952". So healthy-prior players
  move UP hard and **most of the thirteen warnings should disappear**.
- `lineup-brain.js:628-633`: the fit "overstates it most for exactly the players
  carrying a designation — the band where the fit moves furthest, and the only
  one that moves DOWN". So Puka Nacua moves DOWN from 0.324.

**The countable check:** warning counts 3 / 2 / 4 / 3 / 1 and Nacua at 0.324
before the fit. If the counts do not fall and Nacua does not drop, the role
rates did not land — that is a failure, not a quiet success.

**Capture ordering, from the release thread (their finding, verified by them
against the memo keys):** take the mid-window capture **after the step 8
restart, not before**. A restart re-runs `bootJobs` and refreshes
`nfl_injuries`, which moves the very numbers being measured — so a capture taken
before it is a baseline for a process that no longer exists. The fit itself
needs no restart (`fittedAvailability` self-invalidates and the simulate memo
key carries the seed); the shrinkage promotion does, because the `proj:` and
`player-week:` keys at `routes/model.js:404`, `:426`, `:443` do not.

See [[designated-band-is-occupied]] and [[availability-fit-attribution-map]].
