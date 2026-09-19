# The historical verdict — one leaderboard, run against real data

Giant Plan Step 2e. Branch `unify-2026-09-12-historical`. Built on stage 1
(`docs/evidence/historical/STAGE_1_RESULTS.md`, `STAGE_2_RESULTS.md` for the
model-side fixes; the sweep-items commit for the betting-side ones) and
stage 2 (`docs/evidence/2026-09-13/STAGE_2_PURGED_EVALUATION.md` — purged
walk-forward, the real trial registry, Geyer effective-N, deflated Sharpe,
CSCV/PBO). Full numbers regenerate with `node scripts/run-historical-leaderboard.mjs`
(reads `server/data.sqlite` **read-only**; writes only to a scratch database);
raw JSON in `docs/evidence/2026-09-13/historical-leaderboard-report.json`.

**The one-line verdict: nothing in the stable clears the bar, and this time
the error bars are on every number.** That is the outcome the plan itself
called the most likely one, and it is what real data says.

---

## The constraint every row below is read against

This is the first stage of this project's 2026-09-12 sweep whose numbers come
from `server/data.sqlite` directly — every earlier report in this same sweep
(`MODEL_BUILD_REPORT.md`, `BETTING_MODEL_REPORT.md`) was forbidden to open it
and said so on every page. That restriction is **lifted for reads only** for
this stage. Every number below was read with `node:sqlite`'s `{ readOnly:
true }`, verified directly in this session, never through a script that
calls `runMigrations()` against that file (several of this project's own
report scripts do that on import, which is a write — see "What this report
could not do," below, for exactly which candidates that rules out).

One important consequence: **stage 1's corrected inputs are code and
migration-file fixes that have not been applied to `server/data.sqlite`.**
The live process has been capturing real games under the *old* code all
night. Every real number below — the audit registry, the ensemble fit
artifacts, the production decision board — is the historical record as the
old code actually produced it, not a re-simulated backtest under the opener/
neutral-site/open-spread-corruption fixes. Re-running the real history under
the corrected inputs would require either applying stage 1's migrations to
the live database (forbidden) or exporting real rows out for reprocessing
(not attempted here, and not obviously safer). This is a scope limit,
disclosed rather than glossed over: **this report is the stable's honest
track record to date, not a corrected re-backtest.**

---

## The leaderboard

| # | Candidate | Real n | Point estimate | Error bar / significance | is_market_identity | Verdict |
|---|---|---:|---|---|:---:|---|
| 1 | **Incumbent raw-blend ensemble** (21 original spread components) | 15,096 real closing lines (2026-08-27 commit `73f930f`) | 0 of 21 components clear the promotion gate | Individual per-component statistic not reconstructable (see gaps below); family-level ablation proxy only | n/a | **No real edge ever demonstrated.** |
| 1b | — candidate additions (`unified-all-inputs` v1/v2/v3-roster) | 4 real seasons × 4 strategies | Directionally positive in 3 of 4 periods each | **PBO = 0.167** (CSCV, real matrix) — but mechanical: 3 of 4 strategies are near-duplicates that dominate the baseline in most periods regardless of skill | n/a | **Not a real robustness result; too correlated and too few periods to trust.** |
| 2 | **Market-residual blend — the mode production actually serves** | 26,288 real component-cutoff rows (848 fit artifacts, every one ever persisted) + 16 real production decisions | 0 / 26,288 rows ever passed the residual gate. 16 / 16 real decisions: edge = 0.0000, 100% abstained (`calibration_not_proven`) | Not a sampled proportion — a closed-form consequence of the gate never opening. No bootstrap CI applies to "always." | **TRUE, 100% of the time this blend has ever been fit or served** | **This is not a model result. It is the market, exactly, every single time, and production has never once acted on it.** |
| 3 | **Joint scoring model / forecast-combination (tonight's betting-model build)** | **0** | No real trial exists | n/a — nothing to correct | n/a | **Untested, not merely negative.** Both were measured only on a synthetic fixture by their own authors' own reports; see "What this report could not do." |
| 4 | **Execution / teaser strategies** — best single real trial | 57 real bets (2024–25 subset) | 33-24, 57.89%, Sharpe 0.1117 | **DSR = 0.35** against 31.78 effective real looks (Geyer τ=1.64 over 52 real scored trials) | n/a (no market-residual dependency) | **~1-in-3 odds this is skill, not the best of many looks. Below even money.** |
| 4b | — the *same hypothesis*, completed sample | **242 real bets (five held-out seasons, 2021–2025)** | **117-125, 48.35%, z = −1.26** | Reverses sign from 4; not individually significant either way | n/a | **The nominal "win" in row 4 was an early, partial look. The finished test loses money.** |
| 4c | — team-trend totals, full real sample | 194 real bets (2016–2025) | **85-109, 43.81%**, z = **−2.39** | Individually significant **against** the strategy, uncorrected for the registry's own multiplicity (stage 2's τ/effective-N already discounts this look in aggregate) | n/a | **A real, well-powered, losing result.** |
| 4d | — CLV/line-movement lean signal, 5 real seasons | 915 real games (2017–2021) | 468-447, z = 0.69, p = 0.49 | Not significant | n/a | **Coin flip.** |
| 4e | — line-shopping (routing to the best real book) | 80 real routed bets | +1.01pp win rate vs. the worst book | n too small for a real CI; directionally the most defensible number in the whole registry because it requires predicting nothing, only capturing a price that already existed | n/a | **The one candidate that isn't trying to forecast anything — worth keeping, not worth calling proven.** |
| 4f | — actual accepted/placed executions | **0 settled, ever** (1 open, unsettled, paper teaser dated today) | n/a | n/a | n/a | **There is no real execution track record to grade, positive or negative.** |

Rows 1b/4a–f are the real detail behind rows 1 and 4; the plan asked for one
table, and the detail is what makes the top-level verdict for those two rows
honest rather than a single cherry-pickable number.

### The deflated-Sharpe correction, applied to the full real set (not a subset)

Stage 2's own script (`run-purged-evaluation.mjs`) computed row 4's DSR from
**2** of the 5 real `audit_registry` rows that carry a reconstructable bet
ledger (ids 1 and 14), hand-transcribed from prose. Reading every row's own
`detail_json` directly and generically (this stage's
`run-historical-leaderboard.mjs`) finds three more real, sealed trials that
belong in the same cross-section — ids 9, 13 and 15 — and one, id 1, whose
prose-cited 36-48 split does not actually appear anywhere in its own
`detail_json` (`{"simulator_mae":11.28,"market_mae":9.37}` — no win/loss
field at all) and is excluded here rather than carried forward unverified.

| | Stage 2 (hand-picked, n=13 bet-ledger trials) | Stage 3 (every real bet-ledger row, n=15) |
|---|---:|---:|
| Best observed trial | audit_registry#14, Sharpe 0.1117 | audit_registry#14, Sharpe 0.1117 (unchanged — still the best) |
| Sharpe std across trials | 0.0863 | 0.0784 |
| SR0 (expected best-of-31.78 looks, under the null) | 0.1809 | 0.1645 |
| **DSR** | 0.305 | **0.349** |

The headline number moves from 0.305 to 0.349 — still **under even odds**,
still the same conclusion (the deflated benchmark and the best real result
are close enough together that this project's real history cannot
distinguish "real skill" from "the best of ~32 effectively-independent
looks"), now computed on the complete real set instead of two hand-picked
rows. The two added losing trials (13, 15) do not move DSR because DSR is a
best-of-N statistic — but they are exactly the additional real information
row 4's plain-language verdict needed, and the multiplicity math with only
2 inputs never showed them.

---

## is_market_identity — reproduced directly, independent of u2

Item 17's neighbor (u2-market-identity, branch `unify-2026-09-12-u2-market-identity`)
had not merged into this worktree at the time of this stage, so this stage
reproduced its claim from scratch, directly against real data, rather than
trusting the commit message:

```
real fit artifacts ever persisted:        848
component-cutoff rows across all of them:  26,288
residual_gate_passed = true, anywhere:     0
residual_weight > 0, anywhere:             0
```

**Independent confirmation, exact match to u2's own count (848 / 26,288 / 0).**
`market_residual` — the blend mode production's auto-pick board runs — has
returned the market line by arithmetic at **every cutoff this system has
ever fit**, with no exception. The real production decision board
(`nfl_pick_decisions`, 16 rows, the only rows that table has ever held)
confirms it from the other side: `edge = 0.0000` on all 16, 100% abstained.

Any row in this leaderboard tagged `is_market_identity: true` — row 2, in
full — should be read as *"this is the market, not a forecast,"* not as
*"this forecast happens to be small."* Three independent instruments inside
this project's own history now agree on this (u2's branch, this stage's
direct reproduction, and `MODEL_BUILD_REPORT.md` build 1's eigendecomposition
finding the identical `blend = 0 + 1·market`, R² = 1, from a completely
different direction).

---

## Item 17 — the declared CLV reference book set

Using `clv-core.js#referenceBookQuotes(quotes, { executionBook })` — the
mechanism tonight's audit-consolidation stage 3 built for exactly this —
this stage declares the reference set explicitly rather than leaving
`nfl-execution-clv.js`'s `DEFAULT_CLOSING_BOOKS = null` (every book,
including whichever one a position was accepted at) as the silent default:

