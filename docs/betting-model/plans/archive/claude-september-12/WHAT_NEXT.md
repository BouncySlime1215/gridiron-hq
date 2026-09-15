# Gridiron HQ — what I'd do next
**2026-09-12 evening.** Written after: three audits, a 121-agent research sweep, one completed
fix/consolidation build (16 pieces, merged and tested), and a betting-model build that is 9 of 11 done.
**Revised later the same night** after a five-reader sweep of the codebase, the research corpus, the audit
corpus and the GitHub catalog, whose surviving findings are folded in below.

---

## Read this first

**The production spread forecast is the market line, by construction, and always has been — the single
fact that should anchor everything else on this page.** `blendMode:'market_residual'` returns the
market's own margin unless at least one ensemble component clears a promotion gate; across every fit
this project has ever run — 848 stored artifacts, 26,288 component-cutoff rows — that gate has passed
**zero** times (full detail in 2.0). So the fair one-line summary of the betting-model work is not
"several honest nulls" — it is one measured win (calibration), a forecast-combination attempt that lost
cleanly to the incumbent, and a production model that has never once moved off the market at all. None
of that is a disappointing result — it is honest abstention working exactly as designed, and a
trustworthy no is worth more than an ambiguous maybe — but it also means the settled −7.7% ROI verdict
describes a *different function* (`raw`) than the one actually staked (`market_residual`), and Step 2
cannot produce an interpretable leaderboard until every row declares which function it is.

**That same finding is why Step 0 cannot wait.** Two things are actively breaking, right now, in ways
this honest accounting cannot redo later: week-1 2026 scores never landed for 14 of 16 games, which has
pinned `currentNflWeek()` at 1 and frozen seven downstream modules there since kickoff; and
`beat-the-close` — the one forward, zero-stake experiment this document treats as the season's honest
target — has written zero week-2 decisions and settled only 6 of 61 shadow decisions, for the same
reason plus a kickoff-window capture gap, leaving 55 permanently unsettled if that gap isn't closed. Even
that record's headline signal isn't clean yet: item 27 shows the nfelo-vs-Pinnacle-opener family selected
its hyperparameters inside its own holdout window, so expect the number to shrink once it is re-measured
honestly. Neither finding changes the betting *outlook* — there is still no prediction edge, and
execution and props are still where the real ones live — but both are actively destroying data the week
is about to move past, which is why there is now a Step 0, and why it comes before everything else here.

Given your own standing priority — fantasy beats betting — the fantasy side (Step 3) is where I would
spend the next block of *building*. Run alongside it: Step 2's honest historical verdict, which turns
five years of development data (15,096 closing lines, a 1,424-game common universe) into a number
corrected for the 21 attempts already made against it; and Step 4's props work, which routes this
project's one *proven* skill at a market inconsistency instead of trying to out-predict anyone. Nick's
push on Step 2 was correct — this is not a starting-from-zero situation.

---

## Step 0 — This week, because the data stops existing if it waits

Everything here is cheap. What makes it urgent is not difficulty, it is that each item is currently
destroying or failing to record something that cannot be reconstructed later.

1. **Week-1 2026 scores never landed, and that has frozen the entire forward record.** `game_lines` holds
   scores for exactly 2 of 16 week-1 games (LAR–SF and SEA–NE); the other 14 still have
   `team_score IS NULL`. `currentNflWeek()` is defined as `MIN(week) FROM game_lines WHERE season=? AND
   team_score IS NULL` (`server/services/weekly-learning.js:206-209`), so it returns **1** and will keep
   returning 1 until those scores arrive. Seven modules read it — `beat-the-close.js`, `nfl-prop-clv.js`,
   `nfl-external-ratings.js`, `book-feeds-extra.js`, `weekly-learning.js`, `scheduler.js`,
   `routes/nfl-market.js` — and all of them are stuck on week 1 on 13 September. The live `sync_log` row
   for `beat_the_close` proves it: `runs: 197`, `last_status: "ok"`, and inside the detail,
   `"snapshot":{"season":2026,"week":1}` and `"decided":{"season":2026,"week":1,"frozen":0}`. A healthy-looking
   job, running hourly, doing week 1 forever. *Cost: hours, once you know why the score ingest wrote two
   games and stopped.* *Caveat: a past diagnostic already flagged score ingestion once; whatever was done
   then is not holding now, so fix the ingest, then add the assertion that would have caught it — a
   completed-kickoff game with a NULL score after 24 hours should raise, not silently pin the clock.*

2. **`beat-the-close` has frozen 61 decisions, settled 6, and written zero week-2 rows — and it *is* the
   2026 forward record.** This is the project's only forward, timestamped, zero-stake experiment on the one
   +CLV signal family, and the closing section of this document calls a record exactly like it the honest
   target for the season. Live state: `nfl_signal_snapshots` 38,055 rows through 2026-09-13T01:00 (capture
   is healthy), `shadow_decisions WHERE regime='beat_the_close'` 61 rows, all season 2026 week 1, 6 settled.
   Two separate causes, both fixable: the week pin from item 1 stops new decisions, and settlement reports
   `{"settled":0,"waiting":55}` because `settleBeatTheClose` (`beat-the-close.js:275-286`) needs both a
   `game_lines` score and a Pinnacle line captured near kickoff, and only 4 of the 9 past-kickoff events in
   the tape have any capture inside 60 minutes of kickoff (the same measurement item 31 cites again for
   the coverage of its own CLV claim). *Cost: hours for the week pin; the kickoff-window
   capture coverage is a scheduler question worth answering before Week 3.* *Caveat: Pinnacle's last
   pre-kickoff line for a game that already kicked off is not recoverable from a live feed later — check
   whether `nfl_odds_archive` still holds week-1 closes before assuming the 55 are lost.* **Note for
   whoever picks this up:** an earlier read of this claimed nothing schedules the module. That is wrong —
   `scheduler.js:761` registers `beat_the_close` on a 60-minute live-tier cadence and `:381` calls
   `runBeatTheClose()` (snapshot + decide + settle). The job runs; its inputs are wrong.

3. **The prop price feed is dead and both jobs report `last_status: "ok"`.** `nfl_prop_clv` has had no new
   row since 2026-09-07T18:21Z. Live `sync_log`: `nfl_prop_feeds` returns
   `{"actionnetwork":{"games":16,"stored":0,"unsupported":1595},"underdog":{"error":"HTTP 426"}}` and
   `nfl_prop_clv_free` returns `quotes_seen:100944, stored:0, modeled:0`. Underdog 426s on every run;
   Action Network sees 16 games and stores nothing because all 1,595 of its markets are unsupported types.
   **The whole of Step 4 inherits this** — 4a, 4c and 4d all assume a live producer, and this document
   currently says of the prop tape "from here forward it is [measured]", which is false as of right now.
   *Cost: hours to diagnose, unknown to restore — the 426 may be a deliberate block.* *Caveat: see Step 4's
   corrected premise; restoring Underdog alone does not unblock 4a, because Underdog posts no game totals
   and no touchdown markets.*

4. **Merge the receipt-clock fix ahead of the rest of the branch, not alongside it.** Step 1 item 6 covers
   merging the branches as a batch. This one piece should jump the queue: all 1,521 rows of
   `nfl_quote_batches` carry `receipt_clock_source = 'legacy_request_time_only'`, including every
   `free-book-feeds` batch written through 2026-09-13T01:47Z. `nfl-t60-packet.js:214` filters on
   `receipt_clock_source === 'response_completion'`, so `realClock` is empty for every game and
   `received_by_cutoff` can never be granted — which is the actual cause of the symptom Step 8 names as
   "no forecast has yet consumed a frozen packet in production". The fix already exists at
   `build-2026-09-12-v2-integration:server/services/book-feeds.js:418`
   (`receivedAt: at, receiptClockSource: 'response_completion'`); `main` does not have it. *Cost: it is
   already written; this is a merge-ordering decision, not work.* *Why it is here and not in Step 1: rows
   written before the merge cannot be relabelled afterwards, because the receipt time was never recorded.
   Week 2 is being captured into permanent unusability while this waits.*

5. **Pre-register the 2026 review endpoints before Week 3 kickoff.** The audit did the arithmetic this
   document currently asserts the conclusion of: ROI needs ≈560 settled bets to resolve +10% and ≈2,250 to
   resolve +5% — three seasons and eleven seasons respectively at five picks a week — but **all-game point
   CLV at T-60 on 272 observations is decidable** (+0.3 points needs ≈35-70 games iid, ≈50-100 clustered;
   +0.5pp of price CLV at SD ≈1.5pp needs ≈55). Three things follow, none of them currently in motion:
   (i) CLV must be graded for **every tape decision, selected and abstained** — that is what makes the
   denominator 272 instead of ≤90, and `nfl-execution-clv.js` today grades accepted positions only;
   (ii) the T-60 threshold must be re-declared against the 2026 tape's own T-60→close distribution once
   ~4 weeks exist, *before* anyone looks at the model's side of it, because the existing +0.3 gate was set
   for opener-based signals over days of movement and does not transfer to a 60-minute window;
   (iii) one `audit_registry` row per hypothesis — point CLV and price CLV, explicitly **not** ROI — with a
   Week-9 integrity endpoint (counts and coverage only, no economic claim) and a Week-18 CLV endpoint, σ and
   τ taken from 2021-25 development data. *(This is the same `audit_registry` table as Step 2 item 2b's
   "trial registry" and Step 8's "registry-and-gate layer" — one table, three names for three different
   uses of it; see 2b for the full reconciliation.)* Today is 2026-09-12 and week 2 is in progress. *Cost:
   hours to write the registry rows; the value is entirely in doing it before the data exists.* *Related
   and free: `always_valid_p` is NULL on all 15 registry rows — the mSPRT implementation at
   `backtest-significance.js:216-230` is correct and has simply never been fed a σ.*

## Step 1 — Close out what's already built (do this first, it's nearly free)

6. **Let the betting-model build finish** (joint scoring model + execution realism are still running), then
   read the integrator's independent re-check of every claimed improvement.
