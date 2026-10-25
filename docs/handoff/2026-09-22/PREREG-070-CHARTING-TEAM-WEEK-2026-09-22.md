# Pre-registration — charted columns as team-week features

**Planner, 2026-09-22. Written BEFORE any code**, per the coordinator's
condition and `PLAN-05` §3g.3. Tree: `claude/project-thread-2oztzw` at
**`4a8085c`** (`origin/main` at `f620a12`). Every figure below carries that
tree, because the inventory is tree-dependent — see §5.

---

## 0. READ THIS FIRST — the unit as assigned cannot serve 2026

The unit was assigned as "the migration-070 nflverse columns
(`was_pressure`, `defense_man_zone_type`, `defense_coverage_type`,
`time_to_throw`) as features". Checking what production does with the quantity
**before** fitting anything — gate-1 item 4, the rule added this afternoon —
turns up a problem that changes the unit rather than a detail inside it.

**`nfl_play_formations` has exactly one writer**, `ingestFormations` at
`nfl-formations.js:89`, and it fetches
`pbp_participation/pbp_participation_${season}.csv`. Measured on the release
path this branch already uses: **2022-2025 return 206, 2026 returns 404.**

So the 070 columns are **history-only, 2016-2025**. They can train and they can
validate. They **cannot serve a live 2026 week**, which is the season the app is
projecting.

And that is precisely the gap migration 059's own header was written about:

> "Man/zone participation data stops at 2025; FTN charting is published weekly
> for 2026 and carries the pressure and target-quality signals that exist live"

**So there are two different units here, and they are not interchangeable:**

| | 070 columns (participation) | 059 columns (FTN charting) |
|---|---|---|
| seasons | 2016-2025 | includes 2026, published weekly |
| can serve a live week | **no** | **yes** |
| coverage in `nfl_team_week_features` today | **0** | **0** |

**Recommendation: build the 059 unit, and use 070 only as history.** Building
070 alone produces a feature that is fit on seasons it can never be served in —
a fit/serve mismatch designed in from the start, and the fifth of the day. If
the Auditor wants 070 built anyway, it should be registered explicitly as a
**history-only feature for training and validation**, never as a serving input,
and that decision should be written where the feature is defined rather than
discovered later.

The rest of this pre-registration is written for the **059** unit on that
recommendation, with the 070 columns entering only as held-out history.

---

## 1. (a) CLAIM — one sentence

Team-week aggregates of the FTN charting columns already ingested into
`nfl_play_charting` — blitz rate, pressure rate, target quality — carry
information about team-week outcomes that the 91 play-by-play-derived features
in `nfl_team_week_features` do not, and adding them lowers held-out error
against the current feature set.

**Falsifiable as stated.** If the charting aggregates add nothing beyond
play-by-play, the decomposition in §3 returns an information component whose
interval covers zero, and the unit closes as a null — which is a result, not a
failure.

## 2. (b) FILE:LINE, on a reachable tree

All at `4a8085c`, all read rather than inherited:

| fact | citation | verified |
|---|---|---|
| builder of `nfl_team_week_features` | `nfl-pbp.js:563`, `writeTeamWeeks`, INSERT at `:564` | yes |
| charting references in that file | **zero** — `grep -c` for `charting\|nfl_play_charting\|n_blitzers\|was_pressure\|defense_coverage_type` returns **0** | yes |
| feature key suffixes | **91 distinct**, at `:447-559` | yes |
| the 059 columns | `059_play_charting_ftn_columns.js:10-13` | yes |
| sole writer of `nfl_play_formations` | `nfl-formations.js:89` | yes |
| consumers inheriting the gap | `nfl-team-tendencies.js:5` ("183 features each"), `nfl-ensemble.js:2446` (`team_features: 'nfl_team_week_features'`) | yes |

**Line and count corrections, under `PLAN-05` §3g.2.** The routing gave
`nfl-pbp.js:539` and "88 feature suffixes at `:440-545`". On this tree the
builder is at `:563` and there are **91** suffixes at `:447-559`. Main moved
between the two readings; nothing is wrong with the original measurement, and
this is the method note in the bracket file doing its job — **a figure quoted
without its commit is not a figure.**

