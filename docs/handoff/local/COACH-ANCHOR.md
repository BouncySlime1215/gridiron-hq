# COACH ANCHORS EVERYTHING (Nick 9/23 ~11:55 PM: "what about Coach anchoring EVERYTHING")
Coach is the single front door to the whole brain for league 4. You never need another page: every plan, person, number, grade and change goes through Coach, and Coach can see and explain all of it. Coach does NOT compute numbers itself: it reads engine fields (with source + as_of) and calls the engine's simulators. Every number it says is checked against a field before it reaches you.

## Today vs target
- Today (main): football Q&A tools only (sql_select, catalog_lookup, who_plays, team_tendencies, coaching_profile, football_context, source_trust, compute) + verify.js grounding + people variables. #230 adds screen actions. It can't see the plan, the people brain or the report card.
- Target: Coach = navigator + negotiator + analyst + screen driver + memory, over ONE engine.

## The 6 jobs
1. NAVIGATOR (row 10): holds the destination, stops and rules. You talk ("I want a WR1 by week 8 but don't touch Bijan"). Coach turns it into itinerary edits, shows the trade-off (title odds, cost, ETA) BEFORE applying, and applies on confirm (warroom_requests). Every reply ends with: destination · where we are · next move.
2. NEGOTIATOR: for each step, the message (COACH-MSG, grounded), reply table and walk-away. In negotiation mode it's a live copilot: paste or tap his reply -> Coach classifies it (counter / no / stall), shows the pre-planned answer, re-prices a counter in real time with the rescorer, and says "take it / counter with X / walk".
3. PEOPLE READER: answers "how do I approach [manager]?" from the counterpart model (traits, credibility, in-market flags, mood, fatigue). Role-plays his likely reply from the model, clearly labelled as a simulation. Warns about how Nick comes across ("that's the third offer to him this week").
4. ANALYST / EXPLAINER: "why this move?" -> walks the reason chain (title-odds change, P(yes) band, his side of the table, devil's advocate, confidence and what the brain report says about trusting it). "Is the brain working?" -> reads E1-E7 + M-module grades plainly. "Is that number broken?" -> Number health.
5. SCREEN DRIVER (WR-COACH #230 + FIX-06): focus, filter, pin, plug any engine field in as a card, arrange/undo, switch risk mode (with trade-off), open his screen, start negotiation mode.
6. MEMORY + BRIEFS: morning brief (what changed overnight: new credible statements, replies, injuries, the next move and why), push on next-move change (PUSH-01), weekly check-in against the itinerary, and Nick's own patterns (SELF-01: what he overpays for, which recs he ignores).

## Tools Coach gets (typed, read-only unless marked)
| tool | reads / does | producer |
|---|---|---|
| plan_read | plans contract for league 4: destination, next_move, alternatives, itinerary, stop_tradeoffs, flip_map, targets, catch_up, speed_curve, feasibility | CAMPAIGN (FIX-03) |
| people_read | counterpart model per manager: traits, credibility, wants, mood, P(responds), reply mix, fatigue, nick_override | PEOPLE-01 / COUNTERPART |
| pulse_read | recent labelled statements (labels, no quotes) | PULSE-01 |
| brain_read | brain_report E1-E7 + M-stats + fallback state | EVAL / FIX-05 |
| health_read | number audit rows | BROKEN-01 |
| what_if | rescore a deal / package edit / stop change: title-odds change, P(yes) band, his yes-point | rescorer + opponent model |
| roleplay | sample his reply to a message from the counterpart model | COUNTERPART-02 |
| itinerary_edit (write, confirm) | set objective / add or remove a stop / risk mode -> warroom_requests | FIX-07 |
| ui_action (write) | typed screen actions | #230 / FIX-06 |
| log_offer (write, confirm) | "I sent it" / reply logged -> trade_outcomes, campaign_steps | OFFER loop / STEP-LOG |

## Guardrails
- Grounding: every number, player and probability in a Coach reply must match a tool result (verify.js extended to the new tools); on a mismatch the reply is regenerated or the claim dropped.
- Never sends an offer or a text: it drafts, and Nick sends.
- Labels only from chat, never quotes. nick_override beats everything.
- Says "the brain isn't proven here yet" whenever the relevant check is not passing.
- Cost: the $0.50/day local cap is kept; the morning brief is cached, and tool results are cached per plan version.

## Build units (build queue, after FIX-06)
COACH-TOOLS (plan/people/pulse/brain/health read tools + grounding), COACH-NAV (itinerary edits with trade-off preview), COACH-NEGOTIATE (live reply copilot + real-time re-pricing), COACH-ROLEPLAY (counterpart reply simulation), COACH-BRIEF (morning brief + weekly check-in + push text). Graded: share of Coach claims that verify (target 100%), and M10 (share of reasoning claims that came true).
