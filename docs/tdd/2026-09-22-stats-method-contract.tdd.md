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
