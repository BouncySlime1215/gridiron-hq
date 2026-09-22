# S-00 (C18) — statistical method contract and the 2025 holdout ledger

Unit S-00, plan item 18 (Goodhart / accuracy-theater guards), statistical-method
half. Docs only: two new files, `docs/evidence/HOLDOUT-LEDGER.md` and
`docs/evidence/STATS-METHOD.md`, plus this evidence file. Every number below
names the command that produced it and the tree it ran on. Base tree:
`origin/main` at `d6d7bd5a` (#116).

## 1. Audit — extend or build (written before any census row or number)

What already exists on `origin/main` `d6d7bd5a` for "record every look at the
held-out season" and "one statistical method every unit follows":

| # | Existing thing | What it does | Why it is not the ledger / contract |
|---|---|---|---|
| 1 | `docs/HISTORICAL-TESTS.md` (79 lines) | Betting-era list of hypotheses and verdicts, last section 2026-09-16 | Betting scope (out of product scope); one verdict per test, no date/metric/p/CI columns, no fantasy rows, does not count spends of 2025 |
| 2 | `docs/evidence/2026-09-20/AUDIT-FINDINGS-LEDGER.md` | One line per audit finding | Findings about code, not looks at 2025 |
| 3 | `docs/tdd/sweeps/ledger.json` | Mutation-sweep specs (`id`, `file`, `old`, `new`) | Mutation testing, not holdout spend |
| 4 | `server/services/audit-registry.js` | `preregister()` / `runAudit()`: locks hypothesis + threshold + code hash, seals once, Šidák sequential correction `1-(1-0.05)^(1/(priorTests+1))` at `:265`, writes table `audit_registry` | Real preregistration machinery, but its family is the `audit_registry` table (callers: `scripts/audit-football-first.mjs:58`, `scripts/audit-trend-totals.mjs:90`, `scripts/preregister-2026-clv-endpoints.mjs:142,164`), not the fantasy feature-lift tests in `docs/`. It controls family-wise error (Šidák), not false discovery. The "orphaned" claim at `scripts/model-lab/audit_corpus.ts:503` is stale on `d6d7bd5a`: the grep `git grep -n -E "preregister\(\|runAudit\(" origin/main -- server scripts client` finds the three script callers above. |
| 5 | `server/modeling/walk-forward.js:35-55` | `createWalkForwardSplits` returns the last season as `holdout: { state: 'sealed' }` | "Sealed" is a label on the split object; nothing counts or records how many times the holdout was evaluated |
| 6 | `server/services/matchups.js:33-35` | The house ship rule, in a comment: MAE improves with the player-clustered 90% CI entirely below zero, Spearman no worse than −0.002, DNP-included MAE no worse | A rule, stated once in one module; no contract doc points every unit at it |
| 7 | `scripts/model-lab/mass_test_harness.py:70,74` | `two_sided_p(z)` and `benjamini_hochberg(pvals, q)` for a registered family of tests. A second, line-for-line identical `benjamini_hochberg` sits at `scripts/model-lab/atom_drift.py:71` | Reused, not rebuilt: the ledger's BH command imports the family harness's two functions and also runs the `atom_drift.py` copy on the same input to show they agree |
| 8 | `server/services/lineup-brain.js:268` | `DECISION_CURVE`, a static start/sit win-rate curve from a research baseline, 2018-2025 | A decision metric exists but is static and not graded per unit (C-10's job, not this unit's) |
| 9 | `scripts/fit-weekly-coverage.mjs:72-75` | `production()` helper: `kOverride: undefined`, `roleRecency: WEEKLY_ROLE_RECENCY` | The configuration-B shape; the contract cites it |

Commands for the table (tree `d6d7bd5a`):

```
git ls-files docs | grep -i -E 'holdout|ledger|stats-method'
#   docs/evidence/2026-09-20/AUDIT-FINDINGS-LEDGER.md   <- known-nonzero control: the grep does find ledgers
#   docs/tdd/coach-ledger-and-verifier.tdd.md
#   docs/tdd/sweeps/ledger.json
#   (no holdout ledger, no stats-method file)
git grep -n -i -E "benjamini|hochberg|\bfdr\b|false.discovery|holm|sidak|bonferroni" origin/main -- server scripts client/src test
#   50 files match. BH implementations: scripts/model-lab/mass_test_harness.py:74 and scripts/model-lab/atom_drift.py:71
#   (identical logic, both Python, both betting-era). Šidák in the server: audit-registry.js:437, decision-basis.js:210,281,
#   gridiron-model.js:172 (and 22 more server files use Holm/Šidák/Bonferroni words). No JavaScript BH exists.
```

**Decision: BUILD** the two docs (nothing on main records spends of 2025, and no
single document states the method). **EXTEND by reuse** for the arithmetic: the
BH verdicts are computed by `scripts/model-lab/mass_test_harness.py:70,74`, not
a new implementation. Risk stated: both BH copies live in the betting-era
`scripts/model-lab/`; if that directory is removed, the function has to move
with the ledger command.

**One number, one producer.** Two producers of "is this significant after
multiplicity" will exist after this unit: `audit-registry.js:265` (Šidák,
family-wise, α = 0.05, family = sealed rows of table `audit_registry`) and the
ledger's BH at q = 0.10 (false discovery, family = fantasy feature-lift rows of
the ledger). They answer different questions on different families. The BH
command also prints the Šidák verdict on the same ledger family so the two can
be compared on one input. Unifying them (one family, one correction) is named
as a follow-up, not done here: it touches `audit-registry.js`, a server file
this unit does not own.

## 2. Pre-registration (committed before any census row or BH number is computed)

Seen before this commit: the per-file hit counts of the task's example grep
(743 lines in 135 files, tree `d6d7bd5a`), the 2025 table in the
`server/services/matchups.js:28-45` comment, and the betting rows of
`docs/HISTORICAL-TESTS.md`. No ledger row has been written and no p-value has
been derived.

**Question.** How many times has the 2025 season been looked at, per the
documents in `docs/evidence/` and `docs/tdd/` on `origin/main`, and which
shipped feature-lift results survive Benjamini-Hochberg false-discovery control
at q = 0.10 across every feature-lift test in that record?

**Census commands (fixed now).**

- C1, the task's example: `git grep -n -i -E 'held.?out|2025' origin/main -- docs/evidence docs/tdd`
- C2, widened, primary: `git grep -n -i -E 'held.?out|hold.?out|out.of.sample|2025' origin/main -- docs/evidence docs/tdd`.
  C1 cannot match "holdout" or "hold-out"; C2 exists for that reason. The
  files C2 adds over C1 are listed.
- Known-nonzero control: `docs/evidence/2026-09-22/target-share-prior-result.md`
  must appear in both (C1 already counts 5 lines there).

**What counts as a look (one ledger row).** A document section that reports a
result — a metric value, an interval, a p-value, or a pass/fail verdict —
computed with 2025 outcomes as evaluation data, whether or not the document
calls 2025 held out. Every file C2 returns is classified into exactly one of:

