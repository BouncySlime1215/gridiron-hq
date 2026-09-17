# Gridiron HQ betting model — RUNBOOK

**September 16, 2026, EXECUTION IN PROGRESS.** Gap analysis is DONE. Execute
from LATEST-PLAN.md's **"FINAL ORDER"** table (in its "DATA INTEGRITY
MASTER PLAN" section) — the one authoritative sequence; `~~strikethrough~~`
rows are done. **FINAL ORDER #1 and #2 are DONE** (recipes §10.1 and §10.2;
measurements in §3.3 and in LATEST-PLAN Section B). #1's joint residual fit
is a null result — it does not beat the market either. #2 fixed the
drive-sim's kneel sign, kneel clock and missing halftime/overtime, and the
re-run backtest reads 52.14% ATS over 491 games rather than the long-cited
42.86%, which has no recorded provenance. Both are valid recorded
completions. **#3 (leakage guard, §10.3) is DONE** — built and tested, deliberately not enforced; see LATEST-PLAN's "FINAL ORDER #3" section for what strict admission would refuse and why that is Nick's call. **#4 (GW + Holm, §10.4) is DONE**. **Then the opener-CLV measurement (LATEST-PLAN "RESULTS — the opener-CLV measurement") found the first real edge this project has measured — at the OPENING line, +0.2-0.27 pts, one signal, sub-vig as a flat bet. Read it before #5.** Scripts: `scripts/opener-clv-measurement.mjs`, `opener-clv-pass2.mjs`, `opener-clv-summarize.mjs --pool 2022,2023,2024` (run the summarizer with a scratch GRIDIRON_DB_PATH). **NEWEST: LATEST-PLAN's "RESULTS — MULTI-CHANNEL KALMAN"** (`scripts/model-lab/kalman_multi.py`; dev Holm survivor on totals, failed 2025 and the scorecard). **Before that: "RESULTS — OPENER LAB"** — rerun `scripts/opener-lab/level3.py` weekly (Kalshi/Polymarket timing, forward test at 150 games). **Before that: "CLV + KELLY SCORECARD"** — the standard grading for every strategy test (`scripts/model-lab/clv_kelly.py`); nothing is +EV at the opener, line shopping is the biggest lever. **Before that: "RESULTS — DATA WIRING PART 2, W8-W13"** — every stat table wired as walk-forward forecasters (`scripts/model-lab/wired.py`, `wired2.py`), no edge; Rams dedupe in fit v16. **Before that: "RESULTS — MODEL LAB"** — every forecaster through five methods, Kalman models, confidence tiers and book tests; no confirmed edge; frozen rules and `scripts/model-lab/grade_forward.py` are the 2026 forward test. **Before that: "WALK-FORWARD POINT CONVERSION (fit v15)"** — per-season conversion cutoffs and a fitted opp_adjusted conversion; the 2025 holdout shows no edge for any forecaster. **Before that: "OPENER PLACEHOLDER REPAIR"** — migration 055 repairs 127 Pinnacle placeholder openers in 2022-25 (not yet applied to the live DB); on repaired openers 2025's edge vanishes and the confident-pick tier disappears; re-grade with `scripts/regrade-repaired-openers.py`. **Before that: "CONFIDENCE META-MODEL" is a preregistered null** — model conviction does not predict correctness (r = −0.010), and a supervised meta-model on nine point-in-time features failed out of sample (AUC 0.489). Do not add a learned confidence tier to Phase 3's filters. Script: `scripts/confidence-meta-model.py` (reads saved JSONL only, no DB).
Two #2 follow-ups are parked on a decision from Nick (kneel half-clock; HFA
into per-play rates) — see FINAL ORDER row 2. The dependency table right after FINAL ORDER in
LATEST-PLAN.md says what blocks what for everything after #2. The lineage
of every endpoint and table is in "DATA SOURCES, ENDPOINTS AND LINEAGE"
beside FINAL ORDER. This file's own master sequence (§9, bottom) is
historical background underneath that; the master plan is the entry point.

Both suites green as of this pointer: Node 2,223/2,184/0/39, Python 127/127
(exact commands in §0a rule 5 below). Everything through #4 is committed
and pushed to `cursor/betting-model-audit-fixes-1c85`.

**Start here.** This is the operational companion to `LATEST-PLAN.md`. The
plan says *why* and *what*; this says *do this, then this*, with the exact
command or the exact file, per layer, in the order the steps are safe.
Every command below was either run in this repository on 2026-09-15 or is
the command a module's own documentation gives; where a step is code rather
than a command, it names the file, the function, and the test to add. Steps
marked **NOT YET EXECUTED** are real commands that have not been run on real
data yet.

---

## 0a. Operating contract for whichever model executes this (added 2026-09-16)

Read before touching anything. These are the rules every result in
LATEST-PLAN.md was produced under; breaking one silently invalidates what
follows.

1. **Two databases.** The 16 GB live DB is read-only: `sqlite3 "file:<path>?mode=ro"`;
   Python uses `dataset.read_only_connection`. **Never** set `GRIDIRON_DB_PATH`
   to it. JS runs against real history use the §1.3 extract, built with
   named-column inserts (never `INSERT ... SELECT *`) and verified per §1.3(d).
2. **Every new signal is `challengerOnly: true`** in `nfl-ensemble.js` MODELS
   and never enters the live blend by clearing a per-component test alone —
   only after the rank report (§3.4) shows it raised effective rank AND §6's
   gate passes on a new window. Prove exclusion with the byte-identical
   `ensembleLine()` test pattern in `test/nfl-ensemble-market-correction-component.test.js`.
3. **Measure before believing.** Any accuracy claim needs: out-of-fold, the
   week-clustered `scripts/unified-margin-audit-significance.mjs` (or
   `pairedBootstrapDiff` with `groups`), a declared-family correction for the
   number of comparisons run (Bonferroni/Šidák by hand, written down as you
   go), vs the market AND vs the candidate's own base. A null result is a
   valid completion; never search for a configuration that wins.
4. **Preregister:** `unified_margin_audit.py` writes `preregistered.json`
   before scoring; keep that. New experiments declare recipe/window/metric
   first. Put the comparison count in the plan.
