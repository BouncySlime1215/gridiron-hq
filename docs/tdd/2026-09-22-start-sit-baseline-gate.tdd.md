# The standing start/sit gate: our projection vs ESPN's projection (the plan's rule), with "start the higher average" as a floor

Unit C-01 (plan item C12). Branch `claude/local-c-01-startsit-baseline-gate` off
`origin/main d6d7bd5a`. Pre-registration: `docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md`,
committed at `a2ea8714` before any number was run. **Addendum 1**
(`start-sit-baseline-gate-prereg-addendum-1.md`, `f55d2eb6`, 17:18:46 -0400) was committed
before its arms were computed by this unit; §0 of it states what a skeptic had already seen.
**Addendum 2** (`start-sit-baseline-gate-prereg-addendum-2.md`, `9ea52eae`, 2026-09-22T23:42:07Z)
registers the plan-rule verdict: committed before any code change for the Independent Auditor's
ruling and before week 3's first kickoff (2026-09-25 00:15Z). **Revision 4** implements that
ruling (§0c): the verdict is now the projection the app served against ESPN's weekly projection,
and the season-average ship rule runs unchanged beside it as `average_check`.

**Every number in this file is for the Independent Auditor, not for Nick** (standing rule 3,
R44.1, R45, R61). The Lineup panel shows direction only; see §10.

## 0. Revision 2: the skeptic review of `b39b54c8`, and what changed

