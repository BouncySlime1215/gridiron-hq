# Handoff — Feature audit thread — 2026-09-22

Written 18:05Z on Nick's "save all work" order. Everything named here is pushed
to `origin`. Nothing in this thread lives only on disk.

**Thread:** Feature audit (the fantasy-side sense-check).
**Designated branch:** `claude/project-thread-5f9c3y`, with per-unit branches
suffixed off it (`claude/project-thread-5f9c3y-<unit>`). Ten of those carry
work right now; all ten are listed below with their pushed head.

**Standing brief, still in force:** sense-check the whole fantasy side of the
live app feature by feature across all five leagues at week 2 of 2026;
spot-check against the underlying feeds rather than trusting the app's output;
produce a prioritised list with evidence; fix small unambiguous findings as
draft PRs.

**Scope limits Nick set, verbatim, still in force:**
> "do not deploy to the live app, do not write to league data, and do not touch
> the betting side."

---

## SHIPPED

| PR | merge sha | what it fixed |
|---|---|---|
| **#87** | `0c5b7be` | box/pass-rusher averages were being computed over feed-zero sentinel plays — guarded in v1, v2, and v2's `participation()` satellite. |
| **#115** | `144b722` | `availabilityPicture()` reported "close to healthy" for a team whose injury feed had never loaded. It now reads `nfl_injuries` for that team and season and says "this is a data gap, not a health reading" when there is nothing there. `server/services/football-context.js`; pinned by `test/football-context-injury-availability.test.js` (3 cases). |

Both are on `main` and both are in the deployed tree `c5ee3b54` or later.

---

## OPEN

### #130 — a trade verdict says an unreadable record could not be read
- **Head:** `5b8a345`, base `main` at `c90d2834`, rebased onto the green main.
- **Branch:** `claude/project-thread-5f9c3y-evidence-fault-not-no-record`
- **Gate state:** `npm run check` was **exit 0 on the pre-rebase head `ea03d88`**
  (3546 tests / 3505 pass / 0 fail / 41 skipped). The guard on `5b8a345` was
  **still running when this document was written** — its exit code is not known
  and must not be quoted as green until it reports. `check:wiring` on `ea03d88`
  was exit 1 and proven not this PR's: byte-identical output on base `f620a12`
  (empty `diff`), which #129 has since fixed on `main`.
- **What it is.** When the career-history query behind a trade verdict threw,
  the engine caught it, dropped the field, and printed "a player with no NFL
  record" — the sentence it prints for a genuine rookie — about a five-year
  starter. Pricing was correct throughout, which is what made it believable.
- **Four surfaces, all fixed:**
  1. `describeProfile` (`trade-engine.js:962`) via `headline_read` (`:1001`).
  2. `packageNumbers` (`:1007`) via `verdict_evidence` (`:1039-1040`).
  3. `packageRisk`'s `withRecord = seasons > 0` filter (`:985`), which silently
     dropped an unknown player from the season/top-24/top-12 sums.
  4. **`RiskStrip.tsx:5-6`** on the trade card — found by the audit *after* the
     evidence file wrongly said "Nothing is left uncovered". `floorOf` read
     `seasons === 0` as "no record"; `floorBetter` (`:31-32`) coloured the Floor
     cell from partial sums; and with career *and* preseason both failing the
     whole strip returned null, rendering the failure as nothing at all.
- **Commits (all reachable from `5b8a345`):**

  | stage | sha | subject |
  |---|---|---|
  | RED 1 | `77ccbbc` | a failed career-evidence read is stated as "no NFL record" |
  | GREEN 1 | `6412283` | a career layer that could not be read says so |
  | docs 1 | `48c8eaa` | evidence for the unreadable-career-layer fix |
  | RED 2 | `cc97eb2` | a partly unreadable package reports the readable half as the whole |
  | GREEN 2 | `8b522d1` | the evidence line says how much of a package it could read |
  | docs 2 | `d01a003` | evidence, rounds 1 and 2 |
  | RED 3 | `e7d2a84` | the trade card's Floor cell calls an unreadable package "no record" |
  | GREEN 3 | `389c2ac` | the trade card says which records it could not read |
  | docs 3 | `5b8a345` | RED round 3 and the rebased shas |

