# G20 — docs/evidence + docs/reference/fantasy, line-by-line

Reader: **G20-docs-evidence**. Repo root `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`.
Read-only throughout. No file in the repo was modified. `server/data.sqlite` was never opened; the
`.bak` referenced by `NFL_AUDIT_RUN_8_MANIFEST.json` was never opened. No paid API was called.
No process was started or stopped.

**Scope:** 57 files, 17,818 lines (every line of every file in the assigned globs), plus targeted
reads of `server/`, `scripts/` and `.env` to verify or falsify specific documented claims.

---

## 0. The five things that matter most

1. **P1 — `game_lines.open_spread` was corrupted by this project's own median-opener backfill, and
   the season signature proves it.** `profitability-baselines.md:404-412` records writing "blank-only
   `game_lines` openers from the median opening line" out of `nfl_odds_archive`, whose coverage
   `execution-work-through-2026-09-08.md:80` states is **2022–2026 only, "2021 was never fetched"**.
   `RETURN-TO-CODEX.md:98-105` then measures antisymmetry of open_spread over game pairs as
   256/256 (2019), 251/251 (2020), 272/272 (2021), **5/267 (2022), 4/285 (2023), 1/285 (2024),
   4/285 (2025)**, 271/271 (2026). The broken seasons are **exactly** the archive's coverage minus
   2026 (which has live ESPN openers) and minus 2021 (which the backfill's default season list
   excluded). A single home-perspective median written to both the home and away rows produces
   precisely that pattern. No document states this cause. This also breaks the project's own
   canonical rule `OOF-1` clause 8 (`research-packages-2026-09-08.md:246`): "A backfilled or
   simulated cutoff is labelled as such on every result derived from it."

2. **P1 — the shopping board, the module built on the project's only claimed positive, drops most
   books by construction.** `server/services/nfl-shopping-board.js:92-94` joins each event to
   `MAX(captured_at)` with exact equality (`latest.captured_at = s.captured_at`), so any book whose
   row carries a different capture instant is discarded, then `:112` drops the event entirely below
   two books. With six writers into `nfl_line_snapshots` (Odds API, SportsGameOdds, four free feeds),
   different instants are the normal case. `RETURN-TO-CODEX.md:131-134` confirms the effect on live
   data: DK, FanDuel, BetMGM, Circa, bet365, Caesars and BetRivers "disappear from the shopping board
   entirely… almost all of the time." BetRivers is the 5.54%-hold book that anchors the 2.45-point
   hold spread from which the headline 1.22-point edge is derived
   (`server/services/nfl-execution.js:4-9`).

3. **P1 — the frozen fantasy baseline cannot do the one job it exists for.**
   `docs/evidence/baselines/2025-baseline-pre-stage1.json` and `2025-baseline.json` were frozen 35
   minutes apart, carry **byte-identical** `code.commit`, `dirty: true` and `dataset_hash`, and report
   materially different numbers (CRPS 34.877 → 36.412, calibration_error 0.267 → 0.307, Blend MAE
   42.10 → 42.70). `scripts/freeze-baseline.mjs:77` fixes the RNG seed and its comment at `:74-75`
   asserts "rerunning it against the same commit and the same data reproduces the same number."
   The only remaining explanation the script's own header allows is uncommitted code — and `:35`
   records `dirty` as a **boolean**, never hashing the diff. Consequence: the declared Build-Order 0.3
   success criterion "Fantasy MAE < 42.10" (`model-diagnostic-2026-08-26.md:929`) was never met —
   the shipped model is **42.12** — and `STAGE_1_RESULTS.md:91` reports "model wins" only because
   the comparator moved to 42.70 under an identity that cannot detect the move.

4. **P2 — the one "proven edge" has five unreconciled values.** 0.813 pts / 2.566% per bet
   (`WORK_LOG.md:451-455`), retracted to 0.289 pts in the same file at `:457-463`, re-published as
   current eleven days later in `BETTING_CAPABILITY_AUDIT-evidence.md:262` as "the strongest proven
   number in the entire betting apparatus"; 0.225 pts / +0.019 decimal / 1.5–2.5% ROI
   (`nfl-model-status-through-2026-08-30.md:196-199`); ~1.22 points
   (`MODEL_ARCHITECTURE_ASSESSMENT…:71`, from `nfl-execution.js`'s header, and it is an arithmetic
   ceiling from book-hold spread, not an observed return); 0.0067 on 80 observations
   (`2026-09-09/AUDIT-EVIDENCE.md:79`, explicitly "not proof of positive absolute expectation");
   ~2.57%/bet cited from an external memory file in `ADP_DISAGREEMENT.md:4-5`. The test that would
   settle it — "line shopping is authoritative — the one thing measured positive on outcomes" —
   was **failing** in the baseline suite (`slice-final/baseline-suite-before.txt:402`) and is now
   **skipped** (`slice-final/ci-conditions-suite.txt:425`).

5. **P2 — a live betting recommendation rests on a leg rate its own document calls contaminated.**
   `CODEX-6-HANDOFF.md:630` recommends betting the classic Wong window "at −110 or better, hard stop
   at −115", priced from 74.69% over 1,391 legs 1999–**2025**. The same file at `:579` says the 2025
   season is manufactured by the `game_lines.spread` corruption and the corrected headline is
   **74.52%**, and `RETURN-TO-CODEX.md:75-78` bounds the family to 1999–2024. Recomputed:
   at 74.52% the EV is −110 **+6.02%** (not +6.50%), −115 +3.82%, −120 **+1.81%** (not +2.27%),
   −130 −1.75%. The −115 stop survives; the −120 margin shrinks 20%. Nothing was recomputed.

---

## 1. Per-file sections

### 1.1 `docs/evidence/2026-09-11/RETURN-TO-CODEX.md` — 278 lines
**Purpose.** Reviewer-facing correction of the September 10 handoff. The newest document in the
corpus and the one that supersedes most of the rest.
**Data read/written.** None (prose). Cites live-DB observations: 1,154 `nfl_quote_batches`,
1,384,350 `nfl_quote_tape` rows, a 9.0 GB database now at migration `035_alt_spread_capture`.
**Wiring.** `imported_by`: NONE. No code reference anywhere.
**Verified arithmetic (all reproduce):**
- `:76-78` cross-both 2,894 legs / 74.06% → p² = 0.54849; `:63` "+9.70%" at +100 = 0.54849×2−1 ✓.
- `:66-69` joint 54.00% vs p² 54.85% → ρ = −0.0443 ✓ matches the stated −0.044.
- `:71-73` z 1.99 at SE 1.17pp → numerator 2.328pp; at SE 1.29pp → z 1.805 ✓; one-sided p 0.036 ✓.
- `:147` "25 below 0.05 against 25.05 expected" = 501×0.05 ✓; "87 × 6 = 501" correctly flagged
  as arithmetically 522 ✓.