7. **Review and merge the two completed branches.** `build-2026-09-12-v2-integration` (the 16-piece fix
   build) and whatever the model build produces. Everything is tested, nothing is merged to your real
   branch yet, and the reports name exactly which items are high-confidence versus which want your eyes.
   *(The receipt-clock piece of this branch should go first and separately — Step 0 item 4.)*
8. **Commit the separate `nfl-execution-replay` fix** sitting uncommitted in your live checkout from the
   other session, and delete the stray `.Rhistory` file.
9. **Push the 58 commits.** They need the GitHub token's missing `workflow` scope fixed first. Three days
   of real work exists on exactly one disk; this is the single highest-consequence, lowest-effort item on
   this whole page.
10. **Apply the new migrations to the live database — deliberately, with you present, not overnight.**
    Tonight's builds wrote them but never applied them, on purpose. Rehearse on a copy first, exactly as
    this project's own past practice does.

## Step 2 — The honest historical verdict (added 2026-09-12, at Nick's push — and he was right)

**Why this exists.** The framing "don't expect profit in year one" was half wrong. There are 15,096
closing lines, a 1,424-game common universe, and 545 bets per audit run in the 2021-2025 history — that
is an adequately-powered dataset, not a starting-from-zero situation, and it already returned a verdict
— for the `raw` blend specifically; see 2.0 for why that is not the function production runs — (negative:
−7.7% ROI on spreads, ensemble RMSE 12.840 vs the market's 12.448 at t=4.47, mean CLV −2.28).
What that history *cannot* currently do is serve as honest evidence for any model, because those same
years were used to build, tune and select across 21 variants, and nothing has ever corrected for that.
This step converts five years of development data into a verdict you can actually stand on — and makes
every future model comparison interpretable instead of suggestive.

### 2.0 — Read this before designing the protocol: the staked model and the audited model are not the same model

**The production spread forecast is the market line by arithmetic, and always has been.**
`blendMode:'market_residual'` returns `marketMargin` unless at least one component clears
`residual_n ≥ 250 && residual_rmse_gain ≥ 0.03 && residual_paired_t ≤ −1.645`
(`nfl-ensemble.js:1185-1189`, applied at `:1299`). I scanned every stored fit artifact:
**848 artifacts, 26,288 component-cutoff rows, zero have ever passed that gate.** The best result in the
repository's entire history is `trenches` at cutoff 2017|7 — gain 1.42, t = −1.703, **n = 14**, blocked on
the sample floor by a factor of eighteen.

Consequences, all of which change how Step 2 must be run:

- `unifiedGameProjection`'s "canonical answer" margin **is** the market spread, and the drive simulator is
  min-KL-pulled onto it. `spread_edge ≡ 0`.
- `autoPickDecisionBoard` computes `edge = projectedMargin − marketMargin ≡ 0.000` on every game, so
  `home = (edge > 0)` is always false and the away side is nominally selected with zero edge everywhere.
- `nfl-cover-calibration.js:276` fits the **live staking gate** on replays whose `edge_points` is
  identically zero, which explains its stored coefficients exactly: intercept −0.000641, edge_slope
  +0.0000194, selected_lambda 16384, `lambda_reason: "Heavy shrinkage selected — the model adds nothing to
  the market on training data."`
- Meanwhile `nfl-blind-audit.js:307` takes no `blendMode` and therefore grades **`raw`**
  (`nfl-ensemble.js:1221`) — a genuinely different function. **The settled −7.7% ROI and −2.28 CLV numbers
  describe `raw`. Production runs `market_residual`.**

Nothing here is broken; this is honest abstention working exactly as designed. What is missing is that
nobody has said it out loud. **The fix is an assertion, not a model:** a blend mode whose gate has never
passed must be reported as `is_market_identity: true`, and every audit, replay and leaderboard row must
declare its blend mode. *Cost: hours.* *Caveat: this does not reopen the settled negative — it makes the
negative precise. The correct reading of Step 8's "no forecast has yet consumed a frozen packet" is also
stronger than written: no forecast has yet moved off the market at all.*

### 2a-2e — The protocol itself

*Read 2f before running any of this.* Its preconditions corrupt the record 2a-2e is about to grade — it
is placed after the protocol only because the protocol had to be described before its flaws could be, not
because it runs second.

2a. **A purged walk-forward protocol, applied uniformly.** Fit on seasons 1..n, test on n+1, roll
    forward, with purging at the train/test boundary so multi-week features can't leak backwards. One
    protocol used by every candidate, rather than each engine grading itself its own way.
    *Do not build this from scratch:* `research2/github/eslazarev__purged-cross-validation` is **MIT** and
    ships `_walk_forward.py:18 WalkForwardSplit`, `_purge.py:19 purge()`, `_embargo.py` and `_cpcv.py`.
2b. **Backfill the trial registry — `audit_registry` itself, the same table as Step 0 item 5 and the gate
    Step 8 describes; see the note on that Step 8 bullet for the full reconciliation — with every
    historical attempt.** It is not empty: it already holds 15 rows (`server/services/audit-registry.js`,
    schema at `server/db/schema/core-and-fantasy.js:379`), preregistered 2026-08-29/30. But none of those
    15 are the trials this step needs — they cover simulator validation, CLV, line-shopping and the
    football-first model, not the 21 spread-ensemble variants Step 2 has to correct for. So the real gap is
    unchanged even though the table is not empty: it needs all 21 model variants, every family ablation
    config, every segment definition — including the ones silently dropped for falling below the
    minimum-bets threshold, which are exactly the attempts a naive count misses. *The concrete line:
    `nfl-replay.js:670` discards every below-`minBets` segment before the Holm family is assembled at
    `:691`, so the correction is applied to survivors only — precisely the bias the correction exists to
    remove. Also note three unlinked Holm families (`nfl-replay.js:691`, `line-move-study.js:406`,
    `nfl-passing-specialists.js:226`); backfilling `audit_registry` should join them, or it is three
    registers under one name.*
2c. **Compute the effective number of trials, not the raw count.** The 21 attempts were iterative, each
    informed by the last — they were not 21 independent draws. Feeding raw `21` into a Holm or Bonferroni
    correction is wrong in one direction; treating it as a single test is wrong in the other. The research
    named the specific fix: a Geyer-style autocorrelation-time correction computed from the actual trial
    sequence (`purgedcv/_metrics.py:557 effective_n_trials`). *Quote its own docstring into the deliverable:
    the Geyer-1992 truncation is "a heuristic … an order-of-magnitude correction, not an exact figure."*
2d. **Apply a deflated-Sharpe / probability-of-backtest-overfitting haircut.** Given the effective trial
    count and the best observed result, what is the probability that the best-looking model is simply the
    luckiest of the attempts? This is the question nobody has ever asked of these numbers. *The same MIT
    package supplies this too — `_metrics.py:197 deflated_sharpe_ratio`, `:313 …_full`,
    `_pbo.py:272 probability_of_backtest_overfitting` — which removes the plan's earlier assumption that
    this had to be reimplemented from a GPL-3.0 source, and removes the "five disagreeing implementations"
    risk as well, since it shares 2c's `n_eff` convention.* **Point it at the right search.** The 21 model
    variants are all negative, so haircutting them changes nothing. The haircut bites where a
    *positive-looking* result was selected out of a large search: the segment finding, and the
    beat-the-close feature grid (~320 feature × stamp × market cells). Start there.
2e. **Run the whole stable through it, on one common universe.** The incumbent ensemble, the raw blend,
    the market-residual blend, the new joint scoring model (once it lands), any combination method, and
    the execution/teaser strategies — one leaderboard, one protocol, one honest confidence statement per
    row. *Two cheap additions: `purgedcv/_metrics.py:385 min_track_record_length` converts this
    document's closing "you get a fraction of the sample needed" into the actual number of settled bets
    required, and `:486 minimum_backtest_length` answers 2d's question from the other direction before any
    refit runs. And since `nfelo.js` already ingests greerreNFL's published lines into `nfl_nfelo_games`
    (1,709 rows, 2020-2026, with `nfelo_home_line_open/close`), add nfelo's published prediction as an
    external floor row rather than standing up a new Elo.*

**The deliverable:** a single table answering, for every candidate: how it performed on data it was never
fitted to, corrected for how many attempts preceded it, **and which function it actually is** (see 2.0).
And the headline — does anything clear the bar.

**Why it ranks here:** it does not block the fantasy work below and can run in parallel. But it is the
input that decides whether further betting-model investment is justified at all, and it is the thing that
makes every future comparison trustworthy rather than suggestive. Days of work, no new data collection,
uses infrastructure built tonight.

**One honest caveat, stated up front:** the most likely outcome is that it confirms the negative result
with proper error bars rather than revealing a hidden edge. That is still worth doing — a trustworthy no
is far more valuable than an ambiguous maybe, and it is the only thing that makes a future yes believable.

### 2f — Preconditions nobody has checked, which corrupt the record Step 2 is about to grade

Every one of these is small, and every one of them changes numbers the leaderboard will print.

11. **`market_anchor` reads the OPENER live and the CLOSE in every backtest.** `games()` — the only history
    source for both fitting and grading — hardcodes `NULL AS open_spread, NULL AS open_total`
    (`nfl-ensemble.js:60`), while the per-game live query uses
    `CASE WHEN team_score IS NULL THEN open_spread END` (`:1247`) and `market_anchor` is
    `openSpread ?? spread` (`:599-606`). So a settled game grades the component as the **closing** line and
    an unplayed game serves the **opening** line. `market_anchor` earned margin weight .0938 and
    **total weight .2503** under the closing-line grading. The raw blend therefore carries a built-in
    `+0.0938 × (openMargin − closeMargin)` **fade-the-move** term, in a portfolio whose documented failure
    mode is 78% adverse moves; mean |close − open| is 1.17 (2025), 0.93 (2024), 1.19 (2023). No backtest can
    detect this, because every backtest replays settled games where the live branch is dead. The data is
    there (271 of 272 2026 games and 285/285 in 2023-25 carry `open_spread`). *Cost: the edit is one line;
    treat it as a comparison run, not a patch, because it will change every fitted weight.*
12. **Neutral-site games carry a +0.71-point spurious home lean across 43% of the margin weight.**
    `diffModel` returns `cal.b0 + cal.b1 * raw` when a calibration exists (`nfl-ensemble.js:664`; same at
    `:333` for `availability`) and **drops `c.hfa` and `c.neutral` entirely**. Every calibrated `b0` in the
    live artifact is a home-field constant (1.603, 1.641, 1.655, 1.710, 1.700, 1.656, 1.713, 1.465); weighted
    over the 8 active calibrated components (Σ .4312) that is +0.71 points at every neutral-site game, while
    every uncalibrated component correctly reads `hfaFor() → 0` (`:806-807`). The unified engine even
    remembers to pass `homeFieldPoints: 0` to the simulator (`nfl-unified-engine.js:45-47`) — the ensemble it
    reconciles to does not. This hits the **`raw`** blend, i.e. the blind audit, the replay, the council and
    the neural capture — exactly the historical record 2e will grade. 2026 has 9 neutral-site games; ~60 sit
    inside the 2015-2025 fit window. *Cost: hours.*
13. **2022-2025 `open_spread` is corrupted and tonight's fix structurally cannot repair it.** The new
    `odds-archive.js` writes home and away rows separately with the away side negated — correct going
    forward — but it writes `COALESCE(open_spread, ?) … WHERE (open_spread IS NULL OR open_total IS NULL)`,
    which pins the already-wrong non-null values forever, and no repair script exists. Live antisymmetry
    check (home.open_spread should equal −away.open_spread): 2019-2021 are 256/256, 251/251, 272/272 clean;
    **2022 is 5 of 267, 2023 is 4 of 285, 2024 is 1 of 285, 2025 is 4 of 285** — and in every one of those
    seasons the *identical* value is written on both rows. 2026 is clean (271/271). That is 1,122 corrupted
    game-pairs across four seasons, read by sixteen modules including `nfl-ensemble.js`'s market-anchor
    family, `nfl-replay.js`, `nfl-expert-council.js`, `nfl-drive-sim.js` and `nfl-profitability.js`.
    *Cost: hours for a repair script, and it is a precondition for 2e, not a follow-up.* *Caveat, so this is
    not overclaimed: `line-move-study.js` reads openers from `nfl_odds_archive`, not this column, so the
    nfelo-vs-Pinnacle-opener signal is **not** affected. The exposure is the ensemble/replay/council path.*
14. **`game_lines.spread` is still being overwritten with live in-game numbers, and tonight's build
    deliberately declined to fix it.** `gamescript.js:120-133` on the model branch is a new comment block
    saying the preKickoff guard was *"Deliberately NOT applied … Left for a human to resolve."* The
    corruption is measured: integer-spread share in `game_lines` falls 47.7% (2024) → 24.9% (2025) → 16.9%
    (2026). `teaser-leg-rates.js:30-57` excludes 2025 and 2026 from measurement because of it;
    `nfl-execution-edge.js:93,218,276` does not (Step 5). `syncCurrentLines` runs on a scheduler job plus two
    mounted routes, so this is writing right now. *The unresolved question is not "add a guard" — it is
    "which readers are allowed to see the live column", and that decision has no owner. It is now in the
    open-decisions list.*
15. **Week-keyed tables are mutated in place, so a `week <` filter proves the chronology of the index, not
    of the value.** Since 2026-09-02 there have been ~79k injury, 342k depth, 253k snaps and 122k usage
    UPDATEs against week-keyed rows. Tonight's bitemporal wiring fixes this forward for injuries only.
    2a's purged walk-forward inherits the rest, and the specific unadjudicated question — whether a 2021
    replay week consumes a fit computed through 2025 — was never settled by any reader. *Cost: days if it
    turns out to need bitemporal treatment for the other three tables; hours to answer the question.*
16. **Two small fixes to the statistics the leaderboard will lean on.** (i) The `t = 4.47` that everyone
    quotes is an ad hoc paired t-test on squared-error differences (`nfl-ensemble.js:1126-1130`), which
    assumes iid, non-autocorrelated, symmetric loss differentials — NFL weekly loss differentials are none
    of those, and `grep -rni "diebold|harvey.leybourne|hln" server/` returns zero hits. The literature
    standard is Diebold-Mariano with the Harvey-Leybourne-Newbold small-sample correction; it is ~40 lines
    with a published closed form, so transcribe it rather than depend on it. (ii) `pairedBootstrapDiff`
    accepts a `groups` array **longer** than n through its `>=` guard and then misaligns by index
    (`offseason-model.js:1497`, `:1149`); 2e makes that function load-bearing across the whole stable, so
    it should refuse mis-*aligned* groups, not merely short ones, and tonight's `stats-util.js` clustering
    should return a `clustered` flag. *Cost: hours each.* *Caveat on (i): this does not reopen the settled
    result. The ensemble lost, and HLN typically **shrinks** |t|, so the expected effect is "the market is
    better, with a correctly-sized interval" — which is exactly what 2e promises and what this line
    currently cannot deliver.*
17. **Declare the CLV reference book set, and exclude the execution book from it.** Migration 037
    (`nfl_clv_grades`) plus the new `clv-core.js` supply the mechanism tonight; what is missing is the
    declaration. This was previously refuted on the grounds that no graded number was being cited in a
    reproducible claim — 2e and Step 0 item 5 are exactly that, so its own stated reopening condition is
    now met. *Cost: hours.*

**And one scoping decision Step 2 must make before it runs (18).** 2e promises to grade "the
execution/teaser strategies" on the same protocol. **The teaser strategies can do this**
(`margin-distribution.js` already walk-forwards 2007-2024 on `game_lines`). **The execution strategies
cannot.** Shopping value, middles, arbitrage and sharp-vs-rec divergence all require two or more books
priced at the same instant, and the pre-September archive does not contain that: of 68,108
(captured_at, event_id, market) groups in `archive:oddstrader`, **67,528 contain exactly one book**, and
the mean span of capture times *within a single event* is **12.8 days**. Running a dispersion backtest
across that would measure staleness and report it as edge — the precise failure
`nfl-shopping-board.js`'s own header warns about. So decide explicitly: either (a) a stated tolerance-window
join with the latency confound measured and reported, or (b) execution strategies are scoped to the forward
record only, with a stated accumulation horizon. Silently including them produces the one thing Step 2
exists to prevent.

## Step 3 — Fantasy, the priority you already set (biggest available wins)

Ordered by dependency, not preference — the first item unblocks four others.

19. **One-time historical player-season import from nflverse.** Nothing else in fantasy modeling can
    proceed without it; your current player table only holds internally-rostered players, so there is no
    full-population history to fit anything against. Days of work, unblocks items 20-22.
20. **A real aging curve, fit from your own data.** Replaces a hand-typed literature table in which
    quarterbacks are assigned a flat "no change" purely because nobody had a published number to copy.
    Must carry the survivorship-bias correction the research flagged — two independent sources showed that
    correction can flip the sign of the result, so it is a precondition, not a nicety.
21. **The cliff/hazard pattern alongside the smooth curve.** The empirical reality is that players hold up
    fine and then fall off suddenly; a smooth gradual decline is the wrong shape. Gate it against a
    base-rate comparison before it touches trade values.
22. **The injury usage-propagation tool.** Today the system computes that a player will miss snaps and then
    stops — it never redistributes those snaps to specific teammates. Every input table already exists.
    The research checked and found no credible open-source implementation anywhere, in-house or public,
    which makes this the only genuinely novel thing on the entire list. Days-to-weeks, highest upside on
    this page for actual weekly decisions.
23. **Stand up the statistics toolchain, then the hierarchical player-prop model.** Props are the one area
    where your model has *proven* skill (2+ TD Brier skill +27%), and it is currently running on fixed
    guessed constants for uncertainty rather than a model that widens honestly for thin-data players.
    Check first whether the current fixed-dispersion approach already handles the low-history split
    acceptably — if it does, skip the new dependency entirely. *There is also a smaller version of the
    dependency than the one this decision assumes: `martineastwood/penaltyblog` (MIT, active) ships a
    hierarchical-prior ensemble MCMC as a plain `pip install` with no CmdStan and no R sidecar, which
    answers "does a hierarchical prior widen intervals honestly for thin-data players" without committing
    to `footBayes`.* *(Step 4c applies this identical decision to the props betting workstream and adds a
    citation this item doesn't carry: `nfl-prop-player-heads.js`'s documented 0/3 negative result on this
    exact idea. This is the canonical discussion; 4c points back here rather than repeating it.)*

## Step 4 — Player props, and routing prop skill into the spread (added 2026-09-12, Nick's idea)

**Why this is the most promising betting idea on the page.** Props are the one place this model has
*proven* skill — roughly +27% Brier improvement on 2+ touchdowns, +20% on anytime. Spreads are where it
has proven none. That asymmetry is not luck: props are priced by simpler models, carry lower limits, and
attract less sharp attention, which is exactly where skill survives.

**The premise correction you need before starting.** An earlier draft of this section said the 101,820
captured prop rows meant the data for 4a already existed and that skill would be measured against real
prices "from here forward". Both halves are wrong as written, and the reason is the book mix, not the
modelling:

- `underdog` supplies **100,944 of 101,820 rows (99.1%)**, captured 2026-09-02 → 09-07: receiving yards
  38,456 · receptions 38,174 · rush yards 16,892 · pass yards 7,422. Underdog is a DFS pick'em product —
  it posts **no game totals and no touchdown markets**.
- Every other book (draftkings 477, fanduel 164, betrivers 161, betonlineag 74) comes from **one
  five-minute paid Odds-API capture on 2026-08-27**. **All 512 `player_anytime_td` rows are from that
  single capture.** The market where the model has its only proven skill has had no price captured in
  16 days.
- Same-book prop-and-total coverage today is 876 rows, 16 days stale. You cannot reconstruct implied team
  points from yardage and reception lines alone — that needs a scoring market, and the tape has essentially
  none.
- And there is no live producer at all right now (Step 0 item 3).

None of this is an argument against 4a. It is the missing first step, and it reframes the whole section:
**the props workstream is currently blocked on price acquisition, not on modelling.**

**4a. Market-prop vs. market-total consistency check — still the single best idea in this document.**
Compare the books' own player props for a team against the books' own posted game total. If the props imply
27 points and the total implies 23, the market is internally inconsistent **across its own products** — the
cheap-to-price product disagreeing with the expensive-to-price one. This requires no predictive superiority
over the market at all, only that the market's props and totals be priced by different models with
different rigor, which is a documented reality. It fits every real edge this project has ever found:
structural and execution-based, never predictive. *Exit test:* measure, over held-out weeks, whether the
size of the prop/total disagreement predicts which side of the total actually lands. **Prerequisite, newly
identified:** acquire prop prices from books that post both props *and* totals, including TD markets.
*Cost: days, and most of it is acquisition, not analysis.*

**4b. Bottom-up team total from your own player projections, as a spread/total component.** The diagnosed
disease is thirty-one components that collapse to about three independent signals, because all of them are
top-down restatements of team efficiency. A team total assembled from player usage → player yards → points
travels an entirely different data path, which makes it *structurally* independent — the exact property the
research said was missing. Nothing in the codebase does this today (verified: no team-total aggregation
from player projections exists on any spread-model path). This is a more concrete, data-grounded version of
the "independent totals engine" already on the research list and should probably replace it.
*Two honest cautions, to be tested rather than assumed:* (i) the proven prop skill may be mostly **usage**
prediction — who gets the ball — while team totals depend far more on efficiency and pace, so the skill may
not transfer; (ii) summing correlated player projections without modeling that correlation produces a team
total with badly wrong variance. **Caution (ii) already has an answer in the repo and should not be rebuilt:**
`nfl-prop-correlation.js` (`SGP_MODEL_VERSION = 'prop-sgp-copula-v1'`, `:31`) fits within-game residual
correlations for both `sameTeam` and `opposed` pairs (`:120-122`) across the five stats that actually trade,
with a `MIN_PAIRS = 150` floor (`:45`), persisted to `prop_correlation_estimates` — **182 fitted archetypes
live in the database** — and `sgpAnalysis` (`:263`) already samples them through a Gaussian copula. Point 4b
at that table. *(If tail dependence later matters, escalate to `vinecopulib/pyvinecopulib`, MIT — and not to
`sdv-dev/Copulas`, whose Business Source License 1.1 is not an open-source license and restricts production
use, which the GitHub catalog lists as `call` without flagging.)*

**4c. Finish the props model itself.** The hierarchical count model — same dependency decision as Step 3
item 23, which is the canonical discussion; see it for the fixed-dispersion test and the smaller
`martineastwood/penaltyblog` alternative — is gated behind the statistics toolchain. **Read the existing
negative result first, since item 23 doesn't carry this citation:** `nfl-prop-player-heads.js` and its
three siblings carry a documented 0/3 negative result on this exact idea, and the cleanup plan proposes
archiving them this week (Step 8). **Same premise correction as 4a:** Step 0 item 3 lists this among the
sub-items that assume a live producer — the toolchain and the model itself can be built and back-tested on
existing data now, but validating that it widens intervals correctly for real thin-data players is blocked
until the feed is restored.

**4d. Now that matching works, actually measure prop CLV.** The tape has 101,820 rows and has never been
scored against real prices because of the name bug. First real measurement of whether the prop skill
survives contact with actual market prices — a different and harder question than beating a baseline.
**One click unblocks most of it (24):** `reconcilePropQuoteMatches({ force = false })`
(`nfl-prop-clv.js:598`) only selects rows `WHERE model_match_status IS NULL OR
model_match_status='legacy_unclassified'`, and `scheduler.js:638,654` still call it with no arguments — so
every row corrupted by the old name-key bug sits in a terminal status the scheduled job never revisits, even
now that id-based matching is fixed. Live counts are frozen at `role_ineligible 92,192 ·
projection_missing 9,134 · modeled 406 · identity_unresolved 40 · unsupported_participant 48`. The manual
path already exists and is wired to a button: `POST /props/quotes/reconcile` →
`reconcilePropQuoteMatches({force:true})` (`ProfitabilityControl.tsx:89`). *Cost: one click, plus a decision
about whether the scheduled job should pass `force` periodically.* **Same premise correction as 4a and
4c:** reconciling the existing 101,820-row backlog works today, independent of Step 0 item 3 — it is pure
matching against quotes already captured. Measuring prop CLV *going forward*, week over week, is a
different claim and is still blocked on Step 0 item 3 until the feed is restored.

**4e. Fix the two places the props evaluation flatters the model, before 4c or 4d cites a number (25).**
Both are untouched by tonight's branches. (i) `nfl-props-replay.js:44` — `toHalfPoint` only adds +0.5 when
naive rounding lands on an integer, so `toHalfPoint(50.0)=50.5`, `(49.9)=50.5`, `(49.0)=49.5`,
`(49.7)=49.5`: the synthetic line the harness uses to judge whether the model "has business being bet into a
real market" is systematically high, which flatters Unders and punishes Overs uniformly. (ii)
`nfl-prop-calibration.js:342` — `const chosen = scoredOnTrain[0]` selects the shipped TD-calibration head by
**training** Brier, under a comment at `:337-338` claiming "same selection discipline as the sealed audit",
while the sealed audit (`:231-257`) fits on train, selects on a separate discovery set, applies a paired test
and Holm. `nfl-prop-player-heads.js:18-20` documents that "lowest training Brier wins" "would always crown
platt_all". *Cost: hours.* *Caveat: this does not touch the settled +27% Brier result, which came from the
held-out sealed-audit path. It says the **production** selection rule and the **replay harness** are not the
thing that earned it.*

**4f. The SGP self-consistency loop is built, gated, and completely empty (26).** Same mechanism as 4a — the
market disagreeing with itself across its own products — applied to a second product, and unlike 4a it
already has its governance gate written. `sgpAnalysis()` (`nfl-prop-correlation.js:263`) computes a
`correlation_multiplier` comparing a book's posted parlay price against that book's own component prices, and
its own note says *"A multiplier far from 1 is where a blanket book haircut is most likely to be wrong — it
is a measured disagreement, not yet a proven edge."* `recordSgpQuote()` and `sgpQuoteEvidence()` implement
the loop with a stated bar (50 candidate/close pairs, positive CLV, 0u staking until then). **`nfl_sgp_quotes`
has 0 rows** — capture is a manual POST and nothing auto-captures, so the loop has never run. *Cost: days,
almost all of it operational.* *Caveat: books apply blanket SGP haircuts and hold small limits on correlated
parlays. "The book's haircut is wrong" and "you can get paid for it" are different claims, and 50 manually
entered pairs is real cost for an unproven one.*

## Step 5 — Execution and market structure (new section; this is the category the plan had no home for)

This is where every edge this project has actually measured lives — line-shopping and the Wong teaser —
and until now the document had no section for it. Nothing here asks the model to predict better than
anyone. Everything here is about the price you can reach, the fence around the number, or a market
disagreeing with itself in time.

27. **The only +CLV signal this project has selects its hyperparameters inside its own holdout.**
    `report-cache.js:59-62` calls `line_move_study` with `args: [{}]`; `line-move-study.js:119,132` then has
    `selectionThrough = null ⇒ fitModel()`; and `nfl-market.js:156` computes
    `selectionCap = selectionThrough == null ? lastSeason - 1 : …`. With completed 2026 rows in `game_lines`,
    `lastSeason = 2026`, so the selection window runs **through 2025 — inside `line-move-study.js`'s own
    `HOLDOUT_FROM = 2024`.** This is the nfelo-vs-Pinnacle-opener family, promoted to a live rule in
    `beat-the-close`'s RULES table. Re-measuring it with the selection window fenced is a one-line call-site
    change plus a re-run, and the project already knows roughly what fencing costs elsewhere: +0.47 → +0.28.
    *Two companions in the same file: T2 uses realised kickoff-hour weather (`:197`) rather than the forecast
    available at decision time, and nfelo's per-date availability is unverified while TeamRankings' is
    date-verified.* *Cost: hours plus a re-run.* *Caveat: expect the number to shrink. That is the point —
    a smaller honest number is worth more than a larger selected one, and this is the signal the whole
    Step 0 item 2 forward record is built on.*
28. **`beat-the-close` was left with the reachable-quote join the shopping board just abandoned.** Tonight
    fixed `nfl-shopping-board.simultaneousQuotes` to group by `(event_id, book)` with a 5-minute window,
    with an explicit comment that the old exact-equality join on one `MAX(captured_at)` *"silently dropped
    every book except whichever provider happened to be polled last."* `beat-the-close.js:106` still does
    exactly that (`SELECT MAX(captured_at) … WHERE provider LIKE 'free:%'`). Live proof from the last 24
    hours: only `free:oddstrader` and `free:pinnacle` carry the newest instant (01:47:36Z); `free:kambi`,
    `free:fanduel`, `free:sbr` and `free:rotowire` sit at 01:10:4xZ and `free:bovada` at 00:09:53Z — **five
    of seven free books are structurally excluded from every `bestReachable` call.** After the merge the two
    surfaces answering "what price could I actually have got" use two contradictory definitions, and the
    execution edge is the one edge this project has. *Cost: hours; the corrected join already exists to copy.*
29. **Execution pricing is computed from the seasons the repo itself calls corrupted, and the board leads
    with the underdog-bias number.** (i) `nfl-execution-edge.js:93,218,276` run three margin-distribution
    queries `FROM game_lines` with no season bound, while
    `server/betting/nfl/strategy/margin-distribution.js` exports `MEASUREMENT_SEASONS` / `EXCLUDED_SEASONS` /
    `EXCLUSION_REASON` and honours them — so every half-point valuation on the shopping board is priced from
    a distribution that includes the rows item 14 is still corrupting. (ii) `nfl-shopping-board.js:237-240`
    sorts every side across every game by `expected_net_return` and `:444` reports
    `best_expected_return: spreads[0]…`, which is the no-forecast empirical cover rate that commit `14c5e65`
    itself measured as underdog bias (+6.5 → 53.53%, +10 → 55.28%, against 52.38% break-even). It is
    labelled `qualified:false` so it cannot reach a stake — it is still the first number a human reads on the
    board. *Cost: hours.*
30. **The conditional margin model is orphaned, and the middle finder is spreads-only.** `findMiddles()`
    (`nfl-shopping-board.js:267-268`) calls `simultaneousQuotes('spreads')` — totals (689,394 captured rows)
    and h2h (662,444) are never scanned for middles or arbs, despite `shoppingBoard()` already accepting a
    `market` parameter and `bookHold()` already working per-market. Worse, `signedMarginDistribution()`
    (`:46`) pools **every** home margin in `game_lines` unconditionally, when a middle window is an interval
    on a specific game's scale and the correct object is P(margin | spread).
    `server/betting/nfl/strategy/margin-distribution.js` is exactly that — fitted, walk-forward-validated,
    key-number-calibrated, exporting `marginPmf(spread)` and `coverProbability({spread, handicap})` — and
    **`grep -rln margin-distribution` returns only itself.** Zero importers anywhere in the repo, and the
    test file its own header cites does not exist. Its own `MARGIN_MODEL_VERDICT` is honest about losing to
    the empirical lookup on the eight cross-both teaser lines (3.36pp, z = 3.42) and winning on sparse
    lines — *"on sparse lines the model is the best estimator available because the lookup has nothing to
    look up"* — and middles are sparse lines by construction. Peer-reviewed grounding for the mechanic:
    Simon 2024 (*Management Science* 70(12)) finds line changes significantly negatively autocorrelated
    across 3,681 games, and totals are where books move most. *Also recorded there and mentioned nowhere
    else: a measured pricing error — favourites at −7 to −8.5 beat their number by 1.04 points (z = +2.36)
    and underdogs at +1.5 to +3 by 0.85 (z = +2.84), against an otherwise linear efficiency slope.*
    *Cost: days.* *Caveat: middles need two books straddling at the same instant, and the live free tape is
    eleven days old, so the historical yield is genuinely unknown — see item 18.*
31. **Cross-book catch-up lag is about 100 minutes, and the shopping board deliberately throws that signal
    away.** Measured on `nfl_line_snapshots` spreads 2026-09-04..09-12 (510,070 rows, 570 event/book/side
    series, 796 line transitions): grouping same-direction transitions across books within 6 hours gives 38
    move waves with ≥4 books; in the median wave the median book follows the first mover by **102.0 minutes**
    and the slowest by 220.4. Capture resolution supports the measurement (~200 distinct capture minutes a
    day, roughly every 5-7 minutes). The observable requires no news at all — the trigger is "book A moved,
    book B hasn't." The repo currently filters this out on purpose: `nfl-shopping-board.js:21-24` makes
    *"only ever compare quotes captured at the same instant"* the module's cardinal rule, and
    `book-feeds.js:72` sets `STALE_BOOK_HOURS = 72`, roughly 40× too coarse to see a 100-minute effect.
    **The framing worth keeping: that cardinal rule is correct for measuring dispersion and wrong for
    finding an opportunity.** A stale book is a measurement artifact when you are averaging prices and a
    live opportunity when you can actually bet it. *Cost: days.* **This is NOT yet an edge and must not be
    presented as one.** The one directional test run so far was negative: of the 38 waves only 10 had a
    usable closing consensus, and taking the lagging book's stale line scored **0 of 10 positive, mean
    −0.30 points of CLV** — far too small to conclude either way, and the sign convention may be inverted,
    but it is not support. Three further cautions: closing coverage is thin (only 4 of the 9 past-kickoff
    events had any capture inside 60 minutes of kickoff — same count as Step 0 item 2 — so CLV measurement
    on the live tape is ~44% covered, which bears on the whole CLV program); the per-book lag ranking is
    untrustworthy because this
    study detects line-level transitions while Pinnacle expresses moves in juice (which is why it absurdly
    ranks Pinnacle slowest at 201 min); and the consistent laggards are offshore/low-limit books (bodog,
    betonlineag, bovada, everygame, lowvig, heritage), so limits and account longevity bound anything built
    on it. 38 waves is one week; a season accumulates enough.
32. **`signal-latency.js` is measuring Polymarket while its own header says it is measuring ESPN.** Line
    57-64 defines `MOVE_UNION` as `espn_line_moves UNION ALL polymarket_line_moves` and asks only "did OUR
    signals lead this pooled log?". Row counts: `espn_line_moves` **81**, `polymarket_line_moves` **4,961**.
    The union it studies is **98% Polymarket**, while the module says it is "deliberately built on the FREE
    ESPN reference line" — a 61:1 mislabel. Any latency conclusion drawn from it today is a conclusion about
    Polymarket wearing an ESPN label. The fix is to split the two series and ask the question symmetrically:
    does the exchange lead or lag the book? The `nextMoveAfter`/`priorMoveBefore` pattern is already proven
    in that same file, and no new data collection is needed. *Cost: hours.* *Caveat: with only 81 ESPN moves
    the lead/lag test is badly underpowered today. **The deliverable is the separation and an honest power
    statement, not a verdict** — do not let the lead/lag study itself be scheduled on this sample.*
33. **A finished negative-EV staking gate exists with no caller, and it answers one of your own open
    decisions automatically.** The first open decision below is whether DraftKings' +100 teaser price is a
    promotion or standing. What the decision list does not say is that the guardrail for the "promotion"
    answer is already written and unwired. The live price floor is −115 in three independent places
    (`teaser-scan.js:195,209,578`; `nfl-teaser-execution.js:24,126`; `teaser-season.js`
    DEFAULT_WONG_SETTINGS), while the family's own break-evens are **−120.2** (`stake_back`, the default
    grading) and **−116.8** (`graded_loss`). At −115, `teaser-staking.js`'s posterior puts **37.2%** mass on
    no edge at all, against its own `maxNegativeEvProbability` default of 0.20. `recommendStake` — the
    function carrying that gate — is imported **only** by `test/teaser-staking.test.js` after both builds,
    and the test itself asserts `recommendStake({ americanPrice: -115 })` is refused (test:225) while the
    live scanner admits it. Also stale: `teaser-staking.js:257 MEASURED.forwardRateSd = 0.023` against
    `teaser-season.js:612 FORWARD_RATE_SD = 0.0282`, so every quoted P(no edge) — including that 37.2% — is
    computed with too narrow an SD and is **understated**. *Cost: hours. Wiring it converts a standing
    question into a code guard that re-answers itself whenever the price moves.*
