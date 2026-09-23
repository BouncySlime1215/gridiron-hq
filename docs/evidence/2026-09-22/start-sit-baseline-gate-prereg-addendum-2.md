# Pre-registration addendum 2: the plan-rule verdict for the standing start/sit gate (C-01)

Filed under the Independent Auditor's ruling of 2026-09-22 on C-01
(`docs/handoff/local/audits/2026-09-22-C-01-ruling.md` on the handoff branch, acceptance item
A8). **Committed before week 3's first kickoff (2026-09-25 00:15Z), before any code change for
the ruling, and before any week-3 outcome exists.** The original pre-registration
(`start-sit-baseline-gate-prereg.md`, `a2ea8714`) and addendum 1
(`start-sit-baseline-gate-prereg-addendum-1.md`, `f55d2eb6`) are not edited.

What this file does:

- It registers a **new verdict**, the plan-rule verdict: the projection the app served against
  ESPN's weekly projection, which is plan item 12's "start highest projection" in Nick's ESPN
  leagues. It becomes the gate's top-level `verdict`, the gate that decides the stored governance
  audit, and the verdict in the job's `sync_log` detail that the Coach reads.
- The pre-registered ship rule H1 (prereg §8: G1-G4 against the season-to-date average) keeps
  running **exactly as registered**, renamed `average_check`. It is a floor check, reported
  beside the verdict and never as the verdict. No threshold, window or pair rule of H1 changes.
- Nothing in the app switches on or off by either verdict (prereg §8, unchanged).
- **Filing.** This commit's sha and time go to the coordinator's `WORKLOG.jsonl` (unit C-01), as
  the ruling's A8 asks, and into the evidence file (revision 4).

## 1. What was seen before filing

This verdict is **not** blind for 2026 week 2. Stated so nobody reads week 2 as a clean forward
test.

- **Arm B for 2026 week 2, and its variants** (ruling §2.2-2.3; local copy, not production):
  - At lock (addendum 1 §3 as registered): 153 rows, 286 disagreements, our pick won 0.3776,
    points per disagreement −3.4207, player-clustered 90% CI [−6.5246, −0.3637]. ESPN ahead.
  - ESPN's Thursday capture on the same 153 rows: −2.3490, CI [−5.7580, +1.1337].
  - ESPN's Thursday capture on every row it covers (342 rows): −2.2757, CI [−5.4234, +0.6708].
  - Every variant points ESPN's way. Only the at-lock one excludes 0.
- **Also seen:** arm A (served vs the season average: +3.4905, CI straddling 0) and H1's run
  (`beats_dumb`: G1 0.7958, G2 0.9566, G3 0.5256, G4 2.7923).
- **RL-1-1's 2026 week-2 numbers** (cited from the ruling §2.5, not reproduced here). Pair
  accuracy over our structural head: Sleeper +0.042 [+0.011, +0.074], FantasyPros ECR +0.034
  [+0.003, +0.065], ESPN on rostered players +0.020 [−0.021, +0.063]. Over 2023-24, ECR over the
  season-to-date average: +0.028 [+0.023, +0.034].
- **Week 3 and later outcomes: unseen.** Week 3 has not kicked off at commit time. The commit's
  own time (`git log --date=iso-strict`) is the record.
- **Week 2 stays in the window** (ruling (c).4). Its design was registered blind (addendum 1,
  17:18:46 -0400) before it was computed (about 17:30). Dropping a known-unfavourable week would
  be the flattering move.

## 2. Hypothesis and the dumb rule

- **H3.** Where the projection the app served and ESPN's weekly projection disagree about which
  of two startable same-position players to start, the app's pick scores more actual PPR points.
- **Ours (π).** `weekly_prediction_snapshots.prediction`, the pregame projection the app captured
  for that week (writer `server/services/weekly-learning.js:49` `captureWeeklyPredictions`, INSERT
  at `:63`; first write wins; refused once the slate starts). It is the ensemble projection, not
  the lineup's `week_points` (storing that is S-12). The incumbent start/sit rule is already
  "start the higher projection" (`lineup-brain.js#lineupCall` → `bestLineup(..., 'week_points')`,
  prereg §1, evidence file §9).
- **The plan's dumb rule (β).** ESPN's weekly projection, with the design **exactly as addendum 1
  §3**:
  - **One value per player-week.** If the synced leagues hold different values for the same
    player-week, it is excluded and counted, never averaged.
  - **Population, actuals and byes** come from the forward replay rows: players active in week
    W−1, byes removed, actual PPR with 0 for a player who did not play. Joined by (week, player);
    rows missing either projection are excluded and counted.
  - **Startable:** both players at or above 8.0 PPR by both rules. Same season, week and
    position (QB, RB, WR, TE). Each unordered pair once.
  - **A disagreement:** the two rules order the pair strictly and differently. A projection tie
    by either rule is no call.
  - **Grading and sign:** `win` is 1, 0.5 or 0 as our pick scored more, the same or less;
    `points` is our pick's actual minus ESPN's pick's actual. **Positive favours our projection;
    a win rate above 0.5 favours our projection.**
  - **Interval:** the player-clustered two-factor (pigeonhole) bootstrap of prereg §5, 90%,
    2,000 draws, seed 1, percentile.