- `:157-158` 74.06% − 70.71% = 3.35pp, and 70.71% is exactly the +100 two-leg break-even ✓.
- `:187` 60,317 legs ≈ 543 seasons → 111.1 legs/season; 2,894 over 26 seasons = 111.3 ✓.

**Defect G20-01 (P2) — `RETURN-TO-CODEX.md:148`, the withdrawal of the 4.26 ceiling is itself wrong.**
> "The previously quoted ceiling of **4.26 is suspect as a 95% quantile** — for 4,060 independent
> one-sided tests that quantile is 4.44 … It is plausible as a 99% quantile."

Computed directly: for m = 4,060 independent one-sided tests the 95% max-z quantile is
**4.2124** (Šidák: 1−0.95^(1/4060) = 1.2634e-5), which must sit just *below* the document's own
Bonferroni figure of 4.22 — and does. **4.44 corresponds to m ≈ 11,400.** The 99% quantile is
**4.567**, not 4.26 (4.26 is the 99% quantile for m ≈ 983). So the stated impossibility argument is
inverted: 4.26 implies ~5,018 effective independent tests against 4,060 actually run — 24% more, a
mild inconsistency, not the contradiction claimed. The conclusion (max-z 2.87 is safe) is unaffected
because 2.87 < 4.21 under any reading, but the reasoning offered for withdrawing a number is
numerically wrong in a document whose subject is numerical trustworthiness.

**Defect G20-02 (P3) — `RETURN-TO-CODEX.md:66` carries forward ρ = +0.082 without re-deriving it.**
Its source, `CODEX-6-HANDOFF.md:550`, states joint 57.75% against p² 55.79%. From those figures
ρ = (0.5775 − 0.5579)/(0.74693×0.25307) = **+0.1037**, not +0.082. One of the three numbers in that
sentence is wrong and neither document reconciles them.

**Genuine strengths worth preserving.** §4a (`:193-213`) is the single most valuable page in the
corpus: it states that four of five measurement claims in §4 have **no stored artifact of any kind**,
that the specific figures (max-z 2.87, the 4.26 ceiling, six pre-registered hypotheses, Holm ≥ 0.99,
the 3.35–9.86pp MDE range, 60,317 legs) appear for the first time in that document with no
predecessor in the handoff, and that "an analysis that cannot be rerun is a memory, not a
measurement." `:157-162` self-flags the 3.35pp MDE as arithmetically impossible on a 2,894-leg family
and instructs the reader to treat it as unverified. This is the correct standard.
**Verdict: active, authoritative, highest-quality document in the set — with two arithmetic defects.**

### 1.2 `docs/evidence/2026-09-10/CODEX-6-HANDOFF.md` — 638 lines
**Purpose.** Slice-by-slice record of the work executed against the September 10 review (slices 0–10),
plus the five-agent Wong × model addendum.
**imported_by:** NONE.

