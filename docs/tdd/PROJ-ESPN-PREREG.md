# PROJ-ESPN pre-registration

Committed before any result it judges. Two rules: the weekly width refit for the calibrated
weekly ranges (Q2), and one test of the value-gain hint (Q3). The served-projection switch (Q1)
was decided by the coordinator and advisor on the ML testbench (#446) and needs no rule here.

## 1. Weekly range width k (Q2)

**Range.** A lineup-week's p10 / p50 / p90 is read off the lineup total where each QB/RB/WR/TE
starter scores `max(0, served ESPN mean + k x Q_pos(u))`. `Q_pos` is the empirical quantile
function of (actual PPR - ESPN weekly projection) at his position, 2022-2025, player-weeks with
ESPN >= 3 that were played (`server/services/range-residuals.json`). K and D/ST add their
projection with no spread. `k` is one global multiplier.

**Initial k.** Fitted on the 2026 team-weeks with a frozen pre-kickoff ESPN mean for every skill
starter (week 2: 46 team-weeks, 5 league-weeks; weeks 1 and 3 have no frozen capture or no finals).
The smallest k on a 0.01 grid whose replay covers >= 80%. Stored with its fit date
(`range-residuals.json` `k.fit_date`).

**Weekly rule.** Every Tuesday (America/New_York), once:
1. Pool the trailing 4 completed weeks of real team-weeks (every league, starters from
   `league_roster_snapshots`, means from frozen ESPN only; a team-week missing a frozen skill
   mean is dropped).
2. Replay coverage at the k in force (4,000 seeded draws per team-week).
3. If the coverage is inside [72%, 88%], keep k (a `range_calibration` row, decision `kept`).
   Otherwise refit k on those same team-weeks with the initial-fit procedure (decision `refit`).
   No other change to k is allowed.
4. Every completed week is logged per league in `range_coverage_log` at the k then in force,
   first write wins; number_health `range_coverage` reads the pooled trailing 4 weeks and warns
   outside [72%, 88%].

**Success.** Pooled realised coverage over the first 8 logged weeks inside [72%, 88%]. A season
with more than 2 refits is reported as "k unstable" and the method is reopened (positional k or a
projection-tier split), not tuned in place.

## 2. Value-gain hint (Q3)

**Data.** `offer_value_gain_log`: one row per decided offer (`eval/decided-offers.js`, the one
producer), first write wins, with `fc_gain` (counterparty's FantasyCalc gain), `need_met`,
`blue_chip_given`, `days_to_deadline` and the outcome.

**Test (runs once, when n >= 100 decided offers with a non-null `fc_gain`).**
- Arms: (A) the activity baseline (`eval/e1.js#activityBaseline`, as served); (B) a logistic
  regression on the activity baseline's logit plus `fc_gain / 1000`.
- Out of sample: prequential in proposal order; (B) is refit on every offer resolved before each
  offer's proposal time, and scored only once 30 earlier offers exist.
- Metric: mean log-loss difference (B - A), p clipped to [0.02, 0.98], with a 95% bootstrap CI
  (1,000 resamples, clustered by league-week, seed 20260925).
- Verdict: **promising** if the CI's upper end is below 0; **worse** if its lower end is above 0;
  otherwise **no evidence**. Only "promising" can put value gain into any served probability, and
  then only through its own PR.

**Until then** the hint is info only: shown as "how much FantasyCalc value the other manager
gains", never as a chance, and the finder's order changes only when the user asks for it
(`?sort=value_gain`).

**Known limit.** FantasyCalc history starts 2026-09-24, so `fc_gain` for an older offer is priced
at values as of logging (`features_as_of`), not as of the offer.
