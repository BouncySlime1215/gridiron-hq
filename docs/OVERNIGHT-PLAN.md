# Overnight plan — 2026-09-18 (week 2)

Nick, 03:50: *"Trades are designed by the people they are being sent to while finding an edge… if someone loves a player then abuse that… sneak a guy in… all the moves and mind games, then how to approach the negotiation based on our data and our intelligence read on this person."* And: a Coach that gives accurate information **and a plan** ("don't shop Achane — do this, send it now or wait X"), works with his questions, cheap on tokens, **numbers that tell a story, not stats-wordy**. A dashboard home page with the trades, the Coach, the weekly matchup and intelligence read, major news and waivers; deep dives on their own pages. Every old UI surface inspected and cleaned. Work until every item is done.

**Order (Nick, 04:00): finish what is running, then everything already queued, then the new work. Wire every piece in properly. Before building anything, ask whether it already exists; if it does, audit that system first and re-engineer it only if the audit says so.**

**Rules that hold for every item:** one workflow at a time on this machine; every model change passes a gate written before it runs (fit on earlier seasons, validate 2024/2025, player-clustered bootstrap); tests first (tdd-workflow), commits of each agent's own files only, pushed after integration; every installed skill used (agents read `~/.claude/skills/*/SKILL.md`); the web server restarts only after an integration pass, always with `SCHEDULER_DISABLED=1`.

---

## Sequence

| # | Workflow | What it delivers | Est. |
|---|---|---|---|
| W0 | early-season + skills review *(running)* | Week 2-4 projections use the structural head; rest-of-season value from preseason + in-season evidence; fake floors; play-chance by role; waiver drops never cut a higher-ROS player; IR-slot starts; 10-lens skills review + fixes | ~1 h left |
| WQ | **Queued work** (section Q below) | Every item deferred earlier in the session, gated; housekeeping | 3-4 h |
| W1 | **Trade Brain** | Trades built from how each person values players, with the edge, the tactic, the package and the negotiation plan | 2-3 h |
| W2 | **Coach** | Grounded chat + the weekly action plan ("send now / wait until…"), cheap, numbers that tell a story | 2 h |
| W3 | **Dashboard home** | New `/` page: action plan, top trades, Coach, matchup + intelligence read, major news, waivers; deep-dive links | 1.5 h |
| W4 | **UI audit + cleanup** | Every page inspected in the browser at phone and desktop width; dead/betting remnants removed; one consistent design | 1.5-2 h |
| W5 | **Models fully built out** | Everything still open in the model chain (list below), each gated | 2-3 h |
| W6 | **Final integration** | Full suite, build, harness, live smoke on all 5 leagues, restart, morning report | 45 min |

---

## Existing systems first — discover, audit, decide, then build

Every workflow from W1 on starts with a **Discover → Audit → Decide** phase before any new code:
1. **Discover** every existing implementation of the capability (routes, services, client components, tables, LLM calls). A read-only inventory of all overlapping systems was run at 04:00 and is attached below when it lands.
2. **Audit** each one the way the model-chain audit did: does it run, what does it read, is it correct, which page uses it, is it duplicated.
3. **Decide** per system: *extend* (sound, missing pieces), *re-engineer* (right idea, wrong inputs or wrong math), *retire* (duplicated or dead), or *build new* only when nothing exists. The decision and its evidence go in the workflow report.
4. **Wire it in**: one source of truth per capability; every consumer (page, Coach tool, dashboard section, plan) reads the same service; no second copy of the same logic.

Known overlaps to resolve (from the route map): the Coach vs `PageExplainAssistant` + `/explain` + `/sense-check` + Trade Lab `/pitch`; the action plan vs `/inbox` (decision inbox) + `/brain/plan` + `/post-draft-plan`; the Trade Brain vs `findTrades` + `/title-trades` + Trade Lab `/partners` + `/brain/sell-high` + `/brain/liquidity` + `counterparty-pricing`; waivers `waiver-wire.js` vs `waiver-brain.js` vs `/brain/waivers` + `/brain/free-agents`; the dashboard vs League Hub / My Team / TeamScout; news vs `/news-edge` + news-fantasy-impact.

---

## Q — Everything already queued (finish before the new work)

