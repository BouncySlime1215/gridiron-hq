---
name: gridiron-state-1244-2026-09-22
description: "17:02Z-17:05Z eighth batch: Auditor R45 — Explorer's lineup submission ACCEPTED, R42.2 gate passed, but NO RATE GOES TO NICK (80.19% measured 'mean' while live default is 'ceiling'); second correction posted 17:05Z; production() helper = NAMED CONFIGURATION MARKER, not required argument; 19 files vs 24 sites reconciled; fit-weekly-coverage.mjs:227 upgraded to a follow-up; two UI follow-ups"
metadata:
  type: project
  modified: 2026-09-22T17:06:30.000Z
---
- **Auditor R45 17:02Z** (§R45, `audit-unitA-and-ceiling-bracket-2026-09-22.md`): Explorer's lineup submission **ACCEPTED, R42.2 gate PASSED, fix unchanged.** **NO RATE GOES TO NICK:** 80.19% measured the 'mean' objective while the live default is **'ceiling'** (`ceiling-lineup.js:145`, `routes/trades.js:661`); the solver is a one-substitution local search on `hit_probability` at 3,000 draws (`:185-205`); the target is self-referential (`:141-142`) → the rate is not bounded in either direction. **Second correction to Nick POSTED 17:05Z** (80% withdrawn as a number; the qualitative finding stands). Rule addendum: corrections to Nick are sent, never silently swapped [[gridiron-gate-evidence-before-nick-rule]].
- **RULED: NAMED CONFIGURATION MARKER** (not a required argument) for the `production()` helper; the eight legitimate sites declare their configuration. Relayed to Fantasy plan 17:05Z — **supersedes its required-argument / STRUCTURAL_ONLY choice** in [[gridiron-state-1237-2026-09-22]].
- **Count reconciliation (§R45.5):** Auditor's 19 = FILES, Explorer's 24 = call SITES incl. its own script; both right.
- **`fit-weekly-coverage.mjs:227` UPGRADED to a follow-up:** the coverage gate runs at 200 draws vs production 2,000; re-run at production draws or state the Monte Carlo component (its header `:29-31` says a draw change = a new gate). `promote-early-week-weights.mjs:369` just recorded.
- **Two UI follow-ups after the ceiling-lineup fix:** the self-referential target; evidence must include the IR filter `:159-163`.
- **Explorer's order:** third-mislabel check (`readdesign.mjs:84` frozen weights) → production re-read in configuration B.
Prev [[gridiron-state-1243-2026-09-22]]. Next [[gridiron-state-1245-2026-09-22]].
