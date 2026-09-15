# Verification notes: G19-docs-plan-vs-code (14 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). All checks done with grep/sed/cat/git (read-only), one read-only `node:sqlite` query of server/data.sqlite (nfl_blind_audit_runs rows 7/27/31/32 only).

## #234 — plan has no row for teasers; scope doc forbids new teaser work
- `grep -ci teaser docs/CLAUDE-NEXT-STEPS.md` -> 0; `grep -ci wong` -> 0. Confirmed.
- docs/reference/architecture/FOLDER-REORGANIZATION.md:11 quote confirmed verbatim: "Do not expand the milestone into new prop, teaser, MLB, or fantasy functionality or evidence gates."
- Teaser code is live and mounted, not dead: server/index.js:107 `app.use('/api/betting/wong', wongRouter)`, :109 `app.use('/api/execution-slate', executionSlateRouter)`. `server/routes/wong.js`, `execution-slate.js`, `betting-hub.js` all reference teaser modules.
- docs/reference/betting/execution-slate.md:46 confirms "Wong teasers | 74.69% per leg over 1,391 legs... +6.51% EV at -110" — numbers in the claim match exactly.
- Judgment: factually solid, but the plan's own scope document (FOLDER-REORGANIZATION.md) explicitly places teasers out of THIS milestone's scope, and plan line 688 says "Do not delete props/fantasy/MLB code just because this project is spreads-only... defer their model improvements unless a demonstrated dependency blocks a spread milestone." So omitting teasers from the corrections/status register is consistent with declared scope, not obviously an oversight. The claim's distinction ("governance of an existing, already-built, +EV result" vs "building new functionality") is a defensible but more editorial argument than a functional defect. Not refuted, but I'd soften severity to P3.

## #235 — tracked .bak-journal file ships in the release zip
- `git ls-files server/ | grep journal` -> `server/data.sqlite.pre-migration-2026-09-11T00-19-06-457Z.bak-journal`. Confirmed tracked.
- .gitignore lines checked: `server/data.sqlite*.bak` (line ~11), `*.sqlite.bak`, `*.pre-migration-*.bak` (lines ~52-53) — all require the path to literally END in `.bak`; the actual filename ends in `.bak-journal`, so none of the patterns match. Confirmed gap.
- docs/CLAUDE-NEXT-STEPS.md:690 (claim said 718, off by ~28 lines but same document/section 12 area): "Generated SQLite DBs, WAL/SHM files, backup journals, private provider payloads, credentials and large runtime artifacts stay out of Git." Confirmed verbatim.
- docs/reference/model-governance-manual.md:71: "15. Commit cohesive verified work. Do not commit database files, keys, cookies, or local secrets." Confirmed (rule 15).
- scripts/package-release.mjs: EXCLUDE set (line 41-44) = `{node_modules, .git, dist, .env, .DS_Store, data, coverage, .vite, client/dist}`; files list built from `git ls-files` (line 169); loop (line 177-179) tests only `top = rel.split('/')[0]` or the full rel path against EXCLUDE. The journal's top segment is `server` (not in EXCLUDE), full path not in EXCLUDE either -> it is copied into the staged release and thus into GridironHQ.zip. Confirmed exactly as claimed (my line numbers: 169/177/179 vs claim's 166-179 — same block).
- README.md:266 (confirmed by direct read): "ESPN cookies and your API key live only in local files (`server/data.sqlite`, `.env`), both git-ignored." Minor imprecision in the claim: README pairs (cookies, API key) with (data.sqlite, .env) as a set, not a strict 1:1 mapping — the API key more plausibly lives in `.env`, not the sqlite DB. The claim's phrasing "that database holds ESPN espn_s2/SWID cookies and the Claude API key" overstates what's in the DB specifically re: the API key. Core point (DB holds sensitive ESPN session cookies, and a journal is a page image of that DB) still stands.
- Not refuted. Strong, code-verified claim; only nitpick is the API-key-in-DB oversell and a citation off-by-~28-lines.