- **Counts:** server 11 of 19 fail pre-fix, 19/19 pass; client 5 of 5 fail
  against the untouched `RiskStrip.tsx`, 5/5 pass; 44/44 across the four
  affected test files.
- **Left before merge:** the guard's exit code on `5b8a345`; CI green on that
  head; Evidence Auditor REAL. The PR body still shows the pre-rebase shas and
  needs updating to the table above.

### #122 — strike the trade-engine crash finding (docs only)
- **Head:** `0cac36d`, base `main` at `c90d2834`, rebased and pushed.
- **Branch:** `claude/project-thread-5f9c3y-trade-engine-crash-correction`
- One file: `docs/tdd/football-context-injury-data-gap.tdd.md`. It retracts a
  finding **I got wrong** — I reported `assetUniverse`/`loadRosters`/`freeAgents`
  as hard-crashing on an unsynced league. Tracing the callers showed every one
  validates first (`routes/trades.js`'s `league()` helper; `roster-risk.js`'s own
  `if (!lg?.payload) return { error: 'league not synced yet' }`). My probe used a
  shape no caller produces.
- **Left before merge:** CI green. Docs-only, so it skips the Evidence Auditor.

### #123 — negative-finding audit, roster-risk.js / waiver-brain.js (docs only)
- **Head:** `a36c69c`, base `main` at `c90d2834`, rebased and pushed.
- **Branch:** `claude/project-thread-5f9c3y-roster-risk-waiver-brain-audit`
- One new file. Searched both modules for `availabilityPicture`'s silent-default
  shape and **did not find it** — recorded as a clean negative rather than
  manufacturing a fix.
- **Left before merge:** CI green. Docs-only.

### Earlier open PRs on this thread's branches
All pushed and current as of 18:05Z. These predate today's units and were saved
in this sweep; none has had a guard run on its current head.

| PR | branch suffix | pushed head |
|---|---|---|
| #55 | `consensus-season` | `ae28a81` |
| #62 | `waiver-kdef` | `457aac5` |
| #67 | `byerisk-honest` | `305c612` (unchanged; stacked on `waiver-kdef`, whose PR #62 is still open — the stacking is valid) |
| #74 | `window-honest` | `b5f3996` |
| — | `draft-chain-hold` | `f6f4d79` |
| — | `week-callers` | `1b66a80` |
| — | `draftboard-health-hold` | `759f6cf` (had **no remote branch at all** before this sweep) |
| — | `trend-exploits-usage-blindspot` | `bc03222` (had **no remote branch at all** before this sweep) |

The last two were unsaved work and are the most at-risk items recovered today.
Draft PRs were opened for both in this sweep: **#138** (`draftboard-health-hold`,
head `759f6cf`) and **#139** (`trend-exploits-usage-blindspot`, head `bc03222`).
Neither has had a guard run on its head and both bodies say so.

**Three things a successor must know about #138 and #139, found while opening
them:**

- **#138 is a combined branch, not one unit.** Its first-parent history is four
  commits; the other seven arrive through merge commit `759f6cf`, which merges
  `claude/project-thread-f921do-preseason-layers-hold`. That branch's head
  `615bc08` is **already open as PR #79**, so #138 overlaps #79 substantially.
  Someone has to decide whether #138 is narrowed or #79 closed. Neither was
  touched.
- **#138 and #139 both edit `server/services/trend-exploits.js`** (#138 around
  `:116-150`, #139 adds `primaryUsageTrend` around `:119`). Nothing is broken
  today because neither is merged, but whichever lands second needs a rebase.
- **#139's evidence file has a line that is now false.**
  `docs/tdd/trend-exploits-usage-blindspot.tdd.md` ends "Not pushed — local
  commits only". It *is* pushed as of this sweep. The PR body says so rather
  than the file being edited; fix the file on that branch's next push. The same
  file flags a real unfixed issue on the same source: the
  `rosterTeams.has(team)` exclusion at `trend-exploits.js:245` suppresses
  "avoid" reads for any rival player on a team where you own any other player,
  regardless of position. Judgment call, deliberately left.