5. **Both suites green before reporting done:** `npm test` (Node) and
   `cd research/betting/nfl && ../../.venv/bin/python3 -m unittest discover -p "test_*.py"`.
   Tests that hardcode catalog/challenger counts (`model-integrity`,
   `family-contribution-scoring`, `nfl-ensemble-rank`) change when MODELS
   changes — update them to the true new counts, never fudge.
6. **Corrections are made in place** with `**CORRECTED <date>**` and the old
   claim left visible; nothing measured is deleted. New findings are dated
   sections. Do not commit unless Nick says so.
7. **Verify agent/subagent output yourself** (re-run its tests, grep its
   claims) before building on it — three of tonight's real catches came from
   doing that.

## 0. Conventions — read once

**Two databases. Never confuse them.**
- **Live research history:** `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite`
  — 16 GB, written by a live capture process. Python reads it read-only
  (`dataset.read_only_connection` uses `mode=ro`). **The JS db layer opens
  read-write and runs migrations at import** — never point
  `GRIDIRON_DB_PATH` at this file. Use the extract in §1.3.
- **Production app DB:** `server/data.sqlite` inside `gridiron-hq` — the app's
  own. Tests never touch it (`npm test` sets a scratch `GRIDIRON_DB_PATH`;
  every DB-touching test asserts `dbPath === process.env.GRIDIRON_DB_PATH`).

**Python interpreter.** `research/.venv/bin/python3` inside `gridiron-hq`
(py 3.12.4, sklearn 1.7.2, numpy 2.5.3, joblib 1.6.0, lightgbm 4.7.0,
scipy 1.18.1 — the versions the saved artifact pins). The JS bridge finds it
automatically when `GRIDIRON_RESEARCH_PYTHON` is unset. Bare `python3` on
this machine is Homebrew 3.14 with no LightGBM — never use it.

**Run everything from the repo root:** `/Users/nick_matta/Documents/GitHub/gridiron-hq`.
Python research commands run from `research/betting/nfl/`.

**The two test suites:**
```bash
npm test                                                   # Node, 2,198 tests (2,159 pass, 0 fail, 39 skipped as of 2026-09-16)
cd research/betting/nfl && ../../.venv/bin/python3 -m unittest discover -p "test_*.py"   # Python, 127 (as of 2026-09-16)
```

**Isolation rules the suite enforces (do not work around them):**
- `test/offline-guard.mjs` blocks all non-localhost network.
- It also sets `GRIDIRON_MARKET_CORRECTION_LOOKUP` to a nonexistent path, so
  no test reads the real `server/data/research/market-correction-lookup.json`
  unless it writes its own scratch file and points there.

---

## 1. One-time setup — verify before anything else

**1.1 Verify the interpreter resolves with no env var** (what a deployed server does):
```bash
env -u GRIDIRON_RESEARCH_PYTHON node --input-type=module -e \
  "const {resolveResearchPython}=await import('./server/betting/nfl/forecast/python-artifact.js'); console.log(resolveResearchPython())"
```
*Done when:* it prints `.../gridiron-hq/research/.venv/bin/python`.

**1.2 Verify both suites are green** (§0 commands).
*Done when:* Node `fail 0`, Python `OK`.

**1.3 Build the read-only extract for any JS run against real history.**
The JS ensemble needs `game_lines`, `nfl_team_week_features`, `nfl_injuries`,
`nfl_snaps`. Do NOT copy the 16 GB file (that was tried; it ate 15 GB of disk).
```bash
SCRATCH=/tmp/gridiron-extract; mkdir -p $SCRATCH
SRC=/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite
# a) pull only the tables + seasons needed, read-only
sqlite3 "file:$SRC?mode=ro" <<EOF
ATTACH '$SCRATCH/slim.sqlite' AS slim;
CREATE TABLE slim.game_lines AS SELECT * FROM game_lines WHERE season >= 2010;
CREATE TABLE slim.nfl_team_week_features AS SELECT * FROM nfl_team_week_features WHERE season >= 2010;
CREATE TABLE slim.nfl_injuries AS SELECT * FROM nfl_injuries WHERE season >= 2010;
CREATE TABLE slim.nfl_snaps AS SELECT * FROM nfl_snaps WHERE season >= 2010;
CREATE TABLE slim.nfl_pfr_adv AS SELECT * FROM nfl_pfr_adv WHERE season >= 2010;
CREATE TABLE slim.nfl_depth AS SELECT * FROM nfl_depth WHERE season >= 2010;
CREATE TABLE slim.nfl_qbr_weekly AS SELECT * FROM nfl_qbr_weekly WHERE season >= 2010;
DETACH slim;
EOF
# b) let the real migrations build a correct schema, then load the rows into it
GRIDIRON_DB_PATH=$SCRATCH/real.sqlite SCHEDULER_DISABLED=1 node --input-type=module -e \
  "const {db}=await import('./server/db/index.js'); await (await import('./server/db/migrate.js')).runMigrations(); db.close()"
# c) load BY COLUMN NAME -- never `INSERT ... SELECT *`. The migrated schema
#    and the live table do not share column order (nfl_snaps: live is
#    ...offense_pct, st_pct, defense_snaps, defense_pct; migrated is
#    ...offense_pct, defense_snaps, defense_pct, st_pct). A positional insert
#    put raw defensive snap COUNTS into defense_pct on 2026-09-15 and every
#    availability deficit came out ~100x too large. Named inserts over the
#    intersection of columns, in the migrated order:
for t in game_lines nfl_team_week_features nfl_injuries nfl_snaps nfl_pfr_adv nfl_depth nfl_qbr_weekly; do
  live=$(sqlite3 "file:$SRC?mode=ro" "PRAGMA table_info($t);" | cut -d'|' -f2)
  cols=$(sqlite3 "$SCRATCH/real.sqlite" "PRAGMA table_info($t);" | cut -d'|' -f2 \
         | while read c; do echo "$live" | grep -qx "$c" && printf '%s,' "$c"; done | sed 's/,$//')
  sqlite3 "file:$SCRATCH/slim.sqlite?mode=ro" \
    "ATTACH '$SCRATCH/real.sqlite' AS dst; INSERT INTO dst.$t ($cols) SELECT $cols FROM main.$t; DETACH dst;"
done
# d) VERIFY before using it: these two must print the same numbers.
sqlite3 "$SCRATCH/real.sqlite"  "SELECT MAX(offense_pct), MAX(defense_pct), ROUND(AVG(defense_pct),2) FROM nfl_snaps WHERE season>=2021;"
sqlite3 "file:$SRC?mode=ro"    "SELECT MAX(offense_pct), MAX(defense_pct), ROUND(AVG(defense_pct),2) FROM nfl_snaps WHERE season>=2021;"
```
*Done when:* `$SCRATCH/real.sqlite` is ~40 MB,
`sqlite3 $SCRATCH/real.sqlite "select count(*) from game_lines"` is ~9,000,
and step d) prints `1.0|1.0|0.24` twice. Every JS-vs-real-history command
below uses `GRIDIRON_DB_PATH=$SCRATCH/real.sqlite`.

