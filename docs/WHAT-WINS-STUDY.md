# What It Takes to Win — the study that defines the engine's target

**Status:** designed 2026-09-17 from a five-angle literature review (academic, practitioner, luck/skill, methodology, established findings; 102 sources). Not yet built. This document supersedes the informal design in the chat and is the spec the build is graded against.
**Why it exists:** every model in the app optimises *something* — season PPG, market value — and nothing ever established that those are what win. This study establishes the target first. Everything in `FANTASY-ENGINE-MASTER-PLAN.md` is then graded on it.

---

## 0. What the research changed

The first design had two fatal flaws that all five reviewers found independently, and four serious ones. Fixed below. It also surfaced a set of measured facts about fantasy football that reorder the engine's priorities — most importantly that **season-long fantasy at the manager level is roughly 80% luck**, that **good projections beat real managers by only about +0.2 wins a season**, and that **the documented in-season edge is keeping live players, not out-projecting anyone.** The person on the other side of a trade is the one part of the system that finding does not touch.

## 1. Measured facts the design and the engine now rest on

Every number below is from a cited source in the review; ranges are the review's own.

| Fact | Number | Consequence |
|---|---|---|
| Manager skill share, season-long H2H | R* = 0.19 (Cates; 4,115 teams, 1,252 ESPN leagues); year-to-year R² = 0.01 | A 10-team, 13–14-week league sits at the far luck end. Anything "found" from a handful of real leagues is noise. |
| Schedule luck | ±2 wins/season SD ≈ 1.9; actual-vs-all-play gap up to ±3 wins; 26–33% of standings variance; all-play vs H2H r ≈ 0.82–0.86 | All-play is the regular-season outcome. Show every manager's luck. |
| Bracket luck | 53% per-game favourite wins a 4-team single-elimination title 28% of the time; best regular-season team wins ~1/3 of titles | Title probability is the noisiest outcome available. It is a derived quantity, not the estimand. |
| Lineup efficiency | managers ≈ 85% of hindsight optimum, ~20 pts/week left on the bench; **projections beat managers by +0.2 wins/season**; hindsight-optimal = +2.9 wins | The projection's ceiling for start/sit is small. Not starting zeros is worth more than any accuracy gain. |
| Structure effects, managed leagues | small: ~+15 pts/season, ~+2–5 pp; flip sign season to season (early WR vs early RB flipped 2021 → 2025) | Structure is real but small and market-dependent. Never pooled across years without season × structure terms. |
| Strongest documented driver | **ADP value captured** (draft capital vs market): +20–30 pts/season, ~5 pp advance rate; structure effects shrink once it is controlled | "Value vs consensus price" is the thing to measure at the draft and its trade analogue in-season. |
| Biggest in-season driver | **live players at week 14**; in managed leagues ~half of title-roster value arrives after the draft (waivers, late picks) | Waivers and injury replacement are first-class engine features, not afterthoughts. |
| Volatility | + in best ball (+4–14% per doubled SD); **−** in managed H2H (consistent rosters 51.4% vs 48.5%); sign depends on favourite/underdog | The lineup posture must switch by stage and by who is favoured. A pooled "volatility" number is meaningless. |
| Playoff vs regular season | different drivers (ETR 4:1 finals-to-advance exchange rate); ADP value → advance; ceiling, correlation, live players → finals | Model both, separately. |
| Correlation | QB–WR1 weekly r 0.31–0.43; stacking changes no season total; +1.8 ceiling / −1.6 floor per week; lift is finals-only | Stack when you need ceiling; never for the regular season. |
| Position volatility (played weeks) | CV: QB 0.36, RB 0.54, WR 0.58, TE 0.63; raw SD ≈ equal (6.4–7.6) | Use CV, never raw SD. |
| RB availability | 27% play a full season; mean 13.7 games; RB vs WR miss 2.4 vs 2.2 games; no "curse of 370" threshold | Injury risk is a per-player hazard, not a workload cliff. |
| ADP predictiveness | Spearman ≈ 0.6, Pearson ≈ 0.4; validity concentrated in rounds 1–3; R1 hit rate WR 63%, RB 58%; ~half of preseason top-12 retain tier | ADP noise in the replay must reproduce this; tighter means the draft is unrealistic. |
| TD regression | xTD barely more predictive of next-year TDs (r² .282 vs .277) but much stickier (.381 vs .277); 11% of 10+ TD players increase; mean −5.4 | The expected-points anchor is right; expect a modest gain, not a large one. |
| "What winners have in common" studies | conditioned on winners, no base rates | Not evidence. The study never conditions on the outcome. |