**Q1. Model-chain deferrals (each gated):**
- `targetSharePrior` 0.06 for WR/TE/RB — fit per-position shares jointly with the volume k (WR 0.131, TE 0.098, RB 0.062 measured).
- QBR: re-sync 2021-2024 QBR, then a starts-based shrink (20% of reads rest on < 3 starts).
- Negative-binomial dispersion (/n variance, unfitted fallbacks, DNP rows inflating it, independent draws of targets/carries/attempts).
- Ensemble form: convex vs LAD + intercept (LOSO 4.422 vs 4.344, 5/5 folds) and the median head's definition.
- P(play) 0.92 floor cliff and zero-inflation in the weekly distribution; the copula's QB-WR1 understatement and the (p90-p10)/2.56 spread rule.
- Trade objective constants still unfitted: value-giveaway λ 0.9, fairness cap, the 0.2 × joint_ppg term, PLAYOFF_IMPORTANCE × odds.
- Week-postmortem must grade with the projection as of that week (cutoff honoured).
- `weekly-learning.js` retrain: keep the early-week key, grade against the live set, stop rejecting on coverage noise (0.78 line).
- Posture: bootstrap by player, and the spread-rule choice that the verifier called a coin flip.
- Roster-risk LAST_REGULAR_WEEK per league; the `playoff_sos` field rename.
- Volume-prediction grading: grade feature families on target and carry prediction, not points.

**Q2. The other considerations:** multi-week horizon in trades and the plan; bye-week planning; trade-deadline awareness; confidence display (only where it changes a decision); stacking as a playoff tool.

**Q3. Deferred product work:** Phase 6 more deals (depth-3 sequences, three-team routes); Phase 7 explain from every evidence block; P(accept) as proposals accrue and counter-offer behaviour (first pass ~week 10); the early-QB finding → next year's draft tool with a value-over-replacement baseline agent; bench points per week (needs weekly roster snapshots captured on the refresh loop); the durability prior in `weeklyAvailability` (the side session Nick stopped — reconcile with W0's play-chance work).

**Q4. Housekeeping:** the three untracked files nothing imports (`coach-qb-context.js`, `efficiency-features.js`, `td-features.js`) — review and either wire or delete; the launcher's `spawn node ENOENT` so the phone "start" button works; the 3 failing prop-CLV tests (betting, pre-existing) — fix or quarantine with a reason; `.env.bak-*` cleanup (ignored, still on disk).

**Q5. Later, Nick's call:** Phase 11 accounts and 24/7 hosting.

---

## W1 — Trade Brain: the other person designs the trade, we keep the edge

**The core object is a per-manager valuation map**: for every player in the league, what *this* manager thinks he is worth, next to what we think he is worth. The gap on each player is the raw material of every trade.

Their value = our value × their personal multipliers, each capped and each from data we already hold:

| Signal | Source | Effect |
|---|---|---|
| How they talk about the player (chat sentiment, n) | `manager_player_sentiment`, `talk-vs-model.js` reads | loves → overvalues; sours → undervalues |
| What the negotiation profile says they over/undervalue | `negotiation_profiles.roster_read` (all 9 + Nick) | explicit names |
| Hype vs usage (outscoring expected points) | `talkReads` expectation gaps | a hot player they own is priced at his hot number |
| Luck-flattered record | `manager_archetypes` luck block | flattered managers price their roster high |
| Positional need / roster holes | lineup solve per roster | a need raises what they pay at that position |
| Recency / last-week reaction | weekly scores, `reacting_to_loss` | post-loss window lowers resistance |
| Declared untouchables and their credibility | `bluff-detector.js` | respect / probe / ignore |

**Tactics** (each is a rule that fires on the valuation map, and each idea card names the tactic it used):
1. **Sell the crush** — they overvalue a player of ours: make him the centrepiece.
2. **Buy the sour** — they undervalue a player of theirs (complained about him, bad week, below-expectation line): target him.
3. **Sneak-in** — a throw-in they rate as filler that our model rates highly (a backup RB with rising role, a WR whose usage is up).
4. **Consolidate for need** — 2-for-1 into a team with a hole, where their need prices our depth above our value.
5. **Hype window** — sell a player of ours who is outscoring his usage *before* the regression, to the manager who has praised him.
6. **Post-loss / timing** — send inside their fastest-response window, or after a loss when they are reacting; wait when they just declined.
7. **Anchor ladder** — opening ask (P≈0.25), fair (≈0.5), floor (≈0.75 and still positive for Nick), phrased in their own language.
8. **Veto-proof** — the league has vetoed Nick's deals (4 votes on the Rami trade): the package must look fair to the league, not only to the partner, so the ask is capped by a league-perceived fairness check.
9. **How Nick looks** — pacing by his recent offers to that person, never lead with a player the whole league knows he is shopping (Achane), and counter Nick's own known pressure points (Raj's "you need wins now").

**The edge test (non-negotiable):** every idea must be positive for Nick on *our* numbers — this-week and rest-of-season lineup gain, horizon-weighted — while scoring well on *their* numbers. An idea that only wins on their perception is a gift, not a trade.

**P(accept)** — too few decided proposals (6 accepts, 24 declines) to fit a model, so it is a band from the heuristic (their perceived value delta, need fit, receptiveness, profile) with the observed accept rate as the anchor, labelled as a band.

