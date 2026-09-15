# Sweep reader s4-audits — betting findings the plan is missing

Method. Read WHAT_NEXT.md in full first. Then SYSTEM_AUDIT_2026_09_11.md (all sections),
AUDIT_SYSTEM_REVIEW.md (all sections + Appendix A), CLEANUP_PLAN.md, and the per-group notes
G03, G07, G08, G09, G10a, G10b, G11, G12 (news — added because Nick's ask names it), G16.

Then — and this is the part that changed most of the answers — I checked every candidate against the
**actual post-merge code**, because tonight's two build branches (`build-2026-09-12-v2-integration`,
`model-2026-09-12-integration`; `main` is still at `14c5e65`) already fix a large fraction of the audit
corpus. A finding that is fixed on the branch is not a gap in the plan. Everything below was verified
present *after* the merge, either by reading the branch's file content or by a read-only
`node:sqlite {readOnly:true}` query against the live `server/data.sqlite`.

Confirmed FIXED on the branches (therefore not proposed): T-60 receipt clock (book-feeds.js:418 now
passes `receivedAt`/`response_completion`, and `at` is genuinely assigned after the awaits at :390);
line-shopping.js:66 likewise; packet body persisted + canonical hash + news scoped by team
(t60-runner.js:165-168, migration 036); shadow-ledger kickoff guard; prop name-key and prop settlement
now keyed by player id / gsis_id; shopping-board simultaneous-quote join (now per-book with a 5-minute
window); price-0 quote ranking (`isRealPrice` in nfl-execution.js:26); `stakeFor` deny-list → allow-list
(nfl-execution-edge.js:632); live-edge Polymarket futures collision (kind filter + both team names);
bitemporal injury revisions; migrations for research_trials / nfl_clv_grades / replay spec.

---

## 1. The props workstream (Step 4) is blocked on a dead price feed, not on modelling

Live DB and live `sync_log`, read tonight:

- `nfl_prop_clv`: `MAX(captured_at) = 2026-09-07T18:21:14.247Z`, n = 101,820. **Five days with zero new rows.**
- `sync_log.nfl_prop_feeds`, last run `2026-09-13T01:10:42Z`, `last_status:'ok'`:
  `{"actionnetwork":{"games":16,"stored":0,"unsupported":1595},"underdog":{"error":"HTTP 426"}}`
  — Underdog returns 426 Upgrade Required on every run; Action Network sees 16 games and stores **0**
  because all 1,595 of its markets are unsupported market types.
- `sync_log.nfl_prop_clv_free`, last run `2026-09-13T01:08:12Z`: `quotes_seen:100944, stored:0, modeled:0`.
- `sync_log.nfl_prop_capture` (paid path): `{"captured":{"skipped":true,"reason":"no T-24h or T-1h prop capture window is due"}}`.

