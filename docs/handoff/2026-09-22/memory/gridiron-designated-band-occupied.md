---
name: gridiron-designated-band-occupied
description: The designated (Questionable/Doubtful/Out) band on Nick's rosters is occupied and priced by hardcoded constants — an nfl_injuries row is not the only way a player gets a designation, and an earlier plan said the band was empty.
metadata:
  type: project
  modified: 2026-09-19T21:28:38.014Z
---

**"No `nfl_injuries` rows" does NOT mean "no designated players".** This
inference was written into the release run sheet and into
[[gridiron-availability-fit]] and it is wrong.

`weekDesignation` (`contingency.js:202-213`) reads the NFL report **and** an
ESPN status, and **ESPN wins when it is more severe**. It synthesises a report
object from the ESPN label even when the NFL row is null. So a roster with zero
`nfl_injuries` rows can be full of designated players.

**Measured against the live app 2026-09-19, not inferred.** Puka Nacua, on
another manager's roster in **all five leagues**:

- `injury_status` `"Questionable (ESPN)"`
- `practice_status` `"Did Not Participate In Practice"`
- `active_probability` **0.324**, against 0.805 for a healthy target
- basis `constants`, stamp `absent|absent`

**The arithmetic pins the code path**, which is what makes it more than an
observation. Constants branch, `contingency.js:679-688`: questionable gives
`Math.min(0.75, Math.max(0.45, active * 0.70))`, which **floors at 0.45**; then
"did not participate" gives `active *= 0.72`. `0.45 * 0.72 = 0.324`, matching
the live reading to three decimals. `fitted.lookup(...)` at `:667` replaces it
wholesale once the availability tables exist.

**0.324 is not a property of Nacua — it is what the constants produce for
questionable plus DNP, and his designation tracks a live ESPN report.** Full
practice gives `Math.max(active, 0.96)`; ruled out gives 0.01. **Re-read his
status immediately before any before/after test rather than carrying 0.324
forward**, or the test silently becomes a question about nothing. It re-anchors
in a line, because it was always about the floor of the questionable band:
take the constants value his *current* status produces, and a drop below it is
still unambiguously the fit. The genuinely invariant control is `basis:
constants` + stamp `absent|absent` + both availability tables missing — no
migration creates them, so only `fit-availability.mjs` can break it.

**How to apply.** Read this player first in any availability-fit dry run.
`current_week_ppg` 4.18 against `adj_ppg` 10.3 is where the change shows
undamped. **Do not predict direction or size** — questionable-plus-DNP could go
either way and the dry run prints it. The same file's comment (`:671-673`)
records that two constants were badly wrong when finally measured: Doubtful set
at 0.15 against a measured 0.004, Out at 0.01 against 0.001.

**Also withdrawn: 0.833 and 0.823 are not injured-player readings.** The capture
script stringified the roster payload's `injury` field and tested it for
emptiness, but `injury` is a 0/1 flag (`trade-engine.js:440`) and `String(0)` is
`"0"`, which is truthy. Every player matched, so the "injured" target was the
next most valuable healthy one. **The tell generalises:** those readings came
back priced *above* the healthy target, which an injured-player reading cannot
produce. A number impossible in the direction it moved is stronger evidence than
one that merely looks off.

**Why this is worth its own file.** A document that says "nothing to land on"
tells the reader not to look, and if the largest effect then lands there, it
reads as noise or goes unnoticed. That is this project's recurring failure mode
arriving through the *documentation* rather than the code — the hardest kind to
catch, because a plan that says where not to look leaves no failing check
behind. Caught by the Trade Brain thread, verified here against the shipping
tree per [[gridiron-cite-the-shipping-tree]].
