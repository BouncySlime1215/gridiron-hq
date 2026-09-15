# QB value and player availability in points of spread: research report for the Gridiron HQ model redesign

This builds on prior research: **N13** (Gregory-Smith, nflWAR), **GF02** (nfelo code, where `qb_weight`=1) and **F13** (injury events). It also uses the code in the `nfelo`/`nfeloqb` repos and the notes in `server/services/nfl-bitemporal.js`. I cloned the nfeloqb repo to `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/qbres/nfeloqb`. I also ran three measurements on the app's own database, opened read-only; they are labelled "MEASURED" below. I changed nothing in the repo.

## 1. How credible models turn QB value into points

**538 QB Elo, now maintained as nfeloqb** (repo read directly: https://github.com/greerreNFL/nfeloqb)
- **Per-game VALUE formula** (`Resources/data_loader.py`, which cites 538's methodology page): VALUE = −2.2·PassAtt + 3.7·Cmp + PassYds/5 + 11.3·PassTD − 14.1·INT − 8·Sacks − 1.1·RushAtt + 0.6·RushYds + 15.9·RushTD.
- **Ratings update:**
  - The player's rating is an exponentially weighted moving average (EWMA) with weight 0.0886 on the newest game, plus a career EWMA.
  - In the offseason it shrinks toward league average (up to 0.265) and toward the player's career average (up to 0.82). Both taper by career start count (midpoints 183 and 67 starts).
  - A rookie's prior comes from a draft-slot curve (intercept 9.872, slope −4.619), set relative to the team's previous passing value. Undrafted players are treated as pick 300.
  - A backup making his first start gets only 10% of the team's other QB adjustments (`model_config.json`).
- **Game adjustment:** `qb_adj = qb_expected_value − team_off_value` (`qb_model.py:182`). This is the QB *relative to the team's own rolling passing baseline*, not an absolute rating. It is multiplied by 3.3 to get Elo points (`elo.py:109`).
- **Elo to spread:** 25 Elo points per point of spread, so 1 VALUE unit ≈ 0.132 points. The /25 figure comes from 538's methodology as quoted in search results; 538's page now redirects and I could not read it directly.
- **nfelo** adds the 538 QB adjustment at full weight (`qb_weight: 1`, GF02).
- **License:** neither repo has a license, so reimplement the ideas rather than copying code.

**MEASURED: QB adjustment sizes** (published `qb_elos.csv`, seasons 2010–2025, points = adj/25)
- Across 8,758 team-games: mean −0.12, SD 1.25, 1st percentile −5.05, 99th percentile +1.88.
- At an in-season change of starter (n=797, which includes starters returning): mean −1.47, median −0.84, 10th percentile −4.7.
- With the same QB as the previous game: SD 1.04.
- So the typical swap is about 1 point, and a star-to-scrub swap is about 4–5 points.

**Academic estimate: Gregory-Smith (2021)**, *Economic Inquiry* 59(2):829–847 (https://eprints.whiterose.ac.uk/id/eprint/165323/)
- **Data:** 2011–2015, games where the starting QB was injured during the game.
- **Win probability:** the team's win probability drops 28 percentage points, "equivalent to giving the other team 9.5 points on the spread."
- **Points per win probability:** one extra point of spread is worth 3% win probability.
- **Market:** pregame spreads do not predict in-game injuries, so the event is exogenous.
- **Backup quality:** backups average 16 fewer passer-rating points, and passer rating explains about half of the total effect.
- **Why this is an upper bound for pregame use:** the backup had no week of preparation, and the result measures a win-probability effect, not a spread line.

**PFF WAR** (Eager & Chahrouri, Sloan conference paper: https://www.sloansportsconference.com/research-papers/pff-war-modeling-player-value-in-american-football; figures from https://www.pff.com/news/nfl-what-is-pff-war-and-why-it-shows-russell-wilson-is-the-mvp)
- **Method:** grade-based. Replacement level is defined as a 3–13 team.
- **Magnitudes:** elite QB seasons run about 4.1–5.5 WAR (Brees 2011 at 5.54). QB WAR has a year-to-year correlation of 0.62.
- **Per game:** Seth & Brown (PFF, 2021) list Prescott's projection for Week 6 of 2020 at +0.14 WAR/game (https://www.pff.com/news/nfl-pff-data-study-war-adjusted-injuries-lost).
- **My conversion (derived, not published):** at 3% per point, 0.14 WAR/game ≈ 4.7 points, and about 0.3 WAR/game for an elite season ≈ 10 points above *replacement*. Real backups are better than replacement level, so the realistic gap is smaller.
- **Access:** the data is proprietary and would need a paid feed.

**Replacement QBs against the market** (nfelo analysis: https://www.nfeloapp.com/analysis/team-and-scheme-nfl-qbs/)
- Replacements for below-average starters cover only 46% of first starts; replacements for above-average starters cover 54%.
- The previous starter's performance correlates 0.459 with his replacement's, which points to a team/scheme component.
- This is a blog analysis with a small sample (19 QBs in the natural experiment). Treat it as a hypothesis, not a finding.

**MEASURED: does the market already price the QB adjustment?**
- **Data:** `nfl_nfelo_qb` joined to `game_lines`, 2020–2025, n=1,621 games.
- **Result:**

| Test | Slope per point of QB adj | SE | n |
|---|---|---|---|
| Actual margin minus closing line | 0.07 | 0.17 | all games |
| Same, in QB-change games only | 0.04 | 0.24 | 318 |
| Closing line minus opening line | 0.41 | 0.035 | all games |
| Same, in QB-change games only | 0.46 | 0.06 | QB-change games |

- **Line movement:** in QB-change games the line moves 2.24 points from open to close on average, against 1.54 in other games.
- **What it means:** the closing line fully absorbs QB information, and about 40% of it arrives *after* the open.
- **Caveats:**
  - The `qb1` column records who actually started, so this is an upper bound on what was knowable at the open.
  - `game_lines.closing_spread` is NULL for 2018–2025; I used `spread` as the close.
  - The local `nfl_nfelo_qb` table only starts in 2020.

**Blog claims (unverified):** "3–7 points when a starter is ruled out" (e.g. https://walterfootball.com/quarterbackinjuriesimpact.php). No methodology is given, and the figure is broadly consistent with the numbers above.

## 2. Non-QB availability

- **Adjusted games lost (AGL):** Football Outsiders reports its injury measure correlates with wins at only about 0.2–0.3 (https://www.footballoutsiders.com/stat-analysis/2017/nfl-head-coaches-adjusted-games-lost). That is season-level and weak.
- **Weighted injury burden:** Glazer, Binney & Seth (2025) study snap- or value-weighted measures (https://journals.sagepub.com/doi/10.1177/22150218241304941). The page returned 403, so I have no effect sizes.
- **Bottom line:** I could not verify any per-position points-of-spread figure for non-QBs in a peer-reviewed source. Non-QB coefficients must be learned under strong shrinkage.

## 3. What is known at decision time

**The NFL reporting schedule**
- **Practice reports:** Wednesday, Thursday and Friday before a Sunday game. Participation is recorded as DNP (did not participate), Limited or Full.
- **Game status report:** due 4 p.m. ET two days before kickoff, i.e. Friday for Sunday games. Thursday games get a Wednesday status report.
- **Designations:** Out ("will not play"), Doubtful ("unlikely"), Questionable ("uncertain"). Probable was dropped in 2016 after about 95% of Probable players played.
- **Sources:**
  - ESPN on the 2016 designation change: https://www.espn.com/nfl/story/_/id/17361111/nfl-streamlines-injured-players-game-status-removes-probable-designation
  - Pro Football Network on the injury policy: https://www.profootballnetwork.com/what-is-nfl-injury-policy-rules-and-procedures-for-nfl-teams/
- **Inactives:** the list is released 90 minutes before kickoff. This comes from secondary sources (CBS Sports), because the official policy PDFs now return 404.

**What each decision time can see**
- **Decision at 60 minutes before kickoff:** inactives are known, so Questionable uncertainty is almost fully resolved.
- **Decision at the open or midweek:** only the practice trajectory is available.

**Play rates for designated players**
- **Footballguys, 2017–2023:** 71% of Questionable players played; 5.9% of Doubtful players played (https://www.footballguys.com/article/2024-injury-index-chance-to-play-questionable-vs-doubtful).
- **PFF:** assumes Questionable = 73% (link above).
- **MEASURED, `nfl_injuries` joined to `nfl_snaps` by name, 2021–2024, all positions:**

| Final status | Final practice | Played | n |
|---|---|---|---|
| Out | any | 0% | — |
| Doubtful | any | <1% | 610 |
| Questionable | Full | 73% | 1,138 |
| Questionable | Limited | 66% | 3,560 |
| Questionable | DNP | 45% | 980 |

- **MEASURED, QBs who were recent starters (≥50% of snaps in the prior 3 weeks):**

| Status and practice | Played | n |
|---|---|---|
| Questionable + Full | 79% | 14 |
| Questionable + Limited | 49% | 81 |
| Questionable + DNP | 19% | 16 |

- The name join may miss some players, so these rates are lower bounds.

**The data's time-safety problem (from `nfl-bitemporal.js`)**
- `nfl_injuries` keeps only one row per player-week, holding the final status. It is overwritten in place, and the midweek history is gone.
- `modified_at` is NULL for every 2025 and 2026 row.
- `valueAsKnown` has zero callers, and `nfl_feature_revisions` has 0 rows.
- The nflverse data dictionary likewise describes one `report_status`, one `practice_status` and one `date_modified` per row (https://nflreadr.nflverse.com/articles/dictionary_injuries.html).
- **Consequence:** a Wednesday practice-report tape cannot be rebuilt for past seasons from this source.

## (A) Key findings
1. **A QB swap is usually worth about 1 point, and 4–5 points at the extreme.** 538/nfelo express QB value relative to the team's baseline at 1 VALUE unit ≈ 3.3 Elo ≈ 0.132 points (nfeloqb code).
2. **An unplanned in-game QB loss is about 9.5 points** (Gregory-Smith 2021, 2011–15, with 3% win probability per point). Treat this as the upper bound.
3. **The closing line fully prices the nfelo QB adjustment** (MEASURED, residual slope 0.07±0.17). About 0.41 points of line movement per point of QB adj happens between open and close. Any QB edge only exists before the close.
4. **Questionable means roughly 66–73% to play overall, and practice status shifts that sharply** (Footballguys; PFF; MEASURED). For starting QBs it runs 79% with a Full practice and 19% with a DNP (small n).
5. **The app's injury history is final-status only.** 2025–26 have no timestamps, so midweek features cannot be backtested without look-ahead.

## (B) Recommendations
1. **QB feature: `qb_delta_pts`.** Build an own-data version of the 538 structure:
   - Shrunk per-QB efficiency state: EPA per dropback plus the VALUE formula, EWMA weight about 0.09.
   - Offseason pull toward league average, fading toward the career average as starts accumulate.
   - Rookie prior from draft slot.
   - Subtract the team's rolling passing baseline.
   - Put it into the model with a ridge penalty, with a prior coefficient of 0.132 points per VALUE unit (or the equivalent after refitting). Do not hard-code the weight.
2. **Expected-QB feature.** Use `p_play·starter + (1−p_play)·backup`.
   - `p_play` comes from a small logistic model (numpy or JS) on final status × practice level × position.
   - Priors from above: Out 0, Doubtful 0.02, Questionable/Full 0.75, Questionable/Limited 0.6, Questionable/DNP 0.35.
   - At a 60-minutes-before-kickoff decision, overwrite it with the inactives when captured.
3. **Non-QB feature.** Snap-share-weighted starters-out by position group: OL, WR/TE, CB/S, front seven. Use hierarchical shrinkage toward zero, no gates. Expect coefficients well under 1 point and let walk-forward results decide.
4. **Bet gate.**
   - QB information is absorbed by the close, so grade QB-driven bets by closing-line value at the time of the decision.
   - Expect value only where the decision beats the market's move from open to close. That is consistent with the prior −2.28 CLV finding.
5. **Time safety.**
   - **Training data:** treat the 2020–2024 final Friday status as a feature "known at Friday 4 p.m.", valid only for decisions at or after that time.
   - **Rule:** never use `nfl_snaps` "played" as an availability input for pre-inactives decisions.
   - **Excluded seasons:** leave 2025–26 injury features out of validation until captured revisions exist.
   - **Going forward:** wire the injury sync's `recordRevision` calls and `valueAsKnown` into feature generation now, so a genuine Wednesday/Thursday/Friday tape builds up from here.
6. **Backfill.** Load pre-2020 QB values from the nfeloqb `qb_elos.csv` for training depth, flagged as `reconstructed`.
   - Caveat: nfeloqb's parameters were tuned on the full history, which leaks mildly into training. It is better to recompute QB values in-house, point in time, from nflverse play-by-play.

## (C) Code and repos to borrow from
- **greerreNFL/nfeloqb** (no license; reimplement ideas only)
  - VALUE formula (the 538 formula is public methodology).
  - Parameter values in `model_config.json`, as priors.
  - Backup handling in `QB.get_value`.
  - The team-relative adjustment in `qb_model.py:182`.
  - The weekly `qb_elos.csv` as a benchmark and challenger feature.
- **greerreNFL/nfelo** (no license): how `project_game` applies the QB adjustment (GF02).
- **fivethirtyeight/nfl-elo-game** (MIT; GF02): the base Elo only. It contains no QB code.
- **nflreadr injuries data dictionary** (https://nflreadr.nflverse.com/articles/dictionary_injuries.html): field meanings for the injury table.

## (D) Open questions and risks
- **Look-ahead in QB identity:** the "who started" field in historical QB tables has look-ahead built in. The app needs its own announced/projected-starter field with timestamps.
- **Small samples:** Questionable-QB samples are tiny (n≈110), so pool across positions with a QB offset.
- **Unverified primaries:**
  - I could not read the 538 methodology page (it redirects), so the /25 figure comes from secondary quotes.
  - The official NFL injury policy PDFs return 404, so the 90-minute inactives rule rests on secondary sources.
- **Team usage of designations varies** (Footballguys), so a team-level random effect on `p_play` may help. It is unmeasured here.
- **No point-in-time inactives or elevation data** exists in the DB today.
- **The 9.5-point in-game estimate may not transfer** to planned backup starts made with a full week of preparation.
- **Measurement limits:** everything MEASURED is descriptive and single-pass. It is not a registered test (F06), so re-run it under the trial registry before relying on it.