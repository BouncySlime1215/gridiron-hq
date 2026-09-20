# Scoring a live league against the stored Team Outlook fit

2026-09-20. `server/services/league-outlook.js`, `test/league-outlook-live.test.js`.
RED first, then the implementation, then fourteen mutations.

## Why this exists at all

O4 has never had a consumer. PR #42 built the panel — `espnWeeklyRows` reads the weekly
scores that have been sitting unparsed in `leagues.payload` since the first sync — and
stopped deliberately, for a reason its own commit set out: `history-corpus.js` opens the
crawled corpus from `process.cwd()/data/derived/sleeper_history.sqlite`, and the
Dockerfile's runtime stage copies `client/dist`, `server` and `scripts` and nothing else.
So `fitOutlook`, `fitThresholds` and the variance `k` had always resolved to nothing on the
deployed app — silently, and only there, while working perfectly on a dev checkout. A chip
pointed at a verdict that resolves to nothing in production is worse than the heuristic
label it replaces, because the heuristic at least renders.

Migration 065 and `outlook-fit-store.js` closed that: the fit is a row in the app's own
database, written by `scripts/fit-team-outlook.mjs` on a machine that has the corpus. This
file is the read side. It fits nothing.

## The deployment claim, proved rather than documented

The whole test file sets `GRIDIRON_LEAGUE_HISTORY_PATH` to a path that does not exist
before importing anything, and test 1 asserts `historyStatus().available === false`. Every
assertion after it is therefore a statement about the deployed app and not about this
container — which *does* have the corpus, 203 MB of it, and is exactly how a consumer that
secretly depends on it would pass its tests here and render nothing on Fly.

The mechanism it relies on: `history-corpus.js` opens the file lazily, inside `handle()`,
reached only from the corpus-reading queries. `weeklyPanel({ rows })` short-circuits at
`suppliedRows ?? regularSeasonWeeks(seasons)`, so with rows supplied the corpus is never
touched. Mutation M14 replaces the supplied rows with a corpus read and five tests fail,
so that short-circuit is load-bearing and not incidental.

## The three corrections, and why each is not optional

Each is a case where the untouched pipeline returns a plausible number rather than an error.

**1. `weeks_left`.** `weeklyPanel` computes it as `totalWeeks - (i + 1)` over the rows a
team *has*. For a corpus row from a finished season that is the weeks remaining. For a
league three weeks into a fourteen-week season it is **zero** — the model is told the
regular season is over. `weeks_left` is one of the six fitted features, so a team is priced
as though its record were final: a bad start reads as fatal and a good one as safe, at
exactly the weeks where the model's whole claim is that little is settled. The season
length comes from `settings.scheduleSettings.matchupPeriodCount`; a payload without it is
refused, because a default would be inventing the length of somebody's season.

The correction is applied in the consumer, not in `weeklyPanel`. The producer is right for
the corpus it was written for, and changing it there would put a live league's assumption
into every fit.

**2. The league's format.** `featureRow` falls back to `playoff_share = 0.5`, and
`weeklyPanel` puts the playoff cut at the whole field, when `playoff_teams` is missing. Six
of twelve and two of four are different worlds, and both `games_back` and `playoff_share`
are fitted features. Refused, not defaulted.

**3. A week the fit does not cover.** The fit is per week; `OUTLOOK_GATE.weeks` is 2 to 8.
`predictOutlook` returns null outside them and `verdictFor(null, …)` returns null, so a
surface gets blanks with nothing beside them saying why. Refused, naming the week and the
weeks the fit covers.

## Three defects found while writing this, two of them in the tests

**The rounding undid the clamp.** `predictOutlook` clamps to `(1e-6, 1 - 1e-6)` because a
logistic fit on a few hundred league-seasons is not entitled to say a team is certain.
`(0.9999996).toFixed(4)` is `'1.0000'`. Rounding for display put the certainty straight
back, and the page would have printed a 100% playoff chance at week 3. `forDisplay` rounds
*inside* the bounds: 0.9999 and 0.0001. Found by an assertion that a probability is
strictly between 0 and 1; fixed in the implementation, not the test.

**A test that could not fail.** "The correction changes the answer" compared the served
probability (rounded to four places) against an unrounded prediction and asserted they
differed. They always differ. It survived the mutation that deletes the correction
entirely. Both sides are now scored the same way, and the assertion is that the *served*
number follows the corrected side on a team where the two round differently.

