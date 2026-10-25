# BUILD PLAN v2 (9/24 ~1:10 AM): supersedes the phase order below; the tables below stay as the unit inventory
Nick 9/24 ~1:05 AM: every brain box should play against every other box thousands of times with thousands of small changes, leverage the other managers and look for weaknesses to attack; Coach should speak exactly like Nick; the coordinator gets attacked every 2 h to find its weak spots.

## Stage 0: CONVERGE (now to about 4 AM). Nothing new stacks on unmerged code
Merge batches 1+2 -> engine hub (#216 + #250) -> ONE-READER, ONE-PLANNER, ONE-COUNTERPART -> the War Room on main without freezing (WR-FREEZE) -> SCALE-140 (sim 73 vs ESPN 140) -> FIXB batches (the sweep fixes) -> open PRs under 35. Gate in RULES.md.

## Stage 1: TRUTH CHECK OF THE CORE (morning, before anything clever)
The sim's points match ESPN league-4 scoring (SCALE-140); title odds calibrated on ESPN league history, not just Sleeper; P(yes) beats activity-only on pooled ESPN offers (E1, today: no); the price band is calibrated (PRICE-BAND-01/02). If the core fails, everything built on it is noise, so this stage decides what the War Room is allowed to claim.

## Stage 2: LEAGUE TWIN + WEAKNESS SCANNER (Thu-Fri): "thousands of runs, thousands of small changes"
- TWIN-01 league digital twin: every manager = his counterpart model (people reader + credibility + mood + activity intensity + clone/neural clone), the one-world sim, and the planner, all playing the league forward together. Each night: 10,000+ perturbed runs (injuries, reply outcomes, timing, price nudges of ±5-15%, message framing, order of offers, who else trades with whom). Output: plans ROBUST across runs (not just best on average), the value of each small change, and which sequences of small moves compound.
- WEAK-01 weakness scanner per manager: roster holes by week (bye crunches, injury exposure), players he overvalues vs our value (sell him those), players he undervalues (buy), tilt windows (after losses/roasts), desperation (playoff odds falling, deadline), attention gaps (inactive = slow to react to waivers), and whom he listens to (influence). Ranked "attack surfaces" feed targets, timing and message framing. Honesty rule: we exploit real weaknesses with TRUE facts and good timing; we never lie in a message.
- Self-play check: the twin replays weeks 1-3 of 2026 and the Sleeper seasons; the planner must beat simple strategies inside the twin AND on held-out real outcomes (E4), or it doesn't ship claims.

## Stage 3: VOICE: Coach speaks exactly like Nick
VOICE-01 (local only: Nick's 11,619 texts, is_from_me, plus his style with the coordinator): a style model covering lowercase, abbreviations (u, ur, rn, pls, bruh, tn, lol), no end punctuation, short bursts, hype words ("insane", "lock in"), and per-recipient register (league chat vs DM vs Josh vs the hard negotiators). It works by retrieving his own similar messages as examples plus a learned style guide. COACH-MSG drafts offer messages in his voice; Coach's chat replies to Nick can match his register too. Graded by a style classifier (can it tell Nick from the draft? target: chance) and later by Nick's picks. Privacy: his texts never leave the Mac except inside model calls he has approved; nothing goes to the public repo.

## Stage 4: INTELLIGENCE LAYER (CONNECTIONS.md)
FUSION-01 learned edge weights, CLONE-NN neural clone, JEV-CROSS cross-box reasoning. R&D rounds 33-34 test them first; each ships only if it beats the current model held out.

## Stage 5: SCREENS (released by the gate): War Room v3 (people board, negotiation mode, his screen), Coach jobs 1-6, COACH-LINK. Then always-on (PRODUCER-FAST, PUSH, STEP-LOG), then the report card (E1-E7 + M1-M10 + twin checks).

## How the coordinator works tonight (efficiency)
- The coordinator orchestrates, verifies and integrates; it builds only when a unit is small and on the critical path. Everything else goes to lanes.
- Lanes: 4 build workflows (converge units only until the gate passes), 1 R&D (when the load is under 14), local 2 (Mac-data jobs), cloud up to 6 (FIXB batches; about $4/session, total under about $150 of Nick's $250).
- Cadence: WORKFLOW KEEPER every 10 min, REVIEW-ON-FINISH every 20 min, handoff push hourly, STEP BACK + RED TEAM every 2 h, Monitor on EVENTS.log for instant reactions.
- One-hop rule: every new unit declares the hub fields it produces/consumes (FIELD-REGISTRY.md); the sweep rejects a second producer.
- Every result is verified before it is believed or told to Nick (prereg predates the result, re-run the headline).

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

## Coach anchors every phase (COACH-ANCHOR.md, Nick 9/23 ~11:55 PM)
Phase 1: COACH-TOOLS (Coach reads plan / people / brain / health, grounded), COACH-NAV. Phase 2: COACH-ROLEPLAY. Phase 3: COACH-NEGOTIATE, COACH-BRIEF. They go first in the build queue after FIX-06.
