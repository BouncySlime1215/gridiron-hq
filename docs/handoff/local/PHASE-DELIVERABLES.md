# PHASE DELIVERABLES, UI, R&D RESEARCHERS AND MODELS PER STAGE (2026-09-23 ~2:00 AM ET). Nick: "ok with 4: you stay here until it's ready and done. STATISTICALLY INSANE." Planning only until "go".
Ruling recorded (WORK-QUEUE §12): the coordinator stays on the Trade Machine v1 phase until every deliverable below is landed, graded and audited; other phases only fill idle slots.

## Models per role (build-side)
- Coordinator, Independent Auditor, hardest statistical skeptics (claims lens on model/engine units): Fable 5.1 (this session's model).
- Builders of model, engine and trade-valuation units; wiring/liveness/structure skeptics: Opus 5.5.
- Lean builders for UI, docs, ledgers, wiring-only units; board keeper; recorders; PR-body steps: Sonnet 5.
- Mechanical: log rendering, census, monitors, integration cards: Haiku 4.5 or scripts.
- Training: gradient-boosted trees and logistic/ridge in Python 3.12 on this Mac (LightGBM/XGBoost, scikit-learn), sequence nets in PyTorch on this Mac; served in Node as exported weights or precomputed tables (one producer). Nothing trains on the small Fly box.
## Models per role (in-app, via Jev; needs Nick's weekly cap; balance checked first; every call metered in ai_usage)
- Situation reader (AI-03): three voters, Claude Sonnet 5 + GPT + Gemini, structured JSON, calibrated vote; Claude Opus 5.5 only for disagreements.
- Twins (AI-06) and analyst briefs (TM-07): Claude Opus 5.5 with retrieval (embeddings via Jev's embedding model over the local chat index; index never leaves the Mac).
- Pitch and objection writer (AI-10): Claude Sonnet 5 through the Coach verifier; Opus for the final draft only when the deal is top-3.
- Web research (TM-08): Jev's cheap search + Haiku 4.5 summaries; licence note stored per item.
- Statistical models (AI-01/02/04/05/08/09, CE-*): no LLM; trees, nets, ridge, PU-learning, Monte Carlo.

## Phase 0: finish in-flight (Opus builders/skeptics as launched; resume from cache). Deliverables: BLEND-01 merged (ESPN base ship rule live; evidence + prereg on main); HX-01 merged (historical head-to-head evidence); S-03 merged (projection fix before week 5); C-01 #160 merged (start/sit gate v2); B-01 #162, A-03 #163, SY-02 #161, C-12 #73 verified and merged; skill-split report delivered (rnd/skill/REPORT.md, skeptic verdicts read to Nick).

## Phase 1: Foundations (Opus builders; Fable auditor on every number)
| Unit | Deliverable (code / table / route / page / evidence) | Statistical bar |
|---|---|---|
| CE-05 rules | services/league-rules.js (scoring, slots, IR, deadline, review window, playoff format, seeds, tiebreakers) from A-01 fields; test fixtures for all 5 leagues; docs/evidence/…/league-rules-replay.md | 2025 replay reproduces every real seed |
| TR-01 chance-to-play | fix in trade-engine.js:340-362 chain + lineup-brain; RED test; evidence with the live-vs-history comparison | healthy undesignated starter P(play) within 0.03 of the measured played share |
| TR-03 value inputs | A-07 scoringFor on every trade surface, S-07 real horizons, S-10 one value store; contract test across TradeCard / TradeLab / title odds | one producer, zero disagreement in the fixture universe |
| AI-01 true value | services/true-value.js on opportunity-model.js; ros = f(expected points, availability, schedule); luck column; registry entry; prereg doc | opportunity ROS beats points ROS at predicting the next 5 weeks 2021-2025, CI clear, MDE stated |
| TM-09 market prices | scripts/build-market-prices.py (Sleeper trade_sides) -> table market_price; job weekly; page: Trade Brain price chip | held-out price MAE; hype decay curve (RS-04) |
| AI-04 price model | trees in Python, exported table; registry entry | beats "ESPN rank -> price" baseline on held-out weeks |
| TM-06 backtest harness | scripts/backtest-trades.py + docs/evidence/…/trade-backtest-prereg.md (committed BEFORE results) + results doc | decision win rate of our verdict vs ESPN-value and season-to-date baselines, 90% CI, MDE at 80% power, BH across the tests |
| FantasyCalc test | docs/evidence/…/fantasycalc-disagreement.md | our side right >55% on 15%+ disagreements, CI clear of 50%; else the finder ships labelled "no proven edge" |
| GR-05 discipline | docs/STATS-CONTRACT.md (prereg template, holdout ledger, MDE, BH, week-clustered CIs, forward-only for LLMs); registry check that a prereg commit predates any result | contract test fails a model without a prereg |
| GR-01 ledger | table rec_ledger + services/rec-ledger.js helper used by every recommending route; grader job; considered-not-proposed rows (C-08) | fixture recs graded at +1w/+2w/+5w correctly |

## Phase 2: Engine (Opus builders; Fable auditor; Sonnet for the UI ladder)
| CE-01 game sampler | services/sim/game-sampler.js from game_lines; power ratings for future weeks (TM-12) | team-point coverage and calibration by spread bucket 2022-2025 |
| CE-02 player sampler | services/sim/player-sampler.js: shares × team points with ranges (BLEND-02 layers only where proven) | 80% ranges cover 80% ±3; same-team correlation matches history |
| CE-03 availability sampling | uses ST-01 oracle + TM-11 durations | simulated games missed match 2022-2025 |
| CE-09 one currency | tradeImpact extended: paired seeds, ladder (do nothing / best claim / best trade / best trade + lineup); tables sim_state, action_price; OddsLadder component on My team, TradeCard, WaiverWire | contract test: one producer; delta SE about 0.3 pts at 10k |
| CE-06 event bus | services/events.js; handlers for news, sync, lines, waivers, counters, live scores; incremental re-sim; stall detection (D21) | injury event re-prices its league under a minute |
| CE-10 sim grading | weekly job writing Brier/calibration to the registry; zoo page row | matchup win probability calibrated; beats ESPN's projected winner |

## Phase 3/4: Trade Machine v1 (STAY HERE UNTIL DONE; Opus builders, Fable auditor on every number, Sonnet UI)
| Dossiers | rnd/dossiers/<league>/ (local only) + aggregate fields into manager_signals (no names in repo) | every number with command and n; THIN marked |
| LS-01 lineup signals | job after league sync -> table lineup_signal; SignalChip on ManagerRead and TargetBoard; evidence doc on the Sleeper test | benched+shopped+usage-intact outscore price over 4 weeks, CI |
| TM-03 target board | /trades/:id/brain/managers extended; TargetBoard component (Trade Brain) | n on every read |
| AI-05 acceptance | PU model in Python -> table; replaces acceptanceBand centre; registry | reliability curve beats fair-tier default |
| TM-17 pain calendar + TM-30 reaction lag | services/pain-calendar.js; columns on the target board | RS-02 result attached |
| TM-02 tags | services/trade-tags.js (schedule swing, regression, role trend, injury) with numbers | tagged sells lose value vs untagged (PRE) |
| TM-04 pitch ladder + counter evaluator | /trades/:id/evaluate extended; EvaluatePanel (Trade Lab); MESO packages via offer-many (TM-31) | ungrounded digit refused; MESO default |
| TM-01 finder | /trades/:id/find extended (his_screen, real, odds_delta, tags, accept) | fixture ranking; FantasyCalc test passed or label |
| TM-05 decision tree | /trades/:id/find/sequences extended; RoadmapTree on Trade Brain | 3-step fixture with odds rising |
| DD-01 doomsday | table scenario_card; ScenarioCards on My team | pre-planned responses beat late reaction on replays |
| GT-01 game theory | inside the planner: rival-aware, minimax regret, variance choice | rival-aware vs plain on replays |
| LL-01 luck ledger | served from luck-panel logic; LuckLedger on My team | matches the study's method |
| GR-02 report card | /grades/:id/report-card; ReportCard on My team | decision win rate vs ESPN and do-nothing, points per decision, calibration, trust per feature |
| GR-06 receipts | offer_ledger + receipts at +2/+5 weeks; Receipts on Trade Brain | per-manager acceptance calibration; pitch-style experiment log |
Exit criteria for the phase (all must hold): FantasyCalc test passed or the finder labelled; TM-06 backtest published with CI and MDE; every served number has a registry entry, a prereg commit and an auditor sign-off; the report card shows the first graded week; zero unwired tables (wiring gate 0 new findings).

## Phase 4 alongside: Start/sit + rhythm (Sonnet lean builders for UI; Opus for ST-02/ST-03 statistics)
SS-01 guard (DeadStarterGuard on Start/Sit), WV-01 streaming board (StreamingBoard on League Hub), WV-02 injury alert, WV-03 snap share, SK-01 command center (CommandCenter on League Hub), ST-02 floor/ceiling (FloorCeilingToggle), ST-03 late-swap windows (LateSwapWindows). Each: RED fixture test; ST-02/03 with the history test.

## Phase 5: AI tier (Jev cap needed for AI-03/06/10, TM-08; Opus builders; Fable auditor)
AI-02 forecaster (Python; exported), AI-03 reader (role_shift table), TM-08 research feed (ResearchFeed on News), AI-06 twins (local index; aggregate acceptance into AI-05), AI-07 source inference, AI-08 regression classifier (RegressionRadar), AI-10 writer, AI-11 preference (thumbs on every card -> rec_ledger), CE-07 planner (MCTS), AI-09 value net (kill-or-confirm doc), AI-12 zoo page (registry read; ModelZoo on Settings or My team). Bar: each leads its baseline on held-out and forward before it moves a number; LLM pieces forward-only.

## Phase 6: insane tier and new ideas (continuous): TM-16..42, NX-01..10, ST-04..11, RS-02..06; each behind its test; researchers feed this phase.

## UI deliverables (design system from C-12 #73 once verified; 8 tabs unchanged)
Shared: OddsLadder, SignalChip, ScenarioCard, ReportCard, ReceiptCard, TagPill (with the number), GuessLabel. My team: ladder, scenarios, report card, luck ledger, portfolio risk. Trade Brain: TargetBoard, OffersOut, CountersIn, RoadmapTree, RegressionRadar, Receipts. Trade Lab: EvaluatePanel (his screen vs real, odds delta, tags, pre-mortem, pitch ladder, counter evaluator). Start/Sit: DeadStarterGuard, AvailabilityChips, FloorCeilingToggle, LateSwapWindows, LiveTracker. League Hub: ManagerRead+signals, StreamingBoard, InjuryAlerts, CommandCenter. News: ResearchFeed, Briefs. Settings: JevCap, Alerts, AutopilotScope, ModelZoo link. Rules: three lines per card, one tap, guesses labelled, no walls of text, names in-app only, mobile first (D23).

## R&D researchers (standing agents; they may ADD to the plan only through the validity + implementation assessors and the coordinator's approval; Nick sees additions as "proposed" on the board)
- R1 Trade-market researcher (Sonnet explorer, Opus assessors): Sleeper corpus: prices, timing, acceptance, position runs, IR-slot effects; proposes RS units.
- R2 Negotiation-science researcher (Sonnet + Jev search): MESO, anchoring, framing, reciprocity, deadline effects; proposes pitch experiments for TM-21.
- R3 Data-source scout (Sonnet): licence-first feeds (practice reports, weather, FTN, trends, depth charts); proposes TM-1x pulls with terms quoted.
- R4 Sim/ML researcher (Opus): samplers, calibration, value nets, PU learning, planner search; proposes CE/AI improvements with a kill-or-confirm test.
- R5 Internal structure scout (Opus): duplicate numbers, unwired tables, stale evidence; proposes S units.
- R6 Product/UI researcher (Sonnet): what the best fantasy tools show and how; proposes UI units against the design system.
Cadence: R1-R6 each run one round per day while slots allow (rnd-loop.js pattern: explorer -> validity assessor -> implementation assessor -> recorder), aggregates only, no paid calls beyond the Jev cap.

Model pinning (02:45Z): the session model can change (it is Opus 5.5 now), so the v2 scripts pin roles explicitly: auditor and claims/statistics skeptic model: "fable"; builders and other skeptics model: "opus"; lean builders, recorders and the board keeper model: "sonnet"; mechanical model: "haiku". No role inherits the session model by accident.