**One consumer-count correction.** The routing said five of the 059 columns have
exactly one consumer. Measured here it is **six** — `n_blitzers`,
`n_pass_rushers`, `created_reception`, `read_thrown`, `interception_worthy` and
`qb_fault_sack` each reach only `nfl-formations.js`. `catchable` has three
consumers. `drop_` cannot be counted this way at all: as a substring it matches
`drop_table` and similar across a dozen unrelated files, so any count of it by
grep is noise. Recorded because a count nobody can reproduce is worse than no
count.

## 3. (c) EVIDENCE — command, metric, n, held-out split

- **Command.** A committed script under `docs/evidence/`, runnable, reporting
  every number here. No figure enters the write-up that the script does not
  print.
- **Metric.** Held-out MAE on the team-week target, **with mean signed error
  reported beside it on everything** (§3g.1). MAE is a median-type statistic on
  a right-skewed target — recurring defect #6 — so a decomposition that reports
  only MAE hides a level shift.
- **Decomposition.** `total = level + information`, **mandatory regardless of
  how the primary comes out** (§3g.3 item 2). A gain that is all level is a
  rescale, not a feature.
- **n.** Stated per arm from the rows the script actually reads, not from a
  table. Bootstrap intervals are **player-clustered** where the unit of
  repetition is a player, team-clustered where it is a team-week.
- **Held-out split.** **2025 is held out and is not touched during fitting.**
  Fit on seasons through 2024, validate on 2025. Recorded in the holdout ledger
  with the date it was first read.
- **Gate 1 power check (§3g.3 item 1).** Before the real run: fit an **oracle**
  version on the eval season's own answers and compare the effect it produces
  with the test's own resolution. The oracle is biased upward by construction,
  so a stand-down on that comparison is conservative. **If the oracle cannot
  clear the resolution, this unit is not run.**
- **Tie-breaks pre-registered.** Aggregation choice (rate vs count per team-week)
  and the minimum charted-plays threshold are fixed **here**, before any result
  is seen, not chosen afterwards.

## 4. (d) INCUMBENT TO BEAT

**Coverage today is 0** for both the 059 and the 070 columns: no charting-derived
value reaches `nfl_team_week_features`, so the incumbent is the current 91
play-by-play features, unchanged, and the bar is a real reduction in held-out
error against exactly that set — not against a simplified baseline.

Concretely: the 183 features `nfl-team-tendencies.js:5` describes under the
X's & O's page are all play-by-play-derived. The charting layer the app already
pays the ingest cost for reaches one service, `nfl-formations.js`, and stops.

## 5. PRODUCTION CAVEAT — stated up front, not in a footnote

**Nobody has shown that `nfl_play_charting` has rows in production.** Neither
the rig nor any read has established it. Explorer's read script settles it when
Nick runs it.

Until then, every number this unit produces is a claim about **the development
database**, and it carries that scope on the result itself rather than in a
caveats section — the same discipline R42 scoped to the two misclaiming callers.
**If the production table is empty, the unit is not a feature improvement, it is
a backfill item**, and it joins the QBR crosswalk row in `PLAN-09` §4.

This is not a reason to delay the pre-registration. It is a reason to know which
answer we are holding before the numbers arrive.

## 6. WHAT I WILL NOT DO

- **The Sharp Football source is refused on licence.** I have not opened it, will
  not read it, and nothing here derives from it. Explorer's package is cited only
  for the repository-side gap, which is on our side of that line.
- **No code before the Auditor rules**, including the 070-vs-059 question in §0.
- `nfl-pbp.js` is granted to me for this unit and I will edit nothing else.

## 7. THE FIVE QUESTIONS

1. **What would make this wrong?** If `nfl_play_charting` is empty in production
   (§5), or if the charting aggregates are collinear with play-by-play pressure
   proxies already in the 91 — in which case the information component is a null
   and the unit closes.
2. **What is the incumbent?** The 91 play-by-play features, with charting
   coverage at exactly 0.
3. **How big is it?** Unsized on purpose. Sizing it is the unit's job; a
   pre-registration that predicts its own effect size has pre-registered nothing.
4. **What did I check that came back clean?** That the builder genuinely has no
   charting reference — a grep count of 0, not an eyeball — and that
   `nfl_play_formations` has exactly one writer, which is what makes the 2026
   finding in §0 solid rather than inferred.
