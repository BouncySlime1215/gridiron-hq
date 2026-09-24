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
| 7 | "Always running on sims, game theory, always inching closer" | Plans recomputed on every data refresh now; event-by-event replanning with push alerts | PARTIAL: refresh-based by morning; always-on replanning LATER (engine daemon EA-02) |
| 8 | "Risk modes and tolerance, up to fuck it let's go" | Safe / Balanced / Fuck it (max chance to win it all); sliders: assets to spend, offers per manager, risk per move | MORNING (modes change the plan's scoring) |
| 9 | "140 projected points every week" | Objective type "hit X projected pts/week" with a feasibility check: how likely, by when, at what cost; bye/injury warnings | MORNING (feasibility report) |
| 10 | "Goal changes, add stops, Coach as the middle man, don't lose sight" | Itinerary (destination + stops + rules); Coach shows the trade-off before adding a stop; weekly check-in | PARTIAL: itinerary + trade-off in the War Room by morning; Coach chat edits LATER (COACH-01) |
| 11 | "Can we speed up / make up ground" | Speed curve: arrive by week N at cost X; speed levers priced | MORNING |
| 12 | "How do we catch back up" | Catch-up list in order: free moves -> flips -> desperate / checked-out managers -> bigger swings when behind -> timing | MORNING |
| 13 | "How do we know it works / this is a prayer" | Report card: E1 "yes" odds on real trades, E3 title odds on real Sleeper seasons (numbers by morning); E2, E4-E7 graded as 2026 weeks come in; failing check -> falls back to Balanced | TESTED: E1 + E3 by morning; rest LATER |
| 14 | "GPS: weather from ESPN/Vegas, route is ours" | ESPN + Vegas feed the simulator; honest range; the route graded on history and live | DONE (design) + MORNING (range shown) |
| 15 | "See when numbers break, in the app" | Number health card + red dot; broken-numbers list | LATER this week (BROKEN-01), list kept now |
| 16 | "UI overhaul" | War Room inside Trade Brain, designed for one decision per screen, phone + desktop, mockup first | MORNING (mockup + first build behind preview) |

## Build order tonight
A (running): engine foundation fix (EA-00); prototype flip map + planner on real leagues; E1 + E3 historical tests; War Room design + mockup; merge fixes.
B (as soon as A's prototype + design land): campaign producer (plans per league: 1, 2, 5, 6, 8, 9, 11, 12) + War Room UI (3, 5, 6, 8, 10, 11, 12, 13) behind the preview switch.
C (before morning): merge, update the local app, click through every league, screenshots + MORNING-BRIEF.md.
## After tonight (critical path)
Engine daemon (always-on replanning, 7) -> manager clones validated (better P(yes)) -> Coach navigator chat (10) -> Number health in-app (15) -> live report card (13).