34. **Nothing anywhere knows where the bankroll sits relative to its own high-water mark.**
    `grep -rni "high.water|highWater|peak_bankroll|realized_bankroll" server/` returns **zero hits**. All
    three staking paths are static fractional Kelly — `staking.js:116` and `:294` at `multiplier = 0.25`,
    and the real gate at `nfl-execution-edge.js:623` at `fraction = 0.25, bankrollUnits = 100` where
    `bankrollUnits` is a caller-supplied default rather than a tracked balance. Meanwhile
    `staking.js:231-257` estimates `drawdown_probability` by an 8,000-trial Monte Carlo which its own header
    (`:53`) describes as "a genuine Busseti/Ryu/Boyd-style drawdown-probability constraint … estimated, by
    Monte Carlo rather than solved in closed form", with no analytic cross-check. Two cheap additions: the
    **Grossman & Zhou (1993) linear drawdown cushion** `f = κ·(d/b)`, and the closed-form **Chernoff bound
    `Prob(W_min < α) ≤ α^λ`** from the Busseti/Ryu/Boyd paper `staking.js` already cites by name, as a
    sanity ceiling — if the Monte-Carlo estimate ever exceeds the analytic bound by more than simulation
    noise, the correlation matrix or the copula draw is wrong, not the math. *Why this matters more than it
    looks: the `source='model'` branch at `nfl-execution-edge.js:625-634` already zeroes any model-derived
    stake until proven CLV, so the only paths that will ever stake real money are the two documented
    positive-expectation ones — line-shopping/execution and the Wong teaser. A static quarter-Kelly with no
    drawdown state is precisely the wrong guardrail for the paths that will actually run.* *Cost: days.*
    *Licence note: take only the peer-reviewed 1993 rule from
    `sergeisukhovmkt/…Drawdown-Constrained-Kelly-Betting` (MIT) — that repo's own "Bayes GZ" contribution is
    self-published, unreviewed, and had an earlier version of its main formula retracted. And reimplement the
    Chernoff formula rather than importing `cvxgrp/kelly_code`, which is GPL-3.0.*
