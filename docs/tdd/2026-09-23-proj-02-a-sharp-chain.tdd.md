# PROJ-02-a sharp chain: links on every projection, graded link by link

Unit PROJ-02-a (TRADE-INSANE-RND Layer 2 v2 item 2, "Sharp chain"; ONE ENGINE stage 2,
UNDERSTAND). Branch `claude/local-proj-02-a-sharp-chain`, based on `origin/main`
`62f9530a`. Every number below: local copy of the app database (not production), made
2026-09-23 with `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"`.

**Verdict.** Every projection from `buildProjections` now carries
`links: {plays, pass_rate, share, volume, eff, td}`. Team shares sum to 100% over each
team's as-of roster (hard rule holds on every team-week of the 2023, 2024 and 2026-W2
replays; max deviation 0.0011%). Per the pre-registered rule: **plays and pass rate are ON**
(they beat the incumbent in 2023, in 2024, pooled, and forward). **Targets and carries keep
the incumbent**: normalized targets tie today's number (interval straddles 0), and
normalized carries are worse. So the served weekly number (`ppg`, `params`) is unchanged
for all 3,323 players checked.

## 1. Audit: extend or build

Written before any number, in `docs/evidence/2026-09-23/proj-02-a-sharp-chain-preregistration.md`
section 1 (commit `de40645f`). Summary: extend `teamVolume` (`server/services/projections.js:372`),
the per-player shares (:595-605 on `62f9530a`) and read `gameScriptFor`
(`server/services/gamescript.js:389`). Nothing was refit and no new producer was made.
- **Win probability.** `gameScriptFor` returns no win-probability number. Its spread term,
  a walk-forward OLS on spread and total (`fitObservations`, `gamescript.js:320`), is the
  script effect. The chain reads it. It does not create a second win-probability producer.
- **Why volume stays pre-script.** `fantasy-coordinator.js:312,409`, `season-sim.js:360` and
  `nfl-props.js:59` already multiply `params` by `pass_mult`/`rush_mult`. Scripted volume in
  `params` would count the script twice. So the script lives only in `links.plays` and
  `links.pass_rate`.
- **Table and writer.** Table `player_week_usage`, writer `syncWeeklyUsage`
  (`server/services/nflverse.js:247`, INSERT at :262). `target_share` there is nflverse's
  targets / team targets. The old `targets = share x pass_att` (:607 on `62f9530a`)
  therefore assumed a target rate of 1. The chain multiplies by the measured team target rate.
- **Prior evidence against conservation.** In `opportunity-redistribution.js` (off by
  default), conserving vacated volume hurt 2025 MAE. The carries result below agrees with it.
- **Scoring.** `scoreSim` is now at `server/services/scoring.js:173` (the row cited :157). It
  is unchanged and still runs last, through `expectedPoints` (`projections.js:906`).

**Stale drafts, not depended on.** Both edit the same file, so they will conflict.
- #88 (`effk`, projection-range): imports (:30), the K comment (:94), a new `rangeBand`
  after `positionalPriors` (:442), the top of `buildProjections` (:459) and the output
  object (:748). This unit also edits the imports (adds `gameScriptFor`), the region after
  `teamVolume`/`positionalPriors`, and the end of `buildProjections`.
- #44 (sim basis): imports (:28) and a `resolveRecency`/`predictingSeasonFor` block after
  `positionalPriors` (:442). Same regions as above.

## 2. Commits (RED / GREEN)

| order | sha | subject |
|---|---|---|
| 1 | `de40645f` | docs: pre-register PROJ-02-a sharp chain (audit, links, ship rule per link) |
| 2 | `4e242266` | test: RED for PROJ-02-a sharp chain links and per-team share normalization |
| 3 | `659c79d6` | feat: PROJ-02-a sharp chain links on every projection (plays, pass rate, normalized shares, volume, eff, td) |
| 4 | `c259749f` | test: PROJ-02-a per-link study script (pre-registered, local copy only) |
| 5 | `a7de3e70` | feat: PROJ-02-a ship decisions per link (plays, pass rate served; targets, carries keep incumbent) |
| 6 | this commit | docs: PROJ-02-a evidence, holdout-ledger forward rows |