| # | blocker (lens) | disposition | where |
|---|---|---|---|
| 1 | the dumb rule is "season average", not the named "start highest projection" (claims) | **arm added, ruling still needed.** The literal rule (ESPN's weekly projection) is graded on the forward weeks against what the app served. On 2026 week 2 it points **against us** (§4a). The verdict still gates on the season average, as registered; whether the literal arm replaces it is the Auditor's call | `f55d2eb6` addendum §3, `b51468ee` |
| 2 | prereg not filed with the Auditor before any number ran (claims) | **cannot be undone; ruling needed.** Stated in addendum §5 with the four rulings asked for | addendum §5, §9 below |
| 3 | replay magnitudes and lineup rates on the panel (claims, wiring) | **fixed:** the panel renders direction only; the job's `sync_log` detail (Coach-readable) carries verdict and directions only; a rendered-panel test fails if any digit other than a season, week or timestamp appears. The route still serves the magnitudes for the Auditor | `f6eba878`, `b51468ee`, `test/start-sit-gate-panel.test.js` |
| 4 | writer not reached where the app runs (wiring) | **fixed, needs a file grant:** `start_sit_gate` added to `scripts/refresh-live-data.mjs` `FANTASY_LIVE_JOBS`, after `nfl_model_growth` and `nfl_weekly_learning`; pinned by `test/refresh-loop-steps.test.js` G7. Both files are outside the unit row; drop `ad66dae7` (and G7) if the grant is refused | `ad66dae7`, `05ceb070` |
| 5 | LM1, LM3 survived (liveness) | **fixed:** hand-counted past and forward values on the fixture (`n` 90, points -0.5333, win rate 0.4722; forward 28, -0.25, 0.4821) and an all-correct fixture that must read `beats_dumb` | `05ceb070` |
| 6 | LM2 survived (liveness) | **fixed:** `test/start-sit-gate-job.test.js` calls `JOBS.start_sit_gate.run()` and requires one FANTASY/start_sit row | `05ceb070` |
| 7 | LM4 survived (liveness) | **fixed:** a forward season that reverses the actuals must read `beats_dumb_unconfirmed_forward`, G4 value -6, not passed | `05ceb070` |
| 8 | LM6 survived (liveness) | **fixed:** the panel is compiled with the repo's TypeScript and rendered with React; one chip per failing week, samples of 7 and 12 included | `05ceb070` |
| 9 | LM5, LM7 survived (liveness; not listed as blocking) | **fixed:** the unknown-team bye rule and both MAEs are pinned | `ffd84d02` |
| 10 | the forward window is labelled "as production served it", but week 2 was served on other settings; `weekly_prediction_snapshots` unused (structure) | **fixed:** the replay is relabelled "today's settings, replayed"; what was served is graded beside it (arm A) with the capture time, weights and fit time per week, and the page says why they differ; the producer table below now names the snapshot table | `f55d2eb6`, `b51468ee`, §1, §4a |

## 0b. Revision 3: the round-2 skeptic review of `fff49295`, and what changed

| # | blocker (lens) | disposition | where |
|---|---|---|---|
| 1 | rule 2 not met: no Independent Auditor ruling on file (claims, earlier blocker 2) | **agreed; cannot be fixed in code.** Re-checked: `grep -c 'C-01' ~/gridiron-local/WORKLOG.jsonl` → `0`; no `board/unit-C-01.json`; `grep -rl 'C-01'` over `~/gridiron-local/*.md board evidence` finds only `WORK-QUEUE.md`, `BLOCKER-LAB.md`, `STRUCTURE-MAP.md` and the C-02/C-03/C-10 board rows. Rulings (a) and (b) are still needed before merge (§9) | addendum §5, §9 |
| 2 | what blocker 1 leaves: the literal rule (ESPN) points against the green verdict, and its lost week was not on the panel (claims) | **the ruling part is agreed and still open** (ruling c: which rule gates). The verdict is **not** changed: ~~the prereg forbids swapping the gating rule after the fact~~ *(corrected in revision 4: that line is in neither prereg file. Prereg §1 names ESPN's weekly projection as the follow-up rule, addendum 1 §3 gives the swap to the Independent Auditor, and the Auditor's ruling of 2026-09-22 makes it; §0c)*. **The display part is fixed:** "Weeks our projection lost" now has one group per graded window and arm, each under the rule it lost to, so **2026 W2 shows under "This season as the app served it, against ESPN's projection"** (§10). Addendum §4 already said the panel shows "the failing weeks"; it showed only the past window's | `0d3caa19` RED, `8d434c66` GREEN, `06408d00` |
| 3 | no file grant for `scripts/refresh-live-data.mjs` and the G7 test (wiring, earlier blocker 1) | **agreed; no code change.** The coordinator records a grant to C-01 for the one allowlist line (`ad66dae7`) and G7 (`05ceb070`) and tells the R-09 and BL-02 owners and PR #47 that `FANTASY_LIVE_JOBS` changed, or rules that the panel ships `not_run`, in which case `ad66dae7` is reverted and G7 dropped (a new revert commit, not a history rewrite) | §7.17 |
| 4 | the older-settings reason line had no liveness proof: `assert.match(text, /before/i)` matched other text; mutant `const differs: ServedWeek[] = []` survived (structure) | **agreed, the test was wrong; fixed in the test.** Reproduced first: that mutant on `fff49295` gave `# pass 6 # fail 0`. The line is now pinned by its own words, each clause alone, and a negative case (a week served on today's settings, `same_weights` true and `served_before_k_fit` false or null, renders no such line). Same mutant on `0d3caa19` (tests changed, panel not): **killed** (`not ok 9 - a week served on older settings says so, naming each reason`); sweep 7 and 8 kill it too, with five more mutants on the same line | `0d3caa19`, §2, §6 |

## 0c. Revision 4: the Independent Auditor's ruling, and what changed

The ruling: `docs/handoff/local/audits/2026-09-22-C-01-ruling.md` (handoff branch; Independent
Auditor, 2026-09-22 19:25 EDT; filed at WORK-QUEUE.md :611). Its verdicts:

- **(a)** C12's gate gates on the plan's named rule, "start highest projection", which in Nick's
  ESPN leagues is ESPN's weekly projection. The season average stays as a pre-registered floor
  check, reported beside the verdict and never as it.
- **(b)** No green "Beats" headline while the plan's own rule points against us: an amber "Not
  shown to beat ESPN's projection" with the week-2 direction and its caveat; the average result
  below as a weaker check, with no green.
- **(c)** Keep the pre-registered average verdict exactly as computed, renamed `average_check`.
  The top-level `verdict`, the stored governance audit and the sync_log detail the Coach reads
  carry the plan-rule verdict. Addendum 2 before week 3's first kickoff.
- **(d)** `server/index.js` (+4) needed a one-line coordinator grant: granted (WORK-QUEUE.md :610).
  The refresh-loop files were already granted (:601).

| # | ruling item | status | RED → GREEN | proof |
|---|---|---|---|---|
| A1 | top-level `verdict` is the plan-rule verdict | **done** | `698d6762` → `83fead0c` | "A1, A2: G1-G4 all pass and ESPN is ahead on the served week…" (`test/start-sit-gate.test.js`). On the old code: `the top-level verdict must be the plan rule, not the average check` (actual `'beats_dumb'`) |
| A2 | H1 kept unchanged as `average_check {verdict, gates, rule, prereg}` | **done** | same | the old G1-G4 tests re-pointed to `average_check`. On the local copy it reads `beats_dumb`, G1 0.7958, G2 0.9566, G3 0.5256, G4 2.7923, identical to the ruling's copy (§4b) |
| A3 | `plan_rule {verdict, reason, source, weeks_graded, direction, gates, mde80, prereg}` | **done** | same | one fixture per state: 1 at-lock week, ESPN ahead → `not_shown` (`too_few_weeks`, never a loss); 4 same-cutoff weeks, CI below 0 → `loses_to_dumb`; 4 passing weeks → `beats_dumb` (either source); 3 passing weeks → `not_shown`. Plus `espn_ahead_at_lock_only`, strict bounds, nothing graded. On the old code: `S.planRuleVerdict is not a function` |
| A4 | the plan-rule gate reaches `recordGateAudit` | **done** | `698d6762` → `638608aa` | the A1 fixture stores `blocked`; on the old code `the plan-rule gate must reach recordGateAudit` `+ 'promotion_eligible' - 'blocked'`. A positive control stores `promotion_eligible` only when both rules pass. Real row on the local copy: `blocked`, G1-G4 passed, PLAN failed (§4b) |
| A5 | sync_log detail: `verdict` = plan rule, `average_verdict` = H1 | **done** | same | job test on the old code: `the job detail must carry the plan rule, not the average check` (actual `'beats_dumb'`). Real detail: `{"verdict":"not_shown","average_verdict":"beats_dumb",…}` (§4b) |
| A6 | panel per ruling (b); texts, job label, Lineup comment | **done** | `e10798c5` → `e597292c` | render test on the ruling's own result as b97d5ea2 served it: on the old panel `1 emerald chip(s) on the panel: Does our projection beat the dumb rule? Beats "start the higher average" …`; on the fix no emerald, no "Beats", ESPN in heading and chip. The same result as the fix serves it renders the amber chip and the ruling's lines. The rule-3 grep finds nothing (§10) |
| A7 | week-clustered CI `null`, with a reason, below 2 week clusters | **done** | `f04a908b` → `5e493dbe` | on the old code `one week cluster gave a week interval [-0.8,-0.8]`; a two-week control still gets an interval. Real run: the replay's forward window and both served arms now read `week.points: null` with the note (§4b) |
| A8 | prereg addendum 2 | **done** | `9ea52eae` | committed 2026-09-22T23:42:07Z, before any code change (first: `f04a908b`, 23:44:06Z) and about 48.5 hours before week 3's first kickoff (corrected after the Auditor's fresh-session check; this row first said 24.5). Filed as one line in `WORKLOG.jsonl` (unit C-01, sha, commit time) |
| A9 | this revision | **done** | — | §0c, the corrected sentence (§0b row 2), §2 revision 4, §4b, §6 sweeps 9-10 (the ruling's mutant V1 killed; not-applied controls C2, C3), §10 |

**A7, the ruling's wording.** Its proof reads "`ci90.week === null` (it is [x, x] today)". What was
[x, x] is the week interval's values, `ci90.week.points` and `.win_rate`; those are now `null`. The
`ci90.week` object stays so it can carry the reason (`note`) and the cluster count, the shape the
n = 0 case already had.

**Outside the acceptance items, disclosed:** `scripts/run-start-sit-gate.mjs` prints both verdicts
(`cf1fffa6`), and `server/routes/gates.js`'s doc comment names ESPN's projection first. Both are
C-01's own files.

**Auditor fresh-session check (2026-09-22 20:45 EDT, head `bc0062d8`): A1-A5 and A7-A9 met; A6 met
except one panel line.** Under every `not_shown` the panel added '"Not shown" is not the same as
"worse": these weeks may be too few to show a small edge.' It raised one possibility only, an
unseen edge for our projection, under "treat our start/sit calls as no better than ESPN's
projection", and it is false in `espn_ahead_at_lock_only` (4+ weeks, at-lock interval below 0).
**RED** `78393369` "test: RED for dropping the panel's "not the same as worse ... small edge" line
under not_shown": panel **16 pass / 1 fail**, `REAL_FIX: the panel still says "Not shown" is not the
same as "worse"`. **GREEN** `1bdfdef9` "fix: drop the gate panel's "not the same as worse ... small
edge" line under not_shown": panel **17/0**, surface **13/0**; `grep -c 'small edge'
client/src/components/lineup/StartSitGate.tsx` → `0`; panel `tsc --noEmit` exit 0. The small-sample
caveat stays ("Few weeks so far: this season shows direction, not proof."). This check touched only
`StartSitGate.tsx`, `test/start-sit-gate-panel.test.js` and this file.

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
| `weekly_prediction_snapshots`, writer `server/services/weekly-learning.js:49` `captureWeeklyPredictions` (INSERT `:63`) | the projection the app actually served each week, pregame, first write wins (added in revision 2; missed in the first audit) | **reuse as arm A's policy** (addendum 1 §2). A second producer of "our week-2 projection": see §4a |
| `league_roster_snapshots.projected_points`, writer `scripts/collect-roster-snapshots.mjs:109` `writePeriod` (value built `:92`) | ESPN's own weekly projection for every rostered player, per league, settled periods from the boxscore; the refresh loop runs it every tick | **reuse as arm B's dumb rule** (the literal "start the highest projection"), settled rows only, one value per player-week |
| `espn_player_market_weekly` | ESPN market capture with `week_proj`, 2026 week 2 only | **not used by the gate:** no writer in the repo (`git grep -n espn_player_market_weekly d6d7bd5a` finds one doc line). Used only in a descriptive stress check (§4a) |

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

### Revision 2 (after the skeptic review)

Same command, six files (the three above plus `test/start-sit-gate-job.test.js`,
`test/start-sit-gate-panel.test.js`, `test/refresh-loop-steps.test.js`). TAP files in the
session scratchpad `c01-fix/`.

- **RED** `05ceb070` "test: RED for the gate fixes: forward arms, direction-only panel, loop wiring;
  pin values, G4 and the job write". baseline-gate 15/0, start-sit-gate **19 pass / 7 fail**,
  surface **10 / 2**, job **1 / 0**, panel **3 / 3**, refresh-loop **19 / 1**. The failing
  assertions that name the gap:

  > `the gate job must be on the live loop` (refresh-loop G7) ·
  > `past_n = 120 would put a number in sync_log` (surface) ·
  > `beats_dumb: a number other than a season or week reached the panel: … Our pick scored more 55.0% of the time (90% range 52.6% to 57.3%), and +1.37 points per disagreement …` (panel, rendering the old component) ·
  > `Cannot read properties of undefined (reading 'vs_average')` (start-sit-gate, the served arm)

  The tests that kill LM1, LM3, LM4 and LM2 **pass on the old code by design** (they pin what the
  old code already did right): the job test, the G4-reversal test, and the value assertions,
  which run before the new `direction` assertion in the same test. Their liveness is shown by the
  sweep (§6, sweep 4), not by RED.
- One test fixture was corrected before GREEN: the job test's actuals were below the 8.0 line, so
  the oracle control had no pairs and the gate said `instrument_fault` (the test was wrong, not
  the code); actuals moved to `8 + 2 × id`.
- **GREEN** `ad66dae7` (tree `1beaa175`), after `b51468ee` (service), `f6eba878` (panel), `ad66dae7`
  (loop): **15/0, 26/0, 12/0, 1/0, 6/0, 20/0**. `ffd84d02` (test only, LM5 and LM7): 26/0.
  **Final code head `95952b44`** (tree `daf89b12`, after `29ec1909` test-only and two panel wording
  commits): **15/0, 26/0, 12/0, 1/0, 6/0, 20/0**. The two other tests that read `FANTASY_LIVE_JOBS`
  pass on `d5eddaa3`: `league-history-schedule` 7/0, `manager-signals-api` 27/0.
- **Wiring:** `node scripts/wiring-map.mjs --check` on `d5eddaa3`: **exit 0**, `no missing-feed
  findings`; no finding names the gate, its route, its job, `model_gate_audits`,
  `weekly_prediction_snapshots`, `league_roster_snapshots` or the refresh loop (grep of the output).
- **Panel typecheck, single file** (not the Gate phase's full run):
  `tsc --noEmit <tsconfig options> client/src/components/lineup/StartSitGate.tsx` exit 0; the same
  command on a copy with a planted `boolean`→`number` error exits 2 (known-nonzero control).

### Revision 3 (after the round-2 skeptic review)

Same command (`c01-fix/run-tests.sh`); TAP files in scratchpad `c01-fix/` (`red4-`, `green4-`,
`g6-`, `final-0640-`) and mutant runs in `c01-fix3/`.

- **Skeptic mutant reproduced first:** on `fff49295`, `const differs: ServedWeek[] = [];` →
  panel `# pass 6 # fail 0` (`c01-fix3/m1-on-fff4.tap`). The skeptic was right.
- **RED** `0d3caa19` "test: RED for failing weeks per arm on the gate panel; pin the older-settings
  reason line". Panel **6 pass / 5 fail** on the unchanged panel. Failing: the two past-window chip
  tests (now read from the past group), `every graded arm lists its own failing weeks under the rule
  it lost to`, `the real week-2 payload shape: the ESPN arm's lost week is a chip, the other forward
  arms say none`, `an arm that was not graded, or a season not measured yet, gets no failing-weeks
  group`. The assertion that names the gap:

  > `one group per graded window and arm, in order` … `+ []` `- ['past', 'replay', 'served_vs_average', 'served_vs_espn']`

  The two reason-line tests **pass on the old panel by design** (the old code rendered the line
  correctly; only its test was blind). Their liveness on the old panel, both on `0d3caa19`:
  mutant S3 (`const differs: ServedWeek[] = []`) → 5 pass / 6 fail, the sixth being
  `not ok 9 - a week served on older settings says so, naming each reason`; mutant P2
  (`.filter(() => true)`) → 5 pass / 6 fail, the sixth being
  `not ok 10 - a week served on today's settings gets no older-settings line`.
- **GREEN** `8d434c66` "feat: the gate panel lists every graded arm's lost weeks under the rule it lost
  to": panel **11 / 0**.
- `06408d00` "refactor: drop the panel's redundant not-measured guard (sweep 7 survivor P12)":
  panel 11 / 0.
- **Final code head `06408d00`** (tree `45245916`), all six files: baseline-gate **15/0**,
  start-sit-gate **26/0**, surface **12/0**, job **1/0**, panel **11/0**, refresh-loop **20/0**
  (85 tests; `c01-fix3/final-0640-summary.txt`).
- **Panel typecheck, single file:** the same `tsc --noEmit` options as revision 2 on
  `StartSitGate.tsx`: exit **0** on `8d434c66` and on `06408d00`; a copy with a planted
  `const __planted: number = graded(undefined)` exits **2** (`TS2322: Type 'boolean' is not
  assignable to type 'number'`), the known-nonzero control.
- Server, route, job, scheduler and loop code are **unchanged since `d5eddaa3`**
  (`git diff --stat d5eddaa3 8d434c66 -- server scripts test client` lists only the panel and its
  test), so sweep 5's kills on them stand; the wiring check was not re-run.

### Revision 4 (after the Independent Auditor's ruling)

Command per file, the coordinator's: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node
--experimental-test-module-mocks --test --test-reporter=tap test/<file>.test.js` (runner
`c01-fix4/run-tests.sh`; unlike revisions 2-3, no offline-guard import). TAP files in scratchpad
`c01-fix4/`.

- **Merged first, never rebased:** `origin/main` into the branch at `4e7c25d3` (main `dd7cec20`),
  then again after addendum 2 at `36536263` (main `7a9d75f6`, F-08, which touches no C-01 file). No
  conflicts. Baseline on `36536263` before any change: 15/0, 26/0, 12/0, 1/0, 11/0, 20/0.
- **A8 first:** `9ea52eae` "docs: prereg addendum 2 for the start/sit gate's plan-rule verdict,
  before week 3 kicks off", 2026-09-22T23:42:07Z.
- **RED** `f04a908b` "test: RED for a null week-clustered interval below 2 week clusters (Auditor
  ruling A7)": baseline-gate **15 pass / 1 fail**:

  > `one week cluster gave a week interval [-0.8,-0.8]`

- **GREEN** `5e493dbe` "fix: the week-clustered interval is null below 2 week clusters, with the
  reason (Auditor ruling A7)": baseline-gate 16/0; start-sit-gate 26/0 and surface 12/0 unchanged.
- **RED** `698d6762` "test: RED for the plan-rule verdict: top-level verdict, average_check,
  plan_rule states, stored audit, Coach detail (Auditor A1-A5)": start-sit-gate **20 / 15**,
  surface **7 / 6**, job **0 / 1**. The assertions that name the gap:

  > A1 `the top-level verdict must be the plan rule, not the average check` (actual `'beats_dumb'`) ·
  > A3 `S.planRuleVerdict is not a function` ·
  > A4 `the plan-rule gate must reach recordGateAudit` `+ 'promotion_eligible'` `- 'blocked'` ·
  > A5 `the job detail must carry the plan rule, not the average check` (actual `'beats_dumb'`) ·
  > A2, the re-pointed G1-G4 tests: `Cannot read properties of undefined (reading 'gates')`

  Two assertion orders changed after the first RED run, and RED was re-run on the same tree: the A1
  test and the job test now assert the verdict before they touch `average_check`, so each RED names
  the verdict instead of a missing field.
- **GREEN** `83fead0c` "feat: the start/sit gate's verdict is the plan's rule, served projection vs
  ESPN's (Auditor A1-A3)": start-sit-gate 34 / 1, surface 7 / 6, job 0 / 1. What is still red is
  the A4-A5 set, by design.
- **GREEN** `638608aa` "fix: the stored audit and the Coach's sync_log line carry the plan-rule
  verdict (Auditor A4, A5)": start-sit-gate 35/0, surface 13/0, job 1/0.
- **RED** `e10798c5` "test: RED for the gate panel per the Auditor's ruling (b): ESPN's rule heads
  it, no green unless it passes (A6)": panel **10 / 6**, surface **10 / 3**, start-sit-gate **35 / 1**:

  > `1 emerald chip(s) on the panel: Does our projection beat the dumb rule? Beats "start the higher average" …` ·
  > `+ 'Does our projection beat the dumb rule?'` `- "Does our projection beat ESPN's projection?"` ·
  > `one group per graded window and arm, the plan's rule (ESPN) first` ·
  > the job label `did not match /ESPN's projection/`: `'Start/sit gate: our projection vs "start the higher season average" (plan item C12)'` ·
  > `the panel has no wording for not_shown` · `did not match /^The plan's dumb rule: /`: `"The literal dumb rule: …"`

- **GREEN** `e597292c` "feat: the Lineup gate panel asks whether we beat ESPN's projection, and
  shows no green until we do (Auditor A6)": all six files green.
- `cf1fffa6` (the manual run prints both verdicts); `3158f184` (test only: sweep 9 survivor V15).
- **Final code head `3158f184`** (tree `4230a581`), six files: baseline-gate **16/0**, start-sit-gate
  **36/0**, surface **13/0**, job **1/0**, panel **16/0**, refresh-loop **20/0** (102 tests;
  `c01-fix4/final-3158-summary.txt`). `npm run check` was not run here: CI on Node 22 is the guard.
- **Panel typecheck, single file** (the revision 2-3 options): exit **0** on `e597292c`; a copy with a
  planted `const __planted: number = graded(undefined)` exits **2** (`TS2322`), the known-nonzero
  control.
- **Wiring:** `node scripts/wiring-map.mjs --check` on `3158f184`: **exit 0**, `no missing-feed
  findings`. A grep of its output for the gate's names finds only an unrelated `routes/aggregates.js`
  annotation (the pattern `gates\.js` matches `aggregates.js`).

## 3. What it does

| piece | file | what |
|---|---|---|
| gate interface | `server/services/gates/baseline-gate.js` | `gradeDecisions(decisions)` → win rate, points per decision, player-clustered (two-factor pigeonhole) and week-clustered (`pairedBootstrapDiff`) 90% CI, SE, MDE at 80% power, every week, every failing week. `baselineGateVerdict({past, forward})` is the pre-registered rule. C-02 and C-03 pass their own disagreements in |
| start/sit gate | `server/services/gates/start-sit-gate.js` | k control → `replaySeasonWeekly` in configuration B with the as-of champion head → byes removed → startable same-position pairs → disagreements → grade → oracle and identity controls → verdict. `refreshStartSitGate` stores; `latestStartSitGate` reads |
| store | `model_gate_audits`, writer `model-governance.js:154 recordGateAudit` | `sport = 'FANTASY'`, `market = 'start_sit'`, `evidence_json` = the whole result. **No migration**: the table exists (legacy schema, `server/db/schema/mlb-model-misc.js:195`) |
| route | `server/routes/gates.js`, mounted `server/index.js` `app.use('/api/gates', ...legacyAuthenticated, gatesRouter)` | `GET /api/gates/start-sit` reads one row; `status: 'not_run'` before any run, `'unreadable'` if the stored JSON is corrupt |
| job | `server/services/scheduler.js` `JOBS.start_sit_gate` | growth tier, `offThread: true`, `maxAgeMinutes` 7 days, `timeoutMs` 10 min. **Weekly now; B-17 (ops calendar, not built) will give it a day.** An instrument fault returns `error`, so `sync_log` records it. **Run by `scripts/refresh-live-data.mjs` (revision 2)**, the only runner of scheduler jobs while the server has `SCHEDULER_DISABLED=1`. Its `sync_log` detail carries the verdict and directions only |
| page | `client/src/components/lineup/StartSitGate.tsx`, rendered in `Lineup.tsx` | **direction only (revision 2):** the verdict chip in plain words; the past window in words from the verdict; this season replayed, and as served against the average and against ESPN, each as which pick scored more; why the served week differs from the replay, only when it does; every failing week as a season-week chip with no size, grouped by window and arm under the rule it lost to (revision 3: past vs the average, this season replayed, served vs the average, served vs ESPN); "What was compared" (both rules, the literal rule, the universe, scoring, why no numbers, the replay limit, when it was measured). Nav unchanged (8 tabs) |
| served arms | `start-sit-gate.js` `servedArms`, `servedSnapshots`, `espnProjections`, `substitute` | forward weeks only, descriptive (addendum 1): the replay rows with the policy swapped for the served snapshot (arm A), and then the baseline swapped for ESPN's settled projection (arm B). Each window carries `direction` |
| manual run | `scripts/run-start-sit-gate.mjs` | prints configuration, then controls, then the result; `--store` writes like the job. Its last line prints the plan-rule verdict, then the average check (revision 4) |
| **plan-rule verdict (revision 4)** | `start-sit-gate.js` `planRuleVerdict`, `runStartSitGate`, `refreshStartSitGate` | top-level `verdict` = `plan_rule.verdict`: the served-vs-ESPN arm pooled from 2026 week 2 (prereg addendum 2). The at-lock source can pass, never lose; the same-cutoff source does not exist yet. Gates P1-P3; reasons `too_few_weeks`, `espn_ahead_at_lock_only`, `not_distinguishable`. `average_check` carries G1-G4 unchanged. The stored audit gets gate `PLAN` beside G1-G4; the sync_log detail carries `verdict` and `average_verdict` |
| **page (revision 4)** | `StartSitGate.tsx` | heading "Does our projection beat ESPN's projection?" and "The plan's dumb rule: start whoever ESPN projects higher."; the chip reads `plan_rule.verdict` only (emerald only for `beats_dumb`); a `not_shown` line built from the weeks, the direction and the source; the floor as one plain "Weaker check" line, rose if it fails; a result stored before the plan rule reads "Not measured against ESPN's projection yet"; lost weeks with ESPN's group first |

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

## 4a. Revision 2 run: what the app served, and the literal rule (local copy, not production)

**For the Auditor, not for Nick.** Data basis: a fresh backup,
`sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data-b.sqlite'"` at
2026-09-22 17:16 -0400, sha256 `b9086412006153571a2bb3e3acfb41aba136bd9688cecd33e708c1a59fb32bed`,
**local copy, not production** (the §4 copy is older and has no ESPN roster rows). Code `ffd84d02`
(tree `f2fe3095`, worktree clean). Command as §4 with the new path. **47.1 s wall, 356 MB peak
RSS** (`/usr/bin/time -l`), load average 8.75. Output: scratchpad `c01-fix/gate-run-2.out`.

Printed before any metric: roleRecency `{"seasonDecay":0.05,"weekHalfLife":5}`, kOverride omitted,
k control 2024 **0.2747**, 2025 **0.2086**, 2026 **0.1733**; champions `frozen-2023` for every
graded week of 2024-2025, `fit-2` for 2026 week 2. Oracle **n 10,131, win rate 1.0, +6.90**;
identity **n 0**; controls passed.

**Past window: identical to §4** (6,633 of 52,297; 0.5497; +1.3703; player CI [+0.7958, +1.9428];
week CI [+0.9566, +1.7702]; win-rate CI [0.5256, 0.5733]; the same five failing weeks). G1-G4 pass.
**Verdict `beats_dumb`, unchanged.**

| 2026 week 2 | rows | pairs | disagreements | our pick won | points per disagreement | player-clustered 90% CI | MDE80 | direction |
|---|---|---|---|---|---|---|---|---|
| replay, today's settings (G4) | 360 | 1,923 | 571 | 58.1% | +2.79 | [+0.31, +5.51] | 3.93 | ours ahead |
| **A.** served vs the average | 360 (0 without a snapshot) | 1,233 | 63 | 55.6% | +3.49 | [−2.13, +9.26] | 8.57 | ours ahead, CI straddles 0 |
| **B.** served vs ESPN (the literal rule) | 153 (207 with no settled ESPN value; 0 conflicting) | 784 | 286 | **37.8%** | **−3.42** | **[−6.52, −0.36]** | 4.73 | **ESPN ahead** |

Pair accuracy: replay 0.636 vs average 0.587; A 0.580 vs 0.573; **B ours 0.564 vs ESPN 0.653**.
MAE on B's 153 rows: ours 6.47, ESPN 5.72. The forward replay reads 571 disagreements here against
570 in §4: the fresh copy's week-2 rows moved after 16:10.

**Reading.** The registered verdict holds. **On the literal rule the one forward week points
against us:** where what the app served and ESPN's projection disagreed, ESPN's pick scored more,
and the player-clustered interval excludes 0. One week, 153 rostered players, direction only, and
not part of the verdict by pre-registration. **C12's literal bar is therefore not shown met; on
week 2 it points the other way.** The Auditor should rule on this before merge.

**Stress, descriptive, NOT pre-registered** (scratchpad `c01-fix/espn-stress.mjs`, same copy and code):

| variant | rows | disagreements | our pick won | points | player CI |
|---|---|---|---|---|---|
| B reproduced | 153 | 286 | 37.8% | −3.42 | [−6.52, −0.36] |
| served vs ESPN's **Thursday** capture (`espn_player_market_weekly`, 22:08Z, 3 h after our snapshot), same 153 rows | 153 | 308 | 41.7% | −2.35 | [−5.93, +1.31] |
| served vs ESPN's Thursday capture, every row it covers | 342 | 381 | 41.9% | −2.28 | [−5.51, +0.86] |
| **today's settings replayed** vs ESPN settled | 153 | 508 | 42.8% | −1.99 | [−4.65, +0.63] |

ESPN's settled value differs from its Thursday value for **127 of 153** player-weeks (mean abs 0.73
points): the settled value carries later news, which favours ESPN (addendum §3 limit 1). Every
variant points ESPN's way; only the pre-registered one excludes 0.

### One number, two producers: "our 2026 week-2 projection"

Scratchpad `c01-fix/two-producers.mjs`, same copy and code.

- **Both values on the same input:** the gate's replay (today's settings) against the served
  snapshot, same 360 rows: mean abs gap **2.17** points, **71.7%** of rows differ by more than 1;
  **327 of 1,242** startable pairs (both ≥ 8.0 by both, no ties) are ordered the other way.
