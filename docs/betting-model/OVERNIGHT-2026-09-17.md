# Overnight run — 2026-09-16 into 09-17

Read this first. Detail lives in
[EDGE-TEST-REGISTRY.md](research/EDGE-TEST-REGISTRY.md) and
[RECOVERY-PLAN-2026-09-16.md](plans/RECOVERY-PLAN-2026-09-16.md).

---

## The headline

**No edge was found. Twenty-three hypotheses tested out of sample, graded on CLV and Kelly, with
adversarial refutation on anything positive. Zero survivors.**

The closest call, and the most instructive failure, was **steam moves** — bet the side the market
just moved toward, at a book that has not repriced yet. It looked like the real thing: +3.67% EV,
t=+2.63, stable across six parameter settings, and it replicated on two independent sources (an
11-book US tape) and a second market (totals). Three adversarial attacks killed it:

1. **My own bug.** The script selected the laggard's price and never used it — EV was hardcoded at
   −110. The laggard's real price averages **−112.4**, and the juice scales with the apparent free
   points (−102.3 at zero CLV, −119.6 at +6 points of CLV). A book that has not moved its *line*
   defends the number with *price*. At real prices: **+3.67% → +0.33%, p = 0.403.**
2. **A direction placebo.** 200 shuffles randomising the steam direction reproduce the result
   exactly — and at one setting a **random direction beats the real signal** (32nd percentile).
   The rule harvests cross-book dispersion, which in this tape is largely scrape staleness.
3. **Execution.** The laggard's price is worse than the movers' on the same side 71% of the time.

Both "replications" were replicating the confound, not a signal — which is why they agreed.
**Consistency across markets and sources is not evidence when the confound is present in all of
them.** The lesson: run the placebo *before* the parameter sweep. The sweep made it look robust;
the placebo showed there was nothing to be robust about.

Fully corrected end to end — real posted price, corrupt seasons dropped, one bet per game — it is
**−2.35%**. And the multiplicity was worse than it first appeared: not 3.5 bets per game but
**11.25**, median 7, **max 443 bets on a single game**.

**Two ideas worth keeping from the autopsy.**

> **1. The market prices a stale line through the PRICE, not through the line.**
> A book that has not moved its number has moved its juice instead. 46.9% of laggard quotes are
> worse than −110 and only 11.8% better, and the juice scales with the apparent free points:
> −102.3 at zero CLV, −119.6 at six points of CLV. The "free" half-point is sold back to you at
> almost exactly its value. **Any CLV measured on lines alone is measuring an illusion** — which
> applies to two other findings in this document, both now flagged.

> **2. Positive CLV can be a definition rather than a discovery.**
> I initially wanted to keep "+0.57 pts of real CLV" as a salvaged finding. The judge overruled it,
> correctly: the placebo reproduces the CLV **to three decimals** (null +0.729 vs real +0.730). The
> rule *selects* books sitting on the good side of the movers and then measures CLV against a close
> that follows the movers. A t-statistic of +36.94 was measuring the selection rule.

And one result overturns an assumption this project was built on:

> **Line shopping is a cost reduction, not an edge.**
> Best-book EV is **−1.82% per bet** (N = 561,746 opportunities, 260 games).
> Shopping is worth **+3.23 points versus a random book** — real, large, worth doing — but perfect
> shopping *still loses*. The prior belief was ~+4 points reaching roughly break-even, with models
> supplying the edge on top. The measured number is ~60% smaller and does not reach break-even,
> so there is no break-even foundation for a model to add to.

| Strategy | EV per bet |
|---|---:|
| Best book | **−1.82%** |
| Best price on consensus number | −4.01% |
| Consensus | −4.88% |
| Random book | −5.05% |
| Worst book | −8.42% |

**Replicated on a second sample and extended to every market.** Not one cell is positive:

| market | books | sample | best-book EV |
|---|---:|---|---:|
| spreads | 11 | 2026, 260 games | **−1.82%** |
| spreads | 4 | 2019–25, 1,525 games | −4.61% |
| totals | 4 | 2019–26, 1,936 games | −3.03% |
| moneyline | 4 | 2019–26, 1,946 games | −3.35% |
| moneyline on Kalshi (heavy favs) | — | 2026, 7 games | −1.88% |

The shopping *gain* scales with how many books you can reach — +0.66 pts across 4 books versus
+3.23 across 11 — because 4 books disagree by only 0.52 points on average. Book count is the entire
mechanism, and even 11 books only reaches −1.82%.

**And the closing line itself is efficient.** Probed 39 ways — home dogs, big road favourites,
divisional, primetime, low and high totals, key numbers 3 and 7 — **zero of 39 buckets survive**
correction for having looked 39 times (Bonferroni α=0.00128).

---

## What else was tested and died

