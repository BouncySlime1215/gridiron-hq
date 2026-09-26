# TITLE-PATH EXPLAINER (plan item 41)

RED `f67a0d67` · GREEN follows · `test/campaign-title-path.test.js`.

Unit source: Nick's reserve queue, item 41: "for the next move, a 3-line plain-English
'why this wins you the title' (the lineup slot it fixes, the weeks it matters, the odds
before -> after), derived from plan numbers only."

## Scope

`server/services/campaign/title-path.js`, called once per league by the planner after the
served move is chosen:

1. **Slot line.** The net get (got and not given on later in the path) with the biggest
   points-a-game gain over the starter he replaces: a same-position starter the move gives
   away, else the weakest same-position starter he outscores, else (RB/WR/TE) the weakest
   flex-eligible starter at FLEX. Rates are the planner's own `players.ros_ppg`. No
   replacement: "adds depth", never a made-up slot.
2. **Weeks line.** Nick's lineup points a week on the world's own weekly draws
   (`W.weekly`, the dice every plan is scored on), after minus now, from the week the move
   lands (`arrivalWeek`, as `eta_week`). Weeks are named only when they stand out
   (best minus worst >= 1 pt). Playoff weeks are named only when the league carries them
   (`league.playoff_weeks`; none today, see the PR).
3. **Odds line.** `title_now`, `title_now + delta_final` (every step lands),
   `title_now + expected` (counting a no), the plan's SE, and P(complete) labelled a guess.

It explains only the planner's served move (already rule-filtered). As a second check it
refuses, with no text, any move that gives or gets a blocked id: objective and adapter
untouchables plus never-give.js's pinned 160 / 80 / 277 (on Nick's roster) and 290.

## Flag

`GRIDIRON_TITLE_PATH`: `1` computes it as SHADOW into `_run.inputs.title_path` (no screen
reads `_run`); unset or anything else is off and computes nothing. Preview mode never turns
it on. It moves no number.

## Pre-registration (written before any code)

| id | metric | pass bar | what fails it |
|----|--------|----------|---------------|
| E1 | grounding, 10 fixture seeds | every figure in the text is in `numbers`, and the odds figures equal `title_now`, `title_now + delta_final`, `title_now + expected`, `p_complete` of the served plan (as printed); >= 8 of 10 seeds explained | any figure not traceable to a plan number |
| E2 | Nick's rules | a move giving 160 / 80 / 277 or getting 290, or naming an untouchable, is refused with no text; through the planner the explained move never names an untouchable | any text for a blocked move |
| E3 | plain text | <= 3 lines, each <= 180 chars, no snake_case, file names, source tags or bare ids | any line failing |
| E4 | shadow | flag off: nothing computed; on vs off entries differ only at `_run.inputs.title_path`; `validateLeague` passes | any served field changing |
| E5 | speed | < 50 ms per league for the explainer on the fixture | slower |
| L1 | league 4 (local, Nick reads) | 5 consecutive nightly runs with the flag on: Nick marks each explainer right or wrong; >= 4 of 5 right, 0 that name a rule-blocked player or a wrong slot | fewer than 4 right |

Serving the lines on a screen (Today / Trades next-move card) is a later step, after L1
passes, and is the coordinator's to wire (Trades client files are out of scope here).
