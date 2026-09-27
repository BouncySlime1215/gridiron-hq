---
name: gridiron-what-is-actually-tested
description: The four parts of Gridiron HQ that are properly tested or properly honest, verified on main at 791b131 — so an audit does not re-litigate them or "fix" them into something worse.
metadata:
  type: project
  modified: 2026-09-20T01:36:26.881Z
---

Verified 2026-09-20 on `origin/main` at **791b131** during the model audit.
Every audit of this repo finds the same weak spots; these are the strong ones,
recorded so they are not re-opened.

- **`ros-projection.js` is the best-supported number in the app.**
  `0.5 × structural + 0.5 × [n/(n+4) × season-to-date + 4/(n+4) × market prior]`,
  fitted by `scripts/fit-ros-projection.mjs` and passed on a **pre-registered**
  gate: 2024 weeks 1-4 MAE 3.83/3.13/2.90/2.91 → 2.47/2.36/2.42/2.51, 2025
  3.58/3.12/2.85/2.79 → 2.37/2.32/2.42/2.44, **12 of 12 checks passed**
  (`ros-projection.js:44-67`). The shipped params are a frozen constant in code
  (`:69`), so they ship regardless of the database. It is 75% of `adj_ppg`.

- **`fantasy-coordinator.js`'s ridge is real ML, walk-forward, honestly
  reported.** Week-clustered Huber ridge over three experts, correlation-based
  family de-duplication, shrinkage by each source's own walk-forward record. It
  beats the plain structural projection in all three testable seasons,
  Holm-corrected, p ≈ 0.0005 each, MAE ≈ 4.28-4.40 vs ≈ 4.41-4.52. Its header
  also records that `boom_bust_signal` shrank to **k = 0** (earned no weight) and
  that a mixture-of-experts regime split was **tested and rejected**. That is the
  discipline to judge the rest by. (It is being added to the wrong base — that is
  a separate defect, [[gridiron-coordinator-wrong-base]] — but the model itself
  is sound.)

- **A layer that goes inert says so, on the page.** `availabilityDegradation`
  (`contingency.js:611`) returns the inert layer, its reason, its effect and its
  fix, and `Lineup.tsx:168-180` renders all four. This is CLAUDE.md's
  "errors are handled or they throw" rule implemented properly, and it is the
  model to copy — the counter-example is
  [[basis-fields-served-never-rendered]].

- **Objectives that disagree are surfaced, not reconciled by fiat.**
  `title-odds-trades.js:112-128` ranks deals by championship odds, compares that
  to the points ranking, and prints which one to ignore: *"Points is a proxy;
  this is the thing it proxies for."* Best piece of design in the trade half.

- **The efficiency half's hand-set k is a REJECTION, not an oversight.**
  `shrinkage-fit.js:465-473` records that the efficiency k from the
  variance-components fitter was substituted and made 2025 worse (4.773 vs
  4.749), "because 'player' is not a stable group for efficiency within a
  season"; `volumeKFits` (`:481`) filters to the six volume pairs on purpose.
  Do not propose fitting efficiency k. The efficiency PRIORS are fine too:
  `projections.js:416-426` pools real player-weeks per position. **The three
  literals beside that k were swept 2026-09-20 and they hold** —
  [[gridiron-efficiency-constants-swept]], which also carries the one thing that
  is open there. **The opening the rejection's own reason leaves**: if a
  player's past rate is a weak estimator of his efficiency, that is exactly when
  an outside signal earns its place — aDOT and air-yards for ypt, CPOE for
  passing, RACR/PACR for receiving conversion, all already columns on
  `player_week_usage`, none read here, nothing graded. That is the one fantasy
  ML build with a prior reason to work, and it needs Nick's word.

Also correct by design, not a bug: retired signals stay retired and stay
visible. Matchup and defence-vs-position multipliers failed their walk-forward
test and are pinned to 1, with the reason travelling on the asset
(`trade-engine.js:340-341`, `:443-444`).

See [[gridiron-model-audit-2026-09-20]].