- `LOOK` — originates one or more rows.
- `RESTATE` — quotes a 2025 result that originates in another file. The row goes
  to the origin; if the origin is outside `docs/evidence` and `docs/tdd`, the
  first in-scope file that reports it originates the row, marked "origin out of
  scope".
- `ARTIFACT` — raw output (`.json`, `.jsonl`, `.txt`, `.csv`, `.mjs`, `.py`,
  `.tap`). Its look is the `.md` that reports it; an artifact with no reporting
  `.md` originates its own row.
- `COVERAGE` — 2025 appears only as data coverage, row counts or a date range.
- `FIT` — 2025 used only as training or tuning data, no metric reported on it.
  Not a row, but listed, because it spends the holdout too.
- `PLAN` — a plan, prose or a future test; nothing was run.
- `NOISE` — the match is not about the season (for example a sha or id
  containing "2025").

One row per separately reported hypothesis test with its own verdict. A table of
variants from one run is one row per variant. A sweep reported only in aggregate
("N tests, none survive") is one row with N noted.

**Columns.** date, unit/PR, domain (fantasy / betting), family
(feature-lift / other), hypothesis, metric, result, estimate, CI low, CI high,
CI level, p, shipped (yes / no / n.a.), file:line.

- date = the run date the document states; else
  `git log --diff-filter=A --follow --format=%as -1 origin/main -- <file>`.
- unit/PR = the `(#N)` in the subject of the commit that added the file; else
  that commit's short sha.
- result = the source's own words, copied, not re-judged. Numbers are the
  source's rig magnitudes (auditor Condition A: direction travels between rigs,
  magnitude does not). A number the Independent Auditor withdrew
  (handoff/auditor §5) is marked `withdrawn` and is not used for BH.

**Feature-lift family.** domain = fantasy AND the hypothesis is "change X to a
fantasy projection or model input improves a 2025 accuracy metric against the
incumbent". Shipped and declined tests both belong; each separately reported
variant is one test.

**p-value per row, in this order.**

1. The source reports a p-value: use it (two-sided; a one-sided p is doubled,
   capped at 1).
2. The source reports an interval: normal approximation (Altman & Bland 2011):
   `SE = (U − L) / (2 z)` with z = 1.645 for 90%, 1.960 for 95%;
   `z_obs = estimate / SE` (estimate = the reported point, else the interval
   midpoint); `p = two_sided_p(z_obs)` from
   `scripts/model-lab/mass_test_harness.py:70`.
3. Otherwise `not computable`.

**BH.** m = every feature-lift row. Primary: not-computable rows enter with
p = 1 (they count in m and can never be discoveries). Sensitivity: the same with
those rows dropped. Two-sided p, q = 0.10, `benjamini_hochberg` from
`scripts/model-lab/mass_test_harness.py:74` (cross-run: the identical copy at
`atom_drift.py:71` must return the same set). Literature control before the
real run: the 15 p-values of the worked example in Benjamini & Hochberg (1995) at q = 0.05
must give 4 rejections. Benjamini & Yekutieli (2001) show BH keeps
FDR ≤ q under positive regression dependence, which is the expected shape here
(many tests on the same 2025 player-weeks). A survivor whose effect is in the
harmful direction does not count as a ship surviving.

**Past ship.** A feature-lift row whose source states the change was enabled in
production (shipped ON / promoted / live).

**Outputs.** (1) rows in the ledger (the look count), (2) files per class, (3)
for every past ship: survives BH / does not survive / not computable, plus the
Šidák verdict at α = 0.05 on the same family for comparison.

**Sign convention.** Every accuracy delta is candidate − incumbent. For MAE,
negative = candidate better.

**This unit's own ship rule.** No model changes, so no model ship rule applies.
The unit is complete when every C2 file is classified in this evidence file and
the BH command reproduces the ledger's listed verdicts from the ledger alone. A
past ship that fails BH is flagged in `STATS-METHOD.md` for a forward-holdout
re-test; this unit does not switch anything off (docs only).

**Literature.** Benjamini & Hochberg (1995, *JRSS B* 57:289-300) define the
step-up procedure that bounds the expected share of false discoveries at q, and
Benjamini & Yekutieli (2001, *Ann. Statist.* 29:1165-1188) extend it to
positively dependent tests. Dwork et al. (2015, *Science* 349:636-638) show that
a holdout reused adaptively stops being a holdout, which is why every look is
counted rather than only the ones that shipped. Altman & Bland (2011, *BMJ*
343:d2304) give the interval-to-p conversion used in step 2.

---

