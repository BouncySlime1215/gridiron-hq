---
name: gridiron-lineup-ordering-changes
description: "The season-long vs weekly configuration changes WHICH PLAYERS GET STARTED, not just the point value. The 80%/88% rates are WITHDRAWN as rates (Auditor R45): they measure the non-default mean objective. Qualitative finding only; never quote a rate to Nick."
metadata:
  type: project
---
Explorer, 2026-09-22, Auditor R42's order. Package `/mnt/project-files/PACKAGE-LINEUP-ORDERING-2026-09-22.md`, prereg `LINEUP-ORDER-PREREG-2026-09-22.md`, scripts `LINEUP-lineup.mjs` / `LINEUP-lineup-tier.mjs`. Rig only, 2024 weeks 5-18, 28,000 synthetic team-weeks per arm, seed 20260922.

A = `ceiling-lineup.js:62` (`buildProjections` with NO roleRecency). B = `player-week-engine.js:271-273` (+ `WEEKLY_ROLE_RECENCY`).

| metric | pre-registered arm | robustness arm (draft-like pool) |
|---|---:|---:|
| starting-set change rate | **80.19%** | **88.29%** |
| mean players swapped (of 8) | 1.311 | 1.633 |
| FLEX change rate | 56.62% | 59.78% |
| candidate-set change (top 14 of 16) | 37.54% | 47.40% |

Swaps: 0 → 19.81%, 1 → 41.19%, 2 → 28.67%, 3 → 8.84%, 4 → 1.41%, 5 → 0.08%.

**Pre-registered reading 2 fires decisively.** The disagreement is a SELECTION difference, not only a point-value one — the first measurement today showing the configuration reaches a decision.

**My registered weakness was REFUTED by its own robustness check.** I predicted uniform draws would bias the rate UPWARD vs real drafted rosters; the draft-like pool gives a HIGHER rate (88.29% vs 80.19%). Concentrating on startable players makes the configurations disagree more.

**CONFOUND, per Auditor R41:** passing WEEKLY_ROLE_RECENCY moves role memory AND (via `activeKVectorFor`, `shrinkage-fit.js:516`) whether the fitted volume-k is included. Every number is a JOINT effect. Decomposition arm not run.

**`ceilingLineup` was never executed** — `:148` needs a `leagues` row and the rig has 0 leagues / 0 roster_players. Synthetic-roster proxy of its selection step, declared in the prereg before the run. Solver not modelled (greedy-by-mean, `objective: 'mean'`; the `ceiling` objective's draws are a separate axis, deliberately excluded).

**Says nothing about which configuration is right.** [[gridiron-replay-rolerecency-trap]] [[gridiron-replay-config-axes]]

---

## RATE WITHDRAWN, Auditor R45 (2026-09-22 17:02Z) — DO NOT QUOTE A NUMBER TO NICK

R45 accepted the format and the finding, then went past my declared limit. Every
claim below re-verified by Explorer on tree `654ff93`.

**I measured the arm that does not ship.** `ceiling-lineup.js:145` defaults
`objective = 'ceiling'`, and `routes/trades.js:661` routes
`req.query.objective === 'mean' ? 'mean' : 'ceiling'` — the live default is
**ceiling**. The shipped solver is not greedy either: `:185-205` is a
one-substitution-at-a-time local search over `trials = 3000` correlated draws.
My proxy also had no IR filter where `:159-163` removes IR players.

**The ceiling objective's target is SELF-REFERENTIAL, worse than R45 stated.**
`:179-181` sets `effectiveTarget = target ?? r2(naiveScore.ceiling)` where
`naive` is the highest-mean lineup and `:132` defines `ceiling: r2(q(0.90))`.
So the bar is the 90th percentile of a lineup the projections themselves
selected. A configuration change moves the pool AND the bar. (The `@param`
docstring at `:141-142` saying "a stretch above the team's own median" is STALE;
the inline comment at `:177-178` contradicts it and the code is the 0.90
quantile.)

**Therefore 80.19% does not bound the shipped surface in either direction.** It
is not a conservative floor; it is a measurement of a different objective.

**WHAT MAY BE SAID, and it is the part that mattered:** *his ceiling/floor
lineup and his weekly projections disagree, and the disagreement reaches which
players get started.* Qualitative, no rate. R45 records that R44.2/R44.3 never
depended on the rate, so the `ceiling-lineup.js` fix is unaffected.

Re-running on the ceiling objective would pull in the fourth axis (draws-seed)
that this design deliberately excluded; R45 did not ask for it. Specified, not run.

