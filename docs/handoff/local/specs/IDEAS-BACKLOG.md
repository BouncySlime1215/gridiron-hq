# IDEAS BACKLOG (Fable, 9/27): buildable ideas, each tied to a MASTER-MAP tier
Not commitments. Each needs a pre-registered bar before it counts.

| # | Idea | Tier | What it does | Data we have? |
|---|---|---|---|---|
| 1 | Inactives sniper | 1, 9, 10 | Within 60 s of Sunday inactives: re-project the affected players, push a lineup fix and a waiver claim | inactives feed needs timestamps |
| 2 | Screen-gap radar | 5, 9 | Daily buy and sell lists: players whose FantasyCalc and FantasyPros value lags xFP-based forward value; the trade edge vs calculator users | FC yes; FP internal; xFP yes |
| 3 | League-mate dossiers | 13, 10 | Per manager: needs, calculator used, reply clock, accept history, what they overrate; feeds P(yes) and offer wording | chat (masked), replies, trades |
| 4 | Counter-ladder engine | 9 | Pre-planned concession steps for each offer, each still passing the rules and the break-evens | planner |
| 5 | Regret meter | 11 | Weekly: what the do-nothing path and the best rejected path would have scored; counterfactual grading made visible | replay lab |
| 6 | Season war-game | 9 | Simulate the rest of the season with likely rival trades and waiver moves; who blocks whom | rosters, transactions |
| 7 | Boom-week finder | 9 | Underdog weeks: pick the tail-upside starters from the boom-probability expert | quantile expert (C) |
| 8 | Bye-week planner | 9 | Two weeks ahead: waiver and lineup plan for bye clusters | schedule |
| 9 | Luck ledger | 11 | All-play record, luck-adjusted standings, schedule luck; separates luck from decisions | league scores |
| 10 | Consensus-drift alarm | 6 | When ESPN or FP move toward our earlier call, log lead-time credit and tell Nick "we were early on X" | history archive |
| 11 | Nick calibration coach | 5, 10 | Grade Nick's own calls by type ("70% on RB, 40% on QB") and show where to trust himself | belief sliders |
| 12 | Model debate digest | 10 | Weekly: the 5 biggest expert disagreements, with reasons and records | ledger |
| 13 | Trade-market heatmap | 13 | Who is buying and selling what across the league, from transactions and chat | league data |
| 14 | "What if I had" replay | 4 | Rerun the season with alternative decisions at any past week | replay lab |
| 15 | D/ST and K streaming model | 5 | Weekly streamers from Vegas totals, sacks and turnovers allowed, weather | lines, PBP |
| 16 | Draft trust gate | 7 | The same ledger and gate applied to draft rankings for next year | history |
| 17 | Offer drafts in Nick's voice | 10 | Coach writes the message, picks the send time from the reply clock; one-tap copy | VOICE-01 exists |
| 18 | Private model scoreboard | 11 | A page that shows weekly wins vs ESPN and FP, by position and situation; the honesty page | PROJ-DUEL |
| 19 | Push on flip triggers | 10 | PWA push when a watched trigger fires (#293 exists, flagged) | PWA on |
| 20 | Portfolio view | 8 | Exposure across the 5 leagues: same-player and same-bye concentration, a risk dial per league | rosters |

## Added 9/27 from "The prompt is 10%, the harness is 90%" (motion-design studio post)
| # | Idea | Tier | What it does | Data we have? |
|---|---|---|---|---|
| 21 | MOTION-RENDER: key moments as our own clips | 10 (TEAMS-V2 unit 5) | Render each player's top plays as short animated diagrams on our own field from play-by-play (down, distance, air yards, YAC, WP swing), via the HTML + Playwright + ffmpeg pipeline with closed-form springs; deterministic seek(t) so every render reproduces; exports 9:16, 1:1, 16:9. Legal: our graphics from data, no NFL video | 2025 pbp CSV on disk; 2026 weekly ingest needed |
| 22 | Weekly recap film | 10 | "Your week in 30 seconds": matchup swing, best and worst starts, trade impact, playoff odds move; shareable to the league chat | league scores, plans.json |
| 23 | Trade story animation | 10 | The chain (step → hole → fill) and lineup before/after as a 10-second motion explainer on the Coach trade page | chain producer |
| 24 | Critique loop for pages | 0, 10 | After every UI build, the model reviews rendered screenshots (375/1440, light/dark) against CLAUDE.md 2b and fixes before the PR; formalises today's UI scan | screenshots |
| 25 | Director's brief template | 0 | One brief format per tier (goal, metric, bar, files, reference frames, what not to touch, when to stop) for 12-hour autonomous runs | RULES.md section 4 |
| 26 | Recurring jobs as skills | 0 | Package PR batch review (verifier + skeptic workflow), the judge run, the chain run and the replay as reusable skills, so any account runs them the same way | scripts exist |
| 27 | Reference-frame rule for UI | 0 | Builders get the Figma frame or a screenshot as the reference, never a description; "named styles beat descriptions" | Figma links exist |