**Stale-text sweep done:** #55, #57, #67 and #74 each carried a paragraph saying
"CI is off until October 1 — the repository's Actions minutes are spent and the
workflow is disabled". That is false: CI has been active since 2026-09-22
14:52Z. All four bodies were corrected in place (a body edit, not a push, so no
CI cycle was spent). The true reason those heads show no check runs is that they
are from 2026-09-20 and have not been pushed since — a push is what gets them a
check.

---

## BLOCKED

Nothing is blocked on a person right now. The one blocker this thread had all
afternoon — `check:wiring` red on `main`, which failed every open PR at the gate
step before any test ran — was cleared by **#129**, merged as `c90d2834`.
`npm run check` now includes the wiring gate.

Standing risk that is **not** this thread's to clear: five credentials have been
exposed across three incidents and **zero rotations are confirmed**. Nick
declined rotation at 15:38Z. That decision stands; the risk stays open.

---

## FINDINGS HANDED OFF, NOT BUILT

1. **`pass_rushers` guard sequencing** — owner: whoever takes #87's follow-up.
   #87 parked the guard because `nfl_play_formations` had no dropback
   discriminator. That expires when **#92** merges (migration 070 writes
   `was_pressure` only on dropbacks, `nfl-formations.js:122-127`), and
   `nfl_play_charting` shares the `(game_id, play_id)` PK so it is joinable
   already. **The trap:** `nfl-formations.js:86-88` says pre-070 rows only get
   those columns on re-ingest, so a `was_pressure IS NOT NULL` gate applied
   before a participation backfill would null out essentially the whole history.
   **Correct order: merge #92 → re-ingest participation 2016-2025 → then gate.**
   Queued deliberately; do not build it before #92 lands.
2. **The rig's table inventory** — owner: this thread or its successor. The
   offline rig built from free nflverse `player_stats` CSVs populates only
   `player_week_usage` (11,851 rows, 2023+2024) and `players` (738, **every
   `espn_id` NULL**). Empty: `leagues`, `roster_players`, `nfl_snaps`,
   `nfl_injuries`, `nfl_qbr_weekly`, `nfl_depth`, `player_week_snaps`,
   `nfl_team_week_features`, `nfl_player_week_features`, `nfl_play_formations`,
   `nfl_play_charting`, `dynasty_values`, `player_season_stats`, `nfl_teams`,
   `game_lines`. `nfl_games` does not exist. No 2026 data at all. This is a
   materially larger blindness footprint than the "six blindnesses" shorthand in
   circulation, and anything measured on the rig has to be read against it.
3. **The post-deploy read probe** — owner: coordinator, needs Nick. A probe
   command for `nfl_injuries` on the live database was handed over and its
   result has not come back. Production `nfl_depth` is 0 rows. Until that read
   happens, the injury-data-gap fix in #115 is verified only offline.

---

## RULES AND LESSONS A NEW SESSION MUST KNOW

1. **The cache-fingerprint hazard, and it is a live trap.** `findTrades`' result
   cache is fingerprinted on `manager_profiles`' row **COUNT** and
   **`MAX(updated_at)`** (`tradeIdeasFingerprint`, `trade-engine.js:1478`;
   `fingerprint()` at `compute-cache.js:48-68` reads exactly those two). The
   fixture idiom used across `test/trade-evidence.test.js` to "bust the cache"
   upserts `tradeability` alone, which moves **neither** once the row exists — so
   the second `findTrades` hands back the *same object* as the first. **Two of my
   own new end-to-end tests passed against unfixed code this way.** The fix is
   `reSearch()` in that file: write a strictly increasing explicit `updated_at`
   literal (`datetime('now')` is second-resolution and not reliably distinct),
   and assert **reference inequality** of the two results. Reference identity is
   the only liveness check a fix cannot satisfy by itself — a text or field
   comparison can be satisfied by the very bug under test. Audit anywhere else
   that compares two cached searches.