**RED:** `4e242266` (test: RED for PROJ-02-a sharp chain links and per-team share
normalization). On the unfixed code, all 6 tests fail. The first failing assertion is
`assert.ok(p.links, \`${p.name} has no links\`)`, which fails with `'AAA-stale has no links'`,
and the hard rule fails with `Cannot read properties of undefined (reading 'share')`.

**GREEN:** `659c79d6` (6/6 pass), then `a7de3e70` (7/7 pass, the ship decision pinned).

**Liveness.** After the test-3 assertion was corrected (it compared an unrounded value with
the rounded `targets_per_game`), RED was re-run against `origin/main`'s `projections.js`:
`# fail 6`, `# pass 0`.

Command:
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/proj-02-chain.test.js`

## 3. What it does

`attachChain` (`projections.js:933`) is called at the end of `buildProjections` (:901)
and adds these links:
- **plays.** Pace, `pass_att + rush_att` (teamVolume's shrunk values), times the predicted
  week's script from `gameScriptFor(team, through, throughWeek + 1)` (:939). It is neutral at
  a season-boundary cutoff or when no line exists.
  - `incumbent`: the team's plain season-to-date average plays.
  - `team`: `{pass_att, rush_att, target_rate}`.
- **pass_rate.** `pass_att x pass_mult / plays`. The incumbent is the season-to-date pass
  rate. `script` holds `{pass_mult, rush_mult, spread, total, week}` or `null`.
- **share.** `target_share` and `carry_share` normalized over the as-of roster: players whose
  current team has a row in its last `ROSTER_WEEKS = 3` played weeks (:433, :599). The raw
  shrunk shares come with them. Off-roster players get `roster: false`.
- **volume.** `targets` = share x team pass att x team target rate. `carries` = share x team
  rushes. Each is `{chain, incumbent, served, value}`, pre-script.
- **eff, td.** The existing shrunk rates. `td.expected_tds` is on the served volume.
- **Target rate.** Team targets / team pass attempts, recency-weighted like `teamVolume` and
  shrunk to the league rate with `K.team_volume` = 10 weighted games. That k is **hand-set**:
  no fitted k exists for this metric.
- **What is served.** `CHAIN_SERVED` (:452) is `{plays: true, pass_rate: true, targets: false,
  carries: false}`. When a volume link is served, `ppg`, `points` and `params` are re-scored
  through `expectedPoints`. That path is currently inactive.

**Consumer.** `GET /api/model/projections` (`server/routes/model.js:425`) returns the full
projection objects, `links` included.
- It calls `buildProjections({ through, scoring })`, a season-boundary cutoff, so its
  `plays.chain` is neutral pace.
- The in-season path is the weekly engine, `player-week-engine.js:271`
  (`throughWeek: week - 1`). It reads `ppg`, which this unit leaves unchanged.
- PROJ-04 is the named future reader of `links`.

## 4. The numbers

Rig: configuration B. That means `roleRecency: WEEKLY_ROLE_RECENCY` and no `kOverride`,
with k from `activeKVectorFor`. For 2023 and 2024 that is the walk-forward refit
`cutoffSafeKVector`; for 2026 it is stored fit #1.

**k control passed** (`k_control` in the output). Fitted `target_share.ALL` was 0.4605
(2023), 0.2747 (2024) and 0.1733 (2026). None is the hand-set 6.

**Scope of the run.** Weeks 2-18, walk-forward as-of. Sign: `chain - incumbent` MAE, so a
negative number favours the chain. Intervals are 90% cluster bootstrap (B = 2,000, seed
20260923), with clusters = team for the team links and player for the player links.

**Command** (tree `c259749f`):
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite node docs/evidence/2026-09-23/proj-02-a-sharp-chain-study.mjs > docs/evidence/2026-09-23/proj-02-a-sharp-chain-output.json`
The output is committed in `a7de3e70`. The later change to `CHAIN_SERVED` only moves
`links.*.value` and `served`. The study reads `.chain` and `.incumbent`, so the numbers do
not depend on it.

