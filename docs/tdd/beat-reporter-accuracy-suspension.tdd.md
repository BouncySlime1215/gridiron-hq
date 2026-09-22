# TDD evidence: suspension, the fourth beat-reporter claim type (2026-09-22)

**Item:** Self-directed unit, picked after the paid-run-guard detour (PRs #109, #117) and
stated to the coordinator before starting (17:05Z). `suspension` is the third of the four
claim types PART 5 asks Coach's source-map to score (`injury_status`, `role_change`,
`return_from_injury` already shipped; `transaction` deliberately not attempted — it needs a
roster/ownership-change ground-truth read, not a played/did-not-play one).
**Files:** `server/services/beat-reporter-accuracy.js` (new exports
`classifySuspensionDirection`, `resolveSuspensionClaim`, `resolveSuspensionClaims`; header
comment updated — `transaction` is now the only remaining unattempted type);
`test/beat-reporter-accuracy.test.js` (12 new tests).
**Source:** `beat-reporter-accuracy.js:375-465` (this unit, after the vocabulary fix in §5);
`:128-149` (`playedOrNot`, the shared ground-truth helper reused unchanged); `:236-241`
(`classifyReturnDirection`, the sibling classifier this one's shape follows); PART 5 (Nick's
ask: "Score sources historically... whose reports actually predicted outcomes").
**LLM spend:** $0.
**Environment:** cloud box, isolated temp SQLite per test file; real-data hand-check used
the session's already-downloaded free nflverse 2025 CSVs (`snap_counts_2025.csv`,
`games.csv`) via a scratch script, not committed to the repo.

## 0. RED / GREEN citation (fleet rule, Auditor R52.2)

Both shas below are reachable from PR #90's head.

| stage | PR | commit subject | sha |
|---|---|---|---|
| RED | #90 | `test: RED — suspension, the fourth beat-reporter claim type` | `03da7fd6` |
| GREEN | #90 | `feat: GREEN — suspension, the fourth beat-reporter claim type` | `9e1a931b` |
| follow-up fix (§3) | #90 | `fix: two real vocabulary bugs in the suspension classifier, found by hand-check` | `e89f2e03` |

**RED's failing assertion, verbatim**, reproduced by checking out `03da7fd6` in an isolated
worktree and running the test file against it — 58 tests, 46 pass, **12 fail**, every one of
them with:

```
not ok 39 - classifySuspensionDirection reads suspension language as suspended
  location: 'test/beat-reporter-accuracy.test.js:613:1'
  failureType: 'testCodeFailure'
  error: 'classifySuspensionDirection is not a function'
  code: 'ERR_TEST_FAILURE'
  name: 'TypeError'
```

The same `TypeError: … is not a function` for `resolveSuspensionClaim` and
`resolveSuspensionClaims` accounts for the other 11. At `9e1a931b` the same file runs
58/58 pass, 0 fail.

A second, **behavioural** RED sits inside this unit at the vocabulary fix (`e89f2e03`): the
three real-wire sentences in §3's table produced wrong or absent directions against
`9e1a931b`'s code — including one confidently wrong answer — and pass against `e89f2e03`.
That one is not a missing-export failure; it is the resolver returning the wrong direction
for real reporter language.

## 1. What this slice does

Same shape as `return_from_injury`: no new ground-truth read. A suspended player logs no
offensive snaps for exactly the same reason an injured or IR'd player does not —
`player_week_snaps` carries no row either way — so `resolveSuspensionClaim` reuses
`locateGameAndPlayer` and `playedOrNot` unchanged and supplies only its own vocabulary:

- `classifySuspensionDirection(text)` reads whether a claim commits to `'suspended'` or
  `'reinstated'`, or `null` if neither.
- `resolveSuspensionClaim(event, { asOf })` maps `reinstated → played`,
  `suspended → did_not_play`, checks that against the real outcome, and returns
  `confirmed`/`contradicted`/`unresolved` with a printed reason — never a guess.
- `resolveSuspensionClaims({ limit, asOf })` is the batch entry point, scoped to
  `claim_type = 'suspension'`, using the same shared `resolveAndStore` loop every other
  claim type uses.

`suspended`/`reinstated` are their own vocabulary, not a reuse of `RETURNING`/`STILL_OUT` —
"eligible to return" and "reinstated" name different real events even though both predict
the same played/did-not-play outcome, and collapsing them would blur what the claim
actually said in `predicted_direction`.