5. **What is still open?** The 070-vs-059 decision in §0, and the production read
   in §5. Both are with the Auditor and Nick respectively, and neither is mine
   to settle.

---
---

# REVISION 1 — Auditor R56, 2026-09-22 17:42Z

R56 ruled: **build on 059, not 070**, with one condition, and held the
registration on three blocking text items. Nothing has been run against a model.
The §0-§7 above stand as written; everything they say that this revision changes
is superseded **here, in text**, not by overwriting them.

**The condition is accepted in full.** FTN charting (`ingestCharting`,
`nfl-formations.js:138-139`, `ftn_charting/ftn_charting_${season}.csv`) and
nflverse participation (`ingestFormations`, `:89`,
`pbp_participation/pbp_participation_${season}.csv`) are **different sources for
"pressure"** and are not pooled. The 059 feature is fit only on seasons where FTN
charting exists; 070 rows enter **only as a crosswalk**, never as training rows.

**The FTN window, stated by command.** Same probe method as the participation
finding in §0, run 2026-09-22:

```
for s in 2019..2026; curl -sL -r 0-0 -o /dev/null -w '%{http_code}' \
  https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_${s}.csv
```

| season | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|
| FTN charting | 404 | 404 | 404 | **206** | 206 | 206 | 206 | **206** |
| participation (§0) | — | — | — | 206 | 206 | 206 | 206 | **404** |

**First FTN season: 2022.** The window is 2022-2026. With 2025 held out that is
**three fitting seasons — 2022, 2023, 2024** — one validation season, and 2026
live. **That is a short window and it is stated rather than padded: gate 1
decides whether it is enough, and if the oracle cannot clear the test's own
resolution the unit is not run.** No season is borrowed from participation to
make it longer; that is precisely what the condition forbids.

**Crosswalk scope.** Both feeds exist for **2022-2025**. The crosswalk asks one
question — do FTN and participation pressure agree on the plays they share? — on
2022-2024, with 2025 held out like everything else. It produces an agreement
rate, not a training row.

---

## BLOCKING 1 — SCOPE. Answered by re-pointing the unit, not by arguing.

R56 is right and the finding is decisive. On the record it cites,
`nfl_team_week_features`' only **predictive** readers are the betting game model.
Its fantasy readers are descriptive. Under Nick's scope rule that ends the unit
as written — so the unit moves to a fantasy consumer rather than being defended.

**The fantasy weekly projection has a live opponent-matchup seam that currently
returns exactly 1.**

`matchups.js:365`:

```js
export function gameMultiplier(opponent, home, position) {
  return dvpFor(opponent, position).mult * homeFieldFactor(home);
}
```

