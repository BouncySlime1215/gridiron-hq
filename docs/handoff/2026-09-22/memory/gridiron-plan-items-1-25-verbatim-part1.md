---
name: gridiron-plan-items-1-25-verbatim-part1
description: "VERBATIM PART 5 list (Nick's approved plan items), part 1 of 3: Phase A items 1-3 and Phase B items 4-11; part 2 = Phase C 12-20, part 3 = Phase D 21-25 + global rules + not-approved line"
metadata:
  type: project
---

Source: PART 5 — Nick's approved additions, cmsg_01YAsw8AnFv4ioRMQw8dfPmTRwtoUfvgWYLwXAcxCgATNx, 2026-09-21T19:58:42Z. Verbatim, typos kept. Also at /mnt/project-files/PLAN-ITEMS-1-25.md.

Order: Foundation → A (1-3) → B (4-11) → C (12-20) → D (21-25). Continues in [[gridiron-plan-items-1-25-verbatim-part2]] and [[gridiron-plan-items-1-25-verbatim-part3]].

**PHASE A — FOUNDATION**
1. LEAGUE CONFIG AUTO-INGEST (Nick: "have the model auto do it"). The model pulls and verifies ALL league settings itself: scoring (PPR, pass TD value, bonuses), lineup slots, bench/IR, waiver type, FAAB budget, trade deadline, playoff structure, keeper/dynasty rules. Then it PROVES the projections use the right scoring with a verification check. If any setting can't be confirmed, it says so loudly instead of guessing. Keeper/dynasty detection changes trade valuation entirely — get this wrong and every trade number is for the wrong game.
2. DEEP PREDICTIVE FEATURE SET (Nick: "the biggest add"). Routes run (not just targets), OL-vs-DL matchups, team pace/play volume, red-zone touches inside the 10, coaching run/pass tendencies and 4th-down aggression, practice participation (DNP/Limited/Full), depth-chart changes. Insane bar: every feature must prove predictive lift on historical data before it earns a place in the model — no feature gets in on vibes.
3. BEAT REPORTER SOURCE MAP (Nick: yes, insane). The news reader is only as good as its sources. Build the per-team beat reporter map: who to trust, who's noise, plus national aggregators. Score sources historically: whose reports actually predicted outcomes vs. who cried wolf. The reader reads the best sources first.

**PHASE B — DECISION ENGINES**
4. WAIVER WIRE SYSTEM (Nick: insane). FAAB bidding strategy (when to go big, when to hold — game-theoretic, not greedy), DST/K/TE streaming optimizer, stash-vs-drop expected value of every roster spot, handcuff logic modeled from historical backup production not folk wisdom. Insane bar: it should beat a sharp human on the waiver wire over a simulated season.
5. DEFENSIVE ADDS + KICKER DENIAL (Nick: insane, same logic for kickers). Roster warfare: adding a DST or kicker so your opponent can't stream them against you. Model the denial value, not just the points value.
6. TRADE ACCEPTANCE PROBABILITY (Nick: "idc about veto — just will they ACCEPT"). The only question: P(they hit accept). Per-manager models: what each human overvalues, their roster desperation, their trade history. Calibrated probabilities. Start honest ("experimental — 30 real outcomes") and let the logging make it strong.
7. TRADE TIMING (Nick: insane insane). WHEN matters as much as what. Buy-low windows after bad games, Tuesday post-waiver need shifts, deadline urgency curves. The engine proposes the trade AND the hour.
8. THREE-TEAM TRADES (Nick: insane insane). The biggest edges live here. Build the 3-team trade finder: who needs what, who has surplus where, construct the triangle.
9. PLAYOFF PROBABILITY ENGINE (Nick: insane). Rest-of-season sims output playoff odds and expected finish, not just points. "You're 62% for playoffs; this move takes you to 78%." Playoff-week schedules (weeks 15–17) priced into every trade and add.
10. WEEKLY OPERATING RHYTHM (Nick: insane). The app runs on the NFL week: Tuesday waivers, Wednesday trade targets, Thursday TNF decisions, Sunday-morning inactives scramble, Monday night review. Design the ops calendar — the product has a heartbeat, not random agent schedules.
11. PUSH NOTIFICATIONS / GAME-DAY MODE (Nick: insane). "Your RB is OUT — here's your pivot, tap to apply." Sunday-morning inactives are the highest-leverage 90 minutes in fantasy. Own them.