## 2. The study — redesigned

### 2.1 Two estimands, strictly separated

The original design regressed season-end roster strength on all-play record — points on points, a tautology that produces huge R² and no decision. There are now two models and they never share a covariate:

**(A) Ex-ante — "what to do."** Only information knowable at the decision time enters: ADP-implied positional capital (in draft-capital units, not round counts), structure archetype, draft slot, ADP value captured (sum of ADP − pick), roster counts, concentration of draft cost, *projected* volatility from prior-year CV by position, bench size. This is the only model that informs the draft tool, the trade engine, or the projection. **Its output is the target spec.**

**(B) Ex-post — "what it looked like."** Realised positional strength, realised CV, playoff-week points, live players at week 14, source of players. Descriptive accounting only: how much of title variance was luck vs draft-time structure, and through which channel (e.g. how much of an archetype's effect flows through RB injury exposure). It never enters model (A). It is never presented as "what it takes."

### 2.2 The unit of inference is the season

Every simulated league inside 2023 shares 2023's breakouts and injuries. Ten thousand leagues over five seasons is five draws. Design effect for plausible intra-season correlation is 20–200, so naive standard errors are wrong by an order of magnitude.

Rules: season is the cluster; wild-cluster bootstrap-t (Cameron–Gelbach–Miller) confidence intervals; every effect reported **per season** and pooled; an effect is "known" only if its sign holds in **≥ 4 of 5 seasons**; leave-one-season-out validation; jackknife the top player-seasons (drop CMC / Chase / Kelce and refit — if the effect goes with them it was them); report the ICC and design effect. **Two-stage:** explore on 2021–2023, freeze definitions and hypotheses in a pre-registration note, confirm on 2024–2025. 2026 is out-of-sample as it arrives.

### 2.3 Managers are agents, not "ADP + noise"

Homogeneous ADP drafters have no strategy variance to detect; the regression would estimate which noise draws did best, entangled with draft slot. Real drafters (JDM 2022, 1,350 Sleeper leagues, 188,426 picks) show strong positional rhythm, herd on the previous pick, and time K/DST; humans won 51% of games vs bots' 39%.

Design: **factorial**. Each team is assigned an explicit archetype — Zero RB, Hero RB, Robust RB, early QB, early TE, late QB, balanced/BPA-by-ADP, high-volatility seeker, contrarian ADP-fader — with league mix varied (1, 3, 5 adopters). Opponents draft on a behaviourally calibrated rule (positional rhythm, herding, K/DST timing, ADP noise widening with pick number). Draft slot is a fixed effect; ADP value captured is a covariate in every regression; structure is expressed in draft-capital units. **Composition value is relative to the field** — the answer for Nick's league uses Nick's field (calibrated from the 2023–25 history pull: who reaches, who follows ADP, who works waivers).

### 2.4 Rosters are managed, not frozen

Frozen rosters make this best ball with a lineup layer; ~half of managed-league title value arrives after the draft. Every bot runs a uniform, non-look-ahead churn rule each week: drop the lowest trailing-N-week bench scorer, claim the best free agent by trailing points (or ADP-rank-of-remaining early), reverse-standings priority; injured/zero starters replaced from the pool by the same rule. **Waiver aggressiveness is an agent parameter.** "Live players at week 14" is computed and reported. Results are shown with and without churn so the draft-only and managed answers are both visible.

### 2.5 Three lineup arms; the middle one is the headline

Hindsight-optimal lineups are unattainable (~20 pts/week above real managers) and turn head-to-head into best ball, so volatility is harvested automatically and the study would "discover" that ceiling beats floor.

Arms: **(1) naive** — ADP order; **(2) attainable** — season-to-date PPG with an ADP prior for early weeks, plus OUT status, never the same week's points (this is the headline arm; the ffsimulator prior for real efficiency is N(0.775, 0.05)); **(3) hindsight ceiling**. Decision value = attainable − naive. Hindsight is reported only as a bound. Roster-feature coefficients are reported under arm (2).

### 2.6 Outcomes

Primary: **all-play win %** (regular season) and **expected wins with capped per-week influence** (all-play discards margin; a 0.1-point win and a 40-point win look identical). Playoffs: two objects, labelled — (i) conditional title probability given realised scores (a luck decomposition, computed analytically from all-play ranks; replaying a bracket on fixed points only reshuffles seeding), and (ii) **ex-ante title probability** with playoff-week scores resampled from each player's full empirical weekly distribution (all 17 weeks × 5 years ≈ 85 weeks per player — ETR's "every week is a playoff week" device). The gap between (i) and (ii) is irreducible playoff luck. Regular season and playoffs are modelled separately because their drivers differ.

