# Team Outlook — the rule, written before it was fitted

O4 in `docs/FANTASY-ENGINE-MASTER-PLAN.md`. This document states what the outlook
model is, what it is scored against, and what happens if it fails, and it is
committed **before** the model is fitted. A threshold chosen after seeing which
threshold looked good is not a threshold. The same order was used for
`play-chance-gate-v2.md` and for the same reason.

Read `docs/tdd/sleeper-history.tdd.md` for where the data comes from and
`server/services/league-history.js` for the only code that reads it.

---

## 1. What is being predicted, and from what

**Outcome:** `made_playoffs`, for one team-season, evaluated at the end of week `w`.
Nothing that happens after week `w` is an input. The outcome is never an input.

**Population:** completed public Sleeper redraft league-seasons, 2021-2025. Fit on
2021-2023, scored on 2024 and 2025 **separately**, each once.

**Features, all of them known at the end of week `w`:**

| feature | why it is in |
|---|---|
| `all_play` | the luck-free record; measured best single signal at every week 1-13 |
| `points_shrunk` | the posterior mean under `k` from the variance decomposition — the plan's `k(w)`, applied |
| `win_share` | the actual record. Not a duplicate of `all_play`: seeding is decided by it, so a team can be luck-rich and still in |
| `games_back` | distance to the playoff line in wins, which `win_share` alone does not give |
| `weeks_left` | how much time there is to move |
| `playoff_share` | the league's format. 6 of 8 making the playoffs is a different question from 6 of 14 |

`playoff_share` is a conditioning variable throughout, in the baselines as well, so
no model is credited for learning the league format.

### What is deliberately NOT a feature, and the measurement that decided it

The plan (D2) says "Sleeper rosters carry player ids that map to ours
(`players.sleeper_id`), so every real team gets **our** projected strength week by
week." **That is not available.** Measured on the app database, `players.sleeper_id`
is populated for **751 of 8,556 players (8.8%)**. The plan's own blocker list (E5.7)
says 0 of 8,640, which is also wrong in the other direction; the number is 751.

Either way a roster cannot be priced from an 8.8% crosswalk — a team whose two best
players happen to be unmapped would be scored as a bad team, and the error would
correlate with player profile rather than being noise. So:

- **Projected lineup strength is not a feature of the validated model.** Every number
  this document gates is produced without it.
- Where our own projections do exist — Nick's five leagues, which are ESPN-keyed — the
  service may report projected strength and its rank **alongside** the validated
  probability, labelled as unvalidated at population scale, and it may never move the
  probability or the verdict. A number that cannot be held out cannot be allowed to
  decide anything.
- Building the crosswalk is real, separable work. It is not a prerequisite for the
  rest of this item and is not done here.

---

## 2. The model

Per week `w`, L2-regularised logistic regression on the six features above,
standardised using **fit-set** means and standard deviations only.

One model per week rather than one model with week interactions: a per-week fit
cannot borrow strength across weeks, which is the conservative choice, and it makes
each week's coefficients readable on their own.

**Sign check, pre-registered.** After fitting, the coefficients on `all_play`,
`points_shrunk` and `win_share` must be `>= 0` and the coefficient on `games_back`
must be `<= 0`. A fitted sign that disagrees with the direction of the world is a
defect in the fit, not a discovery, and it fails the gate rather than being shipped
with an explanation.

**Calibration layer.** None by default. Expected calibration error is measured and
reported. Isotonic regression fitted on the fit seasons is applied **only** if the
raw model's ECE exceeds 0.03 on the **fit** seasons — never in response to a test
season's ECE, which would be fitting on held-out data.

---

## 3. The gate

Baselines, every one of them binned or fitted on the same fit seasons:

1. `base_rate` — the league's playoff share. Knows nothing about the team.
2. `all_play` only.
3. `points_shrunk` only.
4. `win_share` only — the naive "win rate so far", which is what a person reads.

**Ships only if all four hold:**

