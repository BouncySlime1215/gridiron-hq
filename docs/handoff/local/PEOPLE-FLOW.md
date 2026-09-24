# PEOPLE FLOW: how the texts and psychology run through the whole brain (league 4)
Nick 9/23 ~11:50 PM: "the way the messages and psychology flow into this whole thing needs to be insane". Builds on PEOPLE-WIRING.md (readers, M1-M10). Every arrow is a table or field with as_of, so backtests see only what existed then.
Status labels: PROVEN (tested, held out) / BUILT / BUILDING / IDEA (untested, gets a pre-registered test before it gets weight).

## 1. Sources (what we read)
- iMessage: league group chat, DMs with each league-mate, other group chats (league-mates count as themselves; non-league fantasy talk = "street"). Tables messages + messages_ext (5,433 new rows 9/23). BUILT
- Screenshots of trades in chat -> screenshot_trades (18 trades; 7 never in ESPN's feed) -> screenshot proposals (SHOT-01). BUILDING
- ESPN transactions: every proposal, accept, decline, counter, veto with timestamps (OFFER-SNAPSHOT #247 keeps the terms). BUILT
- Nick's own knowledge: manager_notes + nick_override (who's active, hard, unreachable, not a buyer). BUILT, beats everything

## 2. Read every message (per message, as-of)
Jev classifier + labeller -> statement labels: WANT_PLAYER, SHOP, UNTOUCHABLE, HYPE, FRUSTRATED, URGENCY, REFUSAL, ACCEPT_TALK, TRADE_REACTION, WANT_POS, with speaker = roster, player ids, time. 624 fantasy statements so far (84% from 3 rosters). BUILT (PEOPLE-LAB labels); live via PULSE-01 BUILDING

## 3. Credibility: do this person's words turn into actions? (the core idea)
For every statement type x manager: follow-through rate = P(matching action within 7/21 days) / base rate, shrunk to the league. That is the WEIGHT the statement gets everywhere.
- WANT_PLAYER -> acquires that player in 7 days: 17x base (CI 9.7-25.5). PROVEN
- SHOP ("he's available"): credible for one roster, pure noise for another (0.0x). PROVEN per-manager split
- FRUSTRATED / UNTOUCHABLE / WANT_POS / chat "no" style: no predictive power. PROVEN noise -> 0 weight
- Chat features inside P(yes): not helping yet (PEOPLE-03, 40 offers). ~0 weight until E1 grades them positive
CRED-01 recomputes these nightly; a trait that stops following through loses its weight automatically.

## 4. Profile + counterpart model (one per manager, versioned)
Profile (negotiation_profiles, model-read of all chat): how_to_approach, best_bait, techniques, says_no, what_shuts_him_down, face, values_talk (talks up / down / untouchable / wants), deal_feelings, behaviour_vs_words; + PEOPLE-02 counters (activity, wants in the last 21 days, changes) + nick_override.
Counterpart model (COUNTERPART-01 #254 -> COUNTERPART-02): P(responds), P(yes | deal) (clone + tells; chat ~0 for now), reply-style mix (prior ignore 45 / counter 33 / decline 17 / accept 5, updated per manager), yes-point price, in-market flags (wants X now), untouchables (face cost), timing windows, fatigue budget.

## 5. Where it flows (every decision the War Room makes)
| decision | people input | module | status |
|---|---|---|---|
| Suggested targets | who is in-market (wants X), who's selling for real (credible SHOP), out-of-contention sellers | M1/M4 | BUILDING |
| Partner order | P(responds) x edge; the 4 active guys first; unreachable manager never; non-buyer last | M2 + FIX-02 | BUILDING |
| Price + walk-away | yes-point; tougher opening for the 2 hard negotiators; count-neutral best-player belief pending | M3 | BUILDING (belief untested) |
| Package | give him what he asked for (17x signal), never ask for his untouchables | M4 | BUILDING |
| Message | framing from how_to_approach / best_bait, face-safe, grounded facts only; bandit learns which framing works per manager | M5 + COACH-MSG + BANDIT-01 | BUILDING |
| Reply table | his predicted counter / no-style -> pre-written answer per branch | M6 | BUILDING |
| Timing | send when urgency spikes (injury to his starter, losing streak, "need a move"); wait when he just made a deal | M7 | BUILDING |
| Planner simulation | the planner plays out his reply for every path, so routes go through people who deal | M8 COUNTERPART-02 | BUILDING |
| Replanning | a new credible statement or profile change is an event -> replan -> push if the next move changes | M9 PULSE-01 + PUSH-01 | BUILDING |
| Reasoning panel | "his side of the table" cites traits + credibility (labels, not quotes) | M10 REASON | BUILDING |
| Flip radar | buy from the one who talks a player down, sell to the one who hypes him | C3 | BUILT (FLIP-01 PR) |
| Catch-up | desperate / checked-out / out-of-contention managers first when behind | CATCHUP-LIVE | QUEUED |

## 6. The learning loop (why it gets sharper every week)
Every offer Nick sends (War Room "I sent it", or ESPN match) -> reply + time -> trade_outcomes / campaign_steps -> graded: E1 (yes-odds), E2 (price), M-stats per module -> weights update, credibility recomputed -> better next plan. Nick's one-tap skip/decline reasons are labels too. Surprises (a yes we gave 10%) -> HYPO-01 writes a hypothesis -> R&D tests it.

## 7. New ideas (IDEA, each gets a pre-registered follow-through test before it gets weight)
1. Mood clock: tilt after a bad loss or a roast in chat, euphoria after a win -> P(yes) and price move for 48 h.
2. Influence graph: who replies to or roasts whom in the group chat. Avoid offers his "advisor" will talk him out of; seed deals the group will praise.
3. Public-face ledger: trades discussed in the group chat, who got roasted after -> a face-cost score per manager; frame offers so he can't look fleeced.
4. Anchor memory: the last value he said out loud for a player ("I'd need a 1st for him") -> open near his own anchor.
5. Street-talk lead: non-league fantasy talk + beat news spreading into the group chat 1-2 days before prices move -> buy/sell timing.
6. How Nick comes across: per counterpart, Nick's own tone and pushiness -> SELF-01 flags ("you've sent him 3 offers this week").
7. Counterfactual replay: for every past declined offer, would our price/message/timing have flipped it? Offline grade of M3/M5/M7.

## Guardrails
Labels and counts only leave the chat DB; never quotes; no names in the public repo. nick_override beats every model. Quiet managers are "unknown", never "neutral". Nothing is ever sent automatically: the War Room drafts, Nick sends.