---

## 2. L0 — DATA. Is it good, and what to do about the gaps

**Start here:** the data is verified point-in-time correct for what it
covers. Do these in order.

**2.1 Confirm injury receipt clocks are accumulating** (the forward fix for
2025-26 rows that have no `modified_at`).
```bash
sqlite3 "file:$SRC?mode=ro" "SELECT COUNT(*), MIN(observed_at), MAX(observed_at) FROM nfl_feature_revisions WHERE feature='injury_report';"
```
*Done when:* the count grows week over week. Baseline on 2026-09-15: **20
rows, and all 20 share one `observed_at` (`2026-09-15T05:38:19Z`)** — a single
batch write, so accumulation over time is not yet demonstrated. If the count
and `MAX(observed_at)` do not advance after the next `nfl_injuries` run
(`scheduler.js` job `nfl_injuries`), the writer is not recording revisions —
fix that before anything downstream trusts 2025+ injury data.

**2.2 Decide the Monday-night lag.** Measured: 42/42 prior-week MNF games and
~3% of Sunday games are excluded from the next Wednesday fit by
`dataset.RESULT_PUBLICATION_LAG = 3 days` against a midnight `decision_at`.
Options: (a) keep — conservative, documented; (b) split the *score* label
lag (hours) from *derived-feature* lag (days) in `dataset.py`'s
`build_chronology`/`eligible_football_rows`. If (b): change the constant to
two constants, add a test asserting MNF week N enters fit week N+1, re-run
§4.1 and compare against the 9.913 baseline. **This is a decision, not a
bug.**

**2.3 Defensive quality — the free path.** Per-player defensive production is
0% in our tables; `nfl_pfr_adv` (kind=`def`, 2024+, ~7.6k rows/season,
`def_pressures`, `def_passer_rating_allowed`, `def_missed_tackles`, …) is
already ingested and unused.
- Code step: in `server/services/nfl-availability.js` `availabilityDeficit`,
  replace the positional constant for defenders with a prior-weeks value from
  `nfl_pfr_adv` joined on `player_name` (full names on both sides), with an
  explicit `unmatched` count, never a silent default. 2021-2023 defenders stay
  on the positional weight (no PFR rows) and the output says so.
- Test to add: `test/nfl-availability-weighting.test.js` — a defender with
  high `def_pressures` costs more than one with low, same snap share.
*Done when:* that test passes and `scripts/export-availability-features.mjs`
reports the unmatched count.

**2.4 Refresh the market-correction lookup on a schedule** (today it is a
one-time file, 237 weeks).
- Code step: add a `market_correction_lookup` job to
  `server/services/scheduler.js` next to `nfl_learned_shadow`, `tier:
  'growth'`, that runs
  `research/.venv/bin/python3 research/betting/nfl/export_market_correction_lookup.py --db <live> --out server/data/research/market-correction-lookup.json --min-test-season 2015 --quiet`
  after `nfl_weekly_learning`, then calls `clearMarketCorrectionLookupCache()`.
*Done when:* the file's `through_season`/latest `week` advances without a
manual run.

**2.5 Optional, later:** import nflfastR play-by-play (free, CC-BY) with
`*_player_id` columns to enable defensive on/off value. Our current PBP is
ESPN's and carries no player identity. Not needed for steps 3-9.

---

## 3. L4 — EVALUATION. How to run everything (do this before adding signals)

You cannot add a signal without the harness that grades it, so this layer
comes before L1 in practice.

**3.1 The Python weekly walk-forward** (unified model + correction head,
every game scored or explicitly abstained):
```bash
cd research/betting/nfl
../../.venv/bin/python3 unified_margin_audit.py \
  --db /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/server/data.sqlite \
  --output ../../../docs/betting-model/research/experiment-results/unified_margin_audit \
  --through-season 2026 --min-test-season 2021 --quiet
```
Writes `<run_id>/{preregistered,report,predictions}.json` and updates
`LATEST.json` (the pointer the explain-pick tool reads). ~2-4 min.
*Done when:* the printed verdict lists unified, market, zero-info AND the
market-correction block.
*Validity checks the run enforces on itself* (September 15 fixes — see
"Audit system validity" in LATEST-PLAN.md): `preregistered.json` carries
both candidates' recipes (`recipe`, `secondary_candidate.recipe`), the
`horizons` block, and `code_identity` hashed BEFORE the first game is scored
(seven files, including `market_correction.py`); `report.json` must show
`rows_in_evaluation_window == games_scored + games_in_abstained_weeks`
(the run raises otherwise) and `code_files_modified_during_run: []`. If that
list is non-empty, the working tree was edited mid-run — re-run before
citing the numbers. A test-week game reaching its own training set raises
`AssertionError` and no report is written. Note the `run_id` suffix is the
protocol hash, so it changed with this protocol version.

**3.2 Significance — always, never skip.** One tool, week-clustered:
```bash
R=docs/betting-model/research/experiment-results/unified_margin_audit/<run_id>
node scripts/unified-margin-audit-significance.mjs $R                          # unified vs market
node scripts/unified-margin-audit-significance.mjs $R --a correction --b market
node scripts/unified-margin-audit-significance.mjs $R --a correction --b football_alone
# recipe vs recipe, identical games (§4.1 v2 vs v1): field B from ANOTHER run
node scripts/unified-margin-audit-significance.mjs $R_V2 --a correction --b correction --b-run $R_V1
```
*Done when:* you have `mean_diff`, `ci90`, `significant` for each pair. A
point difference without this is not a finding. `--b-run` refuses to join
two runs that disagree on any game's outcome or fit week.