**A fixture that measured the clamp.** The first league fixture had team 1 outscoring team
4 by twelve points every week. All four teams pinned against `clamp01`, where no input
changes the output, so nothing could demonstrate the correction. And in the fit panel every
league ran fourteen weeks, so within a fitted week `weeks_left` was a constant column —
standardised to all zeros, L2 driving its coefficient to nothing. The feature was in the
model and had no effect. The fit leagues now run 13 to 17 weeks, as real ones do, and the
live fixture's results are mixed.

A separate deliberately-saturating fixture (`BLOWOUT`) exists for the one test that needs a
probability that rounds to a certainty.

**Dead code found by a mutation that changed nothing.** The first version checked
`outlookFitStatus().present` and then `activeOutlookFit()`. Both call the store's `latest()`
and refuse on the same condition, so the first could never reject anything the second
accepted. Deleting it failed no test. Collapsed to one read, with the status consulted only
for the words.

## Mutations

Every mutation was applied and the file confirmed changed before the run; a pattern that
did not match is reported as NO-OP and is not evidence. Two earlier sweeps on this project
recorded green runs that were silent no-ops, which is why the harness prints it.

| # | mutation | result |
|---|---|---|
| M1 | drop the `weeks_left` correction entirely | 2 fail |
| M2 | `weeks_left = regular_periods`, forgetting the weeks played | 2 fail |
| M3 | accept a payload with no season length | 1 fail |
| M4 | accept a payload with no playoff places | 1 fail |
| M5 | score a week the fit does not cover | 1 fail |
| M6 | serve a shape when no fit is stored | 1 fail (after the dead check was removed) |
| M7 | round with `toFixed` alone, dropping the clamp | 1 fail |
| M8 | swallow the producer's reason for a generic one | 1 fail |
| M9 | score every week, not just the latest | 3 fail |
| M10 | `regular_periods` dropped from `espnWeeklyRows` | 6 fail |
| M11 | verdict from round numbers, not the fitted thresholds | 1 fail (after test 10 was added) |
| M12 | publish thresholds that are not the ones used | 1 fail |
| M13 | report features from a different `k` than the fit's | 1 fail (after the reproduce-the-probability invariant) |
| M14 | reach for the corpus instead of the league's own rows | 5 fail |

M6, M11 and M13 survived their first run. Each is recorded above as a defect the tests
could not see, and each was answered by an assertion rather than by weakening the mutation.

## Numbers

RED: 12 tests, 1 pass, 11 fail. GREEN: 12 pass, 0 fail.
Full local check `npm run check`: exit 0 — 3,044 tests, 3,003 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database.

## The five questions

**Is this well built?** It is the read side of a store, and it refuses rather than defaults
in every case where a default would be an invented fact about somebody's league. Its one
correction is applied where it is visible and not inside the shared producer. The published
features are required to reproduce the published probability, so an explanation can never
belong to a number it did not produce.

**Is this based on stats, or is it made up?** The fit is the O4 model fitted on completed
league seasons and stored; the thresholds are quantiles of the fitted probabilities, fixed
in `docs/tdd/team-outlook.tdd.md` before anything was fitted. Nothing here chooses a number.
The one judgement — four decimal places — is a display choice, and it is bounded so it
cannot claim more than the model does.

**How do we know?** Fourteen mutations, all failing. The deployment claim is a test that
runs with the corpus absent, not a paragraph. The `weeks_left` defect is demonstrated on
the untouched producer inside the test before the corrected value is asserted.

**Should this data be pointed anywhere else on the platform?** Yes, and it is the reason
four modules currently reach no surface: `history-corpus.js`, `outlook-fit-store.js`,
`team-outlook.js` and this file. League Hub is the surface. The `verdict` must not be
promoted to `act` by anything that cannot also show a move that helps — that promotion
belongs to a caller holding the Trade Brain's best move, and the model's own header says so.

**How does it unify?** It reads the weekly scores out of `leagues.payload`, which is the
same unparsed `mMatchup` data four other thresholds are waiting on, and it publishes the
fit's identity (`fit.id`, `fitted_at`, `through_season`, `basis`) beside every number, so a
surface can say which model produced what — the same shape as the basis fields being added
across the app.