35. **The only +EV product's UI is broken in two ways.** Both surfaced as asides inside claims that were
    themselves refuted, which is exactly the shape of a finding a merge loses, and both files are untouched
    by either branch. (i) `client/src/components/betting/wong/WongSettings.tsx:9-13` offers
    `reduce_to_single` / `push_refunds_stake` / `loses`, while the server enum is
    `teaser-season.js:115 REDUCED_PAYOUT_MODELS = ['stake_back','same_price','graded_loss']` and
    `validateSettings` rejects anything else — **every option in that dropdown fails server validation**,
    and the push-grading model is the single assumption that moves the teaser break-even (−120.2 vs −116.8).
    (ii) `WongSeason.tsx:22-41` reads `season.record`, `season.units_staked`, `season.units_won` and
    `season.roi`, none of which exist at the top level of `wongSeason()`'s return — they live under
    `placed`/`paper` — so the season P&L tiles for the only strategy this project believes is +EV render
    blank. *Cost: hours.*

## Step 6 — News and information timing (new section; news timing was not previously treated as its own subject)

**Read the verdict first, because it decides how much the rest is worth.** Measured end to end: a story
reaches `nfl_news_signals` a median of **19.8 hours after publication** (Schefter's own tweets: 8.7h
median; only 14.1% of all signals inside an hour; 9.8% inside fifteen minutes). A paid odds capture
triggered by that news fires a median of **24 hours after publication** (p90 91h, max 297h). The market's
own catch-up window — first book to last — is about **100 minutes** (item 31). The pipeline is an order of
magnitude too slow and no amount of tuning closes a 20-hour gap against a 2-hour window. **There is no
news-speed edge available from this architecture.** That is now in the NOT-DO list.