**AI pass (cheap):** once per league per day, Sonnet 5 turns the top ~12 numeric ideas into 5-8 **sendable proposals**: the package, the one-line why-they-say-yes in their terms, the opening message in Nick's voice, ask / fair / floor, send now or wait-until with the reason, the one risk, and the data it leaned on. It may drop or merge ideas; it may not invent players or numbers (verified after the call). Cached per league-day.

**Where it shows:** Trade Lab (full list + detail), the dashboard (top 3), the Coach (as tools).

**Acceptance:** top ideas change when the sentiment map is zeroed (proof it is read); no idea targets a credible untouchable; every idea is positive on our numbers; every proposal's cited data exists.

---

## W2 — Coach: accurate, a plan, cheap

**The weekly action plan is computed, not generated.** A deterministic service ranks this week's moves across lineup, waivers, trades and "don't do this" warnings — each with an action, a reason in one sentence, the one or two numbers that tell the story, and timing (*now* / *wait until <day, time> because <reason>*). Example shape: *"Stop shopping Achane — the whole league knows. Send Raj [package] instead, Thursday night after his loss; he answers in ~20 min and has taken 1 of 4 of your offers."*

**Chat** is a thin, grounded layer on top:
- Tool use over our own services (`plan`, `trades`, `manager_read`, `player`, `matchup`, `waivers`, `news`, `lineup`). The model fetches only what the question needs.
- One compact **situation brief** (the plan + Nick's roster + this week's matchup, ~1.5k tokens) is the cached prefix, so repeat questions cost little.
- Style contract: answer first, then why, then the move; ≤ ~120 words unless asked for more; at most three numbers, each one that changes the decision; no stat dumps.
- **Accuracy check:** every number in a reply must appear in that turn's tool results; a reply that fails is regenerated once with the offending numbers named, then falls back to "I don't have that".
- **Cost guard:** Sonnet 5 by default, daily budget (default $1, set in Settings), tokens logged per turn and shown; Haiku only for trivial routing.
- The plan and the trade proposals are the Coach's main tools, so "the plan" and "the chat" never disagree.

**Acceptance:** 20 scripted questions (lineup, trade, person, "should I send this now") answered with zero numbers absent from tool results; median cost per answer shown; the plan's top action appears when asked "what should I do this week".

---

## W3 — Dashboard home

`/` becomes the dashboard (current `/league` stays as the deep dive). Phone-first, one column on mobile, two on desktop:
1. **Do this now** — the action plan (top 3-5), each with its timing.
2. **This week** — matchup projection vs opponent, win chance, the one lineup call that matters, the intelligence read on the opponent.
3. **Trades** — top 3 proposals with the tactic and the send window; link to Trade Lab.
4. **Coach** — the chat, inline, with suggested questions drawn from the plan.
5. **Waivers** — top claims with the drop.
6. **Major news** — only items that touch Nick's rosters or targets, with what it changes.

Each section links to its page. Nav: Home first.

## W4 — UI audit and cleanup

Every route opened in the browser at 375 px and desktop width, logged in: League Hub, Start/Sit, Trade Lab, Draft (hub, room, live), News, X's & O's (teams, team detail), player detail, Settings, Pair, Edge, Model, and every redirect. For each: dead or betting-era widgets, stale copy ("season average" where it is weekly, retired schedule signals), numbers that disagree between pages, broken states (empty league, no sync, API error), horizontal scroll, accessibility basics. Remove what is dead, fix what is wrong, keep one visual language. Screenshots before/after in the morning report.

## W5 — Models fully built out

From the audits, verifiers and integration notes — each gated:
- Rest-of-season model beyond week 10 (proven only through week 10).
- Play-chance activation, respecting ESPN Questionable/Doubtful; then ship the fake-floor fix that waits on it.
- `weekly-learning.js` retrain saves the early-week key and grades against the live set.
- Multi-week horizon, bye-week planning and trade-deadline awareness in trades and the plan.
- Confidence labels on projections (from interval coverage), shown only where they change a decision.
- Stacking as a playoff tool (QB-WR correlation) when it clears a gate.
- Trade-explain rebuilt from the evidence blocks (Phase 7), numbers cited.
- Trade-engine backtest on the proposals captured so far (Phase 9), honest about sample size.
- Start/Sit accuracy table replaced everywhere by the relevant-pairs numbers.

## W6 — Final integration and morning report

`npm test`, `tsc`, `lint`, `build`; harness (weeks 2-4 and 5-18); live smoke on all 5 leagues; restart with `SCHEDULER_DISABLED=1`; push. Morning report: what changed, what Nick will see, what is still open and why.