*Everything below this line was written after the pre-registration commit
(`51c3fddd`, "docs: pre-register the 2025 holdout census and BH method for
S-00"). Nothing above the line was edited afterwards.*

## 3. Commits

| stage | commit | subject |
|---|---|---|
| pre-registration | `51c3fddd` | docs: pre-register the 2025 holdout census and BH method for S-00 |
| ledger (data, before any BH number) | `bedb7882` | docs: seed the 2025 holdout ledger with every look found in docs/evidence and docs/tdd |
| contract + BH run | `a9a2d80c` | docs: statistical method contract with BH over the holdout ledger |
| this evidence file | `7da8facb` | docs: S-00 evidence: census, BH result, forward weeks, mutation sweep, findings |
| review round 1 fixes (section 13) | `1c9d6650` | docs: S-00 review round 1: name the 2026 job, the second pair-accuracy producer and the registry's sealed season |
| review round 2 fixes (section 14) | listed in section 14 | docs: S-00 review round 2: name nfl_model_growth as the second caller of the weekly retrain |

The PR number is not assigned yet. The branch is pushed and no PR is opened,
per the unit's instructions. Cite these as `#N` + subject + sha once a PR
exists.

**RED/GREEN: not applicable.** This unit changes no code. The only executable
piece is the BH command embedded in `docs/evidence/STATS-METHOD.md` (rule 3).
Its liveness proof is the mutation sweep in section 7 (9 mutants killed, one
designed survivor, one not-applied control) plus the literature control it
asserts on every run.

## 4. The census (tree `d6d7bd5a`)

Commands and results. Scratch copies of the raw grep output are not committed.
Re-run the commands to reproduce.

```
git grep -n -i -E 'held.?out|2025' origin/main -- docs/evidence docs/tdd | wc -l                   # 743
git grep -l -i -E 'held.?out|2025' origin/main -- docs/evidence docs/tdd | wc -l                   # 135
git grep -n -i -E 'held.?out|hold.?out|out.of.sample|2025' origin/main -- docs/evidence docs/tdd | wc -l   # 892
git grep -l -i -E 'held.?out|hold.?out|out.of.sample|2025' origin/main -- docs/evidence docs/tdd | wc -l   # 144
```

- **Files C2 adds over C1 (9):** `2026-09-13/integration-reports/UNIFICATION_REPORT.md`,
  `2026-09-15/BETTING-MODEL-UNIFIED-PLAN.md`, `2026-09-15/STAGE-1-BASELINE-FREEZE.md`,
  `2026-09-22/R25-LEVEL-VS-INFORMATION-RESULTS.md`,
  `historical/LIVE_BETTING_FEASIBILITY-evidence.md`,
  `historical/platform-audit-2026-08-24-findings.md` (all under `docs/evidence/`),
  and `docs/tdd/league-history-writer.tdd.md`,
  `docs/tdd/sweeps/start-sit-decision-curve.mutations.json`,
  `docs/tdd/wiring-map-route-deletions.tdd.md`. None originates a 2025 row.
  C1 missed nothing that mattered on this tree, but it cannot match "holdout",
  so the contract keeps C2.
- **Known-nonzero control:** `docs/evidence/2026-09-22/target-share-prior-result.md`
  has 5 lines under C1 and under C2, and originates ledger rows L145-L149.
- **Result:** 144 files classified, 153 ledger rows from 56 files (55 LOOK files
  and one artifact with no reporting document,
  `docs/evidence/redzone-tier-decomposition.mjs`). Classes: LOOK 55,
  ARTIFACT 22, NOISE 20, PLAN 19, COVERAGE 15, RESTATE 10, FIT 3. Rows: fantasy
  feature-lift 76, fantasy other 52, betting 25. Recount from the ledger:

```
grep -c -E '^\| L[0-9]{3} ' docs/evidence/HOLDOUT-LEDGER.md                                          # 153
grep -E '^\| L[0-9]{3} ' docs/evidence/HOLDOUT-LEDGER.md | awk -F' \\| ' '{print $4, $5}' | sort | uniq -c
#   25 betting other / 76 fantasy FL / 52 fantasy other
grep -E '^\| L[0-9]{3} ' docs/evidence/HOLDOUT-LEDGER.md | awk -F' \\| ' '{print $16}' | sed -E 's/:[0-9]+`$//' | sort -u | wc -l   # 56
```

- **Out of scope, counted, not classified:**
  `git grep -l -i -E 'held.?out|hold.?out|out.of.sample|2025' origin/main -- docs ':!docs/evidence' ':!docs/tdd'`
  returns 35 files (361 lines). The same pattern over `server scripts` returns 286
  files (1,763 lines). Control: `server/services/matchups.js`, a known look,
  has 13 matching lines. The ledger says "at least 153" for that reason.
- **Every row's file:line was resolved mechanically.** Each row carries an
  anchor string that must occur on that line of the file at `origin/main`.
  The scratch generator stopped on any anchor that did not resolve, and all 153
  resolved.

### Interpretations applied while classifying (decided before any BH run, stated so they can be disputed)

1. **"Evaluation data"** means data a prediction, rule or hypothesis is scored
   against. A descriptive statistic computed on 2025 (row counts, a mean
   fourth-down rate, source coverage) is COVERAGE. Code hand-checks against real
   2025 records (the four `beat-reporter-accuracy-*` files) score code, not a
   prediction, so they are also COVERAGE.
2. **Feature-lift family.** A superiority claim that a model change improves a
   2025 accuracy or loss metric against the incumbent. Calibration-band gates,
   non-inferiority gates (the lineup-card probability map), grading against
   dumb baselines, diagnostics and research-estimator studies are `other`.
3. **Controls, placebos, synthetic-signal arms and deliberate leaks** are not
   rows. Power checks that detected something are one `other` row each.
4. **Declared deviation from the pre-registration:** betting studies are one row
   per study, not one per test. They are out of product scope and outside the
   family. Written in the ledger as well.
5. **Where a later file restates an earlier one**, the row goes to the first
   in-scope file by date. Example: the role-scenario touches result is recorded
   at `MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08-evidence.md:282` (2026-09-08),
   with the numbers from `2026-09-09/AUDIT-EVIDENCE.md:380`.
6. **Levels not printed** were entered as 90% and marked "guess" in the note:
   the Vegas lift row, and the eight opportunity-vs-baseline rows from the
   2026-09-20 model audit.

## 5. The BH result

Command (from the repo root, on `a9a2d80c`, tree `6f93aff1`, `docs/evidence`
subtree `7ca27348`):

```
sed -n '/^```python holdout-ledger-bh$/,/^```$/p' docs/evidence/STATS-METHOD.md | sed '1d;$d' | python3 -
```

Exit 0. The full output is 84 lines. Every table line and summary line appears
verbatim in `STATS-METHOD.md` rule 3 and rule 4. That was checked with a
line-by-line `grep -qxF` over the output: 0 missing. The evidence commit
changes only prose in `STATS-METHOD.md`, not the script or its recorded
output, and the same command re-run on that commit gives a byte-identical
output (empty `diff`). Summary:

```
control: BH 1995 example at q=0.05 rejects 4 (expected 4)
rows 153; by domain/family {('fantasy', 'FL'): 76, ('fantasy', 'other'): 52, ('betting', 'other'): 25}
feature-lift family m = 76; p computable 57; not computable 19 ({'not computable': 19})
BH q=0.1, primary (not computable enter as p=1, m=76): critical p 0.01016, discoveries 11
BH q=0.1, sensitivity (computable only, m=57): critical p 0.01908, discoveries 12
Sidak alpha 0.05 over m=76: threshold 0.000675, discoveries 8
```

Past ships (feature-lift rows with `shipped` = yes):

| id | hypothesis | p (two-sided) | BH primary | BH sensitivity | Sidak | direction |
|---|---|---|---|---|---|---|
| L006 | Separate role memory (seasonDecay 0.05, weekHalfLife 5) improves the structural head | not computable | not computable | not computable | not computable | favours candidate |
| L007 | Position-aware ensemble beats the fixed 60/40 blend | 0.054 | does not survive | does not survive | does not survive | favours candidate |
| L043 | Preseason p20/p80 band variant kernel-18 beats the raw band (top 150) | 0.079 | does not survive | does not survive | does not survive | favours candidate |
| L044 | Kernel band beats the raw band (top 200) | 0.047 | does not survive | does not survive | does not survive | favours candidate |
| L048 | Live board model-nudge weight 0.2 beats weight 0 | not computable | not computable | not computable | not computable | n.a. |
| L065 | Matchup card spread C2 (DEFAULT_CV x 1.63) beats current spread B0 | 0.019 | does not survive | survives | does not survive | favours candidate |
| L073 | Weeks 2-4: structural-only head (b) beats live fit-1 (a) | 1.8e-07 | survives | survives | survives | favours candidate |
| L077 | Fake-floors fix improves the printed percentiles (D1) | 4.2e-08 | survives | survives | survives | favours candidate |
| L082 | Vegas game-script lift (lineup-brain.js:280) improves weekly points | 0.034 | does not survive | does not survive | does not survive | harmful |
| L084 | Rest-of-season model (d) beats the weekly blend (a) for ros_ppg | <1e-12 | survives | survives | survives | favours candidate |
| L100 | Published cascade opportunity_without beats base_opportunity on absence weeks (Test A) | 0.99 | does not survive | does not survive | does not survive | favours candidate |
| L101 | Own recent usage x multiplier beats own recent usage (Test B) | 0.049 | does not survive | does not survive | does not survive | harmful |
| L152 | Four red-zone tiers beat three for expected touchdowns | 0.0043 | survives | survives | does not survive | favours candidate |

Reading, in one line each (the longer version is in `STATS-METHOD.md` rule 3):
four past ships survive BH (L073, L077, L084, L152). L065 survives only in the
sensitivity run. L007, L043 and L044 do not survive. L082 and L101 point the
harmful way and are not significant after correction. L006 and L048 are not
computable.

## 6. Forward weeks available for rule 5 (local copy, not production)

A fresh copy was made with
`sqlite3 /Users/nick_matta/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"`
(2026-09-22 16:33 local, source file mtime 15:54). `.local-db/` is in
`.git/info/exclude`. Table `player_week_usage`, writer `syncWeeklyUsage`
(`server/services/nflverse.js:245`, insert at `:260`):

```
sqlite3 "file:.local-db/data.sqlite?immutable=1" \
  "SELECT season, COUNT(DISTINCT week), MIN(week), MAX(week), COUNT(*) FROM player_week_usage
   WHERE season IN (2025, 2026) GROUP BY season;"
# 2025|18|1|18|8857      <- known-nonzero control
# 2026|2|1|2|1052        <- weeks 1-2 (527 and 525 rows)
```

So on 2026-09-22 a weeks 5-18 gate has no forward week yet, and under rule 5 its
result ships default-off, labelled "unconfirmed forward". A weeks 1-4 gate has
two weeks. No league or manager data was read. Only `player_week_usage` season,
week and row counts were queried.

### 6b. The other 2026 producers (added in review round 1, same copy)

Same local copy (not production, made 2026-09-22 16:33 local). Each query was
run from the worktree root with `D="file:.local-db/data.sqlite?immutable=1"`.
No league, manager or credential column was selected.

```
# A. actuals: player_week_usage (writer syncWeeklyUsage, nflverse.js:245)
sqlite3 "$D" "SELECT week, COUNT(*) FROM player_week_usage WHERE season = 2026 GROUP BY week;"
# 1|527
# 2|525

# B. pregame snapshots: weekly_prediction_snapshots (writer captureWeeklyPredictions, weekly-learning.js:63)
sqlite3 "$D" "SELECT season, week, COUNT(*), SUM(actual IS NOT NULL) FROM weekly_prediction_snapshots GROUP BY season, week;"
# 2026|2|1183|0

# C. snapshots that already have an actual (settleable on the next run) and pass the retrain's season_to_date filter
sqlite3 "$D" "SELECT COUNT(*), SUM(s.season_to_date IS NOT NULL) FROM weekly_prediction_snapshots s
  JOIN player_week_usage u ON u.season = s.season AND u.week = s.week AND u.player_id = s.player_id WHERE s.season = 2026;"
# 351|351

# D. fits: weekly_ensemble_fits (writer saveWeeklyFit, weekly-weight-store.js:140, insert :147)
sqlite3 "$D" "SELECT id, through_season, through_week, promoted, json_extract(weights_json, '\$.early.weeks') FROM weekly_ensemble_fits ORDER BY id;"
# 1|2025|18|1|
# 2|2025|18|1|[2,4]

# E. job fits on 2026 (the rule-5 query) and its known-nonzero control
sqlite3 "$D" "SELECT id, through_season, through_week, promoted FROM weekly_ensemble_fits WHERE through_season >= 2026;"
# (no rows)
sqlite3 "$D" "SELECT id, through_season, through_week, promoted FROM weekly_ensemble_fits WHERE through_season >= 2025;"
# 1|2025|18|1          <- control: the same filter finds rows one season earlier
# 2|2025|18|1

# F. model registry tables, with a known-nonzero table in the same query as control
sqlite3 "$D" "SELECT 'model_experiments', COUNT(*) FROM model_experiments UNION ALL SELECT 'model_dataset_versions', COUNT(*)
  FROM model_dataset_versions UNION ALL SELECT 'model_backtests', COUNT(*) FROM model_backtests
  UNION ALL SELECT 'weekly_ensemble_fits', COUNT(*) FROM weekly_ensemble_fits;"
# model_experiments|0
# model_dataset_versions|0
# model_backtests|0
# weekly_ensemble_fits|2   <- control

# G. the job's last run (table sync_log)
sqlite3 "$D" "SELECT job, last_run_at, last_status, runs, json_extract(last_detail, '\$.settlement') FROM sync_log WHERE job = 'nfl_weekly_learning';"
# nfl_weekly_learning|2026-09-19T02:00:31.333Z|ok|2|{"pending":1183,"settled":0}
```

Read together: 2026 actuals exist for weeks 1-2, the job holds week-2 snapshots
only, none are settled yet, and no fit has used 2026. Week 2 is inside the
stored early window `[2,4]`, which the retrain excludes (`weekly-learning.js:237`),
so no 2026 fit can happen before week-5 rows settle. How the rule-5 check relates
to this job is in `STATS-METHOD.md` rule 5, "The job that already fits and gates
on 2026".

## 7. Mutation sweep of the BH command

Tests: the command's two built-in assertions (literature control and
two-copy agreement) plus a byte-for-byte diff of its stdout against the recorded
output. Each mutant is a `sed` on the extracted script. Scratch run, on
`a9a2d80c`.