- **No replay projection is graded by this verdict.** The replay (configuration B with the as-of
  champion, prereg §1 and §7) supplies only the population and the actual scores.

## 3. Window

- Every served week from 2026 week 2 on, **pooled, week 2 included**, up to the latest played
  week in `player_week_usage`. A week is **graded** when it has at least one disagreement.
- The window is itself 2026 forward data. There is no past window for β: ESPN past-season
  projections are HX-01's, under their own pre-registration, with 2025 left out.
- **The served model's identity is recorded per week:** the capture time and the `weight_fit`
  (the served ensemble's weight set) of that week's snapshot rows, in `forward.served.weeks`.
- **A change of served model is reported as its own sub-window beside the pooled one.** The first
  planned change is S-03 at week 5 (2026-10-08); a week whose `weight_fit` differs from the week
  before counts as a change too. The sub-window is descriptive: the verdict reads the pooled
  window only. The code that reports sub-windows is not part of the ruling's acceptance items; it
  is a named follow-up, due before the gate first grades a week served on a changed model.

## 4. Sources, and which one decides

- **At lock.** ESPN's value from `league_roster_snapshots.projected_points`, rows with
  `source = 'final'` (writer `scripts/collect-roster-snapshots.mjs:109` `writePeriod`, value built
  at `:92`), read after the period ends. It can carry news from after our snapshot (addendum 1 §3,
  limit 1; 127 of 153 week-2 values moved by more than 0.01 points between Thursday and lock).
  That **favours ESPN**. So the at-lock source **can support `beats_dumb`** (a pass against a
  favoured opponent is conservative) **but never `loses_to_dumb`**.
- **Same cutoff.** ESPN's projection captured alongside our snapshot (RL-1-1's capture), or our
  served number captured at lock (S-12), graded with the same design. Neither exists in the
  repository at commit time. Until one lands, the same-cutoff source is `not_available`, and the
  gate can only pass or stay `not_shown` (ruling §5.1).
- **Which decides.** Once the same-cutoff source has **4 or more graded weeks**, it alone decides
  the verdict. Until then the at-lock source decides. The deciding source is reported as
  `plan_rule.source`: `espn_at_lock` or `espn_same_cutoff`.

## 5. The verdict

A pure function of the deciding source's pooled grade. Each gate is strict: a bound sitting on
the line has not cleared it.

- **P1:** pooled points per disagreement, player-clustered 90% CI lower bound > 0.
- **P2:** pooled win rate, player-clustered 90% CI lower bound > 0.5.
- **P3:** at least 4 graded weeks.

| verdict | condition |
|---|---|
| `beats_dumb` | P1 ∧ P2 ∧ P3 on the deciding source (at lock or same cutoff) |
| `loses_to_dumb` | the deciding source is same cutoff, P3 holds, and the pooled points player-clustered 90% CI upper bound < 0 |
| `not_shown` | anything else, with a `reason` (below) |
| `instrument_fault` | the prereg §7 oracle or identity control failed; no verdict is drawn |

`not_shown` reasons, checked in this order:

1. `too_few_weeks`: fewer than 4 graded weeks on the deciding source, including none.
2. `espn_ahead_at_lock_only`: the at-lock source decides, it has 4 or more graded weeks, and its
   points CI upper bound is < 0. That is a loss the source cannot support.
3. `not_distinguishable`: 4 or more graded weeks, and neither a pass nor a loss.

- **Every state also carries:** the **direction** (the sign of the deciding source's pooled points
  per disagreement: `ours_ahead`, `dumb_ahead`, `even`, `no_disagreements`, or `not_available`
  when the source is not graded), the **weeks graded**, and the **MDE** at 80% power (§6).
- **Week-clustered criterion: none.** The week-clustered interval is still reported, but no
  plan-rule gate reads it. One can be added only by a later addendum, at a cluster count that its
  own null calibration supports, calibrated the way evidence §4 calibrated G2 (4/40 false passes at
  28 clusters against a nominal 2/40). Below 2 week clusters the week interval is null (ruling A7).
- **Fields:** `plan_rule {verdict, reason, source, weeks_graded, direction, gates: [P1, P2, P3],
  mde80, prereg}`, with `prereg` naming this file.
- **On the data already seen (§1):** the deciding source is at lock, with 1 graded week and ESPN
  ahead. The rule gives `not_shown`, reason `too_few_weeks`, direction `dumb_ahead`. Written here so
  the first run of the fixed gate can be checked against it.

## 6. Power

- MDE80 = (1.6449 + 0.8416) × SE, where SE is the player-clustered bootstrap SD (prereg §5). It is
  reported with every verdict that is not a pass.
