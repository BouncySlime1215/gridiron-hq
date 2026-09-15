# Completeness critique of SYSTEM_AUDIT_2026_09_11.md + CLEANUP_PLAN.md

Scope: read SYSTEM_AUDIT_2026_09_11.md (508 lines, in full) and CLEANUP_PLAN.md (212 lines, in full)
end-to-end, then cross-checked every G01-G20 and H01-H06 note file's own stated methodology
(header + "Files read"/"lines_read" sections) against what the two synthesis documents claim about
coverage. This is a critique of the audit's completeness, not a re-audit of the codebase.

lines_read for this pass: SYSTEM_AUDIT_2026_09_11.md 508/508 (wc -l 508), CLEANUP_PLAN.md 212/212
(wc -l 212). Both read in full via the Read tool (two chunks for the audit, one for the plan).
For the reader-note cross-check, every G/H file's header + methodology section was read (not every
line of every note — the note files themselves are the audit's own claimed evidence trail, and the
gap being tested is "does the note's own header admit partial coverage", which lives in the header/
methodology section by construction of how these notes were written).

---

## Gap 1 — Ten of twenty code groups have no primary full-read report on disk; only two
adversarial-verification passes survive, each reading targeted excerpts

The audit's own opening line (SYSTEM_AUDIT_2026_09_11.md:2) claims: "Synthesis of 20 code-group
readers (G01–G20, each independently adversarially verified)." This implies, for every group, a
primary line-by-line reader pass (the one that would make "every number is either quoted from a
reader's direct read of the file/DB" true, per line 2's own promise) plus a verification pass on
top of it.

