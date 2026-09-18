# TDD evidence: review-fixes

Source: the step-1b review panel's findings (one reviewer per installed skill plus
silent-failure-hunter and mle-reviewer), handed over as a list of 31 critical, high
and medium findings on 9a7a809..79dbeb1. Journeys were derived from those findings
during this run. Gates for this item were written before any fix, in
`scratchpad/step1b/review-fixes/GATE.md`: this item moves no fitted constant, no gate
threshold and no number a user sees today; anything that would is deferred with the
gate it needs.

Runner (every command below):

    GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test \
      --test-concurrency=1 <file>

## 1. The scheduled weekly retrain kept undoing the early-week blend (high)

Journey: as Nick, I want weeks 2-4 to keep using the structural-only projection
after the automatic retrain runs, so that a player's week-2 number is not 80% his
week-1 score again.

Found two defects, both reproduced:

1. `retrainWeeklyWeights` saved a promoted fit with the four per-position vectors and
   no `early` block, so the next week's `activeWeeklyWeightSet` served no early
   buckets.
2. It fit and graded the per-position vector on settled week 2-4 rows, where
   production never serves that vector. The live table's only settled rows will be
   2026 week 2 (1,183 rows). The RED run shows what would have happened: the
   candidate `[1,0,0,0,0]` fit on week-2 rows beat fit-1's vector (MAE 0 vs 3.58 on
   the synthetic rows), was promoted with no `early`, and would have been served at
   weeks 5-18.

Fix: `saveWeeklyFit` carries the newest stored early block onto any promoted fit
that has none (the invariant lives in the store, so no caller can drop it), and the
retrain drops rows inside the stored early window before fitting and grading. The
pass rule (player-clustered paired bootstrap, rank, coverage band, sizes) is
unchanged. The fix the early-week TDD doc suggested,
`carryEarlyWeights(candidate, champion.weights)`, would not have worked: the champion
is read at a week-5+ row, where `early` has already been stripped.

| # | What is guaranteed | Test | Type | RED (3034218) | GREEN |
|---|--------------------|------|------|---------------|-------|
| 1 | A promoted retrain keeps the stored early buckets for weeks 2-4 | `weekly-retrain-early-carry.test.js: a promoted weekly retrain keeps the stored early-week buckets` | integration | FAIL (`early` undefined) | PASS |
| 2 | `saveWeeklyFit` carries `early` onto a promoted fit without one; a rejected fit is stored as evaluated | `...: saveWeeklyFit carries the newest stored early block...` | unit | FAIL | PASS |
| 3 | Week 2-4 rows neither fit nor grade the per-position vector; with only week-2 rows nothing is trained or stored | `...: settled rows inside the early-week window...` | integration | FAIL (promoted a week-2 fit) | PASS |
| 4 | Rows outside the window still train (650 of 650 used, 180 week 2-4 rows ignored) | `...: rows outside the window still train...` | integration | FAIL (sample 830) | PASS |

Regression: `model-integrity` 94/94, `weekly-early-week-blend` 19/19,
`weekly-prediction-snapshot-mode-migration` 3/3.

## 2. "Protect the floor" returned an arbitrary lineup (high; frontend-patterns and eval-harness)

Journey: as Nick, when I press "Protect the floor" I want either a lineup that really
protects the floor or to be told the floor cannot rank my players this week, so that
I never bench Mahomes because of roster order.

Reproduced: every live floor is 0 at 2026 week 2 (a did-not-play week scores 0 and no
live chance to play exceeds 0.9, so every p10 is 0). The solver's sort is stable, so
an all-tied key returns roster order.

