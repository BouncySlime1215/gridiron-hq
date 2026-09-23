# SPEND ESTIMATE: getting both accounts to the end (2026-09-23 ~2:20 AM ET). Method and numbers; estimates are labelled.
## Measured (plan-usage-history.json, this account's samples only; 221 samples 9/14-9/23)
- This account's weekly counter last reset Tue 9/22 ~2:16 PM ET (92% -> 2%). Earlier resets in the series are irregular (9/15 6 PM, 9/19 4 PM, 9/21 9 PM), so the next reset time is NOT known; working assumption: Tue 9/29 ~2 PM ET. Nick should confirm in Settings > Usage.
- Burn since that reset: 2% -> 57% between 2:16 PM and 1:46 AM = 55% in 11.5 h = ~4.8% of the weekly cap per hour (heaviest night: up to 9 workflows at once).
- The 5-hour window burns ~30%/h at 4-5 workflows (bin/burn.py, 2:05 AM).
## Work bought with that 55% (9/22 2 PM -> 9/23 2 AM)
About 20 unit-equivalents: merges #150-#160 and #97 (11 units, several with full skeptic rounds), BLEND-01 / HX-01 / S-03 builds + skeptics, verify runs for 6 PRs, the skill study (dataset + 4 analyses + 8 skeptic passes + report), the UI audit, re-audit/structure/synergy passes. => ~2.75% weekly per unit-equivalent (ESTIMATE; the night included one overload and several restarts).
With the optimizations now in force (risk-tier lenses, lean reading, Sonnet for lean/UI/gates, Fable critical-only, no restarts), expected cost per unit (ESTIMATE): lean/UI/docs ~0.8%, standard build ~1.8%, study/model/critical ~3%. Blended ~1.8%.
## What's left (units on the board / queue, 2:20 AM ET)
- Critical path to "Trade Machine v1 + Diligence Engine done": phase 0 remainder (~3), phase 1a (10), phase 1b diligence (7), phase 2 engine (6), phase 3 trade machine v1 (15), UI revamp core (UX-03 + My team + Trade Brain + Trade Lab + Start/Sit ~8) = ~49 units x ~1.9% = ~93% of one account's week (range 70-130%).
- Everything else (original A-D backlog ~90, AI tier 12, insane tier ~30, NX 10, ST 11, UX rest ~6, INT follow-ups ~15) = ~175 units x ~1.7% = ~300% (range 220-400%) = 2-4 more account-weeks.
## Capacity
- This week: account A ~43% left (until its reset, assumed Tue 9/29 2 PM) + account B 100% from Wed 9/23 3 PM (its own weekly reset ~7 days later) = ~143%.
- Keep ~10% per account for Nick's own chat and handoffs -> ~123% usable.
## Verdict
- Critical path (~93%) FITS this week with ~30% to spare, IF the burn stays lean. The full plan does NOT fit: it needs ~2-3 more weeks of both accounts (or about 3-4 weeks of one).
- Pace needed to run 24/7 until A's reset: 123% / ~156 h = ~0.8% per hour, i.e. about ONE-SIXTH of tonight's burn. Practical shape: bursts of 2-3 workflows during each 5-hour window, then idle, rather than 5 workflows nonstop.
## Allocation
- Account A (now -> ~87%, about 30% more): finish phase 0, phase 1a foundations, start phase 1b diligence (lean). Throttle to ≤3 workflows now; board keeper replaced by the 20-min status cron (the keeper cost ~90K tokens per tick); R&D at one round per day.
- Account B (from 3 PM, after Nick pastes the handoff): phase 1b finish, phase 2 engine, phase 3 trade machine v1, UI core. Stop at 90% weekly.
- Next week (both accounts reset): AI tier, insane tier, original backlog, in priority order.
## How the estimate is kept honest
Every other 20-min check: bin/burn.py (5-hour) + weekly delta per unit merged since the last check -> update the per-unit cost here and the projected finish date of the critical path. If the measured cost per unit exceeds 2.5% for a day, cut lenses/effort where the rules allow or re-order to the most valuable units first; correctness rules never get cut.
