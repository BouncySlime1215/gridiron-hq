# Betting model plan

**Context for this doc:** you asked me to use a few pasted articles (a Medium post on a basic NBA gradient-boosting model, PropsBot.AI's "how betting models work" glossary page, and Unabated's intro-to-data-science series) to "build our model and revamp it." Before writing a plan I checked what those articles actually describe against what's already in this codebase — worth stating plainly, because it changes what the plan should be.

## What the articles describe vs. what's already here

All three describe the same standard pipeline: rate → simulate → convert to fair odds → compare to the market → bet the gap, minus the vig. That pipeline is already built here, and built to a higher standard than any of the three articles describe:

| Article's advice | This codebase |
|---|---|
| "Simulate the game thousands of times" | `nfl-ensemble.js` runs a 21-model ensemble; Monte Carlo simulation is already the mechanism |
| "Strip the vig, compare to fair odds" | `noVigProbability()` — already done, everywhere |
| "Test on win rate before deploying" | Goes further: walk-forward validation, Holm-corrected across every candidate, then **ablation-tested against the actual shipped pipeline** — a discipline none of the three articles mention |
| "A realistic edge is a few points of ROI, not 60%" (PropsBot) | Matches this project's own finding exactly — see below |
| Nothing on execution/line-shopping as a distinct edge source | This project already found and measured that this **is** the real edge (see below) |

So this isn't a "the model needs the basics" situation. The gap the articles would close doesn't exist. The real, already-documented finding is more specific and more useful than anything in the pasted material:

> **"Betting: the edge is in execution, not prediction."** (`docs/WORK_LOG.md`, §12, written before I read your pasted articles — same conclusion PropsBot's own glossary states as the honest ceiling: "a realistic long-run edge is a few percentage points of ROI.")

Specifically, already measured on real data in this repo:
- **Prediction edge on spreads: settled negative.** 21 component models against 15,096 closing lines, 0 clear the materiality gate. This was tested three independent ways and is not an open question — see `docs/WORK_LOG.md`'s "Do not redo these" list.
- **Execution edge: real and measured, never fully exploited.** Books disagree by 0.813 points on average per market; taking the best price instead of a median one is worth 2.566% per bet on its own.
- **The real break-even is 51.38%, not 52.38%** — the standard "-110 both sides" assumption only held for 13.2% of 11,134 real historical games checked here.
- **Wong teasers: the one defensible +EV bet found.** 1,391 qualifying legs, 74.69% win rate, +6.50% EV at -110 (z=1.99). This is a structural payout exploit, not a prediction — it doesn't need the model to be right about anything.
- Nine other signal families were built and rejected after passing initial validation but failing ablation against the real pipeline (age, injury, scheme, opponent strength, teammate competition, recency blends, etc.) — throwing more inputs at the margin model is the one thing already conclusively shown not to work here.

## What this changes about "revamp it"

Revamping the *prediction* side would be re-doing 21 models' worth of already-negative work. The plan below is the project's own next-value-per-effort list (`docs/WORK_LOG.md`, "Where to start next"), re-prioritized against what's actually still open **today**, with current status checked live rather than assumed.

## The plan, in order

### 1. Let the prop CLV loop actually run — it just started
`ODDS_API_KEY` is already set. `nfl_prop_clv` has captured its first **876 quotes**, but only in a 5-minute window earlier today (2026-08-27) — zero are settled yet, zero have a recorded closing line. This is expected: it's Week 1 preseason, no games have closed yet. **Nothing to build here — just let the scheduled `nfl_prop_capture` job keep running.** The doc's own honesty bar is ~200 *settled* bets before median CLV means anything; that clock only starts once real games are played and graded. Check back after Week 1 settles.

### 2. Verify the Wong teaser edge against live, bookable prices
The +6.50% EV number is real but conditional on actually being able to get -110 or -115 on a 2-team 6-point teaser — the doc itself flags that books have moved many of these to -120+ *because* this exact exploit is known. This is a market-availability question, not a modeling one: pull current teaser pricing from whatever books are reachable and check whether the edge still clears at bookable prices. If it doesn't, this line item is closed as "known but not currently accessible," not re-litigated.

### 3. Extend the key-number lens to the spots it hasn't touched yet
`lineMoveValue()` already prices a line move against the real NFL margin distribution (3 covers 15.12% of games, 4.2x the value of a "generic" half point). It's only been pointed at the teaser case. Same lens, unexplored angles:
- Teaser lengths besides 6 points (6.5, 7)
- Home underdogs specifically
- Divisional unders
- Middling opportunities (two books straddling the number 3)

This is mechanical — reusing an already-validated tool on new segments, not new modeling risk.

### 4. Passing yards — the one real remaining accuracy gap
Every broad-brush signal family has been tried and exhausted (see "Do not redo these"). The one stat that's still measurably weak is passing yards specifically (r² 0.075 vs. 0.28–0.34 for rushing/receiving/scoring), and the diagnostic work already separated *why*: attempts (volume) is the larger error source, not yards-per-attempt (efficiency). Next step here is volume-specific — a targeted look at pass-attempt drivers (game script, injury to the RB room, pass-rate over expectation) rather than another general-purpose accuracy head, which is exactly the kind of addition already shown to backfire when it's not targeted.

### 5. LLM extraction from `news_items` — the one signal source a numeric model can't reach on its own
1,036 news rows already have `injury_entities_json` and `fantasy_impact` populated by the typed extraction pipeline built earlier this project (practice-report severity, transaction wire, beat-reporter Twitter signal). None of that has been tested as a candidate signal against the spread model yet. It goes through the exact same gate as every other candidate: walk-forward validate, Holm-correct, then ablate against the shipped pipeline. "An LLM found it" is not evidence it survives that gate — nothing gets a pass just because it's new.

## What I am **not** proposing
- Adding more machine-learning heads to the margin/spread prediction (settled negative, tested three ways).
- Re-adding age, injury, scheme, opponent, or teammate-competition adjustments to player projections (each already passed isolated validation and then degraded the real pipeline).
- Scraping OddsPortal for historical lines (its `robots.txt` disallows every relevant path — already checked, not revisited).

## Bottom line
The pasted articles' actual thesis — the edge lives in beating the vig on execution, not in out-predicting the market — is already this project's own conclusion, reached independently and with more rigor than the articles apply. The plan above is five concretely scoped, already-partially-built next steps ranked by value, not a rebuild.
