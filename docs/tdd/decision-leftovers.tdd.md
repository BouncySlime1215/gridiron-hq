# TDD evidence: decision leftovers (2026-09-18)

**Modules:** `server/services/lineup-brain.js` (Start/Sit), `server/services/waiver-wire.js` (waiver board), `server/services/lineup-posture.js` (matchup card), `server/services/ceiling-lineup.js`, `server/services/season-sim.js`; UI `client/src/components/lineup/WaiverWire.tsx`, `client/src/components/lineup/MatchupPosture.tsx`, `client/src/pages/Lineup.tsx`.
**Why:** five decision-logic leftovers found at 2026 week 2. Start/Sit used players in ESPN's IR slot. The waiver board chose its cut on this week's number alone, so one bad game made a good player the cut. Free agents with no NFL team showed up as stashes. The ceiling lineup and season sim still applied the home/away factor that matchups.js retired. The matchup card's "You" total left out the betting-line adjustment that Start/Sit includes.

## Source plan
There was no `*.plan.md`. The task text from the step-1b workflow served as the plan. This run picked up an earlier attempt at the same item that had been interrupted. That attempt had written the gate (scratch `step1b/decision-leftovers/GATE.md`, 03:13), the RED commit `46dfecb` and an uncommitted implementation. I re-read every line of that diff and re-ran RED against HEAD's services. I also re-ran every live check on a fresh copy of the production DB. Four things were added along the way:
- a ceiling-lineup IR fix (J1d), which the fresh live check found;
- a Sleeper coverage test (J1c);
- a fix to the check script (duplicate player names);
- a wording fix in the UI's held-back line.

## User journeys
- J1: As a manager, I want Start/Sit never to start, compare against, or list as a bench option a player on IR (ESPN IR slot 21 or ESPN status INJURY_RESERVE). That is the rule waiver-wire.js, lineup-posture.js and the League Hub card already use.
- J1b: As a manager, I want a low chance to play described as this week's chance, not as a share of weeks.
- J1c: As a Sleeper user, I want the roster's reserve list treated the same way.
- J1d: As a manager, I want the ceiling lineup to follow the same IR rule.
- J2: As a manager, I want an immediate waiver claim never to cut someone worth more over the rest of the season than the player claimed, and never to lower my rest-of-season lineup. The claim must still help this week.
- J3: As a manager, I don't want free agents with no NFL team offered at all.
- J4: As a manager, I want the ceiling lineup and season sim to stop tilting home games +2% and away games -2%. matchups.js retired that factor on the 2026-09-17 walk-forward test.
- J5: As a manager, I want the matchup card's "You" total to be the Start/Sit total: same players, same betting-line adjustment.

## Gate (pre-registered in scratch GATE.md before any test, code or live run; addendum written before the run it governs)
Nothing is fitted here, so there is no season split and no bootstrap. Each fix is graded by code graders (node:test) and by pre-registered live checks. The live checks run on a VACUUM INTO copy of the production DB, 2026 week 2, all 5 leagues, Nick's team.

| Check | Pass rule |
|---|---|
| L1 | 0 IR players in any Start/Sit lineup, alternative ("over") or bench list; 5 leagues x 3 objectives |
| L1d (addendum) | 0 IR players in either ceiling-lineup lineup; 5 leagues |
| L2 | every immediate claim meets (a) cut's rest-of-season value <= claim's, (b) rest-of-season lineup not lower, (c) week gain > 0.05. Recomputed independently from `assetUniverse` + `bestLineup`, with 0 resolution mismatches |
| L3 | 0 free agents with no NFL team in immediate or stashes |
| L4 | card "You" within 0.1 of Start/Sit `projected_points` wherever the starting sets match; any league where they differ is a FAIL unless explained |
| L5 | ceiling lineup and season sim run on all 5 leagues. Odds are reported only |

## The waiver cut rule (as shipped, `waiver-wire.js#chooseClaimCut`, returned as `drop_rule`)
For each free agent, every active rostered player is a candidate cut.
- (a) Never cut someone whose `ros_ppg` is higher than the claim's. A player flagged out for the season or released counts as 0.
- (b) Never cut someone whose loss lowers the rest-of-season lineup (`bestLineup` on `ros_ppg`, after the add).
- (c) The claim must still raise this week's lineup by more than 0.05.
- (d) Among the cuts that pass, pick the largest week gain first, then the highest rest-of-season lineup, then the lowest rest-of-season value.