- **Declared from the expected SE** (STATS-METHOD rule 4). Week 2 at lock, in the ruling's run:
  SE 1.9022 points (MDE80 4.73 points per disagreement) and SE 0.0752 in win rate (MDE80 0.187), on
  286 disagreements among 69 players.
- **Guess:** if weeks behaved like independent draws, 4 weeks would halve the SE, giving an MDE80
  of about 2.4 points and 0.094 in win rate. The same players recur across weeks, so the realised
  SE will shrink more slowly than that.

## 7. Where the verdict goes, and what Nick sees

- **Payload.** Top-level `verdict` = `plan_rule.verdict`. `average_check {verdict, gates: G1-G4,
  rule, prereg}` carries H1 exactly as computed before, under its own name.
- **Governance store.** A gate `PLAN`, passed only when `plan_rule.verdict` is `beats_dumb`, is
  added to G1-G4 in the call to `recordGateAudit`. So `model_gate_audits.verdict` is `blocked`
  unless both the plan rule and the floor pass.
- **`sync_log` detail (the Coach reads it).** `verdict` = the plan rule, `average_verdict` = H1.
  Directions and verdicts only, no rate or size (standing rule 3).
- **Panel heading:** "Does our projection beat ESPN's projection?", with the line "The plan's dumb
  rule: start whoever ESPN projects higher."
- **Chip wording, every state:**

| state | chip | line under the chip |
|---|---|---|
| `beats_dumb` | emerald, "Beats ESPN's projection" | "Over at least four weeks where they disagreed, our pick scored more than ESPN's, and it held up under the test set before the numbers." |
| `not_shown` | amber, "Not shown to beat ESPN's projection" | the weeks measured and which pick scored more, e.g. "In the one week measured (2026 week 2), ESPN's pick scored more."; when the at-lock source decides, "ESPN's number was read at lineup lock, after news our projection did not have, which favours ESPN."; then "Until this passes, treat our start/sit calls as no better than ESPN's projection." |
| `loses_to_dumb` | rose, "Loses to ESPN's projection" | "Measured at the same cutoff over at least four weeks, ESPN's pick scored more where they disagreed. Treat our start/sit calls as worse than ESPN's projection." |
| `instrument_fault` | slate, "Could not grade" | "The gate's own check failed (a perfect-foresight pick found no edge on these rows), so no verdict was drawn." |
| not run yet | slate, "Not measured yet" | "The weekly gate job has not stored a result yet." |
| a stored result from before this addendum (no `plan_rule`) | slate, "Not measured against ESPN's projection yet" | "This stored result was graded before the plan's rule was added; the next weekly run grades it." |

- **Which pick scored more, in words** (the `not_shown` line): `ours_ahead` "our pick scored more",
  `dumb_ahead` "ESPN's pick scored more", `even` "the two came out even", `no_disagreements` "the two
  never disagreed on a startable pair", `not_available` "no week has been graded against ESPN's
  projection yet".
- **Emerald appears only for a plan-rule `beats_dumb`.**
- **The floor, below the chip,** as plain text with no chip and no green: 'Weaker check, set before
  the numbers: against "start the higher season average", our pick scored more in 2024-2025 and in
  2026 week 2 replayed.' If the floor stops passing (`average_check` is `beats_dumb_unconfirmed_forward`,
  `not_distinguishable` or `loses_to_dumb`), that line becomes a rose warning.
- **"Weeks our projection lost":** all four groups stay, ESPN's first.

## 8. Known limits, stated now

1. **At-lock values carry later news, which favours ESPN.** The at-lock source can only pass or
   stay `not_shown`; it can never return a loss.
2. **Rostered players only** (the synced leagues): 153 of 360 forward rows in week 2.
3. **PPR, not each league's scoring items;** a league-wide pool of pairs, not a roster.
4. **Repeated looks.** A standing gate is re-read every week, so over a season its false-pass rate
   is above a single look's 5% (repeated significance tests on accumulating data; Armitage,
   McPherson & Rowe 1969, *JRSS A* 132(2)). The 4-week floor and the two joint interval conditions
   are the only guard. No alpha spending is applied.
5. **2026 forward looks.** Each weekly plan-rule grade is a look at 2026 (STATS-METHOD rule 5). Its
   row belongs in `docs/evidence/HOLDOUT-LEDGER.md`, "2026 forward looks", a file this unit does
   not own. The coordinator records it.
6. **The served snapshot is the ensemble projection,** not the lineup's `week_points` (S-12).

## 9. Grounding

Grading a forecast by the decisions it drives is decision-based forecast evaluation (Pesaran &
Skouras 2002), and the two rules are compared on identical decisions, as in Diebold & Mariano
(1995, *JBES* 13(3)). The interval is Owen's (2007) pigeonhole bootstrap, because each player
recurs on both sides of many pairs. A benchmark that is itself a skilled forecast, ESPN's
projection, is the harder bar the plan names; the naive season average (Hyndman & Koehler 2006,
*IJF* 22(4)) stays as the floor.
