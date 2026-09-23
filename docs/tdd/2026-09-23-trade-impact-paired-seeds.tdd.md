# RL-6-3 (CE-09): Trade Lab's title-odds deltas become a paired experiment

Unit RL-6-3, plan item CE-09 (title-odds currency, critical), TM-01 / TM-04.
Branch `claude/local-rl-6-3-trade-impact-paired-seeds`, cut from origin/main `3ac59fea`
(CE-05 #168 already merged there, so no merge-in was needed).

## 1. Audit: extend, not build

What exists on `3ac59fea`:

- **The one producer of a title-odds delta** is `server/services/season-sim.js#tradeImpact`
  (`:452-497`). Every surface goes through it:
  - Trade Lab "Title impact" tab: `server/services/title-odds-trades.js:66` (seed 1, 800 runs)
    -> `client/src/pages/TradeLab.tsx:286-307`.
  - TradeCard "Title odds impact": `POST /model/:id/trade-impact` at `server/routes/model.js:465-481`
    (random seed per click, 1,200 runs) -> `client/src/components/TradeCard.tsx:343-370`.
  - The sense-check verify loop: `server/routes/trades.js:1155` (seed 1) -> `server/services/trade-verify.js`
    (`NOISE_SD_AT_REFERENCE_RUNS = 0.0155`, measured on the broken pairing).
  - `grep -rn "title_delta" server client/src` finds no second producer. The finder's horizon odds
    (`trade-engine.js:1380`) are one seeded `simulateSeason`, not a delta.
- **The pairing is broken by construction.** `tradeImpact` seeds both arms with the same
  `withRandomSeed(pairedSeed, ...)`, but `simulateSeason` hands out one global mulberry32 stream
  (`stats-util.js:77-97`) in roster-array order:
  - `season-sim.js:313` builds `roster` in team order, then each team's player order.
  - The trade's overrides rebuild both teams as `kept + received` (`:463-466`), so every player from
    the first moved slot on sits at a new position.
  - `:325` `for (const p of roster)` draws each player's outcome pool from the shared stream
    (`sampleWeeks` -> `projections.js:989`), and `correlatedNormals` (`stats-util.js:302-312`) draws
    the copula normals in the same order, one per active player per draw.
  - So after the first displaced player every player in the league, including uninvolved teams,
    gets different random football in the "after" run.
- **No test pins reorder invariance.** `git grep -n "paired\|title_delta\|common random" origin/main -- test`
  hits only `trade-verify.test.js` (which consumes a hand-built impact) and bootstrap/alt-line tests.
  Control for the grep: the same grep for `tradeImpact` finds `b-01-real-record-odds.test.js`,
  which asserts only `from_week` and `playoff_before`.
- The R&D package measured the damage on a local copy of W3: a roster-order-only permutation moves
  a team's title odds by up to 6.5 pp at 400 runs; seed-to-seed sd of `title_delta` on the tab's
  shortlist is 2.15 pp median at 800 runs (`rnd/loop/r6-internal-title-odds-pairing-broken.md` §1b-1c,
  on origin/main `89f69b3b`, whose sampling code is unchanged at `3ac59fea`).

Decision: **extend** `tradeImpact` / `simulateSeason` in place (no new producer), and carry the new
paired standard error through the three existing consumers.

## 2. Pre-registration (committed before any number is run)

This is an estimator-correctness fix, not a model that predicts anything, so there is no held-out
season and no 2025 look. What is pre-registered is the variance claim and the SE calibration.

- **Method.** Common random numbers (CRN) only reduce variance when each random number is used for
  the same purpose in both configurations ("synchronisation"; Law, *Simulation Modeling and Analysis*
  5e §11.2; Rossetti, *KSL* §9.2). The standard way to synchronise is a dedicated stream per source of
  randomness (L'Ecuyer, Simard, Chen and Kelton, *Operations Research* 50(6), 2002). Here each
  player-week outcome pool is seeded from a hash of (sim seed, player id, week), and each copula
  normal is a counter-based draw keyed by (sim seed, player id, week, run), in the style of
  Salmon et al., "Parallel random numbers: as easy as 1, 2, 3" (SC'11). The paired SE is the textbook
  paired-difference SE: sd(after_i - before_i) / sqrt(runs) over the per-run title indicators.
- **H1 (deterministic, tests).** A roster-order-only permutation leaves every team's title odds,
  playoff odds and expected wins exactly unchanged; a bench free agent who never starts, given the
  highest id, changes nothing to 1e-9; a real trade's published paired SE is below the unpaired
  binomial SE on the fixture.
- **H2 (local copy, W3).** Metric: median over the Title-impact shortlist deals of the seed-to-seed sd
  of `me.title_delta`, seeds 1-5, 800 runs, default scoring, shortlist 6. Baseline: the served build
  on the same local copy, same deals, same seeds. Sign convention: `title_delta = after - before`,
  positive = the trade raises my title odds.
- **Ship rule.** Ships ON if H1's tests pass AND the fixed build's median seed sd is <= 1.0 pp AND the
  published paired SE matches the seed sd within +/-25% (median ratio in [0.75, 1.25]). If the SE
  calibration misses but H1 and the 1.0 pp bar hold, the fix ships and the greying uses the seed-sd
  measurement instead, recorded as a known defect.
- Forward holdout: not applicable (no prediction is graded). Holdout looks: none (2025 not opened).

## 3. RED / GREEN

Test file: `test/rl-6-3-trade-impact-paired.test.js`. Command, every run:
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/rl-6-3-trade-impact-paired.test.js`

- **RED** `f3ded73a` "test: RED for identity-keyed draws and paired SE in tradeImpact", on `4a36b681` code: 6 of 7 fail.
  - #1 permutation: `deepEqual` fails, team 1 `[0.3075, 0.6675, 1.88, 204.2]` vs `[0.27, 0.6825, 1.94, 204]` (title, playoff, wins, points) for the same players merely listed in reverse.
  - #2 benched claim: `team 1 field 1: 0.3275 -> 0.2925 after a benched claim` (a free agent who never starts moved team 1's title odds 3.5 pp).
  - #3 SE: `expected: 'number', actual: 'undefined'` (no `title_delta_se`).
  - #5 no-seed determinism: `expected: 4075509328, actual: 268889711` (a fresh random seed per call).
  - #6 verify bar: `expected: 0.04, actual: 0.0219` (the SE argument is ignored).
  - #7 banners: `summariseTitleTrades is not a function`.
  - #4 (paired seed-sd below two independent runs) PASSED on the broken code: the served pairing is not fully unpaired on this fixture. It is kept as a behaviour pin, not claimed as a liveness proof; M4 below is its liveness.
- **GREEN** `7dc1a841` "fix: key tradeImpact's simulated draws to player identity and publish a paired SE": 7/7 pass.
- `4c17e8c1` "test: RL-6-3 call-site coverage for the verify judge and Title-impact tab" adds #8 (`judgeTradeVerdict` uses the impact's own SE) and #9 (`titleOddsTrades` carries `title_delta_se` / `title_delta_clears_noise`); 9/9 pass. Their liveness is M7 and M8.
- Neighbouring tests on the GREEN tree (same command shape, one file each): b-01-real-record-odds 8/8, decision-leftovers-home-away 5/5, league-rules-bracket-sim 4/4, league-rules 15/15, trade-verify 24/24, trade-engine-correctness 15/15, ceiling-lineup-recency 6/6, ceiling-lineup-weekly-agreement 3/3.

## 4. What it does

- `server/services/stats-util.js`: `keyedSeed(...parts)` (FNV-1a + murmur3 finaliser) and `keyedNormal(key, counter)` (counter-based normal). `correlatedNormals(L, iid)` takes optional caller-supplied iid normals.
- `server/services/correlation.js#correlatedSampler(players, samples, keys)`: with keys, `sample(counter)` gives player i `keyedNormal(keys[i], counter)` before the Cholesky mix. Without keys it is unchanged (ceiling-lineup.js still uses the stream).
- `server/services/season-sim.js#simulateSeason`:
  - the simulated player list is sorted by id, not built in roster order;
  - one draw from the caller's stream names the "world"; each player-week pool is sampled under `keyedSeed(world, 'pool', id, week)` and each copula normal is keyed `(world, 'copula', id, week)` with the run index as counter;
  - `keepRuns: true` returns per-run title/playoff indicators (only `tradeImpact` asks).
- `tradeImpact`: publishes `title_delta_se`, `playoff_delta_se` (paired SE = sd(after_i - before_i)/sqrt(runs)) and `title_delta_clears_noise` / `playoff_delta_clears_noise` (|delta| > 2 SE, `TRADE_DELTA_NOISE_SE`). No seed now means `tradeImpactSeed(lg)` = one seed per (league id, fetched_at), so `POST /model/:id/trade-impact` (`server/routes/model.js:465-481`, unchanged) gives one answer per deal per sync instead of a new answer per click.
- Consumers:
  - `title-odds-trades.js`: carries the SE and flag per deal; banners moved into exported `summariseTitleTrades(scored)`, which counts only deltas that clear the noise; new `no_deal_clears_noise` with its own note. "Both gain" needs both deltas to clear the noise.
  - `TradeLab.tsx` Title-impact tab: one decimal, "±2SE", in-noise deltas greyed and labelled "within noise".
  - `TradeCard.tsx` title-odds panel: "±2SE", in-noise deltas muted.
  - `trade-verify.js#contradictionBar(runs, threshold, pairedSe)`: noise bar = 2 × the deal's own paired SE when present; the 0.0155 constant is fallback only.
- Round 2 (§9): `tradeImpact` also defaults runs to `TRADE_IMPACT_RUNS` and scoring to `scoringFor(lg)`; no caller (tab, card route, sense-check route) passes seed, scoring or a different default run count, so one deal is one number on every surface. `simulateSeason({ universe })` gives both arms one player set.
- No table, column, migration or route added.

## 5. Mutation sweep (on `4c17e8c1`)

Script: session scratchpad `mut.py` (apply one textual mutant, run the test file, restore). Results:

| Mutant | Where | Result |
|---|---|---|
| M1 player list not sorted by id | season-sim | killed by #1 |
| M2 pools off the shared stream | season-sim | killed by #1 |
| M3 copula keys not passed (call site) | season-sim -> correlatedSampler | killed by #2 |
| M4 `wd.draw()` instead of `wd.draw(run)` | season-sim | killed by #3, #4 |
| M5 paired SE uses after+before | season-sim | killed by #3 |
| M6 default seed random again (call site) | tradeImpact | killed by #5 |
| M7 judge ignores the SE (call site) | trade-verify | killed by #8 |
| M8 tab drops `title_delta_clears_noise` (call site) | title-odds-trades | killed by #9 |
| M9 "every deal lowers" banner ignores noise | title-odds-trades | killed by #7 |
| M10 `keyedNormal` ignores its key | stats-util | killed by #3 |
| S1 `>` to `>=` in clears_noise (intended survivor) | season-sim | killed by #9: the fixture deal at 200 runs has delta 0 and SE 0, so `0 >= 0` flips the flag. This means a zero-SE delta counts as "not real", which is the behaviour we want. Replaced as the survivor by S2 |
| S2 designed survivor: hash part separator 0x1f -> 0x2f | stats-util | survived (an equally valid keying; nothing should pin the constant) |
| C1 designed not-applied control | season-sim | not applied (pattern absent) |

## 6. Numbers (local copy, not production)

Setup: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"` at 05:52 ET; leagues last synced `2026-09-23 09:09:41` (UTC); `fetched_at` checked before and after every league in both arms: `synced_mid_run = false` 5/5, both arms. "served" = a detached scratch worktree at origin/main `3ac59fea`; "fixed" = this branch at `4c17e8c1`. Leagues are read with an explicit column list (cookie columns never selected). Scripts live outside the repo: `~/gridiron-local/rnd/loop/scripts/rl63_null_reorder.mjs`, `rl63_crn_measure.mjs`, `rl63_summary.py`; outputs in `~/gridiron-local/rnd/loop/data/rl63/`. Env for every run: `GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite SCHEDULER_DISABLED=1 GRIDIRON_DB_INTEGRITY_CHECK=off nice -n 10 node ...`.

**6a. Null reorder (each roster listed in reverse, same players, seed 1, 400 runs).** Command: `node rl63_null_reorder.mjs <tree>`. Max absolute change over all teams:

| League | served `3ac59fea` (title / playoff / wins) | fixed `4c17e8c1` |
|---|---|---|
| L1 | 3.50 pp / 6.00 pp / 0.35 | 0 / 0 / 0 |
| L2 | 2.75 / 3.75 / 0.19 | 0 / 0 / 0 |
| L3 | 5.00 / 3.75 / 0.16 | 0 / 0 / 0 |
| L4 | 3.25 / 4.75 / 0.18 | 0 / 0 / 0 |
| L5 | 4.00 / 7.25 / 0.15 | 0 / 0 / 0 |

The served column is the known-nonzero control for the fixed column's zeros.

**6b. Title-impact shortlist, seeds 1-5, 800 runs.** Command: `node rl63_crn_measure.mjs <tree> <label> deals.json <out>.json`, then `python3 rl63_summary.py`. The 23 deals (L1 6, L2 3, L3 6, L4 6, L5 2) were built once by the served tree's `findTrades` plus the `title-odds-trades.js` dedupe (shortlist 6), and both arms read the same file.

```
median seed sd pp: served 0.87 fixed 0.81; mean 1.07 vs 1.01; variance ratio (mean sd^2) 1.17
paired SE / seed sd (fixed): median 1.18, IQR 0.81-1.73, n=23; median published SE 1.03pp
deals whose sign flips across seeds: served 7, fixed 5 of 23
seed-1 deals clearing 2 SE (fixed): 11 of 23
```

- **Against the pre-registered rule:**
  - H1 passes (§3, 9/9).
  - Fixed median seed sd is 0.81 pp, inside the 1.0 pp bar.
  - SE calibration: median ratio 1.18, inside [0.75, 1.25].
  - Verdict: **ships ON**.
- **What did not reproduce.** The R&D package's served baseline (2.15 pp median, variance ratio 4.15, on `89f69b3b` against the 08:06Z sync) did NOT reproduce on `3ac59fea` against the 09:09Z sync. The served median here is 0.87 pp, so the variance cut measured on this tree is small (ratio 1.17).
  - I did not establish why. Two candidate causes, both guesses: CE-05 #168 changed `season-sim.js` (bracket weeks); the shortlist deals are different.
  - What this unit can claim on this tree: the reorder drift is gone (6a), and every delta now carries an SE that matches its seed-to-seed spread within the pre-registered band. It cannot claim a 4× variance cut.
- **The paired SE against the old spread (counts only).**
  - The median published paired SE (1.03 pp at 800 runs) is larger than the served seed sd (0.87 pp). The old two-decimal display carried no interval at all.
  - Under the fixed build, 12 of 23 seed-1 deltas are inside 2 SE, and those are now greyed rather than painted red or green.
- **The sense-check bar.** It moves from the 2.19 pp constant (at 1,200 runs) to 2 × each deal's own SE. Extrapolating the 1.03 pp SE from 800 to 1,200 runs gives about 1.7 pp. That is a guess by 1/sqrt(runs) and was not measured.
- **Decision grading (discipline d/e).** Not applicable. This fixes the estimator; it makes no start/sit, waiver or trade call of its own. Whether title-odds ranking beats points ranking is CE-10's question.
- **Holdout looks.** None: 2025 not opened; 2026 W3 rosters only.

## 7. Known defects and what this does NOT cover

- ~~Adding a player is exact only for same-game players listed before him.~~ Fixed in `e39e6b8f` (see §9): `simulateSeason` takes a `universe` and `tradeImpact` passes give+get to both arms, so both arms simulate one player set. A caller that calls `simulateSeason` directly for a claim (CE-09's ladder) must pass the same `universe` to both arms; the test shows what happens if it does not.
- **Cholesky jitter** now sees the same matrix in both arms (same player set), so it is paired too. It is still global across a week if a matrix is non-PD.
- **`NOISE_SD_AT_REFERENCE_RUNS` was not re-measured.** It is now only the fallback for an impact with no SE, and no current producer emits one without it.
- **The SE is run-to-run only.** It excludes the per-seed outcome-pool error, which is shared across runs within one seed. The calibration ratio of 1.18 says the SE still covers the seed spread on these 23 deals.
- **Client files were not type-checked here.** Per the unit rules, the Gate phase runs `npm run check`.

## 8. Nick's five questions

1. **Well built?** One producer is extended in place (`tradeImpact`). Its draws are keyed to player identity, and the three consumers read the new SE: the Title-impact tab, TradeCard and the sense-check. There are 9 tests plus a 13-row mutation sweep with call-site mutants, a designed survivor and a not-applied control. No new table, column, route or migration.
2. **Stats or made up?** Stats. The paired-difference SE and the 2-SE rule are the ordinary conventions (2 is a convention, not fitted).
3. **How we know.** Deterministic tests (§3). On the local copy: a reorder moved title odds up to 5.00 pp on served and exactly 0 on fixed. On the tab's 23 deals the SE matched the seed spread at a median ratio of 1.18. No backtest, because nothing is predicted.
4. **Pointed anywhere else?** Yes: `POST /model/:id/trade-impact` (TradeCard, now one seed per sync), `routes/trades.js:1155` (the sense-check, via `judgeTradeVerdict`), and the Title-impact tab. The finder's horizon odds (`trade-engine.js:1380`) now run on keyed draws too: their numbers shift by Monte Carlo noise, with no change of method.
5. **How it unifies.** Every title-odds delta on the platform comes from `tradeImpact` and now carries the same SE and the same noise rule (`TRADE_DELTA_NOISE_SE`). The sense-check bar and the tab's greying use that one number instead of a separately measured constant.

- **Defect fixed:** `season-sim.js:313,325,356` on `3ac59fea` (positional draws).
- **Incumbent:** `tradeImpact` (`git grep -n title_delta -- server` shows no other producer).
- **What would make this wrong:** the SE under-covering on other leagues (IQR upper 1.73 means some deals' SE is conservative, not the reverse), or a consumer that reads `title_delta` without the flag. Current readers: `TradeLab.tsx`, `TradeCard.tsx`, `trade-verify.js`, `title-odds-trades.js`.

## 9. Re-review fixes (skeptic round 1)

Commits: `e39e6b8f` (fix), `ee885017` (tests). All numbers below: tree `ee885017`, unless named.

| Skeptic finding | Fix | Proof |
|---|---|---|
| A low-id free agent moved an uninvolved team (0.305 -> 0.3075) | `simulateSeason({ universe })`; `tradeImpact` passes `[...give, ...get]` to both arms | tests #2 (ids 999 and 50, plus an unshared-universe control that must differ) and #11 (`tradeImpact` claim of either id gives exactly 0 for both sides) |
| Three seeds / run counts / scorings for one deal (tab seed 1 at 800 runs in PPR, card `tradeImpactSeed`, sense-check seed 1) | `tradeImpact` defaults: `tradeImpactSeed(lg)`, `TRADE_IMPACT_RUNS` (= `SENSE_CHECK_SIM_RUNS`, 1200), `scoringFor(lg)`. `title-odds-trades.js`, `routes/trades.js` and `routes/model.js` pass none of them | test #9 (tab == `tradeImpact` defaults, field by field), #12 (tab default runs, 0-PPR league scored STANDARD, source pin: no caller passes `seed:`/`scoring:`). Local copy, not production: 14 of 14 deals in 5 leagues identical on tab, card-shaped and sense-check-shaped calls (below) |
| Unread fields | TradeCard greys and bands `playoff_delta` via `playoff_delta_se`/`playoff_delta_clears_noise`; TradeLab greys and bands `their_title_delta` via `their_title_delta_se` / new `their_title_delta_clears_noise`, and shows `no_deal_clears_noise` in the header. Dropped `noise_rule` and `threshold.paired_se` (no reader; `noise_bar` already carries the SE) | `grep -rnE 'playoff_delta_se\|playoff_delta_clears_noise\|their_title_delta_se\|their_title_delta_clears_noise\|no_deal_clears_noise' client/src` now hits TradeCard.tsx and TradeLab.tsx |
| Test #9 degenerate (every value 0/1) | Cause: `trade-engine.js` imports `season-sim.js`, so the plain instance loaded UNMOCKED (empty projections, every team scores 0, team 1 wins every run). The test now mocks `season-sim.js` with the mocked instance and imports `title-odds-trades.js?rl63`. At 300 runs my flag clears and theirs does not, and the SEs differ. `mutual_title_gain` is now `mutualTitleGain()`, unit-tested (#10) | mutants N3, N6, N5 below |

**Mutation sweep on `ee885017`** (script: scratchpad, applied one at a time, file restored with `git checkout --` after each; command per mutant: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/rl-6-3-trade-impact-paired.test.js`):

| Mutant | Result |
|---|---|
| N1 `simulateSeason` ignores `universe` | killed (#2, #11) |
| N2 `tradeImpact` passes an empty universe | killed (#11) |
| N3 tab shows their SE as mine | killed (#9) |
| N4 tab back to `seed: 1` | killed (#9, #12) |
| N5 `mutualTitleGain` drops their noise check | killed (#10) |
| N6 `their_title_delta_clears_noise` read from my side | killed (#9) |
| N7 tab default runs back to 800 | killed (#12) |
| N8 `tradeImpact` default scoring back to PPR | killed (#12) |
| N9 sense-check back to `seed: 1` (routes/trades.js) | killed (#12, source pin) |
| S2 designed survivor `Number(id)` -> `+id` | survived (equivalent) |
| C1 control (text not in file) | not applied |

A first "designed survivor" (renaming the copula key label) was killed by #9, because it changes the draws and so the fixture's "flags differ" check; it is not an equivalent mutant.

**One number on real data** (local copy, not production; `.local-db` backup of 2026-09-23 05:52): `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<wt>/.local-db/data.sqlite node ~/gridiron-local/rnd/loop/scripts/rl63_one_number.mjs <wt> ~/gridiron-local/rnd/loop/data/rl63/one_number.json`. For each league, the tab's shortlist of 3 at default runs, then `tradeImpact` called the way `model.js:471` and `trades.js:1155` call it. 14 of 14 deals in 5 of 5 leagues: tab, card and sense-check give the same `[title_delta, title_delta_se, clears_noise, their_title_delta]` and the same seed. Example, league 1 first deal: -2.42 pp, SE 1.33 pp, inside the noise, on all three.

**Cost.** The tab now runs at 1,200 runs, up from 800. Measured first-load times for a shortlist of 3 at 1,200 runs, on the same local copy: 44.0 / 27.5 / 22.4 / 26.5 / 18.3 s. The page asks for a shortlist of 6, so about twice that is a guess; the results are cached per league sync. The 800-run time on this tree was not measured, so the slowdown factor (about 1.5x by run count) is a guess.

**Behaviour change to name:** the tab used to score every league as PPR (it never passed `scoring`). It now uses `scoringFor(lg)` like the card, so tab numbers in non-PPR leagues change.

**Neighbour tests on `ee885017`** (same command shape): b-01 8/8, decision-leftovers-home-away 5/5, league-rules 15/15, league-rules-bracket-sim 4/4, trade-engine-correctness 15/15, trade-verify 24/24, wiring-map 90/90. RL-6-3 file 12/12.
