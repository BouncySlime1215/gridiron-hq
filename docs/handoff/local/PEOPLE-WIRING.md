# PEOPLE WIRING: how the chat psychology feeds the north star (league 4) (Nick 9/23 ~10:15 PM: "do you know the wiring with this for the north star plan, do you need to remap it out?")

## Today (origin/main + open PRs), measured by grep
Five separate readers of the chat profiles, each reading them its own way:
| reader | reads | feeds |
|---|---|---|
| server/services/counterparty-pricing.js | negotiation_profiles, manager_chat_profile | price + P(accept) (receptiveness) |
| server/services/manager-signals.js | profiles + chat rates | manager signals (activity, tells) |
| server/services/coach/people/variables.js + grading.js | profiles, notes | Coach's people reads + gate |
| scripts/campaign/chat-labels.mjs + server/services/campaign/partners.js (PR #233) | chat labels | War Room partner choice |
| server/services/bluff-detector.js | chat, live | credibility (computed at call time) |
Nothing reads the NEW profile fields being built tonight (deal_feelings, values_talk, behaviour_vs_words, changes_since_0918), and the profiles had not been rebuilt since 9/18.

## Target: one reader, every north-star piece reads it
`server/services/people/profile-reader.js` (PEOPLE-01) = the ONE producer of a typed per-manager profile for league 4 (engine field `people.profile` once the spine lands): all keys + new fields + as_of + messages_read + source (claude-code-local / api) + version. Every consumer below switches to it; no consumer parses profile_json itself.
| profile field | north-star piece | how it's used |
|---|---|---|
| what_moves_him, deal_feelings.urgency, activity | C1 who says yes | P(accept) features (tested; earns weight via EVAL E1) |
| values_talk (talks up / down / untouchable / wants), praise_means | C2 clone price + C3 flip radar | per-player price adjustment hints; buy from the hater, sell to the lover; never offer for untouchables |
| roster_read, values_talk.wants | C4 planner / targets | which position/players he'll trade for; target suggestions |
| how_to_approach, best_bait, techniques | C7 playbook | message framing + opening offer |
| says_no, what_shuts_him_down, deal_feelings.face | C7 reply table | pre-planned answers to decline/counter/silence; avoid public-loss framing |
| behaviour_vs_words, calibration | C8 reasoning + bluff | "his side of the table" + credibility of his claims |
| ME profile | SELF-01 clone of Nick | bias flags, what Nick overpays for |
| changes_since_0918 | campaign replanning | a profile change is an event that can change the next move |
Rules: labels/counts only leave the chat DB; profiles versioned (as_of) so backtests use the version that existed then; typed absence (unknown, not neutral) for people with thin chat.

## Units
- PEOPLE-01 (after tonight's rebuild lands): profile-reader + switch counterparty-pricing, manager-signals, coach/people, campaign partners to it; contract test that every consumer reads through it (grep ratchet).
- PEOPLE-02: nightly local refresh of profiles (Claude Code agents now; API path later per Nick), versioned rows.
- PEOPLE-03: R&D C1/C2 test of the new fields vs league-4 decisions (leak-free version uses the as_of history).

## CAMPAIGN-PEOPLE: how the War Room brain itself uses the profiles (Nick 9/23 ~10:20 PM: "how this new module will use these profiles is HUGE")
The campaign producer (#233) gets a COUNTERPART MODEL per league-4 manager, built from PEOPLE-01 (profile) + CLONE-01a (activity, shrunk accept, motive) + LIVING-01a (engaged/drifting/out) + live bluff credibility. It is used at EVERY step of a campaign, not only partner choice:
1. **Targets:** suggest players whose owners' profiles say they'd sell (frustrated with him, wants a position you have, urgent) and skip untouchables.
2. **Partner order:** P(responds) x edge, where P(responds) includes engagement + posture (ghoster, haggler) and deal_feelings.urgency.
3. **Price:** open at his predicted yes-point, shifted by his values_talk (he overvalues players he hypes: ask for more of them / give him the ones he [redacted]), capped by the fatigue budget.
4. **Package design:** include the players he wants, avoid ones he dislikes; never ask for an untouchable (face cost).
5. **Message:** framing from how_to_approach / best_bait / techniques; never a framing that makes him look like he lost publicly (face).
6. **Reply tree:** predicted counter and his "no" style from says_no / what_shuts_him_down / posture; pre-planned answers per branch.
7. **Timing:** send when his urgency spikes (injury, losing streak talk, 'need a move'); wait when he's attached or just won a trade.
8. **Simulation:** the planner's opponent model uses the counterpart model to simulate his accept/counter/decline in the MCTS/beam search, so paths route through the people most likely to deal.
9. **Replanning:** a profile change (changes_since, new chat) is an event that re-runs the plan.
10. **Reasoning panel:** "his side of the table" cites the profile traits (labels, no quotes).
Honesty rule: every people-based adjustment is a FEATURE with a weight, shown in the reason chain, and graded (EVAL E1/E2/C7); traits that don't earn weight fade. Tonight: PEOPLE-01 then CAMPAIGN-PEOPLE (cloud) once the rebuilt profiles land.