### 2.7 Volatility, done properly

CV on played weeks only; count of zero weeks as its own regressor; interacted with ex-ante team strength (favourite vs underdog) and with stage (regular vs playoff); reported per lineup arm; a best-ball arm included as the positive control that must show the + sign.

### 2.8 Placebos that target the real threats

The label shuffle destroys everything and always passes; it stays as a code test only. Real placebos:
- **Season-mismatch:** draft with year-t ADP, score with year-t+1 outcomes → ex-ante ADP-value effects must vanish; if hindsight effects survive, that exposes their tautology.
- **Within-player week shuffle:** keeps season totals, breaks weekly structure → must kill every volatility and playoff-week claim.
- **Player-swap within ADP band:** structure fixed, identity redrawn → separates "this structure" from "these players."
- **Schedule-only shuffle:** all-play unchanged, H2H moves ±2 wins → validates the schedule randomiser.
- **Synthetic seasons** with a planted effect (projection + noise) → the pipeline must recover it.

### 2.9 Pre-registration

Before any run: feature definitions, the format list, the archetype list, the minimum practical effect (≥ +0.03 all-play win % or ≥ +3 pp title probability, sign-stable in ≥ 4 of 5 seasons), season-clustered CIs, Benjamini–Hochberg across features × formats. **All format cells are reported**, not the interesting ones.

### 2.10 ADP and format honesty

One point-in-time preseason ADP snapshot per season with a documented date (the week before Week 1), from a redraft source matching the format (FantasyPros consensus PPR / half-PPR; ESPN where available) — **not** Underdog best-ball ADP, whose QB/TE pricing embeds 3-QB builds and variance harvesting. Sensitivity to an earlier snapshot. Because 2021–25 ADP encodes five different markets (RB share of the top 36 picks moved 44–50% → 25% → 36%), report year × structure interactions and add a "draft from the 5-year-average ADP" counterfactual arm to separate structure from that year's mispricing. K/DST included as empirical weekly noise draws; roster and bench sizes parameterised; real bye schedules; ties defined.

### 2.11 Known answers first — the gate on the study itself

The simulator runs first in **12-team half-PPR best ball**, the only configuration with a public benchmark, and must reproduce, within published ranges:
- schedule luck ±2 wins, all-play vs H2H r ≈ 0.82–0.86, a top scorer missing the playoffs in a low-single-digit % tail
- bracket: 53% favourite → 28% title; best team ~1/3
- CV by position (QB .36 / RB .54 / WR .58 / TE .63); RB games (27% full, mean 13.7)
- ADP → season value Spearman ≈ 0.6; R1 hit rates WR 63% / RB 58%
- hindsight gap ~20 pts/week with 2–3 wrong starters; attainable arm at 75–80% of hindsight
- volatility: + under best-ball lineups, ~0 or − under managed
- baseline advance rate 16.7%; under the code-test shuffle, a 10-team title rate of exactly 10%
- Cates persistence: year-over-year R² ≈ 0.01 for H2H records
Only then does one format dimension change at a time toward Nick's formats (10-team, 1–2 flex, PPR / half-PPR), so any divergence is attributable. **ffsimulator (CRAN)** is the reference implementation for ADP-to-outcome resampling by positional rank, its injury model, and its efficiency prior; reuse its choices where ours are unspecified.

### 2.12 Nick's leagues: calibration and ground truth

The 2023–25 history pull (approved) does three things the simulation cannot: calibrates the agents to *his* field; is the test the simulation must reproduce (scoring distribution, playoff teams, roughly the winners); and yields the answers only about him — all-play vs actual for every manager (who has been lucky and thinks he is good), bench points per week, what his actual title rosters looked like, luck decomposition per team per season.