Both jobs report `last_status:'ok'` while capturing nothing (the scheduler's strict `skipped===true`
check — G10b #85 — is part of why this is invisible).

WHAT_NEXT.md:117-119 says the 101,820 rows "had almost nothing scored against them… **From here forward
it is** [measured]". That is false as of right now: there is no producer. Step 4a, 4c and 4d all
inherit this.

Plan sections checked: Step 4 (4a/4b/4c/4d), Step 3 item 10, Step 6. No item restores or replaces a prop
price producer.

## 2. The book mix makes 4a (prop-vs-total consistency) unbuildable from the stored tape

`SELECT market, book, COUNT(*) … FROM nfl_prop_clv GROUP BY market, book`:

- `underdog` 100,944 rows (99.1%), captured 2026-09-02 → 2026-09-07. Markets: reception yards 38,456 ·
  receptions 38,174 · rush yards 16,892 · pass yards 7,422. Underdog is a DFS pick'em product: it posts
  **no game totals and no touchdown markets**.
- Every other book — draftkings 477, fanduel 164, betrivers 161, betonlineag 74 — comes from **one
  five-minute paid Odds-API capture on 2026-08-27** (17:11:59Z / 17:16:55Z).
- **All 512 `player_anytime_td` rows are from that single 2026-08-27 capture** (DK 365, BetRivers 77,
  FD 56, BetOnline 14). The market where the model has its only proven skill (+27% Brier on 2+ TD,
  +20% anytime) has had **no price captured in 16 days**.

Consequences the plan does not state:
- 4a compares "the books' own player props for a team against the books' own posted game total". The
  books that post totals (unibet, bodog, heritage, betonlineag, bovada, pinnacle, betrivers, fanduel…,
  from `nfl_line_snapshots` market='totals', last 7 days) are not the book supplying 99% of the props.
  Same-book prop+total coverage today is 876 rows, 16 days stale.
- You cannot reconstruct implied team points from yardage and reception lines alone — that requires a
  scoring market, and the tape has essentially none.

So 4a's stated premise ("Data to do it already exists in the prop tape", WHAT_NEXT.md:127-128) does not
hold. This is not an argument against 4a; it is the missing first step: acquire prop prices from books
that post both props and totals, including TD markets.

Plan section checked: Step 4a. Not represented.

## 3. `game_lines.spread` is still overwritten with live in-game numbers — and tonight's build deliberately deferred the fix "for a human to resolve"

`model-2026-09-12-integration:server/services/gamescript.js:120-133` is a new comment block added tonight:

> TODO(a5-simulation, 2026-09-12): the build plan for this pass asked for a preKickoff guard on `stmt`'s
> spread/total UPDATE… **Deliberately NOT applied**… Left for a human to resolve: either the plan's
> premise is wrong… or there is a narrower guard intended here… Not applied either way rather than guessed at.

The corruption it leaves running is measured: integer-spread share in `game_lines` falls 47.7% (2024) →
24.9% (2025) → 16.9% (2026) (G07 #38, re-queried by the verifier). `teaser-leg-rates.js:30-57` excludes
2025 and 2026 from measurement *because of this*; `nfl-execution-edge.js:93,218,276` does not (see §6).
`syncCurrentLines` runs on a scheduler job plus two mounted routes, so this is writing right now.

The unresolved question is not "add a guard" — it is "which readers are allowed to see the live column",
and that decision has an owner-shaped hole in it. It is in no plan section: Step 1 (close-out), Step 5b
(architecture), Step 6 (operational debt) and "The decisions still sitting with you" all omit it.

## 4. 2022-2025 `open_spread` is still corrupted, and the new fix structurally cannot repair it

Tonight's `odds-archive.js` fix is correct going forward (home and away rows written separately, away
negated). But it writes `COALESCE(open_spread, ?) … WHERE (open_spread IS NULL OR open_total IS NULL)`,
so the already-wrong non-null values are pinned forever. No repair script exists
(`git grep -ln open_spread -- scripts` on the branch: nothing).

Live antisymmetry check (home.open_spread should equal −away.open_spread):

| season | pairs | antisymmetric | identical on both rows |
|---|---|---|---|
| 2019-2021 | 256 / 251 / 272 | 256 / 251 / 272 | 4 / 6 / 11 |
| **2022** | 267 | **5** | **267** |
| **2023** | 285 | **4** | **285** |
| **2024** | 285 | **1** | **285** |
| **2025** | 285 | **4** | **285** |
| 2026 | 271 | 271 | 0 |

1,122 game-pairs, four full seasons, still wrong. Sixteen modules read `game_lines.open_spread`,
including `nfl-ensemble.js` (the market-anchor family), `nfl-replay.js`, `nfl-expert-council.js`,
`nfl-evidence.js`, `nfl-drive-sim.js`, `nfl-orthogonal-specialists.js`, `nfl-profitability.js`.

Note (do not overclaim): `line-move-study.js` reads openers from `nfl_odds_archive`, not this column, so
the nfelo-vs-Pinnacle-opener signal is *not* hit by this. The exposure is the ensemble/replay/council path
— which is exactly what Step 2's leaderboard will re-run over 2021-2025.

Plan sections checked: Step 2 (5a-5e) has no data-repair precondition; Step 1 item 5 is about applying
migrations, not repairing rows. Not represented.

## 5. `beat-the-close.js` was left with the reachable-quote join the shopping board just abandoned

Tonight fixed `nfl-shopping-board.simultaneousQuotes` to group by `(event_id, book)` with a 5-minute
`CAPTURE_WINDOW_MS` (branch, nfl-shopping-board.js:98-112), with an explicit comment that the old
exact-equality join on one `MAX(captured_at)` "silently dropped every book except whichever provider
happened to be polled last".

`beat-the-close.js:106` still does exactly that: `SELECT MAX(captured_at) … WHERE provider LIKE 'free:%'`.
Live proof (`nfl_line_snapshots`, last 24h): only `free:oddstrader` and `free:pinnacle` carry the newest
instant (`2026-09-13T01:47:36.081Z`); `free:kambi`, `free:fanduel`, `free:sbr`, `free:rotowire` sit at
`01:10:4xZ` and `free:bovada` at `00:09:53Z`. Those five books are structurally excluded from every
`bestReachable` call.

Why it matters more than it did yesterday: `beat-the-close` is the project's only forward, timestamped,
zero-stake experiment, and after the merge the two surfaces that answer "what price could I actually have
got" use two contradictory definitions. The execution edge is the one edge this project has.

Plan section checked: Step 5b lists two engine disputes and three unexecuted merges; beat-the-close is not
among them. Not represented.

## 6. Execution pricing is still computed from the seasons the repo itself calls corrupted, and the board still leads with the underdog-bias number

On the merged branch:
- `nfl-execution-edge.js:93, 218, 276` — the three margin-distribution queries still read
  `FROM game_lines` with no season bound, while `server/betting/nfl/strategy/margin-distribution.js`
  exports `MEASUREMENT_SEASONS` / `EXCLUDED_SEASONS` / `EXCLUSION_REASON` and uses them. Every half-point
  valuation on the shopping board is therefore priced from a distribution that includes the 2025/2026
  rows §3 is still corrupting.
- `nfl-shopping-board.js:237-240` still sorts every side across every game by `expected_net_return`, and
  `:444` still reports `best_expected_return: spreads[0]…` — the no-forecast empirical cover rate that
  commit `14c5e65` itself measured as underdog bias (+6.5 → 53.53%, +10 → 55.28% vs 52.38% break-even).
  It is labelled `qualified:false`, so it cannot reach a stake; it is still the first number on the board.

Plan sections checked: Steps 5, 5b, 5c contain no execution-pricing item at all — despite execution being
the one place the project has a measured edge.

## 7. The only +CLV signal still selects its hyperparameters inside its own holdout

Untouched by both branches:
- `report-cache.js:59-62` — `line_move_study: { … args: [{}] }`.
- `line-move-study.js:119,132` — `selectionThrough = null` ⇒ `fitModel()`.
- `nfl-market.js:156` — `selectionCap = selectionThrough == null ? lastSeason - 1 : …`; with completed
  2026 rows in `game_lines`, `lastSeason = 2026` ⇒ selection window runs through **2025**, inside
  `line-move-study.js`'s own `HOLDOUT_FROM = 2024`.
- Also still present: T2 uses realised kickoff-hour weather (`line-move-study.js:197`), and nfelo's
  per-date availability is unverified (AUDIT_SYSTEM_REVIEW L20) — TeamRankings is date-verified, nfelo is not.

Per memory, `nfelo`-vs-Pinnacle-opener favourites is *the* positive-CLV signal this project has. It is
promoted to a live rule in `beat-the-close`'s RULES. Re-measuring it with the selection window fenced and
the realised-weather feature dropped is a one-line call-site change plus a re-run. The project already
measured what fencing costs elsewhere: +0.47 → +0.28.

Plan sections checked: Step 2 (multiplicity/walk-forward) charges *trial count*, not this specific
selection-window leak; Step 5c lists unused research leftovers. Not represented.

## 8. Verified news claims are wrong at the player level, and they already spend money and move numbers

G12 D1/D2 (both P1). The rules extractor gives **every player named in a story the story's first matching
status**, and the team matcher treats "WAS" and "NO" as team codes inside English prose (193 misattributed
RSS/Twitter rows).

Verified live tonight in `nfl_news_signals`:

```
Lamar Jackson  | BAL | released | unavailable_probability 1.0 | verification_state verified | 2026-08-31 | evidence "waived"
Derrick Henry  | BAL | released | unavailable_probability 1.0 | verification_state verified | 2026-08-30 | evidence "waived"
```
114 rows carry `status='released', unavailable_probability=1.0, verification_state='verified'`, the most
recent published 2026-09-12T20:02Z.

Where those rows go (G12 §3 wiring, all live): `enqueueRecentNewsTriggers` turns any verified signal with
`unavailable_probability >= 0.5` into a **paid Odds API capture trigger** (`nfl_capture_triggers` holds
real `captured`/`deferred` rows keyed "TEAM availability: out"); `playerNewsSignal` overwrites the
numeric carry-forward `unavailable_probability` in `nfl-postgame-truth.js:514-520` → `gameInjuryCarryover`
→ council / unified-engine head; `newsOpportunities` emits concrete fantasy actions on
`GET /trades/:leagueId/news-edge`.

So the news layer is currently capable of spending Odds API credit and marking a starting QB as gone, on a
claim the system labels "verified".

Related, dated: `newsSourceVerification` accepts a social handle whose `news_source_validation` verdict is
under 30 days old. The 108 handles were validated 2026-08-29 — **that expires 2026-09-28** and nothing
re-runs it automatically (G12 D4). On that date every social-sourced claim silently falls to quarantined.

Plan sections checked: the whole of WHAT_NEXT.md — the word "news" does not appear anywhere in it. Nick
explicitly asked about the news; the plan has no news row at all.

## 9. The insider sweep cannot deliver a timing edge as configured

`twitter-ingest.js:119,128-139,195` (G12 D7): `MAX_TWEETS_PER_RUN = 5` handles per run, 108-handle pool,
6 runs/day ⇒ **each handle is read once every ~3.6 days**, Schefter on the same rotation as a beat writer.
The query carries no `since:` / `since_id` bound, so 369 of 370 recorded sweep calls returned exactly the
20-item page cap — every visit re-bills the same window. For a prolific national insider the "latest 20
matching" window covers well under a day, so Week-1 breaking news from precisely the accounts the module's
header calls "the whole reason this exists" is structurally missed most of the time.

Cost is trivial ($0.09/day against a $10 hard cap, `twitterapi_io_usage` 777 rows / $1.185 spent). This is
a coverage-and-latency bug, not a spend bug — and latency is the entire point of an insider feed feeding a
capture trigger. Fix is a weighted rotation (nationals every run) plus `since:` from each handle's last
stored `published_at`.

Two sibling facts from the same group: `twitter_insiders` is abandoned at its 120s scheduler budget on
every recent run while the abandoned promise keeps running and spending (D6), so its recorded status is
meaningless; and `trustedHandles()` — the documented control that would drop the one `questionable`
national handle — is wired to a route only, never to the ingest (D8).

Plan section checked: none — no news/ingest item exists.

## 10. §5's answer: the season has exactly one decidable endpoint, and declaring it has a deadline that is days away

AUDIT_SYSTEM_REVIEW §5 does the arithmetic the plan asserts the conclusion of without carrying the method:

- ROI: n ≈ 5.6/δ² before clustering ⇒ +10% needs ≈560 bets (≈3 seasons at the 5/week cap), +5% needs
  ≈2,250, +3% is unreachable. A 90% ROI interval at n=90 is ≈±16%.
- **All-game point CLV at T-60 on 272 observations is decidable**: +0.3 pts needs ≈35-70 games iid
  (≈50-100 clustered); price CLV of +0.5pp with SD ≈1.5pp needs ≈55 games.
- Conditional Brier vs the market on 272 games cannot resolve differences of the size that matter (≈0.002).

Three concrete requirements follow, none of which are in the plan:
1. **CLV must be graded for every tape decision, selected *and* abstained** — that is what makes the
   denominator 272 instead of ≤90. `nfl-execution-clv.js` grades accepted positions only.
2. **The T-60 threshold must be re-declared against the 2026 tape's own T-60→close distribution**, once
   ~4 weeks of tape exist, *before* anyone looks at the model's side of it. The existing +0.3 gate was set
   for opener-based signals over days of movement and does not transfer.
3. **The review endpoints must be pre-registered before Week 3 kickoffs** (§7 item 10): one
   `audit_registry` row per hypothesis — point CLV and price CLV, explicitly **not** ROI — with a Week-9
   integrity endpoint (counts and coverage only, no economic claim) and a Week-18 CLV endpoint, σ and τ
   taken from 2021-25 development data. Today is 2026-09-12. Week 2 is in progress.

The plan states the 2026 target correctly ("a complete, trustworthy forward record and a closing-line-value
direction reading", WHAT_NEXT.md:229-230) but never says how it is made admissible, and never mentions the
deadline. Step 5 item 14 (shadow-run window before promotion) is a different mechanism.

Also worth noting from §5: `always_valid_p` is NULL on all 15 registry rows — the mSPRT implementation
(`backtest-significance.js:216-230`) is correct and has never been fed. Tonight's migration 040 splits the
column; nothing declares a σ.

## 11. Step 2's multiplicity haircut is aimed at the wrong search

Step 2 (5b/5c/5d) points the trial register and the deflated-Sharpe/PBO haircut at "all 21 model variants,
every family ablation config, every segment definition". AUDIT_SYSTEM_REVIEW §5's multiplicity row says
where it actually bites:

> the haircut bites hardest on the **segment finding** (best of many segments) and the **beat-the-close
> signals** (best of ~320 feature × stamp × market cells), which is where it must be applied first.

Reason: the 21 model variants are all negative (−7%), so haircutting them changes nothing. The two places
a *positive-looking* result was selected out of a large search are the segment finding and the
beat-the-close feature grid. Two mechanical details the plan should carry:

- `nfl-replay.js:670` discards every attempted segment below `minBets` **before** the Holm family is
  assembled at `:691` — the correction is applied to survivors only, which is precisely the bias the
  correction exists to remove. (This is the concrete form of plan item 5b's "including the ones silently
  dropped for falling below the minimum-bets threshold" — the plan names the symptom, not the line.)
- Three unlinked Holm families exist: `nfl-replay.js:691`, `line-move-study.js:406`,
  `nfl-passing-specialists.js:226`. A trial register that does not join them is three registers.

Combined with §7: the beat-the-close cells are both the place the haircut matters most *and* the place with
a live selection-window leak.

## 12. One click revives the 101,820-row prop tape — and nothing scheduled will ever do it

`nfl-prop-clv.js:598` — `reconcilePropQuoteMatches({ force = false })` selects
`WHERE model_match_status IS NULL OR model_match_status='legacy_unclassified'`. On the merged branch
`scheduler.js:638` and `:654` still call it with no arguments. Live status counts are frozen at
`role_ineligible 92,192 · projection_missing 9,134 · modeled 406 · identity_unresolved 40 ·
unsupported_participant 48` — i.e. every row corrupted by the old name-key bug sits in a terminal status
the scheduled job never revisits, even now that the id-based matching is fixed.

The manual path exists: `POST /props/quotes/reconcile` → `reconcilePropQuoteMatches({force:true})`, wired
to a button at `ProfitabilityControl.tsx:89`. The audit's own Section I item 5 said "force-reconcile the
100,944 frozen rows once fixed"; that sentence did not survive into the plan.

Plan section checked: Step 4d assumes the tape becomes scorable once matching works. Not represented.

## 13. The only +EV product's UI is broken in two ways, both found only as asides inside refuted claims

Both files untouched by either branch. Both were surfaced in G16 as "a different, more severe bug… not
covered by this claim" while the claim itself was refuted — exactly the shape of a finding a merge loses.

- `client/src/components/betting/wong/WongSettings.tsx:9-13` offers
  `reduce_to_single` / `push_refunds_stake` / `loses`; the server enum is
  `teaser-season.js:115 REDUCED_PAYOUT_MODELS = ['stake_back','same_price','graded_loss']` and
  `validateSettings` rejects anything else. **Every option in that dropdown fails server validation.**
  The push-grading model is the single assumption that moves the teaser break-even (−120.2 vs −116.8).
- `client/src/components/betting/wong/WongSeason.tsx:22-41` reads `season.record`, `season.units_staked`,
  `season.units_won`, `season.roi`. `wongSeason()` (teaser-season.js, `return { season, generated_at,
  settings, placed, paper, open_tickets, pace, price, projection, forward_leg_rate, version }`) has none
  of those at top level — they live under `placed`/`paper`. So the season P&L tiles for the only strategy
  the project believes is +EV render blank.

Plan section checked: Step 5b and "The decisions still sitting with you" — the teaser appears only as a
pricing question. Not represented.

## 14. The guardrail for the DK-price decision already exists and has no caller

The plan's first open decision is whether DraftKings' +100 on the 2-team 6-point teaser is a promotion or
a standing price. What it does not say is what happens if the answer is "promotion":

- The live floor is −115 in three independent places: `teaser-scan.js:195,209,578`,
  `nfl-teaser-execution.js:24,126`, `teaser-season.js` DEFAULT_WONG_SETTINGS.
- The family's own break-evens are −120.2 (`stake_back`, the default grading) and −116.8 (`graded_loss`).
  At −115 `teaser-staking.js`'s posterior puts **37.2%** mass on no edge at all, against its own
  `maxNegativeEvProbability` default of 0.20.
- `recommendStake` — the function carrying that gate — is still imported **only** by
  `test/teaser-staking.test.js` after both builds. The test itself asserts
  `recommendStake({ americanPrice: -115 })` is refused (test:225) while the live scanner admits it.
- And `teaser-staking.js:257 MEASURED.forwardRateSd = 0.023` is stale against
  `teaser-season.js:612 FORWARD_RATE_SD = 0.0282`, so every quoted P(no edge) — including the 37.2% —
  is computed with too narrow an SD and is **understated**.

Wiring `recommendStake` into `teaser-scan`/`nfl-teaser-execution` and refreshing the SD converts an open
question into a code guard that answers it automatically whenever the price moves.

Plan section checked: "The decisions still sitting with you", item 1. The question is there; the guard is not.

## 15. The props evaluation harness biases toward the model, and the shipped calibration head is selected in-sample

Both untouched by either branch, both directly under Step 4:

- `nfl-props-replay.js:44` — `toHalfPoint` only ever adds +0.5 when naive rounding lands on an integer.
  Executed by the verifier: `toHalfPoint(50.0)=50.5`, `(49.9)=50.5`, `(49.0)=49.5`, `(49.7)=49.5`. The
  synthetic line the harness uses to judge "whether the model has business being bet into a real market"
  is systematically high, which flatters Unders and punishes Overs uniformly.
- `nfl-prop-calibration.js:342` — `const chosen = scoredOnTrain[0]`: the shipped TD-calibration head is
  chosen by **training** Brier, under a comment (`:337-338`) claiming "same selection discipline as the
  sealed audit". The sealed audit (`auditTdCalibration`, `:231-257`) fits on train, *selects on a separate
  discovery set*, applies a paired test and Holm. `nfl-prop-player-heads.js:18-20` documents the baseline
  as "lowest training Brier wins" and explains why that method "would always crown platt_all".

This does not touch the settled +27% Brier result (which came from the held-out sealed-audit path). It
says the *production* selection rule and the *replay harness* are not the thing that earned it — worth
knowing before 4c/4d cite either number.

Plan sections checked: Step 3 item 10 and Step 4c — both discuss the dispersion model; neither mentions
the harness or the selection rule.

## 16. The forward provenance verifier still checks kickoff instead of the horizon cutoff (G24)

`nfl-evidence-provenance.js:4-5,54` on both branches: `evidence_cutoff` is the game's kickoff for all
seven horizons. AUDIT_SYSTEM_REVIEW rates G24 CONFIRMED with "highest forward materiality"; its verifier
re-ran the module's own `collectTimestamps` against each row's own horizon cutoff and found **8 of 155
stamped rows carry a late stamp** (T-24h 3, T-6h 3, T-60m 1, T-15m 1) that the served verdict string
currently calls clean ("every stamped input predates its kickoff"). One parameter; it changes a verdict
a person reads today.

Plan section checked: Step 5b mentions merging the two T-60 window notions (daemon vs runner). This is a
different module. Not represented.

## 17. Two cleanup verdicts are now in direct tension with the plan (answer to Q4)

`CLEANUP_PLAN.md` b.4 archives:
- `nfl-execution-staking-policy.js` + `nfl-execution-clv-downsize.js`, reason: "built for a prop-market
  calibrated-Kelly path that was never wired" (G08 1.7/1.12 confirm zero non-test importers; 616 lines of
  calibration-shrunk Kelly and a CLV-downsize control law).
- `nfl-prop-player-heads.js`, `nfl-prop-player-weekly-heads.js`, `nfl-props-player-features.js`,
  `nfl-props-player-features-weekly.js`, reason: "0/3 documented negative result".

Tonight's plan makes props the primary betting workstream (Step 4) and proposes a hierarchical player-prop
model (Step 3 item 10 / 4c). Archiving the only built prop-staking path and four built prop feature/head
harnesses in the same week is either the right call or a duplicated build; it should be one decision, not
two independent ones. Note also that the four heads carry a *documented negative result on this exact
idea* — that is evidence Step 4c should read before it starts, not just files to move.

Plan section checked: Step 5b names two engine disputes (nfl-prospective-collection, nfl-neural-replay).
These two are different and unlisted.

---

## Answers to the four questions, stated plainly

**Q1 — confirmed P1/P2 betting defects not in the plan.** Yes, and the ones that survive the
post-merge check are: the dead prop feed (§1), the deliberately-deferred `game_lines.spread` guard (§3),
the unrepaired 2022-25 `open_spread` (§4), `beat-the-close`'s reachable join (§5), execution-edge season
pooling and the dog-bias board sort (§6), the line-move selection-window leak (§7), the two news P1s
(§8), the Wong client/server contract breaks (§13), the props harness and calibration-selection defects
(§15), and G24 (§16). A large fraction of the rest *was* fixed tonight — that part of the merge held up.

**Q2 — defects that read as opportunities.** The clearest: the one-click force-reconcile that revives
101,820 prop rows (§12); `recommendStake`, a finished negative-EV gate with no caller, which answers the
plan's own open teaser-price question automatically (§14); the mSPRT implementation that is correct and
has never been fed a σ (§10); and the insider-sweep rotation, where a `since:` bound and a weighted
rotation convert a re-billed 20-tweet page into an actual timing edge (§9).

**Q3 — §4/§5 actionable and unrepresented.** §5: yes — the all-game CLV denominator, the re-declared
T-60 threshold, and the pre-Week-3 registration deadline (§10), plus the correction to where the
multiplicity haircut belongs (§11). §4 leakage: the one exposure that is both unresolved and load-bearing
for Step 2 is L08/L09 — week-keyed tables are mutated in place (79k injury, 342k depth, 253k snaps, 122k
usage UPDATEs since 2026-09-02), so a `week <` filter proves chronology of the *index*, not of the
*value*; L09 (whether a 2021 replay week consumes a through-2025 fit) was never adjudicated by any reader.
Tonight's bitemporal wiring fixes this forward for injuries only. Step 2's purged walk-forward inherits it.

**Q4 — refuted-on-materiality gaps whose precondition has changed.** Two:
- Appendix A **G16** (paired bootstrap degrades silently) was refuted because no live call site trips it —
  but the verifier found a *different, reachable* exposure it did not state: `groups` **longer** than n
  passes the `>=` guard and misaligns by index (`offseason-model.js:1497`, `:1149`). Step 2's leaderboard
  and the deflated-Sharpe work make `pairedBootstrapDiff` load-bearing across the whole stable; tonight's
  build added `stats-util.js` clustering (+87 lines) without a `clustered` flag on the return. Reopen as
  the verifier restated it: refuse mis-*aligned* groups, not only short ones.
- Appendix A **G09** (CLV never persisted; default reference book set includes the execution book) was
  refuted on the grounds that it is a read-only projection over an append-only tape and 0 positions exist.
  Its own stated reopening precondition is "a graded number is cited in a claim that must be reproducible
  at a later date". Step 2's leaderboard and §10's pre-registered CLV endpoint are exactly that. Tonight's
  migration 037 (`nfl_clv_grades`) plus the new `clv-core.js` supply the mechanism; what is missing is the
  declared reference book set that excludes the execution book.
Also worth listing under Q4: §17's cleanup-vs-plan conflict, where the archive rationale ("the prop path
was never wired") stops being true the moment Step 4 is the priority.