## #236 — stale "nfl-research-lab.js still derives root from ../.." limitation
- Actual text at docs/CLAUDE-NEXT-STEPS.md:90 (claim said 104, off by ~14 but same row, section 0.1 slice-9 row): "...`nfl-research-lab.js` still derives its root from `../..`." Confirmed verbatim (git blame: written by commit 612361b, 2026-09-10 13:58:08).
- server/services/nfl-research-lab.js:7: `import { PROJECT_ROOT } from '../platform/paths.js';` — confirmed; root derivation now goes through server/platform/paths.js, not a `../..` walk. Comment at nfl-research-lab.js:8-14 explicitly documents this was the fix.
- `grep -rln "'\.\./\.\.'" server/services/ server/routes/` -> empty. Confirmed no remaining literal `../..` root derivation.
- test/platform-paths.test.js exists (confirmed via ls).
- server/platform/paths.js:1-27 quotes the plan's own 10.4 passage verbatim as the reason the module was built. Confirmed.
- Commit-order check: `git log --oneline 612361b..56d67b9` = {56d67b9, cbe3e67, be51226} — exactly 3 commits, matching "fixed three commits later." commit 56d67b9 timestamped 2026-09-10 14:13:48, i.e. ~15 minutes after the plan text was written (13:58:08) — same day, later commits. Confirmed.
- Claim also says the same stale sentence is "the source text at section 10.4 line 711" — actual location of that sentence ("`nfl-research-lab.js` computes its root from `../..`...") is docs/CLAUDE-NEXT-STEPS.md:682, not 711 (line 711 is an unrelated slice-9 table row). This specific sub-citation is wrong (off by 29 lines onto different content), though the substantive point (the sentence appears twice, and paths.js quotes it as historical rationale) still holds since 682 does contain the near-identical sentence framed as forward-looking instruction that has since been satisfied.
- Not refuted; solid, git-verified claim; one internal citation (line 711) is inaccurate — the real second occurrence is at line 682.

## #237 — folder-map.csv: claimed 820 dispositions "none undisposed"; actually 829 rows, 34 tracked files missing
- Quote-aware CSV parse (python csv module) of docs/reference/architecture/folder-map.csv: 830 total lines incl. header -> 829 data rows. Confirmed (claim said 829, matches exactly).
- `source_commit` column value counts: `{401a5d0...: 793, fced8d9...: 27, be51226...: 9}` — matches claim's cited breakdown exactly.
- Diff against `git ls-files` (860 tracked files): 34 tracked paths have no row in the CSV at all. Enumerated all 34; verified 31 are teaser/Wong/alt-spread-related (12 Wong client components/pages, 5 teaser strategy files, 1 wong route, 5 teaser tests, 1 alt-spread service, 1 alt-spread test, 1 fanduel fixture, 1 fanduel-lines.mjs script, 1 import-alt-spreads.mjs script, migration 035_alt_spread_capture.js, margin-distribution.js = 31), plus the tracked `.bak-journal` file, plus 2 evidence docs (verification-sweep.txt, RETURN-TO-CODEX.md). Matches claim's "31 of the 34... plus migration 035, the FanDuel scraper and the tracked backup journal" precisely.
- docs/CLAUDE-NEXT-STEPS.md:90 (row 8/required-return-8, actually found at line 90 in the file, claim cited 110): "recomputed to 820 dispositions, none undisposed." Confirmed verbatim text exists (line number differs from claim by 20, but same document/table, section 0.3 "Required returns" table).
- Extremely well-verified claim; not refuted. High confidence.

## #238 — C09's cited evidence file cannot reproduce the headline number; the real reproducing test is unnamed and skips on clean checkout
- docs/CLAUDE-NEXT-STEPS.md:67 (claim said 97, off but same row / C09 correction row): `test/audit-overview-counting.test.js` (10 pass, synthetic packets) cited as evidence for "Run 27's spread record now reproduces independently... 153 bets, 72W/78L/3P, -11.855 units, -7.7% ROI."
- test/nfl-audit-overview.test.js (77 lines total) confirmed to contain: line 15 `const run27Exists = () => row('SELECT status FROM nfl_blind_audit_runs WHERE id=27')?.status === 'complete';`; line 20-29 `test('auditOverview reproduces run 27\'s known spread-only numbers exactly', { skip: !run27Exists() }, ...)` asserting `bets===153, wins===72, losses===78, pushes===3, units≈-11.855`. Confirmed exactly as claimed.
- server/db/index.js:10: `const DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(__dirname, '..', 'data.sqlite');` — test/nfl-audit-overview.test.js imports `../server/db/index.js` with no env override, so it depends on the real dev DB. Confirmed.
- docs/CLAUDE-NEXT-STEPS.md C06 (line 218 area) lists "audit overview tests" explicitly among the files needing hermeticity repair, and states "Some tests import the application's default DB or expect saved audit runs... Do not describe it as 'hermetic and green.'" Confirms the claim's framing that the reproducing test is exactly the C06 problem.
- test/audit-overview-counting.test.js exists separately (confirmed via `find`), distinct file from nfl-audit-overview.test.js — the row cites the wrong/insufficient file for its headline claim.
- Not refuted; very well supported.