That pattern genuinely holds for 13 groups — G01, G02, G04, G05, G06, G08, G10a, G12, G13c, G14,
G17, G18, G20 — whose primary note file opens with a "line-by-line audit" / "full system read"
style header and states lines_read == wc -l for its assigned files (spot-checked: G08-nfl-
execution.md:3 "30 files, 8,755 lines, every line read"; G10a-audit-evidence.md:4 "Files: 24 ·
Lines read: 5440"; G09-market-data.md:6 "Files fully read (lines_read == wc -l)").

It does **not** hold for 10 groups, where the file that should be the primary reader note is
itself titled "Verification notes" / "Adversarial verification" and its own "Files read" section
lists targeted excerpts, grep hits, and DB spot-checks rather than full files:

- **G03-routes-betting.md** (head: "Verification notes: G03-routes-betting (9 claims)") — of the
  route files underlying the D.1 P1 unauthenticated-route findings (item 2) and the money-path
  findings (item 3), coverage is: `betting-hub.js` 903 lines, ~308 read (~34%); `edge.js` 532
  lines, ~100 read (~19%); `wong.js` 682 lines, ~170 read (~25%); `nfl-betting.js` **1,874 lines**,
  ~270 read (~14%); `scheduler.js` 1,176 lines, ~50 read (~4%). A second file,
  G03-routes-betting-verify.md, exists but is *also* verify-style with similarly partial coverage
  of the same files — i.e. two independent partial checks, zero full primary read, for the file
  group behind the audit's single largest unauthenticated-route P1 (D.1 item 2, 13 route families).
- **G07-nfl-sim-strategy.md** (head: "Verification notes — G07-nfl-sim-strategy (11 claims)") —
  **no second file exists at all** for this group (confirmed: no `G07-*-verify.md` in the
  directory). This is the sole surviving note for the entire NFL drive simulator / teaser-strategy
  file set. Its own header admits `nfl-drive-sim.js` (1,280 lines) was read only 1-985 ("tail is
  backtest reporting, not needed for these claims" — i.e. lines 986-1280, ~23% of the file, were
  never read by anyone, by this note's own account), and that `teaser-scan.js`, `teaser-leg-
  rates.js`, `teaser-staking.js`, `nfl-espn-pbp.js`, `teaser-season.js`, `nfl-betting.js`,
  `index.js`, and `scheduler.js` were covered only by "targeted regions" / greps. This is the group
  behind five of the D.2 "NFL core model & simulator" mechanics bugs (turnover field-position
  mirroring, half-clock, kneel-window inversion, HFA lump, EP double-transform) — real, cited,
  probably-correct findings, but produced and checked by a single narrow pass with zero
  independent cross-check and an admitted unread 295-line tail in the file most central to the
  group.
- **G09-market-data.md** / **G09-market-data-verify.md** — both verify-style, but the primary-
  named file (`G09-market-data.md`) does claim `lines_read == wc -l` for its six core files
  (book-feeds.js 442/442, nfl-t60-packet.js 459/459, live-edge.js 245/245, polymarket.js 442/442,
  prediction-markets.js 387/387, beat-the-close.js 449/449) — so despite the misleading "verify"
  framing in its own title, this group's coverage is close to genuinely full for its core files.
  Flagging for completeness of the meta-point, not as a coverage risk in its own right.
- **G10b-replay-learning.md** / **-verify.md** — both verify-style; primary-named file states full
  reads for the files behind the highest-priority fantasy P1 (weekly-learning.js 220/220,
  weekly-ensemble.js 41/41) but only targeted ranges (100-199) of player-week-engine.js. Low risk
  given the specific claim, but the group as a whole has no exhaustive primary pass on file.
- **G11-props-players.md** — **no second file exists**. Sole surviving note for the entire
  props/player-matching engine, which underlies three of the audit's P1 defects (D.1 #11, #12,
  #13 — the nflverse-abbreviation vs full-sportsbook-name key mismatch that has silently zeroed
  prop-model matching and league-roster matching since 2026-08-31). No independent verifier ever
  checked this note's claims; no primary line-by-line pass of `nfl-props.js`, `nfl-prop-clv.js`,
  or `td-regression.js` survives on disk.
- **G13a-fantasy-draft-trade.md** — **no second file exists**. Sole surviving note for the fantasy
  draft/trade/lineup engine (`lineup-brain.js`, `trade-engine.js`, `waiver-brain.js`,
  `draft-assist.js`, `draft-ingest.js`, `fantasy-coordinator.js`) — i.e. the single subsystem
  Nick's own standing priority ("fantasy over betting") points at hardest. Every file in it was
  read only in named line ranges (e.g. `lineup-brain.js` "full doc header + lines 250-340" of what
  is presumably a much longer file; `trade-engine.js` 150-260; `waiver-brain.js` 100-190), never
  a stated full read, and never independently re-checked.
- **G13b-player-models.md** / **-verify.md** — both verify-style, but the primary-named file does
  claim chunked-full reads for `projections.js` ("full read in chunks, esp. 1-60, 90-260, 340-560,
  560-750" — note the gaps 60-90, 260-340, and anything past 750 are not listed as covered) and
  targeted regions elsewhere (`offseason-model.js:1610-1932` only, out of a file the audit
  elsewhere cites content from as high as line 1932 — unclear if the full file is longer and
  uncovered beyond that).
- **G15-client-fantasy.md** / **G15-verify.md** — both verify-style; per-claim targeted reads
  (e.g. SourcePill.tsx 79/79 full, draft-capture.js 80/80 full for one claim — good — but this
  pattern is claim-by-claim, not a systematic full-directory sweep of `client/src/pages` and
  `client/src/components` for fantasy).
- **G16-client-betting.md** / **-verify.md** — both verify-style, claim-by-claim (34 claims) with
  ">=80 lines around each cited line" as the verify pass's stated method — i.e. by design, never a
  full-file read, for the entire client betting surface (25 pages + components).
- **G19-docs-plan-vs-code.md** / **-verification.md** — both verify-style; the verification file
  additionally flags (own text) that claim-cited line numbers for `docs/CLAUDE-NEXT-STEPS.md`
  claims #236-240 and #245 are "consistently offset... by roughly +25 to +30 lines" from the
  file's actual current line numbers, attributed to a counting artifact rather than fabrication,
  and "not treated as grounds for refutation." This is a live citation-accuracy caveat that the
  synthesis document does not surface anywhere — a reader of SYSTEM_AUDIT_2026_09_11.md has no way
  to know some `docs/CLAUDE-NEXT-STEPS.md` line citations in the corpus may be off by ~25-30 lines
  (the specific D.1 #24 citation to `docs/CLAUDE-NEXT-STEPS.md:64`, sourced from a *different* claim
  set (#267/#268, checked independently in H01), was separately re-verified byte-for-byte in this
  pass and is accurate — but the general caveat from G19 is still an undisclosed, unresolved
  accuracy risk for any other doc citation drawn from claims #236-240/#245).

**Net effect**: half of the 20 "code-group readers" the synthesis document credits with full,
independently-verified coverage in fact have zero primary full-read note surviving on disk, and in
three cases (G07, G11, G13a) zero independent second check either. The synthesis document never
discloses this distinction — it treats all 20 groups as equally, fully covered.

---

## Gap 2 — Five of six history groups (H01-H05) have no primary chat/git-archaeology note on
disk; only verify-style notes over pre-existing, numbered claims survive

Section C's dated ledger and Section H's plan-vs-code discrepancies are both explicitly sourced to
"H01–H06 chat/git archaeology" (SYSTEM_AUDIT_2026_09_11.md:93, :464). Checking each H-group's own
file header:

- **H01** (`H01-chat-sep11-codex-exec.md`, `H01-chat-sep11-codex-exec-267-268.md`) — both files are
  "Verification notes" over specific pre-numbered claims (#267, #268). No primary archaeology note.
- **H02** (`H02-chat-sep11-scraper.md`) — "Adversarial verification — H02-chat-sep11-scraper (7
  claims)." No primary note; no second verify file either.
- **H03** (`H03-chat-sep10-brief.md`, `H03-chat-sep10-brief-verify.md`) — both verify-style over
  claim set (6 claims). No primary note.
- **H04** (`H04-chat-sep8.md`) — "Verification notes: H04-chat-sep8 (2 claims)." No primary note,
  no second verify.
- **H05** (`H05-git-and-codex.md`) — "Adversarial verification — H05-git-and-codex (4 claims)." No
  primary note, no second verify.
- **H06** (`H06-data-layer.md`, `H06-data-layer-verify.md`, `verifier-H06-data-layer.md`) — the one
  exception: `H06-data-layer.md` is a genuine primary note ("H06 — Data Layer Audit," live DB
  reads, dated observations), backed by *two* independent verify passes. This is the best-attested
  group in the whole corpus.

**Net effect**: the entire "dated ledger" narrative in Section C — commit-by-commit, session-by-
session history from 2026-08-27 through 2026-09-12, including the reconstruction of the 40-agent
self-audit workflow's false "0 hypotheses survive" result and the `live_odds.py` external-tool
narrative — rests on claim numbers (#267-#290-ish) whose originating extraction pass is not present
in this directory at all. What is checkable from the delivered artifacts is only "does the cited
git/file evidence support this specific pre-written sentence," not "was the full chat/git history
for this period read end-to-end and were these the right sentences to write." (Supporting files
`chat_hits.json`, `gitlog.txt`, `extract_chat.py`, `categorize.py` exist in the directory and were
presumably the actual primary-extraction tooling/output — but no prose reader note built from them
survives per H-group, the way G01/G02/etc. have prose notes built from their file reads.)

---

## Gap 3 — Half of the P1 ("wrong money / wrong decision / data-integrity / security") defects in
Section D.1 have no stated exit test, despite the section's own pattern implying every P1 gets one

Of the 24 numbered P1 defects in D.1, **12 have no "Exit test:" sentence at all** — only a "Fix":
items **7** (nfl-t60-packet.js:258, injury receipt-clock), **8** (live-edge.js:204, Polymarket
futures-market collision), **12** (nfl-prop-clv.js:429, settlement key mismatch), **13**
(td-regression.js:310, Trends-page join break), **15** (nfl-ensemble.js:60,602,1247, opener/close
mismatch), **16** (nfl-opening-lines.js:264-333, four-source opener stitching), **17**
(nfl-shopping-board.js:87-93,112, BetRivers-dropping join), **20** (package-release.mjs, DB-in-
release-zip fallback bug), **21** (import-scottfree.mjs:42, dead leakage guard), **22**
(mlb-pregame.js:44-94, post-first-pitch snapshot contamination), **23** (live_odds.py:701-782,
external tool), **24** (docs/CLAUDE-NEXT-STEPS.md staleness + npm test env leakage).

Items 1-6, 9, 10, 11, 14, 18, 19 (12 of 24) do carry an explicit, checkable exit test. This is not
a uniform documentation gap across the whole list — it is a clean 50/50 split with no stated reason
for which items got one and which didn't (e.g. #17, the BetRivers/shopping-board defect, is
arguably the single most financially consequential item in the whole report per the report's own
language — "the module built on the project's only claimed positive edge cannot see the book that
produces it" — yet has no exit test in D.1, though Section I item 8 *does* supply one for it when
it's promoted into the ordered plan. Items 7, 8, 15, 16, 20-24 never make it into Section I at all,
so they have *no* exit test anywhere in either document.)

**Fix location**: SYSTEM_AUDIT_2026_09_11.md, `### D.1 — P1 defects` section, items 7, 8, 12, 13,
15, 16, 17, 20, 21, 22, 23, 24 — add an `**Exit test**:` sentence to each, in the same voice as the
other 12.

---

## Gap 4 — Section I, item 14 (the ensemble opener/close rebuild-evidence item) has no exit test

Every other numbered item in Section I ("What to do now") — 1 through 13 — closes with an explicit
`*Exit test*:` sentence. Item 14 (SYSTEM_AUDIT_2026_09_11.md, line beginning "**Only after 1-13**,
if betting-engine time remains this cycle: fix `nfl-ensemble.js:60,602,1247`'s opener/close
mismatch...") ends instead with "Bring him the evidence (this report) before starting that
rebuild" — no stated, checkable exit condition for the fix itself (e.g. "re-run the RMSE-vs-market
comparison and confirm it moves from 12.840 toward/past 12.448, or document that it doesn't").
Given this is explicitly the one item queued as "the 'rebuild, not a patch' Nick asked for," it is
the item most likely to be picked up next and most in need of a stated definition of done.

**Fix location**: SYSTEM_AUDIT_2026_09_11.md, `## I. What to do now`, item 14.

---

## Gap 5 — Section A's ten-sentence top-line verdict has no MLB sentence

Sentences A.1-A.10 give a one-line verdict for: structure (A.1), wiring (A.2), the money path
(A.3), the fantasy path (A.4), betting's headline finding (A.5), model-vs-wiring framing (A.6),
data organization (A.7), documentation (A.8), "what to do now" (A.9), and the report's own
methodology (A.10). None of the ten sentences mentions MLB, even though: G14 is a full dedicated
1,028-line primary read; the D.2 domain table has 8 MLB-specific rows; and Section I's item 13 —
"Decide, do not silently continue, on MLB" — is one of only two items in the entire 14-item ordered
plan phrased as a decision rather than a code fix (the other being item 1, "push the commits"). A
reader who only reads Section A (a reasonable way to consume a 508-line report) gets zero signal
that MLB odds capture has been off for 11+ days, that ~1,300 boxscore fetches/day are being wasted
for zero output, or that a decision is queued and waiting. This is a direct answer-completeness gap
against the ask "MLB?" — it is answered elsewhere in the document but not in the section designed
to be the one-paragraph answer to exactly that kind of question.

**Fix location**: SYSTEM_AUDIT_2026_09_11.md, `## A. Verdict in ten sentences` — add an eleventh
sentence (or fold into A.4/A.9) naming the MLB odds-capture-off-since-09-01 / wasted-fetch finding
and pointing to Section I item 13.

---

## Gap 6 — CLEANUP_PLAN.md and Section G's disposition table do not flag that they inherit the
Gap-1/Gap-2 coverage risk for the files they propose to move/archive

Several of CLEANUP_PLAN.md's tier-(b) archival candidates — `nfl-prop-player-heads.js` /
`nfl-prop-player-weekly-heads.js` (G11 territory), `nfl-execution-staking-policy.js` /
`nfl-execution-clv-downsize.js` (partially G08, which is well-covered, but cross-referenced against
G07/G03's weaker execution-adjacent coverage for reachability) — rest on "zero importers outside
its own test file" claims whose underlying reachability greps were run by readers/verifiers whose
own coverage of the calling code (routes, scheduler) was itself partial per Gap 1 (e.g. G03's ~4%
read of `scheduler.js`, ~14% read of `nfl-betting.js`). The zero-importer proofs cited
(`grep -rln` commands) are mechanically sound and don't depend on having read every line of the
caller — a grep across the whole tree catches a reference regardless of whether a human read the
surrounding context — so this is a lower-confidence gap than Gaps 1-2, but CLEANUP_PLAN.md never
states that its importer-proofs were run independently of (and are more reliable than) the prose
coverage of the groups that first flagged the files, which would reassure a reader who has just
read Gap 1 above and is now unsure whether *any* claim touching G03/G07/G11/G13a territory is
safe to act on.

**Fix location**: CLEANUP_PLAN.md, top of section `(b)` — one sentence clarifying that every
archive/delete proposal's zero-importer claim is a repo-wide `grep`/`git grep` result (mechanical,
independent of prose read-depth), not a claim resting on the citing group's narrative coverage.

---

## Gap 7 — No claim in either document was found to be missing a path:line citation

Spot-checked Section A (summary, generally exempt by the report's own "every claim below" framing
at line 17), Section C (dated ledger — narrative/historical, not code defects, and each factual
anchor point that matters is independently cross-referenced to a path:line elsewhere, e.g. the
`docs/CLAUDE-NEXT-STEPS.md:64` staleness claim), Section D.1 and D.2 (every one of the 24 P1 rows
and every P2 table row carries a `path:line` in its lead cell; a mechanical check for malformed
table rows — fewer than 4 pipe-delimited cells — in D.2 returned zero hits), Section G (disposition
table, every row has a `Path` cell), and Section H (every numbered discrepancy cites a specific
file, commit, or line). **No defect or fix claim was found lacking a path:line.** This is a
genuine strength of the corpus, not a gap — recorded here so the "unanswered claim" question in the
task brief has an explicit negative result rather than silence.

---

## Gap 8 — Every one of Nick's named top-level questions is answered, but "MLB" and "audits" are
answered only by triangulating across sections, not from a single located answer

Cross-checking the task brief's bracketed list of Nick's asks against the corpus:

- **"structure good?"** → SYSTEM_AUDIT_2026_09_11.md:8 (Section A.1). Direct, single-location
  answer. No gap.
- **"wiring right?"** → SYSTEM_AUDIT_2026_09_11.md:9 (A.2) + Section B.2. Direct. No gap.
- **"what now?"** → A.9 + full Section I. Direct. No gap.
- **"cleanup?"** → Section G (disposition table) + the entirety of CLEANUP_PLAN.md. Direct and
  thorough. No gap.
- **"MLB?"** → answered, but only by assembling Section I item 13 + 8 scattered D.2 rows + one
  Section G "keep, frozen" row; no single verdict sentence (see Gap 5 above — same underlying
  issue, restated here as an answer-completeness gap against Nick's own question rather than a
  structural gap in Section A alone).
- **"audits?"** (meaning: the historical blind-audit-run reconciliation) → answered mainly via
  Section C.1's table (the "at least 6 irreconcilable records" resolution) and A.6, both of which
  are single, locatable answers. Minor gap: this doesn't restate which run (27) is the one to treat
  as canonical going forward in Section A itself — that fact only appears in A.8's aside about the
  README/governance-manual headline and in Section I item 12's exit test ("Run 27/31/32"). A reader
  asking "so which number do I quote" has to infer it from two indirect mentions rather than a
  direct statement. Low-severity version of Gap 5's pattern.
- **"data?"** → Section F, a dedicated section. Direct. No gap.

No top-level question is left entirely unanswered; MLB and (to a lesser degree) audits are the two
that require stitching rather than a single located paragraph.

---

## Summary — subsystem groups that should be re-read (by key)

Ranked by combination of (a) how thin the surviving coverage actually is and (b) how much weight
the synthesis document places on that group's findings (P1 count, whether it's on Nick's fantasy-
first path, whether it's a governance/money-path area):

1. **G13a** (fantasy draft/trade/lineup engine — `lineup-brain.js`, `trade-engine.js`,
   `waiver-brain.js`, `draft-assist.js`, `draft-ingest.js`, `fantasy-coordinator.js`) — zero
   primary full-read note, zero independent verifier, and this is Nick's own stated top priority
   ("fantasy over betting"). Highest-value re-read.
2. **G11** (props/player-matching engine — `nfl-props.js`, `nfl-prop-clv.js`, `td-regression.js`,
   `nfl-prop-player-heads.js` and siblings) — zero primary full-read note, zero independent
   verifier, underlies three P1 defects (D.1 #11-13) plus a CLEANUP_PLAN archive batch (b.4).
3. **G07** (NFL drive simulator + teaser-strategy files — `nfl-drive-sim.js`, `nfl-sim-policy.js`,
   `teaser-scan.js`, `teaser-staking.js`, `teaser-leg-rates.js`) — zero independent verifier, and
   its own note admits an unread 295-line tail (986-1280) of the single most bug-dense file in the
   set (5 mechanics bugs already found in the read portion).
4. **G03** (betting + fantasy routes, especially `nfl-betting.js` 1,874 lines at ~14% read,
   `scheduler.js` 1,176 lines at ~4% read, `betting-hub.js`/`wong.js`/`edge.js` all under 35% read)
   — two partial verify passes, no full primary read, underlying the audit's largest single P1
   (13 unauthenticated route families) and the money-path settlement-fabrication P1.
5. **H01, H02, H04, H05** (chat/git archaeology for the sessions behind the dated ledger in
   Section C and several D.1/H discrepancies) — no primary archaeology note survives for any of
   these four sub-periods; only narrow verify passes over pre-numbered claims exist.
6. **G13b** (fantasy player models — `projections.js`, `offseason-model.js`, `shrinkage-fit.js`)
   — chunked-partial reads with visible gaps between chunks (60-90, 260-340 in `projections.js`;
   unclear coverage of `offseason-model.js` beyond line 1932), no primary full-read note.
7. **G16** (client betting surface, 34 claims, all read as ">=80 lines around the cited line" by
   design — never a full-file or full-directory sweep) — lower priority than 1-6 since its findings
   are mostly P2/labeling issues, not P1s, but it is the single largest claim set in the corpus and
   has the least systematic (as opposed to claim-driven) coverage.

Groups NOT flagged for re-read: G01, G02, G04, G05, G06, G08, G09, G10a, G10b, G12, G13c, G14, G15,
G17, G18, G19, G20, H03, H06 — each either has a genuine primary full-line-count read on file, or
(G09, G10b, G15, G19) a primary-named file that, despite a misleading "verification" self-
description, actually states full or near-full reads of its core files.