- **G1.** Held-out Brier of the combined model is lower than all four baselines, at
  **every** week 2-8, in **both** 2024 and 2025.
- **G2.** The advantage over the **strongest** baseline at each of those weeks has a
  90% interval excluding zero, by paired bootstrap **clustered by league**
  (`pairedBootstrapDiff`, 2000 draws, seed 20260919, groups = league id). Clustering
  by league is required: team-seasons inside one league share opponents, so treating
  them as independent would shrink every interval by roughly the square root of the
  league size and manufacture significance.
- **G3.** Expected calibration error at most **0.03** by decile, at every week 2-8,
  in both test seasons.
- **G4.** Signs as stated in section 2, at every week 2-8.

**If the gate fails, that is the answer.** No feature is added, no week is dropped
from the range, no threshold is loosened, and there is no v2 of this document. The
model that ships instead is the best **single** validated signal — which on the
measurement already taken is `all_play` — as the outlook probability, labelled as a
single signal and not as the combined model. The failure is reported as a failed
gate, which is what D2 item 7 requires.

Stated in advance because it is the part that is tempting to move later: **weeks 2-8,
both seasons, all four baselines, no exceptions.** Week 1 is excluded because the
plan's own acceptance range is weeks 2-6/2-8; it is still measured and reported.

---

## 4. The decomposition — luck, noise, real

The plan wants the change since preseason split three ways. A decomposition whose
parts do not sum to the whole is a set of three unrelated numbers, so this one is
defined sequentially on the model's own probability, which makes it sum exactly by
construction:

```
p0 = model at week w with the preseason state
p1 = model at week w with the actual record replaced by the all-play record
p2 = model at week w with points_shrunk at its shrunk value
p3 = model at week w with the real state

luck  = p1 - p0     what the record did beyond what the scoring earned
noise = p2 - p1     the part of the scoring the posterior does not believe yet
real  = p3 - p2     what is left: the roster and the schedule
```

`luck + noise + real == p3 - p0` identically. This is an ordering choice, not a
unique attribution, and the service reports it as such: with a different order the
individual parts differ. Stating that is part of the pre-registration.

The `noise` term is the one the plan cares about and is where `k` does its work: at
week 2 the posterior keeps 21% of what has happened, so 79% of an unusual start is
assigned to noise, and by week 8 that is 48%.

---

## 5. The verdict — and the half of it that cannot be validated yet

D2 defines Act as two conditions: **(a)** odds below a fitted threshold, **AND**
**(b)** the best available move raises title odds by at least a fitted amount.

**(a) is fitted and validated here.** The threshold is chosen on the fit seasons as
the playoff probability below which teams finish materially worse, and validated on
held-out seasons by the separation it actually produces.

**(b) cannot be computed on this population.** It needs each team's roster priced by
our projections and a counterfactual for the best available waiver or trade — the
crosswalk measured in section 1 rules out the first, and the replay counterfactuals
are a separate dataset. So:

- The service emits **`fine`**, **`watch`** and **`act_candidate`**.
- **`act` is never emitted by this service.** A caller that can supply condition (b)
  — the Coach, with the Trade Brain's best move — promotes `act_candidate` to `act`.
  Until such a caller exists, no surface shows Act.
- This is the plan's own rule ("the verdict may never say Act on noise alone") taken
  literally: telling a team to act when we have not shown that acting helps them is
  exactly the thing it forbids.

**Validated here:** that `act_candidate` teams finish materially worse than `watch`
teams and `watch` worse than `fine`, held out, with the separation reported in
playoff rate and in final rank.

**Not validated here, and labelled so:** that acting beats not acting. That needs the
replay leagues and is not claimed.

---

## 6. Verification required before this is called done

- The full suite, lint and typecheck clean.
- Tests covering: the sequential decomposition summing to the total exactly; the sign
  check failing a fit with a wrong sign; the gate failing when a baseline wins;
  `act` never being returned; a league with a playoff share the fit never saw;
  week 1 and week 13 boundaries; and a team with zero games played.