| id | mutation | where | result |
|---|---|---|---|
| M1 | literature control computed with Bonferroni instead of BH | unit (control) | killed: AssertionError |
| M2 | family q 0.10 → 0.05 | call-site constant | killed: output differs (8 lines) |
| M3 | family filter removed, so every row enters BH | call site | killed: output differs (59 lines) |
| M4 | primary drops not-computable rows instead of entering them at p = 1 | unit | killed: output differs (7 lines) |
| M5 | harmful-direction test inverted | unit | killed: output differs (46 lines) |
| M6 | one-sided p instead of two-sided | unit | killed: output differs (42 lines) |
| M7 | cross-run copy given a different q | call site (cross-run) | killed: AssertionError "the two BH copies disagree" |
| M8 | z for 90% intervals set to the 95% value | unit | killed: output differs (84 lines) |
| M9 | SE computed from the full width, not the half-width | unit | killed: output differs (126 lines) |
| M10 | **designed survivor**: the withdrawn test loses its "not used for BH" phrase | unit | survived: output identical. No `FL` row is withdrawn, so this branch is not exercised by today's ledger. A withdrawn `FL` row added later would exercise it |
| M11 | **not-applied control**: a pattern that matches no line | none | not applied: the mutated file is byte-identical |

## 8. One number, one producer