A free agent with no passing cut is not an immediate claim. He goes into `held_back`, along with the cut the old rule would have made.

## RED -> GREEN
| Stage | Commit | Evidence |
|---|---|---|
| RED | `46dfecb` | 19 tests; 17 fail on the intended behaviour. Examples: IR players in all three objectives; card 90 vs 130; Waddle cut instead of Corum; one-week streamer not held back; teamless stash; home draws at 1.122 instead of 1.1. The 2 that pass are regression guards. |
| RED (supplement) | `71cbeb9` | 22 tests; 20 fail against HEAD's unchanged services (`red-supplement.txt`). J1d fails with both IR players in the lineup. J1b fails with `'only plays about 19% of weeks'`. J1c fails because there is no `on_ir`. The tightened J3 fails with "teamless free agent offered as a stash". J1c was written after the ESPN implementation, as a coverage test. A mutation check (Sleeper branch disabled) makes it fail. |
| GREEN | this commit | 22/22 pass. pass^3: 3 consecutive runs, 22/22 each (`pass3.txt`). |

Command (repo runner):
```
GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-concurrency=1 test/decision-leftovers-home-away.test.js test/decision-leftovers-lineup.test.js test/decision-leftovers-waivers.test.js
  -> home-away 5/5, lineup 10/10, waivers 7/7
```

## Live checks (DB copy; before = HEAD `71cbeb9` services, after = this commit)
Verdicts: before failed L1, L1d, L2 and L4. After, all six passed: L1, L1d, L2, L3, L4, L5. The "after" run was repeated on HEAD `947d66c` (the fake-floors fix to player-week-engine.js landed during this run) with these changes applied. All six still passed, with identical lineup totals, claims and card numbers (`after-head947.json`).

**L1: IR in Start/Sit, before.**
- Leagues 2 and 3 listed Jordyn Tyson (IR slot) as a bench option under every objective.
- League 4, mean objective: Chase Brown and De'Von Achane were started "over" Zach Charbonnet (IR slot, OUT).
- League 4, ceiling objective: the same, plus four starts "over" A.J. Brown (ESPN injured reserve).
- League 4, "Protect the floor": Charbonnet and A.J. Brown were started.

After: 0 in all 15 calls. Each IR player is named in `on_ir` with the reason.

**L1d.** Before, league 4's ceiling lineup started A.J. Brown. After: 0.

**L2: waiver cuts.** Before, 16 of league 3's 17 claims cut Tyler Warren and lowered the rest-of-season lineup by 0.41-0.55 a week. After, all 40 claims across the 5 leagues pass (a)-(c), and the recomputation matches the service's number on every row. League 3 now has 13 claims, all cutting Zach Charbonnet (bench, ESPN OUT, ros 10.02). 4 tight-end claims are held back (Gesicki, Schultz, Fant, Otton): the only cut that helps this week is Warren, who is worth 10.75 over the rest of the season against their 7.7-9.8.

**Coker / Waddle, leagues 1 and 2** (same DB copy, three code states):

| Code | League 1 top claim and cut | League 2 claim and cut |
|---|---|---|
| e2ba4c4 (what the live server runs now) | Coker +23.93, cut Waddle (week 1.45, ros 2.72); all 20 claims cut Waddle | Bryce Young +3.32, cut Waddle |
| HEAD before this change (ROS model and early-week blend landed) | Coker +5.21, cut Marvin Harrison Jr. (4.61 / 8.76) | Juwan Johnson +1.24, cut Harold Fannin Jr. (5.16 / 8.87) |
| After | Coker +5.21, cut Blake Corum (4.86 / 7.59) | Juwan Johnson +1.24, cut Antonio Williams (WR WAS, 6.14 / 8.02) |

Which change protects Waddle (`isolate.mjs`):

| Numbers | Old rule | New rule |
|---|---|---|
| Today's numbers, with Waddle's week forced back to 1.45 (ros stays 9.86) | L1 and L2 cut Waddle | L1 cuts Corum, L2 cuts Antonio Williams |
| e2ba4c4 numbers (Waddle ros 2.72) | cuts Waddle | still cuts Waddle |