- **Cause, reproduced:** replaying week 2 with the settings in force at capture (`kOverride: null`,
  so the hardcoded `K.share = 6`; `frozen-2023` weights) matches the snapshot to **0.017** points
  mean abs. Capture `as_of` 2026-09-17T18:56Z; volume fit 1 `fitted_at` 2026-09-18T02:52Z;
  ensemble `fit-1` created 2026-09-17 21:59, `fit-2` 2026-09-18 06:45 (`weekly_ensemble_fits.created_at`).
- **How it unifies:** not forced into one number. Both are served and shown, labelled, with the
  reason per week (`forward.served.weeks[]`). Week 3's snapshot was captured on current settings
  (`weight_fit` `fit-2`, `as_of` 2026-09-22T20:48Z, 1,196 rows), so from week 3 the two producers
  should agree unless the model changes, and the gate will show it if they do not. The served
  number is the ensemble projection, not the lineup's `week_points`; storing that is WORK-QUEUE S-12.

## 4b. Revision 4 run: the plan-rule verdict (local copy, not production)

**For the Auditor, not for Nick.**

- **Copy:** `sqlite3 ~/gridiron-local/data.sqlite ".backup '<scratchpad>/c01-fix4/run/data-c01fix4.sqlite'"`
  at 2026-09-22T23:58:16Z: 925,073,408 bytes, SHA-256
  `1d474388f84e1b7dfb8ad91ecdf1067fd06d7e852a45cb11583f0a6d632b78b3`. **Local copy, not
  production.** No `leagues` column is read.
