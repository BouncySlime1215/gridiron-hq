# PLAYOFF-SEEDING (plan items 47 + 48) pre-registration

Written 2026-09-25, before the code or any result exists. Nick's goal is now
"playoffs first": this unit tells him what a playoff spot and each seed are worth
in league 4's bracket, how many wins get him there, and which remaining weeks
are must-win.

## What is built

One producer: `server/services/season-sim.js#playSeasons`, the same runs that
serve playoff and title odds, collects per-run results and hands them to
`server/services/playoff-path.js`. Nothing else simulates a season for this.

Per team (ids only), from the world's base runs:

1. **Seed value (47).** For every seed s of the playoff field, title odds if the
   team finished at seed s, played on the SAME runs (counterfactual bracket: the
   team is placed at seed s, the others keep their order). Paired, so the value
   of one seed over the next and of a bye over no bye has a paired SE.
   Also: P(finishing at each seed), P(title | in the playoffs).
2. **Win targets (47).** P(playoffs | final wins = k) and P(bye | final wins = k)
   per win total, the smallest total that reaches 50% / 90% playoffs and 50% bye
   (only buckets with at least 20 runs count), the wins still needed from the
   current record, and an on-pace line per remaining week.
3. **Must-win weeks (48).** For every remaining regular-season week: P(win),
   and playoff and title odds with that one game forced to a win vs forced to a
   loss, all else in the run unchanged (paired counterfactual, not a
   correlation, so a strong run does not inflate it). leverage = difference,
   with paired SE. A lineup posture guess per week: favoured -> protect the
   floor, underdog -> chase the ceiling (labelled a guess).

Every probability carries its run-to-run Monte Carlo SE.

## Flag

`GRIDIRON_PLAYOFF_SEEDING`: unset / `0` = off (the sim output is byte-identical
to before); `shadow` (or `1`) = computed in the producer's base world and written
to `plans.json _run.inputs.playoff_path` (bookkeeping; no screen reads it).
Preview mode (`GRIDIRON_PREVIEW_UNCONFIRMED`) never turns it on. There is no
served mode in this PR.

## Must-win rule (fixed here, no sweep)

A week is must-win when its playoff leverage is at least 0.10, clears 2 paired
SE, is among the 3 largest remaining leverages, and is at least 1.25x the
median remaining week's leverage (so when every week matters about equally, as
early in a season of even teams, no week is singled out).

## Pass bar (all must pass before a screen may show any of it)

- **B1 exactness.** On a synthetic league of equal teams (every draw identical
  in distribution), a 6-team field with 2 byes and a fixed bracket: title if
  seed 1 or 2 = 1/4, seeds 3-6 = 1/8, each within 3 SE at 4,000 runs; the
  per-seed finish probabilities sum to P(playoffs) for every team and to 1 over
  teams for every seed.
- **B2 monotone.** Forcing a win never lowers a team's playoff odds in any run
  (per-run difference >= 0 in every run, not just on average).
- **B3 identity.** The counterfactual title at the seed a team actually
  finished equals the served bracket's champion indicator in every run.
- **B4 precision.** At the producer's 1,200 runs every playoff-level number
  (seed finish, P(playoffs | wins), playoff leverage) has SE <= 0.015 (a
  binomial SE is at most 0.5/sqrt(1200) = 0.0144, so this is a check that the SE
  is the run-to-run one and not something smaller).
- **B5 off is off.** With the flag unset, `simulateSeason` / the world's base
  carry no `playoff_path` and the rest of the output is unchanged.

What would fail it: any of B1-B5 red; or the local league-4 run (below) showing
seed-finish probabilities that do not sum as in B1, or an SE above B4's.

B1-B5 prove the arithmetic. They do not prove the sim's playoff odds are
calibrated: that is SIM CALIBRATION MONITOR (#466). Promotion from shadow to a
screen needs B1-B5 green, the local league-4 run, and #466's playoff-odds
reliability not failing.

## Needs local measurement

`GRIDIRON_PLAYOFF_SEEDING=shadow node scripts/campaign/produce-plans.mjs --league 4`
then read `_run.inputs.playoff_path` from plans.json (seed values, win targets,
must-win weeks with SE; runtime added in `_run.phases_ms.world`).
