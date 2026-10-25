---
name: gridiron-nick-morning-list-2026-09-22
description: Items waiting on Nick for the morning of 2026-09-22 (he said 08:25Z "ill do tmr"): key rotations, #95 merge, live reads (weekly_ensemble_fits, shrinkage_fits/shrinkage_k), refresh-live-data.mjs question.
metadata:
  type: project
  modified: 2026-09-22T08:44:00.000Z
---
Nick 08:25Z: tomorrow. Coordinator posts ONE consolidated morning message: every PR, verified figure/tree, merge order, these blocks.
1. **Rotate** GRIDIRON_FLY_TOKEN then GRIDIRON_ANTHROPIC_API_KEY (incident 3, 08:23Z); update Claude Code environment variables; say "rotated". Block posted 08:24Z.
2. **Merge #95** on local figure (3ef535b, 3009/0) — `gh pr ready 95` / `gh pr merge 95 --squash`; or `gh workflow enable ci.yml` first (his settings call). Then deploy block, then unset brake. **#96 HELD** until UI's data-freshness.js consumer fix lands (fails open otherwise).
3. **Live reads** (readOnly, same heredoc pattern as the 08:02Z block): `SELECT id, data_hash, through_season, through_week, promoted, substr(rejection_reason,1,200) FROM weekly_ensemble_fits ORDER BY id;` and `SELECT id, fitted_at, through_season, test_season, active FROM shrinkage_fits ORDER BY id;` and `SELECT COUNT(*) AS n FROM shrinkage_k;` — settles whether efficiency k is applied in production (projections.js:198-201 is a comment, unverified) and QBR-nudge liveness. Also: `SELECT COUNT(*) FROM player_week_usage WHERE targets=0 AND carries=0;` (zero-opportunity dressed rows: rig has them; decides rig denominators). Also (Auditor unit 11): Wednesday-vs-final designation disagreement rate PER BUCKET from nfl_feature_revisions, injury feature (low Questionable rate = #19 production-valid).
4. **Question:** is `scripts/refresh-live-data.mjs` running anywhere on his side? Decides whether trade-ledger `observed` rows will ever fill.
5. **PR board + merge conflicts:** [[gridiron-pr-board-0855-2026-09-22]] (Release c8420d3 on #102; #95 first; ready/hold lists; #94/#100 rebase after #91; #89 vs #95/#91; drop #47; migration 064 duplicated). Morning post = that board + verified figure per PR + merge commands.
6. **#103** (a830c2b) verified 2x + accepted; pre-08:41Z unmigrated-read counts were inflated (62 vs 273 migrated names), 6 unmigrated, all allocated.
7-9. **Projection-model items** (TE prior 0.06 hardcode at projections.js:547; polymarket.js:204 bare catch unallocated; efficiency-k units + effW #22/PR #106 gate): [[gridiron-projection-model-items-2026-09-22]].
10. **Conformal (#20):** G2/G3 pass on the rig; G1 coverage needs a production read (scripts/fit-weekly-coverage.mjs) — only you can run it.
11. **2025 holdout:** the literal gate (fit-weekly-coverage.mjs, RUNS 300, SEED 20260826) on 2025 is runnable (CSV exists) but spends the protected holdout. Auditor recommends: grade the INCUMBENT on 2025 (free, selects nothing) — do; HOLD the conformal candidate run until then. Your call.
12. **51 of 319** service/modeling files are reachable only via betting routes (Opportunity reach grader, #99).
13. **Shared-mount script:** Trade Brain and Scheduler cannot execute /mnt/project-files/verify2x-v4.sh (classifier) and re-ran its steps by hand. Your call whether to allow it.
14. **promote-weekly-ensemble.mjs** can report a successful promotion as a failure when its JSON is piped (process.exit truncation); read its exit status and the DB row, not the piped report.
15. **Opportunity's reach grader** is verified but unpushed (two local commits); say 'push' to land it on #99.
16. **Product decision:** projections at the MAE optimum run ~17-18% low in the mean (Auditor R12); mean signed error must be reported beside MAE on anything shipped; which to optimise is Nick's call.
17. READ: see part2.
See [[gridiron-overnight-0825-2026-09-22]], [[gridiron-open-risks]]. Continued (item 18+) in [[gridiron-nick-morning-list-2026-09-22-part2]].