Fix (lineup-brain.js#lineupCall): a requested key on which every startable skill
player has the same value is not optimised; the lineup is solved on week_points,
`objective_used` says so and `objective_fallback` says why. Exact ties on a key that
does rank players are broken by week_points (stable pre-sort), never roster order.
Lineup.tsx now names the header by what was summed and shows the fallback note.
The floor model itself is unchanged (see deferred: fake-floors sign-off).

| # | What is guaranteed | Test | Type | RED (08a34ad) | GREEN |
|---|--------------------|------|------|---------------|-------|
| 1 | All-zero floors: floor request solves on week_points, says so, projection > 0, starts the 22.4 QB | `lineup-floor-objective.test.js: every floor 0...` | integration | FAIL (`objective_used` floor) | PASS |
| 2 | Exact floor ties go to the higher week_points, not roster order | `...: exact floor ties are broken by week_points...` | integration | FAIL (backup QB started) | PASS |
| 3 | Distinct floors: the floor-optimal lineup is unchanged (40.3) | `...: when floors rank the players...` | characterization | PASS | PASS |

Live check on a VACUUM INTO copy of production taken 05:00 (script
`scratchpad/step1b/review-fixes/floor-live.mjs`): in all 5 leagues the floor request
now returns `objective_used: week_points` with the fallback note and the mean
lineup (league 1: Mahomes, Jacobs, Achane, Chase, McLaurin, McBride, Javonte
Williams, 83.75). Ceiling totals are unchanged (league 1 186.1).

Regression: decision-leftovers-lineup 10/10, decision-inbox 17/17, lineup-evidence
16/16, fantasy-workflows 7/7. `tsc --noEmit` clean.

## 3. ESPN-connect and the page assistant answered anyone on the tunnel (high + medium; security-checklist, pre-existing)

Journey: as Nick, I want only my own signed-in browsers to read, wipe or rebind my
ESPN connection or spend my Anthropic credit, so that someone who learns the tunnel
URL cannot turn every lineup into advice for another team.

Reproduced with the routers mounted exactly as server/index.js mounts them (no
wrapper): anonymous GET /api/espn-connect/status returned 200 with cookie
previews; anonymous POST /api/betting/explain/page reached the model call.

Fix: the routers carry their own guards. espn-connect: `legacyAuthenticated` on GET
/bookmarklet, GET /status, DELETE /cookies, GET /discover, POST /add; /add takes the
member from `req.auth`; /status no longer returns any part of either cookie (no client
code read the previews). The bookmarklet's cross-origin POST /cookies and its OPTIONS
preflight stay open (it runs on espn.com and cannot carry the token). betting-hub:
the assistant needs a session, has its own 12/min per-user limit, and refuses a page
summary over 16,000 characters or a question over 2,000 (413) before any model call;
the audits list needs a session. The client's `api()` already sends the token and
provisions one on a 401, so no page changes. Takes effect when the server restarts
(not restarted here).

| # | What is guaranteed | Test | Type | RED (f34ff16) | GREEN |
|---|--------------------|------|------|---------------|-------|
| 1 | Anonymous status/bookmarklet/discover/DELETE/add get 401 and change nothing | `espn-connect-auth.test.js: anonymous callers cannot...` | integration | FAIL (200) | PASS |
| 2 | espn.com preflight still 204 | `...: the bookmarklet preflight stays open` | integration | PASS | PASS |
| 3 | Signed-in status has no cookie fragment | `...: status, for a signed-in caller...` | integration | FAIL | PASS |
| 4 | Assistant and audits need a session | `...: the page assistant and its stored answers require a session` | integration | FAIL | PASS |
| 5 | Oversized summary or question is 413 before the model | `...: refuses an oversized prompt` | integration | FAIL (400 no key) | PASS |
| 6 | Per-user limit at most 20/min (set 12) | `...: has its own per-user limit` | integration | FAIL | PASS |

Existing tests updated to send a session: `espn-connect.test.js` (discover x2,
bookmarklet x2) and `page-explain.test.js` (request helper). One expectation was
deliberately reversed: "adding a league with no session token still succeeds" is now
"...is refused and writes nothing", because the finding's point is that /add rewrites
`my_team_id`. Regression: espn-connect 19/19, page-explain 7/7, draft-reconcile
16/16, league-removal 8/8, legacy-route-security 5/5.

Not done here (deferred): POST /cookies is still anonymous. Closing it means the
bookmarklet must carry an install key, and every saved bookmarklet has to be dragged
again; that is Nick's call.

## 4. Lineup card: urgency rules had no tests; a bad team_id published a rival's swaps (high + medium; tdd-workflow, backend-patterns)

Journeys: as Nick, I want each lineup swap's "how sure" number and urgency to stay
the measured rule, so a refactor cannot quietly turn coin flips into "high". And I
want my Decision Inbox to hold only my own lineup calls, whatever team the My Team
selector points at.

Characterization (tests written after the code, so RED is shown by mutation): eight
tests pin P(right) = Phi(gap/14.5) at gaps 3, 4 and 10 (0.582 low, 0.609 medium,
0.755 high), a swap into an empty IR-left slot priced at the newcomer's chance to
play (0.8), retiring an open row as `superseded`, `activate_from_ir`, and
`flagged_starters.espn_disagrees`. Each of six scratch mutations fails at least one
of them (`scratchpad/step1b/review-fixes/mutations-lineup-diff.log`):

| Mutation | Characterization tests failing |
|----------|-------------------------------|
| M1 urgency always 'high' | 3 (3.0 gap, 4.0 gap, retire) |
| M2 sigma 14.5 -> 3 | 4 |
| M3 versus-zero priced on the gap | 1 (empty-slot swap) |
| M4 retire UPDATE disabled | 1 |
| M5 on_ir forced false | 2 |
| M6 espn_disagrees always false | 1 |

Bug (RED at 33d5ab3, which also adds the only production change needed to test it:
an optional injected `assets` argument): `lineupDiff(lg, 'not-a-team')` computed
teams[0] and published it; a rival's team_id published the rival's swaps to Nick's
inbox. Fix: an unknown team_id returns `{ error, not_found: true }` and the route
answers 404; only the roster matching `leagues.my_team_id` publishes or retires; the
swallowed inbox error is logged with league and dedup key. The dedup key for Nick's
own roster is unchanged (`lineup:<league>:<my_team_id>`), so open rows keep matching.

Live check on the snapshot (`diff-live.mjs`): `not-a-team` is not-found in all 5
leagues and the open lineup rows stay at 2 (the reviewer's run wrote 3 new rows).

Regression: all 14 files that import trade-engine or the trades route pass (125
tests; list in `reg-trade-engine.log`). The stale "(>= 4pt threshold)" message in
decision-inbox.test.js now states the Phi rule.

## 5. Trade floor/ceiling (lineupSpread) had no tests; two comments said the fake-floors bug was live (high + medium; tdd-workflow, coding-standards, eval-harness)

Journey: as Nick, I want every trade's floor and ceiling change to stay the lineup
total's 10th/90th percentile, so a refactor cannot bring back the "everyone busts at
once" floor.

Characterization tests (`test/lineup-spread.test.js`, 5): (a) two priced starters give
mean -/+ 1.2816 sd of the total, not the sum of floors; (b) no spread information gives
floor null, coverage 0; (c) the floor is clamped at 0; (d) a same-team QB+WR pair adds
one correlation term and widens sd, and with weekly models floor/ceiling are
mean -/+ 1.2816 sd; (e) `evaluate().me.floor_delta` equals the difference of the two
lineupSpread floors and no weekly model is read until the field is. The only
production change is exporting the `WEEK_MARGINAL` symbol so a fixture can carry a
weekly model.

| Mutation (scratch copy) | Tests failing |
|-------------------------|---------------|
| S1 Z90 1.2816 -> 3 | 1 (d) — survived (a)-(c), where the quantile cancels; (d) was strengthened, then caught it |
| S2 floor = sum of starters' floors | 1 (a) |
| S3 correlation term dropped | 1 (d) |
| S4 floor not clamped at 0 | 1 (c) |
| S5 spreads computed eagerly in evaluate() | 1 (e) |

Comments: `player-week-engine.js#playerWeekDistribution` said "the fix was held back"
while the code applied it, and `trade-engine.js` (lineupSpread notes) said the engine
still scored a sitting week as the shift. Both now state today's behaviour (a sitting
week is 0 in both places), and `docs/tdd/fake-floors.tdd.md` now says SHIPPED at
947d66c with the sign-off still owed (deferred to Nick). Checked on the snapshot: 0 of
1,183 week-2 projections carry an ensemble shift above 0.05, so the fix changes no
live number until week 5.

Regression: player-week-distribution 12/12, fantasy-workflows 7/7, find-trades 3/3,
trade-evidence 6/6.

## 6. League-chat extractor: no tests, "night" measured in UTC, failures reported as ok, unknown handles lost (high + 3 medium; python-testing)

Journeys: as Nick, I want the chat profile numbers that reach the negotiation prompts
to mean what their names say, and a broken classifier run to show up as an ERROR in
the refresh log instead of "ok".

New suite `scripts/chat/test_extract_league_chat.py` (stdlib unittest, synthetic DBs
only; run `python3 -m unittest discover -s scripts/chat -p 'test_*.py'`). RED at
a8beb7f: 10 of 13 tests failed (the commit message says 11; the night-share test
counts once, with 4 failing sub-cases). GREEN: 13/13.

| # | What is guaranteed | RED | GREEN |
|---|--------------------|-----|-------|
| 1 | Resume by ROWID is idempotent | PASS | PASS |
| 2 | A renamed group chat exits non-zero | PASS | PASS |
| 3 | A group row from an unknown handle is stored unnamed and reported, not dropped below the watermark | FAIL | PASS |
| 4 | Once the handle is added to participants, the unnamed row gets its name on the next run | FAIL | PASS |
| 5 | LEAGUE_CHAT_SRC / LEAGUE_CHAT_OUT override the paths | FAIL | PASS |
| 6 | A non-zero classifier exit is returned | FAIL | PASS |
| 7 | main() still runs the rollup, then exits non-zero, when classify fails | FAIL | PASS |
| 8 | classify runs for an unlabeled backlog even with no new rows | FAIL | PASS |
| 9 | no backlog and no new rows: classifier not called | FAIL (no main) | PASS |
| 10 | night_share = hours 0-5 on the Eastern clock, both sides of DST, both stored timestamp formats | FAIL (4 of 6 sub-cases) | PASS (7 sub-cases) |
| 11 | Unnamed rows are in no profile | FAIL | PASS |
| 12 | typedstream decoder: 1- and 2-byte lengths | PASS | PASS |
| 13 | a truncated blob returns None instead of raising IndexError | FAIL | PASS |

The classifier (`jev_league_chat.mts`) never sends an unnamed row or uses one as
context, so the privacy scope (the nine members) is unchanged. Retrying ok=0 rows in
the classifier and a sync_log row for Data Health are deferred (see the list).

Smoke run of `rollup()` on a copy of the live `league_chat.sqlite` (the first attempt
failed: the live rows are stored as `2025-08-16T01:54:14`, with a T; the parser now
takes both forms and a test pins it): 10 profiles, 119 sentiment rows (same as live),
backlog 0. **One number changes for users:** mean `night_share` across the 10
managers goes 0.227 -> 0.030 (range 0.171-0.309 -> 0.000-0.092), because it now
measures midnight-6am Eastern instead of 8pm-2am. It is a descriptive ratio, not a
fitted model; it reaches `manager_signals.chat_night_share` and the negotiation
prompts. The refresh loop picks this up on its next tick.

## 7. The asset-universe cache served stale projections after a promotion, rollback, league sync or availability refit (medium; backend-patterns, clickhouse-io)

Journey: as Nick, when a weight set is promoted or rolled back, a league syncs, or the
availability model is refit, I want the next page to show the new numbers without a
server restart.

RED (730e75f): 4 of 5 fail. Fix: one list of every table `buildAssetUniverse` reads
(`ASSET_INPUT_TABLES`, now also `leagues.fetched_at`, both availability tables and
`player_week_snaps`), used by both the assetUniverse and findTrades fingerprints, plus
the served weight set's id in the key (a rollback only clears a flag, which no row
count or max id can see). contingency.js keys its fitted-availability lookup on the
two tables' row count and newest `fitted_at` instead of holding it for the process.