with `DVP_MULTIPLIER_ENABLED = false` (`:66`) and
`HOME_FIELD_MULTIPLIER_ENABLED = false` (`:67`). Two other services say so
independently in their own comments — `trade-engine.js:356-359` ("exactly 1 while
the matchup signal is off") and `season-sim.js:218-220` ("exactly 1 in its tested
state"). The seam is wired; the value is null.

**(i) FANTASY TARGET.** Player weekly fantasy points, PPR. The metrics are the
ones `MATCHUP_EVIDENCE` already publishes for the incumbent — MAE and Spearman —
**with mean signed error added beside them**, because MAE is a median-type
statistic on a right-skewed target (recurring defect #6) and the published
baseline does not carry a level term.

**(ii) FANTASY CALL SITE.** `matchups.js:365`, `gameMultiplier(opponent, home,
position)`, via `dvpFor(...).mult` at `:340`. The new arm is a **fifth candidate
behind a third switch constant, default OFF**, flipped only if it passes the same
test the other four failed. Nothing bends a projection on merge.

**(iii) CALL-REACH PATH, fantasy route to the multiplier.** Not import reach, and
nothing through `scheduler.js`:

```
routes/trades.js:19  → matchups.js  (matchupModel, matchupSignalActive)
                     → trade-engine.js:60, which reads thisGame.mult at :359,
                       passes it at :399 and :408 to playerWeekDistribution
                     → player-week-engine.js:802  sampleWeeks(params, …, mult)
                     → projections.js:945         sampleWeeks(…, mult)
                     → projections.js:825         sampleWeekEvents(params, mult)
                       where mPass/mRush scale attempts, carries and targets.
```

Two more fantasy paths reach the same value: `routes/nfldata.js:3` →
`scheduleOutlook()` → `games[].mult` (`matchups.js:414-419`), and
`season-sim.js:24` → `gameMultiplier` → `sampleWeeks` at `:227`. A fourth,
`ceiling-lineup.js:34`, is UI's file and is named for completeness only.

**Why this is the right hypothesis and not a rescue.** The four arms
`MATCHUP_EVIDENCE` already killed are **outcome aggregates** — points allowed to
a position, and home/away. DvP failed for a stated reason: first-half to
second-half r = +0.027, so the thing being measured barely persists. Charting
rates are **behavioural, not outcome**: how often a defense blitzes and how many
rushers it sends. Whether they persist better is an empirical question this unit
answers, and **persistence is measured first, on the feature alone, before any
outcome is touched** — if a charted defensive rate does not carry from the first
half of a season to the second any better than DvP's +0.027, the unit closes
there and no projection is ever run. That is a cheaper falsification than the
full test and it comes first.

**The registration's claim, restated for the new target.** Opponent charted
scheme rates, aggregated to the defending team-week from `nfl_play_charting`,
make the fantasy weekly projection more accurate than the incumbent multiplier of
exactly 1, on the same walk-forward test that rejected DvP and home field.
Falsifiable the same way: if the interval covers zero, the switch stays off and
the module gains a fifth row in `MATCHUP_EVIDENCE` saying so — which is a
result, and is the form this module already uses for its failures.

---

## BLOCKING 2 — the actual values, fixed here, before anything runs.

**Every aggregate is a RATE, never a count.** A count encodes pace: a team that
runs 70 plays blitzes more times than one that runs 55 without blitzing more
often. Rates are per **defending team-week**, since the consumer is an opponent
adjustment.

| aggregate | definition | denominator |
|---|---|---|
| `blitz_rate` | share with `n_blitzers >= 1` | charted dropbacks |
| `heavy_rush_rate` | share with `n_pass_rushers >= 5` | charted dropbacks |
| `mean_pass_rushers` | `AVG(NULLIF(n_pass_rushers, 0))` | charted dropbacks |
| `catchable_rate` | share with `catchable = 1` | charted targets |
| `drop_rate` | share with `drop_ = 1` | charted targets |

`NULLIF` on `n_pass_rushers` and the `n_pass_rushers > 0` gate on `n_blitzers`
are the treatments this project already measured and wrote down, not new
judgements — a blanket `NULLIF` on `n_blitzers` lands **3.41x high** (1.3095
against a true 0.3838) where the original bug was 0.21x low.
See `docs/evidence/feed-zero-contamination-measured.md`.

**Threshold N = 20 charted dropbacks per team-week.** Fixed now. A rate on 20
Bernoulli trials at p = 0.3 has a standard error of 0.102; below that the
sampling noise approaches the whole between-team spread of blitz rate, so a
smaller N would be measuring the charting sample rather than the defense. N does
not move after a result is seen.

**Below N, the behaviour is DROPPED, then FLAGGED — never imputed.**

1. The team-week rate is NULL.
2. The consumer falls back to that team's **prior-weeks season-to-date** rate
   (strictly `week < W`, the same walk-forward rule `td-features.js:262-271`
   states for this table family).
3. If the fallback is also below N, **the multiplier for that matchup is 1** —
   the incumbent — and never a league mean. Imputing the league mean would invent
   an opponent adjustment out of an absence, which is the defect class this
   thread has spent the day removing.
4. Every fallback and every held-at-1 matchup carries a **reason string** in the
   served object, in the shape `matchups.js` already uses (`signal: false` with a
   `reason`). A layer that goes inert says so; it does not go quiet. That is
   `CLAUDE.md`'s rule, and this project has shipped two bugs of the other shape.

The count of team-weeks in each of the three states is **printed by the script**,
not summarised, so a run where most weeks fell through to 1 cannot read as a run
where the feature applied.

---

## BLOCKING 3 — the incumbent, defined by a command.

R56 is right that the old incumbent was two different numbers: **91** distinct
feature key suffixes at `nfl-pbp.js:447-559`, against **"183 features each"** at
`nfl-team-tendencies.js:5` — and 183 is also today's withdrawn inventory figure,
so quoting it would be quoting a number already struck. Neither is usable.

**Re-pointing the unit dissolves the ambiguity rather than resolving it.** The
incumbent is no longer a feature count. It is a **value**:

> `gameMultiplier(opponent, home, position) === 1` for every opponent, every
> home flag and every position, with `DVP_MULTIPLIER_ENABLED = false` and
> `HOME_FIELD_MULTIPLIER_ENABLED = false`.

and its published baseline is `MATCHUP_EVIDENCE.baseline_2025` — MAE **4.333**,
Spearman **0.6789**, DNP MAE **4.730**, CRPS **3.107**, on
`weekly-backtest replaySeasonWeekly`, weeks 5-18, fit 2023+2024, validated on
2025 once, paired bootstrap clustered by player, 90% CI.

**The command** — committed with the unit, printed before any arm is fitted, and
asserting rather than describing:

1. Print `DVP_MULTIPLIER_ENABLED`, `HOME_FIELD_MULTIPLIER_ENABLED`,
   `matchupSignalActive()` and `MATCHUP_EVIDENCE` as read from the module.
2. Call `gameMultiplier(o, h, p)` across every opponent × {home, away} ×
   {QB, RB, WR, TE} and print the count, the distinct values, and
   `max |mult − 1|`. **Assert the distinct set is exactly `{1}`**; the run aborts
   if it is not, because then the incumbent is not what the module says it is.
3. Re-run the incumbent arm of the backtest and print MAE, Spearman, CRPS **and
   mean signed error**, so the comparison is against a number reproduced on this
   tree rather than against a literal copied out of a frozen object.

If step 3 does not reproduce `baseline_2025` within its own bootstrap interval,
**that is the finding and the unit stops there** — a stale published baseline is
worth more than a matchup feature.

---

## Non-blocking items — all accepted

- **Clustering: TEAM-SEASON, not team-week.** Accepted; team-week is the unit of
  observation, so clustering on it is iid and would understate the interval. The
  player-clustered bootstrap stays for the fantasy-points target, since that is
  what `MATCHUP_EVIDENCE.method` used and the comparison must match.
- **Oracle gate-1 check**: accepted, unchanged, and it runs **after** the
  persistence check described above.
- **Production caveat**: becomes a raw `COUNT(*)` and `MIN/MAX(season)` of
  `nfl_play_charting` in Explorer's pristine census. The coordinator is asking
  Explorer. §5 above stands until that lands: **if production holds no charting
  rows this is a backfill item, not a feature.**
- **`drop_` needs a column-name match, not a substring grep.** Accepted, and
  measured: `grep -rnE "\bdrop_\b" server/ --include=*.js`, excluding
  migrations, returns **exactly 2 hits**, both in the writer
  (`nfl-formations.js:154` and `:164`). So `drop_` has **zero consumers** — not
  one, and not uncountable. The §2 note called it uncountable, which was the
  right caution for the wrong reason: the grep was wrong, not the column. It is
  a seventh charted column that reaches nothing, which strengthens the
  coverage-is-0 incumbent rather than weakening it.
- Line and count corrections accepted.

## Five questions, for the revision

1. **What would make this wrong?** Charted defensive rates persisting no better
   than DvP's r = +0.027 — checked first, on the feature alone. Or an empty
   `nfl_play_charting` in production. Or a three-season fitting window too short
   for gate 1.
2. **What is the incumbent?** The multiplier of exactly 1, asserted by command,
   with MAE 4.333 / Spearman 0.6789 on 2025 — reproduced on this tree, not
   quoted.
3. **How big is it?** Unsized on purpose. A pre-registration that predicts its
   own effect has pre-registered nothing.
4. **What did I check that came back clean?** The FTN window by HTTP probe
   (2022-2026, 2026 live), and the call-reach path from `routes/trades.js` to
   `sampleWeekEvents`, hop by hop, rather than by import reach.
5. **What is still open?** Explorer's production census, and the Auditor's word
   on this revision. No code until it rules.

---
---

# REVISION 2 — Auditor R59(2), 2026-09-22 17:56Z

Revision 1's §BLOCKING 1 named the wrong hop and the wrong site. Corrected here
in text; revision 1 stands as the record of what was claimed and is superseded
where this says so. Text only, nothing run.

## The site was wrong. `gameMultiplier` is not on the trade path.

R59(2) is right and I did not read far enough. **`trade-engine.js` never calls
`gameMultiplier`.** `thisGame` comes from `scheduleOutlook`, and
`scheduleOutlook` recomputes the product itself:

`matchups.js:414-419`, inside `scheduleOutlook`'s `scored` map:

```js
const d = dvpFor(g.opponent_abbr, position);
…
mult: +(d.mult * homeFieldFactor(g.home)).toFixed(3),
```

which is `gameMultiplier`'s body (`:366`) written out a second time. A factor
placed at `:365` therefore reaches **only `season-sim.js`** (`:221`), not the
trade path at all.

**The one function both `:365` and `:419` read is `dvpFor(opponent, position)`,
`matchups.js:340`.** Both call it and both multiply its `mult` by
`homeFieldFactor`. So the charted term enters **`dvpFor`'s returned `mult`**, and
from there it reaches every consumer of either path with no second site to keep
in step.

**A cleaner alternative, which is not mine to take.** `matchups.js:362-363` asks
for exactly this in its own words — "ceiling-lineup.js and season-sim.js
hard-code `dvpFor(...).mult * (home ? 1.02 : 0.98)` themselves and should call
this instead" — so collapsing `:419` onto `gameMultiplier` would leave one site
rather than two. **That is a second change to the file and my grant is one
additive arm behind a third switch constant, nothing else**, so it needs the
coordinator's word. **Default, needing no grant change: `dvpFor` at `:340`.**

## Hop 1 corrected

`routes/trades.js:19` imports `dvpTable`, `matchupModel`, `matchupSignalActive`
and `MATCHUP_SIGNAL_REASON` — **display only**, as R59(2) says. The real path:

```
routes/trades.js:15   → trade-engine.js
trade-engine.js:260     assetUniverse()
             :268       buildAssetUniverse()
             :335       scheduleOutlook(p.team_abbr, p.position, …)
             :348       thisGame = sched.games.find(g => g.week === target.week)
             :359       POINTS   currentWeekBasePpg * thisGame.mult * activeProbability
             :399/:408  VOLUME   playerWeekDistribution({ …, mult })
                        → player-week-engine.js:802 → projections.js:945 → :825
season-sim.js:227       VOLUME   sampleWeeks(pr.params, …, mult, …)
```

## The multiplier is consumed in two forms. The graded one is POINTS.

`matchups.js:31-33` states the graded form and I should have quoted it rather
than described it:

> "the live weekly blend (weekly-backtest.js#replaySeasonWeekly, weights fit-1,
> weeks 5-18) multiplied by each candidate matchup multiplier, **exactly as
> trade-engine applies thisGame.mult to current_week_ppg**"

**Declared graded form: POINTS, `trade-engine.js:359`.** That is what
`MATCHUP_EVIDENCE` graded and what the incumbent's numbers mean.

**The VOLUME form is graded too, not inherited.** Scaling points is linear in the
mean; scaling volume passes through a negative binomial and then through
efficiency and touchdown draws, so it moves the **distribution**, not only the
mean — and start/sit and ceiling decisions read the distribution. Grading one and
shipping both would be the fit/serve mismatch this thread has spent the day
naming. So the volume arm is graded on the same walk-forward test **with CRPS as
a reported metric beside MAE**, since CRPS is the one that can see a
distributional change. If the points arm passes and the volume arm does not, only
the points arm's switch is eligible, and the volume call sites keep 1.

**Ship rule: not invented here.** `matchups.js:33-35` already pre-registers one
and it is adopted verbatim — MAE improves with the **player-clustered 90% CI
entirely below zero**, Spearman **no worse than −0.002**, DNP-included MAE **no
worse**.

---

## BLOCKING 2 (a) — how the rates become one multiplier

**They do not. One rate becomes one multiplier; the rest are never in it.**

- **Primary aggregate: `heavy_rush_rate`** (share of charted dropbacks with
  `n_pass_rushers >= 5`). One aggregate, chosen now, before any outcome.
- **Form:** `mult = 1 + beta * z`, where `z` is the opponent's `heavy_rush_rate`
  standardised within season. **One parameter, one direction.**
- **Fit window:** `beta` fit on **2022 + 2023 + 2024**, applied unchanged to
  2025. Never refit on 2025.
- **`blitz_rate` and `mean_pass_rushers` are NOT in the candidate.** They are
  reported as correlates of the primary in the persistence test only, so that a
  reader can see whether the primary is representative — not to be swapped in if
  it disappoints, which is what an unfixed aggregate set would allow.
- **`catchable_rate` and `drop_rate` are OUT entirely** — see (d).

## BLOCKING 2 (b) — the persistence rule, as a test

- **Primary:** `heavy_rush_rate`. **Unit: team-season.**
- **n = 96 team-seasons** (32 teams × 2022, 2023, 2024). Stated, not discovered.
- **Statistic:** within-season split-half correlation — the first half of a
  team-season's charted dropbacks against the second half — pooled Pearson r
  across the 96, with Spearman reported beside it.
- **Interval:** bootstrap **clustered on team-season**, 90% CI, 2000 resamples.
- **RULE: the unit proceeds only if the CI's LOWER bound exceeds 0.20.**

`r > 0.027` was not a test and R59(2) is right to say so — 0.027 is DvP's point
estimate, not a threshold, and comparing a point to a point decides nothing.
**0.20 is fixed here**: an order of magnitude above DvP's point estimate, and far
below what a genuinely behavioural rate should show, so it can fail. If the lower
bound does not clear it, the unit closes and no projection is ever run.

## BLOCKING 2 (c) — table corrected to match the SQL

The sibling gate was in revision 1's prose and missing from its table, and the
`NULLIF` denominator was misstated. Both corrected:

| aggregate | definition | denominator |
|---|---|---|
| `heavy_rush_rate` **(primary)** | share with `n_pass_rushers >= 5` | charted dropbacks **with `n_pass_rushers > 0`** |
| `blitz_rate` | share with `n_blitzers >= 1` | charted dropbacks **with `n_pass_rushers > 0`** |
| `mean_pass_rushers` | `AVG(NULLIF(n_pass_rushers, 0))` | **rows with `n_pass_rushers > 0`**, which is what `NULLIF` leaves |

The gate is the same one the feed-zero sweep measured: the sentinel zeros are
uncounted plays, so leaving them in the denominator inflates it and depresses
every rate. `mean_pass_rushers`' denominator is the non-zero rows by
construction — `NULLIF` removes them from the average, not from the table.

## BLOCKING 2 (d) — the per-target rates, and whether they belong at all

**They do not, and they are withdrawn from the candidate.** `catchable` and
`drop_` are **receiver-side target quality**. Putting them in an opponent
multiplier would charge the defense for the receiver's hands. They remain
reported descriptives and nothing fits on them.

**So there is exactly one N, and it is unambiguous:** `N = 20` charted dropbacks
per team-week, applying to the three defence-side rates. There are no per-target
rates in the candidate, so no second N is needed.

---

## BLOCKING 3 — condition accepted

Step 3's replay runs in **configuration B, as declared for #121**:
`roleRecency: WEEKLY_ROLE_RECENCY` passed explicitly (`weekly-ensemble.js`, the
same symbol `player-week-engine.js:273` and `player-head-validation.js:75` pass),
**`kOverride` omitted** so `pickK` (`projections.js:211-212`) falls through to the
hardcoded K, and **`K.share = 6`** as the stop control.

**Step 3 prints its configuration** — those three values read from the objects
themselves, not from a literal in the script — before it prints any metric.

**Tolerance, since `baseline_2025` carries no interval.** Reproduce MAE within
**±0.010** of 4.333 and Spearman within **±0.0020** of 0.6789. The four arms the
module already rejected moved MAE by +0.0004 to +0.0043, so a drift larger than
±0.010 is bigger than anything this test was built to resolve and means the
configuration is not the one that produced the baseline. **Outside tolerance the
unit stops and that is the finding.**

## Five questions, revision 2

1. **What would make this wrong?** The split-half lower bound failing to clear
   0.20 — checked first, on the feature alone. Or step 3 missing the baseline
   tolerance. Or an empty `nfl_play_charting` in production.
2. **What is the incumbent?** `dvpFor(...).mult === 1` everywhere, both switches
   false, MAE 4.333 / Spearman 0.6789 reproduced in configuration B on this tree.
3. **How big is it?** Unsized on purpose.
4. **What did I check that came back clean?** That `scheduleOutlook:419`
   recomputes the product rather than calling `gameMultiplier` — which is what
   made revision 1's site wrong — and that `dvpFor:340` is read by both.
5. **What is still open?** Whether `:419` may be collapsed onto `gameMultiplier`
   (outside my grant), Explorer's production census, Nick's answer on fleet size,
   and the Auditor's word on this revision.

---

## Coordinator's ruling on the site, 2026-09-22 18:03Z

**The declared site is `dvpFor` at `matchups.js:340`. `scheduleOutlook`'s inline
product at `:419` is NOT collapsed.** The grant stays one additive arm behind a
third switch constant, and nothing else in the file.

**The collapse is recorded as a separate finding** for whoever owns
`matchups.js` later: `:362-363` asks for it in the file's own words, and while
`:419` duplicates `gameMultiplier`'s body, the two must be kept in step by hand.
That is a real hazard — a future change to one and not the other would give the
trade path and the season simulator different multipliers without any test
noticing — but it is not this unit's to fix.

---
---

# REVISION 3 — Auditor R62(2) CLEARED with three conditions, 2026-09-22 18:08Z

Revision 2 is cleared. The three conditions are accepted as written and recorded
here **in text, with nothing run**. The unit stays unbuilt; this thread pauses
after #92.

## (a) `z` must be WALK-FORWARD

Revision 2 said "standardised **within season**". That is wrong for the same
reason DvP built early in a season is wrong: a within-season standardisation
uses the season's full distribution, including weeks after the one being
projected, so the feature would know something the projection cannot.

**Corrected:** `z` is standardised against the **season-to-date league
distribution, strictly `week < W`** — the same inequality `td-features.js:262-271`
states for this table family. Early weeks therefore have a wide, unstable
standardisation, and that is a real cost carried openly rather than smoothed
away: the N = 20 threshold and the fallback chain in revision 1 §BLOCKING 2 are
what handle it, and the count of team-weeks in each fallback state is printed.

## (b) ONE switch, so the rule is JOINT

Revision 2 treated the points and volume arms as separately shippable. They are
not: **the declared site is `dvpFor` (`matchups.js:340`), and one value there
feeds both** — POINTS at `trade-engine.js:359` and VOLUME through the sampler.
One switch cannot be flipped for one consumer and not the other.

**Joint rule, declared now:**

> Flip the switch **only if both arms pass**. Points must pass the adopted ship
> rule (`matchups.js:33-35`: MAE improves with the player-clustered 90% CI
> entirely below zero, Spearman no worse than −0.002, DNP-included MAE no
> worse), **and** volume must pass that same MAE rule **with CRPS no worse**.

**If the outcome splits — one arm passes, the other does not — the switch stays
off and that is the result.** Shipping the passing arm alone would need a
separate grant, because it would mean either changing the site or gating one
consumer, and neither is in this registration. Recording the split as a finding
is the whole of what happens without that grant.

## (c) The k control is INVERTED relative to #121

Revision 2 copied #121's configuration B and wrote "`kOverride` omitted so
`pickK` falls to the hardcoded K" as a *setting*. R62(2) is right that this has
it backwards. **The incumbent is the app as served**, and `projections.js:206-209`
says what the app actually does:

> "NOTE, and it is the reason this picker looks inert in production: no fitted
> k has ever been persisted. `shrinkage_fits` and `shrinkage_k` are both empty,
> so `activeKVector()` returns null and every call takes the hardcoded branch."

So the hardcoded branch is not a configuration this unit chooses — it is what
production resolves to, and choosing it is only correct for as long as that
stays true.

**Corrected control:** the script **prints the resolved `target_share` k** and
**stops if it differs from what production resolves**. The expected value is
sourced from the **pristine census count of `shrinkage_fits` and
`shrinkage_k`**: both empty means the hardcoded branch, and a non-zero count
means a fit has landed since and the whole comparison basis has moved. Either
way the control states which it saw before any metric is printed.

## Non-blocking, accepted

A **cluster-on-team sensitivity line**: the primary interval clusters on
team-season, and the same interval clustered on **team** is reported beside it.
If the two disagree materially, that is reported rather than resolved — the
choice of cluster is a modelling judgement, and a reader is owed both numbers.

## Status

**The persistence check may run later without these three** — it touches no
outcome and no k. **It does not run now.** The thread pauses with #92 landed;
the unit stays unbuilt with revisions 1-3 on the record.