**3.3 The JS joint fit on real history** (how a component is weighted beside
all 35):
```bash
GRIDIRON_DB_PATH=$SCRATCH/real.sqlite SCHEDULER_DISABLED=1 node --input-type=module -e "
const {fitEnsemble}=await import('./server/services/nfl-ensemble.js');
const fit=fitEnsemble({includeChallengers:true});
for (const m of fit.models.filter(m=>m.family==='Market')) console.log(m.id, 'margin_weight',m.margin_weight,'residual_gate(OLD, per-component)',m.residual_gate_passed,'rmse_gain',m.residual_rmse_gain,'dm_p',m.residual_dm_p,'residual_joint_weight(NEW, served)',m.residual_joint_weight);
console.log('OLD residual_gate_pass_count (per-component, informational only)', fit.residual_gate_pass_count);
console.log('NEW residual_joint (what ensembleLine actually reads)', fit.residual_joint);"
```
*Done when:* every component you care about prints a `margin_weight` and a
gate verdict. The OLD per-component gate is
`residual_n ≥ 250 && rmse_gain ≥ 0.03 && dm_p ≤ 0.05`, still computed and
reported (RUNBOOK §0a rule 6: nothing measured is deleted) but no longer
read by `ensembleLine`. **CORRECTED 2026-09-16 (FINAL ORDER #1):** the
served `market_residual` line now reads `residual_joint_weight`, gated on
`fit.residual_joint.gate_passed` -- the SAME three thresholds
(n≥250/gain≥0.03/dm_p≤0.05) applied ONCE to the joint fit's own
out-of-fold statistics, not once per component. See `jointResidualFit` in
`nfl-ensemble.js` and its result:
```
Real-history result, /tmp/gridiron-extract/real.sqlite, includeChallengers:true,
full history through the extract's cutoff, 2026-09-16:
  residual_joint.gate_passed: false
  residual_joint.n (out-of-fold score rows): 749
  residual_joint.fit_n: 1761
  residual_joint.rmse_gain: -0.008   (negative -- WORSE than the market, not just short of +0.03)
  residual_joint.dm_p: 0.9415        (need <= 0.05; nowhere close)
  nonzero_weight_component_count: 0
  OLD per-component residual_gate_pass_count (for comparison): 0 (unchanged, same as pre-2026-09-16)
```
**Reading this honestly:** the joint fit was built specifically because a
genuine joint regression can in principle capture correlation among
components that 31 independent one-at-a-time slopes cannot -- and it still
found nothing. This raises, not lowers, confidence in the "no independent
residual skill on this data" finding: it is not an artifact of the
one-at-a-time method being too weak to see real skill. Per RUNBOOK §0a rule
3, a null result is a valid completion. FINAL ORDER #1 is DONE as
code+tests+measurement; nothing here argues for searching for a
configuration that wins.

**3.4 Effective rank on real data — DONE, September 15, 2026.**
```bash
GRIDIRON_DB_PATH=$SCRATCH/real.sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node scripts/ensemble-rank-report.mjs --before-season 2025 --label real-2025
```
Result (1,039 complete games, 29 measured components + market-family):
`market_residual` participation ratio **2.518**, entropy rank **4.607**, PCs
for 90/95/99% = 6/10/17. Full writeup and the §5 decision it produces are in
LATEST-PLAN.md ("Effective rank result — the §5 gate, September 15, 2026").
**Decision made: prune, not combine** (rank falls in the predeclared
"≈2-3" band). §5 below now names the 12 retirement candidates instead of a
combiner build.

**3.5 The incumbent JS replay** (grades the whole ensemble the way the app
runs it) — `server/services/nfl-replay.js` via `npm run audit:nfl`
(`scripts/nfl-blind-audit.mjs`), against `GRIDIRON_DB_PATH=$SCRATCH/real.sqlite`.
Use it whenever a JS-side component changes.

---

## 4. L1 — SIGNALS. Adding a signal, the same way every time

The contract: a signal produces an **out-of-fold** prediction per
`season|week|home`, is registered as a `challengerOnly` component in
`nfl-ensemble.js` `MODELS`, is graded by §3.3, and never reaches a pick until
§6. `market_correction_research` is the worked example — copy its shape.

**4.1 Injuries + defense through the correction head (the next real
improvement test; Phase 3).** The remaining 0.13 vs the market is where these
belong — *in the correction head*, not the football model.
- Code step, `research/betting/nfl/market_correction.py`: extend
  `RECIPE['correction_feature_names']` and `_correction_matrix` to accept
  `home_availability_deficit`, `away_availability_deficit` (present on rows
  when `build_football_dataset(..., availability_path=...)` is used). Keep
  the 3-feature recipe as `RECIPE_V1`; add `RECIPE_V2`. Missing values stay
  `NaN` (the imputer handles them); never zero.
- Code step, `unified_margin_audit.py`: `--availability <availability.json>`
  and `--correction-recipe v1|v2` flags; the report names the recipe.
- Generate the availability export first (needs the §1.3 extract):
  ```bash
  GRIDIRON_DB_PATH=$SCRATCH/real.sqlite node scripts/export-availability-features.mjs --out /tmp/availability.json
  ```
- Run §3.1 twice (v1, v2), then §3.2 on both, on **2021-2026 only** (injury
  coverage 75% there, 0% before).
- Test to add: `test_market_correction.py` — v2 with availability present
  produces a different training hash than v1 on the same rows; v2 with
  availability all-missing reproduces v1's fit.
*Done when:* v2 vs v1 `mean_diff` and `ci90` are reported on identical games.
If v2 is not significantly better than v1, record it and stop — that is a
result.

**4.1b Player-props engine's own value estimate → availability weighting
(zero new data, pure integration; added 2026-09-16).** `nfl-availability.js`'s
`availabilityDeficit` still values an injured player by
`weightFor(inj.position)` (a flat constant) for every non-PFR-matched
position — including every offensive player. `server/services/
player-week-engine.js`'s `buildPlayerWeekEngine({season, week})` +
`playerWeekProjection(engine, playerId)` already computes a real,
Bayesian-updated, pregame-only per-player value (`.params` — check its
actual keys, likely a volume×efficiency rate; `playerPropEligibility`'s own
docstring confirms it "never looks at the target week's box score," i.e.
already cutoff-safe). This is the injury-weighting fix for OFFENSE that PFR
data (§2.3) was for DEFENSE, and needs no new ingestion at all.

Concrete steps:
1. Confirm `nfl_injuries`' current query in `availabilityDeficit`
   (`server/services/nfl-availability.js`) selects `gsis_id` — it currently
   selects only `team, full_name, position, report_status`, so this needs
   adding before matching by ID is possible.
2. Build `buildPlayerWeekEngine({season, week})` once per
   `availabilityDeficit` call (cache it the same way the function already
   caches by `${season}|${week}|${cutoffAt}`), then for each injured
   offensive player call `playerWeekProjection(engine, gsis_id)`.
3. Decide the exact value field from `.params` to use as the replacement
   weight (read `explainPlayerWeek(projection)` for the human-readable
   breakdown first, to pick a defensible single number rather than guessing
   at a key name) — mirror the PFR pattern exactly: matched players use the
   real value, unmatched players (no projection, e.g. a true rookie with no
   prior engine state) keep today's flat `weightFor(position)`, with an
   explicit matched/unmatched counter, never silent.
4. Test file: extend `test/nfl-availability-weighting.test.js` the same way
   the PFR tests were added — a high-value offensive player costs more than
   a low-value one at the same position and snap share; an unmatched player
   falls back to exactly today's behavior.
*Done when:* that test passes and the existing full suite (2,173/2,134/0/39
as of 2026-09-16) still passes with zero regressions.

**4.2 `tree_lab`'s cover head as a signal.** Export its out-of-fold cover
probability per game the same way `export_market_correction_lookup.py`
does (new `export_cover_lookup.py`, same JSON shape, target `prob`); add a
`cover_research` `challengerOnly` component whose `predict` returns
`margin: null` and a `probability` field the residual machinery can grade.
*Done when:* §3.3 prints it with a gate verdict.

**4.3 Independent Elo baseline** — port `fivethirtyeight/nfl-elo-game`
(MIT): new `server/services/nfl-baseline-elo.js`, `HFA = 65` Elo points
pregame, zeroed at neutral sites, MOV multiplier; register as
`challengerOnly`. Hours. *Done when:* §3.3 prints it. Its purpose is a
sanity floor: any component that cannot beat plain Elo is not a signal.

**4.4 Recursive weekly team-strength update** — `greerreNFL/nfelosrs`
`BayesianRankings.py` pattern: a Gaussian-conjugate per-team, per-week
posterior in `server/services/nfl-team-strength.js` (`teamStrengthWeekly()`),
carrying `stdev`. Days. Gate through `teamStrengthWalkForward` (needs ≥2 of
3 seasons significant) before it replaces the blend.

**4.5 Empirical replacement level** — `ryurko/nflWAR` method: replace the
hand-typed `POSITION_VALUE` table in `nfl-player-value.js` with a backup-
player baseline fit on our own `nfl_snaps`/`player_week_usage`. Feeds §2.3.

---

## 5. L2 — COMBINATION. Decided by §3.4: prune, don't combine

**Gate resolved September 15, 2026.** §3.4 measured `market_residual`
effective rank **2.518** — the predeclared "≈2-3" band — so the rule that
fires is **prune, don't combine**, not build a new combiner. The 12
components below have redundancy R² > 0.95 against the rest of the catalog
(from `server/data/nfl-ensemble-rank.json`, `spaces.market_residual.redundancy`)
and are retirement candidates: `point_diff` (0.999), `availability` (0.999),
`pythagorean` (0.998), `field_position` (0.998), `turnover_regressed` (0.997),
`massey` (0.996), `rest_travel` (0.994), `roster_strength` (0.994),
`epa_net` (0.990), `rush_eff_matchup` (0.977), `pass_eff_matchup` (0.975),
`opp_adjusted` (0.958).
- **Not yet executed:** the actual retirement (demoting these 12 to
  reports-only, keeping the joint fit as is) — this is real deletion of live
  ensemble components and should not happen without Nick's go-ahead given
  what's still uncommitted. Full context: LATEST-PLAN.md "Effective rank
  result — the §5 gate, September 15, 2026."
- Test to add before any retirement: the replaced path's output on a fixture
  equals the pre-retirement path's within 1e-6 before the old code is deleted.
- The combiner-build branch of this section (`forecast-combination.js` as
  the new combiner, retiring `jointComponentWeights` etc.) does NOT apply —
  rank was not materially higher than 2-3 — and is struck from the active
  plan; kept here only as the road not taken.
*Done when:* the 12 are demoted (or Nick decides otherwise) and a §3.5 replay
shows no regression.

---

## 6. L3 — GATE AND PROMOTION. How a signal ever reaches a pick

**Source of truth:** `server/services/gridiron-model.js` `AUTHORITY` ladder
(`research → … → authoritative`), evidence-derived. Keep it.

**6.1 Name the rungs.** Code step: add to that file the three gates that
exist today as loose code —
- residual gate (`nfl-ensemble.js`: `n ≥ 250 && gain ≥ 0.03 && dm_p ≤ 0.05`),
- cover-calibration forward gate (`nfl-cover-calibration.js`),
- staking width gate (`staking.js`, the 24-point rule) —
each with its `evidence_id` and the audit run that measured it.

**6.2 Add the canary window** (ADD #19): a component that passes the
residual gate on a **new** window must then run `challengerOnly` for a
declared number of live weeks with its shadow observations recorded
(`nfl_decision_events`, `experiment_id`) before `challengerOnly` is
removed. Code step in `gridiron-model.js` + one test.

**6.3 Justify or replace the 24-point width gate.** Our own audit measures
real 80% intervals at 34-36 points wide with 80.0-80.3% coverage — the rule
is unreachable by construction. Decision: raise to a measured quantile, or
replace with the CQR interval (FIX #22). Record the evidence either way.

**6.4 Promotion is a manual decision**, recorded in `LATEST-PLAN.md` with
the run ids that justified it. No engineering pass changes stake.

---

## 7. L5 — EXECUTION. Verify only

Already consolidated (FIX #28: `clv-core.js`, six callers). Before any
promotion, run `npm run audit:nfl` against the extract and confirm
`nfl-execution-replay.js` still reports fills from the frozen tape. Nothing
to build here.

---

## 8. The operating loop — what runs when

**Automatic, every hour or faster, while `npm start` runs with the scheduler
on (default; `SCHEDULER_DISABLED=1` is the brake):**
- `nfl_lines`, `nfl_line_snapshots`, `beat_the_close`, `evidence_daemon`,
  the T-60 capture job — quotes and frozen packets.
- `nfl_injuries` — injury table + `nfl_feature_revisions` receipt clocks.
- `nfelo_sync` — external ratings.
- **`nfl_learned_shadow`** — weekly Python fit (Wednesday noon ET slot) and
  zero-stake shadow forecasts onto the decision tape. **First real
  observation appears the first time the app runs with the venv in place.**
- `market_correction_lookup` — once §2.4 is added.

**At checkpoints (after a real model/feature change, or a declared review
date) — never continuously:** §3.1 + §3.2 (Python audit), §3.3 (joint fit),
§3.5 (JS replay). The audit's `LATEST.json` updates only on completion, so
the explain-pick tool's "what the audit found" changes exactly when an audit
finishes.

**Manual, recorded:** §6.4 promotion; §2.2 and §6.3 decisions; commits.

**To see it live:** `npm start`, then open the betting desk, ask "explain
this pick" on an upcoming game — `learned_shadow_research_context` returns
the shadow forecast, its interval, and the latest audit's stats for that
game's schedule/venue/rest groups. Until the scheduler has fired once it
honestly returns `available: false`.

---

## 9. MASTER SEQUENCE — do these in this order

| # | Do this | Command / file | Done when |
|---|---|---|---|
| 1 | Commit today's work | `git add -A && git commit` on `cursor/betting-model-audit-fixes-1c85` (Nick) | one commit, 50+ files |
| 2 | Verify setup | §1.1, §1.2, §1.3 | interpreter resolves; both suites green; extract built |
| 3 | First real shadow observation | `npm start` (scheduler on) | a `nfl_decision_events` row with `experiment_id='nfl-unified-margin-shadow-v1'`; explain tool `available: true` |
| 4 | Lookup refresh job | §2.4 code step | file advances weekly |
| 5 | ~~Rank on real data~~ **DONE** | §3.4 | rank 2.518 recorded; §5 decided prune-not-combine |
| 6 | ~~Injuries + defense through the correction head~~ **DONE** | §2.3, §4.1 | v2 9.943 vs v1 9.913, diff +0.030 CI[-0.006,0.071] **not significant** |
| 7 | Cover head as a signal | §4.2 | gate verdict printed |
| 8 | Elo baseline + nfelosrs update | §4.3, §4.4 | gate verdicts; team-strength promotion gate |
| 9 | Organize C1-C2 | rename `unified_model.py` → `football_blend.py`; registry contract (§4 header) | both suites green after rename |
| 10 | Combination (only after 5) | §5 | one combiner, or documented prune |
| 11 | Gates named; canary added; width gate decided | §6.1-6.3 | rungs in `gridiron-model.js` with evidence ids |
| 12 | R3 (P1) + 2024 wk1-4 pilot | `t60-runner.js` retry must recover the stored result, not recompute | review's R3 proof passes |
| 13 | Promotion, if and only if a signal clears §6 on a new window + canary | §6.4 | recorded in `LATEST-PLAN.md` |

**Where we are:** steps 2 and 5 are done as of 2026-09-15. Step 1 is Nick's.
Step 3 happens on its own the next time the app runs. Step 6 (injuries +
PFR defense through the correction head, RECIPE_V2) is in progress now —
the next thing that can show improvement. Step 10 (combination) no longer
means "build a combiner" — §5's gate resolved to prune-not-combine.


---

## 10. Execution recipes for FINAL ORDER #1-#7 (added 2026-09-16; line numbers verified by the lineage map that day — re-grep before editing, the file grows)

**10.1 FINAL ORDER #1 — make the served residual path a joint fit.**
Files: `server/services/nfl-ensemble.js`. Today: `fitEnsemble()` collects
per-component residual signals at `:1834-1835` (`residuals[m.id].signal.push(margin - marketMargin)`,
`.actual.push(...)`), then fits each component's `residual_slope`/`residual_weight`
one component at a time and applies the residual gate at `:2022-2027`
(`residual_n >= 250 && residual_rmse_gain >= 0.03 && residual_dm_ok && residual_dm_p <= 0.05`).
`jointComponentWeights` (`:1735-1766`) is a joint ridge — but only for
`margin_weight`. `ensembleLine` consumes the per-component slopes at
`:2252-2256` (`residualMargin = marketMargin + Σ residual_weight·residual_slope·(margin−marketMargin) / Σ residual_weight`).
- Do: add a joint fit of the residual (`actual − marketMargin`) on the
  matrix of non-challenger component departures `(margin_i − marketMargin)`,
  same rows as the per-component residual arrays, same ridge/standardize
  pattern as `jointComponentWeights`, week-clustered evaluation. Store as
  `residual_joint_weight` per component alongside the existing fields (do not
  delete the one-at-a-time diagnostics — the report reads them).
- Gate: keep the existing gate semantics but evaluate them on the JOINT
  fit's out-of-fold residual RMSE gain and DM p, not per component.
- Tests: (a) with the lookup/fixture data, `ensembleLine()` output is
  byte-identical when the joint residual weights are all zero (market
  identity preserved — `is_market_identity` still true); (b) a fixture with
  a planted residual signal gets a non-zero joint weight and moves the line;
  (c) `model-integrity.test.js`'s "challengers have zero weight" assertion
  still holds for `residual_joint_weight`.
- Measure: §3.3 joint-fit command, then `nfl-replay.js` per §3.5 on the
  §1.3 extract; report gate pass count before/after. *Done when:* the served
  path is the joint fit, both suites green, replay shows no regression, and
  LATEST-PLAN records the new gate-pass count (expected: still 0 is a valid
  answer).

**10.2 FINAL ORDER #2 — the three drive-sim bugs that are actually live
(CORRECTED 2026-09-16: FIX_AND_ADD #9 away-WP sign and #11 timeout decrement
are already fixed — `nfl-sim-policy.js:113-121` uses `posteamSpread`;
`nfl-drive-sim.js:509` writes the spend back — and the +7 HFA lump is gone,
now `+1` at rate `hfa/off_drives` per drive at `:544`).**
Files: `server/services/nfl-sim-policy.js`, `server/services/nfl-drive-sim.js`.
- (a) **F01-2 urgency denominator.** `nfl-sim-policy.js:229` and `:441`:
  `urgency = clamp(1 - secondsLeft/3600, 0, 1)` divides a HALF-scoped
  `secondsLeft` by the full-game 3600, so urgency never exceeds 0.5 in the
  first half and is mis-scaled in the second. Fix: divide by the seconds
  remaining in the current half (1800) or pass `gameSecondsLeft` explicitly
  where full-game urgency is intended (the call sites already carry
  `gameSecondsLeft`). Exit test: with 30 s left in the half, urgency ≈ 0.98,
  not ≈ 0.49.
- (b) **F01-3 kneel rule sign + clock.** `nfl-sim-policy.js:317-319`
  `kneelable = 40 + timeouts*40` is called with `timeouts: oppTimeouts`
  (`nfl-drive-sim.js:277`) — MORE opponent timeouts should make kneeling
  LESS safe, not more; and `:279` returns `seconds: secondsLeft`, consuming
  the whole clock in one decision. Fix: `kneelable = 40 + (3 - oppTimeouts)*40`
  (or model the opponent's ability to stop the clock explicitly) and return
  the seconds a kneel sequence actually burns (~40 s per kneel-down). Exit
  test: leading by 3 with 1:30 left, opponent 3 timeouts → do not kneel;
  opponent 0 timeouts → kneel; a kneel consumes ≤ 120 s.
- (c) **F01-6 simulateRemainder.** `nfl-drive-sim.js:819-870`: single
  `while (clock > 0)` loop, `timeouts: 3, oppTimeouts: 3` hardcoded (`:855`),
  no halftime, no OT — can end tied. Fix: share `simulateGame()`'s existing
  halftime/OT logic (`~:540-558`) rather than porting a second copy. Exit
  test: no remainder simulation ends tied; timeouts reset at halftime.
- Structural, not a bug: HFA is still added to the SCORE post hoc (`:544`)
  rather than entering the per-play rates (FIX_AND_ADD #10's real point).
  Fold `homeFieldPoints` into the drive context that `simulateDrive` reads;
  exit test as before — margin histogram bin [6.5,7.5] not an outlier vs
  neighbours beyond the empirical reference in `margin-distribution.js`.
- Then re-run `backtest({season, trials:300, maxGames})` for 2021-2025 and
  record simulator vs market MAE and ATS in LATEST-PLAN as **CORRECTED**
  beside the old 42.86% — whatever it says.
  **DONE 2026-09-16.** Command:
```bash
GRIDIRON_DB_PATH=/tmp/gridiron-extract/real.sqlite SCHEDULER_DISABLED=1 \
  node -e "const {backtest}=await import('./server/services/nfl-drive-sim.js'); \
    for (const s of [2021,2022,2023,2024,2025]) console.log(s, JSON.stringify(backtest({season:s,trials:300,maxGames:100})))" \
  --input-type=module
```
| season | sim MAE | market MAE | ATS | rate |
|---|---|---|---|---|
| 2021 | 10.55 | 10.11 | 60-40 | .600 |
| 2022 | 9.67 | 8.87 | 52-45 | .536 |
| 2023 | 10.83 | 10.76 | 49-46 | .516 |
| 2024 | 11.31 | 10.06 | 46-53 | .465 |
| 2025 | 11.05 | 9.21 | 49-51 | .490 |
| **pooled** | **10.68** | **9.80** | **256-235** | **.5214** |

Break-even is .5238, so this is NOT profitable, and one-sided
P(ATS >= 256 | true rate = break-even) = 0.56 — indistinguishable from a
break-even coin. Raw run saved at
`docs/evidence/2026-09-16/drive-sim-backtest-post-final-order-2.json`.
**The important finding is not the rate, it is that the old 42.86% has no
recorded sample size or configuration anywhere in this repository** — see
LATEST-PLAN Section B. Do not cite 42.86% again without re-deriving it.

**10.3 FINAL ORDER #3 — extend the point-in-time leakage guard.**
Files: `server/modeling/contracts.js` (**CORRECTED 2026-09-16: the recipe said
`server/services/contracts.js`, which does not exist**) (`assertTimestampedObservation`, today
scoped to `PIPELINE_VERSION='gridiron-fantasy-walk-forward@1.0.0'`),
`server/services/nfl-blind-audit.js` (weekly freeze), `research/betting/nfl/dataset.py`.
- Do: make the guard callable with any pipeline id; call it on every row the
  blind-audit freeze and `componentPredictionStream` consume from
  `nfl_team_week_features`, `nfl_snaps`, `nfl_pfr_adv`, `nfl_depth`,
  `nfl_injuries`. These five have **no receipt clock of our own** (map,
  2026-09-16) — so the guard must use the nflverse `modified_at` where
  present and REFUSE (not default) rows without one for cutoffs after
  2025-01-01, matching `injury_admission.py`'s `unmodified_since` rule.
- Test: a backdated row (modified_at after the cutoff) is rejected by the
  freeze path; a row with null modified_at in 2025+ is rejected; 2021-2024
  rows with valid clocks pass unchanged. Run the Python suite too —
  `dataset.py` behavior must not change (the Python side already enforces
  this; the gap is the JS freeze/replay path).
- *Done when:* the test passes, `npm run audit:nfl -- protocol` still lists
  the same input tables, and LATEST-PLAN records how many historical rows
  the guard now refuses (that number is a finding).

**10.4 FINAL ORDER #4 — GW conditional test + Holm on the DM gate;
persist the corrected alpha.**
Files: `server/services/backtest-significance.js` (has `dieboldMariano`/HLN),
`server/services/nfl-ensemble.js` residual gate `:2022-2027`,
`server/services/audit-registry.js` (`runAudit()` UPDATE; `always_valid_p` at `:219`).
- Do: (a) add `giacominiWhite(dL, h)` next to `dieboldMariano` per F02
  §94-150 — regress `ΔL_t` on the conditioning vector `h_t` (constant + lagged
  ΔL), Wald test with HAC covariance; (b) in the residual gate, compute the
  per-component DM p as now, then apply Holm across all non-challenger
  components before any `residual_dm_ok = true`; (c) add columns
  `corrected_alpha_at_seal`, `prior_tests_at_seal` to the audit registry and
  write them in `runAudit()` (F07-3).
- Tests: Holm on a fixture of 31 p-values promotes only those that survive;
  GW reduces to DM when `h_t` is the constant alone; registry test asserts
  the two new columns are populated after a seal.
- *Done when:* the gate reports both raw and Holm-corrected pass counts, and
  LATEST-PLAN's multiple-testing section is updated with the first
  corrected count.

**10.5 FINAL ORDER #5 — nfeloFeatures() unused fields.** `nfl-ensemble.js`
ctx already carries `c.nfelo` at all 3 assembly sites. Add `challengerOnly`
MODELS entries reading `c.nfelo.elo_diff` (family 'Rating systems', /25 with
`hfa_mod`, no extra `c.hfa`), `c.nfelo.qbelo_diff`, and a
`market_public_divergence` entry from `money_pct_home − tickets_pct_home`
(family 'Market'; margin = null until a scaling is *measured* — return the
raw divergence in a `probability`-style field the residual machinery can
grade, never a fabricated points constant). Update the three count tests.
Byte-identical `ensembleLine()` test as usual.

**10.6 FINAL ORDER #6 — see §4.1 pattern; target `server/services/nfl-preseason-blend.js`
`blendedTeamRating()` (`:256`).** Add cross-sectional pooling: after the
existing single-unit posterior, shrink each team's in-season mean toward the
league grand mean with a method-of-moments `k = σ²_within/σ²_between`
computed from all 32 teams' current-season means — reuse
`shrinkage-fit.js`'s fitted-k machinery (`activeKVector` pattern), never a
new hand-rolled `k`. Gate through `teamStrengthWalkForward` (needs ≥2 of 3
seasons significant). Then F08-1: replace `inSeasonMean`'s raw average
margin with the ridge paired-comparison estimator `θ̂=(X'X+λI)⁻¹(X'y+λγ)`,
`γ` = the existing prior-season blend. Test: two teams with identical raw
average margin against different-strength schedules get different ratings;
mutation test that a later week's outcome cannot change an earlier week's
rating.

**10.7 FINAL ORDER #7 — the minutes-to-hours fixes.**
- `server/services/nfl-total-calibration.js:37` — import `shinNoVig` from
  `nfl-devig.js`, delete the local proportional noVig, re-run the totals
  calibration walk-forward fit, bump its `VERSION` constant.
- `server/services/nfl-execution-clv.js:72` — replace
  `DEFAULT_CLOSING_BOOKS = null` with a named, versioned reference-book set
  that excludes the execution book; add a test that the execution book is
  never in the closing set.
- `server/services/nfl-drive-sim.js` — `homeFieldPoints: 1.6` hardcode →
  `nfeloFeatures(season,week,home,away).hfa_mod / 25` when present, else 1.6
  (documented fallback). Test both branches.
- `server/services/nfl-ensemble.js:2501` — comment says "nine
  challenger-only"; make it read the count from MODELS or state 21 with the
  date.

**10.8 FINAL ORDER #24-#27 — catalog items folded in on 2026-09-16.**
- **#24 devig:** `server/services/nfl-devig.js` (`shinNoVig`, 2-outcome only).
  Add `powerDevig(prices)` (solve k so Σ p_i^k = 1) and `shinDevig(prices)` for
  N outcomes (Shin 1993 closed form for 2, iterative for N); then a
  `devig(prices, method)` dispatcher with the 7 methods `penaltyblog/implied.py`
  names. Evaluate: run 2021-2025 closing spread/total/moneyline prices from
  `game_lines` through every method, score Brier vs outcomes, record the
  winner in LATEST-PLAN; pick by that number. Tests: 2-outcome Shin == the
  existing function to 1e-12; power and multiplicative sum to 1; N=3 Shin
  reduces to N=2 when one price is +inf.
- **#25 ledger + schema:** new table `bet_attempts` (`attempt_id, declared_at,
  season, week, game_key, market, side, model_prob, market_prob, edge,
  status in {placed, rejected_no_edge, rejected_policy, rejected_price,
  skipped}, reason, run_id`) written from `nfl-auto-picks.js buildCandidate`
  for EVERY candidate, not just `selected`; then the three research tables
  per GF10/FIX #30-#31 with `BEFORE UPDATE/DELETE` triggers mirroring
  `027_decision_tape.js`. Test: a corrected result cannot overwrite an
  unfavorable prior row; `COUNT(*) FROM bet_attempts` ≥ picks served.
- **#26 reliability auditor:** `server/services/calibration-audit.js`
  (new, ~30 lines): bin predicted probability/interval coverage into 10
  quantile bins, KDE-smooth, report expected-vs-observed per bin and the
  max gap. Run on (a) `market_correction.py` `describe()`'s `interval_80`
  over the V1 run's `predictions.json`, (b) `calibratedCoverProbability`
  over `nfl_auto_picks` with settled outcomes. Write both into the audit
  report. Test: a perfectly calibrated synthetic set reports max gap < 0.02.
- **#27 confidence score:** `server/services/team-codes.js` `eventKey()`/
  `contractKey()`: add `matchConfidence({team, date, ...})` returning a
  log2(m/u) sum with hand-tuned weights (team exact +6 / alias +3 / miss −8;
  date exact +4 / ±1 day +1 / miss −6), LOGGED alongside the existing binary
  result, no behavior change. Test: known aliases score above a fixed
  threshold; a wrong-team/wrong-date pair scores below it.

**10.9 FINAL ORDER #21 (mechanized half) — `scripts/data-lineage-inventory.mjs`.**
Built 2026-09-16. Table-level and JSON-blob-key-level reader detection, pure
JS (no shell-out), so it runs the same under `node --test` as from the CLI.
```bash
node scripts/data-lineage-inventory.mjs \
  --db /tmp/gridiron-extract/real.sqlite \
  --out docs/evidence/2026-09-16/data-lineage-report.json
```
Writes both the JSON report and a `.md` summary alongside it. Pass `--prev
<older-report.json>` to get a diff block (`newlyUnusedTables`,
`newlyUnusedBlobKeys`) — run it before starting any FINAL ORDER item that
touches a new data source (per #21's own text) and keep the report under
`docs/evidence/<date>/` so the next run has something to diff against.
Known blob columns are hand-maintained in `KNOWN_BLOB_COLUMNS` at the top of
the script — add a table there when the recurring checklist (item 6 above)
finds a new wide-JSON column, the same way `nfl_team_week_features`,
`nfl_player_week_features`, and `nfl_pfr_adv` were added from the Sept 16
find. Test: `test/data-lineage-inventory.test.js` builds a throwaway sqlite
db + a throwaway source tree with one "used" and one "unused" name of each
kind, and asserts the report classifies both correctly.