- **Command** (HEAD `cf1fffa6`, tree `1defe230`, worktree clean; the code is identical to `3158f184`,
  which changed only a test): `GRIDIRON_DB_PATH=<copy> GRIDIRON_DB_INTEGRITY_CHECK=off
  SCHEDULER_DISABLED=1 /usr/bin/time -l node scripts/run-start-sit-gate.mjs --iterations 2000` →
  exit 0, 12.65 s wall, 451,788,800 B max RSS, load average 6.7. Last line: `verdict (plan rule,
  served vs ESPN): not_shown (too_few_weeks); average check: beats_dumb`. Output
  `c01-fix4/run/gate-run-fix.out`, JSON `gate-run-fix.json`.
- **Configuration first (STATS-METHOD rule 7):** role recency `{seasonDecay 0.05, weekHalfLife 5}`
  passed explicitly, `kOverride` omitted; k control target-share k 2024 0.2747, 2025 0.2086, 2026
  0.1733 (fit 1); champions `frozen-2023` for 2024-2025 weeks 5-18 and `fit-2` for 2026 week 2.
  Controls: oracle n 10,131, win rate 1, +6.8984 points; identity n 0; passed.

| field | this run | against the ruling's run (`c01-audit/gate-run-audit.json`, b97d5ea2, copy `b9086412`) |
|---|---|---|
| `average_check` | `beats_dumb`; G1 0.7958, G2 0.9566, G3 0.5256, G4 2.7923 | identical (A2) |
| `plan_rule` | `not_shown`, reason `too_few_weeks`, source `espn_at_lock`, weeks graded 1, direction `dumb_ahead`; P1 −6.5246, P2 0.2537, P3 1, all failed; MDE80 4.7299 points, 0.1869 win rate | new; exactly what addendum 2 §5 wrote down before the run |
| served vs ESPN, at lock | 153 rows (207 without an ESPN value, 0 conflicting), 784 pairs, 286 disagreements, 69 players, won 0.3776, −3.4207 per disagreement, player CI [−6.5246, −0.3637], win-rate CI [0.2537, 0.5057] | identical |
| week-clustered CI of the one-week windows (the replay's forward week, both served arms) | `null`, note "fewer than 2 week clusters: one week is one cluster, not an interval" | was [x, x] (A7) |
| past window | n 6,633, +1.3703, won 0.5497, week CI [0.9566, 1.7702] over 28 clusters | identical |

- **Stored the way the job stores** (`--store` on the same copy, a second run, 26.6 s):
  `model_gate_audits` row 1, `FANTASY / start_sit`, verdict **`blocked`**, gates G1-G4 passed and
  PLAN failed (A4). Detail: `{"verdict":"not_shown","average_verdict":"beats_dumb","audit_id":1,
  "past_direction":"ours_ahead","forward_direction":"ours_ahead","served_vs_average_direction":"ours_ahead",
  "served_vs_espn_direction":"dumb_ahead"}` (A5). The copy held no earlier start/sit gate row, so no
  result stored before this revision exists locally.
- **Real-panel render on the fix head:** `c01-fix4/render-fix.mjs`, a versioned copy of the Auditor's
  `render-audit.mjs` that reads `latestStartSitGate()` from the copy (what the route serves) instead
  of a hand-made payload → `c01-fix4/render-fix.out`: 0 `bg-emerald`, 1 amber chip. The text is in §10.

## 5. Holdout looks

No `docs/evidence/HOLDOUT-LEDGER.md` on `origin/main d6d7bd5a`, so recorded here.

| unit | date | hypothesis | metric | 2025 result |
|---|---|---|---|---|
| C-01 | 2026-09-22 | H1: our as-of weekly projection's start/sit pick outscores the season-average pick where they disagree | points per disagreement (player-clustered 90% CI), decision win rate | 2,999 disagreements, 57.2% won, +1.95 [+1.16, +2.75] (local copy, `42310804`) |
| C-01 | 2026-09-22 | H1, re-run in revision 2 (policy unchanged; new copy `b9086412`) | same | identical: 2,999, 0.5715, +1.9482 [+1.1575, +2.7485] (local copy, `ffd84d02`). Arms A and B read 2026 only |
| C-01 | 2026-09-22 | H1 as `average_check`, re-run in revision 4 (policy unchanged; copy `1d474388`) | same | identical: 2,999, 0.5715, +1.9482 [+1.1575, +2.7485] (local copy, `cf1fffa6`). The plan-rule verdict reads 2026 only |

The standing job re-reads 2025 weekly; with the policy unchanged that is the same deterministic
number, not a new look. A policy change is a new look owned by the unit that makes it.

`docs/evidence/HOLDOUT-LEDGER.md` now exists on main (S-00, `dd7cec20`). This unit does not own it,
so these rows are not copied there. Each weekly plan-rule grade is also a look at 2026 (STATS-METHOD
rule 5, "2026 forward looks"); that row is the coordinator's to record (addendum 2 §8.5).

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

### Revision 2 sweeps (after the skeptic review)

Runner: `c01-fix/mutate-v3.py`, a versioned copy of the liveness skeptic's `mutate.py` (not edited
in place), same rules: each mutant must match its anchor exactly once or is refused, runs in a
detached worktree of the swept sha, and every file is restored to its before-hash. Tests: the six
files (80 tests). Spec `c01-fix/mutants-v3.json`: the skeptic's LM1-LM7 verbatim, N1-N13 for the
new code (call sites marked), controls C1-C3 and one known-kill control K1.

