# The standing start/sit gate: our projection vs "start the higher average"

Unit C-01 (plan item C12). Branch `claude/local-c-01-startsit-baseline-gate` off
`origin/main d6d7bd5a`. Pre-registration: `docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md`,
committed at `a2ea8714` before any number was run.

## 1. Audit: what already exists, and extend-or-build

Written before the first test. Every line is on `d6d7bd5a`.

| piece | what it is | decision |
|---|---|---|
| `server/services/weekly-backtest.js:88` `replaySeasonWeekly` | the walk-forward replay; `_decision_rows` (`:163-170`) is the decision population already: players active in W−1, graded with 0 when they do not play | **reuse, unedited.** The gate calls it with configuration B and an as-of champion head |
| `server/services/backtest-significance.js:57` `pairedBootstrapDiff` | paired bootstrap with one cluster key per unit | **reuse, unedited,** for the week-clustered CI. It cannot express the player-clustered CI: a start/sit pair has **two** players, and a unit gets one key. The gate adds a two-factor (pigeonhole) resampler for that one shape |
| `server/services/lineup-posture.js:292`, `:405` | the two places the app *tells* the user "start the highest projection" (no opponent; a neutral matchup) | **not edited.** They state the rule as advice; nothing measured whether it beats a model-free version. That is what this gate measures |
| `server/services/lineup-brain.js:268` `DECISION_CURVE` | a static tail-rate curve measured on a research-baseline projection (startable MAE 6.085), 2018-2025, not production's projection | **not edited; disagreement named.** The gate reports each rule's pair accuracy on the same ≥ 8.0 startable universe, but on production's replay predictor and on 2024-2026. The two numbers describe different projections, so they will not match. C-10 (`lineup-brain.js:268` → tracked rate) is the named follow-up that should read this gate's rows |
| `scripts/promote-early-week-weights.mjs:153` `startSitPairAccuracy` | the one existing pair-accuracy producer (script, report-only): same week and position, every model ≥ a threshold, ties 0.5 | **one definition, two call sites.** The gate's pair accuracy is pinned equal to it on a shared fixture by a test, so the two cannot drift apart |
| `server/services/gate-verdicts.js` | pre-registered ship rules as pure functions | **pattern followed** (the verdict is a pure, tested function), file not edited (another thread's) |
| `scripts/fit-weekly-coverage.mjs:72-75` `production()` | configuration B as a helper: `kOverride: undefined`, `roleRecency: WEEKLY_ROLE_RECENCY`, ensemble head | **same shape,** except the head is the **as-of** champion (`activeWeeklyWeightSet({season, week})`), not a pinned fit: the gate grades what production would have served that week |
| `server/services/model-governance.js:154` `recordGateAudit` → `model_gate_audits` | immutable, hash-deduplicated gate-result store, verdict computed from `gates[].passed` | **reuse as the store, no migration.** Rows carry `sport = 'FANTASY'`, so the betting readers (`nfl-research.js:269` `gateAudits('NFL')`, `nfl-evidence.js:109` count of `sport='NFL'`, `routes/nfl-market.js:217` promote with `'NFL'`) never see them |
| `server/services/scheduler.js` `JOBS` | no gate job exists | **build:** `start_sit_gate`, growth tier, `offThread: true`, weekly cadence. B-17 (ops calendar, not built) will map it to a day |
| `client/src/pages/Lineup.tsx` | no gate panel | **build:** one panel on the existing page; nav stays 8 tabs |

Grep for other producers of the same concept (start/sit decision rate, pair
accuracy, "highest projection") on `d6d7bd5a`:
`git grep -n -i "decision win rate\|highest projection\|pair accuracy\|startSitPair" -- server client/src scripts`
returns only `lineup-posture.js:292,405`, `weekly-ensemble.js:40` (a quoted
0.605 → 0.626 from the early-week gate), `td-features.js:36` (a comment) and
`scripts/promote-early-week-weights.mjs:59,149,153,341`. Control for the grep:
the same command finds `startSitPairAccuracy`, a producer known to exist.

**Decision: extend.** Reuse the replay, the week-clustered bootstrap and the
governance store. Build only the pieces nothing does: the pair builder, the
two-factor resampler, the verdict, the job, the route and the panel.

## 2. RED → GREEN

- **RED** `d7c37773` "test: RED for the standing start/sit gate vs 'start the higher average'".
  43 tests, **43 fail**: `test/baseline-gate.test.js` 0/13, `test/start-sit-gate.test.js` 0/19,
  `test/start-sit-gate-surface.test.js` 0/11. The first failing assertion in each file:

  > `ifError got unwanted exception: Cannot find module '…/server/services/gates/baseline-gate.js'`

  and on the surface side, the ones that name the gap rather than the missing module:

  > `JOBS.start_sit_gate is not registered` · `the wiring map does not see start_sit_gate` ·
  > `ENOENT: … client/src/components/lineup/StartSitGate.tsx`

- **One assertion changed after RED, before GREEN:** the index-mount test expected a static
  `import gatesRouter from './routes/gates.js'`; `server/index.js` imports every router
  dynamically after `runMigrations` (`:21-23`), so the test now expects
  `const { default: gatesRouter } = await import('./routes/gates.js');`. RED re-run with the
  changed tests on the RED tree (detached worktree of `d7c37773`): **0/13, 0/19, 0/11**, still all red.
- **GREEN** `42310804` "feat: standing start/sit gate, our projection vs 'start the higher average'".
  **43/43 pass** (13 + 19 + 11), command:
  `GRIDIRON_DB_PATH=$(mktemp -u …).sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js`.
- `bc17b7a9` sizes the job's budget from the measured run and adds `scripts/run-start-sit-gate.mjs`.
- `7f888374` "test: close the seven mutation survivors of the gate sweep": two tests added and four
  strengthened, implementation unchanged (§6). One assertion was loosened on purpose: the passing
  weeks of the failing-weeks fixture now include a break-even week, so `=== 5` became `>= 0`.
  **45/45 pass** (15 + 19 + 11).
- **Wiring:** `node scripts/wiring-map.mjs --check` on `7f888374`: **exit 0**, no finding names
  the gate, its route, its job or `model_gate_audits`; `no missing-feed findings`. The full
  `npm run check` is the Gate phase's single run and was not run here.

## 3. What it does

| piece | file | what |
|---|---|---|
| gate interface | `server/services/gates/baseline-gate.js` | `gradeDecisions(decisions)` → win rate, points per decision, player-clustered (two-factor pigeonhole) and week-clustered (`pairedBootstrapDiff`) 90% CI, SE, MDE at 80% power, every week, every failing week. `baselineGateVerdict({past, forward})` is the pre-registered rule. C-02 and C-03 pass their own disagreements in |
| start/sit gate | `server/services/gates/start-sit-gate.js` | k control → `replaySeasonWeekly` in configuration B with the as-of champion head → byes removed → startable same-position pairs → disagreements → grade → oracle and identity controls → verdict. `refreshStartSitGate` stores; `latestStartSitGate` reads |
| store | `model_gate_audits`, writer `model-governance.js:154 recordGateAudit` | `sport = 'FANTASY'`, `market = 'start_sit'`, `evidence_json` = the whole result. **No migration**: the table exists (legacy schema, `server/db/schema/mlb-model-misc.js:195`) |
| route | `server/routes/gates.js`, mounted `server/index.js` `app.use('/api/gates', ...legacyAuthenticated, gatesRouter)` | `GET /api/gates/start-sit` reads one row; `status: 'not_run'` before any run, `'unreadable'` if the stored JSON is corrupt |
| job | `server/services/scheduler.js` `JOBS.start_sit_gate` | growth tier, `offThread: true`, `maxAgeMinutes` 7 days, `timeoutMs` 10 min. **Weekly now; B-17 (ops calendar, not built) will give it a day.** An instrument fault returns `error`, so `sync_log` records it |
| page | `client/src/components/lineup/StartSitGate.tsx`, rendered in `Lineup.tsx` | verdict chip in plain words, the headline numbers with their 90% ranges, the forward line, the MDE when it did not pass, every failing week as a chip, and "What was compared" (both rules, the universe, scoring, sign convention, the replay limit, when it was measured). Nav unchanged (8 tabs) |
| manual run | `scripts/run-start-sit-gate.mjs` | prints configuration, then controls, then the result; `--store` writes like the job |

## 4. The numbers (local copy, not production)

Data basis: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"`,
sha256 `6d33a780121d98701a3d0c795cff188e9350b5e6d5568b39b8f45f9f50d6c7f3`, **local copy, not
production.** Code: `42310804` (tree `b42d25a63988e898399b4dd6f42b02a7c3d5a69e`; the run script, then untracked,
was committed unchanged in `bc17b7a9`). Command:

```
GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite GRIDIRON_DB_INTEGRITY_CHECK=off SCHEDULER_DISABLED=1 \
  node scripts/run-start-sit-gate.mjs --iterations 2000
```

52.7 s wall, 330 MB peak RSS (`/usr/bin/time -l`), load average ~23 at the time.

**Configuration, printed before any metric:** roleRecency `{"seasonDecay":0.05,"weekHalfLife":5}`
(WEEKLY_ROLE_RECENCY, passed explicitly); kOverride omitted. **k control** (resolved
target-share k, stop if 6): 2024 **0.2747** (refit on ≤ 2023), 2025 **0.2086** (refit on ≤ 2024),
2026 **0.1733** (stored fit 1, through 2025). None is 6, so the run proceeded. **Champions:**
`frozen-2023` for every graded week of 2024 and 2025; `fit-2` for 2026 week 2.

**Known-nonzero control first** (same rows): oracle **n = 10,131, win rate 1.0, +6.90** points per
disagreement; identity **n = 0**. Controls passed.

**Result: verdict `beats_dumb`.** Sign convention: points = our pick minus the dumb pick; positive
favours our projection.

| window | disagreements (of startable pairs) | our pick won | points per disagreement | player-clustered 90% CI (points) | week-clustered 90% CI (points) | win rate player CI |
|---|---|---|---|---|---|---|
| **past, 2024 + 2025, weeks 5-18** | **6,633** of 52,297 (they agreed on 87.3%) | **55.0%** | **+1.37** | **[+0.80, +1.94]** | **[+0.96, +1.77]** (28 weeks) | [52.6%, 57.3%] |
| 2024 alone | 3,634 of 27,846 | 53.2% | +0.89 | [+0.02, +1.68] | [+0.36, +1.35] | [49.7%, 56.4%] |
| 2025 alone (held out) | 2,999 of 24,451 | 57.2% | +1.95 | [+1.16, +2.75] | [+1.31, +2.59] | [54.0%, 60.5%] |
| **forward, 2026 week 2** | 570 of 1,923 | 58.2% | +2.84 | [+0.35, +5.57] | one week, not computable | [49.2%, 67.7%] |

Gates: G1 **+0.7958 > 0** pass · G2 **+0.9566 > 0** pass · G3 **0.5256 > 0.5** pass · G4 **+2.8369 > 0** pass.

- **Power (MDE at 80%, player-clustered SE):** past 0.88 points per disagreement (3.7 points of
  win rate); forward 3.91 points (14.2 points of win rate). The forward week confirms direction
  only; it could not have detected an edge the size of the past window's.
- **Decisions and error (discipline d):** MAE including did-not-play zeros, same rows: past ours
  **4.583** vs average **4.605** (8,541 rows); forward ours 4.645 vs 5.506 (360 rows). A 0.02-point
  MAE gap is a 55% decision win rate: the decision metric sees what MAE hides.
- **Pair accuracy on all startable pairs** (`startSitPairAccuracy`'s definition): past ours
  **0.6056**, average 0.5929; forward 0.6365 vs 0.5874.
- **Byes removed:** 343 rows (2024), 357 (2025), 0 (2026 week 2); team unknown 0.
- **Failing weeks, all of them (5 of 28):** 2024 W10 −1.34 (n 244), W11 −0.81 (201), W14 −0.62
  (226); 2025 W13 −0.61 (191), W14 −0.45 (208). 2024 W15 is +0.01, not failing.

### Stress tests of the positive result (descriptive, NOT pre-registered)

Scripts in the session scratchpad (`c01/stress.mjs`, `c01/null-coverage.mjs`), same copy, same code.

| check | disagreements | our pick won | points | player CI | reading |
|---|---|---|---|---|---|
| universe ≥ 4.0 PPR (the early-week script's line) | 13,155 | 56.6% | +1.54 | [+1.15, +1.92] | same direction, tighter |
| did-not-play rows removed | 5,575 | 53.8% | +1.00 | [+0.31, +1.64] | smaller but holds: part of the edge is availability |
| QB | 737 | 57.9% | +1.73 | [+0.01, +3.65] | holds, barely |
| RB | 1,570 | 52.0% | +1.11 | [−0.12, +2.34] | **not distinguishable** |
| WR | 3,830 | 55.0% | +1.22 | [+0.39, +2.03] | holds |
| TE | 496 | 59.6% | +2.81 | [+1.29, +4.49] | holds |
| our projection shuffled within week-position | 6,275 | 39.0% | −3.29 | [−4.08, −2.49] | a no-skill ranking loses to the average, as it should |
| decision-level (unclustered) CI of the real result | 6,633 | — | +1.37 | [+1.14, +1.60] | clustering widens the interval about 2.5x |

**Null calibration:** both rules replaced by independent random shuffles within week-position, 40
replicates, 1,000 draws each: mean win rate 0.4988 (0.457-0.528); false passes G1 **1/40**, G2
**4/40**, G3 **1/40**, all three **1/40**; `loses_to_dumb` 3/40. Nominal is 5% per one-sided bound
(2/40); G2 on 28 week clusters runs a little hot, which is why the rule needs G1 and G3 as well.

### One number, one producer

- **Pair accuracy has one other producer**, `scripts/promote-early-week-weights.mjs:153`. Same
  definition, pinned equal by test; different universe (weeks 2-4, threshold 4), so its quoted
  0.605 → 0.626 is not this gate's 0.6056.
- **`lineup-brain.js:268 DECISION_CURVE` disagrees, and says why itself.** Its startable universe's
  overall rate (ties half) is **0.6249** over 656,705 pairs of a research-baseline projection,
  2018-2025 (command: parse the STARTABLE table of `docs/evidence/2026-09-22/start-sit-decision-curve.md`,
  sum n × (rate + ties/2)); this gate's is **0.6056** for production's replay predictor, 2024-2025
  weeks 5-18, byes out, DNP as 0. Different projection, seasons and population, so not the same input.
  **Not unified here: C-10 replaces the static curve with a tracked rate and should read this gate.**

## 5. Holdout looks

No `docs/evidence/HOLDOUT-LEDGER.md` on `origin/main d6d7bd5a`, so recorded here.

| unit | date | hypothesis | metric | 2025 result |
|---|---|---|---|---|
| C-01 | 2026-09-22 | H1: our as-of weekly projection's start/sit pick outscores the season-average pick where they disagree | points per disagreement (player-clustered 90% CI), decision win rate | 2,999 disagreements, 57.2% won, +1.95 [+1.16, +2.75] (local copy, `42310804`) |

The standing job re-reads 2025 weekly; with the policy unchanged that is the same deterministic
number, not a new look. A policy change is a new look owned by the unit that makes it.

## 6. Mutation sweep

Runner: `mutate-run-v2.sh` (a new versioned copy of the handoff's `mutate-run-v1.sh`, paths for this
Mac, not edited in place). Each mutant runs in its own detached worktree of the swept sha, must match
its anchor **exactly once** or is refused as NOT-APPLIED, and is graded on the three test files with
the repo's test environment; the file hash (first 12 of SHA-256) is recorded before, after and
after restore. The spec mutates the units **and their call sites** (M14, S7, S9, S10, S11, S12 are
the arguments a caller passes: the week groups into `pairedBootstrapDiff`, the usage into
`removeByes`, the recency and season into `activeKVectorFor`, the recency and `kOverride` into
`replaySeasonWeekly`).

- **Sweep 1** on `bc17b7a9` (tree `431b8f08`), 43 tests: 32 of 39 mutants killed, **7 survived**:
  M3, M5, M7, S1, S5, S10, P1. Each survivor meant a test that did not pin what it claimed, so the
  tests were fixed (`7f888374`), not the code.
- **Sweep 2** on `7f888374`, the 7 survivors plus M4 and the three controls: all 8 killed, controls as designed.
- **Sweep 3** on `7f888374` (tree `7e819bed`), the whole spec, 45 tests, baseline 45/45:
  **39 of 39 killed**; C1 survived and C2, C3 were refused, all three as designed.

| # | file | mutation | hash before → after | pass/fail | sweep 3 | sweep 1 | killed by (first test, +others) |
|---|---|---|---|---|---|---|---|
| M1 | `baseline-gate.js` | a tie counts as a loss, not half | `38a38bb58db1`→`3efbce507a9b`, restored `38a38bb58db1` | 43/2 | **KILLED** | KILLED | a disagreement our pick wins is 1 with positive points (+3) |
| M2 | `baseline-gate.js` | sign convention flipped | `38a38bb58db1`→`93f49202f65d`, restored `38a38bb58db1` | 42/3 | **KILLED** | KILLED | a disagreement our pick wins is 1 with positive points (+4) |
| M3 | `baseline-gate.js` | player CI clusters only our pick, not the dumb pick | `38a38bb58db1`→`93756bec7310`, restored `38a38bb58db1` | 44/1 | **KILLED** | SURVIVED | the dumb pick is a cluster too: a shared baseline player widens the in… |
| M4 | `baseline-gate.js` | player CI clusters only the dumb pick, not ours | `38a38bb58db1`→`62c0e35f417b`, restored `38a38bb58db1` | 43/2 | **KILLED** | KILLED | the player-clustered interval resamples players, not decisions (+1) |
| M5 | `baseline-gate.js` | a 50% interval reported as 90% | `38a38bb58db1`→`e8933514988a`, restored `38a38bb58db1` | 44/1 | **KILLED** | SURVIVED | with no player recurring, the player interval is a 90% interval, conse… |
| M6 | `baseline-gate.js` | MDE for a 95% test while the CI is 90% | `38a38bb58db1`→`04ec13c20098`, restored `38a38bb58db1` | 44/1 | **KILLED** | KILLED | the minimum detectable effect at 80% power is (1.6449 + 0.8416) standa… |
| M7 | `baseline-gate.js` | a break-even week reported as failing | `38a38bb58db1`→`a726f74c57b8`, restored `38a38bb58db1` | 44/1 | **KILLED** | SURVIVED | every failing week is listed, none truncated |
| M8 | `baseline-gate.js` | failing weeks truncated to 10 | `38a38bb58db1`→`af9a2795800e`, restored `38a38bb58db1` | 44/1 | **KILLED** | KILLED | every failing week is listed, none truncated |
| M9 | `baseline-gate.js` | G1 boundary not strict | `38a38bb58db1`→`c988d4f13e82`, restored `38a38bb58db1` | 44/1 | **KILLED** | KILLED | verdict: each past gate fails on its own boundary, strictly |
| M10 | `baseline-gate.js` | G3 win-rate line moved to 0.4 | `38a38bb58db1`→`bfc17ebac17a`, restored `38a38bb58db1` | 44/1 | **KILLED** | KILLED | verdict: each past gate fails on its own boundary, strictly |
| M11 | `baseline-gate.js` | verdict ignores the week-clustered gate G2 | `38a38bb58db1`→`8db9324f4bdd`, restored `38a38bb58db1` | 44/1 | **KILLED** | KILLED | verdict: each past gate fails on its own boundary, strictly |
| M12 | `baseline-gate.js` | G4 passes with zero forward disagreements | `38a38bb58db1`→`13307ed6ebd7`, restored `38a38bb58db1` | 44/1 | **KILLED** | KILLED | verdict: a past pass that the forward weeks do not confirm is unconfir… |
| M13 | `baseline-gate.js` | loses_to_dumb on a straddling interval | `38a38bb58db1`→`cac693df239e`, restored `38a38bb58db1` | 43/2 | **KILLED** | KILLED | verdict: each past gate fails on its own boundary, strictly (+1) |
| M14 | `baseline-gate.js` | CALL SITE: week-clustered CI loses its groups (becomes unclustered) | `38a38bb58db1`→`d7f58cb2907e`, restored `38a38bb58db1` | 44/1 | **KILLED** | KILLED | the week-clustered interval is pairedBootstrapDiff itself, grouped by … |
| S1 | `start-sit-gate.js` | startable only by our projection, not both rules | `94bdc716dbbc`→`fb2657fa4e4e`, restored `94bdc716dbbc` | 44/1 | **KILLED** | SURVIVED | pairs are same season, week and position, with both players startable … |
| S2 | `start-sit-gate.js` | pairs across seasons | `94bdc716dbbc`→`bf54d6d43776`, restored `94bdc716dbbc` | 43/2 | **KILLED** | KILLED | pairs are same season, week and position, with both players startable … (+1) |
| S3 | `start-sit-gate.js` | a projection tie counted as a call | `94bdc716dbbc`→`4b12a85313cc`, restored `94bdc716dbbc` | 43/2 | **KILLED** | KILLED | a projection tie by either rule is not a disagreement (+1) |
| S4 | `start-sit-gate.js` | our pick taken from the dumb rule | `94bdc716dbbc`→`c02a97443e4b`, restored `94bdc716dbbc` | 43/2 | **KILLED** | KILLED | our pick is the higher of our projections, the dumb pick the higher av… (+1) |
| S5 | `start-sit-gate.js` | pair accuracy scores a projection tie as a call | `94bdc716dbbc`→`ccce04d2d43c`, restored `94bdc716dbbc` | 44/1 | **KILLED** | SURVIVED | pair accuracy is startSitPairAccuracy's, on the same pairs (one defini… |
| S6 | `start-sit-gate.js` | bye team read from week W (not known at forecast time) | `94bdc716dbbc`→`80dcb7999fd9`, restored `94bdc716dbbc` | 43/2 | **KILLED** | KILLED | a player whose team does not play in week W is a bye and leaves the po… (+2) |
| S7 | `start-sit-gate.js` | CALL SITE: bye removal fed no usage | `94bdc716dbbc`→`fe05a352edb6`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | bye rows never reach the pairs: BBB on a bye in 2025 week 6 drops play… |
| S8 | `start-sit-gate.js` | k control accepts the hardcoded 6 | `94bdc716dbbc`→`01af9cc050c6`, restored `94bdc716dbbc` | 43/2 | **KILLED** | KILLED | the k control stops at the hardcoded K.share = 6, and when no fitted k… (+1) |
| S9 | `start-sit-gate.js` | CALL SITE: k resolver without weekly role recency | `94bdc716dbbc`→`0d2bf3eb4c53`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | the default k resolver is configuration B's: an empty fit table stops … |
| S10 | `start-sit-gate.js` | CALL SITE: k resolver not cutoff-safe (no predictingSeason) | `94bdc716dbbc`→`0a6da867b632`, restored `94bdc716dbbc` | 44/1 | **KILLED** | SURVIVED | the default k resolver is configuration B's: an empty fit table stops … |
| S11 | `start-sit-gate.js` | CALL SITE: replay without WEEKLY_ROLE_RECENCY | `94bdc716dbbc`→`76aaa961ddc2`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | the replay runs in configuration B over the pre-registered windows |
| S12 | `start-sit-gate.js` | CALL SITE: replay with kOverride null (fitted k suppressed) | `94bdc716dbbc`→`92802c8e6ea9`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | the replay runs in configuration B over the pre-registered windows |
| S13 | `start-sit-gate.js` | champion not as-of the predicted week | `94bdc716dbbc`→`c5434a960227`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | the prediction head is the as-of champion for the week it predicts, re… |
| S14 | `start-sit-gate.js` | k control skipped | `94bdc716dbbc`→`402baa525c83`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | the k control runs before any replay and stops the whole run |
| S15 | `start-sit-gate.js` | a failed oracle control still yields a verdict | `94bdc716dbbc`→`f9a53b9da852`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | an instrument whose known-nonzero control finds nothing says so instea… |
| S16 | `start-sit-gate.js` | oracle control not required | `94bdc716dbbc`→`fa2f0f540eed`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | an instrument whose known-nonzero control finds nothing says so instea… |
| S17 | `start-sit-gate.js` | forward window grades week 1 | `94bdc716dbbc`→`c677db1e31a2`, restored `94bdc716dbbc` | 43/2 | **KILLED** | KILLED | the replay runs in configuration B over the pre-registered windows (+1) |
| S18 | `start-sit-gate.js` | stored as NFL: betting readers would count it | `94bdc716dbbc`→`120a2a9fd951`, restored `94bdc716dbbc` | 41/4 | **KILLED** | KILLED | a run is stored in model_gate_audits by recordGateAudit, as FANTASY / … (+3) |
| S19 | `start-sit-gate.js` | reader looks in the wrong sport | `94bdc716dbbc`→`9a6be734abbb`, restored `94bdc716dbbc` | 43/2 | **KILLED** | KILLED | GET /api/gates/start-sit serves the latest stored result with its basi… (+1) |
| S20 | `start-sit-gate.js` | an instrument fault reads as a healthy job | `94bdc716dbbc`→`d5fea99772f6`, restored `94bdc716dbbc` | 44/1 | **KILLED** | KILLED | an instrument fault is recorded as a job error, and still stored so it… |
| J1 | `scheduler.js` | job on the request thread | `dd9c456e86df`→`3bbcd84bc319`, restored `dd9c456e86df` | 44/1 | **KILLED** | KILLED | the job is registered weekly, in the growth tier, off the request thre… |
| J2 | `scheduler.js` | cadence daily, not weekly | `dd9c456e86df`→`8bb4ab060669`, restored `dd9c456e86df` | 44/1 | **KILLED** | KILLED | the job is registered weekly, in the growth tier, off the request thre… |
| R1 | `gates.js` | route path moved | `a3efe5c613e1`→`0b2bea208759`, restored `a3efe5c613e1` | 43/2 | **KILLED** | KILLED | before any run the served answer is not_run, not an empty number (+1) |
| P1 | `StartSitGate.tsx` | panel truncates failing weeks | `b03ca7f061bb`→`c17e2f5e1f55`, restored `b03ca7f061bb` | 44/1 | **KILLED** | SURVIVED | the panel names every verdict, the basis and the sign convention, and … |
| P2 | `StartSitGate.tsx` | panel reads a route that does not exist | `b03ca7f061bb`→`c18f5907dd4f`, restored `b03ca7f061bb` | 44/1 | **KILLED** | KILLED | the Lineup page shows the gate panel, and the panel reads the route |
| C1 | `baseline-gate.js` | DESIGNED SURVIVOR: comment-only edit | `38a38bb58db1`→`07ee15742061`, restored `38a38bb58db1` | 45/0 | **SURVIVED** | SURVIVED | — (as designed) |
| C2 | `baseline-gate.js` | DESIGNED NOT-APPLIED: anchor absent from the file (anchor matched 0x) | `38a38bb58db1`→`38a38bb58db1` | — | **NOT-APPLIED** | NOT-APPLIED | — |
| C3 | `start-sit-gate.js` | DESIGNED NOT-APPLIED: anchor occurs many times, must be refused (anchor matched 8x) | `94bdc716dbbc`→`94bdc716dbbc` | — | **NOT-APPLIED** | NOT-APPLIED | — |

**The controls are designed outcomes.** C1 edits a comment, applies (the hash moves) and survives,
which proves a kill elsewhere came from behaviour and not from a broken suite. C2's anchor is absent
and C3's matches eight times; both are refused rather than landing on the wrong line, which proves a
NOT-APPLIED row is never read as a kill. Every applied row restored to its before-hash.

## 7. Known defects and limits

1. **It grades the replay predictor, not the full live number.** Production's `week_points`
   also carries the chance to play, the betting-line lift and the coordinator correction;
   `replaySeasonWeekly` reads four tables and has none of them (memory
   `gridiron-replay-may-not-grade-the-shipped-model`). The page says so under "Limit".
2. **PPR, not each league's `scoringItems`; a league-wide pool of pairs, not Nick's rosters**
   (`league_roster_history` holds only final snapshots for 2023-2025).
3. **Players on a bye in week W−1 are not in week W's pool** (the harness's "active last week"
   rule). Bye detection in week W uses the season's own `player_week_usage` rows as the stand-in
   for the published schedule, because `schedule_games` on the local copy holds 2026 only. A
   player traded across a bye week is judged by his old team.
4. **The player interval is conservative.** With no player recurring at all, the two-factor
   bootstrap is 1.652x the ordinary 90% interval on a 400-decision fixture (Owen 2007's √3 ≈ 1.73).
   On the real run it is 2.5x the unclustered interval, which includes that inflation.
5. **The week interval runs a little hot** on 28 week clusters: 4/40 false passes under the null
   against a nominal 2/40. The rule needs G1 and G3 too, and all three together false-passed 1/40.
6. **The forward window is one week** (2026 week 2, 570 disagreements, MDE 3.91 points). G4 is
   direction only, as pre-registered. It grows by itself: the job re-reads every played week.
7. **Only the fitted k is cutoff-safe by construction.** Hand-set constants in `buildProjections`
   (e.g. `RECENCY`) were chosen with 2021-2025 visible, so 2024-2025 is not a pristine holdout
   for the whole policy. 2026 is.
8. **Not every slice clears.** 2024 alone: points CI [+0.02, +1.68] but win-rate CI [49.7%, 56.4%]
   straddles 0.5. RB alone: not distinguishable. The pre-registered rule is on the pooled window,
   and the page shows the pooled verdict.
9. **The oracle control uses its own universe** (its projection is the actual score, so the ≥ 8.0
   filter applies to actuals). It proves the grading machinery can see an edge on these rows, not
   that the real pair set is well formed; the tests pin that.
10. **`model_gate_audits.verdict` speaks `recordGateAudit`'s vocabulary** (`promotion_eligible` /
    `blocked`). The served payload carries the gate's own verdict. A FANTASY row cannot be promoted
    through the only promote route (`routes/nfl-market.js:217` passes `'NFL'`).
11. **Cost:** every weekly run re-replays 2024-2025 (52.7 s measured) although those numbers only
    move when the model does. Accepted for now; a model-version short-circuit is a follow-up.
12. **Shared files edited:** `server/services/scheduler.js` (one JOBS entry plus its run function),
    `server/index.js` (one import, one mount), `client/src/pages/Lineup.tsx` (one import, one
    element). F-04 and B-17 also edit `scheduler.js`, so expect a merge there.
13. **The dumb rule is a judgement, pre-registered:** "season-to-date average", because ESPN's own
    weekly projection exists for 2026 week 2 only (614 rows, one league, local copy). The gate
    interface takes any baseline; ESPN's projection can be graded once weeks accumulate.

## 8. Nick's five questions

1. **Well built?** Yes, by reuse: the replay (`weekly-backtest.js:88`), the week-clustered
   bootstrap (`backtest-significance.js:57`) and the governance store (`model-governance.js:154`)
   are called unedited. New code is the pair builder, a two-factor resampler for the one shape the
   existing bootstrap cannot express, a pure verdict function, a job, a read-only route and a panel.
   Every run checks itself first: the k control stops at `K.share = 6`, an oracle must win every
   disagreement it has, an identity policy must have none. 45 tests; 39 of 39 mutants killed on the
   final code, including six call-site mutants (§6).
2. **Stats or made up?** Stats: 6,633 real disagreements from the week-by-week replay of 2024-2025
   and 570 from 2026 week 2, on a local copy (not production). Two choices are judgements, both
   pre-registered and labelled: the ≥ 8.0 startable line (borrowed from `DECISION_CURVE`, not
   fitted) and the season average as the dumb rule.
3. **How we know:** backtest on 2024 + 2025 weeks 5-18 (held out for the frozen-2023 weights) and
   the 2026 forward week: our pick won **55.0%** of disagreements, **+1.37** points each, player-
   clustered 90% CI **[+0.80, +1.94]**, week-clustered **[+0.96, +1.77]**; 2026 week 2 **+2.84**.
   Verdict `beats_dumb`. Stress tests and a null calibration in §4.
4. **Pointed anywhere else?** Yes. C-02 (waivers vs "add the highest projected free agent") and
   C-03 (trades vs "offer fair value") pass their own disagreements into `baseline-gate.js`.
   C-10 should replace `DECISION_CURVE` (`lineup-brain.js:268`) with this gate's tracked rate.
   The two "start the highest projection" notes in `lineup-posture.js:292,405` now have a
   measured backing. Any model unit that changes the weekly projection re-runs this gate and
   reports decision win rate beside MAE (discipline d).
5. **How it unifies:** one instrument for all three dumb baselines, one store (`model_gate_audits`,
   `sport = 'FANTASY'`), one pair-accuracy definition shared with the only other producer and
   pinned equal by test, and the same configuration B every replay grade uses.

## 9. Merge-gate lines

- **Gap fixed:** no standing start/sit gate existed. `git grep -n -i "start_sit_gate\|beat-the-dumb\|beats_dumb" d6d7bd5a -- server client/src scripts`
  returns nothing; the same command on this branch finds the panel (control).
  The handoff's `PHASE-BOARD-2026-09-22.md:86` (handoff branch, not on main): item 12 "not started".
- **Incumbent, by command:** the app's start/sit is `lineup-brain.js:418 lineupCall` →
  `:481 bestLineup(solvePool, slots, 'week_points')`: start the highest projection. This gate
  grades that projection against the model-free one.
- **Does NOT cover:** the chance to play, the betting-line lift and the coordinator correction;
  league scoring; Nick's own rosters; ceiling/floor objectives; K and DEF.
- **What would make it wrong:** the replay predictor diverging from the live one (unestablished
  either way); byes mis-detected; a dependence the two-factor and week bootstraps both miss.
- **Migrations:** none. **Tables written:** `model_gate_audits` only, by `recordGateAudit`
  (`model-governance.js:154`), called from `start-sit-gate.js refreshStartSitGate`. **Secrets:**
  none read or written. **Licence:** no new external data; the replay reads existing
  `player_week_usage` (nflverse, CC BY; attribution is F-08).
