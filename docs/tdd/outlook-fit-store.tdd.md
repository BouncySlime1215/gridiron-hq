# TDD evidence: outlook-fit-store (2026-09-20)

Source: the O4 / Team Outlook model has no consumer, and the reason turned out
not to be an oversight. `server/services/history-corpus.js:48` opens
`process.cwd()/data/derived/sleeper_history.sqlite` **read-only and returns null
rather than throwing** when it is absent, and the `Dockerfile` runtime stage
copies exactly `client/dist`, `server` and `scripts` — `data/` is never in the
image. So on Fly, `fitOutlook`, `fitThresholds`, `varianceComponents`'s k,
`verdictFor` and the `no_results_yet` decomposition have always resolved to
nothing, silently, while working perfectly on a dev checkout. A consumer wired
straight to them would render a verdict in development and an empty chip in
production — worse than the heuristic it replaces, which at least renders.

Both halves of that were verified by reading the two files, not inferred.

Nothing here writes to the live database, runs a migration against it, or
deploys. The fit below was produced on this checkout's own corpus and written to
a scratch database under `/tmp`.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u /tmp/gridiron-XXXXXX).sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test --test-concurrency=1 test/outlook-fit-store.test.js

## RED, then GREEN

A real RED: the rules were written against a throwing stub, and the fixture test
passed at the same commit, which is what says the RED was the rules failing and
not the harness.