- **Sweep 4** on `ffd84d02`: 20 of 21 applied mutants killed; **N13 survived** (the forward
  replay's direction taken from the past grade: every fixture had past and forward pointing the same
  way). Fixed in the tests (`29ec1909`), not the code.
- **Sweep 5** on `d5eddaa3` (whole spec): **21 of 21 killed**, C1 survived and C2, C3 were refused,
  as designed; worktree clean afterwards.
- **Sweep 6** on `95952b44` (the chip wording changed the panel): LM6, N10, N11 **killed**; C1
  survived, C2 refused.

| # | kind | mutation | hash before → after (restored) | pass/fail | sweep 5 | killed by (first test) |
|---|---|---|---|---|---|---|
| LM1 | unit (skeptic) | replay rows: rules swapped | `5ba49a020cd7`→`e404f3f97ef5` (`5ba49a020cd7`) | 75/5 | **KILLED** | the default fixture grades to the hand-counted values |
| LM2 | call-site (skeptic) | job wrapper binds the reader | `dd9c456e86df`→`8db4cb48e0e2` (`dd9c456e86df`) | 79/1 | **KILLED** | JOBS.start_sit_gate.run() stores one FANTASY / start_sit row |
| LM3 | unit (skeptic) | the average fed in as our policy | `5ba49a020cd7`→`09849a62f3d3` | 75/5 | **KILLED** | the default fixture grades to the hand-counted values |
| LM4 | call-site (skeptic) | G4 fed the past grade | `5ba49a020cd7`→`beff0d22eb0d` | 79/1 | **KILLED** | G4 reads the forward rows |
| LM5 | unit (skeptic) | unknown-team rows dropped as byes | `5ba49a020cd7`→`8f434875eb25` | 79/1 | **KILLED** | a player whose team does not play in week W is a bye |
| LM6 | call-site (skeptic, consumer) | panel filters out small-sample failing weeks | `b833f009162a`→`4d7c2993f2d3` (`b833f009162a`) | 79/1 | **KILLED** (sweep 6 too) | every failing week is on the panel |
| LM7 | unit (skeptic) | our MAE reported as the average's | `5ba49a020cd7`→`2a9ddc98a215` | 79/1 | **KILLED** | the default fixture grades to the hand-counted values |
| N1 | call-site | served snapshot replaces the average, not ours | `5ba49a020cd7`→`b3934f6bcabf` | 77/3 | **KILLED** | what the app served is graded against the average |
| N2 | unit | ESPN arm reads live rows | `5ba49a020cd7`→`6cd1ec8bed91` | 78/2 | **KILLED** | the literal rule … final rows only |
| N3 | unit | ESPN arm keeps conflicting player-weeks | `5ba49a020cd7`→`42f25a170eae` | 79/1 | **KILLED** | the literal rule … one value per player-week |
| N4 | call-site | ESPN replaces our projection | `5ba49a020cd7`→`3310d4a1546a` | 78/2 | **KILLED** | the literal rule |
| N5 | call-site | ESPN arm graded on the replay projection | `5ba49a020cd7`→`f227c38176f7` | 78/2 | **KILLED** | the literal rule |
| N6 | unit | direction sign flipped | `5ba49a020cd7`→`3b35ba4e0bf6` | 73/7 | **KILLED** | direction is the sign of points per decision |
| N7 | unit | sync_log detail leaks the past win rate | `5ba49a020cd7`→`376d5bea200d` | 79/1 | **KILLED** | the job detail … never a rate or a size |
| N8 | unit | served-before-fit comparison inverted | `5ba49a020cd7`→`4192583a299f` | 79/1 | **KILLED** | what the app served is graded against the average |
| N9 | call-site | served arms get no replay champions | `5ba49a020cd7`→`af0525ec0060` | 79/1 | **KILLED** | what the app served is graded against the average |
| N10 | call-site (consumer) | panel prints the replay's win rate | `b833f009162a`→`1ed9129753cf` | 79/1 | **KILLED** (sweep 6 too) | direction only: the only digits … |
| N11 | unit (consumer) | panel words a losing direction as ours | `b833f009162a`→`2fb8526e1c7a` | 79/1 | **KILLED** (sweep 6 too) | the forward lines give the direction of each arm |
| N12 | call-site (wiring) | gate job taken off the refresh loop | `86b2fd2fcba2`→`8c3505734b57` | 79/1 | **KILLED** | G7: the start/sit gate job is on the loop |
| N13 | call-site | forward direction from the past grade | `5ba49a020cd7`→`db5e1a634666` | 79/1 | **KILLED** (survived sweep 4) | G4 reads the forward rows |
| K1 | known-kill control | sign convention flipped (builder M2) | `38a38bb58db1`→`93f49202f65d` | 70/10 | **KILLED** | a disagreement our pick wins is 1 with positive points |
| C1 | designed survivor | comment-only edit | `5ba49a020cd7`→`d3b6c8265358` | 80/0 | **SURVIVED** | — (as designed) |
| C2 | designed not-applied | anchor absent (0 matches) | unchanged | — | **NOT-APPLIED** | — |
| C3 | designed not-applied | anchor ambiguous (70 matches) | unchanged | — | **NOT-APPLIED** | — |

