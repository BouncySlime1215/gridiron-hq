# Integration reports — 2026-09-12 / 2026-09-13 multi-branch builds

Eleven reports produced during two consecutive multi-branch integration sessions ("Giant
Plan", "insane batch", "unify sweep", "final sweep"). Each report covers a disposable git
worktree where several feature branches were merged with `--no-ff` for evaluation. **None of
these branches were merged into `main` at the time they were written** — check `git log` for
whether/how their content later landed on this branch.

These files used to sit loose at the repository root; they're collected here because they're
evidence of a specific, dated build session, not a live plan or current instructions. For the
one-line verdict of each, see the "2026-09-12 – 2026-09-13" section of
[../../../HISTORICAL-TESTS.md](../../../HISTORICAL-TESTS.md).

| File | Session |
|---|---|
| GIANT_PLAN_BUILD_REPORT.md | `build-2026-09-12-v2-integration` — 10 branches |
| MODEL_BUILD_REPORT.md | `model-2026-09-12-bigbuilds` — 4 big-build commits |
| BETTING_MODEL_REPORT.md | `model-2026-09-12-integration` — m1–m7 + bigbuilds, 8 branches |
| HISTORICAL_VERDICT_REPORT.md | `unify-2026-09-12-historical` — Giant Plan step 2e |
| NEWS_TIMING_REPORT.md | News-speed-edge investigation |
| PROPS_TO_SPREAD_REPORT.md | Giant Plan step 4 (both halves) |
| BETTING_INSANE_REPORT.md | `insane-2026-09-13-integration` — 6 branches |
| FINAL_SWEEP_REPORT.md | `final-sweep-2026-09-13` — unify + insane merged |
| UNIFICATION_REPORT.md | `unify-2026-09-12-unify-systems` |
| UNIFICATION_AND_HISTORICAL_REPORT.md | `unify-2026-09-12-integration` — 7 branches |
| PIPELINE_REPORT.md | `build-2026-09-12-v2-audit-consolidation`, stage 6 of 6 |
