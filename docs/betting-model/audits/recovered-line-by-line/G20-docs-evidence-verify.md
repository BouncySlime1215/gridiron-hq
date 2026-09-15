# Verification of G20-docs-evidence claims (19 total)

All files opened directly (Bash/Read), read well beyond the cited lines. Notes below are organized
by claim key. Line counts read match wc -l for every file opened (2025-baseline.json 121,
2025-baseline-pre-stage1.json 121, nfl-shopping-board.js 429 (relevant sections 1-285),
CODEX-6-HANDOFF.md 638 (370-400, 489-638 read), WORK_LOG.md 894 (440-475, 790-830 read),
DIAGNOSTIC_2026_09_02.md 626 (1-20, 385-420, 550-570 read), execution-work-through-2026-09-08.md 272
(60-160 read), IMPLEMENTATION-SUMMARY.md 321 (1-200 read), family-contribution-2021-2025.json 418
(1-80, 340-410 read), PRESEASON_MODEL.md 463 (180-215, 395-415 read), RETURN-TO-CODEX.md 278 (1-180
read), DRAFT_RANKER_THEORY_REVIEW_2026_09_06.md 76 (full file), model.js 746 (460-520 read),
NFL_AUDIT_RUN_8_MANIFEST.json 66 (full file), profitability-baselines.md 1135 (380-430 read),
AUDIT-EVIDENCE.md (1-70 read), MODEL_AUDIT_RUN_7.md (1-55 read), superseded-plan-2026-09-09.md
(125-140 read)).

## #248 — 2025-baseline.json identity fields (P1 claimed) — REFUTED, corrected P3

Verified as literally true: docs/evidence/baselines/2025-baseline.json:116-119 and
docs/evidence/baselines/2025-baseline-pre-stage1.json:116-119 both show
`commit: 0c2de2c2a9fcd7cfccfa3f6e5e59ddeb73e393bc, dirty: true`, identical dataset_hash, yet
CRPS 34.877→36.412, calibration_error 0.267→0.307, PIT histograms differ, Blend MAE 42.10→42.70,
Gridiron MAE 42.67→42.12. scripts/freeze-baseline.mjs:74-76 confirms the fixed seed and that
`dataset_hash` only hashes `players`/`player_week_usage`, and `dirty:true` in both means the
commit hash cannot distinguish two different working-tree states — a genuine provenance gap.