- **Full real tape book universe** (`nfl_quote_tape`, distinct
  `bookmaker_key`, all real): 30 books (barstool, betmgm, betonlineag,
  betrivers, betus, bodog, bookmaker, bovada, caesars, circasports,
  draftkings, everygame, fanatics, fanduel, foxbet, gtbets, heritage,
  intertops, lowvig, mybookieag, pinnacle, pointsbetus, sportsbetting,
  sugarhouse, superbook, twinspires, unibet, unibet_us, williamhill_us,
  wynnbet).
- **The one real accepted/paper position's execution book:** `draftkings`
  (`nfl_teaser_executions`, id 1).
- **Declared reference set for CLV grading of that position (and the
  policy going forward): the other 29 books.** Excluding the execution book
  is the default `clv-core.js` recommends for any *new* caller for exactly
  the reason its own docstring gives — grading a position against a close
  that includes its own quote biases the measured CLV toward zero.

There is nothing yet to grade under this declaration — see item 18 — so this
is a **policy commitment for the next real execution**, not a number that
changes today's leaderboard.

---

## Item 18 — can pre-September-2026 execution history be included?

**Decision: scope it out, and the reason is stronger than a book-count
confound — there is nothing real to join.**

Checked directly, real, read-only:

| Real ledger | Rows |
|---|---:|
| `nfl_execution_opportunities` | **0** |
| `nfl_execution_log` | **0** |
| `nfl_bet_log` | **0** |
| `nfl_replay_bets` | **0** |
| `forward_picks` | **0** |
| `nfl_teaser_executions` | 1 (`mode='paper'`, `status='open'`, games kick off **today**, 2026-09-13 — unsettled) |
| `shadow_decisions` | 189 (128 abstain, 61 observe; only 8 ever settled — all 2026, this season only) |