- **BH:** two line-for-line identical implementations on main,
  `scripts/model-lab/mass_test_harness.py:74` and
  `scripts/model-lab/atom_drift.py:71`. The command uses the first (the family
  harness) and asserts agreement with the second on the ledger input. They agree
  (M7 shows the assertion works). Both live in betting-era `scripts/model-lab/`.
  If that directory is removed, the function has to move with the command.
  Follow-up named, not done.
- **Multiplicity correction, two producers, two families:**
  `server/services/audit-registry.js:265` (Šidák, family-wise, α = 0.05, over
  sealed rows of table `audit_registry`, writer `runAudit` in the same file) and
  the ledger BH. On the same input, the 76-row ledger family: BH q = 0.10 gives
  11 discoveries (primary) and Šidák α = 0.05 gives 8. They disagree because
  they control different errors. Unifying them is a follow-up, because it needs
  a grant for `audit-registry.js`. `server/services/decision-basis.js:210,281`
  is a third Šidák use, over decision-basis components. Not touched.
- **Decision win rate, two replay producers that disagree:**
  `startSitPairAccuracy` (`scripts/promote-early-week-weights.mjs:153`) and
  `decisionRanking` (`scripts/promote-volume-shrinkage.mjs:118`, check 4 of the
  volume-shrinkage promotion gate). They keep different pairs, and on one input
  they return 1 pair / 0 versus 3 pairs / 0.3333 (section 13, B2). The contract
  names `startSitPairAccuracy` canonical. Routing `decisionRanking` through it is
  a named follow-up (needs a grant for that script). `DECISION_CURVE`
  (`server/services/lineup-brain.js:268`) is static. Live producers are C-01 to
  C-03. The first version of this section missed `decisionRanking`. Review
  round 1 found it. The structural grep
  `git grep -n -E "pairs\+\+|pairs \+= 1" origin/main -- server scripts` returns 4
  lines. Two are these two producers (the known-nonzero control). The other two
  are `scripts/calibrate-home-field-rate.mjs:50` (game margins) and
  `server/betting/nfl/strategy/teaser-leg-rates.js:610` (betting). Neither is a
  start/sit rate.
- **Forward weeks, three tables:** `player_week_usage` / `syncWeeklyUsage` is the
  only writer of weekly actuals found
  (`git grep -n -E "INSERT (OR [A-Z]+ )?INTO player_week_usage" origin/main -- server scripts`
  returns one line, `server/services/nflverse.js:260`). The first version of
  this section stopped there. It missed the weekly functions that write pregame
  2026 snapshots to `weekly_prediction_snapshots` (`weekly-learning.js:63`),
  settle them (`:157`), and are built to fit and auto-promote weekly weights on
  them into `weekly_ensemble_fits` (`:224`, `:310`, `saveWeeklyFit` at
  `weekly-weight-store.js:140`). Two jobs call them: `nfl_weekly_learning`
  (`scheduler.js:1395`; review round 1 found it) and `nfl_model_growth`
  (`scheduler.js:1416`, `nfl-model-growth.js:307-311`; review round 2 found it,
  section 14). On the local copy, `nfl_model_growth` wrote all 1,183 week-2
  snapshots. On the same copy the two forward sources
  disagree on coverage. Actuals cover weeks 1-2 (1,052 rows). Snapshots cover
  week 2 only (1,183 captured, 0 settled) (section 6b). They also grade
  different numbers: the snapshot holds ensemble `ppg`, not the served number
  (work queue S-12). `STATS-METHOD.md` rule 5 now says rule 5 governs a unit's
  ship decision. It also says every job fit on 2026 is an `F` row that the next
  unit logs. The follow-up is for `retrainWeeklyWeights`, which both jobs call,
  to log or hold its own promotions (needs a grant for `weekly-learning.js`).
- **Sealed holdout season, two sources that disagree:** this contract (2025 is
  held out) and `createWalkForwardSplits` (`server/modeling/walk-forward.js:35`),
  which seals the latest season in the pinned dataset and throws for 2025 once
  the dataset holds a 2026 week (section 13, B3). The registry is unused on the
  copy (0 rows in `model_experiments`, `model_dataset_versions` and
  `model_backtests`; section 6b F). `STATS-METHOD.md` rule 2 now states the
  registry's rule and how its openings enter the ledger. Changing
  `walk-forward.js` is not this unit's call. It is named for C-10, which owns
  that file.
- **New fields:** none in code. The ledger's columns have one reader, the
  command in `STATS-METHOD.md` rule 3, which parses every column it uses (id,
  domain, family, est, lo, hi, level, p, better, shipped, note).

## 9. Findings in files this unit does not own (reported, not edited)

1. **League and manager names are already in the public repo.**
   `git grep -c -E "Matta-Kodsi|Transfer portal|\| 3 My 2025|My 2026 \(" origin/main -- docs`
   matches 10 files, including `docs/tdd/play-chance-live.tdd.md` (4 lines),
   `docs/tdd/manager-data-pipeline.tdd.md` (3) and
   `docs/FANTASY-ENGINE-MASTER-PLAN.md` (3). This breaks the standing
   "no league or manager names in anything committed" rule. It needs an owner
   decision. Rewriting merged evidence files is also against the rules.
2. **fit-1, the promoted weekly weights, was trained on 2023-2025**
   (`scripts/fit-weekly-coverage.mjs:62,66`). Every 2025 grade centred on fit-1
   is mildly in-sample. The files that grade on it say so. Nothing summarises it,
   so rule 5 now does.
3. **Two intervals for one comparison** in
   `docs/evidence/2026-09-22/target-share-prior-result.md`: section 1 prints
   [+0.0680, +0.1437] (line 56) and section 5 prints [+0.0661, +0.1460] for the
   same primary. The ledger uses section 1 and notes section 5.
4. **`docs/tdd/redzone-tiers.tdd.md` contradicts itself.** Section 3b reports a
   significant 2025 ablation (line 95). The five questions (section 4) say the
   gate "cannot run here" and the value is "a guess".
5. **`docs/evidence/redzone-tier-decomposition.mjs` scores 2025, and no document
   records its result.** That look is ledger row L151, with no result.
6. **The Unit-1 volume-shrinkage CRPS gate's 2025 result is not in `docs/`**
   (ledger row L153 cites the local DB row named in
   `docs/tdd/shrinkage-fit-efficiency-weighting-2026-09-22.tdd.md:143`).
7. **`scripts/model-lab/audit_corpus.ts:503` says `audit-registry.js` is
   orphaned.** Stale on `d6d7bd5a`: three script callers exist (section 1).
8. **The Vegas game-script lift is live and graded harmful** on 2025
   (+0.0125 MAE, `docs/tdd/review-fixes-2.tdd.md:172`, ledger L082). It was
   never gated. Rule 5 would keep it default-off until it holds forward.

## 10. Holdout looks by this unit

