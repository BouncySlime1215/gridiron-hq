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
| this evidence file | (the commit that adds this section) | docs: S-00 evidence |

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
- **Decision win rate:** `startSitPairAccuracy`
  (`scripts/promote-early-week-weights.mjs:153`) is the replay producer.
  `DECISION_CURVE` (`server/services/lineup-brain.js:268`) is static. Live
  producers are C-01 to C-03. The contract says to reuse the first, not quote the
  second as live, and wait for the third.
- **Forward weeks:** `player_week_usage` / `syncWeeklyUsage` is the only writer
  of weekly actuals found (`git grep -n -E "INSERT (OR [A-Z]+ )?INTO player_week_usage" origin/main -- server scripts`
  returns one line, `server/services/nflverse.js:260`).
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
   Eight rules that each cite the older rule they consolidate.

**Defect or gap fixed:** no ledger of 2025 looks and no single statistical
method existed (audit, section 1, on `d6d7bd5a`). **Incumbent, by command:** the
`git ls-files docs | grep -i -E 'holdout|ledger|stats-method'` output in section 1.
**What this does not cover:** code comments and docs outside the two census
folders, and any enforcement (no test or guard fails a PR that skips a rule).
**What would make it wrong:** a look missed inside the census folders, a
misread interval or sign in a row, or a classification a reviewer would reverse.
Each row cites its line, so each is checkable.
