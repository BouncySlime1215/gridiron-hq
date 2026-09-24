# BUILD PLAN: the one plan every build workflow, cloud session and local job follows (target league = leagues.id 4)
Written 9/23 ~11:50 PM (Nick: "do you have a plan the build workflows are on?"). Source of truth for order. Queues (lanes/build-queue.json, lanes/cloud-queue.txt, lanes/local-queue.txt, lanes/workflow-queue.json) are filled FROM this file, top to bottom. A unit may start only when its "needs" are merged or it branches from their PR heads.

## Phase 0: Integrate (tonight, done by ~2 AM)
| unit | what | needs | lane | status |
|---|---|---|---|---|
| merge batch 1 | 241 174 244 243 239 236 240 216 242 235 | - | local agent (merge train) | running |
| merge batch 2 | 246 237 227 233 231 230 234 + 228 229 247 + green FIX PRs | batch 1 | merge train | queued |
| FIX-00 | profiles readable again + Nick's overrides (profile-reader seed) | - | cloud | PR #260 |
| FIX-01 | follow ledger -> migration 082 | - | cloud | running |
| FIX-02..08 | contract, flags, partner rules, view, Coach dock, inputs, reasoning | FIX-03 | cloud + local rebaser | PRs landing; rebaser puts each on FIX-03 |
| FIX-09/10 | eval seams (083), flags for visible features | - | cloud | PR #262 (10) |
| FIX-11 | integration smoke on league 4 | batch 2 | local lane | waits |

## Phase 1: the War Room works on league 4 (by morning, ~4 AM)
| unit | what | needs | lane |
|---|---|---|---|
| FIX-03 #272 | producer writes the contract (verified: 0 errors on real data) | #238 #233 | cloud, done |
| FIX-04 | screen reads the contract; best plan is card 1 | FIX-03 | cloud |
| FIX-05 #274 | report card + number health gate the plan | FIX-03 | cloud + rebaser |
| FIX-06 | Coach docked, reads the same keys | FIX-04 | cloud |
| WR-L4 | opens on league 4, header filled | FIX-04 | build workflow |
| FEAS-140 | 140 pts/week card always on; killed wait-or-act off | FIX-03 | build workflow (running) |
| COACH-MSG | exact grounded message + reply table + walk-away per step | FIX-03 | build workflow (running) |

## Phase 2: the people brain (Thu 9/24 - Fri 9/25). See PEOPLE-FLOW below
| unit | what | needs | lane |
|---|---|---|---|
| PEOPLE-01 | one profile reader (FIX-00 + COUNTERPART-01 #254) | FIX-00 | cloud (done) -> merge |
| PEOPLE-02 + SHOT-01 | nightly profile refresh + screenshot trades as proposals | - | local (PR pending review) |
| COUNTERPART-02 | planner simulates each manager's reply | #254, FIX-03 | build workflow (running) |
| TELLS-01b | tells card + clone features | - | cloud PR |
| PULSE-01 | chat pulse: new labelled statements -> events -> replan | PEOPLE-02 | build queue |
| CRED-01 | per-manager credibility weights from own follow-through, updated nightly | PEOPLE-LAB code | build queue |
| M7-TIMING | urgency windows -> send_when | - | cloud (queued) |
| BANDIT-01 | message framing bandit (M5) | offers log | cloud (running) |

## Phase 3: always-on loop (Fri 9/25 - Sat 9/26)
| unit | what | needs | lane |
|---|---|---|---|
| PRODUCER-FAST | producer < 60 s so it replans every refresh/event | FIX-03 | build queue |
| STEP-LOG | sent offers -> campaign_steps -> realized gain (E5) | FIX-09 | build queue |
| PUSH-01 | push when next move changes | - | cloud (running) |
| EA-06/07 | monitors + one world per week | - | cloud |
| CATCHUP-LIVE | live catch-up + priced speed levers | FIX-03 | build queue |
| NEGOTIATE-UI | live negotiation mode (see UI) | FIX-04, COACH-MSG | build queue |

## Phase 4: the report card grades everything (Sun 9/27 - Mon 9/28)
E1 (yes-odds) live on league offers, E2 price at yes-point, E3 done, E4 planner vs baselines (EVAL-E4 running), E5 step value (STEP-LOG), E6 follow vs ignore (FIX-01 + SELF-01b), E7 luck vs decision (AUTOPSY-01). The people modules M1-M10 each get their follow-through stat on the card. Failing -> Balanced fallback (FIX-05).

## Rules
One producer per number. Every unit is behind a flag, on under preview. Every people feature is a weighted, graded feature, not a rule. Labels, never chat quotes, leave the chat DB. Nick's overrides beat everything.