So the rule protects a player who had one bad week once his rest-of-season number is right. With the old rest-of-season number, no cut rule could protect him. The two items work together.

**L3: teamless free agents.** Today there are 0 teamless rows before and after, because the ROS model now gives out-of-work players low rest-of-season numbers. The pool that gets checked shrinks from 542 to 234 free agents per league. With e2ba4c4's numbers (what the live server shows), league 1's stash list is 7 teamless out of 10 (Tyreek Hill, Darius Slayton, Sterling Shepard, ...). Under the new code those 7 are gone, reported as `teamless_excluded 7`, and 6 stashes remain, all on teams.

**L4: matchup card vs Start/Sit**

| League | Card "You" before -> after | Start/Sit | Same starters before -> after | Them | P(win) | Stance |
|---|---|---|---|---|---|---|
| 1 | 83.5 -> 83.8 | 83.75 | yes -> yes | 84.0 -> 85.1 | 49.5 -> 48.8 | neutral |
| 2 | 97.1 -> 98.6 | 98.61 | yes -> yes | 81.3 -> 82.7 | 63.3 -> 63.1 | neutral |
| 3 | 74.1 -> 75.7 | 75.65 | yes -> yes | 88.8 -> 93.3 | 36.3 -> 34.1 | neutral |
| 4 | 82.4 -> 83.4 | 83.39 | no (McConkey vs Kelce) -> yes | 91.9 -> 93.2 | 41.1 -> 40.9 | neutral |
| 5 | 83.8 -> 85.8 | 85.78 | no (Tate vs Sutton) -> yes | 71.5 -> 73.0 | 62.3 -> 62.5 | neutral |

**L5: ceiling lineup and season sim.** Both run on all 5 leagues. Nick's odds were averaged over 3 seeds x 1,500 seasons (`sim-seeds.txt`). Every change is within simulation noise: per-seed differences have both signs.

| League | Playoff | Title | Expected wins |
|---|---|---|---|
| 1 | 65.9% -> 65.4% | 22.7% -> 21.5% | 7.57 -> 7.61 |
| 2 | 59.4% -> 58.1% | 11.0% -> 10.4% | 6.74 -> 6.67 |
| 3 | 27.5% -> 26.1% | 4.1% -> 4.1% | 5.66 -> 5.60 |
| 4 | 35.5% -> 35.5% | 3.3% -> 3.3% | 5.83 -> 5.84 |
| 5 | 86.1% -> 86.1% | 17.6% -> 17.7% | 8.23 -> 8.23 |

## Test specification
| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | Start/Sit never starts, compares against, or lists an IR player (mean / ceiling / floor) | `decision-leftovers-lineup: J1 Start/Sit (x3)` | integration (real solver, mocked prices) | PASS |
| 2 | IR players are named in `on_ir` with a reason | `J1 IR players are reported ...` | integration | PASS |
| 3 | The mean lineup is the best healthy lineup at the Start/Sit week points | `J1 the mean lineup ...` | integration | PASS |
| 4 | Warning says "X% likely to play this week" | `J1b` | integration | PASS |
| 5 | A Sleeper reserve player is excluded | `J1c` | integration | PASS |
| 6 | The ceiling lineup never takes an IR player (ceiling and mean) | `decision-leftovers-home-away: J1d` | integration | PASS |
| 7 | Card "You" = Start/Sit projection, lift included; same starters | `J5 (x3)` | integration | PASS |
| 8 | Waddle-type player (week 2, ros 10) is not the cut; Corum is | `decision-leftovers-waivers: J2 the one-bad-week ...` | integration | PASS |
| 9 | Every claim meets (a)-(c), checked by independent recomputation | `J2 every immediate claim ...` | integration | PASS |
| 10 | Tie order (d) is followed | `J2 the rule is chosen ...` | integration | PASS |
| 11 | No safe cut: held back, with gain and reason; rule text returned | `J2 a claim with no safe cut ...` | integration | PASS |
| 12 | A season-ending player is a free cut (guard) | `J2 a player flagged out ...` | integration | PASS |
| 13 | IR is never the cut (guard) | `J2 IR players are never the cut` | integration | PASS |
| 14 | A teamless free agent is never on the board, and the count covers only rows actually removed | `J3` | integration | PASS |
| 15 | Home and away draws use the same multiplier: the game script alone | `J4 ceiling-lineup / season-sim (no signal)` | integration (sampler spy) | PASS |
| 16 | The matchup factor is `matchups.js#gameMultiplier`, not a local literal | `J4 ... gameMultiplier` | integration | PASS |

