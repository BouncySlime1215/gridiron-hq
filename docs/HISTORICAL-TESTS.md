# Historical tests — every hypothesis run against real data, and its verdict

**Check this file before building a "new" signal, model, or bet-sizing rule.** Everything
below already happened: a specific idea was specified (often preregistered before the code
was written, to stop the analysis from being tuned to its own answer), run against real
historical data, and reached a stated verdict. Most verdicts are negative — that is the
normal, honest result of testing plausible ideas against a market that is already hard to
beat, not a sign the project is broken. Re-testing an idea below from scratch typically
reproduces the same null and costs a day; the one place a real (small) edge was found —
opener-CLV, 2026-09-16 — is a better place to extend than to reinvent.

Live model status is a separate question from this ledger — see
[docs/betting-model/registry/MODEL-REGISTRY.csv](betting-model/registry/MODEL-REGISTRY.csv)
and [docs/reference/architecture/wiring-map.md](reference/architecture/wiring-map.md) for
what is actually wired into the running app.

---

## 2026-09-16 — the opener/model-lab sweep (one day, ~20 preregistered tests)

Raw evidence: `docs/evidence/2026-09-16/{model-lab,opener-lab,opener-clv,opener-clv-v15,opener-clv-v15t,opener-repair}/`

| Commit | Test | Verdict |
|---|---|---|
| `baa069f` → `85f2544` → `b065ef2` → `05847d2` | Opener-CLV: is there real closing-line value at the opening line? | **Yes — the one positive finding of the day.** A small, real, one-signal edge at the opening line; profitable as a flat bet at sub-vig prices. See `opener-clv/summary.md` and `summary-2022-2023-2024.md`. |
| `8034756` | Seven attack-vector tests on the opener-CLV finding (#11,#7,#8,#2,#3,#6,#5) — trying to break it | 7 of 17 comparisons survive Holm correction; **one stated hypothesis falsified**. See `opener-clv/seven-attack-tests-results.json`. |
| `7e4d6f9` | Confidence meta-model: can the system tell *when* it's more likely to be right? | **No — preregistered null.** Matches the standing project note: confidence tiers have now failed on clean data in multiple independent passes. See `opener-clv/confidence-meta-model.json`. |
| `11c1e63` → `d7ad961` | Multi-channel Kalman filter on line movement | Strongest raw development signal of the day, but **fails the 2025 holdout and the CLV+Kelly scorecard** — do not ship. See `model-lab/kmulti-fit.json`, `kmulti-holdout.json`. |
| `401e466` → `30a968a` | Model lab: score every existing forecaster for a preregistered edge or usable confidence tier | **No edge and no usable confidence tier, across every forecaster tested.** See `model-lab/results.json`, `results-wired.json`, `results-wired2.json`, `results-kmulti.json`. |
| `21e7794` → `90d0fa8` | Opener lab: where are openers wrong, what predicts the move, when does it move | Move direction is **predictable at the open but not profitable**; Kalshi may lead the sportsbooks. See `opener-lab/level1.json`–`level3.json`, `table.jsonl`. |
| `b8a694d` → `c51a779` → `ffb7388` | "Data wiring": walk-forward-score six previously-unwired datasets (player, season, preseason, luck, W1–W13) as forecasters | **No survivors in either batch.** Also caught and fixed a Rams team-week de-dupe bug (fit v16) along the way. See `model-lab/` fit/result files for those weeks. |
| `a8d587e` | Exploratory totals deep dive | Signal concentrates in mid-range totals and early weeks; **no Polymarket totals lead** found. See `model-lab/totals-deepdive.json`. |
| `c120c6a` | Totals deep dive 2 — follow-up on the above | Signal is just open-to-close **line prediction**, redundant across channels, **~0 expected growth**. See `model-lab/totals-deepdive2.json`. |
| `0b85f7f` | Build one CLV+Kelly scorecard to grade *every* strategy the same way (closing value, EV at real prices, Kelly growth) | Shipped as the standing grading harness — this is what the Kalman and other model-lab results above are graded against. See `model-lab/clv-kelly-scorecard.csv/.json`. |
| `dc300ae` | Repair Pinnacle placeholder openers (they were synthetic, not real book data) | On the real, cleaned openers, **the 2025 edge and the "confident pick" tier both vanish** — the earlier apparent edge was an artifact of the placeholder data. See `opener-repair/repaired-openers.json`, `regrade-results.json`. |
| `c94abc1` | Investigate an apparent per-season ATS (against-the-spread) decline | **It's noise** — the question is below the data's statistical resolution to answer either way. |
| `e338664` | Point-in-time admission guard | Exposed a **2025 "clock collapse"** bug (future data leaking as if known at decision time); fixed and gated. See `docs/evidence/2026-09-16/point-in-time-admission-report.json`. |
| `9921447` | Holm-corrected residual gate + Giacomini-White conditional test | Ships as the auditable corrected-alpha gate. See `docs/evidence/2026-09-16/residual-gate-holm-correction.txt`. |

## 2026-09-12 – 2026-09-13 — the "Giant Plan" multi-branch integration reports

Ten-plus feature branches each, built in disposable worktrees, merged for evaluation and
**not merged to `main`** at the time. Full reports moved to
[docs/evidence/2026-09-13/integration-reports/](evidence/2026-09-13/integration-reports/)
(they used to sit loose at the repo root).

| Report | Verdict |
|---|---|
| [GIANT_PLAN_BUILD_REPORT.md](evidence/2026-09-13/integration-reports/GIANT_PLAN_BUILD_REPORT.md) | 10 branches merged clean; flags one synthesized join as needing a dedicated regression test before it ships. |
| [MODEL_BUILD_REPORT.md](evidence/2026-09-13/integration-reports/MODEL_BUILD_REPORT.md) | **"Ship the instruments, ship none of the models."** Three of four builds produced worthwhile measurement/governance machinery; zero produced a forecast improvement that clears its own bar. |
| [BETTING_MODEL_REPORT.md](evidence/2026-09-13/integration-reports/BETTING_MODEL_REPORT.md) | **"Nothing in this build improved a forecast."** One of the new grading instruments ended up overturning the rest of the build's own claims. |
| [HISTORICAL_VERDICT_REPORT.md](evidence/2026-09-13/integration-reports/HISTORICAL_VERDICT_REPORT.md) | One unified leaderboard run against real data: **nothing in the stable clears the bar**, and this pass finally put error bars on every number. |
| [NEWS_TIMING_REPORT.md](evidence/2026-09-13/integration-reports/NEWS_TIMING_REPORT.md) | Is there a real speed edge in news reaching this market? **No** — architectural, not a matter of degree; traced one real news fact end-to-end to confirm zero edge. |
| [PROPS_TO_SPREAD_REPORT.md](evidence/2026-09-13/integration-reports/PROPS_TO_SPREAD_REPORT.md) | Two independent checks on "can prop-market info predict the spread." Mechanism runs correctly; **current real data can't validate the idea**, and available data points at a measurement bias in the fallback proxy rather than a real signal. |
| [BETTING_INSANE_REPORT.md](evidence/2026-09-13/integration-reports/BETTING_INSANE_REPORT.md) | Six more feature branches merged clean; restates the props→spread and news-timing verdicts above. |
| [FINAL_SWEEP_REPORT.md](evidence/2026-09-13/integration-reports/FINAL_SWEEP_REPORT.md) | Combines the unify + insane branches; reconfirms the "no real news speed edge" verdict on the fully-merged tree. |
| [UNIFICATION_REPORT.md](evidence/2026-09-13/integration-reports/UNIFICATION_REPORT.md) | Consolidated CLV math into one module (`clv-core.js`); investigated but did **not** merge a sibling walk-forward script. |
| [UNIFICATION_AND_HISTORICAL_REPORT.md](evidence/2026-09-13/integration-reports/UNIFICATION_AND_HISTORICAL_REPORT.md) | Adds an explicit market-identity flag; reproduces (not just spot-checks) the historical verdict above. |
| [PIPELINE_REPORT.md](evidence/2026-09-13/integration-reports/PIPELINE_REPORT.md) | Audit-consolidation pipeline, stage 6 of 6: closes a rollback bug that could have silently deleted decision-tape evidence. |

## Earlier tests (2026-08 – 2026-09-10)

| Date | Commit | Test | Verdict |
|---|---|---|---|
| 2026-09-10 | `81a5ed6` | Full gate audit — do all five betting-authority gates actually fail closed? | **Yes, all five correctly fail-closed; no bugs found.** See `docs/CLAUDE-NEXT-STEPS.md`. |
| 2026-09-07 | `a248329` | Propose-simulate-verify loop for Fantasy Trade Lab's sense-check | Shipped; see [docs/reference/fantasy/TRADE_LAB_VERIFY_LOOP.md](reference/fantasy/TRADE_LAB_VERIFY_LOOP.md). |
| 2026-09-06 | `8413352` | Preseason, offseason, and offseason-data fantasy models — walk-forward validated | Shipped with honest verdicts; see [PRESEASON_MODEL.md](reference/fantasy/PRESEASON_MODEL.md), [OFFSEASON_MODEL.md](reference/fantasy/OFFSEASON_MODEL.md), [OFFSEASON_DATA.md](reference/fantasy/OFFSEASON_DATA.md). |
| 2026-09-02 | `d058da5` | "Beat the close" study — open-to-close dataset, walk-forward + holdout fits, CLV gate | Shipped as `server/services/line-move-study.js`; see [docs/evidence/contracts/beat-the-close-original.md](evidence/contracts/beat-the-close-original.md) for the frozen contract it established. |
| 2026-08-31 | `ae834b4` | Five-season model audit (Run 7) | **Failed** — documented in full at [docs/evidence/historical/MODEL_AUDIT_RUN_7.md](evidence/historical/MODEL_AUDIT_RUN_7.md). |
| 2026-08-30 | `e8479df` | Trend signal vs. closing totals | **Fails, significantly.** Harness: `scripts/audit-trend-totals.mjs`. |
| 2026-08-27 | `1917d30` | Separate "no edge on spreads" from "props never measured" | Confirmed as two distinct, separately-tracked findings; automated watch shipped as `server/services/nfl-model-watch.js`. |
| 2026-08-03 | `5093610` → `f1b2402` | Season replay + systematic error analysis + holdout validation harness, then apply whatever survives it | **Exactly one correction survived holdout validation** and was shipped (`server/services/nfl-ensemble.js`). Everything else the replay proposed did not survive and was not applied. |

---

*This ledger is additive — append new dated entries as tests complete rather than editing
old verdicts. If a rejected idea is later retried with genuinely new data or a fixed bug,
add a new row rather than overwriting the old one, so the "why did we think this was dead"
trail stays intact.*