| # | What is guaranteed | RED | GREEN |
|---|--------------------|-----|-------|
| 1 | No change: the same cached object | PASS | PASS |
| 2 | Promotion and rollback each rebuild | FAIL | PASS |
| 3 | A league sync rebuilds | FAIL | PASS |
| 4 | An availability refit (either table) or a snap load rebuilds | FAIL | PASS |
| 5 | weeklyAvailability reads a refit made after its first read (0.592 -> 0.61) | FAIL | PASS |

Cost, measured on the snapshot (league 1, 8,640 assets): a cached call went from
3.1 ms to 8.1 ms (the `leagues` stamp reads past each 2 MB payload, 2.7 ms; snaps
1.7 ms). A cold build is ~8.5-8.9 s either way. Regression: all 18 files that import
trade-engine, contingency or the trades route pass (list in `reg-fp.log`).

## 8. Silent failures in the rest-of-season inputs (medium; coding-standards / silent-failure)

Journey: as Nick, if the rest-of-season model cannot read its inputs, I want the
server log and the asset to say so, not a quiet return to the week-1-score numbers.

RED (ac754a0): 5 of 5 fail. Fix: `inSeasonHistory` treats only a missing table as
"no games" and otherwise logs (season, week) and raises; `rosPriorMap` logs a failed
source and does not memoise a map built after a failure; `buildAssetUniverse` catches a
ROS failure, logs it with league and week, keeps building, and marks each asset
`ros_basis: { failed }`; `buildAvailabilityLookup` reports an unreadable role config
(`configError` plus a warning) instead of silently switching to pooled positions.