What remains is worth doing for a different reason: every news number this project currently produces is
uninterpretable, several of them spend money, and one of them marks a starting quarterback as released.

36. **Both known P1 news defects are unfixed in the working tree and were absent from this plan entirely.**
    D1 — every player named in a story inherits the story's first matching status — is present verbatim at
    `nfl-news-signal.js:144-163`: `text` is the whole headline+body (`:136`), `text.match(rule.re)` is
    evaluated once per story inside the per-player loop, and the transaction rule
    `/\b(?:waived|released|cut|terminated)\b/i` is still first at `:69`. D2 — "WAS" and "NO" matching the
    English words — is present at `normalize.js:20` (`entity.abbr` still in the alias list) and
    `ingest.js:48-49`. Live consequences in `nfl_news_signals` tonight:
    `Lamar Jackson | BAL | released | unavailable_probability 1.0 | verification_state verified` and the
    same for Derrick Henry; **114 rows carry `status='released', unavailable_probability=1.0,
    verification_state='verified'`**, most recent published 2026-09-12T20:02Z. Those rows are wired live:
    `enqueueRecentNewsTriggers` turns any verified signal at `unavailable_probability >= 0.5` into a **paid
    Odds API capture trigger**; `playerNewsSignal` overwrites the carry-forward probability in
    `nfl-postgame-truth.js:514-520` → `gameInjuryCarryover` → council and unified-engine head; and
    `newsOpportunities` emits concrete fantasy actions on `GET /trades/:leagueId/news-edge`.
    **Three additions the audit did not name:** (a) `:139` computes `bodyPart` once per story and stamps it
    on every player in it — same root cause, different column; (b) `teamForEntity()` (`:96-102`) resolves a
    player's team from `players.team_id`, i.e. his **current** team rather than his team at publication,
    which is a lookahead for any backtest over stored news; (c) the fiction is dispatched first — see item
    38. *Cost: days.* *Caveat: the sentence-scoping fix for D1 is genuinely fiddly — it needs a regression
    corpus, not just a regex change, which is probably why it has survived this long.* *Dated and separate:
    `newsSourceVerification` accepts a social handle whose validation verdict is under 30 days old; the 108
    handles were validated 2026-08-29, **which expires 2026-09-28**, and nothing re-runs it automatically.
    On that date every social-sourced claim silently falls to quarantined.*
