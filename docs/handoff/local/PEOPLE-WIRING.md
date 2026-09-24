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

## The 10 counterpart modules, each with its own stat (Nick 9/23 ~10:25 PM: "these 10 modules need to be insane; we have so much data from the texts that the model has no excuse not to win")
Key insight: the texts are rich in WORDS but league 4 has only ~40 decided offers (thin OUTCOMES). So each module is graded on the chat's OWN follow-through, which gives thousands of labelled events: a statement in chat (wants X, untouchable Y, frustrated with Z, 'need a move', 'no chance') followed later by an observable action (trade, add/drop, offer, reply). Words -> later actions is the ground truth we have plenty of.
| # | module | stat that proves it works (graded on league 4 + chat follow-through, as-of) |
|---|---|---|
| M1 targets | sellers-to-be | of players the module flags 'owner would sell', share actually moved ([mgr]/dropped) within 3 weeks vs base rate |
| M2 partner order | who engages | reply rate / response time of top-ranked partners vs others |
| M3 price | yes-point | accept rate at the module's price vs predicted; overpay avoided (title-odds given up) |
| M4 package | what he wants | share of his next acquisitions matching his stated wants / hyped players vs base rate |
| M5 message | framing | accept rate by framing arm (bandit, IDEA-037), face-safe vs not |
| M6 reply tree | counters | predicted counter/no-style vs actual reply (exact / close / miss) |
| M7 timing | urgency windows | after an urgency spike in chat, P(trade within 7 days) vs baseline |
| M8 simulation | opponent model | log loss of simulated responses vs real responses (E1) |
| M9 replanning | profile change -> plan change | share of profile changes that preceded a real behaviour change |
| M10 reasoning | his side of the table | share of reasoning claims that came true |
Build order: (1) PEOPLE-LAB (local R&D now): extract statement->action pairs from ALL chat history (as-of), compute M1/M4/M6/M7/M9 baselines and the lift of the rebuilt profiles; (2) COUNTERPART-01 (cloud): the counterpart model + M3/M4/M6/M7 hooks in the campaign producer behind flags; (3) M5 bandit once offers log; (4) all grades feed EVAL + the War Room 'Is the brain working?' card.

## Nick's ground truth (9/23 ~10:45 PM) -> manager_notes + profile nick_override (overrides chat-derived reads everywhere)
- Partner pool for league-4 campaigns: ACTIVE = Lars, [mgr], Rami, Raj (Rami + Raj hard to deal with: tough negotiators -> lower P(accept), stricter pricing, patient reply trees). EXCLUDE [mgr] (abroad, unreachable). DEPRIORITIZE Zach (not doing trades). AV: NYG fan; Dart out for season. Josh: 'need a QB' texts are youth football.
- Rule: nick_override beats any model/chat read; the campaign producer and clones must read it (PEOPLE-01 reader).

## PEOPLE-LAB result (verified by coordinator 9/23 ~10:30 PM) -> what each module uses
- M4/C4/C2/M2: wants_player[mgr][player] = STRONG (17x acquire in 7d, CI 9.7-25.5). Use: he is in-market for X, so sell X-type assets to him at a premium, don't bid against him for X, and put him first in partner order that week. Decays over 7->21 days.
- Per-manager credibility: one roster's 'for sale' talk is credible and another's is cheap talk (shop->moved 0.0x). Weight each manager's SHOP/UNTOUCHABLE by his own follow-through; unknown for quiet rosters (2, 4, 11, 12).
- Dead as signals (no weight): frustrated, untouchable, want-position, chat 'no' style. M6 reply prior: ignore 45 / counter 33 / decline 17 / accept 5.
- Data gaps: 84% of statements come from 3 rosters; the ESPN feed missed some executed trades (17 players excluded); 46 league-4 proposals were never captured (pre-collector, unrecoverable); screenshots add 7 trades not in the feed.
- PEOPLE-03 (verified 9/23 10:55 PM: prereg 4e1e088f predates the result, rule followed): chat-profile features do NOT improve P(accept) on 40 league-4 offers (log loss 0.146 worse, CS [-0.408, +0.022]): INCONCLUSIVE, leaning harmful; credibility hurts, wants7 is the only lead. RULE for COUNTERPART-01/TELLS-01b: people features get ~0 weight in P(accept) until E1 grades them positive (about 87 offers); use wants_player for TARGETS/package/partner timing (M4, proven 17x), not for the yes-probability.
