# META-01 "the Referee": final design v2 (revised after three independent critiques, 2026-09-23 ~7:45 PM ET)

**Status:** design v2, supersedes v1 of this file and `META-01-REFEREE-MEMO.md`. Nothing built, nothing served changes.
**Inputs:** v1 (the coordinator's memo, 3 designs, 2 judges, the historical probe `~/gridiron-local/rnd/meta/probe.md`, prereg sha `c79c58ad…`, re-checked OK tonight), plus three independent critiques (43 findings; every one is answered in §10). Every DB number below that a critique reported was re-measured tonight on a fresh `.backup` copy (deleted after) unless marked "critic-measured".
**Cites:** origin/main `a6a77824` unless a PR is named (#164 head `07c81a6d`, open, not a draft; #216 `9e8fc9d0`; #222 `29b77bf0`; #218 `ce340e0b`). `ENGINE-ARCHITECTURE.md` v2 line numbers as of tonight.
**Rulebook:** RULES.md. 2025 stays closed except where the ledger already spent it (named below). FantasyPros consensus is an internal, lab-only input: aggregates only, never a per-player row, never a served field, never displayed.

**What changed from v1, in one paragraph.** v1 built three combiners × 768 cells × an argument tilt × a mixture on the mean, on data that said "the point is ESPN". The critiques found five real breaks: the mixture made the served number ESPN × our broken 0.694 availability layer at n = 0 and counted no-shows twice; the experts were compared at different times and the 2026 replay rows were captured after the games; `published_at` is not knowledge time; the P(plays) incumbent was the known-broken path while a validated fix already sits on main; and the champion pointer, `cons.week`, `blend.p_play` and `referee.expert.*` broke the engine's own contracts. v2 keeps the goal (every source scored on the past and on every week, nothing locked out, ESPN as the prior, one machine) and ships the simple thing that is equally correct: **served point = ESPN; range = residual quantiles + adaptive conformal, inside the one simulator; chance to play = the validated role-cell model with the reader and Jev as graded shadow experts at a fixed decision time; one structured correction in shadow; the lab keeps the three combiners and the lockout check, and production adds a combiner only when an expert with an as-of stamp shows forward lift.**

---

## 0. One page for Nick

**What you asked for:** one machine that pulls every source, weighs each by its past accuracy in this situation, by the argument it is making and by its calibrated confidence, runs several techniques so no one technique locks a source out, learns on 2021-24, goes live now and keeps learning every week.

**What the past says (measured, pre-registered, re-checked tonight):**
- On weekly points, ESPN's number is the anchor. Five combiners of five numeric experts, walk-forward on 2023 and 2024: none beat "start ESPN's higher number". The learning rule (Hedge) became ESPN by week 5-8 of 2021 and stayed there. Stacking cut MAE 1.1% both years and changed no start/sit call. Our own chain is 0.636 pair accuracy vs ESPN 0.683 (BLEND-01).
- ESPN plus per-position residual quantiles already gives an 80% range that covers 81% / 80%. ESPN ships no range.
- Our chance-to-play number was broken (0.694 on players who play 95% of the time). A role-cell fix is already on main, fit on 2021-24 and scored once on 2025: log loss 0.551 → 0.396, healthy starters 0.708 → 0.952. Only its production rate write is held.
- Two ESPN blind spots are proven (PR #222). One (blowout underdog RB, about −0.5 to −0.7 pts) has pre-game inputs. The other (QB change) has no clean pre-kickoff starter source yet.
- Text helps only where the numbers are blind (RL-6 caught one fresh injury the numbers missed); an LLM persona does not predict people (AUC 0.47 vs 0.78 for a move count).

**So the machine does five things, and your three levers survive in a testable form:**
1. **Past accuracy decides weight.** Every expert (ESPN, Vegas, our chain, the corrections, the reader, Jev) is scored every week by the engine's grader at a fixed decision time; the served weights are code constants moved by PR with the grade report attached. At n = 0 the weights are "ESPN alone", so the machine can never do worse than ESPN by construction.
2. **The argument is read as typed facts, and the numbers decide.** The AI reader turns news into fixed-enum facts with a quoted evidence span (the existing `nfl-news-signal.js` pattern), stamped at the moment we learned them. A fact only counts where the numbers were blind at that moment. Every served number shows who moved it and cites the events.
3. **Confidence is calibrated before it is trusted.** Every expert's stated confidence goes through a calibration map fit on outcomes ("reader says 0.9, hits 0.71, n = 140"), never used raw.
4. **Multiple techniques, nothing locked out.** The lab runs three combiners and a nightly lockout check on every expert; production adds a combiner only when an expert shows forward lift. New experts get no shrinkage toward zero and one global parameter each, so "weight 0" reads "not enough data yet", never "proven useless". Each expert's scorecard shows the effect size we could detect this season.
5. **Live off the past, honestly.** What warms from 2021-24: ESPN as the point, the range, the role-cell chance to play, the one correction. What cannot warm: text and Jev (no 2021-24 text; and any historical LLM grade is contaminated). Those are graded forward from their first stamped week.

**The honest calendar** (sizes are guesses; the spine chain EA-00 → EA-02 → EA-03 → EA-04 is ~7 agent-days serial before any Referee row exists on the spine):
| When | What goes live | Needs |
|---|---|---|
| this week (by Thu 9/24 kickoff) | as-of ESPN capture running (the poller), typed-news shadow log running, META-01a prereg committed in a draft PR | a scheduled job for the poller (RULES §7: scheduling is a launch, not a build); the news extractor's Claude key fixed (401 × 29 runs since 9/22 6:26 PM ET, measured) |
| week 4-5 | served point = ESPN (lift #164's four holds, own labelled promotion); chance to play = the role-cell model (its held rate write) | Nick's OK on serving ESPN's point as the anchor with our range and chance to play on top (his 3 PM ruling was about FantasyPros; this is ESPN) |
| week 6-7 | the calibrated 80% range on every player, labelled "calibrated at lock" | PROJ-03-c on `range.week` (after CE-03 in loop 2) |
| week 6-8 | Referee scorecards + reader and Jev in shadow on the spine | EA-04 merged |
| week 10 | range verdict of record (4 forward graded weeks) | |
| week 12-14 at best | reader / Jev P(plays) verdict (about 27-30 informative rows a week in 2023-24, 12-15 in 2026 weeks 1-2, measured) | |
| probably not in 2026 | any points number served over ESPN | a text expert clearing §4.3 |

**Honest expectation:** numeric gain on points ≈ 0 (that is what the probe and the oracle bound say); the text upside is unknown and is measured, not assumed. The sure wins are the range, the chance-to-play fix, and the attribution.

**Next action (Nick, 2 minutes):** fix the news extractor's Claude key (Settings → the key the refresh process uses; `sync_log` says `401 invalid x-api-key`, 29 runs in a row), and say yes/no to ESPN's point as the served anchor.

---

## 1. Where the gain can come from (what the record and the probe say)

### 1.1 The combination puzzle, on our data
- BLEND-01 (#164 tournament output, verified): ESPN 0.6830 pair accuracy vs ours 0.6359; the fixed 50/50 blend 0.6783 (−0.0047 [−0.0081, −0.0011] vs ESPN); every fitted blend tied ESPN; MDE80 0.0089-0.0113.
- HX-01 (verified): **ours vs consensus** 0.6347 vs 0.6656 (SE 0.0037). That is our number vs FantasyPros, not ESPN vs FantasyPros. Within the probe's top-N, ESPN orders better than the consensus rank (Spearman 0.47-0.51 vs 0.38-0.41; post-hoc, decides nothing).
- The probe (§7): Hedge → ESPN 1.000 at every position by the end of 2022; STACK −0.065 MAE both years, no CRPS or decision change; EQ worse; HEDGE+MM flips sign across seasons; EG learned a Vegas mix and gained nothing.
- Vegas on ESPN's at-lock number: in-sample oracle ceiling +0.0013 [+0.0006, +0.0021] (LOOP-LOG:2343). Weather dead (oracle +0.0003).
- Public-data "edges" are priced (rounds 5-8, AI-01).

### 1.2 Information-type tags
M = model on public stats, C = human crowd, K = market, T = text, O = our chain. Same-tag experts are near-duplicates; only a different tag can add ordering information. **The reader and Jev's Claude cross-check arm are one T source** (both Claude reading the same text) and are shrunk together.

### 1.3 Post-hoc diagnostic on the probe's rows (mine; NOT pre-registered; decides nothing)
`~/gridiron-local/rnd/meta/diag-bound.py`, output `diag-bound.json`. **What it is:** a per-position, in-sample linear-pool bound on squared error, with each expert's missing values filled by ESPN's value (20% of 2024 rows have no consensus and are exact ESPN copies there), residuals including DNP = 0. **What it is not:** a bound on pair accuracy, or on any cell-wise or nonlinear combiner.

| | 2023 | 2024 |
|---|---|---|
| residual corr with ESPN's residual: cons / std / l3 / vegas | 0.902 / 0.916 / 0.874 / 0.896 | 0.908 / 0.918 / 0.871 / 0.907 |
| ESPN: MAE / RMSE / pair accuracy | 5.725 / 7.303 / 0.6478 | 5.748 / 7.282 / 0.6522 |
| oracle pool (OLS per position, fit on the graded season): MAE / pair acc | 5.646 / 0.6514 | 5.667 / 0.6538 |
| oracle gain vs ESPN: MAE / pair acc | −0.079 / +0.0036 | −0.081 / +0.0016 |

Reading: the correlations are high partly because every expert shares the same outcome noise and because of the ESPN fill; a text expert that fixed a handful of rows would also correlate > 0.95 with ESPN's residual. So **the correlation number is descriptive and there is no correlation kill rule** (v1's was dropped: it would lock out exactly the experts Nick wants admitted). The decision that production has no numeric stacking for the point rests on the probe's pre-registered ship rule failing in both seasons, not on this table. A new expert is admitted by the encompassing test in §3.7, computed on rows where the expert is actually present.

### 1.4 What carries different information (the targets)
1. **The distribution.** ESPN has none. Residual quantiles on ESPN reach 0.810 / 0.801 coverage on the probe's top-N (99% played, so that number describes the played population at lock); today's served range (`trade-engine.js:447 weekDist`) is uncalibrated.
2. **Availability and its timing.** Our pooled path averages 0.694 on 5,963 startable undesignated rows that played 94.9% of the time (#164 TDD :212-217); the role-cell model on main fixes that (0.952) and is scored on 2025 (L079-L081). ESPN's retained number already zeroes 92% of Friday-Q/none scratches **at lock** (LOOP-LOG:3162, :3174: "92% describes lock, not T-90"); tonight's live week-3 snapshot: ESPN has 14/14 Doubtful, 17/18 Out, 5/5 day-to-day and 22/22 IR at 0 already on Wednesday, and 4/104 Questionable. So ESPN's nonzero number behaves as "conditional on playing" and ESPN 0 means "ruled out". Text is early where the numbers are late (RL-6: one fresh case, Dart; the app had the story and the parser dropped it).
3. **Two proven structured residuals.** qb_change −0.57 [−0.95, −0.19] and blowout_underdog_rb −0.66 [−1.23, −0.10], same sign 2021-24 (PR #222). Live caveat: PR #222's qb_change reads the starter from the game (post-kickoff) and `nfl_depth`'s weekly QB1 matches it on only 322 of 1,131 rows, so the probe's "pre-game qb_change is weaker" describes a stale source, not the spot. blowout_underdog_rb's input (spread ≥ +7, `game_lines`) is pre-game and it held in the probe (−0.58 / −0.48). **Note:** the spots were selected with "same sign in each of 2021-24", so 2021-24 is in-sample for them (§4).
4. **Line drift after ESPN posts.** Real, tiny (+0.0013). A lab feature, not an expert.

---

## 2. Decision times and knowledge time (new; the fix for the two "different clocks" blocks)

**Cuts.** Every expert row, the incumbent and every grade use the same cut, the latest row whose *call wall-clock* is ≤ the cut (EA-04's rule: a row written after its decision time is never graded). Pre-registered cuts per player-week:
| Cut | When | Nick's decision | Primary for |
|---|---|---|---|
| WED | Wednesday 12:00 PM ET | waivers, trade calls | reporting only |
| FRI | Friday 6:00 PM ET (after the final injury report) | his start/sit set | Q1 points (forward) |
| SUN-AM | 120 min before that player's kickoff (before inactives at T-90) | his last check | Q2 chance to play |
| LOCK | the player's kickoff | none (what the ESPN archive shows) | Q1 points on history |

**Stamps.** ESPN 2021-24 archive = `lock` (assumed; the archive has no per-week timestamp, PR #222), usable only at the LOCK cut. ESPN 2026 = the poller's `captured_at` (forward-only; `~/gridiron-local/rnd/loop/data/espn-flip-timing/` is empty tonight and no LaunchAgent, cron or process runs the poller, so every uncaptured week is lost as-of data). `league_roster_snapshots` weeks 1-2 of 2026 are `source='final'` rows first seen 2026-09-22T20:50Z, after the games (PK has no time column; rows are overwritten in place): **post-game, not as-of; they warm nothing and are never graded.** Consensus = the Friday scrape date (lab only). Vegas = `game_lines` implied total (close; lab only; live via `nfl_line_snapshots`). Injuries = `modified_at` when present, else capture time (`first_seen`), the architecture's rule. ESPN status is read live today and not stored as-of; the poller row carries it from now on, and no Q2 grade at a cut runs until the incumbent's inputs at that cut are captured.

**Knowledge time for text.** `news_items.published_at` is not knowledge time: 1,014 of 1,582 rows have no `ingested_at`, 568 have `published_at = updated_at` (updates overwrite it), 159 were updated after ingest, 412 were ingested more than 3 days after their `published_at` and 302 one to three days after, and the row is updated in place (the `nfl_blind_input_news_items_update` trigger fires). Rule: knowledge time = `max(published_at, ingested_at ?? created_at)`; any row with `updated_at > cut` is excluded from a pack at that cut; from EA-00 on, the body is snapshotted into the event at ingest. `nfl_news_signals` is append-only (UPDATE/DELETE triggers abort) with `created_at`; **that `created_at` is knowledge time and is why 2026 weeks 1-3 of typed signals can be graded today at $0.**

**Grading claim vs comparator.** "Beats ESPN" on anything is claimed only against an ESPN comparator at the same cut: for points, the archive at LOCK on history and the poller at FRI/LOCK forward; for chance to play, an ESPN-status/ESPN-zero based P(play) built from poller captures, forward-only. Against our own numbers the status line says "vs our old availability number".

---

## 3. The machine (simplified)

```
 OBSERVE (engine_events, as-of; knowledge time)      UNDERSTAND: one expert row per source, per player-week, stamped
 ├ ESPN archive (lock) / poller (captured_at) ──►  espn.week        (anchor; ESPN 0 = typed ruled_out)
 ├ Vegas lines (lab feature only)              ──►  (lab)
 ├ PR #222 blowout_underdog_rb (pre-game)      ──►  espn.week_corrected   (shadow shift)
 ├ our chain (PROJ-02 links)                   ──►  proj.week       (conditional on playing; shape + fallback)
 ├ role-cell availability (main, held write)   ──►  avail.p_play    (Q2 anchor)
 ├ typed news facts (nfl-news-signal.js + role enums) ─► reader.p_play, reader.role (shadow)
 └ Jev answers (JEV-01a, one calibrated logit)  ──►  jev.*           (shadow)
                                                          ▼
                     THE REFEREE (producer `referee`; reads grade.* and jev_cal.*; fetches nothing)
                       referee.weights  (one object row: {q1:{espn:1}, q2:{avail:1,...}} until a gate passes)
                       range.calib      (per position × phase ACI width; residual quantiles on played rows)
                       lab only: combiners A/B/C, cells, lockout check, consensus axis
                                                          ▼
 blenders read the weights ──► blend.week (mean = ESPN nonzero) · blend.p_play (served chance to play)
                               reason chain = b + Σ w_e (m_e − b), exact, cites event ids
                                                          ▼
 SIMULATE: sim applies blend.p_play ONCE per draw; PROJ-03-c applies range.calib → range.week (the only range pages show)
 DECIDE / ACT: lineup, waivers, Coach, status strip read the state
 LEARN: grader (EA-04) scores every expert and the incumbent at the SAME cut; Tuesday 6 AM ET weekly grade;
        weights move by PR; monitor (EA-05): losing → serve the anchor, labelled
```

### 3.1 The served point (Q1): ESPN, with the two paths ESPN cannot cover
- `blend.week`'s mean = ESPN's number **where ESPN is present, nonzero and fresh**, byte for byte (RED 1). Convention (from the week-3 snapshot and LOOP-LOG r10): ESPN's nonzero number is the mean **conditional on playing**; ESPN 0 for a designated player is the typed absence `ruled_out` (not a projection of 0 and not "missing"), which sets `avail`'s designation input; the DNP mass enters once, in the simulator, through `blend.p_play`. **No mixture on the mean.** Pre-registered check in META-01a: the ratio mean(actual | played) / mean(ESPN) on Questionable rows vs undesignated rows, 2021-24; if ESPN discounts Questionable rows by more than 5 points of ratio, the conditional mean is ESPN divided by that per-designation discount (fit walk-forward), else ESPN as-is.
- **Anchor-missing path** (free agents: the 2026 capture covers rostered players only, `espnWeekProjections` reads `on_roster = 1` on #164; and any player with no capture): serve ours (`proj.week` × the game factor), labelled `anchor_missing`, as today.
- **Anchor-stale path** (capture older than `maxAgeSec`): serve the last good ESPN row labelled "stale, N h old"; never re-weight onto the experts that lost to ESPN in every test. `fallbackField` = `proj.week` only for the missing case.
- Today's served weekly number is ours, not ESPN's (#164's four `SERVING_HOLDS`: `waiver_ungraded`, `espn_zero_reads_as_missing`, `labels_describe_ours`, `s03_identity`). The ours → ESPN flip is its own labelled promotion with BLEND-01's grade report (0.6830 vs 0.6359) and 4 forward weeks in the preview lane; it is a dependency of Tier A, not a side effect of turning the Referee on.
- Scoring: ESPN projects in its own scoring; the league's `scoringKey` is applied last (two distinct scoring sets across the 5 leagues).

### 3.2 Chance to play (Q2): ship the validated fix, then grade the readers against ESPN at the same cut
- **Anchor and incumbent = the role-cell model** on main (`contingency.js:686-700`, report status × practice status × position × tier × gap; fit 2021-24, selected on 2024, scored once on 2025: log loss 0.551 → 0.396, ECE 0.074 → 0.017, healthy starters 0.708 → 0.952; `play-chance-live.tdd.md` run 3 G1-G4 PASS; HOLDOUT-LEDGER L079/L080/L081, rate write held). The local DB has `nfl_availability_rates` (139 rows) and no `nfl_availability_role_rates`, so the legacy 0.694 path is what runs today. **Shipping the rate write is not a Referee win; it is an existing validated fix.** 2025 is spent for this model family (scored three times).
- **Served field = `blend.p_play`** (written by `avail-blend`, EA-08) with `avail.p_play` as its `fallbackField`. The DAG is amended so `sim`, `lineup` and `waivers` read `blend.p_play` from EA-08 on (today they read `avail.p_play`, ENGINE-ARCHITECTURE :376/:381/:382, and only the blenders write `blend.p_play` :379, so a better P(plays) would change no call). The sim applies it once per draw (:201). One chance-to-play number per player.
- **Experts:** the role-cell model (anchor); the ESPN comparator (ESPN status / ESPN zero from poller captures, forward-only); `reader.p_play` (T); Jev `plays_sunday` (T', averaged into one calibrated logit; the Claude arm shares the reader's source tag). The v1 "practice-status transition model" is dropped: `nfl_injuries` has one row per player-week (PK `(season, week, gsis_id)`; 22,200 rows = 22,200 player-weeks for 2021-24) holding the final practice status only, which the role-cell model already uses. The durability prior (CE-03) is multi-week and stays with CE-03.
- **Primary cut SUN-AM**; FRI and LOCK reported. Population: Questionable/Doubtful skill players league-wide (all positions pooled, all five leagues' rostered players included, not only them): 29.9 a week in 2023, 27.0 in 2024, 12 and 15 in 2026 weeks 1-2 (measured). Out is near-deterministic (critic-measured 0% played; Doubtful 0.8%). So the informative set is ~15-30 rows a week and the verdict is late (§4.2).

### 3.3 The range: one range, inside the one simulator
- `range.calib` = per position × phase (weeks 2-9 / 10-17) residual quantiles of **played rows** on ESPN's conditional number, from seasons before the graded one, plus one adaptive-conformal width parameter per cell (Gibbs & Candès 2021) tracked live so 80% coverage holds through non-exchangeable weeks. The DNP mass is `blend.p_play`, applied once by the sim, so no-shows are counted once (v1's residual quantiles included DNP = 0 rows *and* mixed a p_zero: double counting).
- **Pages show exactly one range:** `range.week`, the simulator's draw pool on the fixed grid (ENGINE-ARCHITECTURE :420 "the page always shows `range.week`"). PROJ-03-c applies `range.calib` inside the sim before anything is served; `blend.week` carries no rendered grid. Until PROJ-03-c lands, nothing about the served range changes and the design has no second range.
- Coverage is a target checked weekly, not a guarantee. The cell's ACI width is the one number the HEALTH-01 benchmark guard watches. Labelled "calibrated at lock" until forward coverage at FRI/LOCK exists.

### 3.4 Structured corrections (M')
`espn.week_corrected` = ESPN + blowout_underdog_rb (RB, team spread ≥ +7 at the cut), a shadow shift written by PROJ-01-b's producer, graded on ESPN's residual at FRI and LOCK. qb_change is **parked** until a pre-kickoff starter source exists (a real one: an append-only capture of the team's announced starter, or the poller's ESPN QB projection flip); `nfl_depth` is not it. RED: the JS flag equals `probe_assemble.py`'s flag on a fixture week.

### 3.5 The reader: typed facts with an evidence span, at knowledge time, as a queued stage
- **What it is:** an extension of the existing typed extractor `nfl-news-signal.js` (prompt: "Do not output a projection, probability, point impact… Return [] when the text is ambiguous"; `evidence_span` must be a verbatim substring; `unavailable_probability = values[status]`; `news-fantasy-impact.js:88` already turns signals into `reportedActive`). **Not a third LLM reader** beside it and `nfl-news-events.js`. Output enums: `status ∈ {out, doubtful, questionable_trending_up, questionable_trending_down, full_practice, expected_to_play, not_expected, gtd, none}` × `basis ∈ {official, beat, rumor}`; `role ∈ {down, same, up}` × basis; each with `evidence_span`, `knowledge_time`, `news_id`. No free-form p_plays, delta_pts, severity or confidence numbers (v1's five uncalibrated numbers needing five forward maps on ~26 rows a week are gone).
- **Enum → probability:** official-status enums map through the role-cell model (that *is* the 2021-24 designation × outcome map; a warm start). Text-only enums (trending, expected_to_play, not_expected) enter as **one global logit shift each**, learned forward only (§3.7), so a new information type is never held near zero by pooled shrinkage.
- **Where it enters:** `reader.p_play` = the role-cell probability shifted by the text enums (shadow); `reader.role` (shadow) is an expert for points only after it earns weight. **The argument tilt is dropped:** penalising ESPN for "stale before news" moves weight to experts that are equally stale and hold none of the news; the only expert holding the news is the reader itself. Text enters as an additive, pre-registered structured correction graded on ESPN's residual at a fixed cut, the way the Mistake Map does.
- **Text-only subset, mechanically:** a row is `text_only` when a fact's knowledge time is later than the as_of of every numeric input at that cut (ESPN status and projection capture, `nfl_injuries` as_of) **and** its extracted status differs from the numeric designation. The LLM's own "this is new" flag is a logged feature, never the subset (v1 let the graded party pick its own evaluation rows).
- **Trigger and cost:** only on a new text item by body hash and knowledge time (an in-place update counts as new only if the body hash changed); never on official-status events (structured inactives need no LLM); never on "disagreement" alone (no text to read). Deduped per player per cut. Runs as a queued heavy stage (child process, like `jev/stage`), because EA-02's per-event learner budget is 2 s and a Haiku call on a 3-7k-token pack routinely exceeds it; an intent/result event pair `reader.call` with `payload.model`, so replay needs no paid call and a restart pays nothing twice. A `referee` daily budget default in `llm-budget.js` (proposed $1/day, Nick approves the figure; today `DEFAULT_DAILY_BUDGETS_USD = {coach: 1.00, trade_proposals: 0.50}` and an unlisted feature has **no budget at all**, so v1's "under the in-app cap" was false), plus JEV-01a's runaway rules (calls/hour > 5× the trailing median; the same prompt hash > 3 times in 10 min). On refusal or a 401: health `stale`, typed status `llm_unavailable` (distinct from `no_text`), the fallback labelled. Today the refresh process's extraction has failed 29 consecutive runs with `401 invalid x-api-key` (`sync_log` job `nfl_news_signals`, last run 22:34Z), so the shadow log is currently empty of new signals until the key is fixed; a health check on the daemon's key is part of META-01d.
- **Grading, forward-only, at the SUN-AM cut** (never a paid back-grade on 2023-24: the model knows those seasons): `reader.p_play` vs the role-cell incumbent **and** vs the ESPN comparator on `nfl_snaps > 0`, log loss and Brier, two-way CIs, lift counted on `text_only` rows and reported on all rows (lift elsewhere is a red flag). `reader.role` vs the share change in `player_week_usage` vs the prior 3 weeks (JEV-01b's rule). Calibration slope per enum published as a curve. **2026 weeks 1-3 of `nfl_news_signals` are graded first, today, at $0** (`created_at` is knowledge time; 395 rows since 2026-09-03).
- **Warm-start limit:** no 2021-24 text on this Mac. The reader starts at weight 0 and earns forward.

### 3.6 Jev
JEV-01a's arms (≥ 2 phrasings + the Claude cross-check) are averaged into one calibrated logit per question type (ENGINE-ARCHITECTURE :528) and enter as one expert; the Claude arm and the reader carry the same source tag and are shrunk together. Contamination beyond the pack is guarded by the cut rule (a call whose wall-clock is after the cut is never graded), not by a gateway field (the gateway returns typed answers and token usage only, JEV-01a fact 1). JEV-01b (3)'s learned stack over {calibrated arms, incumbent} **is** the Referee's Q2/Q4 instantiation: one module, weights only for volume question types.

### 3.7 Admitting and weighting experts (the "nothing locked out" rules, testable)
- **Admission of a numeric expert into a served blend:** an out-of-sample forecast-encompassing test, walk-forward: regress `y − ESPN` on `expert − ESPN` in held-out weeks (2023, then 2024), two-way (player, week) clustered 90% CI on the slope clear of 0 in both seasons, computed only on rows where the expert is present. Passing admits the expert to the lab combiners; serving still needs §4.3.
- **New forward-only experts (reader enums, Jev, any HYPO-01b survivor):** no cells, no pooled shrinkage `k`; one global parameter per question, pre-registered, graded on the anytime-valid sequence, promoted by PR. Each scorecard shows the effect size detectable this season next to the status ("weight 0: not enough data yet, needs ≈ N more weeks").
- **Alpha budget:** one family-wise rule for all forward-only candidates in 2026 (e-value Bonferroni across the registered candidates), and at most 3 forward-graded experts per question.
- **Calibration:** every stated width or confidence goes through an isotonic map on PIT (Platt below n = 200) fit walk-forward; the raw value is a gate feature only.
- **Lockout check (nightly, lab; on the spine once combiners exist):** an expert < 0.02 in the champion and > 0.10 in any challenger raises `referee.lockout_check` naming both weights; nothing is deleted.

### 3.8 The lab (META-01a) keeps the machinery the data does not yet support in production
Combiners A (ESPN-prior shrunk pool), B (Hedge with fixed share), C (quantile stacking), the pre-registered cells, the consensus-disagreement axis (missing consensus = its own `missing` cell, never a gap of 0), the residual-covariance table and the lockout check all run in the lab on every expert every week, at $0. They move into production only when an expert with an as-of stamp shows forward lift and the encompassing test passes. This keeps Nick's "several techniques side by side" without 768 cells × 3 combiners × ACI × β chasing noise on ~10k rows (the probe: Hedge = ESPN 1.000 everywhere; STACK changed no decision; oracle bound +0.0036 / +0.0016).

### 3.9 Learning cadence
- **Weekly grade: Tuesday ~6 AM ET** (after MNF), on `outcome.player_week` events with `stat_version`; a deadline check fails loudly if no new grade rows exist by Thursday 12 PM ET (a "Monday" hook would grade before MNF and before stat corrections).
- **Weights are code constants moved by PR** with the grade report (ENGINE-ARCHITECTURE §6.2: nothing at runtime moves a version). There is no `referee.champion.<q>` pointer (v1's was a runtime version switch, which §6.2 forbids); the champion is `VERSIONS.active`, shown by `/api/engine/status`.
- **History constants stay frozen;** the weekly refit uses only 2026 forward rows on top of them (the 2021-24 expert inputs exist only as local files read by the Python lab). The lab code is committed under `docs/evidence/<date>/` minus per-player FP rows; RED parity: the JS range producer, fed the lab's frozen inputs for one 2024 week, reproduces the lab's quantiles to 1e-6.
- **Loss = the proper score on raw outcomes** (quantile score for distributions, log loss for probabilities). PROJ-04-a's luck split is reporting and a pre-registered challenger rule only; v1's "update on the non-luck part" made the weights depend on another model and stop minimising the score on real outcomes.
- **Bounded step** stays: no served weight moves more than δ = 0.05 per promotion PR without a stated reason.

### 3.10 On the spine: fields, one writer, reason chain, RED tests
- **Producer `referee`** (= the architecture's `blend-learner`, layer 7) registers **literal** fields (#216's grep test requires literal field and producer strings): `referee.weights` (valueType `object`, entity `engine:referee`, one row keyed inside by question), `range.calib` (`object`, entity `engine:referee`, per position × phase). Events: `referee.lockout_check`. It reads through `ctx.read.state` (EA-00), reads `grade.<producer@version>.<field>` and `jev_cal.*` for every scorecard (v1's `referee.expert.*` duplicated the grader's rows: dropped), fetches nothing, runs in the daemon.
- **Producer `reader`:** fields `reader.p_play` (prob, player_week, lane shadow), `reader.role` (choice + p, shadow); events `reader.call` (intent/result). One text → availability producer (today's `nfl_news_signals` writer becomes its adapter).
- **Blenders stay the writers of served numbers:** `weekly-blend` → `blend.week`; `avail-blend` → `blend.p_play`; `accept-blend` → `blend.p_accept` (EA-07 / EA-08 files; META-01c waits for EA-08 or carves the blender files out of it). They read `referee.weights` and never re-blend. `range.week` stays the simulator's; PROJ-03-c applies `range.calib`.
- **Reason chain = exact attribution** (§2.10): baseline `b` = the anchor's value, contributions `w_e (m_e − b)` with `state_ids` and the expert's `event_ids`, the reader's line with its evidence span's event id; `residual` 0. Coach turns it into words; `verify.js` refuses any number not in a cited row. Health checks (HEALTH-01a) run on the conditional mean (the envelope check) and separately on the sim's unconditional mean ∈ [0, max expert].
- **No `cons.week` and no consensus axis in production** (FantasyPros is internal-only by ruling; a per-player state row would reach `/api/engine/state`, `ReasonChain` and Coach; and there is no live 2026 feed). If it ever returns it needs an `internal:true` field flag that views, the route, `ReasonChain` and Coach refuse to expand, shown only as an aggregate "other sources" line.
- **Before EA-07/EA-08:** the only pre-spine hooks are `weekly-blend.js:67 CANDIDATES` + a `SERVING_HOLDS` entry, `weeklyAvailability`'s designation source (`contingency.js:934`) and `ACCEPTANCE_SOURCES` with `zero:['referee']`. No third path.
- **RED tests (not statistical):**
  1. with `referee.weights.q1 = {espn: 1}`, `blend.week`'s mean is byte-identical to ESPN's nonzero number in all 5 leagues (the #164 `round2/dump.mjs` test); a designated player with ESPN 0 gets typed `ruled_out` and a labelled fallback, never a served 0; the sim's unconditional mean equals `blend.week` × `blend.p_play` to 1e-9 (applied once).
  2. contributions sum to the shift to 1e-6 in the declared space.
  3. knowledge-time leak: a backfilled item (`published_at` 5 days before `ingested_at`) and an in-place-updated item (`updated_at > cut`) are both excluded from the pack at that cut; every cited id's ingest time ≤ as_of; a reader row whose call wall-clock is after the cut is never graded.
  4. grep: `blend.week` / `blend.p_play` weights are read only from `referee.weights`; a second writer's insert is refused by the trigger; from EA-08 on, no served producer reads `avail.p_play` except as `blend.p_play`'s fallback.
  5. a `stale`/`failed` expert → weight 0 with a monitor contribution; anchor-stale → the last good ESPN labelled "stale, N h old"; anchor-missing → ours labelled `anchor_missing`.
  6. the lockout fixture (0.01 in the champion, 0.2 in B) raises exactly one event (lab).
  7. parity: the JS range producer reproduces the lab's quantiles for one 2024 week to 1e-6.
  8. no real person's name in any reader or Jev payload (grep against the roster names).
  9. the JS `blowout_underdog_rb` flag equals `probe_assemble.py`'s on a fixture week.
  10. an official-status event makes no LLM call; the same body hash within a cut makes one call; a budget refusal or 401 writes `llm_unavailable`, not `no_text`.
  11. the weekly hook fails loudly when no grade rows exist by Thursday 12 PM ET.

### 3.11 Cost and latency
Lab: under 5 s per season (measured). Reader: Haiku, ~3-7k tokens × ~300-700 calls a week ≈ $1-4/week (guess) under a `referee` daily budget; Sonnet on disagreement rows only if Nick approves. Jev: no cap, logged, runaway alert. No historical paid calls. Tests never hit the network.

---

## 4. Pre-registered ship bar (committed and hashed in a draft PR before any lab metric runs)

**Common rules.** Walk-forward fit 2021-22 → test 2023 → refit → test 2024, graded separately. **One inference rule for every META-01 CI:** `gradeDecisions`' two-way (player, week) pigeonhole bootstrap at 90% with t(G−1) critical values, G = weeks (v1 cited two rules and the probe's 16-cluster percentile bootstrap under-covers). Cluster floors ≥ 4 weeks and ≥ 20 entities. **In-sample statement:** the PR #222 spots were selected on 2021-24 and v1's §1.3 was fit on the graded seasons and drove design choices, so 2023-24 are not clean tests for the spots or for any cell claim; **2025 is spent** for the weekly-distribution family (L002, L012, L067/L068) and for the availability family (L079-L081). Therefore **the confirmation of record for anything that changes a served number is forward 2026** through EA-04's grader on the anytime-valid sequence; a 2025 look is logged as a repeat where the family already used 2025, and as a single one-look for the spot (rule: the pooled 2021-25 BH-adjusted CI still excludes 0 after adding 2025 AND the 2025 sign matches; "direction holds" alone is not a test, a null holds its sign half the time). Any fail = held, served as the anchor, logged as a result. Every claim names its cut (§2).

### 4.1 The range (`range.calib` → `range.week`)
PASS if, pooled over 2023+2024 at LOCK on the **served population** (#164's startable universe including bench and free agents by ESPN rank bucket, with scratches included via the prior week's retained projection ≥ 5 rule; weeks 1 and 18 reported separately; each of the two scoring keys): in every position × phase cell (8 cells, all n ≥ 200), |coverage − nominal| ≤ 0.03 at the 10 / 50 / 90 levels with randomized PIT for ties and the DNP mass; the Questionable cell reported separately; quantile score not worse than the baseline "ESPN + per-position residual quantiles" (3.995 / 4.011 on the probe grid) by more than +0.01 (upper bound of the two-way CI). KS p > 0.05 is dropped (a failure-to-reject rule that passes small cells automatically and can fail a correct baseline on a discrete, zero-inflated outcome). Live: ACI keeps trailing-8-week coverage in [0.74, 0.86]; the verdict of record is 4 forward graded weeks at FRI and LOCK.

### 4.2 Chance to play (`blend.p_play`)
The role-cell model ships on its existing gates (nothing new to test). Any expert (ESPN comparator, reader enums, Jev) earns weight only by **superiority**: log loss and Brier vs the role-cell incumbent, two-way 90% CI below 0, at the SUN-AM cut, on the Q/D population (§3.2), lift counted on `text_only` rows; and the status line may say "beats ESPN" only when the same holds vs the ESPN comparator at the same cut. Power (pre-registered in META-01a as a calculation on Q-designated skill rows, ~15-30 a week, week-clustered): the verdict lands around week 12-14 at best; until then the reader is shown as an opinion with its evidence span, never a number.

### 4.3 Points served over ESPN (`blend.week` mean ≠ ESPN)
A challenger PASSES only if in BOTH 2023 and 2024 at LOCK (numeric) or on the forward sequence at FRI (text, ≥ 6 graded weeks, ≥ 20 players): decision win rate vs "start ESPN's higher number" CI low > 0.5 AND points per decision CI low > 0 AND quantile-score diff CI high < 0 AND coverage inside the §4.1 band; non-inferiority per position (no cell worse by more than the MDE ≈ 0.010). Decisions: DNP scored 0 and included (v1's pairs required both players to play, which excluded exactly the rows text and P(plays) would win); primary population on history = #164's startable universe at both scoring keys; forward = Nick's real starter-vs-bench decisions from SELF-01a's ledger; the all-pairs top-N grid is secondary. Power for text: the count of `text_only` rows per week is measured on 2026 weeks 3-4 first, then the number of weeks needed to detect a 0.55 win rate is stated; v1's "~100 decisions a week" counted every decision, not the text-only ones.

### 4.4 P(accept) (`blend.p_accept`)
Undecidable in 2026 (~20 decided offers a week; 37 labelled decisions; 14 outcome rows). Served = `acceptanceBand`; shadow only; no ship bar this season.

### 4.5 Level recalibration of the mean (STACK's −0.065 MAE)
Repeatable, changes no decision; a shadow challenger for the mean with its own bar (MAE better in 2023 and 2024 and forward; sim matchup log loss and `range.week` coverage not worse).

---

## 5. Expected gains (honest)

| Question | Expected gain (2026) | Why | What would make it fail / how we'd know |
|---|---|---|---|
| Points, start/sit vs ESPN | ≈ 0 from numeric experts (measured); text upside unknown, measured on `text_only` rows | the experts' errors share ESPN's; ESPN contains most of C and K | no text lift on `text_only` rows; the FRI/LOCK gap shows the archive flattered ESPN |
| Range | from uncalibrated to a checked 80% band on every player; the biggest visible change | ESPN has no distribution; residual quantiles hit 0.81 / 0.80 at lock | the served-population re-grade fails a cell (then that cell serves the pooled band, labelled) |
| Chance to play | the 0.694 → 0.952 fix on healthy starters (an existing validated fix, not a Referee win); text on surprise scratches | availability is where the numbers are late | the reader is a stale-news echo (weight stays 0, and the scorecard says why) |
| ROS value | ~0 over FantasyCalc; stops a worse own number | FC ties ECR; AI-01 declined | none to decide |
| P(accept) | none decidable | ~20 offers a week | it "wins" in shadow on 40 rows and someone serves it: the floor forbids it |
| Attribution / lockout | qualitative: every number says who moved it; no silent drop | the chain is arithmetic | a page or Coach recomputes a blend (grep); an unlabelled fallback (RED 5) |

---

## 6. Build units (ENGINE-SPECS row style), launch order

| id | goal | metric | baseline | target / kill | files | dont_touch | deps |
|---|---|---|---|---|---|---|---|
| **META-01a** lab + prereg (script only, ~1 day) | Prereg + sha256 committed in a draft PR **first**; then the lab extends the probe: served-population rows with scratches, played-row residual quantiles + ACI per position × phase, the ESPN-discount check on Questionable rows, the encompassing test per numeric expert, blowout_underdog_rb pre-game flag, the Q2 power calculation, the reader enum map from the role-cell model, combiners A/B/C + cells + lockout check (lab), two-way CIs everywhere | §4.1 band per cell; encompassing slopes with CIs; power table; expert scorecards | ESPN MAE 5.725 / 5.748, quantile score 3.995 / 4.011, coverage 0.810 / 0.801 (top-N, lock) | **KILL:** a range cell outside the band → that cell serves the pooled band, labelled; no numeric expert passes encompassing (expected) → production has no combiner; blowout_underdog_rb sign flips in either season → parked with qb_change | `~/gridiron-local/rnd/meta/referee-lab.py` (extends `probe_assemble.py` / `probe_grade.py`; aggregates only); `docs/evidence/<date>/meta-01-preregistration.md` + `.sha256` (draft PR); lab code copied under `docs/evidence/<date>/` minus FP rows | every served module; `~/gridiron-local/data.sqlite` (use `.backup`); 2025 except the single spot look | none (starts now) |
| **META-01b** as-of capture, today (local scripts, ~0.5 day) | Run `scripts/rnd/espn-projection-poller.mjs` on a schedule (every 10 min on game days, hourly otherwise) appending JSONL under `rnd/loop/data/espn-flip-timing/`; grade `nfl_news_signals` 2026 weeks 1-3 at the SUN-AM cut by `created_at` ($0) and keep that shadow log running; both count as forward evidence later | rows captured per week with `captured_at < kickoff`; signal rows graded per week | empty dir tonight; 395 signals, extractor failing 401 | **RED only:** every capture has `captured_at` < that player's kickoff; a re-run appends and never rewrites; the week-3 file is non-empty by Thursday night; the grade script refuses a signal whose `created_at` > cut | poller (exists), `scripts/rnd/grade-news-signals.mjs` (new, local) | the DB; the repo's served code | a scheduled job (a launch, needs the coordinator or Nick); the Claude key fix (Nick) |
| **META-01c** the Referee producer on the spine, shadow (~1.5 days) | `referee` producer: `referee.weights` (anchor-only at start), `range.calib` (from -a's constants with `params_hash`), scorecards read from `grade.*`, `referee.lockout_check`; blenders read `referee.weights`; reason chain = attribution; anchor-missing and anchor-stale paths | RED 1, 2, 4, 5, 7, 9 of §3.10 | n/a (RED) | all RED pass; shadow rows graded by EA-04 from the first forward week | `server/services/engine/producers/referee/{experts,range,producer}.js` (new), `producers/weekly-blend.js` (EA-07), `producers/avail-blend.js` (EA-08, or carved out), `test/meta-01c-*.test.js` | `season-sim.js`, `trade-engine.js`, routes, client; no migration | EA-00, EA-02, EA-04, EA-07; EA-08 for the blender files; PROJ-01-b for `espn.week_corrected` |
| **META-01d** the reader stage, shadow (~1 day) | `reader` stage over `nfl-news-signal.js`'s extractor (+ role enums), knowledge-time packs, `reader.call` intent/result events, per-player-per-cut dedupe, `referee` budget + runaway rules, `llm_unavailable` status, a key health check; `reader.p_play` / `reader.role` graded forward at SUN-AM vs the incumbent and the ESPN comparator; Jev enters through JEV-01a's averaged logit | reader log loss / Brier vs both comparators on `text_only` rows; calibration slope per enum | role-cell incumbent; ESPN comparator | shadow; weight leaves 0 only on §4.2 superiority | `server/services/engine/producers/reader.js` (new), `nfl-news-signal.js` (extend enums; the writer becomes an adapter), `llm-budget.js:43` (`referee` default), `test/meta-01d-*.test.js` (stubbed client) | `claude.js` (call, do not edit), chat store, 2023-24 (no paid back-grade) | META-01c; EA-08 (Jev stage) for the Jev arm (ships without it) |
| **META-01e** serve what the past validated (~1.5 days) | (1) lift #164's four holds and flip the served point to ESPN as a labelled promotion (BLEND-01's grade report; 4 forward weeks in the preview lane first); (2) the role-cell rate write (`play-chance-live.tdd.md` §6); (3) amend EA-06 / EA-11b so `sim`, `lineup`, `waivers` read `blend.p_play` (fallback `avail.p_play`); (4) status strip "points: ESPN; range: calibrated at lock (cov 0.80, n=…); chance to play: role-cell; reader: shadow, needs ≈ N weeks" | RED 1, 5, 11; the 4 hold lifts' own tests; L081's gate re-run reproduces 0.396 | ours (0.6359); pooled path (0.694) | served point = ESPN in all leagues; chance to play = role-cell | `weekly-blend.js:133` (#164), `lineup-brain.js` (0 = a projection), `contingency.js` rate write, EA-03 strip, BENCHMARKS.md rows | `season-sim.js` beyond the input switch | Nick's OK on the anchor flip; #164 merged; EA-07 for the spine path (the pre-spine hooks otherwise) |
| **META-01f** the weekly grade hook (~0.5 day) | Tuesday 6 AM ET grade on `outcome.player_week` with `stat_version`; ACI width update; forward-only refit on 2026 rows over frozen history constants; the Thursday-noon deadline check; promotion by PR via `check-promotion.mjs` | RED 11; replay 2023-24: online ACI not worse than frozen on coverage | frozen META-01a constants | non-inferior | `producers/referee/learn.js`, EA-02 weekly hook registration | `week-postmortem.js` (PROJ-04-a) | META-01c; EA-02; EA-05 (monitor) |

Total ≈ 6 agent-days; -a and -b start now (no spine); -c/-d/-f wait for EA-04; -e is partly pre-spine (the hold lifts and the rate write) and partly EA-06/EA-11b. Replayed 2026 rows are labelled `history`, never `forward`.

### What this replaces or amends in ENGINE-SPECS.md
- **Replaces BLEND-02** (the stacker): its cells and disagreement feature live in the META-01a lab; nothing stacks the served point until §4.3 passes; `vegasLift`'s retirement moves to META-01c's expert table. BLEND-02's row is closed.
- **Replaces JEV-01b (3)** (the learned stack): that stack is the Referee's Q2/Q4 instantiation (one module). JEV-01b (1)-(2) stand under EA-04's grader. **Amends JEV-01c:** `jev_weight.<qtype>` is read from `referee.weights`; the status text comes from `/api/engine/status` (no champion pointer).
- **Replaces PROJ-04-b** (weekly online reweighting of BLEND-02's weights) with META-01f; PROJ-04-a stays a reporting input, never the weight loss.
- **Amends PROJ-01-b:** `espn_corrected` = `espn.week_corrected` (blowout_underdog_rb only, pre-game; qb_change parked until a pre-kickoff starter source exists). **Amends PROJ-01-c:** lab only, aggregates only, still R&D until the licence ruling.
- **Amends EA-06 / EA-11b:** `sim`, `lineup`, `waivers` read `blend.p_play` (fallback `avail.p_play`) from EA-08 on. **Amends EA-07 / EA-08:** `blend.week`'s mean is ESPN's conditional number; the blenders read `referee.weights`; `range.week` applies `range.calib` through PROJ-03-c.
- **Amends EA-05:** the Referee's fields join the monitor with the fallbacks in §3.1-3.2.
- **Leaves alone:** PROJ-00, PROJ-02, PROJ-03-a/b, CE-03, CE-09, CLONE-01, TELLS-01, RADAR, CHESS, HYPO-01 (a survivor becomes a shadow expert here, nothing more).

---

## 7. Probe result (verbatim, from the META-01 workflow's historical probe, 2026-09-23 ~7:00-7:40 PM ET)

No combiner beat ESPN alone. All five challengers fail the pre-registered ship rule in both 2023 and 2024.

Setup: walk-forward on weeks 2-17, the top-N players by ESPN projection at each position, 2,496 rows per season. The prereg was hashed before any metric ran (`c79c58ad…`). 95% CIs are week-cluster bootstrap.

| Combiner | Season | MAE (diff vs ESPN) | CRPS (diff vs ESPN) | 80% cov | Decisions | Win rate vs ESPN pick [CI] | Pts/decision [CI] |
|---|---|---|---|---|---|---|---|
| ESPN | 2023 | 5.725 | 3.995 | 0.810 | – | – | – |
| EQ (ESPN+cons)/2 | 2023 | 6.157 (+0.431 [+0.347,+0.511]) | 4.119 (+0.124 [+0.080,+0.162]) | 0.815 | 2026 | 0.462 [0.419,0.505] | -0.89 [-1.89,+0.11] |
| HEDGE | 2023 | 5.725 (0.000) | 3.996 (+0.002) | 0.813 | 0 | – | – |
| STACK | 2023 | 5.660 (-0.065 [-0.104,-0.023]) | 4.002 (+0.007 [-0.005,+0.019]) | 0.807 | 1933 | 0.491 [0.463,0.518] | -0.21 [-0.88,+0.48] |
| HEDGE+MM | 2023 | 5.723 (-0.003) | 3.998 (+0.003) | 0.812 | 346 | 0.506 [0.470,0.542] | -0.70 [-1.35,-0.02] |
| EG (secondary) | 2023 | 5.722 (-0.003) | 4.002 (+0.007) | 0.812 | 930 | 0.494 [0.455,0.534] | +0.03 [-0.76,+0.75] |
| ESPN | 2024 | 5.748 | 4.011 | 0.801 | – | – | – |
| EQ | 2024 | 5.961 (+0.213 [+0.125,+0.308]) | 4.084 (+0.073 [+0.027,+0.117]) | 0.822 | 1986 | 0.507 [0.471,0.541] | +0.05 [-0.72,+0.79] |
| HEDGE | 2024 | 5.748 (0.000) | 4.012 (+0.001) | 0.803 | 0 | – | – |
| STACK | 2024 | 5.682 (-0.066 [-0.100,-0.034]) | 4.002 (-0.009 [-0.022,+0.003]) | 0.800 | 1791 | 0.504 [0.469,0.544] | -0.05 [-0.75,+0.67] |
| HEDGE+MM | 2024 | 5.737 (-0.011 [-0.016,-0.006]) | 4.010 (-0.002) | 0.803 | 312 | 0.545 [0.500,0.581] | +0.68 [-0.29,+1.60] |
| EG (secondary) | 2024 | 5.764 (+0.016) | 4.019 (+0.007) | 0.800 | 547 | 0.484 [0.439,0.538] | -0.60 [-1.82,+1.04] |

**Near-tie subset (|ESPN gap| < 1.5):** almost every disagreement is a near-tie. Win rates there are 0.49-0.55 and every CI crosses 0.5.

**Controls pass:** the oracle wins 1.000 of its decisions (+7.1 points each) in both seasons; ESPN vs itself makes 0 decisions; no 2025 data was read.

**Hedge weights (eta 3, tuned on 2021-22 only):** end of 2023 and 2024: ESPN 1.000 at QB, RB, WR and TE; it collapsed onto ESPN by 2021 weeks 5-8 at QB, RB and WR, and by 2022 at TE. EG ended 2024 at QB 0.29 ESPN / 0.66 Vegas and RB 0.65 / 0.34, and gained nothing from it.

**Caveats (from the probe, now folded into §2 and §4):** the ESPN archive is untimed (lock assumed); pairs required both players to play; the population is top-N by ESPN (99% played) at full PPR; the CIs are 16-cluster percentile bootstraps; Mistake Map (+MM) used the pre-game depth-chart qb_change, which is a stale source; consensus is missing on 20% of 2024 rows and filled with ESPN.

Files: `/Users/nick_matta/gridiron-local/rnd/meta/` (probe-prereg.md, probe-prereg.sha256, probe.md, probe.json, probe_assemble.py, probe_grade.py, diag-bound.py, diag-bound.json). Nothing committed; the DB copy and the per-player rows file are deleted from scratch.

## 8. What was kept, grafted and dropped (for the record)
- **Kept from v1:** the ESPN prior (byte-identical at n = 0); every source scored every week and visible; the lockout check; the reader's rules (claims cite event ids; the numbers decide); P(accept) undecidable; the pre-spine hooks; forward-only LLM grading; apply league scoring last; capture ESPN as-of in 2026 (now a unit, today).
- **Changed by the critiques (§10):** no mixture on the mean; decision cuts; knowledge time; the role-cell anchor; typed-enum reader instead of free-form numbers; no argument tilt; no cells, no `k`, one global parameter and an alpha budget for new experts; combiners A/B/C in the lab only; no champion pointer; no `cons.week`; no `referee.expert.*`; `blend.p_play` served; one range on pages; raw-outcome loss; Tuesday grade; literal fields; the served-population range gate with a calibration band; two-way CIs; superiority for P(plays) vs an ESPN comparator; DNP in decisions; honest power and calendar.
- **Dropped as fatal or costly:** shrinkage toward 1/K; Normal(μ, sd) point experts; the per-week LLM "expert_quality" judge; five combiners × hierarchical cells; "guaranteed coverage"; regret bounds as a gain claim; the practice-status transition expert (no daily data); the correlation kill rule; the non-luck weight loss; the 2026 week 1-2 replay as a warm start.

## 9. Verification notes (tonight, on a fresh `.backup` copy, deleted after)
- `news_items`: 1,582 rows; `ingested_at` NULL on 1,014; `published_at = updated_at` on 568; `updated_at` after ingest on 159; ingested > 3 days after `published_at` 412, 1-3 days 302; update trigger `nfl_blind_input_news_items_update` present. `nfl_news_signals`: 395 rows 2026-09-03 → 09-23, `created_at`, append-only triggers `nfl_news_signals_no_update/no_delete`.
- `sync_log` job `nfl_news_signals`: `error`, 29 consecutive failures, `401 … invalid x-api-key`, last run 2026-09-23T22:34Z; `ai_usage` shows 6 `nfl-news-typed-extraction` rows since 9/22 with no cost.
- `league_roster_snapshots` 2026: week 1 753 rows `final` first seen 2026-09-22T20:50:40Z; week 2 757 `final` same; week 3 801 `live`. Week 3 skill rows by ESPN status: Questionable 104 (4 at 0), Doubtful 14 (14 at 0), Out 18 (17), IR 22 (22), day-to-day 5 (5), active 530 (0). Week 3 games 2026-09-24 → 09-28; week 4 10-01 → 10-05.
- `nfl_injuries` PK `(season, week, gsis_id)`; practice_status values Full / Did Not / Limited only; Questionable+Doubtful skill rows per week 29.9 (2023), 27.0 (2024), 12 and 15 (2026 wk 1-2). Played rates by status are critic-measured (Out 0%, Doubtful 0.8%); `nfl_snaps` keys by name, not re-run.
- Tables: `nfl_availability_rates` 139 rows; no `nfl_availability_role_rates` (the role path's DDL exists at `contingency.js:167`). `nfl_depth` 2026: 8,913 rows through week 3.
- Poller: `rnd/loop/data/espn-flip-timing/` empty; `launchctl list` shows only `com.gridironhq.launcher`, `launcher-tunnel`, `nightly-backup`; no cron; no poller process.
- Code: `contingency.js:686-700` roleCell (log loss 0.551 → 0.396 comment; :236 `weekDesignation`; :673 `playerActiveProbability`; :934 `weeklyAvailability`); `play-chance-live.tdd.md` runs 1-3, run 3 G1-G4 PASS, "2025 scored three times"; HOLDOUT-LEDGER 160 rows, L002/L012/L063/L067/L068/L079/L080/L081 as cited; `nfl-news-signal.js` typed extractor (evidence_span, unavailable_probability, extractor_version); `news-fantasy-impact.js:88` reportedActive; `llm-budget.js:43` defaults, `:140` "no budget at all", `:220` `source:'none'`; `claude.js` getApiKey env-first; `trade-engine.js:447 weekDist`; `gates/baseline-gate.js` pigeonhole two-way 90% CI + MDE80; #216 `test/engine-spine.test.js:181-193` literal `registerField` rule; #164 `weekly-blend.js:133-157` four holds, `:193-200` `on_roster = 1`; #164 TDD :212-217 (0.694, 94.9%, +0.0116, ESPN +0.0354); #222 body (sign rule, untimed archive, `nfl_depth` 322/1,131); #218 files (pbp, participation, ESPN 2025, licence gate; no ESPN-archive adapter); ENGINE-ARCHITECTURE :201 (p_play once), :376/:379/:381/:382 (DAG readers), :420 (one range), :453 (no runtime version switch), :502 (grade rows), :528 (Jev arms averaged), :680 (`getState` lane default), :783 (A10). LOOP-LOG:3162/:3174 (92% at lock), :2016-2024 (RL-6 Dart).
- Not confirmed: the ESPN archive's per-week stamp (lock assumed); the exact `nfl_news_signals` created-within-1h share (critic-measured 322/395); every size in §6 is a guess.

---

## 10. Review log (three critiques, 43 findings; C1 = ML/statistics critique, C2 = small-data/AI-reader critique, C3 = engine-fit critique)

| id | severity | section | decision | reason / where it landed |
|---|---|---|---|---|
| C1-F1 | blocking | mixture ≠ ESPN at n = 0; p_zero double-counted; Q2 anchor | **accept** | §3.1 no mixture on the mean; ESPN nonzero = conditional mean, ESPN 0 = `ruled_out`; p_play once in the sim; residual quantiles on played rows; RED 1. Q2 anchor = the role-cell model (a calibrated designation-cell rate already built and validated) rather than a new base-rate table. The "divide ESPN by an implied P(play)" form is pre-registered as the fallback only if Questionable rows show a discount (week-3 snapshot: 4/104 Questionable at 0). |
| C1-F2 | blocking | no decision time; 2026 wk 1-2 replay post-game; qb_change source | **accept** | §2 cuts and stamps; the replay is dropped; qb_change parked until a pre-kickoff starter source exists. |
| C1-F3 | important | 2023-24 partly in-sample; 2025 spent; "direction holds" | **accept** | §4 common rules: in-sample statement; forward 2026 is the confirmation of record; the 2025 spot look uses a pooled-CI rule. |
| C1-F4 | important | P(plays) "wins" vs our broken number | **accept** | §3.2 incumbent renamed and replaced by the role-cell model; ESPN comparator at the same cut; superiority; strip text. |
| C1-F5 | important | decision test drops DNP; top-N; PPR only; two inference rules | **accept, one part changed** | §4.3: DNP scored 0; one inference (two-way pigeonhole 90%); both scoring keys. The roster-decision population is primary **forward** (SELF-01a's ledger); on history no 2023-24 roster data for these leagues exists locally, so #164's startable universe is primary there and the top-N grid secondary. |
| C1-F6 | important | ceiling overclaimed; correlation kill rule locks out experts | **accept** | §1.3 reworded (per-position linear-pool bound, ESPN fill); the kill rule is gone; admission by the encompassing test (§3.7). |
| C1-F7 | important | range gate untested cells; KS failure-to-reject; wrong population | **accept** | §4.1: 8 pooled cells all n ≥ 200; calibration band ≤ 0.03 at 10/50/90 with randomized PIT; served population with scratches; Questionable cell reported. (The hierarchical alternative is not needed once every cell reaches n.) |
| C1-F8 | important | CIs too narrow (16 clusters, no player dimension) | **accept** | §4 one inference rule: two-way pigeonhole with t(G−1). |
| C1-F9 | important | expected text gains unmeasured; power overstated | **accept** | §0 and §5 say ≈ 0 numeric, text unknown; `text_only` rows measured on weeks 3-4; decision date stated. |
| C1-F10 | minor | too many moving parts; ship the simple design | **accept** | §3 is that design; A/B/C, cells, lockout stay in the lab (§3.8). |
| C1-F11 | minor | non-luck loss depends on another model | **accept** | §3.9 raw-outcome proper scores; luck split = reporting + challenger rule. |
| C2-F1 | blocking | `published_at` is not knowledge time | **accept** | §2 knowledge time rule; body snapshot at ingest; RED 3 with the two fixtures. |
| C2-F2 | blocking | no common grading cut; reader can win for free after inactives | **accept, cuts chosen differently** | §2: WED / FRI / SUN-AM (T-120 before the player's kickoff) / LOCK with one primary per question; "Sat 12:00 ET" is not a cut because no decision of Nick's happens then and FRI + SUN-AM bracket it. Incumbent inputs captured per cut before any grade. |
| C2-F3 | blocking | Q2 incumbent is the broken pooled path; role-cell fix on main | **accept** | §3.2; the practice-status expert dropped; 2025 stated as spent; §0 calls it an existing fix. |
| C2-F4 | important | power off ~10×; verdict week 12-14 | **accept** | §3.2 population and counts re-measured; §4.2 power pre-registered; Nick told the date. |
| C2-F5 | important | reader should emit enums + evidence spans; fit the map on 2021-24 | **accept in part** | §3.5 enums and spans; official-status enums warm through the role-cell model; text-only enums have no 2021-24 labels and learn forward as one global shift each. |
| C2-F6 | important | `text_only_info` chosen by the graded LLM | **accept** | §3.5 mechanical definition. |
| C2-F7 | important | the argument tilt cannot carry text information | **accept** | §3.5 tilt dropped; text = additive structured correction graded on ESPN's residual at a fixed cut. Nick's "argument" lever survives as typed facts + evidence spans + the reason chain. |
| C2-F8 | important | shrinkage `k` and cells lock out a new information type | **accept** | §3.7 no cells, no `k`, one global parameter, detectable-effect size shown. |
| C2-F9 | important | warm-start numbers use ESPN's lock value; population flattered; poller not running | **accept** | §4.1 served population with scratches; Questionable cell; "calibrated at lock" label; META-01b starts the capture today. |
| C2-F10 | important | practice-status transition model has no Mon-Fri data | **accept** | dropped (§3.2). |
| C2-F11 | important | per-event reader vs the 2 s learner budget; inactive bursts | **accept** | §3.5 queued heavy stage; dedupe per player per cut; no LLM on official-status events. |
| C2-F12 | minor | cost cap claim false; runaway | **accept** | §3.5 `referee` daily budget default ($1/day proposed, Nick approves); body-hash dedupe; runaway rules. |
| C2-F13 | minor | trigger contradiction | **accept** | §3.5 new text only. |
| C2-F14 | minor | reader and Jev's Claude arm are one source; require a no-tool field | **accept in part, one part rejected** | one source tag, shrunk together (§1.2, §3.6). The logged "no tool/retrieval" field is rejected: the gateway returns typed answers and token usage only (JEV-01a fact 1), so no such field exists; the cut rule (call wall-clock ≤ cut) is the guard. |
| C2-F15 | minor | no alpha budget across forward-only experts | **accept** | §3.7 e-value Bonferroni, ≤ 3 forward-graded experts per question. |
| C3-F1 | blocking | mixture double-counts availability; RED 1 cannot pass | **accept** | as C1-F1; option (a)-with-convention chosen; RED 1 includes the sim-mean identity. |
| C3-F2 | blocking | `blend.p_play` has no consumer | **accept, DAG option chosen** | §3.2 sim/lineup/waivers read `blend.p_play` with `avail.p_play` as fallback (META-01e (3)). The other option (renaming the availability producer's output) is rejected: it would touch EA-07's wrapped producer and every consumer's declared inputs twice. |
| C3-F3 | blocking | `cons.week` breaks the FantasyPros ruling; no live feed; gap 0 | **accept** | §3.10 no `cons.week`, lab only; missing = its own cell; `internal:true` flag if it ever returns. |
| C3-F4 | blocking | "live now" is not true; poller not running; EA chain | **accept** | §0 honest calendar; META-01b today; replayed rows labelled `history`; the forward-week gate named (§4.1 four weeks). |
| C3-F5 | blocking | champion pointer = runtime version switch; shadow-on-shadow | **accept** | §3.9 no `referee.champion`; B/C lab only; a live challenger would be a shadow version of the same producer. |
| C3-F6 | important | today's served number is ours; no anchor-missing/stale paths | **accept** | §3.1 both paths + RED 5; the ours → ESPN flip is its own labelled promotion needing Nick's OK (his 3 PM "put better numbers out there" ruling was about FantasyPros; this is ESPN as the anchor under our range and chance to play). |
| C3-F7 | important | a third LLM reader; `published_at`; paid call inside a producer; 401 | **accept** | §3.5 built on the existing extractor as a stage with intent/result events; `llm_unavailable`; key health check; the 401 verified (29 runs). |
| C3-F8 | important | cost cap false | **accept** | as C2-F12. |
| C3-F9 | important | history lives in local files; no parity; `fit_ref` unreproducible | **accept, option (a)** | §3.9 frozen history constants + 2026 forward refit; lab code committed minus FP rows; RED 7 parity. Option (b), an ESPN-archive ingest unit, is rejected as unnecessary once nothing in production refits on history. |
| C3-F10 | important | practice-status expert has no data | **accept** | as C2-F10. |
| C3-F11 | important | deps and files mismatch; #222's post-kickoff qb_change; "rows from the day EA-00 merges" | **accept** | §6 deps rewritten (EA-08 or carve; PROJ-01-b); RED 9 for the pre-game flag; shadow rows only from the EA-02 daemon. |
| C3-F12 | important | two ranges per player-week; population mismatch | **accept** | §3.3 one range (`range.week`); §4.1 re-grade on the served population. |
| C3-F13 | important | `referee.expert.*` duplicates the grader | **accept** | §3.10 reads `grade.*` / `jev_cal.*`. |
| C3-F14 | minor | envelope check fails on mixture rows | **accept** | moot without the mixture; the check runs on the conditional mean and the sim's mean separately (§3.10). |
| C3-F15 | minor | templated field names; per-cell keys | **accept, one part rejected** | literal fields `referee.weights`, `range.calib`, `reader.p_play`, `reader.role`; one object row per question on `engine:referee`. A new `cell` entity in the §2.11 grammar is rejected: there are no cells in production. |
| C3-F16 | minor | Monday hook before MNF / stat corrections | **accept** | §3.9 Tuesday 6 AM ET + Thursday-noon deadline (RED 11). |
| C3-F17 | minor | citations off; prereg hash only local | **accept** | §9 fixed (`trade-engine.js:447`, #164 not a draft, `ctx.read.state`); META-01a commits the prereg + sha256 in a draft PR before the lab runs. |

Net: 43 findings, 36 accepted outright, 6 accepted in part with one piece rejected (C1-F5 history population, C2-F5 text-only enums have no history, C2-F14 gateway field, C3-F2 rename option, C3-F9 archive-ingest unit, C3-F15 cell entity) and 1 fix chosen differently (C2-F2's Saturday cut); 0 rejected outright. Every rejection has its reason in the row.