None. This unit computed no metric on 2025 outcomes. It re-derived p-values from
intervals already printed in committed documents, and counted
`player_week_usage` rows per season on a local copy. Neither reads a 2025
outcome against a prediction. So no row was appended for S-00 itself.

## 11. Known defects and limits

- The census stops at `docs/evidence` and `docs/tdd`. There are at least 35 more
  docs files and 286 code files with 2025 mentions, unclassified. The true
  number of looks is at least 153.
- Classification and row-cutting are judgment. The rules used are written in
  section 4 and in the ledger, and the file table gives the reason for every
  file. A second reader could reasonably move some `other` rows into `FL`,
  which would make the correction stricter.
- p-values from asymmetric bootstrap intervals are normal approximations.
  Grid-minimum rows (L094-L099) are optimistic.
- "Holds forward" (rule 5) is defined by this contract, not by Nick. It is
  written as a proposal.
- The line numbers in the ledger are on `d6d7bd5a`. Later edits to the cited
  files move them. The ledger's anchor method makes each one re-findable.
- Rule 5's handling of the jobs `nfl_weekly_learning` and `nfl_model_growth` is
  manual: a unit runs one query and logs job fits on 2026 as `F` rows. Nothing
  makes either job do it, and nothing stops either one auto-promoting a fit
  trained on 2026 without a pre-registration. The fix is in
  `retrainWeeklyWeights` (`server/services/weekly-learning.js:224`), which both
  jobs call and which this docs-only unit has no grant for (follow-up, sections
  13 and 14).
- Section 1, row 5 says `walk-forward.js` "never counts" openings. That is
  inaccurate: it allows one opening per experiment. It also names only "the
  last season" without saying that this becomes 2026 once a dataset holds a
  2026 week. Section 13 corrects it. Section 1 is left as committed because it
  belongs to the pre-registration commit `51c3fddd`.

## 12. Nick's five questions

1. **Well built?** It is two documents and a command. The ledger is
   mechanically anchored (each file:line was resolved by a string match on
   `origin/main`). The command reads only the ledger, reuses the existing BH
   code, checks itself against a published example, and was mutation-tested
   (9 of 9 real mutants killed).
2. **Stats or made up?** Stats, with named judgment calls. The counts are by
   command. The BH verdicts are computed from intervals the source documents
   printed. What is judgment is the classification of each file and which rows
   form the feature-lift family, and both are written down.
3. **How we know:** the census greps (743 / 892 lines, 135 / 144 files, tree
   `d6d7bd5a`), with a known-nonzero control. The BH command output on
   `a9a2d80c`. The literature control (BH 1995 example, 4 rejections at
   q = 0.05). A 2026 forward-week count on a local copy with a 2025 control. No
   backtest was run. This unit makes no model claim.
4. **Pointed anywhere else?** Yes. The work queue's standard harness line
   (section 3 header) and merge gate v2 section 3 should point at
   `STATS-METHOD.md`. C-10 (decision win rate, sealed holdout, random audits)
   should build its audit job on the ledger and rule 5. Those are other files'
   owners' changes.
5. **How it unifies:** one ledger for every 2025 look instead of disclaimers
   scattered across 56 files. One BH producer, reused and cross-checked. The
   second multiplicity producer (`audit-registry.js` Šidák) is named with both
   verdicts on the same input, and unifying the two is the named follow-up.
   Three more pairs of producers are named with values on the same input (review
   rounds 1 and 2, sections 13 and 14): the weekly retrain, called by the jobs
   `nfl_weekly_learning` and `nfl_model_growth`, against rule 5's forward
   check, `decisionRanking` against `startSitPairAccuracy`, and the registry's
   sealed season against "2025 is held out". For each one the contract says
   which governs, and names the follow-up that would merge them. Eight rules
   that each cite the older rule they consolidate.

**Defect or gap fixed:** no ledger of 2025 looks and no single statistical
method existed (audit, section 1, on `d6d7bd5a`). **Incumbent, by command:** the
`git ls-files docs | grep -i -E 'holdout|ledger|stats-method'` output in section 1.
**What this does not cover:** code comments and docs outside the two census
folders, and any enforcement (no test or guard fails a PR that skips a rule).
**What would make it wrong:** a look missed inside the census folders, a
misread interval or sign in a row, or a classification a reviewer would reverse.
Each row cites its line, so each is checkable.

## 13. Review round 1 (structure lens): three blocking findings, all confirmed

An independent reviewer found three places where the contract named one producer
and a second one exists on `origin/main` (`d6d7bd5a`). I re-checked each one
before changing anything. All three hold. No code changed. The fixes are text in
`STATS-METHOD.md`, `HOLDOUT-LEDGER.md` and this file.

| id | finding | my check | fixed in |
|---|---|---|---|
| B1 | Rule 5 left out the job `nfl_weekly_learning`, which captures 2026 snapshots and is built to fit, gate and auto-promote on them. "No fit and no gate has seen 2026" and "did not exist before" were wrong | read `weekly-learning.js:49,63,155,157,224,243,255,304,310,319`, `weekly-weight-store.js:140,147`, `scheduler.js:547,1395,2116` on `origin/main`. Queries in section 6b: snapshots are week 2 only (1,183, 0 settled); actuals are weeks 1-2 (1,052); fits are 2, both through 2025 W18 | `STATS-METHOD.md` intro and rule 5 ("The job that already fits and gates on 2026": producers, both counts, which governs, `F`-row duty, follow-up); `HOLDOUT-LEDGER.md` intro and "2026 forward looks"; section 8; checklist item 5 |
| B2 | Rule 6 named `startSitPairAccuracy` as the only start/sit pair-accuracy producer. `decisionRanking` in `scripts/promote-volume-shrinkage.mjs:118` computes the same concept with a different pair filter | the script below. It runs both functions, copied from `origin/main`, on one input: 3 pairs / 0.3333 against 1 pair / 0. Control: 3 / 0.3333 for both | `STATS-METHOD.md` rule 6 (second table row, both values, why `startSitPairAccuracy` is canonical, follow-up); section 8 |
| B3 | The contract says 2025 is sealed. `createWalkForwardSplits` seals the latest season in the dataset and throws for 2025 once a 2026 week is present. "Never counted looks" was inaccurate | the script below: 2026 sealed by default, 2025 throws, control 2025 sealed. Also read `server/routes/model.js:157,172,317,348-349,371-377`: the dataset is caller-posted, and one opening is allowed per experiment | `STATS-METHOD.md` rule 2 ("The model registry seals a different season") and its consolidates line; `HOLDOUT-LEDGER.md` intro; sections 8 and 11 |

### B2 command (run from the worktree root)

