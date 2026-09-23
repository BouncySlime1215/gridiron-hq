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