37. **The "did the market react" flag has no market-wide control, and the missing null is now measured.**
    `nfl-news-market-latency.js:49` sets `reacted` from an absolute threshold on a single
    (event, book, market, side) pair — `|line_move| >= 0.5 OR |price_move| >= 5` — with no reference to what
    the rest of the board did in the same window, and `nflNewsMarketLatency()` then reports
    `claims_with_observed_reaction` and `median_news_to_reaction_minutes` as raw counts while
    `research_eligible` (`:80`) gates on sample size only. The file's own `next_gate` (`:82`) says "run
    direction and placebo audit" — the author knew; it was never built. **The null, measured on the live
    tape:** applying the exact `:49` rule at 90 random pivot times (2026-09-05..09-12, 1.45M rows, 2,712
    series) fires on a median **1.4%** of the board, 5.6% at p95, 7.0% at p99. Per capture-minute
    (2026-09-09..09-11, 568K rows, 354 qualifying minutes) the median is **0.35%**, p99 is 8.39%, and the
    worst single minute — 2026-09-09T21:40 — saw **17.0%** of every (event, book, market, side) pair move at
    once. A claim whose first post-claim quote lands in a leaguewide repricing minute therefore reads as a
    **~48× stronger reaction than baseline with zero causal content**. Additionally **807 of 1,439 placebo
    hits (56%) were price-only** — a ≥5-cent juice wiggle, a routine vig adjustment being counted as
    information. The fix is small and exact: run the identical rule over every event *not* involving the
    claim's team in the same window and report the excess with a bootstrap interval; split the line-move and
    price-move thresholds instead of OR-ing them. Everything needed is already in the query at `:60`.
    *Cost: hours.* *Caveat: fixing this creates no edge — it makes a currently meaningless number
    interpretable, and the most likely outcome once corrected is that the claim-conditioned rate sits close
    to the control rate. That is still the answer worth having.*
38. **News-triggered paid captures fire a median 24 hours late, and the fictional claims are dispatched
    first.** `nfl-capture-dispatch.js:37` selects signals on `created_at >= datetime('now','-120 minutes')`
    — the **row-insertion** clock, not the publication clock — so a five-day-old tweet ingested today is
    treated as breaking news. Joining `nfl_capture_triggers` (source `news_signal`, n = 157) back to
    `published_at`: median **23.98 hours**, p75 48.85h, p90 91.23h, max 297.48h (12.4 days). Separately,
    `:52` sets `priority = signal.confidence` and `:60` orders by `priority DESC`, while the defective
    `released` rule (`nfl-news-signal.js:69`) carries the table's top confidence of 0.95 — **19 of the 157
    triggers sit at exactly 0.95**, the fingerprint of item 36's fiction. The module's own header says it
    exists to "spend metered odds credits only after free evidence says the market moved". Two independent
    one-line fixes: filter on `published_at` (or the MIN of the two clocks), and stop using extractor
    confidence as spend priority until D1 is fixed. *Cost: hours.* *Caveat: the honest consequence may be
    that news-triggered capture should be switched **off** rather than repaired — by the time this pipeline
    has a signal at all there is usually nothing left to capture.* *Observed in passing and worth a look:
    `nfl_capture_triggers` holds 601 pending plus 185 deferred `espn_move` rows against exactly **1**
    captured, so the free-movement detector is producing triggers that are essentially never dispatched.*
39. **`nfl_injuries.modified_at` is NULL for all of 2025 and 2026, and the monitor built to catch exactly
    this reports healthy.** Coverage by season: 2021 5,348/5,348 · 2022 5,449/5,449 · 2023 5,451/5,599 ·
    2024 5,952/6,213 · **2025 0/5,783** · **2026 0/182**. `nfl-advanced.js:325` reads `r.date_modified` from
    the nflverse injuries CSV; the rows ingest fine and the timestamp silently does not, so
    `nfl-event-archive.js:85` (`AND modified_at IS NOT NULL`) drops them with no error and the event archive
    has zero `official_injury_report` rows for 2025-26. And the purpose-built blackout detector is blind to
    it: `nfl-offseason-cycle.js:144-165` — written for this exact class of gap, its own comment noting the
    last one *"was only found tonight by accident"* — does `present[0]` on a DISTINCT `strftime` list;
    SQLite sorts NULL first, so `trackedFrom` is `null`, every `ym >= null` is false in JS, and
    `gaps.nfl_injuries` comes back `[]` with `healthy: true` through a 20-month data break. *Cost: hours;
    the monitor fix is two characters (`WHERE ${column} IS NOT NULL`).* *Why the urgency: **2026 is the only
    season with both a live intraday tape and a growing official injury feed**, so every week this stays
    broken is a week of paired data that cannot be recovered later. 2025 is worth backfilling for
    completeness only — its price side is openers and closes, so it yields no latency measurement either
    way.* *Caveat: nobody has verified what the 2025/2026 nflverse CSV actually names the column, so the
    ingest fix needs one look at the live header; if upstream genuinely dropped the field, the timestamped
    -fact side needs a different source.*
40. **The latency instrument's two halves do not overlap in time, so it can never return a number.**
    `verifiedEventMarketLatency()` (`nfl-news-market-latency.js:96`) is the *right* instrument — thousands
    of official injury facts with hard timestamps — and requires `time_precision='timestamp'`. Those events
    exist (8,258 line-moving ones) but **all end 2025-01-04**. The intraday price path exists only in
    2026-09 (1,902,536 of 2,041,217 snapshot rows; every earlier month holds 7-8K rows, i.e. openers and
    closes, as `:123` itself admits). `beat-the-close.js:364` calls it with `since:'2026-08-01T00:00:00Z'`:
    that predicate returns **0 rows**, so the `event_to_move_window` panel on the one live
    betting-execution surface is permanently empty and reports no error — it looks like "no news this week"
    rather than "this instrument cannot work". The other half, `nflNewsMarketLatency()`, *does* overlap the
    tape (368 verified claims, 2026-08-19..09-13) but is fed by the D1/D2-defective extractor. **One
    instrument, two halves: the half with good inputs has no price path; the half with a price path has bad
    inputs.** *Cost: this is a diagnosis, not work — it is fixed by item 39, and is listed so nobody
    "fixes" the empty panel by changing the panel.*
41. **The tweet-to-line instrument takes its "pre-tweet" baseline after the tweet 97% of the time.**
    `nfl-tweet-line-correlation.js:51-53` baselines a tweet against
    `WHERE captured_at = (SELECT MAX(captured_at) FROM nfl_line_snapshots)` — the newest capture in the
    whole table at the moment of ingestion — and never compares that to the tweet's `published_at`. Because
    the sweep reads each handle only every ~3.6 days, the baseline is routinely taken days after the news it
    claims to precede. Measured over all 21,564 `nfl_tweet_line_watch` rows, `baseline_captured_at −
    tweet_published_at`: p10 +15.5h, p25 +40.5h, **p50 +121.8h (5.1 days)**, p75 +264.5h, p90 +478.1h.
    **97.1% are positive; 97.0% exceed an hour.** The baseline already contains any real reaction, which
    biases the measured move rate toward zero — and 2,926 watches have resolved, 401 were flagged "moved",
    and **401 Claude calls were billed** asking the model to connect a tweet to a move it could not have
    caused. The prompt at `:122` also still tells Claude "line snapshots are captured roughly twice daily",
    which is false now (~5-7 minutes) and makes the model more willing to attribute.
    `tweetLineCorrelationSummary()` reports `move_rate` behind an `n>=30` sufficiency gate that is
    satisfied, so this reads as a meaningful number the moment anyone looks at it. *Cost: hours — and the
    cheapest correct action may simply be to stop the fan-out.* *Caveat: fixing the ordering will very
    likely reduce the measured move rate rather than reveal a signal, and the forward-only sample restarts
    from zero. The 401 billed explanations are sunk; the point is to stop billing more and stop the number
    being read as evidence.*