A tolerance-window join needs real rows on both sides of the window. Before
September 2026 there are **zero** settled accepted positions of any kind —
not thin coverage, none. The book-concentration question this item was
framed around is real and worth recording anyway, because it explains *why*
a genuine execution ledger was never built out before this month:

- This stage's own reproducible grouping (`event_id, market` over the real
  `nfl_line_snapshots` table, pre-2026-09-01 rows only): **6,732 groups**,
  **0** with only one book at this coarse (whole game+market) grain, mean
  capture span **12.11 days**.
- That 12.11-day figure lands in the same neighborhood as the 12.8-day
  figure this item was framed around, which was almost certainly computed
  at a **finer** grain (a specific side/line/instant, not "ever quoted by
  ≥1 book at any point for this game+market") — the two are consistent in
  order of magnitude, not the same measurement, and this report does not
  claim to have reproduced the other one exactly. Both readings say the same
  thing at different resolutions: **real multi-book, simultaneous, same-
  contract capture depth before this month is thin and inconsistent.**

Given zero settled real executions exist to join against any book set, a
tolerance-window join has nothing to widen a window around. **Scope
pre-September-2026 out of any execution-strategy CLV comparison, explicitly,
for this reason** — and treat the 189 shadow decisions and the one open
teaser as the start of a real ledger going forward, not as history.

---

## What this report could not do, and why (not glossed over)

**Rows 1 and 3 cannot be re-scored against real history without breaking a
safety rule.** `scripts/ensemble-rank-report.mjs`,
`scripts/forecast-combination-report.mjs`, `scripts/joint-score-report.mjs`
and `scripts/governed-reevaluation.mjs` — the exact tools
`MODEL_BUILD_REPORT.md` names as "the commands that would answer the real
questions" — each call `runMigrations()` on import against whatever
`GRIDIRON_DB_PATH` points to. `server/data.sqlite` is still 11 migrations
behind this branch (`035_alt_spread_capture` is its newest applied
migration; this branch's newest is `046`). Pointing any of those scripts at
the real file, even to answer a real question, means applying pending
migrations to a live database a real capture process is writing into right
now — exactly what safety rule 2 forbids, regardless of how good the
question is. This is why rows 1 and 3 are graded on the registry's real,
already-persisted artifacts (`nfl_ensemble_fit_artifacts`, `audit_registry`)
rather than a fresh real-data run of tonight's new instruments: those
artifacts are real and read-only-safe; running the new report scripts
against the same file is not. **The honest state of tonight's joint-scoring
and forecast-combination builds remains: measured only on a synthetic
fixture, by their own authors' own admission, zero real evaluation.**
Answering rows 1/3 for real requires a human, a quiesced copy of
`server/data.sqlite`, and `GRIDIRON_DB_PATH` pointed at that copy — the same
recommendation every report in tonight's sweep has made and none could act
on.

**The individual per-component statistic behind "0 of 21" does not survive
anywhere** (repo, git history, or the live database) — stage 2 already
found this and it is unchanged here; each of the 21 is scored with a real
family-level ablation proxy, flagged `individual_value_reconstructable:
false`, and excluded from any Sharpe cross-section (no bet ledger exists for
it).

**Segment/bucket combinations below `nfl-replay.js`'s `minBets` threshold**
are never logged by `analyzeErrors()` in any historical run and are not
reconstructed here either — the search space and the real threshold rule
are registered; the specific dropped attempts are not.

**The PBO/CSCV estimate (row 1b) is a demonstration on genuine data, not a
high-power estimate** — unchanged from stage 2's own caveat: three of the
four real strategies are near-duplicates, so its low value is largely
mechanical.

---

## Plain-language verdict

Every candidate this stable currently holds was checked against its own
real, historical track record, on one protocol, with one multiplicity
correction, and **nothing clears the bar**:

- The **raw-blend ensemble** has never had a single component demonstrate
  real, held-out value against a real closing line, at any point in this
  project's history (0 of 21, real, 15,096 lines).
- The **production blend** does not have a track record to evaluate,
  because it has never produced an opinion independent of the market — not
  once, in 848 real fits and 16 real decisions. Grading its "accuracy"
  would be grading the market's own accuracy under a different name.
- The **newest models** (joint scoring, forecast-combination) have no real
  evaluation at all to report, by their own authors' own honest accounting,
  and this stage could not produce one without breaking a safety rule that
  exists precisely because a live capture is running right now.
- The **execution/teaser stable**'s single best-looking real result is a
  partial, superseded look at a hypothesis whose completed real test loses
  money, sitting inside a registry whose own effective-N correction already
  says the best of ~32 real looks lands at roughly a coin flip's worth of
  confidence that it reflects skill (DSR 0.35) — and there is no real,
  settled accepted-execution history at all, before or (yet) after
  September 2026, to check any of it against with real money.

**This is the outcome the plan itself flagged as most likely, and it is a
completely valid and valuable thing to have confirmed: zero edge against the
close, now with real error bars on every number instead of a synthetic
fixture's.** The one thing in this entire stable worth keeping without
qualification is row 4e — routing to the best available real price — because
it is the one candidate that never had to predict anything to be worth
something.

---

## Reproduce

```bash
export SCHEDULER_DISABLED=1
export NODE_OPTIONS='--import ./test/offline-guard.mjs'
GRIDIRON_DB_PATH=/tmp/leaderboard-$$.sqlite node scripts/run-historical-leaderboard.mjs
npm test    # 1931 tests, 1891 pass, 1 fail (pre-existing, see below), 39 skipped
npm run lint         # clean, 657 files
npx tsc --noEmit     # clean
```

The one failure, `test/nfl-execution-pipeline.test.js:62`
(`resolveQuoteBasis: prefers the real multi-book quote tape...`), is the
same pre-existing, date-boundary-sensitive failure independently confirmed
on the unmodified base branch by every prior stage of tonight's sweep
(`GIANT_PLAN_BUILD_REPORT.md`, `MODEL_BUILD_REPORT.md`,
`BETTING_MODEL_REPORT.md`) — unrelated to anything in this stage, not fixed
here, out of scope for the same reason it was out of scope for all of them.

`node scripts/run-historical-leaderboard.mjs` never opens
`server/data.sqlite` for anything but `{ readOnly: true }` reads; the
registry backfill it runs first (`scripts/backfill-historical-trial-registry.mjs`,
unchanged from stage 2) writes only to the scratch `GRIDIRON_DB_PATH`, and
refuses to run against anything that isn't obviously a temp path.
