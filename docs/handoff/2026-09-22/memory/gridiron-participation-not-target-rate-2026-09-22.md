---
name: gridiron-participation-not-target-rate-2026-09-22
description: Target share's stability is playing time, not target rate — snap share ICC 0.616 vs 0.276 for targets-once-on-field; a perfect snap forecast is worth 0.34 targets/week and projections.js has no participation term.
metadata:
  type: project
---

Measured 2026-09-22, nflverse pbp + participation, REG 2022-2025, 22,740
player-weeks built and 15,447 predicted. Spec `ONFIELD-SPEC.md`, scripts
`of-build.mjs` / `of-test.mjs` / `of-ci.mjs`.

**The decomposition.** `participation.offense_players` lists all eleven
offensive players on every play (non-blank on 100% of 2024 rows), so a
player's own denominator — pass plays he was ON THE FIELD for — is free.
Mean 16.9 on-field pass plays a week against 35.6 team attempts: **the average
pass-catcher is on the field for under half the attempts he is charged with.**

**Where the stability lives** (Searle one-way ICC, player-season, 1,061
players, N=13,226):

| quantity | ICC |
|---|---:|
| **snap share** (on-field plays / team attempts) | **0.6157** |
| target share (targets / team attempts) — what the model uses | 0.4985 |
| target rate once on the field | 0.2760 |

So "usage repeats" is really **participation repeats**. The rate at which a
player is targeted once he is out there is nearly as noisy as efficiency.

**The prize, and why it is out of reach today.** Paired bootstrap clustered on
player, n=15,447, in targets of weekly MAE:
- Denominator KNOWN: on-field share beats naive targets/week by **−0.344**
  [−0.373, −0.323] and beats team-attempt share by −0.223. That is a CEILING —
  nobody knows next week's snaps.
- Denominator forecast from the last 3 weeks: on-field share vs naive is
  **+0.0024 [−0.0114, +0.0114], indistinguishable.** The binding constraint is
  FORECASTING participation, not choosing the denominator.

**PARTLY REVISED 2026-09-22 by [[gridiron-injury-report-forecasts-snaps-2026-09-22]].**
"A realistic forecast captures none of it" was an artifact of MY sample: these
rows required >=1 on-field pass play, deleting every week a player MISSED —
exactly what an injury report predicts. Add the absences back and the free
nflverse injury report captures **21% of the ceiling**. The binding-constraint
finding stands; the pessimism about forecasting it does not.

**Do NOT swap the denominator. Build the snap-share forecast.** `nfl_snaps` is
already ingested (`nfl-advanced.js:174-192`) and read by availability,
contingency, role-scenario and the feature store — but `projections.js` has NO
participation term for skill players: availability is game-granular
(`:611-630`) and only QBs get a within-game refinement (`:652-669`). The gate
is whether a snap forecast beats the last-3-weeks baseline above.

**Do not repeat as a defect report:** with a realistic volume forecast my
simplified team-share stand-in is significantly worse than naive
(+0.0133 [+0.0034, +0.0201]). The repo's real share is shrunk and
multi-season, and its ensemble already weights season_to_date 0.40 against the
structural head 0.20 — so this is consistent with, and arguably explains, those
weights.

**Biggest measurement flaw:** on the field is not running a route; a TE can be
present and blocking. Participation's `route` is only the targeted receiver's.

**Also settled while screening WADE:** nflverse pbp carries `cp`, `cpoe`,
`xpass`, `pass_oe`, `xyac_mean_yardage` and `nfl-pbp.js:275-282, 357, 444-449`
already ingests them, so catch-probability-over-expected needs no package.

Related: [[zero-is-not-missing-in-participation]] (the special-teams trap this
build had to avoid), [[gridiron-yards-per-target-is-noise]].
