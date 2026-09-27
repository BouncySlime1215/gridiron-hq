# Gridiron HQ plan — items 1-25, VERBATIM

**Source:** "PART 5 — Nick's approved additions", Nick, 2026-09-21T19:58:42Z,
message `cmsg_01YAsw8AnFv4ioRMQw8dfPmTRwtoUfvgWYLwXAcxCgATNx`. Full body relayed by the
coordinator 2026-09-22 ~17:45Z; text below is that body unaltered (typos and punctuation
kept). Phase order/ranges: Foundation (Phase 0, Nick's GO `cmsg_01YAsw8AnFv4ioRMQw8dfPmT8hKXRheXe6eCXwGuAPPEAb`,
01:25Z 2026-09-22) → A (1-3) → B (4-11) → C (12-20) → D (21-25). Companion messages:
"PLAN UPDATE v2" `cmsg_...EADG` (20:13:55Z, status points only) and compiled directives
`cmsg_...EtD` (19:52:53Z). All 25 items recovered; none marked NOT FOUND.

## Foundation (Phase 0 — Nick's GO, items 1-7; condensed record from gridiron-go-plan-2026-09-22.md, not part of PART 5)

1. Confirm wiring map stopped + panel lines rewritten.
2. 24-job live-tier stall table with monitorEventLoopDelay against a DB copy; >60s = killer, >10s = suspect.
3. Freshness registry + PR that kills the fake data-healthy banner, in the SAME PR.
4. Trade-acceptance outcome logging contract; first real row gated on Nick's ESPN cookie, never faked.
5. Honest-inventory contract.
6. Open-PR triage: 49 open, 46 draft, 3 ready (#56, #59, #61).
7. Deploy sequence — PREP ONLY, against 654ff93.

## Phase A (1-3) — PART 5 heading: "PHASE A — FOUNDATION"

1. LEAGUE CONFIG AUTO-INGEST (Nick: "have the model auto do it"). The model pulls and verifies ALL league settings itself: scoring (PPR, pass TD value, bonuses), lineup slots, bench/IR, waiver type, FAAB budget, trade deadline, playoff structure, keeper/dynasty rules. Then it PROVES the projections use the right scoring with a verification check. If any setting can't be confirmed, it says so loudly instead of guessing. Keeper/dynasty detection changes trade valuation entirely — get this wrong and every trade number is for the wrong game.

2. DEEP PREDICTIVE FEATURE SET (Nick: "the biggest add"). Routes run (not just targets), OL-vs-DL matchups, team pace/play volume, red-zone touches inside the 10, coaching run/pass tendencies and 4th-down aggression, practice participation (DNP/Limited/Full), depth-chart changes. Insane bar: every feature must prove predictive lift on historical data before it earns a place in the model — no feature gets in on vibes.

3. BEAT REPORTER SOURCE MAP (Nick: yes, insane). The news reader is only as good as its sources. Build the per-team beat reporter map: who to trust, who's noise, plus national aggregators. Score sources historically: whose reports actually predicted outcomes vs. who cried wolf. The reader reads the best sources first.

## Phase B (4-11) — "PHASE B — DECISION ENGINES"

4. WAIVER WIRE SYSTEM (Nick: insane). FAAB bidding strategy (when to go big, when to hold — game-theoretic, not greedy), DST/K/TE streaming optimizer, stash-vs-drop expected value of every roster spot, handcuff logic modeled from historical backup production not folk wisdom. Insane bar: it should beat a sharp human on the waiver wire over a simulated season.

5. DEFENSIVE ADDS + KICKER DENIAL (Nick: insane, same logic for kickers). Roster warfare: adding a DST or kicker so your opponent can't stream them against you. Model the denial value, not just the points value.

6. TRADE ACCEPTANCE PROBABILITY (Nick: "idc about veto — just will they ACCEPT"). The only question: P(they hit accept). Per-manager models: what each human overvalues, their roster desperation, their trade history. Calibrated probabilities. Start honest ("experimental — 30 real outcomes") and let the logging make it strong.

7. TRADE TIMING (Nick: insane insane). WHEN matters as much as what. Buy-low windows after bad games, Tuesday post-waiver need shifts, deadline urgency curves. The engine proposes the trade AND the hour.

8. THREE-TEAM TRADES (Nick: insane insane). The biggest edges live here. Build the 3-team trade finder: who needs what, who has surplus where, construct the triangle.

9. PLAYOFF PROBABILITY ENGINE (Nick: insane). Rest-of-season sims output playoff odds and expected finish, not just points. "You're 62% for playoffs; this move takes you to 78%." Playoff-week schedules (weeks 15–17) priced into every trade and add.

10. WEEKLY OPERATING RHYTHM (Nick: insane). The app runs on the NFL week: Tuesday waivers, Wednesday trade targets, Thursday TNF decisions, Sunday-morning inactives scramble, Monday night review. Design the ops calendar — the product has a heartbeat, not random agent schedules.

11. PUSH NOTIFICATIONS / GAME-DAY MODE (Nick: insane). "Your RB is OUT — here's your pivot, tap to apply." Sunday-morning inactives are the highest-leverage 90 minutes in fantasy. Own them.

## Phase C (12-20) — "PHASE C — HONESTY & LEARNING (the brain)"

12. BEAT-THE-DUMB-BASELINE GATES (Nick: insane). Nothing ships unless it beats the dumb version: start/sit must beat "start highest projection," trades must beat "offer fair value," waivers must beat "add highest projected FA." Standing gate, re-run continuously. If it can't beat dumb, it's decoration.

13. DECISION POST-MORTEM LOOP (Nick: "how did we approach it, how did it play out, what did we learn"). Every week, every significant decision gets the three-question teardown: (1) How did we approach it — what did we believe and why? (2) How did it play out — what actually happened? (3) What do we learn — what changes in the model? Automated, weekly, unavoidable. This is the learning loop made personal and specific.

14. LUCK DECOMPOSITION (Nick: insane). Decompose every result: expected wins vs. actual, decisions vs. noise. Over a season, answer "are we good or just lucky" with numbers. The 80/20 claim gets measured, not asserted.

15. CAUSAL NEWS IMPACT (Nick: 100% add). Not correlation — causation. Natural experiments: same news shape, real vs. overblown outcomes. Difference-in-differences around news events. If you can't show the news CAUSED the movement, it's narrative.

16. INJURY RESPONSE, NOT PREDICTION (Nick: yessir). Predicting injuries is fool's gold — don't. The edge is pure response speed: news breaks → model updates → Nick notified, measured in minutes. That's the latency metric.

17. SELECTION-BIAS FIX FOR TRADE LOGGING (Nick: "how can we fix"). The problem: we only observe outcomes of trades WE propose — the data is censored. Fixes: log considered-but-not-proposed trades too; two-stage model P(propose)×P(accept|propose); treat counters as partial acceptance signal; per-manager response curves; a small exploration budget of low-stakes offers to learn (not spam). Name the bias in every report until it's handled.

18. GOODHART / ACCURACY-THEATER GUARDS (Nick: yes, insane). Once the scorecard is public, agents will game the metric. Guards: optimize DECISION win rate, not projection MAE (a model can have worse point accuracy and better start/sit calls); holdout sets agents can't see; random audits of claimed accuracy. The metric serves the mission, never the reverse.

19. UNCERTAINTY UI (Nick: yes, but accuracy first). Ranges, not false precision. "60% chance of 10–18" not "14.2." Nobody does this; it's the brand. But every range must be calibrated — a 60% interval that hits 40% of the time is a lie with error bars.

20. THE "WHY" ENGINE (Nick: NEEDS TO BE THE INSANE — flagship). Every recommendation carries a human-evaluable reason: "Start X over Y because: 4 more projected targets, bottom-5 pass defense, 72% routes last 3 weeks." This isn't a feature, it IS the product. It's what makes tested-vs-guessed real in the UI. Insane bar: a sharp fantasy player reads the why and can't poke a hole in it.

## Phase D (21-25) — "PHASE D — ROBUSTNESS & STRATEGY"

21. PIPELINE FRAGILITY FIX (Nick: yes, we need a fix). ESPN changes, cookies expire, scrapers break at 2 AM. Monitoring with alerts, graceful degradation per source, automatic fallback ordering. Nothing rots silently ever again.

22. ONE-LEAGUE OVERFITTING FIX (Nick: ofc). Per-league models on global priors — hierarchical. A new user's league starts smart from global patterns and gets sharper as their data accumulates. Nothing that only works in Nick's league ships as a general feature.

23. DESKTOP + MOBILE (Nick: both). Full parity. Sunday morning with bad data on a phone is the primary battlefield — design for it first, desktop second, but both complete.

24. COMPETITIVE TEARDOWN (Nick: ofc). FantasyPros, 4for4, Establish The Run, FantasyPoints, ESPN/Sleeper built-ins: pricing, strengths, and the verified wedge. Our wedge is "we show our work and learn weekly" — verify nobody else can honestly claim it.

25. KILL LIST (Nick: agree — carefully insane). Standing composer authority to DELETE: dead features, decoration metrics, vibe-producing threads. Cutting is half the job. Careful = everything cut gets a one-line obituary (what it was, why it died, what replaced it) so nothing gets re-built blindly.

## Global rules, not-approved line, and order (verbatim)

GLOBAL RULES FOR EVERY BRANCH: Make each one INSANE, best-in-class or don't ship. NO ASSUMPTIONS, everything measured or explicitly labeled as a guess, Tested-or-Guessing on every number. GET CREATIVE, if the standard approach is weak invent a better one then prove it with data. SCHOLARLY GROUNDING FIRST before executing EACH branch.

NOT APPROVED — DO NOT BUILD: multi-platform league import, offseason product, monetization model, banning narrative features.

Execute Phase A → B → C → D in order. Within a phase, parallelize where threads don't touch.