BUT: docs/evidence/historical/STAGE_1_RESULTS.md (read in full, 1-230) directly and transparently
addresses exactly this. It explicitly demotes the season-total comparison ("Season totals remain a
separately reported product metric, not a veto over weekly evidence"), states the season-total gate
is underpowered/survivorship-biased/wrong-shape (lines 8-16), documents the first-150-player
distribution quirk as "Known limitation #3" ("misleading for a gate decision... the scripts here
use the full set"), and uses the **weekly walk-forward** (4,340 player-weeks) with a paired
bootstrap as the actual Stage 1.3 gate — which passed with CI excluding zero
(MAE delta −0.0215, 90% CI [−0.0403, −0.0036]). That is real, statistically-tested, non-cherry-picked
evidence, not "a comparator move."

Verdict: the raw observation (identical provenance, different numbers) is real and worth a low-grade
flag on freeze-baseline.mjs's provenance capture, but the claim's headline impact ("every Stage-1
improvement claim... comparator move not a model gain," "gate never cleared") is refuted by the
project's own already-published, transparent reasoning and a separately validated statistical
result. Nothing a decision-maker reads is actually misled once STAGE_1_RESULTS.md is read (which
is the actual results document, not the raw JSON pair). Corrected severity: P3.

## #249 — profitability-baselines.md / odds-archive.js causes open_spread corruption (P1) — CONFIRMED, not refuted

profitability-baselines.md:404-409 confirmed verbatim (archive-median opener backfill description).
RETURN-TO-CODEX.md:95-105 confirmed verbatim (antisymmetry table matches exactly: 2019 256/256, 2020
251/251, 2021 272/272, 2022 5/267, 2023 4/285, 2024 1/285, 2025 4/285, 2026 271/271; "Any analysis
using open_spread for 2022+ is working with garbage").

Root cause independently located and verified: server/services/odds-archive.js:138-142 —
```
const r = run(`UPDATE game_lines SET open_spread=COALESCE(open_spread, ?), open_total=COALESCE(open_total, ?)
  WHERE season=? AND week=? AND ((team=? AND opponent=?) OR (team=? AND opponent=?))
    AND (open_spread IS NULL OR open_total IS NULL)`,
openSpread, openTotal, game.season, game.week, game.home, game.away, game.away, game.home);
```
`openSpread` is always the home-perspective median (built from `q.side === q.home` pushes only,
line 116-121) and this single UPDATE applies that same home-perspective value to BOTH the home row
and the away row (the WHERE clause ORs across both team/opponent orderings) without negating for the
away row. This exactly explains the observed antisymmetry signature (home-perspective stored on
both rows) and why it only affects seasons where NULLs existed to backfill (2022-2025) and not
2019-2021 (already populated) or 2026 (live capture, not backfill).

Confirmed no document connects cause to symptom: grepped all docs referencing odds-archive.js
(DIAGNOSTIC_2026_09_02.md, execution-work-through-2026-09-08.md, BETTING_CAPABILITY_AUDIT-evidence.md,
research-packages-2026-09-08.md) — none mention the antisymmetry/home-perspective bug; RETURN-TO-
CODEX.md (which found the bug, 2026-09-11, later than all of these) never cites odds-archive.js or
the backfill mechanism as the cause.

OOF-1 clause 8 ("A backfilled or simulated cutoff is labelled as such on every result derived from
it") is a plausible but not perfect match — clause 8's literal subject is a simulated *decision-time
cutoff*, not a backfilled *data field*; treating the median-opener backfill as an OOF-1 clause-8
violation is a reasonable analogy but a bit of a stretch. This is a minor overreach in an otherwise
very well-supported claim. Kept at P1 given the confirmed, causally-traced, and still-live data
corruption affecting all 2022-2025 opener/line-movement analyses.

## #250 — nfl-shopping-board.js drops books/events (P1) — CONFIRMED, not refuted

server/services/nfl-shopping-board.js:87-93 confirmed: `simultaneousQuotes()` joins on exact
`captured_at` equality against `MAX(captured_at)` per event, dropping any book snapshot with a
different capture instant; line 112 `if (books.size < 2) continue;` drops the whole event below two
books. RETURN-TO-CODEX.md:131-134 confirmed verbatim: "`simultaneousQuotes()` pins each event to its
single newest capture instant, so every slow-tier book is shadowed by a fresher fast-tier row and
disappears from the shopping board entirely — DK, FanDuel, BetMGM, Circa, bet365, Caesars and
BetRivers, almost all of the time." server/services/nfl-execution.js:5-8 confirmed verbatim: "book
hold spans 3.09% at lowvig to 5.54% at betrivers... worth 1.22 points" — and nfl-execution.js:22
imports `simultaneousQuotes` from nfl-shopping-board.js, so the one claimed positive edge is
computed from a book the shopping board structurally excludes. findMiddles (nfl-shopping-board.js:267)
also calls `simultaneousQuotes('spreads')`, confirming the middle-finder inherits the same blindness.
Fully verified, high impact (the project's only claimed positive edge). Kept P1.

## #251 — CODEX-6-HANDOFF.md "three stale comments" vs 97 broken refs (P2) — CONFIRMED, not refuted

CODEX-6-HANDOFF.md:388 quote confirmed verbatim: "Three stale code comments pointing at the relocated
files were updated." Ran the exact grep specified:
`grep -rhoE "docs/[A-Z_0-9]+\.md" server client/src scripts test` → 97 hits, 54 distinct files, 25
distinct targets (one more file/target than the claim's "54 files... 25 distinct targets" — actually
matches exactly: 54 files, 25 distinct targets, 97 total hits). Verified every one of the 25 distinct
targets is missing on disk (`docs/OFFSEASON_MODEL.md`, `docs/PRESEASON_MODEL.md`, etc. — none exist;
the real files live under docs/reference/fantasy/, docs/reference/architecture/, etc. now).
server/services/preseason-model.js:37,54,651,695,722,792 all still reference `docs/PRESEASON_MODEL.md`
(confirmed by grep) which does not exist. Fully confirmed. P2 kept (documentation-only breakage, no
direct money/data-integrity effect, but real risk of a future agent re-running declined work).

## #252 — WORK_LOG.md "sealed" audit 157 bets vs 5 other irreconcilable records (P2) — CONFIRMED, not refuted

WORK_LOG.md:816 confirmed verbatim: "The sealed historical blind audit is complete at 70/70 windows
and 157 bets (72–83, −16.38u, −10.43% ROI)". Cross-checked against:
- AUDIT-EVIDENCE.md run 27 (same seasons/weeks): 153 bets, 72-78-3, -11.854884u, -7.7483% ROI (line 4-10)
- AUDIT-EVIDENCE.md run 17: 115 selections, 55-58-2, -7.499u, -6.52% (line ~63)
- MODEL_AUDIT_RUN_7.md: 144, 65-77-2, -16.952u, -11.77% (lines 12-13, 50)
- NFL_AUDIT_RUN_8_MANIFEST.json: 113, 55-57-1, -6.242u, -5.52% ROI (line 47)
72 wins is shared between WORK_LOG's number and run 27; the claimed "differ by 5 losses and 4.5
units" checks out: 83-78=5 losses, 16.38-11.854884=4.53 units. At least 5 distinct spread-record
numbers exist in the corpus purporting to describe similar/overlapping seasons/weeks of "the"
historical blind audit; genuinely irreconcilable without careful run-ID tracking. AUDIT-EVIDENCE.md
itself warns against exactly this kind of double-counting. Confirmed, P2 kept.

## #253 — DIAGNOSTIC_2026_09_02.md computed on failed run 10 (P2) — CONFIRMED, not refuted

DIAGNOSTIC_2026_09_02.md:403 and :559 confirmed verbatim ("Audit of the twelve (run 10, 323 games,
2022–2023)"; "On run 10 (323 games, 22 weeks) the honest answer is stark: every scored role is
shrunk to zero"). AUDIT-EVIDENCE.md's blind-run register confirmed: "9, 10 | Failed | Input/cache
mutation blockers after 1 and 22 weeks | Operational failures; not independent statistical
conclusions."

Went further than the claim to confirm these are literally the *same* run_id (not a coincidental
reuse of the number "10" across two different audit systems): server/services/nfl-blind-audit.js:855
calls `weeklyExpertAudit(target.season, target.week, { auditRunId: record.id })`, threading the
blind-audit run's own `record.id` into `nfl_weekly_expert_examples.audit_run_id` — the exact table
server/services/nfl-specialist-audit.js:34-37 reads via `MAX(audit_run_id)` to produce the
"specialists/audit" numbers DIAGNOSTIC_2026_09_02.md reports. This is airtight: the specialist audit
and coordinator-v4 shrink-to-zero result are unambiguously computed on the same run the register
later marked an operational failure, and the "beat-the-close program... is the path to profit"
programme redirection (line 566) rests on it without a caveat. P2 kept (a legitimate documentation-
staleness issue that misdirects programme-level reasoning, though not a live money/data-integrity
issue today).

## #254 — .env / SCHEDULER_DISABLED discrepancy (P2) — CONFIRMED, not refuted

execution-work-through-2026-09-08.md:97-98,152-155 confirmed verbatim (".env sets
SCHEDULER_DISABLED=1"; "Resolved: staying set, by your explicit decision... do not re-raise it as an
open question"). Checked .env directly (read-only, via node:sqlite rules not applicable here — .env
is a plain text file, not the DB): 6 lines (ANTHROPIC_API_KEY, ODDS_API_KEY, blank, TWITTERAPI_IO_KEY,
ANTHROPIC_WORKSPACE_ID, AUTO_HEAVY_SYNC=1), last modified 2026-09-08 23:40 (matches claim's "5 lines...
last modified 2026-09-08 23:40" essentially exactly, off by one on blank-line counting convention).
No SCHEDULER_DISABLED line present — confirmed via grep, exit code 1 (no match).
server/services/scheduler.js:1082-1083 confirms this env var is a real, functional gate:
`if (process.env.SCHEDULER_DISABLED === '1') { ...no background jobs will run... }`. Six documents
(not just three) assert it is set: AUDIT-EVIDENCE.md, MODEL_ARCHITECTURE_ASSESSMENT_2026_09_08-
evidence.md, execution-work-through-2026-09-08.md, slice-final/README.md, superseded-plan-2026-09-09.md,
model-governance-manual.md. Given the live server (PID 56651, port 5177) is actively capturing Week 1
T-60 packets right now per the session's own ground truth, the collector clearly is running, which is
only possible if SCHEDULER_DISABLED is not effectively blocking it — consistent with .env's actual
(unset) state and inconsistent with several documents' explicit, standing instruction not to
question it. Confirmed, P2 kept. (Note: did not print the actual secret key values from .env in this
report per basic security hygiene, even though this is a read-only-audit task.)

## #255 — IMPLEMENTATION-SUMMARY.md run-32 totals row wrong ROI (P2) — CONFIRMED, not refuted

IMPLEMENTATION-SUMMARY.md:21 confirmed verbatim: "Total | 48 bets, 23-24-1, -2.945u, -6.13% ROI | 48
bets, 23-24, -2.945u, -6.10% ROI (unchanged...)". Same bet count and same units cannot yield two
different ROI% — confirmed the arithmetic: -2.945/48 ≈ -6.135%, which is much closer to the "-6.13%"
figure than to "-6.10%". superseded-plan-2026-09-09.md:133 confirmed verbatim: "Its totals remain
23/24/1 over 48 bets and −6.134629893% ROI, despite the summary's abbreviated/misrounded table" — an
explicit contemporaneous flag of exactly this error, dated the same day (Sept 10, 14:12 UTC review),
and IMPLEMENTATION-SUMMARY.md as currently read still shows the uncorrected "-6.10%" and the dropped
push (23-24 instead of 23-24-1). Confirmed, P2 kept.

## #256 — BETTING_CAPABILITY_AUDIT-evidence.md republishes retracted 0.813 figure (P2) — CONFIRMED, not refuted

WORK_LOG.md:451-463 confirmed verbatim: original claim "0.813 points on average... worth 2.566% per
bet", followed immediately by "> Correction, 2026-08-27. The 0.813 average did not reproduce...the
mean gap is 0.289 points." BETTING_CAPABILITY_AUDIT-evidence.md:262 (not independently re-quoted here
in full but the claim's snippet is internally consistent with the corpus' known circulating value)
republishes 0.813 as "the strongest proven number in the entire betting apparatus" after the
correction date. Confirmed via grep that WORK_LOG.md is the sole source of the retraction and the
number recurs verbatim in the later-dated audit doc. P2 kept.

## #257 — family-contribution JSON "note" excludes bet-count differences but economic block doesn't (P2) — CONFIRMED, not refuted

family-contribution-2021-2025.json:29-32 confirmed verbatim (the "note" claiming per-variant bet-count
differences are excluded from all three answers). Its `economic.variant_bets` values (Context 263,
Efficiency 112, Market 292, Rating systems 169, Roster availability 202, all against baseline_bets
204) were checked against feature-ablation-2021-2025.json's raw per-variant-universe bet counts
(without:Context 263, without:Efficiency 112, without:Market 292, without:Rating systems 169,
without:Roster availability 202) — numerically identical, confirming the "economic" answer is simply
copied from the un-restricted ablation file rather than recomputed on the declared common universe.
IMPLEMENTATION-SUMMARY.md itself (lines ~159-165) is transparent about this in prose ("The ROI column
is the one to distrust... Its bet count falls from 204 to 112... The apparent profit is the variant
declining to bet, not forecasting better") — confirming the claim's characterization that the prose
is honest but the machine-readable JSON's own "note" field is not. Confirmed, P2 kept.

## #258 — family-contribution JSON challenger_only:0 = fixed C16 bug signature (P2) — CONFIRMED, not refuted

family-contribution-2021-2025.json:350,375,385,399,409 confirmed: `"challenger_only": 0` in all five
families. CODEX-6-HANDOFF.md:317 confirmed verbatim: "featureContracts() read challenger_only while
the registry spells it challengerOnly, so the report saw zero challengers where nine exist."
Independently traced via git (read-only `git log`/`git show`, no state changed): the JSON's producing
commit `27c50e2` ("Answer all three of section 8.6's questions...") is timestamped 2026-09-10
11:13:59 -0400; the C16 fix (server/services/nfl-ensemble.js's `challenger_only: m.challengerOnly ===
true` translation, comment "the registry's own spelling") landed in commit `8d950b0` ("Slice 3:
correct the probabilities...") at 2026-09-10 13:17:05 -0400 — about 2 hours *later*, same day. This
precisely matches the claim's "timestamped 11:11... the C16 fix landed later the same day." Confirmed
with source-level (git-log) proof; no other commit ever touched the JSON file. P2 kept.

## #259 — PRESEASON_MODEL.md ECR→ESPN ADP substitution unvalidated (P2) — CONFIRMED, not refuted

PRESEASON_MODEL.md:406 confirmed verbatim. `SHIPPED_BLEND = { market: 1, structural: 0, model: 0 }`
confirmed (the "What ships" section, market weight 1 = the curve is the entire point estimate).
Board-source switch (ECR 2021-2025, ESPN ADP 2026) confirmed at the "Board source" bullet. This is
disclosed as item 4 of 6 in a "Known limitations" list, not a headline — matches the claim's
characterization exactly. Confirmed, P2 kept (real, high-relevance risk for the imminent/current 2026
draft board, but the doc is honest about it, just not prominent).

## #260 — RETURN-TO-CODEX.md 4.26/4.44 quantile math error (P2) — CONFIRMED, not refuted

RETURN-TO-CODEX.md's single table cell (~lines 145-148) contains, within two sentences of each other,
both "the naive Bonferroni threshold of 4.22" and "for 4,060 independent one-sided tests that quantile
is 4.44" for the *same* m=4060 — a direct internal self-contradiction, since a Šidák/Bonferroni 95%
max-z quantile for m=4060 independent one-sided tests should be ≈4.21 (Šidák: 1-0.95^(1/4060) ≈
1.263e-5 tail ⇒ z≈4.21), consistent with the document's own adjacent "4.22" figure and inconsistent
with its own "4.44" figure. The document's conclusion (max-z 2.87 < 4.21 either way) survives, but the
stated reasoning for withdrawing the "4.26" ceiling is demonstrably numerically wrong, in a document
whose explicit subject is number-trustworthiness. Confirmed, P2 kept.

## #261 — CODEX-6-HANDOFF EV correlation sign vs RETURN-TO-CODEX "family actually bet" (P2) — NOT refuted (moderate confidence)

CODEX-6-HANDOFF.md:551-554 confirmed verbatim. RETURN-TO-CODEX.md:65-68 confirmed verbatim, including
its own bolded framing "the same-week leg correlation has the opposite sign on **the family actually
bet**," which it then ties to the eight-line cross-both family (ρ=-0.044), while attributing the
originally-quoted +0.082 to "the classic six-line Wong window." This creates real tension with
CODEX-6-HANDOFF's own "Standing recommendation: Bet the classic window..." (line 630) — however,
independently reading the production code (server/betting/nfl/strategy/teaser-scan.js:363,369-370;
teaser-leg-rates.js:14-16,159) shows the classic six-line window is coded as `FOLKLORE_WONG_LINES`
("kept only so the comparison can NAME the trap") while `CROSS_BOTH_LINES` (the eight-number family)
is the set actually used for `qualifies`/candidate-selection logic, and alt-spread-import.js:11
describes "the two-team six-point teaser strategy" itself as measured "on eight cross-both numbers."
This supports reading "the family actually bet" as the cross-both family (matching RETURN-TO-CODEX's
own framing) even though the prose "Standing recommendation" text says "classic window" — a real,
document-level ambiguity/inconsistency in this project, not a misreading by the claim. The claim's
arithmetic (2.5pp + 0.85pp ≈ 3.4pp swing on a 3.35pp total edge) is internally consistent with both
source documents' own numbers. Given the genuine textual support for the claim's reading, I did not
refute it, but flag real ambiguity about which family the standing recommendation was written for.

## #262 — CODEX-6-HANDOFF standing recommendation priced from contaminated leg rate (P2) — CONFIRMED, not refuted

CODEX-6-HANDOFF.md:592-597 EV table confirmed verbatim (-110/-115/-120/-130 rows). Lines 576-578
confirmed verbatim ("2025's 99 qualifying legs... is partly manufactured; real lines give 68–70. It
barely moves the 27-year headline (74.69% → 74.52%)"). Recomputed EV using a simple p²×decimal_odds−1
approximation: at p=0.7469, -120 → ≈+2.28% (claim: +2.27%); at corrected p=0.7452, -120 → ≈+1.81%
(claim: +1.81%, exact match) — a ~20.6% relative cut, matching the claim's "cuts the -120 margin by
20%". At p=0.7452, -115 → ≈+3.82% (claim: +3.82%, exact match), confirming "-115 hard stop survives."
The claim correctly uses CODEX-6-HANDOFF's own already-computed corrected rate (74.52%), not RETURN-
TO-CODEX's cross-both-specific 74.06% figure (which would have been an apples-to-oranges family
mismatch) — checked this explicitly since it was the most likely place the claim could be wrong, and
it isn't. Confirmed, P2 kept, math independently verified.

## #263 — WORK_LOG.md 51.38% break-even ignored by two plans (P2) — CONFIRMED, not refuted

WORK_LOG.md:465-468 confirmed verbatim ("The real break-even is 51.38%, not 52.38%... Measured over
11,134 games carrying real spread_odds (2006–2025), only 13.2% actually were"). AUDIT-EVIDENCE.md:20
confirmed verbatim (52.38% break-even assumption). superseded-plan-2026-09-09.md:38 confirmed verbatim
("The approximately 4.38-point gap from this sample's 48% to that illustrative benchmark"). Grepped
all of docs/ for "51.38" — appears only in WORK_LOG.md, confirming neither plan cites or rebuts the
measured figure. Confirmed, P2 kept.

## #264 — DRAFT_RANKER_THEORY_REVIEW_2026_09_06.md unbannered "TONIGHT" work queue (P2) — CONFIRMED, not refuted

Read the entire 76-line file. No "Historical evidence. Not a work queue." banner anywhere (confirmed
via grep across the whole file). Contains ten numbered items, several literally marked "— TONIGHT",
with drop-in JS replacement code and exact line targets (draft-assist.js:100-109, "replace 337-356",
etc.), closing with "Order tonight: 1 → 2 → 3 → 4 → 5, then 6/8/9." Confirmed the exact banner-audit
count: 11 of 28 files under docs/evidence/historical/ carry the banner, 17 do not (exact match to the
claim's "17 of 28"). DIAGNOSTIC_2026_09_02.md also confirmed to lack the banner and to reference
"PROFITABILITY_PLAN.md Priority 0" as an open queue. Checked current server/services/draft-assist.js:
the code has clearly moved on since 2026-09-06 (BENCH_DEMAND values and expectedBest() implementation
differ substantially from what the review describes/proposes), so a blind line-number patch would
likely be caught rather than silently corrupt current code — a mitigating factor not mentioned in the
claim, but doesn't change that "no record exists of whether any were applied" and the banner-omission
finding are both true. Confirmed, P2 kept.

## #265 — server/routes/model.js /accuracy distribution computed on 150 of N players (P2) — NOT refuted, but impact narrowed

server/routes/model.js:497-511 confirmed verbatim: `players_graded: ids.length` (typically 382) while
`for (const id of ids.slice(0, 150))` populates `samples` used for `distribution: gradeDistribution(...)`,
and the response's own `note` says "Every source is graded on the same players" without qualifying
that this applies to the table (point-estimate) rows, not the distribution row. This is the identical
150-cap mechanism also present in scripts/freeze-baseline.mjs (claim #248), and STAGE_1_RESULTS.md's
own "Known limitation #3" independently confirms it: "`/api/model/accuracy` grades distributions on
the first 150 players only. Fine for a live page, misleading for a gate decision. The scripts here use
the full set." That same document also records a real, historical consequence of this exact quirk (a
false ~2% CRPS regression in section 1.1 that "vanished" once graded on the full 382), so this is not
a merely theoretical concern — it has previously produced a wrong research conclusion.

One correction to the claim: it says this affects "Build Order stage 1.2's gate" specifically — 1.2
(added weekly variance sources) and the underlying gate machinery use a dedicated script
(fit-weekly-coverage.mjs) on the full weekly dataset, not this live /accuracy route's season-level
distribution; the actual historical false-conclusion incident was section 1.1, not 1.2. The core
defect (misleading players_graded/note vs. actual distribution sample) and its live-page relevance
stand; the specific "stage 1.2" attribution is imprecise. Kept as not-refuted / P2, with the gate
reference corrected.

## #266 — NFL_AUDIT_RUN_8_MANIFEST.json unreferenced, duplicates run 7 (P2) — CONFIRMED, not refuted

NFL_AUDIT_RUN_8_MANIFEST.json:64 confirmed verbatim ("Recovered read-only from
server/data.sqlite.pre-reset-20260901-135647.bak..."). AUDIT-EVIDENCE.md's register instruction
confirmed verbatim: "The current blind-audit table contains run IDs 9-31... Do not fabricate them."
Confirmed the duplicate rows precisely: run 8's 2023 row (20 bets, 9-10-1, -1.616 units) is byte-
identical to run 7's 2023 row (20, 9, 10, -1.616); run 8's 2024 row (38, 14-24-0, -10.893 units) is
byte-identical to run 7's 2024 row (38, 14, 24, -10.893) — both confirmed via direct file reads.
Confirmed the manifest sits directly under docs/evidence/ (not in a dated/historical subfolder like
almost everything else), and that the only documents referencing its filename are index/reorg-tracking
files (docs/README.md, FOLDER-REORGANIZATION.md, folder-map.csv, model-governance-manual.md) rather
than any analytical document that reconciles its numbers against the audit register. Confirmed, P2 kept.

---

# Summary table

| Key | Refuted? | Corrected severity | Confidence |
|---|---|---|---|
| #248 | Yes (impact overstated) | P3 | 0.75 |
| #249 | No | P1 | 0.85 |
| #250 | No | P1 | 0.9 |
| #251 | No | P2 | 0.9 |
| #252 | No | P2 | 0.85 |
| #253 | No | P2 | 0.9 |
| #254 | No | P2 | 0.9 |
| #255 | No | P2 | 0.9 |
| #256 | No | P2 | 0.75 |
| #257 | No | P2 | 0.85 |
| #258 | No | P2 | 0.9 |
| #259 | No | P2 | 0.8 |
| #260 | No | P2 | 0.85 |
| #261 | No (moderate confidence) | P2 | 0.55 |
| #262 | No | P2 | 0.85 |
| #263 | No | P2 | 0.85 |
| #264 | No | P2 | 0.85 |
| #265 | No (gate-attribution corrected) | P2 | 0.6 |
| #266 | No | P2 | 0.85 |
