# GF09 — nflverse ecosystem code: EP/WP model structure vs Gridiron

## Repos read

### nflverse/nflfastR
- License: MIT (LICENSE / LICENSE.md, copyright Sebastian Carl; Ben Baldwin, 2020)
- Stars: 541. Last commit: 2026-08-13 (`git log -1`), pushed_at via `gh api`: 2026-08-13T12:42:15Z. Actively maintained.
- Cloned to `github/nflverse__nflfastR` (depth 1, ~12MB, no node_modules/venv).
- What it actually does (verified by reading, not the README): an R package that (a) scrapes/normalizes raw NFL play-by-play into a standard schema, and (b) ships **pre-trained xgboost models** for EP (expected points, 7-class multinomial), WP (win probability, 2 variants: with/without a Vegas spread feature), CP (completion probability), and a GAM for field-goal probability. The actual model-**training** code (not shipped in the installed package, but present in the repo) lives in `data-raw/MODELS.R`; the feature-engineering + inference-time special-casing lives in `R/helper_add_ep_wp.R` (2036 lines) and `R/helper_add_nflscrapr_mutations.R`.

### nflverse/nflreadr
- License: MIT (LICENSE.md, nflreadr authors, 2021)
- Stars: 113. Last commit/push: 2026-09-07T17:12:59Z. Actively maintained.
- Cloned to `github/nflverse__nflreadr` (depth 1, ~4.2MB).
- What it actually does: **pure data-access**, not modeling. `R/load_pbp.R`, `load_schedules.R`, `load_players.R`, etc. are thin wrappers that download nflverse's pre-built parquet/csv releases (the output of nflfastR's own pipeline, already containing `epa`/`wpa`/`cp`/`cpoe` columns) from GitHub Releases and cache them. There is no model-training or feature code in this repo at all — it is the distribution layer, not the model. Confirms that when Gridiron's `nfl-pbp.js` reads `epa`/`wpa` columns off ingested play rows (`num(rec,'epa')`, `num(rec,'wpa')`, lines 221/295/376/402 of `server/services/nfl-pbp.js`), it is consuming nflfastR's real, xgboost-trained EP/WP output for *historical, completed* plays — it never trains its own EP/WP model, and doesn't need to for that use case.