| # | What is guaranteed | Test | RED | GREEN |
|---|--------------------|------|-----|-------|
| 1 | A failed history query raises and is logged with the season | `ros-projection-failures.test.js` | FAIL | PASS |
| 2 | buildRosProjections propagates it (no empty "no ROS" map) | same | FAIL | PASS |
| 3 | A prior map built after a failure is recomputed next call; a clean one is cached | same | FAIL | PASS |
| 4 | An unreadable role config is reported | same | FAIL | PASS |
| 5 | A ROS failure is logged and marked on assets; the universe still builds | `ros-projection-failure-wiring.test.js` | FAIL (threw) | PASS |

The test for #3 first counted buildProjections calls, which also counts the calls
preseasonProjections makes; it was changed to compare the returned maps, and the
revised file was re-run against HEAD's code in the scratch copy: 4 of 4 fail there.
Regression: ros-projection 24/24, ros-projection-wiring 1/1, availability-role 17/17,
asset-universe-fingerprint 5/5, decision-inbox 17/17, fantasy-workflows 7/7,
find-trades 3/3, trade-evidence 6/6, decision-leftovers-waivers 7/7, post-draft-plan
5/5, model-integrity 94/94.

## 9. seasonEndingEspnIds cost ~0.8 s per league build for the same answer (medium; clickhouse-io)