42. **The T-60 packet records the wrong news table, which is why "trace one news fact to a decision" was
    never delivered.** `nfl-t60-packet.js:271` adds a source entry for `nfl_news_events` — the Package E
    table, **30 rows total**, manual-extraction-only, consumed by no forecast. `nfl_news_signals` — the
    498-row table that actually feeds the online-neural features, the council's `news_reaction` expert,
    postgame-truth's carryover probability, the fantasy news-edge actions and the paid capture triggers —
    **is not in the packet at all**. So even once a forecast consumes a frozen packet in production, the
    news fact it acted on will not be in that packet. The gap is small: `nfl_news_signals` already carries
    both clocks the packet contract wants (`published_at`, and `created_at NOT NULL DEFAULT
    (datetime('now'))`), so one `sourceEntry` alongside the existing entries makes it packet-legal. **One
    trap that would silently create a lookahead if done naively:** `created_at` is written space-separated
    by SQLite's `datetime('now')` — all 498 rows — while the packet compares `<= cutoffAt` against an ISO-T
    `Z` string, and because `' '` (0x20) sorts before `'T'` (0x54),
    `'2026-09-05 23:59:00' <= '2026-09-05T00:01:00Z'` evaluates **true**, admitting up to a full day of
    future rows into a frozen packet. Normalize to ISO on read or on write. With that done the full trace
    exists end to end: packet row → `teamNewsSignals()` burden → the council's `news_reaction` forecast
    `clamp(burdenEdge*0.75, ±4)` → the decision. *Cost: hours.*
43. **The news pipeline is structurally blind to about 89% of the roster, which matters for spreads and not
    for fantasy.** `server/news/ingest.js:48` selects `FROM players WHERE fantasy_relevant = 1` — **994 of
    8,720 players** (WR 353, RB 239, TE 156, QB 131, K 83, DEF 32): **zero offensive linemen, zero defensive
    players by name, no coaches** — and entity extraction is exact-full-name only (`normalize.js:20`
    supplies no player aliases), so a nickname or bare surname does not match either. For fantasy that is the
    right population. For spreads it is close to the wrong one: after the quarterback the biggest non-QB
    line movers are starting tackles and premier pass rushers, and this pipeline cannot see any of them — so
    `teamNewsSignals().unavailable_burden`, the online-neural `home_verified_news_burden` feature and the
    council's `news_reaction` expert are all computed on skill positions only. The pipeline was built
    fantasy-first (correct, given your priority) and was never widened when it was pointed at the betting
    model. *Cost: days.* *Caveat: widening it multiplies item 36's blast radius, so fix D1/D2 first.*

## Step 7 — Remaining betting and simulation items (after fantasy, or in parallel if you want volume)

44. **An independent totals engine on a different statistical footing.** This one directly targets the
    diagnosed "thirty-one components, three real signals" problem by adding a genuinely uncorrelated
    fourth rather than another correlated restatement. *(Step 4b is the more concrete, data-grounded version
    of this and should probably replace it — but see item 47, which is why neither on its own is enough.)*
45. **A proper overtime model** calibrated to real historical overtime outcomes.
46. **Add timeout state to play-by-play ingestion** — the missing prerequisite for any real in-game win
    probability model later.
47. **Price the covariance between ensemble components — the fix is already in this repo.**
    `rawWeight = exp(-0.7 · margin_rmse)`, normalised (`nfl-ensemble.js:1160-1178`), with **no covariance
    term anywhere**. That is not a subtlety, it is the direct cause of the "three real signals" diagnosis:
    grouping the 22 active components by the *function that produces them* rather than the `family` label
    they carry, 85.6% of the margin weight lives in three constructions, and the largest of those is
    **literally one function — `diffModel(c, f, scale, id)` at `:657-670` — registered eight times**, once
    per column of one table, each instance receiving an independent vote (Σ .4268). Nine `challengerOnly`
    components are also `diffModel`, so 15 of 31 registered components are the same estimator.
    `nfl-expert-coordinator.js:36-41` already implements the correct treatment for the council — Stage A
    walk-forward per-role shrinkage, Stage B collapsing roles correlating above 0.6 into a single
    coefficient, with an audit note that four roles at r = 0.74-0.92 all added error at full scale — and the
    champion engine never got it. The inputs are already in memory: `fitEnsemble` builds
    `residuals[m.id].signal`, a full walk-forward matrix of every component's deviation from the market in
    chronological order (`:1090-1098`), so the covariance is one pass over arrays that already exist.
    **Why this is not item 44 or Step 4b:** those add a fourth signal, which is good, but neither stops the
    existing 22 from being counted as 22 independent votes, and neither is testable as an improvement until
    the weighting can tell a new signal apart from a re-labelled old one. *Cost: days.* *Related and worth a
    sentence when you do it: `deep_residual` should not be counted as one of the engine's independent
    opinions either — `nfl_online_neural_artifacts` has 0 rows so `predictNetwork` returns exactly 0
    (`nfl-online-neural.js:50-61,166-172`), and even once trained its feature vector is built from the
    ensemble's own family aggregates (`:118-157`), making it a non-linear re-read rather than a second data
    path.*
48. **A required shadow-run window before any model promotion.** There is currently no *forward-data* gate
    for model promotion — nothing that says "prove it on data that didn't exist when you built it." (This
    is a different mechanism from the retrospective `audit_registry`/gate Step 8 describes; see that bullet
    for how the two relate.) Pilot on one fantasy model first, since that is cheapest — the identical
    fantasy-first pilot Step 8's registry-and-gate bullet independently calls for; run the two as one
    pilot, not two. **Do not build the harness from scratch:** `beat-the-close.js` already is one — frozen
    zero-stake decisions (`:243-263`), CLV settlement, a documented retirement rule (`:20-22`, two
    consecutive weeks of below-zero live CLV retires a rule) and audit reporting via
    `nfl-blind-audit.js:759-812`. Borrow it rather than writing a second one; it has the advantage of having
    already run against live data. **One piece needs fixing before you copy it, not praising:** its
    reachable-price join (`:104-110`) is the same pre-fix, broken join item 28 documents — it silently
    excludes 5 of 7 free books today — so apply item 28's fix first, or this harness's CLV settlement
    inherits a known bug on day one. *That retirement rule also currently has no owner — assign one.*
49. **A standing check that the champion model's predictions actually resemble reality.** Cheap, needs no
    new dependency, worth running regardless of what else ships.