**Defect G20-03 (P2) — `:388` "Three stale code comments pointing at the relocated files were
updated." There are 97, across 54 files, and every one is broken.**
Measured: `grep -rhoE "docs/[A-Z_0-9]+\.md" server client/src scripts test` returns **97 hits across
54 files**, spanning 25 distinct targets — `docs/OFFSEASON_MODEL.md` ×10, `docs/PRESEASON_MODEL.md` ×9,
`docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md` ×9, `docs/PROPS_PLAYER_ENGINES.md` ×8,
`docs/PROFIT_ROADMAP.md` ×6 (file deleted outright, `git log --diff-filter=D`), `docs/WORK_LOG.md` ×4,
`docs/NFL_MODEL_STATUS.md` ×4, and so on. `docs/` now contains only `CLAUDE-NEXT-STEPS.md`,
`README.md`, `evidence/` and `reference/`. **Zero of the 97 resolve.** Only two files in the repo
carry post-move paths: `server/routes/decision-inbox.js:3` and `server/services/nfl-policy.js:74,81`.
A future agent following `server/services/preseason-model.js:37` ("the declines and the limits are in
`docs/PRESEASON_MODEL.md`") finds nothing and may conclude the evidence is gone.

**Defect G20-04 (P2) — the teaser EV table at `:592-597` uses an undocumented leg rate.**
Its values (−110 +6.7%, −115 +4.5%, −120 +2.4%, −130 −1.1%) back-solve to p = **74.76%**.
`WORK_LOG.md:495-503` gives the arithmetically exact table for the stated 74.69% (+6.50 / +4.30 /
+2.27 / −1.30) and `BETTING_CAPABILITY_AUDIT-evidence.md:466-467` gives a third rounding
(+6.51 / −1.29). Three documents, three tables, one nominal leg rate.

**Defect G20-05 (P2) — internal contradiction on the correlation's economic sign.**
`:553-555`: "EV at −110 is nearer +9% than +6.5%. The same correlation that widens the SE *helps* an
all-must-win ticket, so `p^n` understates the payoff." `RETURN-TO-CODEX.md:66-69` measures ρ = −0.044
on the cross-both family actually recommended, i.e. independence is **optimistic**, overstating a
two-leg ticket by 0.85pp. The handoff's line is not marked superseded anywhere in the handoff itself.

**Defect G20-06 (P3) — test-count contradiction.** `:322-323` "1,449 pass / 0 fail / 24 skip"
(total 1,473) against `slice-final/README.md:16` "After | 1496 | 1472 | 0 | 24" for the same work,
written 95 minutes *earlier*. `DECISION-RECORD.md:32` repeats the 1,449 figure.

**Superseded by `RETURN-TO-CODEX.md`:** `:502` and `:582-587` ("zero teaser prices have ever been
recorded"; `nfl_teaser_price_ledger`: 0 rows) — first real price recorded 2026-09-10
(DK, +100, push reduces), `RETURN-TO-CODEX.md:240-242`. `:452-455` ("No prospective observation
exists") — superseded by §7's frozen SF@LAR packet. `:637-638` ("roughly 4,600 formal tests") —
explicitly withdrawn at `RETURN-TO-CODEX.md:151-155`. `:536` ("carries **zero** dispersion
information") — withdrawn at `RETURN-TO-CODEX.md:170-175`. `:617` (cross-both 3,015 legs @ 73.90%)
— superseded by 2,894 @ 74.06% under the 1999–2024 bound.

**Excellent and load-bearing.** `:427-442` records a defect the work itself introduced (the C09
rewrite reported 153 bets and a null win rate because stored runs write `"Won"`/`"Lost"` and the
comparison was lower-case) and `:464-485` records a second (an import inserted into the middle of a
multi-line import specifier; `node --check` passed). Both are the kind of thing normally deleted.
**Verdict: active evidence, substantially superseded in its betting sections, one materially false
completion claim (G20-03).**

### 1.3 `docs/evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md` — 321 lines
**Purpose.** Section 13 required return: what changed in the Claude session, with the §1b feature-family
table. **imported_by:** NONE.

**Defect G20-07 (P2) — the run-32 totals row is wrong, and the error was already caught and never
fixed.** `:21`:
> `| Total | 48 bets, 23-24-1, -2.945u, -6.13% ROI | 48 bets, 23-24, -2.945u, -6.10% ROI (unchanged …) |`

Identical units and identical bet count cannot produce two ROIs. −2.945/48 = −6.135%. The push also
silently disappears (23-24-1 → 23-24). `superseded-plan-2026-09-09.md:133` states the correct figure
and names this row: *"Its totals remain 23/24/1 over 48 bets and −6.134629893% ROI, despite the
summary's abbreviated/misrounded table."* The summary was never corrected.

**Defect G20-08 (P2) — the §1b ROI column is not on the common universe, and the JSON that backs it
says the opposite.** `family-contribution-2021-2025.json:32` declares: *"Every configuration is
scored on exactly these games. A variant that forecasts more or fewer games than the full ensemble
has the difference EXCLUDED from all three answers."* But each `economic` block carries
`variant_bets` of 263 / 112 / 292 / 169 / 202 against `baseline_bets` 204 — numerically identical to
the *per-variant-universe* file `feature-ablation-2021-2025.json`. Margin and cover are on 1,424
common games; the economic answer is not. `IMPLEMENTATION-SUMMARY.md:159-165` is honest about the
consequence ("the apparent profit is the variant declining to bet") but the JSON's universe note is
false as written, and it is the machine-readable artifact.

**Defect G20-09 (P2) — the family-contribution artifact embeds the C16 bug.**
`family-contribution-2021-2025.json:350,375,385,399,409` report `"challenger_only": 0` for all five
families. `CODEX-6-HANDOFF.md:317` (C16) states `featureContracts()` read `challenger_only` while the
registry spells it `challengerOnly`, "so the report saw **zero** challengers where nine exist."
The JSON is timestamped 11:11, the C16 fix landed later the same day; the artifact was never
regenerated, and `IMPLEMENTATION-SUMMARY.md` §1b is built on it.

**Minor.** `:40` quotes run 27's spread-only 95% ROI interval as "[-23.2%, +7.4%]";
`2026-09-09/AUDIT-EVIDENCE.md:18` gives **−23.22% to +7.51%**. (P3.)
**Verdict: active, honest in prose, with a defective backing artifact and one uncorrected table.**

### 1.4 `docs/evidence/2026-09-10/DECISION-RECORD.md` — 89 lines
Slice-10 continue/reject record. Clean, short, and correct in its central claim ("unknown, and not
yet askable"). Carries the 1,449-pass figure (G20-06) and `−11.85` units where the authoritative
figure is `−11.854884` (`2026-09-09/AUDIT-EVIDENCE.md:16`). **imported_by:** NONE. **Verdict: active.**

### 1.5 `docs/evidence/2026-09-10/AUDIT-EVIDENCE.md` — 18 lines
Evidence index for the September 10 review. **Defect G20-10 (P3):** `:8` records "local Node 24.19.0";
its own co-located `implementation-checks.json:110` says `"runtime": "Node v25.9.0"`,
`slice0/SOURCE-MANIFEST.md:11` says `v25.9.0`, and `superseded-plan-2026-09-09.md:131` says
"isolated Node 25.9.0 suite". Node 24 appears nowhere else in the corpus.
**imported_by:** NONE. **Verdict: active index, one transcription error.**

### 1.6 `docs/evidence/2026-09-10/superseded-plan-2026-09-09.md` — 857 lines
The previous active plan, preserved verbatim under an 8-line authority-removing header
(`:3-8`, "Do not execute anything from this file"). Content is 849 lines of live-voice imperatives:
"Instructions to Claude" (`:14`), "Required correction" ×11, "Acceptance" ×14, "Claude must return"
(`:531`), "Execute the companion **FOLDER-REORGANIZATION.md**" (`:801`).

**Defect G20-11 (P3) — 7 of the 10 broken relative links in `docs/` are in this file.**
`:16` (×4), `:104`, `:106`, `:119` all resolve against `docs/evidence/2026-09-10/` instead of `docs/`,
e.g. `evidence/2026-09-09/AUDIT-EVIDENCE.md` → `docs/evidence/2026-09-10/evidence/2026-09-09/…`
(missing). The links were not rewritten when the file was relocated.

**Highest-value content preserved here and nowhere else:** `:133` is the only place that records the
correct run-32 totals figure, and `:243` records "780 tracked files versus 773 migration-map rows:
12 new paths have no disposition and five deleted documents are still listed as current paths."
**Verdict: correctly headed, correctly retained, link-broken. Risk is mitigated but not zero: the
header is 8 lines against 849 lines of imperatives.**

### 1.7 `docs/evidence/2026-09-10/{family-contribution,feature-ablation}-2021-2025.json` — 418 + 332
All arithmetic reproduces (bets = wins+losses+pushes; roi = units/bets; family shares 17/6/2/4/2 = 31,
0.548/0.194/0.065/0.129/0.065 ✓). Defects G20-08 and G20-09 above.
**Defect G20-12 (P3) — `feature-ablation-2021-2025.json` is a trap for a casual reader.** `only:Market`
and `only:Roster availability` both return **0 bets** (`:110`, `:167`) — the two families the summary
concludes are the ones that matter cannot be measured in isolation at all — while `without:Efficiency`
shows `"roi": 0.072, "beat_vig": true` (`:227-229`) and `only:Rating systems` shows
`"roi": 0.029, "beat_vig": true` (`:143-145`). `beat_vig: true` on a diagnostic-only artifact whose
own `probability_roi_above_zero` is 0.794 and 0.727 is a field that will be misread.
**imported_by:** NONE. **Verdict: active artifacts; the ablation file should carry the same
"different cohorts" warning the summary prose gives.**

### 1.8 `docs/evidence/2026-09-10/implementation-checks.json` — 240 lines
**Byte-identical** (md5 `3e84bfcc5aa363f5725233515a6051b8`) to `docs/evidence/2026-09-09/
implementation-checks.json`. A staged duplicate. Its `full_suite` block (1,207 tests, 21 failed)
describes commit `969d501…`, which is three days and two review cycles older than the directory it
sits in. **Disposition: merge** — keep the 09-09 original, replace the 09-10 copy with a pointer.

### 1.9 `docs/evidence/2026-09-10/slice0/SOURCE-MANIFEST.md` (25) and `slice-final/README.md` (23)
Both clean and exactly what they claim. `slice-final/README.md:18-20` is the right way to report a
skip ("The 24 skips are not the 24 failures renamed… each names the history it needs"). Only defect
is the count mismatch with the handoff (G20-06). **imported_by:** `README.md` matches are unrelated
schema files. **Verdict: active.**

### 1.10 `docs/evidence/2026-09-09/AUDIT-EVIDENCE.md` — 655 lines
The foundational audit. **Every number I could check reproduces**: the season table at `:11-16` sums
to 153/72/78/3 and −11.854884 with per-season ROIs exact to 4 dp; `:133-136`'s market table
reconciles (153+48+344 = 545, −11.854884−2.944622−40.614766 = −55.414272 vs stated −55.414273,
rounding); and `run31-completed-comparison.json` independently confirms the per-season spread counts
37/31/22/36/27 and "six weeks with no spread selections" (`:18`) — I recomputed both from the JSON's
70 records.
**imported_by:** NONE. **Verdict: active, the most reliable numeric record in the corpus.**
Its run table at `:56-71` is the authoritative reconciliation of runs 9–31 and carries the standing
instruction "Do not fabricate them or infer that 31 means 31 independent completed experiments."

### 1.11 `docs/evidence/2026-09-09/run31-completed-comparison.json` — 649 lines
70 records, contiguous ordinals 0–69, 545 picks, 153 spreads, 70/70 `picks_identical: true`,
70 unique SHA-256s, 6 zero-spread weeks. Verified field-wise across all 70 records.
**Verdict: active, internally perfect, and the correct answer to "is run 31 new evidence" (no).**

### 1.12 `docs/evidence/NFL_AUDIT_RUN_8_MANIFEST.json` — 66 lines
Arithmetic verified: 29+20+38+26 = 113 bets; 18+9+14+14 = 55 W; 11+10+24+12 = 57 L; units sum to
−6.242; ROI −5.524%; win rate 55/112 = 49.107%. Specialist directional rates match
`profitability-baselines.md:103-114` to 4 dp.
**Defect G20-13 (P2) — this file is an orphan that contradicts the audit register's own warning.**
`2026-09-09/AUDIT-EVIDENCE.md:54`: "The current blind-audit table contains run IDs 9–31. Earlier run
numbers are referenced in historical documents/conversation, but **their complete rows are not present
in this live table. Do not fabricate them**." This manifest supplies exactly such a complete row for
run 8, recovered from `server/data.sqlite.pre-reset-20260901-135647.bak` (`:64`), sits unreferenced at
the top of `docs/evidence/`, and is indexed by no document. It also shares its 2023 and 2024 rows
**exactly** with run 7 (`MODEL_AUDIT_RUN_7.md:47-48`: 20 bets 9-10 −1.616; 38 bets 14-24 −10.893),
so runs 7 and 8 are not independent for those seasons and nothing says so.
**imported_by:** NONE. **Disposition: keep, but index it and add the non-independence note.**

### 1.13 `docs/evidence/baselines/*.json` — 121 + 121 lines
See §0 item 3 (Defect **G20-14, P1**). Additional: `STAGE_1_RESULTS.md:222` cites the pre-stage1 file
at the stale path `docs/baselines/2025-baseline-pre-stage1.json`.
**Defect G20-15 (P2) — the distribution block is computed on 150 of 382 players and the API does not
say so.** Both files report `players_graded: 382` alongside `distribution.n: 150`.
`server/routes/model.js:503` `for (const id of ids.slice(0, 150))`, and `:511`'s response note reads
*"Every source is graded on the same players"* — true for the point table, false for the distribution.
`STAGE_1_RESULTS.md:207-209` flagged this in August ("Fine for a live page, misleading for a gate
decision") and it is unchanged. `STAGE_1_RESULTS.md:54-57` records that this exact cap once produced
a spurious ~2% CRPS regression.
**imported_by:** written by `scripts/freeze-baseline.mjs`; read by no runtime code.

### 1.14 `docs/evidence/contracts/profitability-policy-v1.3.md` — 72 lines
**The only frozen extraction I could verify end-to-end, and it is faithful.** Compared word-for-word
against its stated source `profitability-baselines.md:697-740` (§2 "Definition of success"):
identical across all three gate blocks. `:66-67` correctly names its consumer,
`server/services/nfl-policy.js`, and that file cites it back at `:74` and `:81` with the *new* path —
one of only two correct doc pointers in the entire codebase.
**imported_by:** `server/services/nfl-policy.js`. **Verdict: active, correct, exemplary.**

### 1.15 `docs/evidence/contracts/beat-the-close-original.md` — 343 lines
Frozen Phase-1/2/3 contract with a proper banner. Phase 1 gate (`:113-120`): mean CLV ≥ +0.3 pts,
interval excluding zero, ≥ 300 games, one decision time. `DIAGNOSTIC_2026_09_02.md:475-503` reports
`ratings_vs_open` clearing it at +0.58 [0.27, 0.95], Holm p < 0.01 on n = 570. **That result is the
direct ancestor of the settled "no edge vs the close / mean CLV −2.28 pts" position, and this
contract is the only place its pass criteria are recorded.** `:196` `[ ] wind_total live rule …
(deferred until run 16 frees the server)` is an open checkbox for an instruction that is now stale.
**imported_by:** NONE (code cites the dead `docs/BEAT_THE_CLOSE_PLAN.md` ×2). **Verdict: correctly
frozen; the checklist should be closed out rather than left with open boxes.**

### 1.16 `docs/evidence/contracts/research-packages-2026-09-08.md` — 270 lines
Contains **OOF-1** (`:235-248`), the canonical eight-clause out-of-fold rule — the single most
important governance artifact in the repo, and the one clause 8 of which the open_spread backfill
violates (§0 item 1). `:31` "Reject 'line shopping is proven profit'" is the correct standing
position and is contradicted in practice by four other documents (§0 item 4). Cites the stale
`docs/MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08.md` at `:231`.
**imported_by:** NONE. **Verdict: active, frozen, high value.**

### 1.17 `docs/evidence/historical/` — 28 files, 5,646 lines
**Files whose numbers I independently verified as internally consistent:** `DRAFT_AUDIT_2021_2025.md`
(tier n's, replacement levels, two-sample t's), `MODEL_AUDIT_RUN_7.md` (144 = 35+28+20+38+23,
−16.952 sums), `profitability-baselines.md` §0 run-8 block (matches the manifest to 4 dp),
`PRESEASON_BAND_CALIBRATION.md`, `DRAFT_BOARD_ABSTENTION.md`, `ADP_REPRICE_LATENCY.md`,
`CONSENSUS_WEIGHTS.md`, `PROPS_PLAYER_ENGINES{,_WEEKLY}.md`, `BETTING_PLAYER_ENGINES.md`,
`DRAFT_LOOKAHEAD_VARIANCE.md`, `STAGE_1_RESULTS.md`, `STAGE_2_RESULTS.md`.

**Defect G20-16 (P2) — 17 of 28 historical files carry no "not a work queue" banner, and two of them
are live-voice work queues.**
Banner present (11): `BETTING_CAPABILITY_AUDIT-evidence`, `LIVE_BETTING_FEASIBILITY-evidence`,
`MODEL_ARCHITECTURE_ASSESSMENT…-evidence`, `build-order-measurements`,
`execution-work-through-2026-09-08`, `model-diagnostic-2026-08-26`,
`nfl-model-status-through-2026-08-30`, `path-to-profit-measurements`, `profitability-baselines`,
`session-results-2026-09-07`, `status-narrative-2026-09-02-facts`.
Banner absent (17): `ADP_DISAGREEMENT`, `ADP_REPRICE_LATENCY`, `ANALYST_CONSENSUS_2026_09_06`,
`BETTING_PLAYER_ENGINES`, `CONSENSUS_WEIGHTS`, **`DIAGNOSTIC_2026_09_02`**, `DRAFT_AUDIT_2021_2025`,
`DRAFT_BOARD_ABSTENTION`, `DRAFT_LOOKAHEAD_VARIANCE`, **`DRAFT_RANKER_THEORY_REVIEW_2026_09_06`**,
`MODEL_AUDIT_RUN_7`, `PRESEASON_BAND_CALIBRATION`, `PROPS_PLAYER_ENGINES`,
`PROPS_PLAYER_ENGINES_WEEKLY`, `STAGE_1_RESULTS`, `STAGE_2_RESULTS`,
`platform-audit-2026-08-24-findings` (different, weaker banner).

The two dangerous ones:
- **`DRAFT_RANKER_THEORY_REVIEW_2026_09_06.md`** (76 lines): ten numbered findings each headed
  **"— TONIGHT"**, containing literal replacement code (`:9-21`, `:31-39`, `:45`), exact line
  targets (`draft-assist.js:100-109`, `replace 337-356`, `rankTargets` `427`/`477`), and a closing
  instruction at `:76`: *"Order tonight: 1 → 2 → 3 → 4 → 5, then 6/8/9."* An agent asked to
  "finish the draft ranker work" would apply these patches. Whether they were ever applied is not
  recorded anywhere.
- **`DIAGNOSTIC_2026_09_02.md`** (626 lines): `:12-13` "Everything else is queued in
  `PROFITABILITY_PLAN.md` Priority 0" (that file no longer exists), and §3 (`:124-153`) is a live
  12-item numbered queue whose item 1 is a **spending instruction**: *"upgrade The Odds API
  ($30/month for 20,000 credits), or create a free SportsGameOdds account… Account creation is the
  owner's action."* That instruction was superseded 24 hours later inside the same file at `:272-273`
  ("the SportsGameOdds account is no longer the gating decision") and again by the free book feeds.

**Defect G20-17 (P2) — `DIAGNOSTIC_2026_09_02.md`'s two load-bearing conclusions are computed on a
run the audit register records as FAILED.** `:403` "Audit of the twelve (**run 10**, 323 games,
2022–2023)" and `:559` "On **run 10** (323 games, 22 weeks) the honest answer is stark: every scored
role is shrunk to zero". `2026-09-09/AUDIT-EVIDENCE.md:58` classifies run 10 as
*"Failed | Input/cache mutation blockers after 1 and 22 weeks | Operational failures; **not
independent statistical conclusions**"*. 22 weeks × ~14.7 games = 323 ✓ — it is the failed prefix.
The document does not say so, and `:566` uses the result to redirect the whole program
("which is why the beat-the-close program, not another role, is the path to profit").

**Defect G20-18 (P2) — `BETTING_CAPABILITY_AUDIT-evidence.md:262` republishes a retracted number as
the headline.** It states the 0.813-point / 2.566%-per-bet figure as "**the strongest proven number
in the entire betting apparatus**" on 2026-09-07. `WORK_LOG.md:457-463` retracted 0.813 → 0.289 on
2026-08-27, eleven days earlier, in a file this document lists in its own Method section (`:26-27`).

**Defect G20-19 (P2) — `.env` does not contain `SCHEDULER_DISABLED`, and three documents say it
does.** Checked directly: `.env` is 5 lines, last modified 2026-09-08 23:40, and
`grep -n SCHEDULER_DISABLED .env` returns nothing.
- `execution-work-through-2026-09-08.md:98` "`.env` sets `SCHEDULER_DISABLED=1`" and `:152-155`
  "**resolved: staying set, by your explicit decision** … **do not re-raise it as an open question**."
- `MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08-evidence.md:590` "`SCHEDULER_DISABLED=1` **is set** in
  this project's `.env` by the user's own explicit instruction this same session".
- `profitability-baselines.md` and `DIAGNOSTIC_2026_09_02.md` assume the same.
- `2026-09-09/AUDIT-EVIDENCE.md:635` inspected the file and states the opposite: *"The actual current
  `.env` has no `SCHEDULER_DISABLED` entry."*
This is not cosmetic. The scheduler is what runs the T−60 collector, and `RETURN-TO-CODEX.md:250-265`
records a real frozen packet on 2026-09-10 — impossible under a disabled scheduler. So
`execution-work-through`'s standing "do not re-raise it" instruction would lead an agent to report
prospective collection as blocked when it is running right now.

**Defect G20-20 (P2) — "the historical blind audit" has at least six irreconcilable spread records.**
| Record | Source | Bets | W-L-P | Units | ROI | Seasons |
|---|---|---|---|---|---|---|
| Run 7 | `MODEL_AUDIT_RUN_7.md:50` | 144 | 65-77-2 | −16.952 | −11.77% | 2021-25 |
| Run 8 | `NFL_AUDIT_RUN_8_MANIFEST.json:47` | 113 | 55-57-1 | −6.242 | −5.52% | 2022-25 |
| — | `WORK_LOG.md:816` + `path-to-profit…:246` | 157 | 72-83 | −16.38 | −10.43% | 2021-25 |
| Run 17 | `2026-09-09/AUDIT-EVIDENCE.md:63` | 115 | 55-58-2 | −7.499 | −6.52% | 2022-25 |
| Run 27 | `2026-09-09/AUDIT-EVIDENCE.md:133` | 153 | 72-78-3 | −11.854884 | −7.75% | 2021-25 |
| Run 32 | `IMPLEMENTATION-SUMMARY.md:20` | 156 | 74-79-3 | −11.088 | −7.11% | 2021-25 |
Each is internally consistent (units/bets = ROI in every row). The 157-bet / 72-83 / −16.38u record
and run 27 share 72 wins over the same seasons and weeks, differ by 5 losses and 4.5 units, and no
document reconciles them. Run 8 and run 17 are near-duplicates over the same 831 games with the same
55 wins. **A reader adding any two of these is double-counting.**

**Defect G20-21 (P2) — two stated break-even win rates, never reconciled.**
`WORK_LOG.md:465-468`: *"The real break-even is **51.38%**, not 52.38%… Measured over 11,134 games
carrying real `spread_odds` (2006–2025), only **13.2%** actually were [−110]. A full point of
required win rate is a large share of any realistic edge."* Against `2026-09-09/AUDIT-EVIDENCE.md:20`
and `superseded-plan-2026-09-09.md:38`, both of which use 52.38% as the benchmark and derive the
headline "approximately 4.38-point gap" from it. At 51.38% that gap is 3.38 — 23% smaller. Neither
plan cites or rebuts the measurement.

**Defect G20-22 (P3) — three mean multi-book spread gaps, one dataset family.**
0.813 pts (`WORK_LOG.md:453`, retracted), 0.289 pts on 272 events
(`path-to-profit-measurements.md:109`), 0.225 pts on 652 markets
(`nfl-model-status-through-2026-08-30.md:197`).

**Defect G20-23 (P3) — the component count is 15, 18, 20, 21, 22 or 31 depending on the document,
and the code disagrees with itself.** `server/services/nfl-execution.js:5` says "twenty-two models";
`:15` of the *same comment block* says "twenty-one models nobody had graded". Documents:
15 (`model-diagnostic-2026-08-26.md:297`), 18 (`nfl-model-status…:113`,
`MODEL_ARCHITECTURE_ASSESSMENT…:359`), ~20 (`BETTING_CAPABILITY_AUDIT…:115`), 21
(`WORK_LOG.md:442`, `STAGE_2_RESULTS.md:111`, `path-to-profit…:68`), 21–22
(`BETTING_CAPABILITY_AUDIT…:32`), 31 (`family-contribution…json`). Specialist/role counts run
8 / 12 / 16 / 17 in parallel.

**Defect G20-24 (P3) — `platform-audit-2026-08-24-findings.md` retains an instruction block it
claims to have removed, and all three of its relative links are broken.** `:9-10` says "What was
removed: its proposed backlog, **its P0–P3 phase plan** and its twenty-three per-page roadmap
sections", yet `:26-37` still defines the P0/P1/P2/P3/Quick-win/Design-project legend and instructs
*"For each completed section, Claude should update `CLAUDE_FEEDBACK.md`…"* (a file relocated to
`history/platform-audit-implementation-2026-09-08.md`). The file also ends at `:92` on a bare heading
`# Global product and engineering recommendations` with no body. Links at `:5`, `:11`, `:15` all
resolve one directory too shallow.

**Superseded-but-unmarked list (all in un-bannered files):**
- `DIAGNOSTIC_2026_09_02.md:475-503` — `ratings_vs_open` +0.58 CLV, Holm p<0.01 at the opener.
  The opener path is settled dead for this model; the memory index records mean CLV −2.28 pts.
  This document is the most persuasive-looking positive result in the corpus and carries no
  supersession notice.
- `DIAGNOSTIC_2026_09_02.md:606-616` — `wind_total` +0.47 CLV, 62.1%, Holm p<0.01 on totals, with
  a prescriptive live rule. Totals are outside the current spreads-only mandate.
- `status-narrative-2026-09-02-facts.md:96-106` — nfelo "beats the sportsbooks' opening line even
  more reliably than our own ratings do, and it is now running live alongside them at paper stakes."
- `nfl-model-status-through-2026-08-30.md:207` — "`open_spread` and `open_total` are NULL for all
  15,000 historical rows." Superseded twice: by the 09-02 fix, then by the corruption in §0 item 1.
- `path-to-profit-measurements.md:191-194` Phase 0 — "**Upgrade the Odds API tier** … nothing else
  moves without it." Superseded by the free book feeds (`DIAGNOSTIC_2026_09_02.md:246-273`).

**Claims never verified (from this corpus):**
- `ADP_DISAGREEMENT.md:4-5` cites "~2.57%/bet" to an external memory file
  (`gridiron-nfl-betting-model`), not to any document or artifact in the repo.
- `DRAFT_LOOKAHEAD_VARIANCE.md:290-293` states plainly that `DRAFT_AUDIT_2021_2025.md` "has no
  re-runnable harness … the `scratchpad/audit/` scripts it cites are no longer in the tree." The
  draft audit is the panel behind four downstream fantasy studies and six production code comments.
- `BETTING_CAPABILITY_AUDIT-evidence.md` candidates **#4** (orthogonal/sequential residual ordering
  for fantasy signal families, `:607-626`) and **#5** (scheme discontinuity as a stayer-side
  offseason feature, `:628-647`) were never run — no doc exists for either. #1, #2 and #3 all have
  completed docs. These are the two open fantasy research items in the whole corpus.
- `CONSENSUS_WEIGHTS.md:176-181` and `ADP_DISAGREEMENT.md:31-33` independently recommend the same
  cheap, time-critical action — snapshot ESPN ADP and Sleeper rank per season **now**, because both
  are overwritten in place and "it cannot be backfilled — the only way to have that data later is to
  start keeping it now." Neither appears in the active plan. Every season not captured is
  permanently lost.

### 1.18 `docs/evidence/history/WORK_LOG.md` (894) and `platform-audit-implementation-2026-09-08.md` (185)
Both bannered. WORK_LOG is the origin of G20-21 and G20-22 and of the retraction at `:457-463`.
`:600-615` ("Retained but unwired — this is deliberate") is a model of how to justify keeping
eight importer-less service modules. `platform-audit-implementation` is the cleanest verification
record in the corpus and the only file whose relative links (`:5`, `:9`, `:12`) all resolve.
**imported_by:** `WORK_LOG.md` → `server/services/betting-fantasy-link.js`, `nfl-coaches.js`
(both via the stale `docs/WORK_LOG.md` path; `betting-fantasy-link.js:178` also cites the deleted
`docs/PROFIT_ROADMAP.md §0` as evidence).

### 1.19 `docs/reference/fantasy/` — 8 files, 2,357 lines
These are the live reference docs for shipped fantasy code and are, as a group, the highest-quality
writing in the repo. All eight except `draft-device-runbook.md` are cited by production code.

**Defect G20-25 (P2) — the entire 2026 draft board rests on an explicitly unvalidated substitution.**
`PRESEASON_MODEL.md:406-409`, Known limit #4:
> "**The 2026 board is ESPN's, not FantasyPros'.** The curve was fitted on ECR ranks and is applied
> to ESPN ADP ranks. They order players similarly but not identically, and **this substitution has
> never been validated** — there is no season where both exist in the database with a graded outcome."

The shipped point estimate is the rank→points curve and nothing else
(`SHIPPED_BLEND = {market: 1, structural: 0, model: 0}`, `:208`). For Nick's fantasy-first priority
this is the single largest unquantified risk in the fantasy stack, and it is one sentence deep in a
"Known limits" list.

**Defect G20-26 (P3) — a live board knob its own evidence declines to endorse.**
`preseason-model.js:724` `export const RECOMMENDED_MODEL_BLEND_WEIGHT = 0.2`, consumed at
`draft-assist.js:79,435`. `PRESEASON_MODEL.md:385-391`: *"This is a reduction of an unvalidated knob
toward zero, not a claim that the nudge works: 0 and 0.2 are statistically indistinguishable on this
evidence, and if the choice were being made from scratch 0 would be equally defensible."*
`:359-363` "Nothing is significant on any season, at any weight, in either universe — 0/3 throughout."
`:373-383` shows it is a tight-end effect that monotonically hurts QB and does not touch the
WR 13-36 overvaluation it was implicitly meant to address.

**Defect G20-27 (P3) — the draft advice verifier's own top-1 is a coin flip, and its doc does not
say so.** `DRAFT_ADVICE_VERIFY_LOOP.md` uses `lookahead()` at 200 sims to contradict and retry
Claude's pick. `DRAFT_LOOKAHEAD_VARIANCE.md:201-221` measures that same call across 8 seeds on six
real board states: top-1 agreement **3/8 to 4/8**, `gap/SE ≤ 1` on every mid-draft board, and
explicitly *"There is no n at which a real 1-point difference on a 2,000-point roster becomes a
confident recommendation."* The verify loop's threshold machinery is correctly calibrated to fire
only on gross errors (its own table at `:105-114` shows it catching a round-2 kicker and a
90-spots-down pick while confirming all five genuine candidates) — but its "Known limitations"
(`:234-249`) never states that the underlying ranking is seed-unstable, which is the reason it can
only ever catch gross errors.

**Defect G20-28 (P3) — same-day contradiction on the same endpoint.**
`DRAFT_LOOKAHEAD_VARIANCE.md:264-268` (2026-09-07): *"The repo's '~1s' figure for this endpoint is
stale … should be read as ~2 s, not ~1 s."* `session-results-2026-09-07.md:57-58` (same day) still
prints *"Monte Carlo lookahead (200 sims × 6 candidates, ~1 s)"*.

**Correctly handled and worth protecting.** `OFFSEASON_MODEL.md:279-282` contract rule 4 — *"Do not
apply this on top of a projection that already conditions on the season-`T` depth chart or the
two-year usage trend (§4). Doing so double-counts."* — is honoured: `PRESEASON_MODEL.md:247` records
the team-change/vacated features as "Not used", and the shipped preseason number is a rank-only slot
curve, which is the one prior the multiplier is legitimately additive over
(`OFFSEASON_MODEL.md:207-211`). This is the cleanest consumption contract in the repo.

`DRAFT_CAPTURE_EXTENSION.md:72-77` remains accurate and important: *"Not yet verified against a real
ESPN draft room."* Still true per `session-results-2026-09-07.md:99-103`.
Stale paths inside these files: `DRAFT_CAPTURE_EXTENSION.md:3,41-42,71,73`,
`STAGE_1_RESULTS.md:222`, `ADP_REPRICE_LATENCY.md:3,17,65`, `DRAFT_BOARD_ABSTENTION.md:3,30,183-185`,
`PRESEASON_BAND_CALIBRATION.md:3,25`, `PROPS_PLAYER_ENGINES.md:8`, `PROPS_PLAYER_ENGINES_WEEKLY.md:6`,
`build-order-measurements.md:14,19,318`.

---

## 2. Contradiction list (two documents disagree on the same quantity)

| # | Quantity | Doc A | Doc B | Sev |
|---|---|---|---|---|
| C1 | Run-32 totals ROI | `IMPLEMENTATION-SUMMARY.md:21` −6.10% | `superseded-plan…:133` −6.134629893% | P2 |
| C2 | Line-shopping edge | five values, §0 item 4 | | P2 |
| C3 | Mean multi-book spread gap | 0.813 / 0.289 / 0.225 | | P3 |
| C4 | Break-even win rate | `WORK_LOG.md:465` 51.38% | `AUDIT-EVIDENCE:20` 52.38% | P2 |
| C5 | Same-week leg correlation ρ | `HANDOFF:550` +0.082 | `RETURN:68` −0.044 (and +0.104 from A's own joint/p²) | P2 |
| C6 | Correlation's effect on ticket EV | `HANDOFF:553` "helps" | `RETURN:69` "optimistic by 0.85pp" | P2 |
| C7 | Teaser EV table | `HANDOFF:592` (p=74.76%) | `WORK_LOG:498` (74.69%) / `BCA:467` (+6.51) | P3 |
| C8 | Wong leg rate / family | 1,391@74.69% / 3,015@73.90% / 2,894@74.06% / 74.52% | across 4 docs | P2 |
| C9 | Post-fix suite | `HANDOFF:322` 1,449/0/24 | `slice-final:16` 1472/0/24 (=1496) | P3 |
| C10 | Node version | `2026-09-10/AUDIT-EVIDENCE:8` 24.19.0 | 3 others: 25.9.0 | P3 |
| C11 | `SCHEDULER_DISABLED` | 3 docs "set" | `AUDIT-EVIDENCE:635` + actual `.env`: absent | P2 |
| C12 | `game_lines.open_spread` coverage | `nfl-model-status:207` NULL for all 15,096 | `execution-work…:78` 96–100% 2013+ | P2 |
| C13 | Historical blind-audit record | six variants, G20-20 | | P2 |
| C14 | Stale code comments relocated | `HANDOFF:388` three | measured: 97 across 54 files | P2 |
| C15 | Spread component count | 15/18/20/21/22/31; `nfl-execution.js:5` vs `:15` | | P3 |
| C16 | Fantasy 2025 baseline | pre: Blend 42.10 wins; post: Model 42.12 wins | same commit+hash | P1 |
| C17 | Lookahead latency | `DLV:264` ~2 s | `session-results:57` ~1 s | P3 |
| C18 | TD miscalibration shape | `nfl-model-status:348` "monotonic" | `model-diagnostic:231-238` "S-shaped, sign flips" | P2 |
| C19 | Common-universe economics | `family-contribution.json:32` "EXCLUDED from all three" | same file's `economic` blocks | P2 |
| C20 | 4,060-test max-z 95% quantile | `RETURN:148` 4.44 | computed 4.2124 | P2 |

## 3. Superseded list

**Fully superseded, correctly marked:** `superseded-plan-2026-09-09.md` (header),
`STAGE_2_RESULTS.md:6-12` (self-marks its own table stale), `PROPS_PLAYER_ENGINES.md` (redone by
`_WEEKLY`, which says so at `:6`), `OFFSEASON_MODEL.md` v1 vs v2 (`:25-29`).

**Superseded, NOT marked (the risk list):** `DIAGNOSTIC_2026_09_02.md` §9 (opener CLV) and §13
(wind); `status-narrative…:96-106` (nfelo opener); `nfl-model-status…:207` (open_spread NULL);
`path-to-profit…:191-194` (Odds API upgrade as the blocker); `CODEX-6-HANDOFF.md:502,536,582-587,
617,637-638,452-455`; `DIAGNOSTIC_2026_09_02.md:13` and `profitability-baselines.md:59-64`
(pointers into deleted plans).

**Superseding chain for `game_lines.open_spread`** — the most important single thread in the corpus:
`nfl-model-status…:207` (all NULL, 08-30) → `DIAGNOSTIC_2026_09_02.md:44-47` (ESPN field path fixed)
→ `DIAGNOSTIC_2026_09_02.md:391` + `profitability-baselines.md:404-412` (archive medians backfilled
into blank openers, 2022–2025) → `execution-work-through…:78-80` (coverage now 96–100%; 2021 never
fetched) → `RETURN-TO-CODEX.md:95-105` (2022–2025 non-antisymmetric; "**Any analysis using
`open_spread` for 2022+ is working with garbage**"; apparent line movement inflated ~1.0 → ~5.3
pts/game). **No document connects the third link to the fifth.**

## 4. "Claims never verified" list

1. The ~2.57%/bet line-shopping figure — external memory citation only (`ADP_DISAGREEMENT.md:4-5`).
2. `RETURN-TO-CODEX.md` §4's four measurement claims — no script, no JSON, no DB row, no clone
   (self-declared at `:195-202`).
3. The 3.35pp MDE floor — self-flagged as arithmetically impossible on a 2,894-leg family
   (`RETURN-TO-CODEX.md:157-162`).
4. `DRAFT_AUDIT_2021_2025.md` — no re-runnable harness; cited scripts gone
   (`DRAFT_LOOKAHEAD_VARIANCE.md:290-293`). Four fantasy studies and six code comments depend on it.
5. ECR→ESPN rank substitution for the entire 2026 board (`PRESEASON_MODEL.md:406-409`).
6. `RECOMMENDED_MODEL_BLEND_WEIGHT = 0.2` — 0/3 significant, explicitly "not a claim that the nudge
   works" (`PRESEASON_MODEL.md:385-391`), live in `draft-assist.js:435`.
7. `BETTING_CAPABILITY_AUDIT` transfer candidates #4 and #5 — never run.
8. Run 8's specialist table — recovered from a `.bak`, unreferenced, shares two seasons verbatim with
   run 7.
9. `DIAGNOSTIC_2026_09_02.md` §8/§10 conclusions — computed on run 10's failed prefix.
10. The `family-contribution` challenger counts (`challenger_only: 0` × 5) — produced under the
    known C16 spelling bug.

## 5. Historical docs that could still mislead an agent — ranked

1. `DIAGNOSTIC_2026_09_02.md` — no banner; live 12-item queue; a money instruction; two
   unmarked-superseded positive CLV results; two conclusions on a failed run's prefix.
2. `DRAFT_RANKER_THEORY_REVIEW_2026_09_06.md` — no banner; ten "TONIGHT" items with literal patches
   and line numbers; no record of whether any were applied.
3. `execution-work-through-2026-09-08.md` — bannered, but carries a standing imperative
   (`:152-155` "do not re-raise it as an open question") premised on a `.env` setting that is absent.
4. `MODEL_AUDIT_RUN_7.md` — no banner; `:119-143` "Do these in order" (7-item queue);
   `:180` includes `powershell -ExecutionPolicy Bypass`.
5. `platform-audit-2026-08-24-findings.md` — retains the P0–P3 legend and a "Claude should update
   CLAUDE_FEEDBACK.md" instruction the header says were removed; three broken links; dangling heading.
6. `path-to-profit-measurements.md` — bannered, but Phase 0's "$30/month, nothing else moves without
   it" reads as current and is superseded.
7. `superseded-plan-2026-09-09.md` — 8-line disclaimer over 849 lines of imperatives; 7 broken links.
8. `STAGE_1_RESULTS.md` / `build-order-measurements.md` — gates and targets stated as live
   ("Fantasy MAE < 42.10"), with the frozen baseline that measures them defective (G20-14).

## 6. Mechanical hygiene

- **10 broken relative markdown links** in `docs/` (7 in `superseded-plan…`, 3 in
  `platform-audit-2026-08-24-findings.md`); enumerated in §1.6 and §1.17.
- **97 broken `docs/XXX.md` references in 54 source files** (G20-03).
- **`docs/evidence/2026-09-10/slice1/` is an empty directory.**
- **`implementation-checks.json` duplicated byte-for-byte** across two evidence dates.
- `docs/evidence/NFL_AUDIT_RUN_8_MANIFEST.json` sits at the top of `evidence/` with no dated folder
  and no index entry.

## 7. Open questions for the parent agent

1. Should the `game_lines.open_spread` backfill be re-derived per-row with the away side negated, and
   every result derived from 2022–2025 openers re-labelled per OOF-1 clause 8? (`RETURN-TO-CODEX.md:104`
   says the repair validates at median |difference| = 0.00, n = 347.)
2. Which of the six historical blind-audit records is the canonical one, and can the 157-bet /
   72-83 / −16.38u record be retired or reconciled to run 27?
3. Were the ten `DRAFT_RANKER_THEORY_REVIEW` "TONIGHT" patches applied? Nothing records it.
4. The ESPN-ADP snapshot recommendation (`CONSENSUS_WEIGHTS.md:176-181`) is time-critical and absent
   from the active plan. Given fantasy-first priority, should it be opened now?
5. Should `server/routes/model.js:503`'s 150-player distribution cap be lifted, or at minimum should
   the response report the distribution's own `n`?
6. Should `scripts/freeze-baseline.mjs:35` hash the working-tree diff when `dirty`, so a frozen
   baseline can distinguish "code changed" from "nothing changed"?
