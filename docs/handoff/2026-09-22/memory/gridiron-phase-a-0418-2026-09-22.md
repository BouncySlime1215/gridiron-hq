---
name: gridiron-phase-a-0418-2026-09-22
description: Detail for 04:16-04:18Z checkpoint cycle (Model audit, Fantasy plan, UI, R&D packages).
metadata:
  type: project
  modified: 2026-09-22T04:38:15.713Z
---

**Model audit**: 4th feature(depth-chart) DECLINED @6f4f6ba3. Root cause: model=98.9% of perfect-hindsight oracle(season-mean/player, leave-1-wk-out); headroom for ANY player-descriptive feature=only +0.0037 R2/+0.0895 MAE. Variance decomp: between-player 45.48%, within-player(wk-to-wk) 54.52%=irreducible by player-level feats. All 4 declined feats competed for same 0.0895 MAE pool(depth 3.5%, route-share 0.9%, practice 0.8%, red-zone 0.4%). Next rec: OL-vs-DL matchup(wk-specific, not player-descriptive; last live item of Nick's 7)→then teammate availability→opponent-adj pace. Evidence: docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md @6f4f6ba3(local, atop 25c3b3cf/70f36bea/0176b575/295318ce/6d800784/f4f6c7bd; remote hold 5b809c0). Reported to Nick 04:18Z + product-shape Q(point-projection vs CI display, given 54.5% irreducible var). Awaiting his call.

**Fantasy plan**: real ESPN field paths found for waiver_type/FAAB/trade_deadline(settings.acquisitionSettings.acquisitionType; .acquisitionBudget gated by .isUsingAcquisitionBudget; settings.tradeSettings.deadlineDate epoch ms, 0=none) via cwendt94/espn-api+captured payload — corrects earlier wrong "no known mapping" claim. GREEN @ccca336, local only, branch effk. Routed to Google sign-in thread for routes/leagues.js.

**UI**: coordinator-approved local-only RED/GREEN fix, lineup-posture.js:360-361 — "K/DEF excluded" label wrong once BENCH/IR count toward roster_positions length; fix computes denominator=starting slots only, names actual excluded. No push authorized, local commit only.

**Data/techniques R&D**: 2 packages delivered to new "R&D integration & cleanup" thread: (1) nfl_route_splits via nflsavant.com open JSON API(free, no key, gsis_id-keyed, 100/100 2024 + 92/92 2025 receivers resolved); (2) per-metric signal-reliability measurement via repo's shrinkage-fit.js showing role/targets ~15x more reliable wk-to-wk than catch%/cushion. R&D self-set timer to keep exploring unprompted. Still blocked on Nick's Kaggle login(5min, BDB2025+2026 rules accept) for true routes-run ground truth — asked directly + relayed to Nick 04:13Z.

**R&D integration & cleanup**(new thread): intake gate written(docs/RD-HANDOFF-CONTRACT.md, local @23fdfaa, branch claude/project-thread-2oztzw), npm ci clean, now processing the 2 incoming packages above.

**Correction (2026-09-22):** the 45.48%/54.52% split above is a RAW variance share, biased upward — ANOVA-corrected signal share is 38.54% (29.30% at R&D's population, reconciling their 26%). Cite 45.48% as "raw share" only. Ceiling conclusion (98.9% of oracle) UNAFFECTED. Full detail: [[gridiron-weekly-ceiling-2026-09-22]].

Trade Brain/Release/Wiring map/Scheduler/Feature audit/Opportunity/Chat sync/Coach: no change since last checkpoint (not re-interrogated this cycle per check-in rule).