| link (unit) | 2023 chain / inc / diff | 2024 chain / inc / diff | pooled diff [90% CI] | MDE 80% | forward 2026 W2 diff | verdict |
|---|---|---|---|---|---|---|
| plays (plays/team-game), n 512+512 | 6.929 / 7.358 / -0.429 | 6.714 / 7.367 / -0.653 | -0.541 [-0.645, -0.434] | 0.161 | -3.125 (n 32) | **ON** |
| pass rate, n 512+512 | 0.0803 / 0.0853 / -0.0050 | 0.0803 / 0.0862 / -0.0059 | -0.0055 [-0.0078, -0.0032] | 0.0035 | -0.0303 (n 32) | **ON** |
| targets (per played game), n 5,138+5,171 | 1.4549 / 1.4566 / -0.0017 | 1.4649 / 1.4660 / -0.0010 | -0.0014 [-0.0108, +0.0082] | 0.0144 | -0.0105 (n 329) | incumbent kept (tie) |
| carries (per played game), n 5,138+5,171 | 1.2477 / 1.2332 / +0.0145 | 1.2462 / 1.2253 / +0.0209 | +0.0177 [+0.0017, +0.0339] | 0.0246 | -0.0344 (n 329) | incumbent kept (worse) |
| targets, DNP counted as 0 (secondary) | -0.0908 | -0.0900 | -0.0904 [-0.0992, -0.0817] | 0.0134 | -0.1645 | secondary only |
| carries, DNP counted as 0 (secondary) | -0.0951 | -0.0673 | -0.0812 [-0.0959, -0.0668] | 0.0221 | -0.1953 | secondary only |

**How to read the targets tie.** The pre-registered rule needs the pooled interval
entirely below 0. It is not. The MDE is 0.0144 targets per game, so the test would have
caught an effect of that size. The observed -0.0014 is a tenth of it. That is a tie, not
an unmeasured effect.

**The DNP-included rows are not a reason to ship.** The chain wins there because
normalizing over a roster lowers per-player volume. That lower number stands in for the
missing availability term. It is the same finding as the target-share-prior ruling of
2026-09-22 (`projections.js` block above `targetSharePrior`), so it is recorded and not
acted on.

**Hard rule on the replay.** The `red` block of the output covers every roster team-week:
- 2023: 544 team-weeks, max target deviation 9.1e-6, max carry deviation 1.4e-5.
- 2024: 544 team-weeks, 1.1e-5 and 1.3e-5.
- 2026 W2: 32 team-weeks, 6.6e-6 and 8.9e-6.

**Known-nonzero control for that check.** The same sums over the *incumbent* volume,
2024 W5/W10/W15: 96 of 96 team-weeks miss by more than 0.5%. The max target deviation is
0.3828 and the max carry deviation 0.6849. The command was an inline `node -e` over
`links.volume.*.incumbent` on this branch.

**Served number unchanged.** `ppg`, `points`, `params.targets` and `params.carries` were
compared for every player between `origin/main`'s `projections.js` and HEAD. Cutoffs were
2024 W9 in-season, 2026 W2 in-season, and through 2025 at the season boundary (evidence
rows only, no outcome read). Result: 3,323 players, 0 changed, max absolute change 0. The
known-nonzero case for this comparison is mutant M6 (serving the targets link), which
fails test 7.

**Decision grade (d, e).** Start/sit pair accuracy: same position, same week, both played,
did the higher structural `ppg` score more (PPR).
- 2023: incumbent 0.7429, chain-volume head 0.7427 (227,971 pairs).
- 2024: 0.7486 vs 0.7495 (227,178 pairs).
- There is no decision change either way. No volume link is served, so the start/sit
  number a user sees does not move.
- Consensus and ESPN baselines are not available to this rig. HX-01 owns that comparison;
  it is not claimed here.

## 5. Mutation sweep

Command: `python3 docs/evidence/2026-09-23/mutate-proj-02-a.py` (tree `a7de3e70` plus the
script). Unit and call-site mutants are included (M4, the week passed to `gameScriptFor`;
M5, the `attachChain` call).

| mutant | expected | result | failing tests | as designed |
|---|---|---|---|---|
| M1 unit: no normalization (raw share) | kill | kill | 1 | yes |
| M2 unit: drop team target rate | kill | kill | 1 | yes |
| M3 unit: roster = everyone on the team | kill | kill | 2 | yes |
| M4 call site: script read for the cutoff week, not the predicted week | kill | kill | 1 | yes |
| M5 call site: attachChain never called | kill | kill | 7 | yes |
| M6 unit: targets link served | kill | kill | 1 | yes |
| M7 unit: pass/rush multipliers swapped | kill | kill | 1 | yes |
| M8 unit: ROSTER_WEEKS 3 -> 30 | kill | kill | 2 | yes |
| M9a unit: season-average plays recency-weighted | kill | kill | 1 | yes |
| M9 DESIGNED SURVIVOR: incumbent pass-rate rounding 4 -> 5 decimals (test tolerance 1e-4) | survive | survive | 0 | yes |
| M10 NOT-APPLIED CONTROL: pattern absent from the file | not_applied | not_applied | - | yes |

