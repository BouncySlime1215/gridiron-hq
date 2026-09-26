---
name: gridiron-availability-fit-blast-radius
description: Which Gridiron HQ surfaces the availability fit actually moves, by how much, and which reading to trust when verifying it.
metadata:
  type: project
---

Part of [[gridiron-availability-fit]]. Verified on `origin/main` **791b131**.

Only `contingency.js` reads the two fitted tables, via `fittedAvailability()`.
Eight modules import `weeklyAvailability`: `routes/model.js`, `season-sim.js`,
`trade-engine.js`, `news-fantasy-impact.js`, `role-scenario-engine.js`,
`role-scenario-lab.js`, `player-week-engine.js`, and `contingency.js` itself.

**`player-week-engine.js` is NOT a live consumer.** Its call sits inside
`applyRedistribution`, reached only from `if (redistributeVolume)`. The flag
defaults to **false** (`:262`) and the only caller setting it true is
`scripts/eval-redistribution.mjs`. So the projection engine does not read
availability on any served path, and **the waiver board does not move**.
"This changes the projection engine every fantasy surface is built on" was
wrong (corrected by the Trade Brain thread).

**What does move:** the **asset universe** — trade values, and Start/Sit's
chance-to-play, which reaches it via `assetUniverse` ->
`trade-engine.js:346`/`:359`, not via the projection engine — and the
**season sim** (`season-sim.js:212`, once per simulated week), meaning playoff
and title odds. `trade-engine.js:1317` calls `simulateSeason`, so the trade
horizon inherits the sim effect too. All **with no code deploy and no pull
request behind it** — the hardest kind of change to attribute afterwards.

## Effect size per surface

- **`current_week_ppg` is the clean instrument.** It moves by exactly
  `delta_a / a0` — **36%** for 0.70 -> 0.95 — for every player alike, with no
  dependence on his base rates. Emitted at `trade-engine.js:449`.
- **Trade values move in SINGLE DIGITS.** `:359` multiplies only the
  current-week projection by `active_probability`, and `:385` is
  `decisionPpg = 0.25*currentWeekPpg + 0.75*rosPpg` — `rosPpg` carries no
  availability term. Exact: `0.25*c*delta_a / (0.25*c*a0 + 0.75*r)` =
  **+6.8%** at c=r. Attenuation against `current_week_ppg` is
  `1 + 3r/(c*a0)`, independent of delta_a: **9.6x** at c/r=0.5, **5.3x** at
  c=r, **3.1x** at c/r=2.0. So "about 4x" is one point on a curve.
  (An earlier note said ~9% on value, from the shortcut "a quarter of 36%".
  Wrong: the current-week term is itself pre-multiplied by the LOW
  availability, so it is ~19% of the baseline total, not 25%.)
- **The odds are the sensitive instrument.** The sim applies availability per
  player per remaining week, undamped, so it compounds.

**Trust order when verifying:** the simulate reading, then `current_week_ppg`,
then the trade value. **Only-the-odds-moved is the EXPECTED shape, not a
partial failure.**

## season-sim omits K and DEF entirely

`SCORED` is QB/RB/WR/TE (`season-sim.js:32`); the roster pool is filtered at
`:202`, `lineupPoints` filters again at `:96`, and `:106`
(`if (!SCORED.has(slot)) continue;`) means a league's K and DEF slots
contribute exactly zero to both sides. The omission is symmetric and K/DEF are
low-variance, so the **margin** moves comparatively little; what is
unambiguously wrong is any **projected points total** the sim reports.
Direction of the odds bias is unmeasured — leave it unquantified. The
before/after delta is unaffected: same simulator both sides.

**Three ways the verification can produce a misleading null:** a cached
simulate reading (see [[gridiron-availability-fit-cache-traps]]), an
attenuated trade reading taken as the headline, and an absent designated band
— see [[gridiron-designated-band-occupied]].
