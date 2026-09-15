# N03 — Transformer / sequence models directly on play-by-play

Researcher: N03-transformers-play-sequences | bucket: new | 2026-09-12

## Repo grounding (read-only checks against fantasy-football-dashboard)

- `server/db/schema/nfl-a-to-m.js:305-334` defines `nfl_play_by_play` (event_id, play_id,
  season, week, sequence, period, clock_seconds, offense, defense, down, distance,
  yards_to_endzone, play_type, yards_gained, is_turnover, is_scoring, is_penalty,
  home_score, away_score, shotgun, no_huddle, pass_depth, pass_direction, text,
  fetched_at), indexed by `idx_pbp_season_week` (line 690). This is a genuine sequential
  play log (ESPN summary endpoint, ingested by `server/services/nfl-espn-pbp.js`),
  not just a features table.
- `server/services/nfl-pbp.js:1-14` (nflverse ingestion) explicitly describes the
  processing model: stream the CSV, "fold each play into an in-memory accumulator,"
  write one row per team-week / player-week. Raw plays are "never held in memory" —
  i.e., the sequence is deliberately discarded immediately after each play updates an
  aggregate. This is the file-level proof of the "251,591 rows used only for
  hand-built features, never sequence models" finding.
- `server/services/nfl-espn-pbp.js:9-25` — the *only* current uses of the raw sequential
  table are (a) validating the drive simulator's yardage distribution
  (`playDistributionAudit()`) and (b) feeding live win probability / in-game simulation
  restart state. Neither trains on the sequence; both treat each play as an
  independent draw conditioned on the current state.
- `server/services/nfl-ensemble.js` — confirmed structurally consistent with the FOUND
  claim: `blend()` (line 1273) linearly combines named components with weights, and the
  file's own comments (line 1163, 1409-1413) describe components entering "the blend"
  and worry about which components a report "cannot see," consistent with an
  under-diversified linear combination.
- `server/betting/nfl/strategy/teaser-leg-rates.js:624,651` — `independent_joint: p*p`
  computed explicitly, with a comment at 651 reading "INDEPENDENCE IS ASSUMED and the
  legs are not quite independent." Confirms the exact defect verbatim.
- `server/services/nfl-team-strength.js:88-131` — `priorPointsByTeam()` blends
  `seasonAggregate(season-1)` (prior year) with `preseasonProjections(season)` via
  hand-written weighting logic, no state-space/Kalman formalism. Consistent with FOUND.
