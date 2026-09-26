---
name: gridiron-feature-audit-findings-f1-f4
description: The four findings the feature-audit thread raised after its first six branches on 2026-09-20 — the coordinator base (F1), the season horizon (F2), the unbuilt availability term (F3), and the waiver confidence (F4).
metadata:
  type: project
  modified: 2026-09-20T02:35:00.000Z
---

Raised by the feature-audit thread (cse_01XL5WQkomfhtJ925G1wZ9yr) after its first
six branches; all landed on EXISTING PRs, per the 01:31Z no-new-PRs rule. Branch
heads and the rest of the thread's work: [[feature-audit-shipped-prs-55-57]].

**The three findings added after the first six branches, all on existing PRs:**

- **F1 (#57, `f2ac614`) — the big one.** `assetUniverse` passed the ENSEMBLE as
  `coordinateFantasy`'s base, but the correction is a residual from the
  STRUCTURAL head by construction (`fantasy-coordinator.js:324`) and by grading
  (`:519`). So production served `ensemble + correction`, a sum never graded, and
  it double-counts: one of the three experts IS `ensemble_shift`
  (`ppg - structural_ppg`, `:33-34`). Measured exposure: **352 of 1,169 startable
  players carry a non-zero shift, mean 2.09, p90 5.21, max 13.75.** Now a named
  `coordinatorBase()`. **Must merge BEFORE `fly secrets set AUTO_HEAVY_SYNC=1`**
  — `fantasy_coordinator_refit` is heavy tier (`scheduler.js:1339`), heavy is
  empty unless the var is `'1'` (`:1759`), so the first refit after that command
  trains against whatever base is on main. The same seam is wrong the other way
  at `fantasy-coordinator.js:571` — **the fantasy plan thread's file**, routed,
  independent, merges either order.
- **F2 (#57, `570cc30`).** `season_delta = ppg_delta * 17` — an NFL season, not
  what is left of one. Now `weeksLeftFor(lg, week)` off `leagueSchedule`. Null,
  not a fallback, when no horizon is given. Serves `season_delta_weeks` beside
  it. Copy fixes routed, not taken: `TradeCard.tsx:109` (UI thread) and
  `routes/trades.js:1055` (no listed editor) both still say "over the season".
- **F4 (#62, `30a16f8`).** `accept_probability: 0.9` was a literal published as
  the Decision Inbox's `confidence`, the same column the trade publisher fills
  with a FITTED `headline.p_right` (`trade-engine.js:2874`). Different quantities:
  "is this right" vs "will someone claim him first". Now one `CLAIM_FRICTION`
  constant behind both served numbers, the basis on the wire **in two shapes**
  (a `'hand-set'` token per row to branch on, the sentence once on the payload
  beside `not_modelled`/`scored_on`), and `confidence: null` on the inbox item.
  The two-shape split follows this file's OWN rule, stated at its `vegas` field:
  a note on every row trains a reader to skip it. The first draft put the whole
  sentence on every row; injections f4f and f4g now pin the split from both
  sides. Safe because **`/api/decision-inbox` has no client reader at all** —
  [[gridiron-server-surfaces-with-no-client-reader]].

**F3 was NOT built** — it needs a new model, so it needs Nick's word. Proposal
sent to the coordinator. It also carried a correction of my own claim:
`adj_ppg` does **not** set a trade's price (`value` comes from the market map,
`trade-engine.js:419`); it is `bestLineup`'s default key (`:611`), so it drives
the lineup solve, `ppg_delta` and `season_delta`. Gap: `currentWeekPpg` carries
`activeProbability`, `rosPpg` (`:367`) carries none, and the binary
season-ending flag catches only the extreme case — the graded middle is
unguarded.