### 2.13 Deliverables

1. `study/what-wins/` — the replay engine (Python; joins `player_week_usage`, historical ADP, real bye schedules; agents, churn, three arms, outcomes, placebos), pre-registration note, and a results notebook with every format cell.
2. **The target spec per format**, written to `docs/TARGET-SPEC-<format>.md`: the winning weekly number by stage, the ex-ante structure effects with season-clustered CIs and per-season signs, the posture rule (when floor, when ceiling), decision value (attainable − naive), and the luck decomposition.
3. **The luck panel** for the app: all-play vs actual, expected wins, bench points, per manager, per week.
4. The **known-answers report** — the gate on the study, with every reproduced number next to its published range.

## 3. How it feeds the engine — the reorder

1. **The gate changes.** Every projection change (1b redistribution, 1c expected-points anchor, 1d route-run volume, 1f ML head) is graded on whether it moves **attainable-arm all-play win %** in the replay and **bench points** on Nick's real weeks — not MAE. Expectation is calibrated by the literature: projections vs managers ≈ +0.2 wins. A change that moves that is real; the ceiling is known.
2. **Availability moves to the top.** Not starting zeros is the single largest lineup lever. The measured per-team injury dialect replaces the hand-set constants in `contingency.js` first.
3. **Live players become a first-class metric.** Waivers, injury replacement, claim-and-flip, and "live players at week 14" are engine features with their own tab, graded on the same replay.
4. **Trades are scored on value captured vs consensus price**, the in-season analogue of ADP value captured — which is exactly what `their_value` and the counterparty layer price. The person side is the part of the system the 80%-luck finding does not touch: Raj's five reversals are not random. That is where the durable edge is.
5. **The lineup engine switches posture** by stage and by favourite/underdog status: floor and consistency in the regular season when favoured, ceiling and correlation in the playoffs or as an underdog. Stacks are a playoff tool.
6. **The app shows luck.** All-play vs actual and expected wins for every manager, every week — so Nick neither overrates his own roster nor underrates it, and so he knows which lucky manager to sell to.
7. **The season simulator is audited** against the replay and against Nick's real leagues before its title odds are shown as a decision number.

## 4. Execution order

| Step | Work | Days | Gate |
|---|---|---|---|
| 1 | Pull 2023–25 league history (transactions with the correct `X-Fantasy-Filter`, drafts with the auto-pick flag, weekly rosters); all-play, expected wins, bench points, luck panel per manager | 1 | numbers per manager per season |
| 2 | Pre-registration note: features, formats, archetypes, minimum effect, placebo list | 0.5 | written before any run |
| 3 | Replay engine in the 12-team half-PPR best-ball config; reproduce the known answers | 2 | every number inside its published range |
| 4 | Add agents, churn, three lineup arms; move one dimension at a time to Nick's formats | 2 | schedule-luck and hindsight-gap answers still hold |
| 5 | Ex-ante model (A) with season-clustered inference, per-season signs, jackknife, placebos; ex-post accounting (B) | 1.5 | ≥ 4-of-5 sign rule; all placebos behave |
| 6 | Target spec per format; luck panel shipped to the app; simulator audit | 1 | spec written; sim agrees with replay and with real leagues within error |
| 7 | Re-point the master plan's gates at the spec; resume 1b / 1c / 1d graded on attainable-arm all-play + bench points | — | — |

About eight working days. Nothing in the engine changes until step 6, by design.

## 5. If the numbers don't go great

- **Ex-ante structure effects all fail the 4-of-5 rule.** Expected. The honest finding is "structure is small and market-dependent"; the spec becomes: capture ADP value, keep live players, switch posture by stage — and the engine's effort concentrates on availability, waivers, and the person side.
- **The known answers don't reproduce.** The study does not ship. Fix the simulator until they do; a replay that cannot recover schedule luck of ±2 wins has a broken schedule randomiser, not a new discovery.
- **Nick's leagues don't match the replay.** Calibrate the agents to his field (his history) before trusting the format answer; if still off, report both and say which one the trade engine uses and why.
- **Projection changes don't move attainable-arm all-play.** They ship if they don't hurt and improve bench points; the literature says the ceiling is +0.2 wins, so a null here is not a failure of the work, it is the measured shape of the game.