Journey: as Nick, I want a news refresh not to cost five near-second rebuilds of the
same "who is out for the season" list.

RED (2b21bda): 2 of 3 fail — 1,863 name normalisations for 60 players x 30 stories,
and identical inputs recomputed every call. Fix: each severe story is normalised once;
the result is memoised on the exact inputs (window, in-window severe stories' text and
time, the roster, each league's fetched_at), so an in-place story edit is seen.

| # | What is guaranteed | RED | GREEN |
|---|--------------------|-----|-------|
| 1 | Same answer (the named player flagged) | PASS | PASS |
| 2 | Normalisations scale with players + stories, not their product | FAIL (1,863) | PASS |
| 3 | Same inputs: no work; a new story or an in-place edit changes the answer | FAIL | PASS |

On the snapshot (`se-live.mjs`, HEAD code from the scratch copy vs new): the same
71 espn ids, identical; first call 773-829 ms -> 228 ms, repeat calls 9 ms.
Regression: player-availability 15/15, decision-leftovers-waivers 7/7,
fantasy-workflows 7/7, find-trades 3/3, trade-evidence 6/6, decision-inbox 17/17,
ros-projection-wiring 1/1.

## 10. Matchup card calibration had no tests (medium; tdd-workflow)

Journey: as Nick, I want the card's win probability and "chase variance / protect the
lead" stance to stay the fitted rule, so a refactor cannot bring back the old spread.

Characterization tests (`test/posture-calibration.test.js`, 6, closed-form fixtures):
the constants (1.63, 23, the positional CVs); `my_sd` = 1.63 x root-sum-square of
projection x CV; win probability = Phi(edge / sqrt(sd1^2 + sd2^2)); the stance turns
at exactly 23 (-22.9 neutral, -23.0 chase, +23 protect); a 0-point player adds no
variance; the variance search (a superflex OP case where a receiver or a tight end
trades half a point for spread) offers the healthy player and never the one flagged
out. No production change.

| Mutation (scratch copy) | Tests failing |
|-------------------------|---------------|
| P1 SPREAD_SCALE 1.63 -> 1.9 | 4 |
| P2 MATERIAL_EDGE 23 -> 12 | 2 (constants, stance boundary) |
| P3 spread from each player's own (ceiling - floor) / 2.56 | 4 |
| P4 flagged players allowed into the swap pool | 1 |

## 11. Matchup no-signal state had no tests (medium; tdd-workflow)

Journey: as Nick, I want defense-vs-position and home/away to stay out of my
projections until they pass the walk-forward test, whatever the history shows.

Characterization tests (`test/matchups-no-signal.test.js`, 5) on seeded game logs where
one defense allows twice the usual: `dvpFor` mult 1 / signal false / the reason, with
the descriptive history intact; `scheduleOutlook` sos and playoff_sos 1, no best or
worst, every game multiplier 1, bye still found; `dvpTable` display-only with applied
multiplier 1; `GET /trades/dvp` reports signal false and the reason; a self-opponent
schedule row is repaired from the other team's row. No production change.

| Mutation (scratch copy) | Tests failing |
|-------------------------|---------------|
| X1 DVP_MULTIPLIER_ENABLED = true | 4 |
| X2 scheduleOutlook's no-signal return removed | 1 |
| X3 HOME_FIELD_MULTIPLIER_ENABLED = true | 2 |
| X4 self-opponent repair removed | 1 |

## 12. The weekly boom/bust shock was held only by a golden snapshot (medium; tdd-workflow)

Journey: as the next person to refit WEEKLY_LEVEL, I want tests that say what must
still hold (mean-preserving, per-position sigma, the `{ sigma }` override), not a
snapshot that breaks on any refit.

Property tests (`test/weekly-level.test.js`, 6): the closed-form shock mean with and
without the downside multiplier (checked against an independent 200,000-draw
simulation within 0.5%); the simulated mean equals the no-shock mean within 1%
(100,000 draws — at 20,000 the first run differed by 1.3% by chance; measured at
200,000 over three seeds: within 0.5%); default QB/WR draws equal explicit sigma
0.30/0.20; `{ sigma: 0 }` switches the shock off for every position;
`meanPreserving: false` moves the mean by exactly the shock mean (0.985 for a WR with
downMult 1.6 — below 1, not above; my first draft of that assertion was wrong and was
corrected before this commit). No production change.

| Mutation (scratch copy) | Tests failing |
|-------------------------|---------------|
| B1 meanPreserving false by default | 1 (c) |
| B2 weeklyLevelMean always 1 | 3 |
| B3 byPosition ignored | 1 (d) |
| B4 `{ sigma }` no longer overrides byPosition | 1 (e) |

## 13. League Hub lineup card scrolled sideways at 375px (medium; frontend-patterns)

Journey: as Nick on my phone, I want the week-2 "Caleb Williams over Patrick Mahomes
(flagged out for the season or released)" row to fit the card.

The repo has no client test runner, so the evidence is the reviewer's Vite harness,
re-run: the real `LineupDiffCard` extracted from MyTeam.tsx, league 1 live data plus
the Mahomes-shaped swap, rendered in the built-in browser at 375x812 and measured with
`document.documentElement.scrollWidth` (harness in `scratchpad/step1b/review-fixes/harness`).

| Build | scrollWidth / clientWidth | Overflowing elements |
|-------|---------------------------|----------------------|
| before (reviewer's copy of HEAD) | 379 / 375 | the nowrap "over" group and its reason span |
| after (this change) | 375 / 375 | none |

Fix: only the position and name stay `whitespace-nowrap`; the reason is its own
`min-w-0 break-words` span inside a wrapping group, and in the screenshot it drops to
its own line under "Patrick Mahomes". `tsc --noEmit` clean.

## 14. Two rules written in several places: this week's number and "is he on IR" (medium x2; coding-standards)

Reproduced by reading: the week-points formula is in lineup-brain.js#startSitWeekPoints
and trade-engine.js#lineupDiffWeekPoints; the ESPN IR test is in irOnRoster,
lineup-posture.js#rosterAssets, lineupDiff and waiver-wire.js. The import cycle is real
too, and it showed up while writing this test: mocking `waiver-brain.js#vegasLift`
reaches lineup-brain but not trade-engine, because waiver-brain imports trade-engine,
which binds the real waiver-brain first.

Not consolidated here (deferred, see the list): moving `vegasLift`,
`startSitWeekPoints` and an ESPN-entry IR test into a leaf module also means rewriting
the betting-line mocks in three test files that belong to other items, and today the
copies agree, so there is no user-visible bug to fix. What this item adds is a guard
that fails the moment a copy drifts: `test/lineup-surfaces-agree.test.js` (2 tests)
prices one roster through the real vegasLift (the game-script model is mocked
underneath it) and checks that the League Hub card's week points equal
`startSitWeekPoints` for every starter, and that irOnRoster, the matchup card and the
League Hub card exclude exactly the same two IR players.

| Mutation (scratch copy) | Tests failing |
|-------------------------|---------------|
| A1 League Hub card drops the lift | 1 |
| A2 League Hub card rounds to 0.1 | 1 |
| A3 matchup card ignores INJURY_RESERVE | 1 |
| A4 League Hub card ignores INJURY_RESERVE | 2 |