### Revision 3 sweeps (after the round-2 skeptic review)

Runner `c01-fix3/mutate-v4.py` (a versioned copy of `mutate-v3.py` with only the worktree, output
folder and spec path changed), same rules, detached worktree `wt/C-01-mut3` at the swept sha, six
test files. Spec `c01-fix3/mutants-v4.json`: the structure skeptic's mutant verbatim (S3), P2-P16 for
the reason line and the new failing-weeks groups (call sites marked: which arm's weeks feed which
group), LM6 with its anchor moved to the new code, N10, N11, and controls C1 (comment edit in the
panel), C2 (absent anchor), C3 (`served`, ambiguous). The P-numbers here are this spec's own; the
first sweep's P1 and P2 above are different mutants.

- **Sweep 7** on `8d434c66`: **19 of 20 applied killed**; **P12 survived** (removing
  `if (fwd.status) return groups;`). It was redundant: a season not measured yet arrives as
  `direction: 'not_available'` (`start-sit-gate.js:415`), which `graded()` already rejects. Fixed
  by removing the line (`06408d00`), not by adding a test for a payload the server never sends.
  C1 survived, C2 and C3 refused, as designed (`c01-fix3/sweep-v4-s7.txt`).
- **Sweep 8** on `06408d00`: **19 of 19 applied killed**; P12 now NOT-APPLIED (0 matches, the line
  is gone); C1 survived; C2 and C3 refused; every file restored to `67acb0d42121`; `worktree clean at
  06408d00` (`c01-fix3/sweep-v4-s8.txt`).

| # | kind | mutation | sweep 8 pass/fail | result | killed by (first test) |
|---|---|---|---|---|---|
| S3 | unit (skeptic, structure r2) | reason line never renders (`const differs: ServedWeek[] = []`) | 84/1 | **KILLED** (survived on `fff49295`) | a week served on older settings says so, naming each reason |
| P2 | unit | reason line on every served week | 84/1 | **KILLED** | a week served on today's settings gets no older-settings line |
| P3 | unit | reason filter reads only the k flag | 84/1 | **KILLED** | a week served on older settings says so … |
| P4 | unit | reason filter reads only the weights flag | 84/1 | **KILLED** | a week served on older settings says so … |
| P5 | unit | k clause always printed | 84/1 | **KILLED** | a week served on older settings says so … |
| P6 | unit | weights clause always printed | 84/1 | **KILLED** | a week served on older settings says so … |
| P7 | unit | ESPN arm's lost weeks dropped | 83/2 | **KILLED** | every graded arm lists its own failing weeks … |
| P8 | call-site | ESPN group fed the served-vs-average weeks | 83/2 | **KILLED** | every graded arm lists its own failing weeks … |
| P9 | call-site | replay group fed the past weeks | 83/2 | **KILLED** | every graded arm lists its own failing weeks … |
| P10 | call-site | served-vs-average group fed the ESPN weeks | 83/2 | **KILLED** | every graded arm lists its own failing weeks … |
| P11 | unit | an ungraded arm still gets a group | 84/1 | **KILLED** | an arm that was not graded … gets no failing-weeks group |
| P12 | unit | not-measured guard removed | — | **NOT-APPLIED** (survived sweep 7; line removed as redundant) | — |
| P13 | unit | served-vs-average group labelled as ESPN | 84/1 | **KILLED** | every graded arm lists its own failing weeks … |
| P14 | unit | past group stops naming its rule | 84/1 | **KILLED** | every graded arm lists its own failing weeks … |
| P15 | unit | only the first lost week per group | 82/3 | **KILLED** | surface: the panel names every verdict … |
| P16 | unit | an empty group says nothing | 83/2 | **KILLED** | no failing week: the panel says none … |
| LM6 | call-site (skeptic; anchor moved) | small-sample failing weeks filtered out | 84/1 | **KILLED** | every failing week is on the panel … |
| N10 | call-site | replay win rate printed | 84/1 | **KILLED** | direction only: the only digits … |
| N11 | unit | losing direction worded as ours | 84/1 | **KILLED** | the forward lines give the direction of each arm … |
| C1 | designed survivor | comment-only edit | 85/0 | **SURVIVED** | — (as designed) |
| C2 | designed not-applied | anchor absent (0 matches) | — | **NOT-APPLIED** | — |
| C3 | designed not-applied | anchor ambiguous (35 matches) | — | **NOT-APPLIED** | — |

### Revision 4 sweeps (after the Independent Auditor's ruling)