| | |
|---|---|
| RED | `c5ee2a1` — `# pass 1 # fail 6`. The one pass is "the fixture is a real fit, not an empty one". |
| GREEN | this commit — `# pass 11 # fail 0` |

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| The corpus in production | Absent by construction, and absent **quietly**: `handle()` returns null and every caller treats that as "no data". | **Build new**: store the fitted model in the app database and read it at request time. Fitting where the corpus is, scoring where it is not. |
| Migration numbering | `server/migrations/` carries two `062`s on `main`, and `server/migrations/README.md` (PR #39) forbids renumbering an applied file and requires an unused number for a new one. Enumerating `server/migrations` across all 74 remote heads: `062` has a third claimant in flight (`062_roster_weekly_panel.js`, PR #38), `063_espn_credentials` is PR #48's, `064_league_history_tables` is PR #47's. | **Take `065`**, the first unused number, and say so where the other owners can read it. |
| `OUTLOOK_FEATURES` and the stored coefficients | The vectors are **positional**. Reorder or extend that list in code and a stored vector prices `win_pct` with `all_play_pct`'s coefficient. The output is still a probability in (0,1), still monotone, still chartable, and wrong. | **Store the feature list with the fit** and refuse the whole fit when the two disagree. A check like this is only possible if the list travels with the fit. |
| `k` | `featureRow(row, k)` shrinks points with it via `shrinkToLeague(z, games, k)`. With k lost, that is `games/(games+undefined)` = NaN, so every probability is NaN, and **`verdictFor(NaN, thresholds)` returns `'fine'`** because every comparison against NaN is false. A whole league told it is fine, with no error anywhere. | **Validate k on both sides.** The test asserts the `'fine'` behaviour directly rather than describing it in a comment, so the reason for the guard cannot rot. |
| Thresholds | They are what turn a probability into a verdict. A fit stored without them reads as present and renders nothing. | **Refuse on both sides.** |
| "The active fit" | `shrinkage_fits` keeps it by convention (`UPDATE … SET active = 0`, then set one). Convention holds for as long as every writer remembers it, and two active rows leave every reader guessing. | **A partial unique index**, `outlook_fits_one_active ON outlook_fits(active) WHERE active = 1`, so two active rows are impossible rather than unlikely. Tested by trying. |
| The write itself | Deactivating the old fit, inserting the parent row and inserting the week rows are three statements. A failure between them is a database with no active fit — a deployment that had a working model a millisecond earlier and now has none. | **One transaction**, with a test that makes the week insert throw after the parent row is in. |
| Gate G4 in the writer | `scripts/audit-team-outlook.mjs` holds the pre-registered gate on a held-out split. It says whether the model may be believed; it does not check the fit that actually gets stored. | `scripts/fit-team-outlook.mjs` **sign-checks every week of the fit it is about to store** and refuses to write if any week fails, and refuses a k reported at its cap (`between_positive: false`), which would shrink every points feature to zero. |

## Mutation: every guarded rule, shown failing

Each row is one edit, the test file re-run, then a restore from a pristine copy.
All were RUN at this commit. **Twelve guarded rules, twelve mutations, twelve
failures.**

| Mutation | Result | Test that caught it |
|---|---|---|
| read: drop the feature-list check | pass 9, fail 1 | a fit stored under a different feature list is refused, not reinterpreted |
| read: drop the k check | pass 9, fail 1 | a stored k that cannot shrink anything is refused … |
| read: drop the coefficient-width check | pass 9, fail 1 | a stored coefficient vector of the wrong width is refused on the way out too |
| read: drop the thresholds check | pass 10, fail 1 | stored rows that lost their week models, or their thresholds, are refused on read |
| read: drop the no-weeks check | pass 10, fail 1 | (same test) |
| save: drop the no-weeks refusal | pass 9, fail 1 | saving refuses what cannot be scored with |
| save: drop the k refusal | pass 9, fail 1 | (same test) |
| save: drop the thresholds refusal | pass 9, fail 1 | (same test) |
| save: drop the coefficient-width refusal | pass 9, fail 1 | (same test) |
| save: BEGIN/COMMIT/ROLLBACK all no-ops | pass 6, fail 5 | a write that fails part way through leaves the previous fit active, not none |
| save: do not deactivate the previous fit | pass 8, fail 2 | the newest stored fit is the active one …; the one-active rule is enforced by the database … |
| migration: drop the one-active unique index | pass 7, fail 3 | the one-active rule is enforced by the database, not by this file being careful |

The two read-side checks in the middle of that table **passed their first
sweep**: `saveOutlookFit` already refuses those states, so nothing in the tests
could reach the read path's copy of them. They are reachable in reality — a fit
written by an older build, or rows edited by hand — so the answer was a test that
corrupts the stored rows directly, not a deleted check. Recorded here because a
rule that passes a mutation sweep is the finding, not a footnote.

## Measured live, on the real corpus

Not a fixture. `node scripts/fit-team-outlook.mjs --write` against a scratch
database on this checkout:

    corpus: 2500 leagues, 27586 team-seasons, seasons 2021, 2022, 2023, 2024, 2025
    k = 7.2 from 26836 team-seasons (avg 13.88 games); half weight at 7.2 games
      week 2: n = 26415, signs ok      ... through ...      week 8: n = 26848, signs ok
    thresholds: watch <= 0.4121, act_candidate <= 0.1986
      (quantiles of 186678 fitted probabilities on the fit seasons)
    stored fit 1, active, through 2025, weeks 2, 3, 4, 5, 6, 7, 8

Then every scorable row of that panel was priced twice, once from the in-memory
fit and once from the stored one:

    rows_scored: 186678,  mismatches: 0

Identical, not close — the coefficients, `mu`, `sd` and `intercept` round-trip as
exact doubles, and the test asserts equality rather than a tolerance. Verdict
distribution on the first 20,000 panel rows: 6,937 fine, 1,814 watch, 1,274
act_candidate, 9,975 null (weeks outside the fitted 2-8, which is the correct
answer for them rather than a number).

`k = 7.2` here against the `7.5` quoted in `history-corpus.js`'s own header: a
different season set (2021-2025 against whatever that figure was measured on),
not a disagreement about the method.

## What this does NOT do

- **It wires no consumer.** The store is the half that was blocking one; a
  surface that renders a verdict is a separate change in a route file this thread
  does not own. Nothing in the app reads `activeOutlookFit()` yet, and
  `outlookFitStatus()` exists so that whoever wires it can print
  "not fitted on this deployment" instead of an empty chip.
- **It does not run on Fly, and must not.** The fitter needs the corpus; the
  image does not have it. `--write` is opt-in for that reason, and a dry run is
  the default.
- It does not re-open the pre-registered gate. `scripts/audit-team-outlook.mjs`
  still owns that, on its held-out split, and the numbers it publishes are
  unchanged by anything here.
- **It does not settle whether the audit's published O4 figures were measured on
  this 2,500-league corpus or on twelve league-seasons.** This checkout has the
  2,500-league file; whether Nick's clone does is still unconfirmed, and any
  figure quoted to him needs that answered first.

## Correction, and what the morning message must say

An independent read pointed out that **neither `server/services/history-corpus.js`
nor `server/services/team-outlook.js` exists on `origin/main` at `791b131`**.
Verified here: `git ls-tree -r 791b131 -- server/services/` matches neither path,
main carries 1,312 files, and the only file on main mentioning `sleeper_history` is
`scripts/collect-sleeper-history.mjs`. Both modules live only on this thread's
branches (`…-outlook-basis`, PR #42, and this one stacked on it).

So the earlier statement — "O4 cannot run in production because the corpus is not
in the image" — was true but incomplete, and the order matters for anyone reading
it. The accurate version:

> **O4 is not on `main` at all.** It ships when PR #42 merges, and even then it
> cannot produce a number on the deployed app until this fit store merges too,
> because the corpus is never in the image. Two merges, in that order, and neither
> of them changes a published figure.

That is also why nothing was ever "broken in production" here: there was nothing in
production to break. The finding is about what would have happened the moment a
consumer was wired, which is exactly when it would have been hardest to see.

## Which corpus the O4 figures were measured on

This container's `data/derived/sleeper_history.sqlite`, built by
`scripts/collect-sleeper-history.mjs`: **2,500 leagues, 27,586 team-seasons,
seasons 2021-2025**, read live today. Earlier notes circulating a "~1,913 league"
figure are stale — the crawl grew. Whether **Nick's own clone** has that file built
is unconfirmed, and it matters: on a clone without it every O4 number resolves to
nothing, and on a clone with a smaller crawl the audit's figures are not the ones
quoted here. The run sheet therefore needs the corpus build command before
`node scripts/fit-team-outlook.mjs --write`, not only the fit command.

## Mutation bookkeeping

Every mutation in the two tables above was verified **applied**: the driver asserts
its anchor string occurs exactly once in the pristine source before editing and
reports `ANCHOR NOT FOUND` with the match count instead of running the suite
otherwise, because a silent no-op reads as a green sweep. Each mutation was
restored from a pristine copy before the next one ran, and the final restore was
checked with `git diff`.

## The five questions

Nick's standing rule of 2026-09-20 01:21Z.

1. **Is it well built?** It is plumbing, and it is built to fail loudly. Two tables,
   one read path returning the shape the model already uses, one writer script that
   refuses more often than it writes. The twelve guarded rules exist because every
   one of them fails silently otherwise.
2. **Is it based on stats or made up?** The store holds fitted numbers and no
   chosen ones: coefficients, `mu`, `sd` and `intercept` from the IRLS fit, `k` from
   the variance decomposition, and thresholds as quantiles of fitted probabilities
   rather than round numbers. The only constants here are structural (which weeks to
   fit, `l2 = 1.0`), and both come from `OUTLOOK_GATE`, which was pre-registered in
   `docs/tdd/team-outlook.tdd.md` before anything was fitted.
3. **How do we know?** Measured, not asserted: 2,500 leagues and 27,586
   team-seasons, `k = 7.2` from 26,836 team-seasons, weeks 2-8 each fitted on
   ~26,400-26,800 rows and every week sign-clean, thresholds `watch 0.4121` /
   `act_candidate 0.1986` from 186,678 fitted probabilities, and 186,678 rows priced
   twice with 0 mismatches. What we do NOT know is whether the model earns its
   keep — that is `scripts/audit-team-outlook.mjs`'s held-out gate, unchanged by
   this, and its figures still need the corpus question above answered before being
   quoted.
4. **Should this data be pointed anywhere else?** Yes, and it cannot be until
   someone wires it: nothing reads `activeOutlookFit()` yet. The natural consumers
   are a League Hub verdict and the Trade Brain's "is this team in trouble" read,
   both in route files this thread does not own. `outlookFitStatus()` exists so those
   surfaces can say "not fitted on this deployment" rather than render a blank.
5. **How does it unify?** Two ways. The fit is stored once and read by everything,
   instead of each caller re-deriving a model from a corpus most machines do not
   have; and `weeklyPanel({ rows })` means an app league's features come from the
   same code the model was fitted on, rather than a second implementation for live
   data. The thing that makes both safe is the stored feature list: one definition of
   what the coefficients mean, checked on every read.
