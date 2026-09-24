# NORTH STAR PLAN: what Nick wants -> what gets built -> when (9/23 ~9:00 PM ET)
Source: Nick's pasted block (9/23 ~8:55 PM): "everything from here down was 100% perfect; ready by the time I wake up, statistically tested and ready with UI; requires a UI overhaul." Every row below is one thing he asked for. Status: MORNING = live in the local app (preview) by 9/24 morning; TESTED = backed by a historical number by morning; LATER = needs the always-on engine or 2026 weeks.

| # | What Nick wants (his words) | What gets built | Morning? |
|---|---|---|---|
| 1 | "The flip radar" | Flip map per league: each league-mate's price vs real title value; biggest buy-from-A / sell-to-B gaps, both fair on each side's screen | MORNING (prototype on real leagues) |
| 2 | "Go get player X" planner | Best path per target: trade / claim / flip steps, P(yes) per step, title-odds effect, backup if someone says no; thousands of paths on the fast simulator | MORNING (prototype) |
| 3 | "Your Title Plan" | War Room: destination, title odds now vs planned, next move, week-by-week path | MORNING (War Room, preview) |
| 4 | "Beat my boys, not ESPN" | ESPN's projection used as the weather; our edge = league-mates (clones, psychology) | DONE (ruling + META-01) |
| 5 | "Set the objective in the UI" / "the model gives me a player we're bullish on, I approve or choose my own" | Objective picker + "Suggest targets" (ranked by title-odds gain x reachability, one-line why), approve or choose | MORNING |
| 6 | "Exact things to say, how to respond, next moves" | Per step: copyable message (true facts, framed on his needs), walk-away price, reply table (accept / decline / counter / silence -> what to do) | MORNING (prototype-level; Coach-written text next) |
| 7 | "Always running on sims, game theory, always inching closer" | Plans recomputed on every data refresh now; event-by-event replanning with push alerts | MORNING: replans every data refresh (15 min) AND on every offer reply / league trade / injury picked up by that refresh, with a push when the next move changes (true second-by-second daemon = EA-02 upgrade later, same outputs) |
| 8 | "Risk modes and tolerance, up to fuck it let's go" | Safe / Balanced / Fuck it (max chance to win it all); sliders: assets to spend, offers per manager, risk per move | MORNING (modes change the plan's scoring) |
| 9 | "140 projected points every week" | Objective type "hit X projected pts/week" with a feasibility check: how likely, by when, at what cost; bye/injury warnings | MORNING: objective added for ALL 5 leagues (Nick: 'add objective'), feasibility: how likely, by when, at what cost; bye/injury warnings |
| 10 | "Goal changes, add stops, Coach as the middle man, don't lose sight" | Itinerary (destination + stops + rules); Coach shows the trade-off before adding a stop; weekly check-in | MORNING: itinerary + trade-off in the War Room AND a Coach tool that turns plain words into itinerary edits with the engine's trade-off preview (COACH-NAV unit tonight) |
| 11 | "Can we speed up / make up ground" | Speed curve: arrive by week N at cost X; speed levers priced | MORNING |
| 12 | "How do we catch back up" | Catch-up list in order: free moves -> flips -> desperate / checked-out managers -> bigger swings when behind -> timing | MORNING |
| 13 | "How do we know it works / this is a prayer" | Report card: E1 "yes" odds on real trades, E3 title odds on real Sleeper seasons (numbers by morning); E2, E4-E7 graded as 2026 weeks come in; failing check -> falls back to Balanced | MORNING: E1 + E3 tested on history with numbers; E2 + E4-E7 graders BUILT tonight and running, showing 'not enough data yet, needs N weeks' until 2026 results arrive (can't be faked) |
| 14 | "GPS: weather from ESPN/Vegas, route is ours" | ESPN + Vegas feed the simulator; honest range; the route graded on history and live | DONE (design) + MORNING (range shown) |
| 15 | "See when numbers break, in the app" | Number health card + red dot; broken-numbers list | MORNING: BROKEN-01a+b tonight (audit job + Number health card + red dot) |
| 16 | "UI overhaul" | War Room inside Trade Brain, designed for one decision per screen, phone + desktop, mockup first | MORNING (mockup + first build behind preview) |

## Build order tonight
A (running): engine foundation fix (EA-00); prototype flip map + planner on real leagues; E1 + E3 historical tests; War Room design + mockup; merge fixes.
B (as soon as A's prototype + design land): campaign producer (plans per league: 1, 2, 5, 6, 8, 9, 11, 12, 17, 18, 19, 20, 22) + War Room UI (3, 5, 6, 8, 10, 11, 12, 13, 19, 21) behind the preview switch.
C (before morning): merge, update the local app, click through every league, screenshots + MORNING-BRIEF.md.
## After tonight (critical path)
Engine daemon (always-on replanning, 7) -> manager clones validated (better P(yes)) -> Coach navigator chat (10) -> Number health in-app (15) -> live report card (13).

## Coordinator's own additions (Nick 9/23 ~9:05 PM: "why do you always just do what I asked, your ideas were insane too")
| # | Idea | Build | Morning? |
|---|---|---|---|
| 17 | Confirm on fresh dice | re-price the chosen plan/deal on an independent seed set before showing it (winner's-curse fix, ~2 pp, IDEA-002) | MORNING |
| 18 | Wait-or-act flag | a step on a player with pending injury designation / role news gets "wait N days" with the option value (IDEA-151, simple version) | MORNING |
| 19 | Attention budget | rank the 5 leagues by decision leverage this week (IDEA-007) at the top of the War Room | MORNING |
| 20 | Price at his "yes" point | offer priced from the P(accept) curve at the clone's indifference point, not a round number (Myerson-lite, IDEA-150) | MORNING (basic) |
| 21 | One-tap decline reason | value / need / likes his guy / not now, logged per offer (IDEA-006) | MORNING |
| 22 | Don't wear them out | offer-fatigue cap per manager per week (IDEA-010 guard) | MORNING |
| 23 | Living league in the sim | LIVING-01a/b: league-mates add, trade, check out inside the season sim | LATER (after EA-01) |
| 24 | Early warning before checkout | activity variance rises before quitting (IDEA-146) | LATER (R&D) |
| 25 | Pitch testing | Thompson-sampling bandit over message framings per manager (IDEA-037) | LATER (needs offer log) |
| 26 | Clone of Nick | SELF-01 bias flags + follow/ignore | LATER |
| 27 | League self-play | IDEA-188 moonshot | LATER |
Rows 17-22 are in tonight's Phase B scope.

## Nick 9/23 ~9:25 PM: "everything in this, add, don't skip"
Every pasted item is now in tonight's scope. The only things that cannot be finished tonight are the ones that need real 2026 weeks to have happened (live grading E2, E4-E7): their graders are built and running tonight and fill in as weeks complete.
Tonight's unit list (launch order, <=3 build loops at once):
1. EA-00 spine v2 (running) | 2. ACQ-FLIP-proto (running) | 3. WR-1 War Room read path + decision card (running)
4. CAMPAIGN producer: flip map, targets, best path + backup, playbook (message, walk-away, reply table), risk modes, sliders, objectives (title / playoffs / get X / X projected pts for all 5 leagues), itinerary + stop trade-off, speed curve, catch-up list, my rows 17-20 + 22; replans every refresh + on offer/trade/injury events, push on change
5. WR-2 ONE-DASHBOARD grid (no page scroll; panels expand in place; phone = one-screen deck) + route/stops/targets/speed/flip map/dark
6. WR-3 War Room buttons (set goal, approve target, I sent it, log reply + one-tap decline reason, risk mode, add a stop) via a small request table the producer reads (no computing in the web server)
7. WR-COACH (folds COACH-NAV): Coach drives the dashboard via typed UI actions (focus, filter, pin, plug_in cards from engine fields, arrange/undo, set objective/stops/risk with trade-off preview + confirm, draft message); every reply shows destination + stops + next move
8. BROKEN-01a+b: audit job + Number health card + red dot
9. EVAL graders E1-E7 + 'Is the brain working?' card (fallback to Balanced on a failing check)
Then Phase C: merge, local app, browser check of every league, screenshots, MORNING-BRIEF.md.

## Nick 9/23 ~9:40 PM: one dashboard (no scroll) + Coach can change the UI on the spot / plug things in -> WAR-ROOM-UI.md v2; WR-2 and WR-COACH updated.

## Nick 9/23 ~9:50 PM: swipe deck on offers ('Next' wipes to the next-best, optional skip reason teaches the brain) -> WAR-ROOM-UI.md section 4; campaign producer outputs top-5 alternatives + reads the skip log; in tonight's WR-2/WR-COACH scope.

## Nick 9/23 ~9:55 PM: 'insane ML, insane UI, most of all insane AI reasoning at every step' -> REASON-01 (ENGINE-SPECS): every card gets case-for / his side of the table / devil's advocate / news check / confidence explained / counter + answer; grounded + graded. Tonight unit 10 (after the campaign producer).

## Nick 9/23 ~8:40 PM: chat psychology drives who we work with. FIXED tonight: the chat classifier (Jev) had failed 17 runs since 9/22 9:05 PM because refresh.sh blanked AI_GATEWAY_API_KEY; refresh.sh now loads .env.local for Jev (Nick: no Jev cap), loop restarted (pid 46996), first tick: 2 classified, 0 failed. Campaign producer (unit 4) reads manager_chat_profile, negotiation_profiles, manager_player_sentiment, jev_chat_signals rollups for partner choice + flip targeting (ruling in WORK-QUEUE). Check: classify backlog (~380 messages extracted while failing) drains on following ticks.
