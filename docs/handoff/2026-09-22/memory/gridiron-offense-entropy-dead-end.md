---
name: gridiron-offense-entropy-dead-end
description: Offense target-distribution entropy does not predict projection error once you control for projection level; do not rebuild it.
metadata:
  type: project
---

Tested 2026-09-22 on 10,755 walk-forward player-weeks (nflverse pbp REG
2022-2025). Method borrowed from Big Data Bowl 2025's Safety Entropy: take
the Shannon entropy of a distribution and aggregate it per team.

Hypothesis: a player in a concentrated offence is more forecastable than one
in an offence that spreads the ball, so the entropy of a team's prior-weeks
target distribution should predict residual spread and earn a narrower
interval.

**It does not.** Raw it looks strong — residual SD falls monotonically from
7.154 to 6.033 across entropy quintiles. That is an artifact: mean projection
falls monotonically too, 9.46 to 7.92, because high-entropy offences simply
have smaller individual players in them. Controlled for projection tercile
the effect nearly vanishes; used as an interval width it moves 80% coverage
from 0.8450 to 0.8442 and the mean width from 16.699 to 16.690.

**Why:** offense entropy is a proxy for projection level, which we already
have and already use.

**How to apply:** do not rebuild this. If a future idea keys off how
concentrated an offence is, check first whether it survives controlling for
the player's own projection — that control killed this one outright. The
generalisation worth keeping is that a monotone bin table is not evidence
until the confounder is held fixed.

Reference numbers and the script: `offense-entropy.json` / `entropy.mjs`,
section 4 of `CALIBRATION-SPEC.md`. Real finding from the same run:
[[gridiron-conditional-calibration-2026-09-22]].