50. **`beats_market` has no magnitude threshold, so the cover-calibration card prints the opposite of the
    truth.** `nfl-cover-calibration.js:261` is `beats_market: modelSse < marketSse` with no tolerance. The
    stored calibration's sweep is monotone toward the market — differences `0.000388, 0.000283, 0.000123,
    0.000025, −0.000004, −0.000005, −0.000002, −0.000001, 0.000000` — so the λ=65536 row "beats" by a
    floating-point artifact, `any_lambda_beats_market` comes back true, and the card reads *"At least one
    blend weight beats the market out of sample — the model carries signal worth keeping"* while
    `lambda_reason` **on the same row** reads "the model adds nothing to the market on training data" and
    `forward_gate_passed` is false. The correct verdict string already exists two branches below (`:267-271`)
    and is exactly right for this data. Fix: require the Brier difference to exceed its own standard error.
    *Companion invariant worth adding at the same time:* because `market_residual` yields a zero-variance
    `edge_points` column whenever the residual gate is empty — which is always, per 2.0 —
    `buildCoverCalibration` can be handed a degenerate design matrix and still store a row.
    `sd(edge_points) > 0` and `n_distinct(edge_points) > 1` should be preconditions for persisting any
    calibration artifact. *Cost: hours.*

## Step 8 — Architecture refinement still outstanding (NFL betting specifically)

Tonight consolidated the worst of it. What remains, concretely:

- **Two engine disputes are still flagged unresolved and should be settled, not left open.** One file the
  cleanup wants archived is still wired into a live path; one the audit-system review wants merged into the
  main replay engine, cleanup calls dead code. Both are documented in the Giant Plan's Section 8.16 with the
  competing citations; neither has been decided.
- **A third dispute, newly created by this plan.** `CLEANUP_PLAN.md` b.4 archives
  `nfl-execution-staking-policy.js` + `nfl-execution-clv-downsize.js` ("built for a prop-market
  calibrated-Kelly path that was never wired" — 616 lines of calibration-shrunk Kelly and a CLV-downsize
  control law, zero non-test importers) and the four prop feature/head modules ("0/3 documented negative
  result"). This plan makes props the primary betting workstream and proposes a hierarchical player-prop
  model. Archiving the only built prop-staking path and four built prop harnesses in the same week is either
  the right call or a duplicated build — **it should be one decision, not two independent ones.** And the
  four heads carry a documented negative result *on Step 4c's exact idea*: that is evidence to read before
  starting, not just files to move.
- **Several "merge these two" verdicts were issued and never executed:** the neural replay into the main
  replay engine as an option rather than a separate engine; the two duplicate football-first paths (a service
  and a script asking the same question with different fits); and the two competing notions of the T-60
  capture window (the evidence daemon and the runner each have their own). *Add to this list:
  `beat-the-close`'s reachable-quote join versus the shopping board's — item 28.*
- **The forward provenance verifier checks kickoff instead of the horizon cutoff.**
  `nfl-evidence-provenance.js:4-5,54` uses the game's kickoff as `evidence_cutoff` for all seven horizons.
  Re-running the module's own `collectTimestamps` against each row's own horizon cutoff finds **8 of 155
  stamped rows carry a late stamp** (T-24h 3, T-6h 3, T-60m 1, T-15m 1) that the served verdict string
  currently calls clean — "every stamped input predates its kickoff". One parameter, and it changes a verdict
  a person reads today. *(This is a different module from the two T-60 window notions above.)*
- **The registry-and-gate layer built tonight is unproven — and it is the same `audit_registry` table as
  2b and Step 0 item 5, read through `gridiron-model.js`'s `statusOf()` gate (`:410-440`).** It exists, it
  is tested, and verified directly against the live table: no capability has ever actually been promoted
  through it. Every `advisory`-rank capability whose audit has run so far failed and was retired
  (simulator, trend-totals, model-spread); the two audits that did pass (line-shopping, live-winprob) both
  belong to capabilities whose `baseAuthority` was already declared `authoritative`, so they confirmed a
  standing claim rather than promoted a new one. It should govern one real promotion — cheapest on a
  fantasy model — before it is trusted as a gate for anything on the betting side. **This is a different
  mechanism from item 48's ask, not the same idea stated twice:** this gate lets a retrospective sealed
  audit set a capability's authority level; item 48 wants a forward shadow-run window — proof on data that
  did not exist when the model was built — which nothing in the repo does generically today
  (`beat-the-close.js` does it, but only for one signal family). Both independently land on "pilot on a
  fantasy model first" — treat that as one pilot exercising both mechanisms, not two separate ones.
- **The target flow now mostly exists end to end** (sources → tape → frozen packet → forecast → decision →
  settlement → CLV → register → gate). The remaining gap is that no forecast has yet consumed a frozen packet
  in production, which was the original point of the whole architecture. **The specific cause is now known
  and is Step 0 item 4** (the receipt clock), with a second contributor in item 42 (the packet records the
  wrong news table).

## Step 9 — Unused GitHub and research leftovers worth taking

- **`eslazarev/purged-cross-validation` (MIT) is the single package behind 2a, 2c, 2d and 2e — see those
  items for what each function does and why.** Recorded here only as a pointer: this plan previously named
  the package for `effective_n_trials` alone and separately budgeted "days" to reimplement DSR, PBO/CSCV
  and Holm/BHY from a GPL-3.0 source, a correction already made at 2d. Noted here so a reader who jumps
  straight to Step 9 doesn't pick up the stale version of that story.
- **The seven-method implied-probability dispatcher** (from `penaltyblog`): run your own historical closing
  lines through all seven price-to-probability conversion methods and pick the one that actually performs
  best on your data, rather than selecting one on literature authority. Cheap, and it settles a question
  currently answered by assumption.
- **`johntwk/Diebold-Mariano-Test`** (MIT, ~40 lines) for item 16(i). Frozen since 2017, which is fine — a
  statistic with a published closed form does not rot. Transcribe it; do not depend on it.
- **The two uncatalogued Kelly repos** for item 34 — `sergeisukhovmkt/…Drawdown-Constrained-Kelly-Betting`
  (MIT, 1993 rule only) and `cvxgrp/kelly_code` (GPL-3.0, formula reference only, never a dependency).
- **nflfastR's own expected-points and win-probability model code**: your play-by-play handling is missing
  features relative to the reference implementation. Worth a direct comparison before building anything new
  on top of the current version. *(nflfastR carries no LICENSE file, so this is a read, not a port — which
  is the correct framing and already how it was written here.)*
- **Already-rejected, recorded here so they are not re-proposed:** genetic programming / symbolic regression,
  mixture-of-experts gating, deep generative play-sequence models, reinforcement-learning play-calling,
  live social sentiment, and cross-venue arbitrage as a revenue plan. Each was independently checked against
  the literature's own sample sizes and found to need ten to a hundred times more data than a football
  season provides (see the NOT-DO section below for the same figure from the five-researcher check), or to
  have a measured real-world payoff too small to justify the infrastructure. **Added to this
  list after the late sweep:** every remaining predictive port in the catalog tail — `fivethirtyeight/
  nfl-elo-game`, `sublee/glicko2`, `greerreNFL/nfelosrs`, `ngboost`, mixture-density networks,
  `crepes`/`cqr`/ACI, and the time-series foundation models (`chronos`, `timesfm`, `uni2ts`). Every one is a
  bid to predict better, which is the single thing measured three times not to work here. *(The one cheap
  piece worth keeping — nfelo's already-ingested published line as an external benchmark row — is folded
  into 2e.)*
- **DFS / salary-cap tooling: still rejected.** The repo has zero salary-cap or contest infrastructure and
  there is no signal you play DFS. (Recorded because one research chunk voted to build it and the
  better-evidenced rejection should be the one that stands.)

## Step 10 — Operational debt that keeps getting deferred

51. **A retention policy for the market-quote tables** (or an explicit decision to prune manually). They
    write over a million rows an hour during capture, nothing ever deletes anything, and the next
    disk-space refusal is weeks-to-months out, not years.
52. **Move the slow daily integrity check off the boot path** and schedule database maintenance off-peak,
    never during a capture window.
53. **Re-read the four subsystems the audit's own critic flagged as under-verified** — the fantasy
    draft/trade engine (your top priority and least-verified), the props engine, the drive simulator, and
    the betting routes file. Their findings are probably right; they just never got the independent second
    read everything else got. *Note that news was **not** among those four and has now had its own read —
    Step 6.*
54. **Two scheduled jobs report `last_status: "ok"` while capturing nothing** (Step 0 item 3). Whatever fixes
    the prop feed should also fix the reporting, because the strict `skipped === true` check is part of why
    a dead feed was invisible for five days. A job that stores zero rows on a run where it saw 100,944 quotes
    is not "ok".

---

## What I would explicitly NOT do next

- **Do not restart the forecast-combination work.** It was built properly and lost to the incumbent on
  held-out data. The documented pattern in forecasting research is that this happens often. Respect the
  result rather than tuning until it flatters.
- **Do not build the genetic-programming, mixture-of-experts, deep generative, or reinforcement-learning
  ideas**, or any of the predictive ports now listed alongside them in Step 9 (same rejection list, same
  figure, cited there too). Five independent researchers reached the same verdict against the literature's
  own sample sizes: every one needs ten to a hundred times more independent observations than a 272-game
  season provides. Build guardrails before models, not after.
- **Do not build cross-venue arbitrage or social-sentiment infrastructure.** The best real number anyone
  measured for prediction-market arbitrage was a few hundred dollars across an entire league-month, and
  the one sentiment effect that replicates is a bookmaker bias already priced in.
- **Do not chase a news-speed edge — it is measured dead, not merely unproven.** 19.8 hours from publication
  to a typed signal, 24 hours to a paid capture, against a market that finishes repricing in about 100
  minutes. Competing on news speed would require push/streaming ingestion, a different architecture and a
  different cost structure, and would still be racing people whose entire business is that race. This
  specifically retires the idea of fixing the insider-sweep rotation *as an edge*: `twitter-ingest.js:119,195`
  reads 5 handles per run from a 108-handle pool at 6 runs a day, so each handle is read every ~3.6 days and
  369 of 370 sweep calls returned the same 20-item page cap — real defects, but at $0.09/day against a $10
  cap they are cost hygiene, and no rotation fix closes a 20-hour gap. Step 6 is worth doing to make the news
  numbers *honest*, not to make them *fast*.
- **Do not "fix" the empty `event_to_move_window` panel by changing the panel** (item 40). It is empty
  because its inputs do not overlap in time, which item 39 fixes.
- **Do not expect this season to prove profitability.** With roughly five selections a week you get a
  fraction of the sample needed to detect even a large edge. The honest target for 2026 is a complete,
  trustworthy forward record and a closing-line-value direction reading — not a profit verdict. **And that
  record is not currently being written** (Step 0 items 1 and 2), which is the single most time-sensitive
  thing on this page.

## The decisions still sitting with you

The eighteen open questions from the Giant Plan are all still open. The ones that actually gate work:

- **Is DraftKings' +100 on the two-team teaser a promotion or a standing price?** At +100 that strategy is
  strongly profitable; at their list price it is roughly break-even. This single fact decides whether the
  whole teaser surface deserves the attention it gets. *And note item 33: the guard that answers this
  automatically whenever the price moves is already written and has no caller, while the live floor of −115
  sits below both of the family's own break-evens.*
- **Which readers are allowed to see the live `game_lines.spread` column?** Tonight's build deliberately
  declined to guess and left this for you in a code comment (item 14). It is not "add a guard" — it is a
  policy question about a column that sixteen modules read and that a scheduler job is overwriting right now.
- **Do you want the statistics toolchain stood up?** It gates the hierarchical props work and several
  fantasy items. Worth deciding as one call rather than one dependency request at a time. *There is a
  smaller version of the question than the one this has always been framed as — see the note on
  `penaltyblog` in item 23.*
- **Archive the prop staking path and the four prop heads, or keep them?** The cleanup plan says archive;
  this plan makes props the priority workstream. One decision, not two (Step 8).
- **Retention policy, or manual pruning?** Needs a standing answer, not another deferral.
- **Two ESPN leagues have been failing to sync since September 7th** — a one-click reauth on your end,
  flagged in three separate audits now.

---

## How this plan was built

This document is not one pass of writing — it is the merged output of several independent ones, run in
roughly this order: three independent audits of the codebase and the standing plan; a 121-agent research
sweep across the codebase, the research corpus and the GitHub catalog; one completed fix/consolidation
build (16 pieces, merged and tested); a separate betting-model build; and, last, a five-reader
betting-specific sweep whose job was to re-check the betting sections against live data and correct
whatever assumptions the earlier passes had made before tonight's fixes existed.

That is why some of the later material — Step 0, section 2.0, the premise correction threaded through
Step 4, the item-27 caveat, the registry disambiguation in 2b and Step 8 — directly corrects text that
appears earlier in this same document, sometimes without deleting the original claim outright. That is not
an editing accident. It is the same discipline this project asks of its own models — state a claim
plainly, then let a later, more rigorous pass check it against live data and say so in public, in the
record, rather than quietly — applied to the plan document itself. Where an earlier section's number or
verdict has been superseded, the surviving text now says so explicitly and points to where the corrected
version lives, instead of the two versions sitting side by side unreconciled. If you ever wonder why a
later step reads as more careful than an earlier one on the same subject, this is why: the later one had
more evidence, not more license to sound better.