## 2. Fixture design: date/week collisions, and a second one this unit actually hit

`return_from_injury` claimed weeks 22-30 (2027-04-12 through 2027-06-21). This unit's
regular tests use weeks 31-38 (2027-06-28 through 2027-08-16), and the batch test uses week
39 (2027-08-23).

The batch test hit a real instance of the collision risk `return_from_injury`'s evidence
file only described in the abstract: `locateGameAndPlayer`'s lookup
(`WHERE team_id = ? AND date >= ? ORDER BY date ASC LIMIT 1`) is **team-wide**, not
player-scoped. The first draft of `resolveSuspensionClaims writes one upserted row... and
leaves other claim types alone` gave the "untouched injury" fixture player a game dated
`2027-08-21` — the same date as the suspension claim's own `published_at` — while the
suspension fixture's own game was three days later (`2027-08-23`, week 39). Because both
fixtures share team KC, the suspension claim's date search (`date >= '2027-08-21'`) matched
the *other* player's earlier-or-equal-dated game first, resolved against that player's
snap data (which the suspension player never had), and reported `contradicted` instead of
`confirmed`. Not a code bug — a fixture bug, and the exact failure mode `locateGameAndPlayer`
is exposed to for any two same-team fixtures in this file. Fixed by moving the untouched
fixture's game to week 41 / `2027-08-30`, strictly after the suspension fixture's date, with
a comment at the fixture explaining why the ordering matters (see the test file).

## 3. Real-data hand-check: two real bugs found and fixed

Real case used: **Rashee Rice (KC, WR)**, who served a real six-game suspension to start the
2025 season and returned in week 7. Confirmed directly against the CSVs, not assumed:
`snap_counts_2025.csv` has no row for Rice in weeks 1-6 and his first 2025 row is week 7
(33 offense snaps, 0.41 pct); `games.csv` gives KC's real week 6 (2025-10-12, vs DET) and
week 7 (2025-10-19, vs LV) dates. A teammate (Mahomes) row was seeded for week 6 so Rice's
absence reads as "the box score exists and he's not in it" rather than "no data yet," per
`playedOrNot`'s own documented rule.

Ran a scratch script (`/tmp/.../suspension-hand-check.mjs`, not committed) with realistic
reporter-style claim text checked against both his real absence week and his real return
week. **First run: all four synthetic-style cases passed** (reinstated-confirmed/
contradicted, suspended-confirmed/contradicted) — unlike `return_from_injury`, the initial
vocabulary handled the constructed sentences correctly. Not satisfied that this proved
enough on its own (four hand-picked sentences that happen to pass is a weak bar), a second
pass ran six additional real-wire-style paraphrases of the same story through
`classifySuspensionDirection` alone, and two produced a genuinely wrong answer, one of them
worse than a miss:

| # | Claim text | Expected | Got (before fix) | Why it matters |
|---|---|---|---|---|
| 1 | "The Chiefs officially activated Rice off the suspended list ahead of Week 7." | `reinstated` | `suspended` | **False positive** — the bare word `suspended` inside "suspended list" (a noun phrase naming what he came *off* of) tripped the original `SUSPENDED` regex, which had no copula requirement. A wrong, confident answer — worse than the honest `unresolved` this whole feature exists to prefer. |
| 2 | "Rice will serve a six-game suspension to begin the season." | `suspended` | `null` | Spelled-out game count ("six-game") not matched — the original pattern required a literal digit (`\d+-game`). |
| 3 | "Rice is eligible to return this week after serving his suspension." | `reinstated` | `null` | `REINSTATED`'s "eligible to (return\|play) (following\|after) suspension" required strict word-adjacency; real copy inserts "this week" between "return" and "after". |

Fixed in three steps, each re-verified against the full case list plus the original four
and the 58-test suite before moving on:

1. **`SUSPENDED` now requires a copula** (`is`/`was`/`has been`/`remains`/`still` directly
   before `suspended`) instead of the bare word, closing the false positive.
2. **Game-count matching accepts spelled-out numbers** (`one`–`ten`) as well as digits, and
   `REINSTATED` gained an `activated ... suspended list` alternative and a bounded gap
   (`.{0,20}`) between "eligible to return" and "after/following ... suspension" instead of
   requiring strict adjacency.
