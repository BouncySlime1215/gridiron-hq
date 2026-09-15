# Verification notes — G19-docs-plan-vs-code (14 claims)

Reader: G19-docs-plan-vs-code. Verifier: adversarial, impact lens.
Repo root: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only).

General note on citations: across the docs/CLAUDE-NEXT-STEPS.md claims (#236-240, #245), the
claimed line numbers are consistently offset from the file's actual current line numbers by
roughly +25 to +30 lines (e.g. claim says line 92 for the C05 row, actual is line 63; claim
says line 718 for the git-hygiene rule, actual is line 690). The *quoted text* is verbatim
correct in every case I checked — this reads like the reader counted lines against a slightly
different rendering (possibly counting the file's own internal table-of-contents or frontmatter
differently) rather than fabricating content. I did not treat this as grounds for refutation on
its own since the snippets are exact matches; I flag it because a reader trying to jump to the
cited line number in the real file would land ~25-30 lines low.

## #234 — Wong teaser workstream missing from the plan (P2 claimed)
- `grep -ci teaser docs/CLAUDE-NEXT-STEPS.md` → 0. Confirmed.
- `docs/reference/architecture/FOLDER-REORGANIZATION.md:11` quote confirmed verbatim: "Do not
  expand the milestone into new prop, teaser, MLB, or fantasy functionality or evidence gates."
- Teaser files exist and are substantial: server/services/nfl-teasers.js (291 lines),
  nfl-teaser-execution.js (367 lines), server/betting/nfl/strategy/{teaser-leg-rates,teaser-scan,
  teaser-season,teaser-staking}.js (teaser-staking.js alone is 1,364 lines with real Kelly-sizing
  math keyed to "the owner's DraftKings account" pricing).
- Commit dates: the teaser commits (8659613, d643567, 61cde5a, e867ecc, 03cf3e0) are dated
  2026-09-10 16:44–20:18, interleaved in the SAME commit sequence as the plan's own cited slice
  commits (fced8d9 13:40, 612361b, be51226, cbe3e67, 56d67b9, e802b5a, ... 14c5e65 22:38 = HEAD).
  This is one linear branch (`git log --oneline 401a5d0..HEAD`), not a side branch — teaser work
  landed mid-stream while the plan was being written and never entered it.
- `grep -ci teaser docs/reference/model-governance-manual.md` → 0 as well. Zero governance
  anywhere for this product.
- execution-slate.md:48 confirms the +6.51% EV / 74.69%-per-leg / 1,391-leg figure cited by the
  claim.
- Verdict: CONFIRMED. Real, currently-staking-relevant module (teaser-staking.js explicitly sizes
  bets against a real sportsbook account) with zero mention in either governance document, built
  in direct tension with FOLDER-REORGANIZATION.md's explicit scope prohibition. This is the kind
  of gap that bears on money actually staked. Not refuted. P2 stands.

## #235 — Tracked backup journal ships in the release zip (P2 claimed)
- `.gitignore` lines 8-11, 53: `server/data.sqlite*.bak` and `*.pre-migration-*.bak` — both patterns
  require the filename to end in literal `.bak`.
- `git ls-files server/ | grep journal` → returns
  `server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal` — tracked. Filename ends
  in `.bak-journal`, not `.bak`, so neither ignore pattern matches. Confirmed gap.
- `scripts/package-release.mjs:41-44` EXCLUDE set = {'node_modules','.git','dist','.env',
  '.DS_Store','data','coverage','.vite','client/dist'} — top path segment of the journal file is
  `server`, not in the set. Script builds the release from `git ls-files` (line ~167) and copies
  every file whose top segment isn't excluded (line 179: `if (EXCLUDE.has(top) || EXCLUDE.has(rel))
  continue;`). Confirmed the journal would be copied into the staged release.
- README.md:265-266 confirms: "ESPN cookies and your API key live only in local files
  (`server/data.sqlite`, `.env`), both git-ignored." A SQLite rollback journal is a page-image
  backup of the database it journals, so this is a real credential-adjacent risk if this
  particular database transaction's journal contains sensitive pages.
- Plan's own text (docs/CLAUDE-NEXT-STEPS.md, actual line 23, claimed line 26): "The backup
  journal also shown by Git is a runtime artifact, not source to commit or delete during an
  active backup." — confirms the plan already flagged this file, but never fixed the ignore
  pattern gap.
- Verdict: CONFIRMED, not refuted. Real distribution-artifact risk touching credentials. P2 is
  reasonable (could arguably be P1 given credential exposure, but requires someone to actually run
  package-release.mjs and hand out the zip — I left it at the claimed P2).

## #236 — Slice 9's "still derives root from ../.." is stale (P2 claimed)
- `server/services/nfl-research-lab.js:7`: `import { PROJECT_ROOT } from '../platform/paths.js';`
  — confirmed, no `../..` derivation remains in this file.
- `grep -rln "'\.\./\.\.'" server/services/ server/routes/` → empty. Confirmed.
- `server/platform/paths.js` docstring (lines 1-27) explicitly quotes the plan's own 10.4 passage
  as the historical problem it was built to remove.
- `test/platform-paths.test.js` exists.
- Commit `56d67b9` ("Finish the paths refactor, with the acceptance test that found its own bug")
  landed the fix. Ordering via `git log --oneline 401a5d0..HEAD`: fced8d9 → 612361b (slice 9's own
  commit) → be51226 → cbe3e67 → 56d67b9 (fix) → ... → HEAD 14c5e65. So the fix landed chronologically
  AFTER slice 9 was recorded but well before HEAD, and the plan text was never updated to drop the
  stale caveat even though the current working tree (what a reader actually opens) no longer has
  the described problem.
- Same stale sentence reproduced at docs/CLAUDE-NEXT-STEPS.md line 682 (claimed 711), confirmed
  verbatim: "First fix location assumptions. `nfl-research-lab.js` computes its root from `../..`..."
- Verdict: substance CONFIRMED true — the plan's own stated blocker is stale at HEAD, in two places.
  IMPACT: this is an internal engineering-sequencing note (whether to defer §10.2 file moves). It
  does not change money staked, a recorded decision, data integrity, backtest leakage, or any
  number Nick reads on a page — worst case is wasted future engineering effort (redoing a
  finished refactor, or over-cautiously delaying a move). Per the impact lens, I am downgrading:
  REFUTED (impact, not substance) — corrected_severity P3.

## #237 — Folder map: 829 rows / 34 tracked files missing, not "820, none undisposed" (P2 claimed)
- Quote-aware CSV parse (`docs/reference/architecture/folder-map.csv`): 830 total lines incl.
  header → 829 data rows. Confirmed (plan claims "820").
- `source_commit` distribution: Counter({401a5d0...: 793, fced8d9...: 27, be51226...: 9}) — matches
  claim's evidence exactly.
- Diff against `git ls-files` (860 tracked files): 34 tracked paths have no CSV row at all. Listed
  and confirmed to include: the entire Wong/teaser client tree (10 files under
  client/src/components/betting/wong/ + NflWongHub.tsx), server/routes/wong.js,
  server/betting/nfl/strategy/{margin-distribution,teaser-leg-rates,teaser-scan,teaser-season,
  teaser-staking}.js, server/migrations/035_alt_spread_capture.js, server/services/
  alt-spread-import.js, scripts/fanduel-lines.mjs, scripts/import-alt-spreads.mjs, the tracked
  backup journal from #235, and 5 related test files. Newest source_commit in the CSV (be51226) is
  well behind HEAD (14c5e65) in the linear history.
- Verdict: CONFIRMED, precisely. This is the plan's own "complete path inventory" (§10) that a
  future move-execution pass is told to trust ("Recompute it against any later changes before
  execution" is present, but the register still asserts completeness: "recomputed to 820
  dispositions, none undisposed" at both the slice-9 row and required-return #8). Real risk: a
  move executed off this CSV would silently skip the entire currently-active teaser/execution
  path plus a real migration and a real route file. Not refuted. P2 stands (arguably the
  strongest of the 14 for concrete, reproducible precision).

## #238 — C09's evidence column names the wrong test file (P2 claimed)
- `test/audit-overview-counting.test.js` (confirmed exists): docstring explicitly states these
  run on SYNTHETIC packets, "deliberate," citing C06's own hermeticity requirement. It does NOT
  reproduce Run 27's real numbers — it constructs synthetic runs.
- `test/nfl-audit-overview.test.js` (confirmed exists, NOT cited by the C09 row): line 15
  `const run27Exists = () => row(...WHERE id=27)?.status === 'complete'`; line 22
  `test('auditOverview reproduces run 27's known spread-only numbers exactly', { skip:
  !run27Exists() }, ...)` with assertions `bets===153` (line 26) etc. This is the file that
  actually reproduces the headline number, and it is unnamed in the register.
- Confirmed this file has NO `GRIDIRON_DB_PATH` override (grep returned nothing) and imports
  `server/db/index.js` directly — `server/db/index.js:10` defaults to
  `process.env.GRIDIRON_DB_PATH || .../data.sqlite`, i.e. the developer's real, un-shared DB. On a
  clean checkout without that populated DB, `run27Exists()` is false and every assertion in this
  file is skipped.
- Verdict: CONFIRMED. The register's own closure rule ("A row advances only when the evidence
  column names something that actually demonstrates it") is violated for its single most-quoted
  headline figure (153 bets / 72W-78L-3P / -11.855u / -7.7% ROI, echoed in README.md and cited as
  "matching §1.2 exactly"). This bears on the credibility of the one number most likely to be
  quoted elsewhere in the repo. Not refuted. P2 stands.

## #239 — "Highest state reached is connected" contradicts the register's own table (P2 claimed)
- docs/CLAUDE-NEXT-STEPS.md §0.1 (actual lines 63-75 range): C12 = "**observed**" (line 69 area,
  "C12 sequential capacity path | **observed**"), C03 = "**installed**" (line 61 area). Both above
  "connected" in the plan's own declared order (open → implemented → tested → connected →
  installed → observed → qualified).
- Required return #6 (actual line 104, claimed 108): "This table plus §0.1. **Nothing is
  `qualified`.** The highest state reached is `connected` (C12)." — confirmed verbatim. No row in
  §0.1 is literally "connected" (scanned all 17 C-rows).
- Verdict: substance CONFIRMED — self-contradictory cell. IMPACT: this UNDERSTATES progress in a
  summary cell; it does not overstate readiness, misrepresent a bet, misstate a dollar figure, or
  corrupt any data/backtest. A cautious understatement of internal software-maturity state is low
  consequence. REFUTED on impact grounds — corrected_severity P3.

## #240 — C05's "30 pass" never matched test/nfl-execution-edge.test.js at any commit (P2 claimed)
- Counted `^test\(` occurrences directly from git blobs (avoids commit-object path syntax
  pitfalls): 8d950b0 → 20; 61cde5a → 26; HEAD → 26. No nested `.test(` subtests found in any
  version (`grep -c "\.test("` on the 61cde5a blob → 0 beyond the top-level `test(` calls).
- Verdict: CONFIRMED — the "(30 pass)" figure cited in the C05 evidence column has never been
  correct. IMPACT: this is a citation/count error in the planning register about a currently-live
  execution-pricing module (nfl-execution-edge.js feeds real staking/shopping decisions), but the
  miscount itself changes no code behavior, no staked amount, and no number displayed anywhere to
  Nick — it only weakens confidence in the register's self-verification. Per the impact lens
  (paperwork error, not a functional or displayed defect) I am downgrading: REFUTED (impact),
  corrected_severity P3.

## #241 — README presents superseded Run 7 numbers as "the latest sealed historical replay" (P2 claimed)
- README.md:174-179 (actual line ~174, claimed 176 — close): "The latest sealed historical replay
  opened 70 weeks and scored 974 games. Its historical selector produced 144 bets, 65 wins, 77
  losses, two pushes, -16.952 units and -11.77% ROI." Confirmed verbatim.
- docs/reference/model-governance-manual.md:957-968 attributes exactly these figures (974 games,
  144 bets, 65-77-2, -16.952u, -11.77% ROI) to "Run 7" dated 2026-09-01.
- Read-only DB query (`node:sqlite`, readOnly:true) confirms runs 27 (created 2026-09-09 04:15),
  31 (2026-09-09 22:34), 32 (2026-09-10 07:30) are all `status = 'complete'` — i.e. real, later,
  sealed runs exist, and the plan's own canonical figures (§1.2) are 153 bets/-7.75% ROI (run
  27/31) and 156 bets/-7.11% ROI (run 32), materially different and less pessimistic than what
  the README shows.
- `docs/CLAUDE-NEXT-STEPS.md` C17 row (line 75 area) lists files "docs/README.md, root README and
  old planning files" and its close criteria (line ~336) literally says "Update stale inventory
  counts and incomplete-folder claims." C17 is marked `tested` in §0.1.
- Verdict: CONFIRMED. This is literally "a number Nick reads on a page" (the root README) that is
  stale and materially more pessimistic than the plan's own canonical figures, under a correction
  marked closed. Not refuted. P2 stands.

## #242 — Governance manual's "truth snapshot" predates runs 27/31/32 (P2 claimed)
- `## 2. Current truth snapshot — 2026-09-01` confirmed at line 73 (claimed 81).
- Update rule confirmed at lines 15-16 (claimed 16-17): "Status: active working document. Update
  this file whenever the engine, data contract, audit result, promotion state, or highest-priority
  research queue changes."
- Section 2.0 (Audit 8: 831 games/113 selections/-6.242u/-5.52% ROI) and 2.1 (champion/all-inputs
  190/273-bet table) confirmed present and confirmed to predate runs 27/31/32.
- One correction to the claim's own citation: Run 7's figures actually appear under
  `### 2026-09-01 — council v3 five-season result` (line 957), which sits inside "## 16. Living
  change log," NOT under "### 11.0.3" as the claim states (11.0.3 is a different, unrelated
  subsection: "Weekly expert council and robust coordinator," line 620). The claim's section
  number for this specific figure is wrong; the figures, dates, and overall "the manual is stale
  relative to runs 27/31/32" argument are otherwise fully verified.
- Verdict: CONFIRMED in substance (stale reference document, verified update rule, verified DB
  dates) despite one wrong subsection citation for where Run 7 lives. Same unclosed-C17 mechanism
  as #241. Not refuted. P2 stands.

## #243 — Governance manual falsely claims SCHEDULER_DISABLED is currently blocking capture (P2 claimed)
- `grep -n SCHEDULER_DISABLED .env .env.example server/services/scheduler.js
  docs/reference/model-governance-manual.md` → present only in scheduler.js (code) and the
  manual's own line 811 (claimed 836) prose; NOT present in `.env` or `.env.example` at all.
- `.env` exists (304 bytes) but contains no SCHEDULER_DISABLED entry.
- `server/services/scheduler.js:1082`: `if (process.env.SCHEDULER_DISABLED === '1') { ... }` — an
  explicit opt-in flag, unset by default.
- `server/data/launcher-logs/server.log` tail shows repeated live lines: "[scheduler] live tier
  still running when its next pass was due — skipping this one" — the scheduler is actively
  running, not disabled.
- Confirmed `docs/CLAUDE-NEXT-STEPS.md` never mentions SCHEDULER_DISABLED at all (`grep` returns
  nothing) — so the manual's own claim that "the new document explains [it] is currently blocking
  exactly that" cites a document that says no such thing.
- Plan's own C12 row and slice-5 exit evidence separately confirm a real frozen T-60 packet
  already captured (SF@LAR, 2026-09-10) via the live `nfl_t60_runner` — consistent with the
  scheduler actually running, not blocked.
- Verdict: CONFIRMED, and worse than the claim states in one respect — it's not just stale, the
  cross-reference to "the new document" is itself fabricated (that document never discusses this
  flag). This is exactly the kind of operational misinformation that could cause someone to try to
  "fix" or discount a system that's actually live during NFL Week 1. Not refuted. P2 stands.

## #244 — domain-ownership.md classifies 202 of 270 services, omitting the whole execution path (P2 claimed)
- `ls server/services/*.js | wc -l` → 270. Doc's own section header counts: Fantasy(27) +
  Betting(139) + Shared(19) + Bridge(3) + Infra(14) = 202. Confirmed both totals.
- Regex-extracted every backtick `*.js` basename referenced anywhere in the file's listing
  sections (before "## Coupling points") → 202 unique names, matching the stated total exactly
  (i.e., no double-counting or stale rows).
- Diff against actual `server/services/*.js` basenames → exactly 68 missing, matching the claim's
  count precisely. Missing set includes nfl-contract-key.js, nfl-decision-tape.js,
  nfl-t60-packet.js, nfl-t60-protocol.js, nfl-research-lab.js, nfl-audit-overview.js,
  nfl-candidate-findings.js, nfl-prospective-collection.js, and — counted directly — exactly
  twelve `nfl-execution-*.js` files (attribution, clv-downsize, clv, corridor, decision, exposure,
  lifecycle, pipeline, replay, staking-policy, stress, validation), matching the claim's "all
  twelve nfl-exec..." verbatim.
- Doc's own stated purpose (lines ~33-38, claimed 36-42) confirmed: "a future session ... can look
  up 'is this fantasy, betting, or shared' ... so new code knows where to actually reach for
  cross-tree information instead of guessing from a name."
- Verdict: CONFIRMED, precisely — and this is materially serious: the entire unclassified set is
  exactly the live spread-execution/decision path (the same path §10.2 of the plan assigns
  explicit new owners to), which is the single highest-risk area for a wrong-tree import this
  document exists to prevent, and it happens to be completely blank. Not refuted. P2 stands.

## #245 — C11's "one validated schema authority" has zero production importers (P2 claimed)
- `grep -rn "contracts/forecast-packet.js" server client/src scripts` → empty (zero production
  consumers). Only reference anywhere is `test/forecast-packet-contract.test.js:20`.
- Sibling module comparison: `contracts/spread-probabilities.js` has 4 real production consumers
  confirmed by grep: server/betting/nfl/strategy/teaser-staking.js, server/services/
  nfl-execution-edge.js, nfl-execution-decision.js, nfl-execution-clv.js (plus 2 test files) —
  matches the claim's contrast exactly.
- Verdict: substance CONFIRMED — "exists as one validated schema authority" is an overstatement
  for a module nothing produces into or consumes from. HOWEVER the claim itself concedes the same
  row's limitation cell already discloses the adjacent fact ("No forecast consumes it yet"), so
  this is a partially self-disclosed overstatement, not a hidden one, and it concerns an internal
  architecture/testing-completeness claim rather than money staked, a recorded decision, data
  integrity, backtest leakage, or a displayed number. REFUTED on impact grounds — corrected_
  severity P3.

## #246 — margin-distribution.js cites a test file that has never existed (P2 claimed)
- `grep -rln "margin-distribution" . --exclude-dir=node_modules --exclude-dir=.git` → only the
  module itself (server/betting/nfl/strategy/margin-distribution.js). Zero importers anywhere.
- `ls test/margin-distribution.test.js` → No such file. `git log --oneline --all -- test/
  margin-distribution.test.js` → empty (never existed at any commit).
- `git log --oneline --all --diff-filter=A -- server/betting/nfl/strategy/margin-distribution.js`
  → first appears at HEAD commit 14c5e65.
- Both cited false-provenance lines confirmed verbatim: line 22 ("...asserted in
  `test/margin-distribution.test.js`: on the eight lines the scanner actually bets, this model is
  BEATEN out of sample...") and line 1573 ("Every number below is reproduced by
  `test/margin-distribution.test.js` from the database, so none of them can quietly stop being
  true.") — both exact-line citations from the claim are correct here (unlike the
  CLAUDE-NEXT-STEPS.md claims, this one's line numbers are precise).
- Verdict: CONFIRMED. Module is not yet wired into any live path (zero importers), so there is no
  immediate staking impact from a wrong number being used today, but the false test citation
  attaches specifically to the module's central negative finding (that this fitted model is beaten
  by the empirical lookup on exactly the eight lines the live teaser scanner bets) — i.e., it's
  evidence-integrity for a decision that bears directly on the one confirmed +EV product in the
  repo (teasers, see #234). Not refuted. P2 stands.

## #247 — nfl-prospective-collection.js's exported status string is false and reaches the UI (P2 claimed)
- `server/services/nfl-prospective-collection.js:41`: `RESTART_LIMITATION` string confirmed
  verbatim, including "SCHEDULER_DISABLED is set by an explicit operator decision."
- `.env`/`.env.example` confirmed to have no SCHEDULER_DISABLED entry (see #243); server.log
  confirms the scheduler is actively cycling, not disabled.
- `grep -n "t60\|runner" server/services/nfl-prospective-collection.js` → no matches — the module
  makes no reference to `nfl_t60_runner`, the actual restartable background collector registered
  in `server/services/scheduler.js:785` (`nfl_t60_runner: { ... import('../betting/nfl/strategy/
  t60-runner.js') ... }`) and included in the boot list at scheduler.js:1094. That runner has
  already frozen a real prospective packet (SF@LAR, per the plan's C12 row).
- `restart_limitation: RESTART_LIMITATION` is returned at line 133 from `runProspectiveCollection`.
- Confirmed reachable from the UI: `client/src/pages/DataHealth.tsx:191,255` types and renders
  `result.restart_limitation` directly under the manual-collection button's result.
- Verdict: CONFIRMED. This is literal text a person (Nick, or an operator monitoring during NFL
  Week 1) reads on a live status page, asserting a scheduler brake that is not engaged and
  omitting the one restartable background job (`nfl_t60_runner`) that is running and has already
  captured real evidence. Squarely within the "number/status Nick reads on a page" impact bar.
  Not refuted. P2 stands.

## Summary of severity adjustments
Confirmed accurate AND materially impactful (P2 retained): #234, #235, #237, #238, #241, #242,
#243, #244, #246, #247 — 10 of 14.

Confirmed accurate but impact-downgraded to P3 (internal-planning/self-disclosed/paperwork
issues that touch no staked money, no recorded decision, no data integrity, no backtest leakage,
and no number displayed to Nick): #236, #239, #240, #245 — 4 of 14.

No claim in this set was found to be factually wrong; every snippet quoted checked out verbatim
against the file at HEAD (one wrong subsection cross-reference in #242, which does not affect the
substance). None were refuted on the facts — only on impact, per the assigned lens, for the four
noted above.