- The gate's own verdict printed per week and per season, so a reader sees which
  baseline was strongest and by how much, rather than being told it passed.

---

## 7. ADDENDUM, written after the fit — what happened

Everything above this line is the rule as it stood before anything was fitted, and nothing
above it has been edited. This section records the result and four things found on the way,
so the changes are visible as changes rather than absorbed into the rule.

### 7.1 The gate FAILED. G3, calibration.

| condition | result |
|---|---|
| **G1** combined beats all four baselines, weeks 2-8, both seasons | **pass**, 14 of 14 |
| **G2** advantage over the strongest baseline, 90% interval excluding zero, clustered by league | **pass**, 14 of 14 |
| **G3** expected calibration error at most 0.03 | **FAIL** — 4-5 of 7 weeks in 2024 exceed it; all 7 in 2025 pass |
| **G4** fitted signs | **pass**, 7 of 7 |

The combined model is clearly the better *ordering*: it beats the strongest baseline by
0.013 to 0.033 Brier at every week in both held-out seasons, every interval excluding zero.
It is not calibrated to the standard this document set, on one of the two test seasons.

**No calibration layer is permitted.** Section 2 keys the isotonic layer on the **fit**
seasons' ECE, and that is 0.0047 to 0.0211 — inside 0.03 at every week. Fitting a layer in
response to 2024's number would be fitting on held-out data, which section 2 forbids in
advance precisely so this moment has no discretion in it.

**The failure is systematic, not noise.** At the worst week (2024 week 4, ECE 0.050) the
reliability table's gap is positive in 8 of 10 deciles and the mean prediction is 0.513
against an observed 0.545. The model is under-confident on 2024 by about three points
across the board. Checked and ruled out as a cause: the data is consistent — each season's
playoff rate matches its declared playoff share to within 0.002, and the count of
`made_playoffs` equals `playoff_teams` in every league but four of 953.

### 7.2 The pre-registered fallback is worse than what it replaces. That is a defect in this document.

Section 3 says the model that ships on failure is the best single validated signal, which is
the all-play record. Measured: all-play's own ECE is 0.018 to 0.043, missing 0.03 at **12 of
14** week-seasons against the combined model's 4-5 of 14.

So the stopping rule, as written, hands over something calibrated *worse* than the thing it
rejected. I wrote that clause assuming a simpler model would be better behaved, and it is
not. Naming it is the honest response; quietly preferring the combined model because the
fallback turned out badly would be exactly the gate-shopping the pre-registration exists to
prevent. What follows from it:

- **The probability does not ship as a calibrated number.** Nothing may present it as meeting
  a calibration standard, and any surface showing it shows its measured error.
- **The ordering ships**, because the ordering is what G1 and G2 validated and both passed
  everywhere. The verdict's own separation is measured directly on held-out seasons and holds
  in both: 2024 week 6 reads fine 75.0% / watch 32.1% / act_candidate 12.7%, and 2025 week 6
  reads 73.9% / 31.0% / 9.9%.