| Area | Result |
|---|---|
| Kalshi leads sportsbooks | No lead at any lag (14 games, 227,810 minute-bars) |
| 55 new advanced features vs the close | **−0.30pp CLV** — the market has already priced them |
| Cross-venue arbitrage | Cheapest two-sided round trip costs a median **1.0375**; 3 minutes in 6 weeks beat fees, all data errors |
| Middles / key-number straddles | **−2.62%** realized, game-clustered **t = −8.99** |
| Stale books | Lag is real and large (DraftKings median 2,302 min behind) but betting it returns +0.71% |
| Kalshi microstructure | Died to its own placebo controls |
| Injury news → line movement | Real second-precision timestamps for 2021–24, but **none for 2025 or 2026**, so no holdout |
| Wong teasers | 74.69% on 1,391 legs — clears −110, dies at −120, and we hold no teaser price data |

## The most interesting mechanism found, even though it is not an edge

**Kalshi is structurally cheaper than sportsbooks for favourites and dearer for dogs, crossing at
p ≈ 0.57.** On heavy favourites it is 1.09 probability points cheaper and cheaper in **92.3% of
minutes**. The reason is structural: a book's overround share is mechanically *proportional to the
probability*, while Kalshi charges a flat half-spread (~0.63c) plus a fee of `0.07·p·(1−p)` that is
humped at the money and near zero at the extremes. Proportional versus flat-plus-hump cross at 0.57.

It still is not an edge — Kalshi's best bucket is −1.88%, worse than the −1.82% you can already get
shopping spreads. But if you are going to bet a favourite's moneyline anyway, Kalshi is the cheaper
venue, and that is a real, mechanically explained, reproducible fact.

## The one thing that is still alive

**The preregistered shadow tape.** 56 decisions written at 2026-09-03T21:01Z, days before week 1,
never graded because the database died on 09-16. Graded now: **+0.94pp CLV, t = +2.04, clustered
over 15 games.** Positive, hindsight-free, and consistent with its own recorded prior basis.

It is *not* proof — 15 games, and the 40.4% win rate has a 95% CI of 27–54%, so results carry no
information at that n. But it is the only genuinely out-of-sample forward test in the project, and
**it stopped recording when the database died.**

**It is recording again as of 2026-09-17T05:36Z — 176 signals written, 38 decisions frozen for
week 2.** Three things had to be fixed: `game_lines` 2026 had no scores or gamedays (backfilled 16
games from nflverse), Pinnacle quotes were being written to a different database than the models
read (bridged, filtering out the alternate ladder), and the launchd capture agent is blocked by
macOS TCC so it runs as a loop instead.

**Caveat that must travel with those 38:** their recorded `opener_at` is tonight's first capture,
not week 2's true opener, so every one has `opener == line`. That makes them a *rating vs current
line* test, not the preregistered *rating vs opener* rule — grade the cohort separately. From week
3 on, with capture running continuously, the true opener will be caught and the tape returns to the
preregistered rule.

---

## Two bugs I made and caught, because they shape how to read everything above

1. **A sign-convention error produced +18.5 points of CLV on an NFL spread** — impossible, which is
   what caught it. `shadow_decisions.line` is standard notation (negative = home favoured);
   nflverse `spread_line` is a margin (positive = home favoured). They are negatives of each other.
2. **Look-ahead inflated a backtest by 87%.** Pricing a week-W rating against the rebuilt archive's
   "opener" let the rating exploit a line posted a median 11–12 days earlier that was no longer
   quotable. Repriced at a realistic decision point, CLV fell from +2.24pp to +0.32pp.

Both are logged in the registry. Any future join between those sources must normalise first.

---

## What was recovered (all free)

The live 16 GB database was deleted 2026-09-16. The 2026-09-03 backup turned out to be an empty
pre-restore shell. Everything below was rebuilt from public sources overnight.

| Table | Was | Now | Source |
|---|---|---|---|
| `nfl_odds_archive` | 0 (lost 135,930) | **102,288** | Covers per-change history |
| `nfl_team_coaches` | 0 (lost 384) | **893** | nflverse game coach columns |
| `nfl_game_weather_forecast_history` | 0 (lost 3,810) | **3,465** (1,155 games) | Open-Meteo previous-runs, all 62 venues |
| `nfl_team_feature_vectors` | 0 | **2,078** | the repo's own feature store |
| `nfl_external_ratings` | 64 | **2,432** | the pre-deletion extract |

**Every Python model was broken** — all 9 hardcoded the deleted path. Repointed via `GRIDIRON_DB`
and verified running (`lab.py` 1,363 games, `books.py` 1,098, `wired.py` MAE 10.24, `kalman.py`
MAE 9.99). Six `.mjs` scripts fixed, including **three broken safety guards** that would have let
validation scripts write to production. A migration blocker was cleared (`nfl_replay_runs` predated
migration 041, killing `db:migrate` entirely).

### ⚠️ ONE THING NEEDS YOUR CLICK: Full Disk Access

Two scheduled jobs were installed and **both are blocked by macOS TCC**. A LaunchAgent does not
inherit Terminal's Full Disk Access, so it cannot read or write anything under `~/Documents` — where
both the repo and the backup directory live. Moving the script to `~/Library/Application Support`
let launchd *execute* it, but it still could not touch the databases, so that is not a fix.

