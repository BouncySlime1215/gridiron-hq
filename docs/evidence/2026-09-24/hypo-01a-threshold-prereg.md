# HYPO-01a per-stream threshold: pre-registration (FIX-277-3)

Committed before any run of the calibration on league data. The sha256 of this file is in
`hypo-01a-threshold-prereg.md.sha256` beside it. The code is
`server/services/hypo/calibrate.js`; the run is
`node scripts/hypo-surprise.mjs --league 4 --calibrate` on a DB copy, after deleting the
`hypo-01a-v1` rows from that copy.

## Question

For each HYPO-01a stream, what share of units does the spec's threshold flag, measured
walk-forward, and is it inside the target 5% +/- 1.5% (3.5% to 6.5%)?

## Units (every scored unit, flagged or not)

| stream | unit | surprisal | time |
|---|---|---|---|
| offer | each resolved offer in the league-season, E1's rows (`mergeOffers` + `scoreAsOf`, eval/e1-league.js): observed ESPN offers and SENT app offers | -ln P(what happened): P(accept) if accepted, 1 - P(accept) otherwise | resolved_at, else proposed_at |
| roster_burst | each 72 h window that opens where a team's decision starts and has a base rate (>= 7 covered days) | -ln P(N >= n decisions), Poisson on the team's prior 28 days | the window's first move |
| projection_miss | each settled player-week in `weekly_prediction_snapshots` on a roster in the league that week, with a usable 80% range | -ln of the two-sided tail p of the actual under the range (projection-stream.js) | settled_at, else as_of |

## Rule (fixed here, not tuned after the run)

1. Sort a stream's units by time; cut into 7-day blocks from the stream's first unit.
2. For block k, the threshold is the 95th percentile (linear interpolation, type 7) of the
   surprisal of every unit in blocks before k.
3. Block k is evaluated only when that history holds at least 20 units; otherwise it is
   reported as not evaluated, never as 0 flags.
4. A unit in an evaluated block is flagged when its surprisal is strictly above the threshold.
5. Flag rate = flagged / evaluated units, per stream.

## Reading

- Inside 3.5% to 6.5%: the threshold is used as the stream's write rule in a follow-up.
- Outside: reported as outside, with the rate; the hand-set rule stays until a later fit.
- Not evaluable (no block with 20 units of history): reported as such, with the unit count.

Nothing is tuned on this run: no quantile, block length, minimum history or target is
changed after seeing the output. The output lists unit ids and p values only.