## Coverage
New tests plus `lineup-evidence.test.js`, run with `--experimental-test-coverage` (lines / branches):

| File | Lines | Branches |
|---|---|---|
| ceiling-lineup.js | 99.2% | 81.3% |
| lineup-brain.js | 97.3% | 80.7% |
| waiver-wire.js | 99.7% | 67.7% |
| lineup-posture.js | 87.6% | 44.2% |
| season-sim.js | 80.5% | 59.1% |
| All five | 92.7% | 71.1% |

The uncovered parts are all old code that this change did not touch: the posture swap search, the season-sim bracket, and the evidence helpers in lineup-brain.

## Regression evals
- **24 targeted files** (every test that imports these modules or their routes, plus the other step-1b items' files): identical pass counts before and after. Examples: decision-inbox 17, lineup-evidence 16, model-integrity 94, waiver-brain 8, wong-routes 20, ros-projection 24, availability-role 17, weekly-early-week-blend 19. Files: `regress-base.txt`, `regress-after.txt`.
- **Full suite on clean snapshots** (`git archive` plus only this item's files). Before, at HEAD services: 2340 tests, 40 failing. The intermediate snapshot (before the J1d fix) had 23 failing. The only difference is the 17 tests of this item passing. No test fails after that passed before. The 23 failures shared by both runs belong to other work:
  - 6 are the fake-floors RED tests (`player-week-distribution`);
  - the rest are snapshot-only gaps (draft-capture, platform-paths, nfl-execution-integrity) or `prop-clv-free-capture`, which also fails in the real checkout.
- **Final snapshot** (HEAD `71cbeb9` plus this commit's services): 2343 tests, 2279 pass, 23 fail, 41 skipped. The 23 failures are exactly the shared set above, with 0 new. All 22 of this item's tests pass. Files: `fullsuite-*.txt`, `fails-*.txt`.
- `npx tsc --noEmit` exit 0; `npm run lint` exit 0; `npm run build` exit 0. The build went to a scratch `--outDir` so the running server's `client/dist` was not replaced mid-run.

## Known gaps and follow-ups
1. Rule (a) compares raw `ros_ppg` across positions. A streaming QB's number is naturally high, so he "outvalues" a bench RB. In league 3, 13 claims, most of them QBs behind Jayden Daniels, cut Zach Charbonnet (ros 10.02). Rule (b) protects the rest-of-season lineup, not bench depth. Several of these QB claims exist only because Daniels' week number is 9.58, since his chance to play reads 0.57. They should disappear once the play-chance fit is activated.
2. The protection depends on `ros_ppg`. Players with no 2026 game still carry the weekly number (a risk noted in the ROS item). `ros_ppg` has no availability term.
3. Roster name matching. waiver-wire.js and lineup-posture.js take the first asset with a matching name; lineupCall matches the ESPN id first. The asset table has retired, teamless namesakes ("Antonio Williams" RB, "Mike Washington Jr." RB, both 0/0). Today the first match is the right player, but that depends on row order. Moving both files to ESPN-id matching would remove the risk.
4. `SPREAD_SCALE` in lineup-posture.js was fitted on the unlifted number. `scripts/fit-posture-calibration.mjs` should be re-run on the new basis. P(win) moved by at most 2.2 points and no stance changed.
5. "Protect the floor" scores 0 in all 5 leagues: every starter's floor is 0 at the current chance-to-play. So among non-IR players, that lineup is arbitrary. This belongs to the fake-floors and play-chance items.
6. The stash cut (the weakest rest-of-season bench player) was not changed. It is not held to rule (a) across positions.
7. The season sim still rosters IR players in future weeks, since they can come back. This was intentionally not changed.