Adopt: nflfastR → **borrow-idea / port-the-feature-set** (the trained xgboost binaries themselves are irrelevant to Node.js; the *feature list, the label construction, and the inference-time special-casing* are exactly transferable and are what Gridiron is missing). nflreadr → **reference-only** (confirms Gridiron's ingestion path already gets real nflverse EPA/WPA for historical plays; no code to adopt here — this repo has no model logic).

## Exactly what the real EP/WP model looks like (read from data-raw/MODELS.R + R/helper_add_ep_wp.R + R/helper_add_nflscrapr_mutations.R)

**EP model** (`nflverse__nflfastR/data-raw/MODELS.R:81-111`): xgboost multi:softprob, 7 classes (`Touchdown, Opp_Touchdown, Field_Goal, Opp_Field_Goal, Safety, Opp_Safety, No_Score` — the next scoring event of the **half**, not just the drive), 525 rounds, features (`R/helper_add_ep_wp.R:151-175`, `ep_model_select`):
`half_seconds_remaining, yardline_100, home, retractable, dome, outdoors, ydstogo, era0..era4 (5 one-hot era dummies capturing rule-change regimes: pre-2002, 2002-05, 2006-13, 2014-17, 2018+), down1..down4 (one-hot), posteam_timeouts_remaining, defteam_timeouts_remaining`.
Training weights (`MODELS.R:37-51`) downweight plays whose "next score" is many drives away or where score differential is extreme (`Drive_Score_Dist_W`, `ScoreDiff_W`) — a form of relevance weighting Gridiron does not do anywhere.

**WP model** (`MODELS.R:172-234`, `wp_model_select` / `wp_spread_model_select` at `R/helper_add_ep_wp.R:179-218`): xgboost binary:logistic with **monotone_constraints** enforced on the feature order (so, e.g., win probability is constrained to move monotonically with score_differential and yardline_100 — this is a real correctness guarantee a game-outcome model normally lacks). Features:
`receive_2h_ko (will this team receive the 2nd-half kickoff — matters most exactly at halftime), spread_time (posteam_spread * exp(-4*elapsed_share) — the pregame spread decayed toward zero as the game plays out, NOT applied at flat weight the whole game), home, half_seconds_remaining, game_seconds_remaining, Diff_Time_Ratio (score_differential / exp(-4*elapsed_share) — score margin scaled by how much game is left, so a 3-point lead means very different things at 2:00 vs at kickoff), score_differential, down, ydstogo, yardline_100, posteam_timeouts_remaining, defteam_timeouts_remaining`.

Critically, `posteam_spread` (`R/helper_add_ep_wp.R:250-254`) is:
```r
posteam_spread = if_else(home == 1, spread_line, -1 * spread_line)
```
i.e. the spread is **sign-flipped for the away team** before it ever reaches the model. This is the exact bug tonight's diagnostic flagged in `nfl-drive-sim.js` ("away-team win-probability uses the home spread") — the reference implementation shows the one-line fix (multiply by -1 when `posteam != home_team`).

**Inference-time special-casing that is NOT baked into the trained model but is essential to correctness** (all in `R/helper_add_ep_wp.R`):
- **Kneel-downs** (lines 397-408): for `qb_kneel` plays with `yardline_100 > 50`, the model's raw EP-outcome probabilities are **hard-overridden**: `Field_Goal/Touchdown/Opp_*/Safety = 0`, `No_Score = 1`. It does not let the model "guess" — a kneel from your own side of the field with a lead is deterministically a non-scoring play, full stop. This directly targets the diagnosed "kneel rule is inverted" bug: the correct rule is a hard probability override, not a flipped conditional.
- **Overtime** (lines 820-899): overtime rows are split out and handled by an entirely separate branch, not fed through the regular-time WP model. It distinguishes `Sudden_Death_WP` (pre-2012 rules: first score wins) from `One_FG_WP` (2012+ rules: receiving team keeps the ball if it doesn't score a TD on the opening OT drive) via `game_year >= 2012 & (Drive_Diff == 0 | (Drive_Diff==1 & One_FG_Game==1))`, and after OT ends `home_wp_post`/`away_wp_post` are forced to exactly 0/1 (lines ~1200-1213). Gridiron's `nfl-drive-sim.js` season-remainder simulator has **no OT branch of any kind** — this is the concrete reference for what one needs to look like (two named regimes, a rule-era cutoff year, and a forced terminal state).
- **PAT / 2-point / kickoff transitions** (lines ~1020-1060) each get their own `get_preds_wp` call on synthetically constructed rows (e.g. `pat_0`, `pat_1`, `pat_2`, `kickoff_preds`) rather than being fed through the down/distance model as if they were normal plays — the model is never asked to price a play type it wasn't trained to represent.
- **Home-field advantage is never a flat additive constant anywhere in this codebase.** It enters as a single binary `home` feature *inside* the learned model (interacting with every other feature via the tree structure), and it decays through the score/clock features exactly like everything else. There is no equivalent of a "+7 point lump," post-OT or otherwise, in the real pipeline — that is a Gridiron-specific simplification, not something ported from a real source.

**CP model** (`MODELS.R:136-168`): binary:logistic, `base_score = mean(model_vars$complete_pass)` (the model is explicitly initialized at the base rate before boosting — a lightweight calibration anchor completely absent from Gridiron's props pipeline, which the diagnostic already flags as point-estimate-only with no calibration).

## Gridiron code actually read (server/services/nfl-pbp.js, 683 lines; nfl-espn-pbp.js, 638 lines; nfl-live.js, 172 lines — all read-only, not modified)

- `nfl-pbp.js` never trains an EP/WP model; it aggregates nflverse's own precomputed `epa`/`wpa` columns per historical play (confirmed: `num(rec,'epa')` at line 221, `num(rec,'wpa')` at line 295/376/402). For **completed, historical** plays this is actually correct and requires no fix — nflreadr confirms those numbers came from the real xgboost pipeline above.
- The gap is entirely in the **forward/live** path: `nfl-live.js:66-89` (`liveWinProbability`) is a documented, self-aware random-walk approximation — `Normal(drift, sigma*sqrt(fraction_left))` off of `lead`, `secondsLeft`, and `pregameSpread` only. Its own docstring states plainly: "it has no possession, down-and-distance, or timeout awareness... will misprice the final two minutes, where those things decide games." That is the exact same feature set the real WP model above is built on (`down, ydstogo, yardline_100, posteam/defteam_timeouts_remaining, receive_2h_ko`) minus every single state variable.
- `nfl-espn-pbp.js` feeds live ESPN state into `simulateRemainder()` in `nfl-drive-sim.js` (not read in full here per scope — its 6 bugs were already verified pre-session) rather than into a state-aware WP classifier at all — there is no logistic/xgboost WP scorer in the JS codebase, only the drive simulator (physics rules) and the random-walk estimator (score+clock only). Neither one uses the down/distance/timeout/field-position feature vector nflfastR trains on.

## Candidates (bucket = fix)
All five map to bugs already verified tonight in `server/services/nfl-drive-sim.js`; each cites the exact reference logic in nflfastR that shows the correct fix.