**Recorded as it happened.** In the first sweep, M9a was the designed survivor, and it was
**killed**. The fixture's stale 2022 AAA rows make the recency-weighted average differ from
the plain one, so test 5 pins the plain average. M9a now stays as a kill row, and a
rounding mutant replaced it as the designed survivor.

## 6. Holdout looks

- **2025.** No outcome was read. `assertNotHoldout` in the study refuses season 2025. No
  `L` row was added.
- **2026 forward.** Week 2 was graded as a forward look: one week, an anecdote. Four `F`
  rows (F016-F019) were appended to `docs/evidence/HOLDOUT-LEDGER.md` "2026 forward looks".
  The ids may collide with unmerged branches' `F` rows; whichever merges second renumbers.

## 7. Known defects and what this does not cover

- **Targets and carries are not served.** The shares-sum-to-100% rule holds on the links,
  but the served volume is still the incumbent, which does not sum to the team total (see
  the control in section 4).
- **TD link not built.** Red-zone share x the team's implied TDs is not built. `links.td`
  is the incumbent rate and says so in `basis`.
- **Targets per route.** Target share from routes x targets per route run
  (participation/FTN) is not built. A licence check would come first.
- **Plays and pass rate were graded in-season only.** The grade covers in-season weeks 2-18
  with a script. At a season-boundary cutoff (the `/api/model/projections` route), the
  served `plays.value` is neutral pace, which was not graded against a full-season incumbent.
- **The plays incumbent is weak.** It is a raw season-to-date average. Whether the script
  adds anything over neutral shrunk pace was not tested; it was not pre-registered.
- **QB attempts** stay the incumbent (a QB is not a share of team attempts in this unit).
- **The roster rule is crude.** "Played for the team in its last 3 weeks" misses a starter
  returning from a 3+ week absence and keeps a player whose injury started this week. That
  is the likely reason normalized carries lose.

## 8. Nick's five questions

1. **Well built?** The chain is one pure pass inside the one producer. It reads the one
   script producer and writes no table or column. The hard rule is tested on a fixture and
   checked on every replay team-week. Ten designed mutants behave as designed.
2. **Stats or made up?** Stats. Each link is graded against actuals on two seasons plus a
   forward week. `ROSTER_WEEKS = 3` and the target-rate k (10) are hand-set; that is a
   **guess**, pre-registered and not tuned.
3. **How we know.**
   - Backtest: 2023 and 2024 weeks 2-18, walk-forward, MAE, cluster-bootstrap 90% CI.
   - Plays: -0.54 plays per team-game. Pass rate: -0.0055. Targets: tie. Carries: +0.018,
     worse.
   - Forward 2026 W2: all four links negative. That is one week, an anecdote.
4. **Pointed anywhere else?** `GET /api/model/projections` (`model.js:425`) returns `links`.
   No page reads them yet; PROJ-04 is the named reader. Served `ppg` is unchanged, so
   Start/Sit, Waivers and Trades see no difference.
5. **How it unifies.** The script still has one producer (`gameScriptFor`), and the pace
   still has one producer (`teamVolume`). No second win-probability or plays number exists.
   The links are the chain's single record, which PROJ-04 and the Monday Autopsy can grade.

- **Defect or gap fixed.** No projection exposed its chain, and nothing made team shares
  sum to the team total (`projections.js:595-607` on `62f9530a`). The implicit target rate
  of 1 (:607) is now measured on the link.
- **Incumbent, by command.** Season-average plays and pass rate, plus today's
  `targets_per_game`/`carries_per_game`. All are in the study output, `mae_incumbent`.
- **Not covered.** See section 7.
- **What would make it wrong.** Any of these:
  - `gameScriptFor`'s cutoff refit leaks the predicted week. It uses `week <` in
    `observations`; not re-audited here.
  - The roster rule is systematically stale.
  - A weekly consumer starts reading `links.plays.value` *and* applying the script again.