- **The crawl was incomplete when this ran** (about 1,000 league-seasons, still growing, and
  2024 had 169 leagues at week 4 against 2025's 321). The unchanged rule will be re-run once
  the crawl finishes and whatever it says will be reported. Re-running an unchanged rule on
  more data is not gate-shopping; changing the rule would be, and it is not being changed.

### 7.3 Abandoned leagues were corrupting the foundation

Found by a robustness check, not by the gate. Sleeper's public API returns leagues nobody
played: five league-seasons are zero for every single team-week, fifty more for over half of
theirs, and they carry `champion` flags on whichever roster the bracket advanced. Two rules
now apply in `league-history.js`, both stated as facts about the data rather than about any
outcome: a team-week of exactly zero is a missing observation, and a league-season more than
half zeros is discarded whole.

This moved `k` from 7.35 to about 7.6, which is *toward* believing an early record less.
A dataset defect that was making the model more confident is the worst kind to leave in a
model whose subject is not being too confident too early.

### 7.4 Two corrections to the design above

- **`real` is a remainder and is labelled as one.** Section 4 calls the third term "the
  roster and the schedule". It cannot be: no roster in this population is priced (section 1).
  The service returns it with `real_is` stating that it is the believed performance signal net
  of luck and noise. Giving a residual a physical name it has not earned is how a number
  becomes untrue.
- **G4 is weaker than it looks, and passing it is worth less than it appears.** An individual
  coefficient's sign is only identified when features are not collinear. `all_play_pct` and
  `win_pct` correlate 0.66, and on a synthetic fixture built with the two as noisier copies of
  one latent strength, the fit put −1.50 on the noisier one and G4 correctly failed a model
  that was not wrong. On the real panel it passes at all seven weeks with win_pct between
  +0.99 and +4.53, so the condition did not bite here — but it would not have caught a
  defect hiding behind collinearity either.

### 7.5 A defect in the fit itself, caught by a test rather than by a number

`solve` returned `row[n] / row[i][i]`, which indexes into a number and yields `undefined`, so
every coefficient came back `NaN`. Nothing threw. And `signCheck` then **passed** that fit,
because every comparison against `NaN` is false, so a check written as `got < 0` / `got > 0`
reports a model of pure NaN as correctly signed.

Two defects compounding: a silent arithmetic error, and a gate that could not see it. Both
are fixed, `fitLogistic` now refuses to return a non-finite fit at all, and
`test/team-outlook.test.js` carries a regression test for each. Worth stating plainly because
the first run of the gate reported "42 conditions failed" and looked like a result.

### 7.6 A field name that was read as a claim we cannot make

`decompose()` returned the neutral-state probability as `preseason`. Section 4 above
uses the same word, and it is wrong there too — but section 4 is pre-registration and
does not get edited after the fact, so the correction lives here.

The UI thread read the field name, not the header above it, and wrote *"only 12% of
that is what has actually happened — the rest is the preseason picture"* into its
design copy. A reader takes that as **our preseason projection of this roster**. There
is no such thing in this payload.

There is a per-player preseason model (`preseason-model.js`, surfaced through
`lineup-brain.js` and `draft-assist.js`), so the word is not unused in this codebase —
which makes the collision worse, not better. But it cannot be summed into a team's
preseason strength, for two reasons already measured: it covers skill positions only,
as does the projection engine (`projections.js:292` and `:300`, origin/main at 791b131,
both select `p.position IN ('QB','RB','WR','TE')`, so no row exists for a kicker or a
defence at all), and `players.sleeper_id` is populated for 751 of 8,556 players, so a
Sleeper roster cannot be priced against it without scoring a team badly for having
unmapped stars. That is the same measurement that kept projected lineup strength out of
the feature set in §1.

What the number actually is: this same fitted model with every result-derived feature
at its neutral value — what it says about a team in this league, at this week, whose
results we have not seen. It contains no information about who the players are.

Renamed to `no_results_yet`, with a test that fails if anything reintroduces the old
name. Nothing read the field yet, so no alias was kept.

**The general lesson, which is the reason this is written down.** A field name is read
by consumers who will never read the header above it, so the name has to carry the
claim by itself. The header here was already correct and explicit, and it did not stop
the misreading — the header is read by whoever edits the function, and the name is read
by whoever consumes it. This is the same shape as the rest of §7: a thing that looked
right to the person who wrote it and said something else to the person who used it.

Also corrected in passing: `weight_on_results` is a property of the league format and
the week, `games / (games + k)`, not of the team. Every team in a 12-team league at
week 2 gets the same value. Any surface that places it where it reads as team-specific
is making a different and false claim.

### 7.7 A contamination in the corpus, and the deliberate decision not to filter it here

`scripts/audit-team-week-spread.mjs` was reporting a pooled within-team spread of 517
points and a 10-team PPR mean score of 1,539. A fantasy team-week is neither. Sleeper
permits arbitrary scoring multipliers and a handful of leagues in the crawl use them: the
largest single team-week in the corpus is 10,150,072.8 points, and 23 leagues carry a week
above 400. That script now excludes a league whose median non-zero team-week falls outside
40–250 points, a band taken from the corpus (5th percentile 91.8, median 123, 95th 166.5)
rather than chosen, and it excludes whole leagues rather than weeks so no team's own spread
is ever clipped.

**Why it survived the first reading, which is the transferable part.** The conclusion that
audit exists to support is about the coefficient of variation, and a CV is scale-invariant
within a team: a league scoring ten thousand points a week still produces an ordinary CV
near 0.2. The column the argument rested on looked healthy on contaminated data while the
points columns beside it were nonsense. A ratio hides a scale error in its own denominator.

**That correction ate one of this document's own claims.** The audit reported 10-team PPR
at CV 0.226 against 12-team PPR's 0.198 and called the gap too large to dismiss. On clean
data they are 0.207 and 0.199. The gap was mostly the contamination; what the data supports
is one cv, not a table.

**The features here are NOT being filtered, and that is a decision rather than an
oversight.** `varianceComponents()` runs on `points_z`, normalised within each
league-season, so an off-scale league's weeks become ordinary z-scores and the fitted `k`
is unaffected by the scale. The residual exposure is a difference in *shape* rather than
level, across roughly 2.6% of leagues, and it is unmeasured. Adding the filter to
`weeklyPanel()` would change the fitted `k` and therefore every number in §7.1 — after the
gate had been run and reported. Refiltering the population until the gate reads better is
the move this document exists to prevent, whatever the motive.

**REVISIT WHEN:** someone wants the gate re-run for its own sake. Then apply the scale rule
to the panel, re-fit `k`, and re-run all four conditions as one pre-registered exercise, and
report both populations side by side. Not before, and never as a tidy-up inside another
change.

### 7.8 The reader was renamed, twice over, and §1 still names the old path

`docs/tdd/team-outlook.tdd.md` §1 cites `server/services/league-history.js` as the only
code that reads the crawled corpus. That file is now
**`server/services/history-corpus.js`**. §1 is pre-registration and is not edited after the
fact, so the correction lives here.

Two collisions, in order:

1. A different module called `league-history.js` arrived in PR #47 — it fetches ESPN league
   history over HTTP and **writes** it to the app database, behind migration 064. Two
   modules, one name, opposite directions, zero shared function names. Git reported
   `add/add`, so resolving that conflict either way would have lost one module outright.
   The name was the ESPN side's before either arrived:
   `scripts/backfill-league-history.mjs` and `test/helpers/seed-league-history.js` were
   already using it.
2. `sleeper-history.js`, the obvious second choice and the one suggested, is **also taken**
   — by the pure parsing layer this corpus is built with. Two files named
   `sleeper-*history*` next to each other would have moved the confusion rather than
   removed it.

So the three now read as what they each are: `collect-sleeper-history.mjs` crawls,
`sleeper-history.js` parses, `history-corpus.js` reads the database they produce.

Nothing about the module's contents, contract or measurements changed — the rename is the
whole diff, plus `test/league-history.test.js` becoming `test/history-corpus.test.js`. The
"one reader, one contract" rule of §1 still holds under the new name: `history-corpus.js`
is the only code that opens `data/derived/sleeper_history.sqlite`.

**Worth noticing rather than just fixing.** Two independent threads each wrote a module for
"league history" without either being wrong about the name, because the phrase describes two
different datasets in this project: the public crawl and Nick's own ESPN leagues. A name
that reads as obvious to its author is not evidence that it is unclaimed, and the only thing
that surfaced this was a merge someone ran on purpose. Neither module's tests could have.

---

## 7.9 The model could not run where it would be consumed, and what that changed — 2026-09-20

**The finding that reordered the work.** The Team Outlook model is unconsumed, and the
reason is not an oversight. It **cannot run on the deployed app at all**, by construction:

- `history-corpus.js:48` opens `path.join(process.cwd(), 'data', 'derived', 'sleeper_history.sqlite')`
  read-only and returns **null** rather than throwing when the file is missing.
- `Dockerfile`'s runtime stage copies exactly `--from=build /app/client/dist`, `server` and
  `scripts`. **`data/` is never in the image.** On Fly `process.cwd()` is `/app`, so that
  path does not exist and cannot.

`history-corpus.js`'s own header had already recorded that the corpus "is a derived artifact
built by `scripts/collect-sleeper-history.mjs`; it is not part of" the repo. The conclusion
was never drawn. So `fitOutlook`, `fitThresholds`, `verdictFor`, the k from
`varianceComponents` and the `no_results_yet` decomposition all work on a developer checkout
and return nothing in production.

This is worth recording in this file rather than only in a PR, because the shape recurs: a
module whose tests pass, whose audit script prints real numbers, and whose data source is
absent from the only environment anyone will read it in. **An `accepted_orphan_modules` entry
would have recorded the symptom and buried the cause.** The wiring question "what consumes
this?" has a second half — "and can it answer there?" — and only the first half was being
asked.

**A second, independent blocker underneath it:** no table in this database holds per-week
fantasy team scores. Checked against `core-and-fantasy.js` and every migration. So even with
a fit available, there was nothing to score for one of Nick's own leagues.

### What was built, and what was deliberately not

The second blocker is fixable without deciding where the fit lives, so that is what this
change does. It does **not** wire a consumer: a chip pointed at a verdict that resolves to
nothing in production is worse than the heuristic label it would replace, because the
heuristic at least renders.

**`weeklyPanel({ rows })`.** A caller may now supply rows in `regularSeasonWeeks`'s own
shape and every derivation runs on them unchanged. The alternative — a second implementation
of all-play, the shrunk z-score and `games_back` for app leagues — is the one outcome that
had to be avoided: the features would drift from the ones the model was fitted on and
nothing would say so. Supplied rows skip the two data-quality rules on purpose, because
those exist to drop abandoned and off-scale leagues from a public crawl, and a league Nick
is playing in is not a candidate for exclusion.

**`espnWeeklyRows(lg)`** reads `leagues.payload`, which has held the weekly scores since the
first sync: `routes/leagues.js:125` requests `view=mMatchup` and `:160` stores the entire
response. No table, no migration, no backfill — the data was already there.

### The row that must not exist

ESPN returns the whole season's schedule, and a week that has not been played comes back
with `totalPoints: 0` and `winner: 'UNDECIDED'`. **Admitting one zero is not one bad row.**
`weeklyPanel` computes the league-season mean and standard deviation from the rows it is
given, so a false zero moves the scale and `points_z` is then wrong for every *other* week
too — and the team with the most unplayed weeks reads as the worst team in the league. It is
the same failure the corpus has a league-level rule for (§7.7), arriving one row at a time.

A period is admitted only when it is **decided**, **both sides carry a number**, and **at
least one is above zero**. Three conditions, individually redundant and jointly necessary:

| Condition | The case only it catches |
|---|---|
| `decided` | a payload that carries `winner`, where a future week is 0-0 |
| `anyPoints` | a payload with **no `winner` key at all**, where "decided" reads true |
| `bothScored` | a malformed side with no `totalPoints` |

and `anyPoints` is `||` rather than `&&` because a completed week really can have a 0 on one
side. Mutating it to `&&` drops that week, which is the mirror of admitting an unplayed one.

### The fit refuses live rows

`made_playoffs` is the model's outcome, and for a season in progress it has not happened.
Live rows carry it as `null` with `outcome_known: false`. `fitOutlook` reads `made_playoffs`
as `y`, where `null` becomes `0`, so **a panel of live rows would fit a model of "nobody
qualifies"** — wrong signs, no error, no way to see it in the numbers. `fitOutlook` now
throws on `outcome_known === false`, strictly, so a corpus row that lacks the field entirely
is unaffected. The flag has to be carried explicitly through `weeklyPanel`, whose output
object is built field by field rather than spread; the first version dropped it there and
the guard silently did nothing, which is how that mutation was found.

### Mutations, as run

11 tests in `test/league-outlook-rows.test.js`. Every load-bearing line was reverted and the
file re-run:

| Reverted to | Result |
|---|---|
| every scheduled period admitted | 5 of 11 fail |
| `anyPoints` dropped | 1 fails — the winner-less payload |
| `anyPoints` as `&&` instead of `\|\|` | 1 fails — the real zero |
| postseason periods admitted | 3 fail |
| `outcome_known` not carried through `weeklyPanel` | 1 fails |
| the `fitOutlook` guard removed | 1 fails |

### Still open, and not this change's to close

Persisting the fit in this database — coefficients per week, the thresholds, the k and the
`through_season` they were fitted on — written by a script on a machine that has the corpus
and read at request time. That is a migration plus a store plus a writer, and until it
exists no consumer can be wired. `server/migrations/` already carries **two 062s** on main
(`062_google_identity_and_invites.js` and `062_league_payload_season.js`), so the number
needs deciding rather than guessing.

Also unclosed: whether the corpus is built on Nick's own clone, and therefore whether the
audit figures already published were measured on the full crawl or on his twelve
league-seasons.

### The shared producer: shape and module path — 2026-09-20

`espnWeeklyRows` is deliberately a shared producer rather than a Team Outlook
private, because per-week fantasy team scores per league-season are the missing
input under several hand-set thresholds elsewhere (a bye-risk multiplier, a waiver
constant, a contention grid's band, draft-board weights). One parser, one shape,
one place to correct.

**Module path:** `server/services/team-outlook.js`.
**Call:** `espnWeeklyRows(lg)`, where `lg` is a row of `leagues` carrying
`payload` (string or object), `payload_season` (migration `062_league_payload_season`),
`season`, and `league_id`/`id`. It reads nothing else and writes nothing.

**Returns** `{ rows, ok, reason?, season, num_teams, playoff_teams, weeks_played,
last_week, skipped_unplayed, skipped_postseason }`. `ok: false` always carries
`reason` in words: payload unreadable, never synced, or no schedule (the last means
the league was synced without `view=mMatchup`).

**Each row**, which is `regularSeasonWeeks`' shape so `weeklyPanel({ rows })` takes
it unchanged:

| field | source in the payload | parsed or inferred |
|---|---|---|
| `season` | `leagues.payload_season ?? leagues.season` | parsed; `payload_season` first because `syncEspnLeague` falls back to last season |
| `league_id` | `leagues.league_id ?? leagues.id`, as a string | parsed |
| `roster_id` | `schedule[].home.teamId` / `.away.teamId`, as a string | parsed |
| `week` | `schedule[].matchupPeriodId` | parsed |
| `points` | `schedule[].{home,away}.totalPoints` | parsed |
| `opponent_roster_id` | the other side's `teamId` | parsed |
| `num_teams` | `payload.teams.length` | parsed |
| `playoff_teams` | `settings.scheduleSettings.playoffTeamCount` | parsed |
| `made_playoffs`, `champion` | — | **null: the season has not finished** |
| `outcome_known` | — | **always `false`**, which `fitOutlook` refuses |

**What is inferred rather than read:** which periods count as regular season
(`matchupPeriodId <= settings.scheduleSettings.matchupPeriodCount`; a payload
without that setting admits every period), and whether a period was played
(decided AND both sides carry a number AND at least one is above zero — three
conditions because ESPN returns the whole season with `totalPoints: 0` and
`winner: 'UNDECIDED'` for unplayed weeks, a completed week really can have a 0 on
one side, and `winner` is absent from some payloads).

**A consumer wanting these as league-season features calls `weeklyPanel({ rows })`
and nothing else**, so the feature math is single-sourced; a consumer wanting raw
scores reads `rows` directly. Neither may pass them to `fitOutlook`, which throws on
`outcome_known: false`.
