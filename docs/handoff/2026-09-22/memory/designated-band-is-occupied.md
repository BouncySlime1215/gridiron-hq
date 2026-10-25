---
name: designated-band-is-occupied
description: The availability fit's designated band DOES have a live target tonight — Puka Nacua at 0.324 under constants in all five leagues — correcting a release-thread claim that zero nfl_injuries rows meant nothing to land on.
metadata:
  type: project
---

Measured against the live app 2026-09-19 20:46Z, five leagues.

**The claim that was wrong.** That "no player carries an `nfl_injuries` row, so
the designated band has nothing to land on". The premise may hold; the
conclusion does not. `weekDesignation` (`contingency.js:202-213`) reads the NFL
report AND ESPN's status, takes ESPN's when more severe, and **synthesises a
report object from the ESPN label even when `report` is null**. So a roster with
zero `nfl_injuries` rows can still be full of designated players.

**The evidence.** Puka Nacua, on another manager's roster in all five leagues:
`injury_status` `"Questionable (ESPN)"`, `practice_status` `"Did Not Participate
In Practice"`, `active_probability` **0.324** against 0.805 for the healthy
target, basis `constants`, stamp `absent|absent`.

**The arithmetic pins the code path**, which is what makes this proof rather
than observation. Constants branch, `contingency.js:679-688`: questionable gives
`Math.min(0.75, Math.max(0.45, active * 0.70))`, flooring at 0.45; then "did not
participate" gives `active *= 0.72`. 0.45 x 0.72 = 0.324, matching the live
number to three decimals. After the fit, `fitted.lookup(...)` at `:668` replaces
it with a measured rate.

**Why it mattered.** A run sheet saying "nothing to land on" is an instruction
not to look — this project's standing failure mode written into the plan. The
replacement: read Nacua first in the dry run, and read `current_week_ppg` (4.18
against an `adj_ppg` of 10.3), where the change shows undamped. Direction is now
known (see [[start-sit-warnings-are-priors]]): the designated band is the only
one that moves DOWN. Magnitude belongs to the dry run.

**The exact reachable set, by enumeration over the whole prior range:** the
questionable path yields **[0.324, 0.693]**, plus the single value **0.96** when
practice is FULL (`Math.max(active, 0.96)` in the practice block, which fires for
questionable since it excludes only doubtful). So the unreachable gap is
**(0.693, 0.96)**.

**Never shorten this to "questionable implies <= 0.70".** It is wrong twice:
wrong bound, and 0.96 is reachable. Three sessions stated this bound and the
first two were wrong, which is worth noticing about the bound rather than about
them — it has an INPUT clamp and an OUTPUT clamp 58 lines apart with different
constants. The output clamp at `contingency.js:696`
(`Math.min(0.995, active)`) is applied to the RETURN and does not bound the
intermediate `active * 0.70`. The bound that does is the prior: `prior` is
`base.get(p.id)?.available ?? 0.92` (`:901`) and `available` is
`Math.max(0.05, Math.min(0.99, rate * penalty))` (`:80`), so `active` enters the
branch at **0.99 or below** and 0.99 x 0.70 = **0.693**.

**0.324 is the FLOOR of that set, and it is exactly Nacua's reading.**
`Math.max(0.45, ...)` bottoms out at 0.45 and DNP multiplies by 0.72. So there is
no constants path that can produce a lower number for him: "Nacua drops below
0.324" is a check the current code STRUCTURALLY CANNOT SATISFY, and any drop at
all is unambiguously the fit. A check with no plausible false positive, which is
the opposite of tonight's usual problem (readings that look like nothing
happened).

The file says it plainly at `:620-625`: constants are "a hand-set constant and a
career durability prior, not a measured rate", and pooled is "a known-low
placeholder, not as a reason to sit anybody".

Expected movements and the countable check are in
[[start-sit-warnings-are-priors]].

See [[availability-fit-attribution-map]] and [[availability-fit-before-after]].