```bash
T=$(mktemp -d)
{ git show origin/main:scripts/promote-volume-shrinkage.mjs | sed -n '118,138p'
  git show origin/main:scripts/promote-early-week-weights.mjs | sed -n '153,174p' | sed 's/^export //'
  cat <<'JS'
const run = newC => {
  const p = [{ id: 'a', old: 10, neu: 10, act: 5 }, { id: 'b', old: 8, neu: 8, act: 12 }, { id: 'c', old: 5, neu: newC, act: 9 }];
  const arm = f => new Map(p.map(x => [x.id, { week: 5, position: 'WR', prediction: x[f], actual: x.act }]));
  const ss = startSitPairAccuracy(p.map(x => ({ week: 5, position: 'WR', actual: x.act, preds: { old: x.old, new: x.neu } })), ['old', 'new']);
  return JSON.stringify({ decisionRanking: decisionRanking(arm('old'), arm('neu')),
    startSitPairAccuracy: { pairs: ss.pairs, old: +ss.accuracy.old.toFixed(4), new: +ss.accuracy.new.toFixed(4) } });
};
console.log('new arm c=3:', run(3));
console.log('control, new arm c=6:', run(6));
JS
} > "$T/pairs.mjs" && node "$T/pairs.mjs"
```

Output, 2026-09-22:

```
new arm c=3: {"decisionRanking":{"pairs":3,"old":0.3333,"new":0.3333},"startSitPairAccuracy":{"pairs":1,"old":0,"new":0}}
control, new arm c=6: {"decisionRanking":{"pairs":3,"old":0.3333,"new":0.3333},"startSitPairAccuracy":{"pairs":3,"old":0.3333,"new":0.3333}}
```

Lines 118-138 of `promote-volume-shrinkage.mjs` are `decisionRanking` whole.
Lines 153-174 of `promote-early-week-weights.mjs` are `startSitPairAccuracy`
whole. The script copies both from `origin/main` and does not import either
file, so neither script's top-level code runs.

### B3 command (run from the worktree root)

```bash
T=$(mktemp -d); git archive origin/main server/modeling | tar -x -C "$T"
cat > "$T/wf.mjs" <<'JS'
import { createWalkForwardSplits } from './server/modeling/walk-forward.js';
const obs = (season, weeks) => weeks.map(week => ({ player_id: 'p1', season, week, as_of: new Date(Date.UTC(season, 8, week)).toISOString(), actual: 10 }));
const base = [...obs(2024, [1, 2, 3]), ...obs(2025, [1, 2, 3])];
const with26 = [...base, ...obs(2026, [1, 2])];
const show = (label, rows, opts) => {
  try { const h = createWalkForwardSplits(rows, opts).holdout; console.log(label, JSON.stringify({ season: h.season, state: h.state })); }
  catch (e) { console.log(label, 'throws:', e.message); }
};
show('2024-2026w2, default:', with26, {});
show('2024-2026w2, holdoutSeason 2025:', with26, { holdoutSeason: 2025 });
show('control 2024-2025, holdoutSeason 2025:', base, { holdoutSeason: 2025 });
JS
node "$T/wf.mjs"
```

Output, 2026-09-22:

```
2024-2026w2, default: {"season":2026,"state":"sealed"}
2024-2026w2, holdoutSeason 2025: throws: final holdout must be the latest season
control 2024-2025, holdoutSeason 2025: {"season":2025,"state":"sealed"}
```

This is synthetic input, so it shows what the code does, not what any stored
experiment did. On the local copy no experiment exists (section 6b F).

### The BH result did not move

These fixes add text and change no ledger row. I re-ran the BH command
(`sed -n '/^```python holdout-ledger-bh$/,/^```$/p' docs/evidence/STATS-METHOD.md | sed '1d;$d' | python3 -`)
before and after the edits on this working tree. The two outputs are
byte-identical: 84 lines, sha256 prefix `dd6984615923901c`, still 153 rows,
76 `FL`, 11 BH primary discoveries, 12 sensitivity and 8 Šidák.
`grep -c -E '^\| L[0-9]{3} ' docs/evidence/HOLDOUT-LEDGER.md` returns 153, and
the same grep for `F` rows returns 0.

### Follow-ups these findings add (named, not done: each needs a file grant this docs-only unit does not have)

1. `server/services/weekly-learning.js`: make `retrainWeeklyWeights` write a
   forward-look record for every fit on 2026, or hold its promotion default-off
   until a pre-registered gate exists. Until then, each statistical unit runs the
   rule-5 query and logs job fits as `F` rows. (Round 2: this one function covers
   both callers, `nfl_weekly_learning` and `nfl_model_growth`. See section 14.)
2. `scripts/promote-volume-shrinkage.mjs`: route check 4 through
   `startSitPairAccuracy`, which will change the printed check-4 pair counts.
3. `server/modeling/walk-forward.js`: C-10 owns it ("holdout sealed by hash").
   It should decide whether the registry seals by season number or by "latest in
   dataset", and whether openings are counted across experiments. The contract
   now states today's behaviour and how registry openings enter the ledger.


## 14. Review round 2 (structure lens): B1 was only half fixed, confirmed

The reviewer re-checked head `1c9d6650` and found B2 and B3 fixed. B1 was still
partly open. Round 1 named one job, `nfl_weekly_learning`, as the thing that
settles, retrains and auto-promotes on 2026. A second job, `nfl_model_growth`,
calls the same functions. Round 1 also said the heavy tier runs only with
`AUTO_HEAVY_SYNC=1` and that what triggered the job's runs "was not
determined". The code answers that: the off-server loop runs both jobs by name.
I re-checked every claim before editing. All of them hold, and one fact goes
further than the review: on the local copy, the week-2 snapshots were written
by `nfl_model_growth`, not by `nfl_weekly_learning`. No code changed.

Commands, run from the worktree root. Code on `origin/main` (`d6d7bd5a`); rows
on the local copy (not production, made 2026-09-22 16:33 EDT),
`D="file:.local-db/data.sqlite?immutable=1"`.