Runner `c01-fix4/mutate-v5.py`, a versioned copy of `c01-fix3/mutate-v4.py` with only the worktree
(`wt/C-01-mut5`, detached at the swept sha), the output folder, the spec path and the test command
changed (the coordinator's command, no offline-guard import). Same rules: each mutant must match its
anchor exactly once or it is refused as NOT-APPLIED; every file is restored to its before-hash
(`start-sit-gate.js` `d0761f094792`, `baseline-gate.js` `2b13b250280f`, `StartSitGate.tsx`
`711a5bcefc00`); the worktree must be clean before and after. Six test files. Spec
`c01-fix4/mutants-v5.json`: **the ruling's call-site mutant V1** ("top-level `verdict` ←
`average_check.verdict`"), V2-V17 on the server and the week interval (call sites marked), P1-P9 on
the panel, the known-kill control K1, and the designed controls C1 (a comment edit, must survive), C2
(absent anchor) and C3 (`result.`, 12 matches), both must be refused.

- **Sweep 9** on `cf1fffa6` (tree `1defe230`), baseline 102/102: **26 of 27 applied mutants killed**;
  **V15 survived**: no fixture had the two arms pointing different ways while the same-cutoff arm
  decided. The test was blind, not the code: fixed in the test (`3158f184`). C1 survived; C2 and C3
  were refused; `worktree clean at cf1fffa6` (`sweep-v5-s9a.txt`, `sweep-v5-s9b.txt`).
- **Sweep 10** on `3158f184` (tree `4230a581`): V15 **killed**, V1 killed again, C1 survived, C2
  refused; `worktree clean at 3158f184` (`sweep-v5-s10.txt`). Only a test file changed between the
  two sweeps, so sweep 9's kills stand.

| # | kind | mutation | sweep 9 pass/fail | result | killed by (first test) |
|---|---|---|---|---|---|
| V1 | **call-site (the ruling's)** | top-level `verdict` ← `average_check.verdict` | 98/4 | **KILLED** (sweep 10 too) | when our projection orders the actuals right … the average check is beats_dumb (+ A1-A2, A4-A5) |
| V2 | call-site (A4) | the PLAN gate never reaches `recordGateAudit` | 99/3 | **KILLED** | A4, A5: on the A1 fixture the stored audit is blocked … (+ surface A4 control, job) |
| V3 | unit (A4) | the PLAN gate always passes | 99/3 | **KILLED** | A4, A5: on the A1 fixture the stored audit is blocked … |
| V4 | call-site (A5) | sync_log `verdict` ← the average check | 98/4 | **KILLED** | A4, A5: on the A1 fixture … the Coach-readable detail carries the plan rule |
| V5 | call-site (A5) | sync_log `average_verdict` ← the plan rule | 98/4 | **KILLED** | A4, A5: … |
| V6 | call-site (A3) | the at-lock arm fed in as the same-cutoff source | 100/2 | **KILLED** | the served arms never move the average check …; the ESPN arm moves the plan rule |
| V7 | call-site (A3) | the plan rule fed the served-vs-average arm | 100/2 | **KILLED** | the served arms never move the average check … |
| V8 | unit (A3) | an at-lock window may return `loses_to_dumb` | 101/1 | **KILLED** | plan rule: at-lock weeks are never a loss, however many … |
| V9 | unit (A3) | 3 graded weeks are enough | 100/2 | **KILLED** | plan rule A3: three passing weeks is not_shown, too few weeks |
| V10 | unit (A3) | the win-rate gate P2 ignored | 101/1 | **KILLED** | plan rule: four weeks that neither pass nor lose … each pass bound is strict |
| V11 | unit (A3) | P1 not strict | 101/1 | **KILLED** | plan rule: four weeks that neither pass nor lose … |
| V12 | unit (A3) | the same-cutoff source decides from its first week | 100/2 | **KILLED** | plan rule A3: three passing weeks is not_shown … |
| V13 | unit | a failed instrument still draws a plan-rule verdict | 101/1 | **KILLED** | an instrument whose known-nonzero control finds nothing says so … |
| V14 | unit (A2) | `average_check` drops the instrument-fault override | 101/1 | **KILLED** | an instrument whose known-nonzero control finds nothing says so … |
| V15 | unit (A3) | direction read from the at-lock arm while the same-cutoff arm decides | 102/0 | **SURVIVED**, then **KILLED** in sweep 10 (101/1) | plan rule A3: four passing weeks is beats_dumb, from either source |
| V16 | unit (A7) | one week cluster still gets a week interval | 101/1 | **KILLED** | below 2 week clusters the week-clustered interval is null … |
| V17 | unit (A7) | two week clusters refused an interval too | 100/2 | **KILLED** | below 2 week clusters … (+ job) |
| P1 | call-site (A6, consumer) | chip keyed on the top-level `verdict` (a stored pre-ruling result paints green) | 101/1 | **KILLED** | A6: the ruling's real result as b97d5ea2 served it gets no emerald … |
| P2 | call-site (A6, consumer) | chip keyed on the average check | 98/4 | **KILLED** | A6: the same real result as the fix serves it … |
| P3 | unit (A6) | the `not_shown` chip painted emerald | 100/2 | **KILLED** | A6: the same real result as the fix serves it … |
| P4 | unit (A6) | a failing floor never turns rose | 101/1 | **KILLED** | A6: the floor line turns into a rose warning … |
| P5 | unit (A6) | a passing floor painted green | 100/2 | **KILLED** | A6: the same real result as the fix serves it … |
| P6 | unit (A6) | the at-lock caveat printed for every source | 101/1 | **KILLED** | A6: the not_shown line names the weeks … |
| P7 | unit (A6) | the past group listed before ESPN's | 101/1 | **KILLED** | every graded arm lists its own failing weeks … |
| P8 | unit (A6) | the heading stops naming ESPN | 100/2 | **KILLED** | A6: the ruling's real result as b97d5ea2 served it … |
| P9 | unit (A6) | the `not_shown` line loses "no better than ESPN's projection" | 100/2 | **KILLED** | A6: the same real result as the fix serves it … |
| K1 | known-kill control | sign convention flipped (builder M2) | 90/12 | **KILLED** | a disagreement our pick wins is 1 with positive points … |
| C1 | designed survivor | comment-only edit | 102/0 | **SURVIVED** (sweep 10 too) | — (as designed) |
| C2 | designed not-applied | anchor absent (0 matches) | — | **NOT-APPLIED** (sweep 10 too) | — |
| C3 | designed not-applied | anchor ambiguous (12 matches) | — | **NOT-APPLIED** | — |

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
    `blocked`). Since revision 4 it is `blocked` unless both the plan rule (gate PLAN) and the floor
    (G1-G4) pass; an instrument fault is blocked too. The served payload carries the gate's own
    verdict. A FANTASY row cannot be promoted through the only promote route
    (`routes/nfl-market.js:217` passes `'NFL'`).
11. **Cost:** every weekly run re-replays 2024-2025 (52.7 s measured) although those numbers only
    move when the model does. Accepted for now; a model-version short-circuit is a follow-up.
12. **Shared files edited:** `server/services/scheduler.js` (one JOBS entry plus its run function),
    `server/index.js` (one import, one mount), `client/src/pages/Lineup.tsx` (one import, one
    element). F-04 and B-17 also edit `scheduler.js`, so expect a merge there. Revision 4 changes
    only the job's label and doc comment in `scheduler.js`, and only the comment in `Lineup.tsx`.
13. **The dumb rule, ruled (revision 4).** The Auditor ruled that the verdict gates on ESPN's weekly
    projection, the plan's rule, and that the pre-registered season average stays as a floor,
    `average_check`, never the verdict (§0c). On today's data the verdict is `not_shown`: one
    at-lock week, ESPN ahead. The panel's green chip is gone; emerald now needs a plan-rule pass.
14. **Arm B's ESPN value is the settled one**, read from the boxscore after the period: it carries
    news after our Thursday capture (127 of 153 values moved). This favours ESPN. The pregame ESPN
    capture table (`espn_player_market_weekly`) has no writer, so a standing gate cannot use it.
15. **Arm B covers rostered players only** (the five synced leagues): 153 of the 360 forward rows.
16. **The route still serves every magnitude** (`GET /api/gates/start-sit` returns the stored
    evidence) so the Auditor can read it; only the panel and the `sync_log` detail are held to
    direction only. If rule 3 is read to cover the route too, the fix is a `display` projection in
    `latestStartSitGate`.
17. **Files outside the unit row:** `scripts/refresh-live-data.mjs` (one allowlist entry, `ad66dae7`)
    and `test/refresh-loop-steps.test.js` (G7, `05ceb070`). **Granted** (WORK-QUEUE.md :601). The
    `server/index.js` mount (+4, one import and one mount) is outside the row too: **granted** at :610,
    per the ruling's (d). Revision 4 touches none of the three.
18. **No same-cutoff source yet.** Until RL-1-1's capture (migration 071, which needs Nick's N9
    word) or S-12 lands, the plan rule reads only the at-lock arm, so it can pass or stay
    `not_shown`, never return a loss (ruling §5.1). Reading that capture once it lands is a follow-up
    for this unit's owner; RL-1-1's own `consensus-gate.js` must feed this gate, not run beside it.
19. **The sub-window report is not built.** Addendum 2 §3 registers a sub-window for each change of
    served model. Week 3's snapshot carries `weight_fit` `fit-2` (week 2's is `frozen-2023`, §4a),
    so the first change arrives with week 3's grade (after its games, about 2026-09-29), and S-03's
    week 5 would be the second. The code for that report is due before week 3 is graded; it is
    descriptive and never moves the verdict.
20. **Repeated looks.** The gate is re-read every week, so over a season its false-pass rate is
    above a single look's 5%; no alpha spending is applied (addendum 2 §8.4).
21. **2026 forward looks** belong in `HOLDOUT-LEDGER.md`, which this unit does not own; the
    coordinator records them (addendum 2 §8.5).
22. **A result stored before revision 4** has no `plan_rule`. The panel then says "Not measured
    against ESPN's projection yet" and never reads the old top-level `verdict` (which was the
    average's) as the plan rule's. The local copy held no such row (§4b).

## 8. Nick's five questions

*Revision 4 answers first; the revision 1-3 answers follow, unchanged where still true.*