```
/bin/bash: .../nightly-backup.sh: Operation not permitted
```

**Grant it:** System Settings → Privacy & Security → Full Disk Access → add `/bin/bash` (or the
Terminal/Claude app that launches the agents). Both jobs start working immediately afterwards.

**Until then there is a fallback already running:** `scripts/line-history/maintenance_loop.sh`,
started from this session's authorised shell, does Pinnacle capture every 10 minutes and one
database backup per day after 04:00. It survives logout but **not a reboot** — restart it with
`nohup scripts/line-history/maintenance_loop.sh > /dev/null 2>&1 &`.

**Backups verified working** when run from an authorised shell: `data` 471 MB and `line_history`
6,723 MB written to `~/Documents/gridiron-db-backups/`, 7 snapshots retained per database, refuses
if the disk is short.

**Pinnacle forward capture is new and matters.** Pinnacle is the benchmark every CLV number is
graded against, no free source carries its history, and nothing was capturing it — which is why
week 1's closes are gone forever and those 56 preregistered decisions can never be settled by their
own rule. It now captures every 10 minutes, so week 2 onward is safe.

## New data collected

Totals at 02:30: **57.0M rows across four databases**; `line_history` alone grew from 35.3M rows
to **50.0M / 9.74 GB** overnight.

| Source | Volume |
|---|---|
| Kalshi per-minute candles (bid/ask every minute, incl. no-trade minutes) | **4,003,489 rows** |
| Kalshi trades | 4,962,218 |
| Odds API (Sep 9→16 gap closed with already-paid credits) | 1,910,098 |
| Covers per-change line history | 1,914,688 |
| Polymarket per-minute prices | 28,906,853 |
| ESPN win probability (per play, wall-clock aligned) | 270,693 |
| Wayback point-in-time injury pages | 671 fetched of 18,239 indexed |
| Press-conference transcripts | 1,436 and climbing (32 channels) |
| Jev coach-speak signals | 270 (free-tier rate-limited) |
| Pinnacle forward capture (new, every 10 min) | 2,010 |
| ESPN team stats + FPI | 312,544 rows, **318 distinct metrics** |
| Advanced team-week features | 11,108 rows × 55 features |

## The weekly board works again

It did not, and the failure was silent: `weekly_board.py` rendered with **every section empty**.
Nothing was wrong with the board code — it reads `nfl_line_snapshots`, which the deleted app used to
feed, so its newest quotes were from 2026-09-03. Two fixes:

1. `scripts/line-history/oddsapi_to_snapshots.py` bridges the paid Odds API tape (11 books) into the
   table the board reads. Note `side` is the literal word `'home'`/`'away'` in `oddsapi_snapshots`
   but the full TEAM NAME in `nfl_line_snapshots` — mapping it wrong returns zero rows silently.
2. `game_lines` had gamedays for only the 16 completed 2026 games, so the board's date window
   matched nothing. All 510 remaining 2026 schedule dates backfilled from nflverse.

`docs/board/2026-week2.md` now renders the full slate. **Caveat:** the Odds API tape carries spreads
only, so the totals section is quoting Pinnacle alone — no shopping across books on totals until
another totals source is wired in.

**And the column that started all of this is fixed.** The spreads table printed a projected home
MARGIN under a heading that read "Consensus", next to a Pick column showing a betting LINE — so
`ATL +2.5` sat beside `-2.5` and read as a contradiction. On 2026-09-16 that was mistaken for a
mislabeled side, and a filter was written to suppress a row that was correct all along. The header
now reads **"Cons. margin"**.

## Known-broken, flagged not hidden

- **The week-1 prop result cannot be reproduced.** `model_probability` and `closing_line` are both
  empty in the surviving copy, and 442 of 443 props carry both Over and Under — so re-settling them
  returns ~50% mechanically regardless of skill. The conclusion stands as recorded; it is no longer
  checkable.
- **416 frozen 2026 feature vectors are premature.** I backfilled weeks 5–18 when the 2026
  team-week table was empty, so they carry 2025-only history, and the table is deliberately
  immutable. Fixing needs a version bump, not a patch. My error.
- **2026 is no longer a virgin holdout** for Kalshi microstructure — one test consumed part of it.

---

## What I would do next

1. **Restart the shadow-decision writer.** Highest value per unit effort. It is the only forward
   test that exists and it is currently dark.
2. **Re-measure line shopping on a second season** before treating −1.82% as settled.
3. **Stop trying to out-predict the closing line.** Fifteen tests, three independent confirmations,
   one overturned assumption. The market is efficient on every dimension measured here.
4. **Top up Vercel** if the coach-speak angle is worth pursuing — press conferences are the only
   timestamped availability source left for 2026, and the classifier is built and running, just
   rate-limited to a crawl on free credits.

## The honest bottom line

There is no demonstrated way to make money here yet. The most valuable output of the night is
negative: a cost model that says even perfect execution loses 1.82% per bet, and fifteen dead
hypotheses that no longer need re-testing. That is worth more than a false positive, which is what
this project has repeatedly produced and then lost.