## #239 — "highest state reached is connected (C12)" contradicts C12=observed, C03=installed, no row ever says "connected"
- All 17 correction rows' State column scanned directly (sed + manual read): C01-C17 states are all "tested" except C03 = **installed**, C12 = **observed**. Zero rows show "connected." Confirmed exactly as claimed.
- Declared order at docs/CLAUDE-NEXT-STEPS.md:51: "open → implemented → tested → connected → installed → observed → qualified" — installed and observed both rank above connected. Confirmed.
- Not refuted; exact, simple, well-verified claim.

## #240 — C05 evidence cites "30 pass" for test/nfl-execution-edge.test.js; the count never matched
- docs/CLAUDE-NEXT-STEPS.md:63: `test/nfl-execution-edge.test.js` (30 pass)`, citing commits 8d950b0 and 61cde5a.
- `git show 8d950b0:test/nfl-execution-edge.test.js | grep -cE '^\s*(test|it)\('` -> 20.
- `git show 61cde5a:test/nfl-execution-edge.test.js | grep -cE ...` -> 26.
- Current HEAD count -> 26.
- No nested `t.test(` or `describe(` subtests found in the file (grep empty) — flat count is the real count.
- Not refuted; exact match to claim's numbers (20 / 26 / 26 vs cited 30).

## #241 — README presents superseded Run 7 numbers as "the latest sealed historical replay" while runs 27/31/32 are complete and different
- README.md:176 (confirmed via direct read, matches claim's line number and quoted text exactly): "The latest sealed historical replay opened 70 weeks and scored 974 games. Its historical selector produced 144 bets, 65 wins, 77 losses, two pushes, -16.952 units and -11.77% ROI."
- docs/reference/model-governance-manual.md:957-965 ("### 2026-09-01 — council v3 five-season result"): "Run 7 opened all 70 sealed weeks... scored 974 games... The historical selector graded 144 bets at 65 wins, 77 losses, two pushes, -16.952 units, and -11.77% ROI." Exact match — confirms README's numbers ARE Run 7, not a current number.
- Read-only `node:sqlite` query (readOnly:true) of server/data.sqlite, table nfl_blind_audit_runs: id 27 status=complete created_at=2026-09-09 04:15:30; id 31 status=complete created_at=2026-09-09 22:34:55; id 32 status=complete created_at=2026-09-10 07:30:16. All three post-date and supersede Run 7 (2026-09-01). Confirmed.
- C17 (docs/CLAUDE-NEXT-STEPS.md:332-340) files list explicitly includes "root README" and instructs "Update stale inventory counts and incomplete-folder claims," with state = tested (not fully closed on this half). Confirmed as claimed.
- Not refuted; strong, precisely verified claim.

## #242 — governance manual's "Current truth snapshot" dated 2026-09-01 predates runs 27/31/32
- docs/reference/model-governance-manual.md:73 (claim said line 81, off by 8): "## 2. Current truth snapshot — 2026-09-01". Confirmed text exists verbatim, wrong line cited.
- Lines 16-17 rule confirmed: "Status: active working document. Update this file whenever the engine, data contract, audit result, promotion state, or highest-priority research queue changes."
- Section 2.0 (lines 78-82) leads with Audit 8 numbers: 831 games, 113 selections, 55-57-1, -6.242u, -5.52% ROI — matches claim exactly.
- Section 2.1 champion/all-inputs table (lines 101-102): Champion inputs 190 bets, All inputs v3 273 bets — matches claim exactly.
- **Discrepancy found**: claim's "section 11.0.3" as the location of the Run 7 numbers is WRONG. Section 11.0.3 (lines 620-end, "Weekly expert council and robust coordinator") contains no Run 7 data at all — checked full text. The actual Run 7 passage is at lines 957-968, under "### 2026-09-01 — council v3 five-season result", itself under "## 16. Living change log" (section 16, not 11.0.3).
- Core defect (stale snapshot date, three superseded-number sections a reader hits before anything current) is otherwise solidly confirmed. Not refuted overall, but flag the "section 11.0.3" sub-citation as a factual error that should be corrected to "section 16 / the 2026-09-01 change-log entry."

## #243 — manual asserts SCHEDULER_DISABLED is currently blocking capture; it's not set and scheduler is live, T-60 runner already captured
- `grep -n SCHEDULER_DISABLED .env .env.example` -> no matches in either file (only appears in server/services/scheduler.js source as the env-var name itself, lines 1071/1082-1083).
- docs/reference/model-governance-manual.md:811 (claim said 836, off by 25 but same passage): "...'capture 2026 decision/close pairs before kickoff' depends on `SCHEDULER_DISABLED` in `.env`, which the new document explains is currently blocking exactly that." Confirmed verbatim.
- server/services/scheduler.js:1127: `console.warn(\`[scheduler] ${label} tier still running when its next pass was due — skipping this one\`);` (claim quoted this near-verbatim, slightly paraphrased "live tier still running when its next pass was due").
- server/data/launcher-logs/server.log tail (read-only) shows repeated live entries "[scheduler] live tier still running when its next pass was due — skipping this one" dated as recently as today (file mtime Sep 12) — direct proof the scheduler is actively running right now, not disabled.
- Not refuted; exceptionally well-supported, directly observable in the live log.

## #244 — domain-ownership.md claims complete importer-verified classification of server/services but covers only 202/270 files
- docs/reference/architecture/domain-ownership.md:17 (confirmed via direct read, matches claim's line and text exactly): "Every one of the 202 files in `server/services/*.js` below was individually classified..."
- Section headers confirm counts: Fantasy-only (27) [line 72], Betting-only (139) [line 105], Shared-engine (19) [line 250], Bridge (3) [line 275], Infrastructure (14) [line 284]. Sum = 202. Confirmed.
- `ls server/services/*.js | wc -l` -> 270. Confirmed.
- Regex-extracted all backtick-quoted `*.js` basenames from the doc and diffed against actual file list: exactly 68 missing, 0 stale/extra rows for deleted files. Confirmed exact count (claim said 68).
- Verified specific named-missing files claimed: nfl-contract-key.js, nfl-decision-tape.js, nfl-t60-packet.js, nfl-t60-protocol.js all present in the missing-68 list. Counted "nfl-execution-*.js" entries in the missing list: nfl-execution-attribution, -clv-downsize, -clv, -corridor, -decision, -exposure, -lifecycle, -pipeline, -replay, -staking-policy, -stress, -validation = exactly 12. Matches claim's "all twelve nfl-exec[ution]..." precisely.
- Cross-checked docs/CLAUDE-NEXT-STEPS.md section 10.2 (lines 637-664): it assigns explicit new owners/targets to nfl-contract-key.js, nfl-t60-packet.js, nfl-t60-protocol.js, nfl-decision-tape.js, nfl-execution-pipeline.js, nfl-execution-decision.js, nfl-execution-lifecycle.js, nfl-execution-clv.js, nfl-execution-replay.js, nfl-family-contribution.js, nfl-audit-overview.js, nfl-candidate-findings.js, nfl-prospective-collection.js, nfl-research-lab.js — every one of these is in the domain-ownership.md missing-68 list. Confirms "the 68 include every file plan section 10.2 assigns an owner to" is at least true for the sampled/checked files.
- Not refuted; extremely precise, thoroughly cross-verified claim.

## #245 — C11's "one validated schema authority" (forecast-packet.js) has zero production importers, only its own test
- docs/CLAUDE-NEXT-STEPS.md:69 (claim said 99, off by 30 but same C11 row): confirmed row text "§4.1's contract now exists as one validated schema authority... **No forecast consumes it yet**".
- `grep -rn "contracts/forecast-packet.js" server client/src scripts` -> no matches anywhere in production code.
- test/forecast-packet-contract.test.js:20: `await import('../server/betting/nfl/contracts/forecast-packet.js');` — confirmed this is the only reference in the whole repo besides the module itself.
- Sibling module server/betting/nfl/contracts/spread-probabilities.js confirmed to have real production consumers: server/betting/nfl/strategy/teaser-staking.js:245, server/services/nfl-execution-clv.js:40, nfl-execution-edge.js:50, nfl-execution-decision.js:46 (4 real importers) — matches claim's contrast exactly.
- Not refuted; well-supported, and the claim itself correctly notes the row partially discloses this ("No forecast consumes it yet").

## #246 — margin-distribution.js cites a nonexistent test/margin-distribution.test.js twice; zero importers anywhere
- server/betting/nfl/strategy/margin-distribution.js: docstring quote at line ~1573 (claim's cited line) confirmed verbatim: "Every number below is reproduced by `test/margin-distribution.test.js` from the database, so none of them can quietly stop being true." Second occurrence near line 22 area (module header) also references the same nonexistent test file for the negative cross-both finding — confirmed by reading lines 1-30 and 1560-1600.
- `find . -iname "margin-distribution.test.js"` -> no such file. `git log --oneline --all -- test/margin-distribution.test.js` -> empty (never existed in history). Confirmed.
- `grep -rln "margin-distribution" . --exclude-dir=node_modules --exclude-dir=.git` -> only the module's own file path. Broader grep for `marginDistribution`/`MARGIN_MODEL` turned up hits in test/spread-probabilities.test.js, nfl-execution-edge.test.js, nfl-model-fixes.test.js, nfl-execution-attribution.test.js, server/services/nfl-execution-edge.js, nfl-shopping-board.js — but on inspection every one of those references a DIFFERENT, unrelated function also named `marginDistribution()` defined locally inside server/services/nfl-execution-edge.js:91 (name collision, not a real import of the audited file). Confirmed: server/betting/nfl/strategy/margin-distribution.js has genuinely **zero** importers/callers anywhere in the codebase — no route, no scheduler job, no other service, no script, no package.json entry.
- **Reachability verdict**: this module is dead / unreachable in the running app. It exports functions (`fitMarginModel`, `teaserLegProbability`, `coverProbability`, `crossBothReproduction`, `outOfSampleCalibration`, etc.) that nothing calls, and its own concluding `MARGIN_MODEL_VERDICT` block explicitly says "DO NOT SWITCH THE TEASER SCANNER TO THIS" — it appears to be a standalone research/comparison artifact, never wired into any live path (teaser-scan.js, execution-slate, routes, or scheduler all use the empirical `familyRate()` lookup instead, per the module's own text).
- Per the audit's reachability rule ("Dead or unregistered code cannot be P1/P2. Default to refuted=true if unreachable"), I am refuting this claim on reachability grounds even though the underlying factual assertion (false test citation, zero importers) is fully confirmed and accurate. A defect in a comment inside a file nothing calls cannot mislead a "reader of the running app" the way the claim's impact section implies, since nothing in the live system consumes or is even aware of this file's claims.

## #247 — nfl-prospective-collection.js's exported status string asserts two things that are now false
- server/services/nfl-prospective-collection.js:41-43 (claim's cited line 41, confirmed exact match): `export const RESTART_LIMITATION = 'Manual, on-demand collection only — not a background daemon. ' + 'Collection stops the moment this app is closed or the machine sleeps. SCHEDULER_DISABLED is set ' + 'by an explicit operator decision; this function does not depend on it or attempt to change it.'...`
- SCHEDULER_DISABLED confirmed absent from .env (see #243). server/data/launcher-logs/server.log confirmed live-tier scheduler activity as of today. Confirmed both halves of the module's factual claim are stale.
- server/services/scheduler.js:785 `nfl_t60_runner: {`, :788 `import('../betting/nfl/strategy/t60-runner.js'),`, :1094 `'polymarket_line_watch', 'beat_the_close', 'nfl_pick_watch', 'nfl_t60_runner'];` — all three line numbers match the claim exactly. Confirmed a real background collector (nfl_t60_runner) exists and is registered in the boot list.
- Reachability: RESTART_LIMITATION is returned at server/services/nfl-prospective-collection.js:133 as `restart_limitation: RESTART_LIMITATION` from `runProspectiveCollection`, which is imported and called at server/routes/nfl-market.js:35/408, mounted at `/api/nfl-market` per server/index.js:45,105. Confirmed this string reaches the live API surface, exactly as claimed.
- `grep -n "t60\|runner" server/services/nfl-prospective-collection.js` -> empty. Confirmed the module contains no reference to the runner.
- docs/CLAUDE-NEXT-STEPS.md section 7.1 (line 502 area): "`nfl-prospective-collection.js` should report the health and coverage of this real path." Confirmed verbatim — matches claim's characterization of the module's assigned job.
- Not refuted; exceptionally precise claim, every cited line number matched exactly on inspection.

## Summary table

| Claim | Verdict | Confidence |
|---|---|---|
| 234 | Not refuted (soften to P3 — scope doc partially justifies the omission) | 0.55 |
| 235 | Not refuted | 0.9 |
| 236 | Not refuted (minor sub-citation error: line 682 not 711) | 0.88 |
| 237 | Not refuted | 0.95 |
| 238 | Not refuted | 0.92 |
| 239 | Not refuted | 0.95 |
| 240 | Not refuted | 0.95 |
| 241 | Not refuted | 0.93 |
| 242 | Not refuted (sub-citation error: Run 7 data is in section 16, not 11.0.3) | 0.8 |
| 243 | Not refuted | 0.95 |
| 244 | Not refuted | 0.95 |
| 245 | Not refuted | 0.9 |
| 246 | **Refuted** on reachability grounds — module has zero importers/callers anywhere; dead code per the audit's own reachability rule, despite the false-citation content being factually accurate | 0.75 |
| 247 | Not refuted | 0.95 |