2. **The silent-inert class is this codebase's signature bug, and it has now
   been found four times.** An empty table read as "healthy" (#115). A thrown
   query read as "never played" (#130, three places). A thrown query read as
   "no record" on the trade card (#130, the fourth). Each time the surrounding
   numbers were correct, which is exactly what made the false sentence
   believable. CLAUDE.md §2 names it: *"If a layer goes inert, the surface must
   say so."* When you find an absence, ask what sentence the UI prints for it and
   whether that sentence is a claim.
3. **Two raw-crash consumers I checked and cleared.** `assetUniverse` /
   `loadRosters` / `freeAgents` take an already-resolved league row and every
   caller validates first. My earlier "hard crash" report was a probe artifact;
   #122 retracts it. Do not rebuild a unit on it.
4. **A test can hold the right reasoning and the wrong assertion.** Twice today.
   `trade-evidence.test.js:173` pinned the swallow CLAUDE.md forbids, under the
   title "a throwing source is **swallowed**". And my own first draft of R2 in
   `test/trade-risk-strip-unreadable.test.js` matched `players.length` anywhere
   inside `floorOf`, which the *pre-fix* one-liner satisfies through its
   empty-package guard — trivially green, caught only by re-running RED against
   the untouched client after relaxing the regex. **Re-run RED after every
   assertion change.**
5. **"Nothing is left uncovered" is a claim, and mine was wrong.** The evidence
   file said three surfaces and the audit found a fourth. It is corrected in
   place, naming the wrong sentence rather than deleting it quietly. Do the same.
6. **Measure before treating, and report negatives.** #123 is a clean negative
   result committed as such. That is the expected output when the bug is not
   there, not a failure to find something.
7. **Fix the implementation, not the test — unless the test is wrong**
   (CLAUDE.md §2). Two tests were changed today under that clause; both changes
   are documented under their own heading in the PR body with the old title and
   line number quoted, so a reviewer sees them without hunting.
8. **Cite RED and GREEN as `#N`, subject, sha; carry the RED's failing assertion
   message inline in the evidence file; update shas in the same push that
   rewrites them** (fleet rule R52.2). The Evidence Auditor checks both shas are
   reachable from the PR head before REAL.
9. **The local gate is `npm run check` alone again** as of #129 — it now includes
   `check:wiring`. Before #129 they were two separate commands and no guard run
   dated before 17:13Z exercised the wiring gate at all.
10. **`switch_model` can report success on an API rejection.** Verify with
    `get_session` and read `last_served_model` / `user_switch_rejected`.
11. **Never print a secret's value** — presence only, never content, into a log,
    a message, or a commit (CLAUDE.md §2).

---

## FILES THIS THREAD OWNS OR HOLDS A GRANT ON

- `server/services/nfl-weekly-feature-store.js` — owned.
- `server/services/football-context.js` — owned (the #115 change).
- `server/services/trade-engine.js` — owned for the `evidence_unreadable` work.
- `client/src/components/trade/RiskStrip.tsx` and the trade-risk lines of
  `client/src/components/trade/types.ts` — **a grant for #130 only**, given by
  the coordinator at 17:51Z, with UI told. Hand these back when #130 merges.
- Test files: `test/football-context-injury-availability.test.js`,
  `test/trade-engine-evidence-fault.test.js`,
  `test/trade-risk-strip-unreadable.test.js`, and the evidence-related tests in
  `test/trade-evidence.test.js`.
- Evidence files under `docs/tdd/`:
  `football-context-injury-data-gap.tdd.md`,
  `trade-engine-evidence-fault-not-no-record.tdd.md`,
  `roster-risk-waiver-brain-silent-default-audit.md`.

---

## NEXT THREE STEPS FOR A SESSION PICKING THIS UP COLD

1. **Read the guard result for `5b8a345`** at `/tmp/claude-0/verify-5b8a345.out`
   if the container still exists, or just re-run
   `bash /mnt/project-files/verify2x-v4.sh 5b8a345 <tag>` and kill RUN 2 — one
   run is the rule. Then **update #130's PR body** to the commit table in the
   OPEN section above (it still shows the pre-rebase shas, which the rebase
   orphaned) and send the head plus the exit code to the coordinator and the
   Evidence Auditor.
2. **Land #122 and #123.** Both are docs-only, both rebased onto `c90d2834` and
   pushed, both skip the Evidence Auditor. They need only CI green. The
   standing-down comments on them about `check:wiring` are now historical —
   #129 fixed that gate.
3. **Do not start a new unit.** The fleet is being cut to five threads plus the
   two auditors and the coordinator will say which continue. The `pass_rushers`
   sequencing above is queued, not assigned, and must not be built before #92
   merges.

---

*Generated by Claude Code — session
https://claude.ai/code/session_01XL5WQkomfhtJ925G1wZ9yr*

---

## ADDENDUM — 18:42Z, hard stop on Nick's order

**Read this paragraph and nothing else from this file to restart me. Everything below is current as of `origin/main` = `b600afa`.**

**Merged by this thread since the last section, all with v2 gate blocks in the body:**
`#122` → `5cca6f2e` · `#123` → `7a9982d4` · `#55` → `624a5d52` · `#62` → `ea69d9f3` · `#130` → `954462ec`.
Guard figures, all `npm run check` exit 0 and worktree-clean: #55 on `143696a` 3601/3560/0/41 · #62 on `01f7273` 3610/3569/0/41 · #130 on `4807e2e` 3614/3573/0/41 · #67 on `a3fc5e7` 3614/3573/0/41. CI was green on each exact head.

**UNMERGED, and the reason matters — do not merge either on the evidence they carry.**
`#67` head `a3fc5e7` (bye-risk `not_modelled`) and `#74` head `7a55f75` (redraft contention window). Both were rebased onto `main` at `6e72271` and were CI-green and guard-green against **that** base. `main` is now **sixteen commits past it** (`#137 #122 #72 #123 #85 #132 #127 #121 #90 #55 #133 #62 #106 #130 #147 #131`). `git merge-tree` says **both still merge into `b600afa` with zero conflicts**, so this is not a conflict problem — it is that their gate evidence was measured against a base main has left behind, which is exactly the failure that cost the fleet an hour on #129. Each needs one merge of current main into the branch, one push, CI on the new head, and one guard run before it can merge. That is two guard runs and I stopped rather than spend them.

**#74 has no guard figure at all.** Its run was still going when the stop came; I killed it and cleaned up the worktree, so there is nothing left to do there — but the batch recorded `window-honest | 7a55f75 | EXIT=NONE | no counts`, which means **no result, not a pass**. Do not read that row as anything but absent. #74 needs a guard run from scratch on whatever base it ends up rebased onto.

**One thing I changed on GitHub that is not in a commit:** `#67`'s base branch still pointed at `claude/project-thread-5f9c3y-waiver-kdef` (#62's branch) even after #62 merged — GitHub did **not** auto-retarget it. I repointed it to `main`. Check the base ref before merging any stacked PR; the list view does not make this visible.

**#130's near-miss, worth carrying as a rule:** the rebase orphaned every RED and GREEN sha its evidence file cited, and I almost merged it that way. R52.2 requires the shas move in the same push that rewrites the commits. Fixed in `a7c7ae5`; guard figure in `44b41cf`. A rebase is not finished until the evidence file's shas move with it.

**Mutation sweeps:** #55 got a full six-row sweep (4 killed, 1 designed survivor, 1 designed not-applied). #130's twelve-row sweep is in its merged body — including M6, which **survived** the first pass because the test grepped `RiskStrip.tsx` instead of running it; extracting and executing `floorOf` killed it. #62 and #67 have **no** sweep and their bodies say so plainly; #62's liveness proof is the Auditor's 8-of-14 failure against unfixed source. #74 has four recorded defect injections in `docs/tdd/contention-window-redraft.tdd.md` but no sweep on the rebased head.

**The sweep harness is now shared and survives this container:** `/mnt/project-files/mutate-run-v1.sh`, with its six-line-per-mutant spec format documented in the header. Never edit it in place — write `mutate-run-v2.sh`. It reports an anchor matching **0 or more than once** as NOT-APPLIED rather than mutating the wrong line; that caught a real trap on #55, where `const season = …` occurs three times in `server/routes/aggregates.js`.

**State at stop:** unsubscribed from PR activity on #67 and #74. I own no triggers — the one enabled Routine, `trig_011nZZwLvza1AqT2LfYuCFwp` (Nick's 30-minute update, next 18:58Z), belongs to the coordinator session and I left it alone deliberately; silencing it would stop Nick's updates.

**Never started, still queued:** the `pass_rushers` unit (re-ingest participation 2016-2025 FIRST, then the `was_pressure IS NOT NULL` gate — `nfl-formations.js:86-88` means gating first nulls essentially the whole history); #138's overlap with #79; and the post-deploy read probe.