1. **Well built? (revision 4)** The ruling's nine items are each a test that failed on the old code
   and passes now (§0c, §2). 102 tests across six files. Sweep 9-10: all 27 applied mutants killed
   on the final code, including the ruling's own mutant (the top-level verdict taken from the
   average check); one survivor on the way (V15) was a blind test, fixed. The plan rule is one
   pure function (`planRuleVerdict`) with no new table, route or job.
2. **Stats or made up? (revision 4)** Stats, with one judgement each way stated before the run:
   the 4-week floor and the at-lock/same-cutoff split come from the ruling and addendum 2; the
   interval is the same player-clustered bootstrap. Week 2 is not blind (addendum 2 §1).
3. **How we know (revision 4, direction only; the sizes are in §4b for the Auditor):** against
   ESPN's weekly projection, the plan's rule, the one week measured (2026 week 2) points ESPN's
   way, read at lineup lock, which favours ESPN. That is **not shown to beat ESPN's projection**:
   too few weeks to decide either way, and an at-lock week can never prove a loss. The weaker
   check set before the numbers still passes: against the season average our pick scored more in
   2024-2025 and in 2026 week 2 replayed. Local copy, not production.
4. **Pointed anywhere else? (revision 4)** C-10 must read `plan_rule`, never `average_check`. C-02
   and C-03 follow the same principle: gate on the plan's named rule, a stand-in only as a floor,
   the prereg filed before any number. RL-1-1's consensus gate must feed this gate. S-02 may claim
   "beats our other arms", never "beats ESPN".
5. **How it unifies (revision 4):** one producer of "ours vs ESPN at start/sit" (the plan rule),
   one store (`model_gate_audits`, now gated on both rules), one Coach line carrying both verdicts
   by name.

Revisions 1-3:

1. **Well built?** Yes, by reuse: the replay (`weekly-backtest.js:88`), the week-clustered
   bootstrap (`backtest-significance.js:57`) and the governance store (`model-governance.js:154`)
   are called unedited. New code is the pair builder, a two-factor resampler for the one shape the
   existing bootstrap cannot express, a pure verdict function, a job, a read-only route and a panel.
   Every run checks itself first: the k control stops at `K.share = 6`, an oracle must win every
   disagreement it has, an identity policy must have none. 60 unit tests plus one loop test; 39 of
   39 mutants killed on the first code, and in revision 2 all 21 applied mutants killed on the final
   code, including the skeptics' seven and ten call-site mutants (§6). Revision 3: the panel test
   file has 11 tests; on the panel, 19 of 19 applied mutants killed at `06408d00`, including the
   structure skeptic's reason-line mutant that survived at `fff49295` (§6, sweeps 7-8).
2. **Stats or made up?** Stats: 6,633 real disagreements from the week-by-week replay of 2024-2025
   and 570 from 2026 week 2, on a local copy (not production). Two choices are judgements, both
   pre-registered and labelled: the ≥ 8.0 startable line (borrowed from `DECISION_CURVE`, not
   fitted) and the season average as the dumb rule.
3. **How we know (direction only, standing rule 3; the sizes are in §4 and §4a for the Auditor):**
   a week-by-week replay of 2024 and 2025 weeks 5-18 (held out for the frozen-2023 weights)
   passed all three pre-registered past tests, and 2026 week 2 replayed on today's settings points
   the same way: verdict `beats_dumb`. What the app actually served in week 2 also points our way
   against the season average, but not clearly. **Against ESPN's own projection, the literal
   "start the highest projection", week 2 points the other way: ESPN's pick scored more.** One week;
   the stress checks in §4a all point the same way. Stress tests and a null calibration in §4.
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
  (`model-governance.js:154`), called from `start-sit-gate.js refreshStartSitGate`. **Tables read
  (revision 2):** `weekly_prediction_snapshots` (writer `weekly-learning.js:49`),
  `league_roster_snapshots` (writer `collect-roster-snapshots.mjs:109`, `projected_points` and
  `player_id` only), `shrinkage_fits.fitted_at`. **Secrets:** none read or written
  (`leagues` is not read). **Licence:** no new external data; the replay reads existing
  `player_week_usage` (nflverse, CC BY; attribution is F-08); ESPN's projections come from the
  leagues' own synced lineups, already stored by the app.
- **Rulings (revision 4):** filed 2026-09-22 (`audits/2026-09-22-C-01-ruling.md`, WORK-QUEUE.md
  :611): (a) the gate gates on ESPN's weekly projection, the average as a floor; (b) the page as
  §10; (c) A1-A9, all done (§0c); (d) the `server/index.js` grant (:610). Rule 2: accepted for H1's
  scope, with addendum 2 filed before week 3 (A8). The two-factor player interval: accepted as the
  primary interval. Rule 3 governs what Nick sees. **Still needed before merge:** CI green on Node 22
  at the pushed head, and an Auditor check of that head in a fresh session. After merge, C12's
  start/sit line stays "partial: instrument live; plan bar not shown met" until the plan-rule
  verdict reads `beats_dumb`.
- **Rulings asked for in revision 3 (history):** (a) a prereg committed before the run but
  not filed with the Auditor (rule 2); (b) the two-factor player interval; (c) the season average as
  the gating dumb rule, now with the literal ESPN arm pointing against us on week 2; (d) the unit
  row's "decision win rate and points shown on the Lineup page" against rule 3 (this unit assumes
  rule 3 wins and shows direction only). **Coordinator:** the file grant in §7.17.
  **Status after the round-2 review (revision 3):** none of the four rulings and no grant is on
  file (`grep -c 'C-01' ~/gridiron-local/WORKLOG.jsonl` → `0`; no `board/unit-C-01.json`). This
  branch is not mergeable until they are.

## 10. What Nick sees (direction only)

**Revision 4.** The real panel (`StartSitGate.tsx` at `1bdfdef9`, after the Auditor's fresh-session
item), compiled with the repo's TypeScript and rendered with React, fed what `GET /api/gates/start-sit`
serves from the local copy after the revision-4 run was stored (`latestStartSitGate()`, read from a
throwaway copy of that copy so it stays at `73e67399…`; scratchpad `c01-fix4/render-fix.mjs` →
`c01-fix4/render-fix-2.out`). Its visible text, above "What was compared":

> Does our projection beat ESPN's projection?
> The plan's dumb rule: start whoever ESPN projects higher.
> **Not shown to beat ESPN's projection** (amber)
> In the one week measured (2026 week 2), ESPN's pick scored more. ESPN's number was read at lineup lock, after news our projection did not have, which favours ESPN. Until this passes, treat our start/sit calls as no better than ESPN's projection.
> Weaker check, set before the numbers: against "start the higher season average", our pick scored more in 2024-2025 and in 2026 week 2 replayed.
> What the app served this season, against the season average (the weaker check): our pick scored more.
> The week 2 projection was served on older settings (before the fitted volume numbers existed; different blend weights), so what the app served and today's replay are not the same projection.
> Few weeks so far: this season shows direction, not proof.
> **Weeks our projection lost**
> This season as the app served it, against ESPN's projection (the plan's rule): 2026 W2
> Past seasons, against "start the higher average" (the weaker check): 2024 W10 · 2024 W11 · 2024 W14 · 2025 W13 · 2025 W14
> This season, today's model replayed, against the average: None: our pick did not lose a graded week.
> This season as the app served it, against the average: None: our pick did not lose a graded week.

- **No green:** 0 `bg-emerald` classes (b97d5ea2 rendered 1 emerald chip on the ruling's result);
  1 amber chip. Emerald appears only for a plan-rule `beats_dumb`.
- **No softening line:** the render at `bc0062d8` also carried '"Not shown" is not the same as
  "worse": these weeks may be too few to show a small edge.' under the chip; `1bdfdef9` removed it
  (§0c), and the render above has neither "not the same as" nor "small edge".
- **No magnitude:** `grep -o -E '[0-9]+(\.[0-9]+)?%|[+-][0-9]+\.[0-9]+'` on the render finds nothing;
  the same grep on the run's JSON finds `-1.3357`, `-0.8139`, … (known-nonzero control). The panel
  test goes further and allows no digit at all except seasons, weeks, the timestamp and the two
  rules in the universe text (8.0 PPR, 0 if he did not play).
- "What was compared" opens with "The plan's dumb rule: …" (ESPN's projection) and then "The weaker
  check, set before the numbers: …" (the season average).

**Revision 3, for the record** (`06408d00`, before the ruling): the heading read "Does our projection
beat the dumb rule?" and the chip was an emerald 'Beats "start the higher average"', with ESPN's
lost week listed last. That is what the ruling replaced.