- `server/services/nfl-drive-sim.js` — not re-audited line-by-line here (already fully
  audited in tonight's FOUND list by another agent); used only as the fix target for
  candidate F2 below, citing the FOUND bug list verbatim.

## Primary sources (read in full unless noted)

1. **Guo, X. (2018/2020). "Neural Network Models for Predicting NFL Play Outcomes."
   Stanford CS230 project report.**
   http://cs230.stanford.edu/projects_spring_2020/reports/38964602.pdf — read in full (4 pp, PDF).
   - Data: Horowitz/Yurko/Ventura Kaggle play-by-play, 2009-2018, split by year
     (train 2009-2017 = 286,524 examples after filtering to pass/run only; test 2018 =
     29,219 examples).
   - Task: 8-class classification of play outcome (yardage buckets + turnover + TD)
     from pre-snap state only (down/distance/field position/score/time/timeouts + 4
     hand-built "recent tendency" features), using 1-6 layer MLPs with softmax output,
     ReLU, Adam, dropout swept 0.1-0.5.
   - Result: **~22% accuracy**, and the model collapsed to predicting the modal class
     (0 yards gained) almost universally; higher dropout diversified predictions but
     *dropped* accuracy to ~19%. The author's own conclusion: "None of the models were
     able to meaningfully predict the outcome of the plays based on the features
     provided," and explicitly flags the fix as future work: "Since football games
     consist of a sequence of plays and the effectiveness of plays earlier in the game
     may be an indicator of how effective they will be later, exploring the use of
     sequence models could be valuable."
   - Honest read: this is a *negative result* for state-only (non-sequential) neural
     nets on this task — useful as the null hypothesis a sequence model must beat, and
     as documentation that play-level yardage is genuinely hard to predict from static
     features alone (bears on how much lift to expect from any drive/play model).

2. **Ötting, M. (2020). "Predicting play calls in the National Football League using
   hidden Markov models."** arXiv:2003.10791 (Bielefeld University). Read in full (13 pp, PDF).
   - Data: Kaggle play-by-play 2009-2018, 5,052 per-team-per-game time series,
     318,691 plays total after removing special teams; train = seasons 2009-2017
     (2,302 games, 289,191 plays), test = season 2018 (224 games, 29,500 plays).
   - Model: **2-state HMM per team**, binary observation (pass=1/run=0) driven by an
     unobserved "pass propensity" Markov chain; transition probabilities are
     covariate-dependent via a multinomial-logit link on down, yards-to-go, shotgun,
     no-huddle, score differential, goal-to-go, own-red-zone, home/away, plus
     AIC-selected interactions (down×ydstogo, shotgun×ydstogo, etc.). Fit per team by
     maximum likelihood via the forward algorithm; one-step-ahead forecast is the
     ratio-of-likelihoods formula in Zucchini et al. (2016).
   - Result: **71.5% weighted-average out-of-sample accuracy** on 2018 (vs. ~58.4%
     base rate of passes, so meaningfully better than a majority-class baseline, and
     better than the ~67% reported by prior play-by-play-only studies (Heiny & Blevins
     2011; Teich et al. 2016) — though a few points below the ~75% reported by studies
     that add personnel/player-rating features (Lee et al. 2017; Fernandes et al.
     2019), which this paper doesn't use). Per-team range 60.2% (Seahawks) to 77.9%
     (Patriots); precision/recall vary substantially by team (e.g. run precision 53.2%
     Packers to 76.3% Texans).
   - Honest read: this is the strongest *directly comparable* result to what Nick's
     data supports today — same granularity (down/distance/formation/score, no player
     tracking), same task family (predict the categorical next event from state +
     recent history), explicit proof that modeling the **time-series/state structure**
     of play-calling (vs. treating plays as i.i.d., as in source #1) buys real,
     measured accuracy. It is a 2-state HMM, not a transformer, but it is the
     literature's cleanest existence proof that sequence-awareness matters on exactly
     Gridiron's kind of data (discrete play-by-play, not tracking).

3. **Chaineau, S. "Transformers can generate NFL plays: introducing QB-GPT."**
   Towards Data Science / Medium, fetched and read in full (blog post, not peer-reviewed).
   - Data: NFL Big Data Bowl 2021-2023 tracking data + public NGS highlights, 2018-2022,
     47,991 plays, 870,559 player trajectories, 28.1M (x,y) coordinates, 3,190 players.
   - Model: GPT-style decoder-only transformer (1.5M-7.7M params across Tiny/Small/
     Medium/Large variants), 3-head multi-head attention, a custom "multi-temporal
     causal mask" letting a token at time *i* attend to all 11 players' tokens from
     time 0..i-1 (not just its own player's history). Player movement tokenized as
     1-yard-grid, 0.2s-frame position deltas, truncated to 256 tokens/play.
   - Task: generative — predict each player's next positional token given the
     formation and preceding frames (trajectory synthesis, not a discrete play/drive
     outcome).
   - Result: exact-token accuracy ~20-35% depending on model size/horizon, top-3
     ~40-60%, top-5 ~50-70%; accuracy drops 40-50% between frame 5 and frame 10 as
     paths diverge; static/blocking players hit 60%+ accuracy while route-runners and
     ball-carriers drop to 20-30% ("chaotic" after ~10 seconds). Author explicitly
     calls the model "raw," flags the 1-yard/0.2s discretization as an open design
     question, and reports adding attention layers gave "minimal improvement" over
     just growing embedding size.
   - Honest read: this is **tracking-data** transformer work (frame-level x,y
     trajectories), a different data type from Gridiron's play-level pbp table. It is
     directly relevant as an architectural pattern (causal masking across a set of
     agents/events, GPT-style generative sequence modeling of a sport) but **not
     directly portable** — Gridiron has no Next Gen Stats tracking feed, only discrete
     play-level rows. Cited as reference-only / adopt="borrow-idea", not as code to
     port.

4. **Biro, P. & Walker, S.G. (2021). "A Reinforcement Learning Based Approach to Play
   Calling in Football."** arXiv:2103.06939. Read in full (13 pp, PDF).
   - Not a neural sequence model — a decision-theoretic Markov Decision Process over
     drives, with state `s = (DOWN, DIST, LOS)` exactly matching the natural
     minimal state for a play-level sequence model, terminal states = {TD, FG, turnover,
     end-of-drive}, actions = {run, pass}, transition probabilities estimated
     empirically from real play-by-play (yards-gained distributions conditioned on
     down/distance/field position, shown non-parametrically in their Fig. 5), and
     utilities solved by value iteration / an ordered-MDP shortcut exploiting the
     "downhill" (never-revisits-a-state) structure of a drive.
   - No held-out accuracy number is reported — the paper's contribution is the
     formalism and the optimal-policy recommendation, not a predictive benchmark, and
     it explicitly declines to condition on team identity, personnel, or history
     within the game ("we assume the law of large numbers will dominate... and the
     differences that these strategies create are minimal") — which is precisely the
     assumption a sequence model would relax.
   - Honest read: read for its exact framing of a drive as an ordered sequence of
     states with a well-defined terminal reward — this *is* the formal object a
     "next-drive-outcome from play sequence" model needs to define its state/target
     space, and its stated assumption (no play-history dependence within a drive) is
     the literature's own admission of the gap this research topic would fill.

### Searched but not read in full (kept as context only, not counted toward the 4)
- "Decoding Defensive Coverage Responsibilities... Factorized Attention-Based
  Transformer" (arXiv 2603.25901) — tracking-data coverage-assignment transformer,
  same category as QB-GPT; not fetched given time budget, listed for completeness.
- Fernandes, Yakubov, Li, Prasad, Chan (2020), "Predicting plays in the NFL," J. Sports
  Analytics — read via search summary only (75.3% NN accuracy with personnel/player
  data added, 2013-2016 seasons, 130,344 plays); not fetched in full, cited by both
  papers above as the personnel-augmented ceiling Gridiron's player-less pbp table
  cannot reach without adding roster/personnel joins.

## GitHub / OSS scan (gh search + one clone)

- `nflverse/nflfastR` (541 stars, MIT/other, active — last push 2026-09-06) and
  `nflverse/fastrmodels` (8 stars) are the actual production baseline the field uses
  for EP/WP: gradient-boosted trees (xgboost) on hand-built situational features, one
  row per play, **no sequence model** — i.e., the field's own reference implementation
  has the same architecture gap Gridiron's `nfl-ensemble.js`/`nfl-drive-sim.js` have.
  `adopt: reference-only` — worth knowing the field baseline is XGBoost-on-features,
  not a reason to import code.
- Searched specifically for "NFL play by play transformer", "nfl play prediction
  LSTM", "nfl drive outcome prediction", "nfl epa neural network", "nfl gpt play
  sequence" — **zero real hits** (`gh search repos` returned `[]}` for every exact-phrase
  query). Broader terms ("nfl-big-data-bowl", "nfl-play-prediction") surfaced only
  Kaggle-competition tracking-data notebooks (Big Data Bowl submissions, all
  frame-level trajectory tasks) and toy classifiers.
- Cloned and inspected `aburstyn9068/NFL_Play_Prediction` (8 stars, no LICENSE file,
  single-season 2017 CSV, last commit 2023-05-21) as the single most-starred "predict
  next play" repo found: `NFL_Play_Prediction.py` is 113 lines, imports
  `sklearn.ensemble.RandomForestClassifier(n_estimators=20)` and a Streamlit UI — no
  sequence structure at all, single-play-row-in/row-out. Deleted after inspection per
  instructions (`adopt: avoid`).
- **Conclusion of the OSS scan**: there is no mature, licensed, maintained open-source
  implementation of "transformer/sequence model directly on NFL play-by-play for
  next-play or next-drive prediction." This confirms the task brief's framing — this
  really is a new-capability build, not a port. The nearest reusable *code* is
  nflverse's feature-engineering conventions (EPA/WP columns, `nflfastR`), which
  Gridiron's own `nfl-pbp.js`/`nfl-features.js` already replicate; the nearest reusable
  *math* is the HMM state-dependent transition-probability machinery in source #2 and
  the MDP state definition in source #4.

## Candidate model spec (the concrete "new" deliverable the task asked for)

**Next-drive-outcome-from-play-sequence model.**

- *Input*: the sequence of plays observed so far in the current drive, each play
  tokenized as `{down, distance, yards_to_endzone, play_type, yards_gained,
  is_turnover, is_scoring, shotgun, no_huddle, pass_depth, pass_direction,
  clock_seconds, score_diff}` — every field already present in `nfl_play_by_play`
  (`server/db/schema/nfl-a-to-m.js:306-334`), plus a static context vector (offense/
  defense team-strength, home/away, week) from `nfl-features.js`'s existing team-week
  blob. No new data source needed.
- *Architecture*: small encoder-only transformer (4-6 layers, ~1-3M params — the QB-GPT
  parameter counts above are a reasonable sizing reference even though the token type
  differs) over the play sequence, causal-masked so play *p* only sees plays 1..p-1
  of the current drive plus the static context; a shared drive-position embedding
  (play index within drive) stands in for the "multi-temporal" trick in source #3
  since there is only one agent (the offense) per token here rather than 11.
- *Output*: two calibrated heads at every play index — (a) categorical distribution
  over next-play type (run/short pass/deep pass/scramble/sack/penalty), and (b) a
  categorical/binned yards-gained distribution (using the 8-bucket scheme from source
  #1, since that paper's own negative result shows this is the honest way to score the
  task rather than point-RMSE); plus a running (c) drive-outcome head (P(TD), P(FG),
  P(turnover), P(punt/downs), P(halftime/end-of-game)) updated after every play,
  directly analogous to the terminal-state formalism in source #4.
- *Training data contract*: `nfl_play_by_play` rows grouped by `(event_id)`, ordered by
  `sequence`, segmented into drives by offense-possession changes (the table already
  carries `offense`/`defense`); target for the drive-outcome head is the actual
  terminal event of that drive read off the same table. At 251,591 rows this is enough
  for the small-model sizes above (source #3's models trained on a comparable
  order-of-magnitude token count) but not enough for anything GPT-scale — a real
  constraint to state up front, not a footnote.
- *Baseline it must beat*: (i) the majority-class/zero-gain baseline from source #1
  (~22% play-outcome accuracy) and (ii) the current drive simulator's own hand-coded
  yardage sampling, which `nfl-espn-pbp.js`'s `playDistributionAudit()` already knows
  how to compare against real distributions — so the exit test below reuses existing
  Gridiron audit code rather than inventing new evaluation machinery.

## Do-not-do list

- Do not attempt to port QB-GPT's trajectory-transformer architecture directly —
  Gridiron has no player-tracking (x,y) feed; the token type, causal-mask trick, and
  parameter sizing are worth borrowing, the code is not.
- Do not train a single pooled transformer across all 32 teams' play-calling and call
  it done — source #2's own results show per-team heterogeneity is large (60.2%-77.9%
  accuracy range with a shared architecture); any next-play model needs either
  per-team fine-tuning or team identity as a first-class conditioning input, not an
  afterthought one-hot.
- Do not report point-estimate accuracy/RMSE as the success metric for a generative or
  distributional play model — source #1's own failure mode (collapsing to the modal
  "0 yards" prediction) is exactly what point-accuracy optimization produces; score
  this with calibration (reliability diagrams / Brier) against the bucketed
  distribution, matching the props module's own honest evaluation style that FOUND
  flagged as the project's one area of genuine measured skill.
- Do not build this as a replacement for `nfl-drive-sim.js`'s existing bug fixes —
  fixing the 6 stated physics bugs (kneel inversion, timeout non-decrement, half/full
  clock mismatch, wrong-team field position on turnovers, flat 7-pt OT lump, missing
  halftime/OT in the season-remainder sim) is cheap, mechanical, and should happen
  regardless of whether any sequence model is ever built; don't let "we're building a
  fancier simulator" become a reason to leave known-wrong rules in production.
- Do not stand up a training pipeline before running the exit tests below on a frozen
  holdout split — with only 251,591 rows across an unknown number of seasons, it is
  easy to leak by drive (adjacent plays in the same drive in train and test) or by
  team-season; source #2's year-based split (train ≤2017, test =2018) is the discipline
  to copy.
