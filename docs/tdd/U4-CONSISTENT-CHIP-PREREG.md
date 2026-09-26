# U4 CONSISTENT-CHIP pre-registration

Committed before any evaluation. The results (`docs/tdd/U4-CONSISTENT-CHIP.md`, `.json`) come in a
later commit; `npm run check:prereg-order` checks the order. Source: NEXT-LEAP U4 (2026-09-25).

## Question

Nick's rule: A.J. Brown (277) may be traded only for a Blue chip (board score 83+) who is a CONSISTENT
weekly scorer now. `never-give.js#ajMayMove` has no `consistentOf` reader, so 277 never moves (fails
closed). Does a conservative, as-of consistency flag pick out 83+ players with a better near-term
floor than the 83+ players it does not flag? If not, the reader stays unwired and 277 stays locked.

## Disclosure first (what was known before this file)

- No outcome of any flag below has been computed. Nothing here was tuned on 2024-2025 results.
- The weekly residual table (`server/services/range-residuals.json`, actual PPR minus ESPN projection)
  was built on 2022-2025, so the p25 clause's WIDTH has seen 2024-2025 outcomes (its centre has not).
  Disclosed, not corrected.
- Arithmetic on the definition alone (no data): with k = 1.71 the calibrated p25 sits about 8 points
  under the mean at RB/WR (Q_pos(0.25) about -4.7), about 10 at QB, about 6 at TE. NEXT-LEAP's literal
  clause "p25 >= the starter MEDIAN" then needs a WR mean of about 22+ and an RB mean of about 24+ per
  game: a handful of player-seasons a year, too few for any test. So the p25 clause is refined below
  (compared with the starter LINE, the N-th starter). The literal version (D0) is still counted and
  reported, descriptively.
- Week 18 is excluded everywhere (teams rest starters; a rested star would read as a missing week).

## The rule D (frozen here), one producer

`server/services/campaign/consistent-chip.js` (pure). The backtest and the live reader call the same
function. Positions QB/RB/WR/TE; N = 10 at QB/RB/TE, 20 at WR; points = full PPR
(`nfl_ffopportunity_weekly.actual_fantasy_points`; all five leagues score PPR 1.0, league-specific
extras are not modelled).

- **Starter median M_P(s)** for season s: in season s-1, weeks 1-17, rank players at P by points per
  game played (8+ games); the top N are the starters; M = the median of all their weekly points (pooled).
  **Starter line L_P(s)** = the N-th starter's points per game. Lagged a full season: no in-season look.
- **Window**: the last 6 weeks (1-17) before decision week W in which his NFL team played, walking back
  from W-1 in season s into season s-1 (week 17 down). His team in a season = the team on his latest row
  in that season before the cut. A team-week with no row for him is MISSING.
- consistent(i) at (s, W) is true only when ALL hold:
  1. board score >= 83 (`BLUE_CHIP_SCORE`), and the board does not mark him `hurt`;
  2. active: his latest injury report before the cut is not Out or Doubtful;
  3. all 6 window weeks exist (no missing week, no unknown team, no previous season for a rookie);
  4. his points >= M_P(s) in at least 4 of the 6 window weeks;
  5. next-week calibrated p25 = `playerDraw(mean, P, 0.25, k, residuals)` (range-residuals.js, the
     app's own player marginal) >= L_P(s), with mean = the board's production value for him and k the
     width in force (range-calibration.js#currentK; 1.71 on the copy).
  Anything missing (no score, no mean, no M or L for the position, no k) = NOT consistent.
- **D0 (literal NEXT-LEAP)**: the same with clause 5 compared with M_P(s). Descriptive only.

## Test

- Seasons **2024 and 2025**; leagues with that season's draft on file (2024: leagues 1, 2; 2025:
  leagues 1, 2, 3). Decision weeks W = 4..14. As-of: only games with week < W in season s (and season
  s-1).
- Board score as-of: `people/player-score.js#scorePlayers` (the producer itself) on a universe of that
  league-season's drafted players (joined espn_id -> players -> gsis) plus the top 40 undrafted by
  production value. Production: season-to-date PPR per game (weeks < W); early (fewer than 3 team games)
  the previous season's per-game as the ros_ppg stand-in. Injury input: the week W-1 report.
  Approximation disclosed: drafted stands in for rostered.
- Eligible row: a player-league-week with as-of score >= 83 at QB/RB/WR/TE and 4 team-weeks at or after
  W (<= 17) in season s. Arm "flagged" = D true; arm "unflagged" = D false.
- Outcome F = his next-4-team-week floor: the 2nd-lowest of the 4 scores (p25 at index floor(0.25 x 4)),
  a missed game scoring 0. Secondary S = mean over the 4 of max(0, M_P(s) - points).
- Primary statistic: delta = mean F (flagged) - mean F (unflagged). 95% percentile CI, 2,000 resamples of
  player-season clusters drawn from the union of both arms (each resample recomputes both means),
  seed 20260925.

## Pass bar (all required, pooled)

1. flagged rows >= 30 and flagged player-season clusters >= 10;
2. delta's 95% CI lower bound > 0;
3. the secondary agrees in sign: mean S (unflagged) - mean S (flagged) > 0 (point estimate).

Per position: the same statistic, reported; a position with < 30 flagged rows is `too_few`. **Served
only at positions that pass on their own** (CI lower > 0, not too_few) AND only if the pooled bar
passes. A position that does not pass returns not-consistent (fails closed).

Reported, not gating: 2024 alone and 2025 alone; delta adjusted for the mean (per position, the F
residual after an OLS on the production value); the NEXT-LEAP weekly bar (share of flagged rows' next-4
weeks >= M, against 70%); D0's flag count; the minimum detectable effect (2.8 x SE) on a decline.

## If it fails

The reader stays unwired, `ajMayMove` keeps failing closed, 277 stays locked, and the results file says
so. No re-run with a changed rule without a new, committed addendum.

## If it passes

Wired behind `GRIDIRON_CONSISTENT` (own flag, shadow by default): 277 may appear only in a step whose
get passes consistent() on the same data; every card giving 277 carries `requires_nick_confirm: true`.
Forward (rule 5): unconfirmed on 2026; the flag stays shadow until the coordinator flips it.
