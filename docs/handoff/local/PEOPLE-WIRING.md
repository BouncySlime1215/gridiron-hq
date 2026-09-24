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