```sh
# A. every caller of the settle and retrain functions
git grep -n -E "retrainWeeklyWeights\(\)|settleWeeklyPredictions\(\)" origin/main -- server scripts
# server/services/nfl-model-growth.js:307:      const playerSettlement = settleWeeklyPredictions();
# server/services/nfl-model-growth.js:308:      const playerTraining = retrainWeeklyWeights();
# server/services/weekly-learning.js:155:export function settleWeeklyPredictions() {
# server/services/weekly-learning.js:406:    settlement: settleWeeklyPredictions(),
# server/services/weekly-learning.js:407:    training: retrainWeeklyWeights()

# B. how the jobs run today
git grep -n -E "SCHEDULER_DISABLED = '1'|SCHEDULER_DISABLED === '1'|'nfl_weekly_learning',|'nfl_model_growth'," origin/main -- scripts/refresh-live-data.mjs server/services/scheduler.js
# scripts/refresh-live-data.mjs:40:process.env.SCHEDULER_DISABLED = '1';
# scripts/refresh-live-data.mjs:57:  'nfl_weekly_learning',
# scripts/refresh-live-data.mjs:64:  'nfl_model_growth',   // finalized-week ingest, shadow settlement, next-week fit — 6h maxAge
# server/services/scheduler.js:2067:  if (process.env.SCHEDULER_DISABLED === '1') {
# server/services/scheduler.js:2106:  setTimeout(() => { runIfStale('nfl_model_growth', { offThread: true }).catch(() => {}); },

# C. the docs at 1c9d6650 never named the second job; control: they do name the first
git grep -c -E "nfl_model_growth|nfl-model-growth|refresh-live-data" 1c9d6650 -- docs/evidence/STATS-METHOD.md docs/evidence/HOLDOUT-LEDGER.md docs/tdd/2026-09-22-stats-method-contract.tdd.md
# (no output, exit 1)
git grep -c -E "nfl_weekly_learning" 1c9d6650 -- docs/evidence/STATS-METHOD.md docs/evidence/HOLDOUT-LEDGER.md docs/tdd/2026-09-22-stats-method-contract.tdd.md
# docs/evidence/HOLDOUT-LEDGER.md:2
# docs/evidence/STATS-METHOD.md:2
# docs/tdd/2026-09-22-stats-method-contract.tdd.md:6

# D. both jobs in table sync_log
sqlite3 "$D" "SELECT job, last_run_at, last_status, runs, consecutive_failures FROM sync_log WHERE job IN ('nfl_weekly_learning','nfl_model_growth') ORDER BY job;"
# nfl_model_growth|2026-09-22T19:43:59.064Z|error|4|1        (last_detail: exceeded its 120s budget in a worker thread)
# nfl_weekly_learning|2026-09-19T02:00:31.333Z|ok|2|0

# E. table nfl_model_growth_runs (writer runNflModelGrowthCycle, insert nfl-model-growth.js:205, update :337):
#    id, started, status, captured, capture week, settlement, trained, reason
sqlite3 "$D" "SELECT id, started_at, status, json_extract(detail_json,'\$.player_learning.next_week_capture.captured'), json_extract(detail_json,'\$.player_learning.next_week_capture.week'), json_extract(detail_json,'\$.player_learning.settlement'), json_extract(detail_json,'\$.player_learning.training.trained'), json_extract(detail_json,'\$.player_learning.training.reason') FROM nfl_model_growth_runs ORDER BY id;"
# 1|2026-09-03T18:15:37.505Z|waiting|||||
# 2|2026-09-17T18:54:59.272Z|ok|1183|2|{"pending":0,"settled":0}|0|need 250 settled snapshots
# 3|2026-09-18T03:00:10.793Z|running|||||
# 4|2026-09-19T01:54:30.810Z|ok|0||{"pending":1183,"settled":0}|0|need 250 settled snapshots outside the early-week window (weeks 2-4 are served by the stored early buckets)
# 5|2026-09-22T19:41:59.421Z|running|||||

# F. who wrote the week-2 snapshots: one as_of for all rows, inside growth run 2
sqlite3 "$D" "SELECT season, week, count(*), count(DISTINCT as_of), min(as_of) FROM weekly_prediction_snapshots GROUP BY season, week;"
# 2026|2|1183|1|2026-09-17T18:56:10.819Z

# G. the other job's last retrain result (control: same reason, from the other caller)
sqlite3 "$D" "SELECT json_extract(last_detail,'\$.training.trained'), json_extract(last_detail,'\$.training.reason') FROM sync_log WHERE job='nfl_weekly_learning';"
# 0|need 250 settled snapshots outside the early-week window (weeks 2-4 are served by the stored early buckets)
```

Read together:

- `captureWeeklyPredictions` sets one `now` per call (`weekly-learning.js:61`)
  and counts only rows it actually inserts (`captured += insert.run(...).changes`,
  `:84-93`, `INSERT OR IGNORE` at `:63`). Growth run 2 started at 18:54:59,
  reported 1,183 captured for week 2, and all 1,183 rows carry one `as_of`,
  18:56:10.819. So that run wrote them.
- Both jobs have already called `retrainWeeklyWeights` on 2026 rows. Both
  stopped at the 250-row minimum (`:243`). The first fit on 2026 can come from
  either one.
- The in-server timer is off when `SCHEDULER_DISABLED=1` (`scheduler.js:2067`),
  which is how the app is run (`refresh-live-data.mjs:7`; I did not read the
  running server's environment). So `AUTO_HEAVY_SYNC` does not decide anything
  today. Liveness on this Mac, from the process list rather
  than the DB (`ps -axo pid,etime,command` and `lsof -a -p <pid> -d cwd`, at
  2026-09-22T21:13:46Z): `scripts/refresh-live-data.mjs --loop 900` is running
  from the main clone. Two copies of it are running, one for about 5 days and
  one started with the web server about 25 minutes earlier. That is reported
  here, not acted on (see the report's open questions).

What changed, text only:

| file | change |
|---|---|
| `STATS-METHOD.md` intro | two jobs share the retrain, not one |
| `STATS-METHOD.md` rule 5 | section renamed "The jobs that already fit and gate on 2026". A job table covers both paths (`scheduler.js:1395/:547`, `weekly-learning.js:401/:405-407`; `scheduler.js:1416/:1008`, `nfl-model-growth.js:201/:284/:307/:308/:311`) and the hand route (`nfl-betting.js:229`, mounted at `index.js:144`). The two hand-run promotion scripts that also write `weekly_ensemble_fits` are named (`promoteWeeklyFitChecked`, `weekly-weight-store.js:174`; `promote-early-week-weights.mjs:418`, `promote-weekly-ensemble.mjs:309`). The `AUTO_HEAVY_SYNC` and "not determined" sentences are replaced with "How the jobs run today" (`scheduler.js:2067`, `refresh-live-data.mjs:40/:57/:64`, `runIfStale` at `scheduler.js:1882`, growth tier ungated at `:2115`, boot pass at `:2106`) and the local-copy rows from D to F above. The follow-up is scoped to `retrainWeeklyWeights` (`:224`), and the text says why a change to one job is not enough |
| `HOLDOUT-LEDGER.md` | intro bullet and the "Job fits" bullet name both callers (`weekly-learning.js:407`, `nfl-model-growth.js:308`) and the hand-run writer `promoteWeeklyFitChecked` (`weekly-weight-store.js:174`) |
| this file | section 3 (round-1 sha filled in), 8, 11, 12, 13 follow-up 1, and this section |

What still holds from round 1: fits from either job go through `saveWeeklyFit`
into `weekly_ensemble_fits`, so the rule-5 query in checklist item 5
(`WHERE through_season >= 2026`) catches both. It still returns no rows on the
local copy, and the same filter at `>= 2025` returns 2 (section 6b E).

The BH output did not move. The command was run on a `git archive` of
`1c9d6650` (the two docs plus `scripts/model-lab`) and on this working tree
after the edits. `cmp` reports the two outputs identical: 84 lines, sha256
prefix `dd6984615923901c`. `grep -c -E '^\| L[0-9]{3} '` on the ledger returns
153 and the `F` grep returns 0.
