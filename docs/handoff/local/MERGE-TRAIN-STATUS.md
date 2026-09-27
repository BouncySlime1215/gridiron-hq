# Merge-train status (2026-09-23)

Base: origin/main c1f17cee (#189). Every PR below had origin/main merged in (no rebase), was pushed, and has CI SUCCESS, mergeable CLEAN at the head shown. Nothing was merged or marked ready.

HOLDOUT-LEDGER ids are pre-allocated across the train so the queued PRs stop clashing with each other: main holds L154/F001 (CE-05). WV-01 #176 L155-L156/F002, AI-01 #181 L157-L158/F003, WV-02 #178 (and #191 via #178) L159/F004, RL-11-1 #203 F005-F006. Gaps in main are ids reserved for PRs still in the queue.

| PR | resolved files | tests (local) | pushed head | notes |
|---|---|---|---|---|
| #176 | docs/evidence/HOLDOUT-LEDGER.md (L154/L155->L155/L156, F001->F002); test stubs for StreamingBoard in lineup-error-no-leak + start-sit-ceiling-uncalibrated | 48/48 (streaming-board + 5 Lineup render tests); tsc ok; wiring ok | `706d33b1` | re-merged main again after #189 landed (clean) |
| #182 | client/src/pages/MyTeam.tsx (imports: kept sanitizedAlert + PageLoading/leagueGate) | 152/152 (4 own + MyTeam tests + wiring-map); tsc ok | `41ec435d` | shares ux08b content with #175 |
| #181 | docs/evidence/HOLDOUT-LEDGER.md (L154/L155/F001->L157/L158/F003) + tdd refs | no own tests (docs+study script); check-prereg-order 16/16; node --check ok | `f294c6fc` |  |
| #183 | none (clean); CI root cause = slow runner hit 20-min job timeout, 0 failures | 38/38 (trade-market + dead-starter + lineup-signals, share routes/trades.js); tsc ok | `22f37887` | CI was cancelled at the 20-min job timeout, 0 failures (slow runner: ~2.3x slower across the whole suite); new run green |
| #188 | client/src/pages/MyTeam.tsx (imports kept both); test stub map in int-168-1 test gains leagueGate (real, compiled) + PageLoading | 106/106 (own + MyTeam tests + wiring-map); tsc ok | `01f8bd0f` | CI had failed (also before this pass) on a test.after race in its own test; fixed by registering cleanup after the last top-level await |
| #187 | none (clean); then merged #183 head 22f37887 so S-19 contains TM-09's current tip | 61/61 (hype-one-producer, trade-market, dead-starter, lineup-signals, trade-engine-correctness); tsc ok | `9db3a7c8` | land after #183 |
| #186 | client/src/pages/LeagueHub.tsx (main's tabless leagueGate page + CommandCenter); command-center.test.js pins lineupDiff path in 2 route tests, real-detection test expects SS-01 producer | 121/121 (command-center, ux-11, wiring-map, dead-starter-guard); tsc ok; wiring ok | `a3589386` | HAZARD: 'feature detection' test asserts streams = not_merged (waiting_on WV-01 #176) via real import detection; once #176 lands, #186 needs a re-merge and that expectation updated (injury_alerts is mocked, so #178 does not affect it) |
| #171 | server/services/lineup-brain.js (signature: main's inactive opt), server/services/trade-engine.js (kept weekLineup + pinnedBestLineup) | 174/174 (2 own + 14 lineup-brain/trade-engine tests); tsc ok | `a9eb4838` |  |
| #178 | none textual; HOLDOUT rows renumbered L155->L159, F002->F004 (pre-allocated) + tdd refs | 60/60 (own + waiver/lineup tests + prereg-order); tsc ok | `6c71b278` |  |
| #191 | none (clean main merge), then merged #178 head 6c71b278 (brings renumbered ledger rows) | 51/51 (own + waiver/lineup tests); tsc ok | `f06c5df4` | draft; land after #178 |
| #175 | client/src/pages/MyTeam.tsx (imports kept both) | 130/130 (own + MyTeam tests + wiring-map); tsc ok | `6955c1b1` | overlaps #182 (same ux08b content): whichever lands second may need a trivial re-merge |
| #73 | none (clean) | 38/38 (design-system-tokens + index.css/html tests); tsc ok | `2f6096ad` | draft |
| #192 | none textual; post-CI fix: server/routes/model.js passes scoring: scoringFor(lg) again (same value tradeImpact defaults to) + TRADE_IMPACT_RUNS added to scoring-call-sites.test.js season-sim mock | 251/251 (own + season-sim/model-route tests incl. scoring-call-sites); route-deletion-impact #6 fails locally on origin/main too (pre-existing, Node 25 local; green in CI) | `4b4c3f63` | first CI run failed scoring-call-sites (semantic clash with #163); fixed |
| #194 | none (clean; overlap trades.js, trade-engine.js) | 307/307; tsc ok | `b9828a3d` |  |
| #195 | none (clean, no overlap) | 96/96; tsc ok | `de9e527a` |  |
| #196 | none (clean, no overlap) | no node tests; python unittest 16/16 | `edd3063b` | draft |
| #197 | none (clean; overlap Lineup.tsx, lineup-brain.js) | 184/184 own + lineup tests; tsc ok | `68263983` |  |
| #198 | client/src/pages/Lineup.tsx, server/services/dead-starters.js, server/services/lineup-brain.js (3-way on SS-01 b53a28b1 base: final #185 + RL-10-1 additions) | 369/369 (dead-starter-guard, espn-zero-inactive + lineup/start-sit/manager-signals tests); tsc ok | `54f8037d` | first CI run cancelled at the 20-min timeout, 0 failures (slow runner); gh run rerun 35867002250 -> green. Land after #185 (merged) |
| #199 | none (clean) | 14/14; tsc ok | `af3e78ec` |  |
| #201 | none (clean) | 27/27; tsc ok | `9d78129c` |  |
| #202 | none (clean) | 11/11; tsc ok | `1308b9bc` |  |
| #203 | none textual (overlap manager-signals); HOLDOUT F002/F003->F005/F006 (pre-allocated) + tdd refs | 471/471 (own + manager-signals-touching tests + prereg-order); tsc ok | `56bb53c6` |  |
| #204 | none (clean) | 12/12; tsc ok | `a346d321` |  |
| #205 | none (clean) | 7/7; tsc ok | `e3f308f5` |  |

## Queue order (dependencies respected)

176, 182, 181, 183, 188, 187 (after 183), 186 (re-merge after 176, see hazard), 171, 178, 191 (after 178; draft), 175, 73 (draft), 192, 194, 195, 196 (draft), 197, 198, 199, 201, 202, 203, 204, 205

## Cross-PR hazards
- #186 vs #176: see the #186 row.
- #175 and #182 carry the same UX-08b change (identical test/ux08b-alert-error-no-leak.test.js). Whichever lands second may need a small re-merge.
- Lineup.tsx render tests (test/lineup-error-no-leak.test.js, test/start-sit-ceiling-uncalibrated.test.js) stub every import on the page. Any PR that adds a Lineup.tsx import must add a stub there. #176 did that here. Watch #197 and #198 after #176 lands.
- Locally on Node 25, test/route-deletion-impact.test.js #6 fails on plain origin/main too. It passes in CI (Node 22), so it is not caused by any PR here.
- The TM-09 and S-19 named worktrees had 41 leftover staged files, so this pass used pr183/pr187 and left those two untouched. Mid-merge states in pr176/181/182/186/188 were aborted before starting.