3. **A second, more subtle bug surfaced by step 2's own fix**: broadening `SUSPENDED`'s
   serve-pattern to `serv(?:e|ing) ... suspension` (to catch "will serve a six-game
   suspension") made it *also* match "after **serving** his suspension" — the completed-
   service phrase inside a reinstatement sentence — which regressed case 3 back to a wrong
   answer (`suspended` instead of `reinstated`) and broke the real Rice case's own natural
   phrasing ("reinstated after serving his six-game suspension"). Fixed by keeping the game
   count in the serve-pattern **required**, not optional (`serv(?:e|ing) ... {GAME_COUNT}-
   game suspension`), since "after serving his suspension" (no count) does not carry one —
   and, because a sentence can still legitimately contain both a `reinstated` keyword and a
   completed `six-game suspension` phrase in the same breath, **reordered
   `classifySuspensionDirection` to check `REINSTATED` before `SUSPENDED`** (the reverse of
   `classifyInjuryDirection`/`classifyReturnDirection`'s "more definite state wins"
   ordering) — `reinstated` is the unambiguous signal in that overlap, and nothing in this
   unit's vocabulary produces a sentence where `SUSPENDED` should win over an explicit
   `reinstated`/return-eligible phrase.

Final state: all 4 original hand-check cases, all 6 additional real-wire paraphrases (plus
one intentionally-uncovered idiomatic case — "his suspension is behind him" — correctly
still returns `null` rather than being force-matched), and the full 58-test suite all pass
together. This is the same category of finding CLAUDE.md's `nfl-news-events`/`page-explain`
history warns about — production text differs from what a first-pass regex assumed — caught
here specifically because the hand-check kept generating real-style paraphrases after the
first four synthetic-shaped cases passed, instead of stopping at "the tests are green."

## 4. Regression

```
node --test test/beat-reporter-accuracy.test.js
# tests 58
# pass 58
# fail 0
```

`node --check` on both changed files — clean. `npm run lint` — clean (916 files, syntax
check).

**Guard runs, guard-v3 form** (isolated `git worktree` + independent `npm ci`; no `set -e`;
`rc=0; … || rc=$?`; no `| tee`; log outside the repo; `git status --porcelain` empty AND
`git write-tree` identical before/after; `find . -path ./.git -prune -o -newermt "@$t0"
-type f -print` afterward). Per the 17:14Z fleet rule the gate is
`npm run check && npm run check:wiring` under one guard, so the pre-merge pass below (run
before that rule landed) is `npm run check` only and the authoritative runs are on the
merged tree:

| pass | tree | worktree | gate | exit | tree before/after | status before/after | tests | touched outside `client/dist/` |
|---|---|---|---|---|---|---|---|---|
| 1 | `f413929f` (pre-merge) | `/tmp/claude-0/suspension-verify-1` | `npm run check` | 0 | `c86c7aaf` / `c86c7aaf` (unchanged) | empty/empty | 3221 total, 3180 pass, 0 fail, 41 skipped | none |
| 2 | `5c04069d` (merged + §4a fixes) | `/tmp/claude-0/suspension-gate` | `npm run check && npm run check:wiring` | 1 | `c4627d02` / `c4627d02` (unchanged) | empty/empty | 3768 total, 3727 pass, **0 fail**, 41 skipped | none |

Pass 2's exit 1 is **not a test failure** — every test in both suites passes, and `npm run
check` (typecheck, lint, suite, build, `start:smoke`) is green end to end. The non-zero exit
comes from `npm run check:wiring`, which reports 19 blocking findings on this tree. None of
them is this unit's:

- **3 are `main`'s own known red** (`play_by_play`, `pbp_participation`,
  `refreshLeagueRosters()`), named as such by the coordinator at 17:11Z with a fix in flight —
  they arrived here with the merge.
- **~10 belong to other threads** (`jev_chat_signals`, `manager_chat_profile`, `messages` and
  their columns), plus one stale accept-list entry (`server/services/cascade-grade.js`) naming
  a file no longer in the tree.
- **6 are Coach's**, and all 6 pre-date this unit: `client/src/components/coach/coach.types.ts`
  (imported by nothing — it is the wire contract handed to the UI thread, whose panel is the
  importer), and `people/context.js`, `people/grading.js`, `people/lexicons.js`,
  `people/variables.js`, `stat-names.js` (reachable from the two run-sheet scripts but from no
  route, job or page). PR #82's body already documents both states in writing: "No UI... the
  panel is the UI thread's" and the grading harness "has [not] run against a real chain".

**Not one of the 19 names a file this unit touched.** The suspension slice adds no wiring
finding: `beat-reporter-accuracy.js` reaches a surface through Coach's tools and catalog and
`routes/coach.js`, and does not appear in the report. Whether Coach's 6 are grandfathered,
annotated, or wired is a cross-thread decision (the importer for the types file is another
thread's, and the gate's accept-list is the Wiring map thread's), raised with the coordinator
rather than decided here.

## 4a. What merging main into this branch actually found

`main` moved from `654ff933` to `f620a120` while this unit was in flight, and PR #90's
branch went un-mergeable (GitHub reported `dirty` at 17:03Z). Merging `origin/main` in
produced **one** conflict and, once resolved, **four** test failures — none of them in this
unit's own files, all of them worth recording because each was a real staleness this branch
was carrying:

1. **`test/health-route-single.test.js` (the conflict).** Both sides had independently
   de-pinned the same line-number assertion. `main`'s own commit (`eb19f475`) documents that
   three branches fixed it the same way on the same night and that "taking any one of them
   costs nothing", so this resolved to `main`'s version verbatim — the resolved file is
   byte-identical to `origin/main`'s, which is the honest outcome when the two changes assert
   the same thing.
2. **`league_season_teams` and `league_week_scores` catalog entries** (2 failures,
   `test/coach-catalog.test.js`). Migration 064 arrived with the merge (PR #47 merged), so
   the declared schema now creates both tables and neither may claim a runtime creator. The
   catalog's own comment had predicted this exact moment in writing ("stops being true the
   day that branch merges... written out rather than folded into the line above precisely so
   it is noticed then") — it worked as designed. **The test reported only the first of the
   two**, because `assert` throws on the first mismatch and the loop never reached the
   second; an audit script over every catalog entry against the declared DDL found both, and
   both were fixed together. Fixing only what the failure message named would have left the
   branch red on the next run for a second, identical reason.
3. **Coach's sweep-spec guard** (2 failures, `test/coach-sweep-edits.test.js`). Six
   `*.mutations.json` specs from other threads now live in `docs/tdd/sweeps/`, in their own
   schema (`name`/`aimed_at`/`kind`, an array of suites, no no-op control). Coach's guard
   was reading every `.json` in that directory and holding all of them to Coach's evidence
   standard — so another thread's file shape failed this branch's gate. Narrowed to the nine
   specs Coach owns. This is the reciprocal of CLAUDE.md's rule about a test that breaks on
   unrelated edits: the fix belongs in the over-reaching guard, not in six files owned by
   other threads.

Both fixes are in `81bd8ea6` (`fix: two Coach guards that the main merge turned red`).

## 5. File ownership

`beat-reporter-accuracy.js` and its test file are this thread's own scope, already owned
across all three prior claim types. No route, no client file, no other thread's table
touched — the `source_trust` tool and `nfl_news_events`/`beat_reporter_claim_resolutions`
catalog entries (shipped in the prior catalog unit) already describe both tables generically
enough to cover a fourth `claim_type` value with no code change there.

## 6. Known limits

- **Vocabulary is still finite.** §3's real-data hand-check found and fixed two genuine
  bugs; it does not prove no other real reporter phrasing is missed, and one plausible
  idiomatic construction ("his suspension is behind him") is deliberately left `unresolved`
  rather than force-matched. Same limit as every prior claim type's hand-check — a
  meaningful but bounded set of real-style cases, not a corpus scan.
- **`transaction` is the one remaining unattempted claim type.** It needs a roster/
  ownership-change ground-truth read (not played/did-not-play), which is a different, larger
  build than this unit's three siblings and was not attempted here.
- **Merge held, not the push.** `main` is separately red on `check:wiring` (Wiring map's own
  unit, three false positives — `play_by_play`, `pbp_participation`, `refreshLeagueRosters`
  — unrelated to anything here) per the coordinator's 17:11Z note, with the fix at
  `ae84ac6d` not yet pushed at the time of writing. That is main's, not this branch's: the
  four failures this branch did hit were its own (§4a) and are fixed. PR #90's **merge** is
  held until main's gate fix lands and CI is green on top of it; the push is not.
