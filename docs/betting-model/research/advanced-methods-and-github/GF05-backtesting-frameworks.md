# GF05 — Backtesting frameworks: ledger / point-in-time / walk-forward patterns to replace Gridiron's 5-7 duplicate audit engines

Cloned and read (not just README) into `github/<owner>__<repo>` under this session's scratchpad. All read via `find`/`wc -l`/`Read` on the actual source, not docs.

## 1. pmorissette/bt — MIT, 2981 stars, last commit 2026-09-12 (today, actively maintained)

**What it actually does** (`bt/core.py`, 2247 lines; `bt/backtest.py`, 809 lines; `bt/algos.py`, 2610 lines):
- A `Node` tree (`bt/core.py:24-364`): every `Strategy` and `Security` is a node with `.value`, `.weight`, `.price`, lazily recomputed only when `root.stale` is set — an explicit dirty-flag cache invalidation pattern, not ad hoc recompute-everywhere.
- `StrategyBase` (subclass of `Node`) owns `outlays` (a DataFrame of capital deployed per child) and drives allocation top-down through the tree once per bar.
- `Backtest` class (`bt/backtest.py:123`) is the single entry point: takes a `Strategy` + a `data` DataFrame + `initial_capital` + a pluggable `commissions` cost model (a callable, or a `CostModel`/`SqrtCostModel`/`AlmgrenChrissCostModel` instance for nonlinear, volume/volatility-aware costs) and produces one `Result` object.
- Every `Backtest` deep-copies its `Strategy` so the same strategy object can be reused across multiple backtests without state leaking between runs — this is the single biggest structural difference from what a bolted-together audit script does.

**Adopt: borrow-idea.** The tree/Node dirty-flag design is overkill for Gridiron (no portfolio hierarchy), but the **single `Backtest` object per run, deep-copying its strategy, producing one `Result`** is the pattern to copy structurally.

**Gridiron attachment point:** the 5 independent CLV implementations over 4 different tables. Each currently computes and stores its own copy of "value" at different points; `bt`'s Node cache-invalidation shows the fix is not "compute CLV 5 times," it's "one Ledger node holds current value, lazily recomputed, and every consumer reads the same node" — i.e., one `clv_ledger` table populated once by one function, with everything else joining to it.

## 2. mementum/backtrader — GPL-3.0, 23,238 stars, last commit 2024-08-19 (14 months stale — the project is dormant, forks/backtrader2 are picking it up)

**What it actually does** (`backtrader/trade.py`, 311 lines; `backtrader/brokers/bbroker.py`, 1237 lines; `backtrader/cerebro.py`, 1716 lines):
- `Trade` (`trade.py:94`) is a single object representing the full lifecycle of a position from open to close, carrying `pnl` (gross) and `pnlcomm` (net of commission) as two parallel numbers, never conflated.
- `TradeHistory` (`trade.py:31`) is an `AutoOrderedDict` snapshot appended on every update — a full audit trail of every state transition (status, size, price, value, pnl, pnlcomm) plus the triggering event (order, size, price, commission), not just a final row.
- `bbroker.py`'s `BackBroker` is the sole owner of cash/margin/commission state; strategies never touch cash directly, they submit orders and the broker is the only path that mutates capital — a hard separation between "decision" and "ledger."

**Adopt: reference-only (license) / borrow-idea (design).** GPL-3.0 means literal code should not be ported into Gridiron's codebase; the *design* — one broker owns the ledger, trades carry gross and net PnL as separate fields with full history, not a single collapsed number — is free to imitate. Given the repo is dormant (14 months no commits), don't build a runtime dependency on it either way.

**Gridiron attachment point:** the CLV sign-convention disagreement across the 5 implementations. Backtrader's pattern (single broker as sole mutator, `pnl` vs `pnlcomm` always kept as two distinct, clearly-named fields) is the direct fix for tables that disagree on sign: define one ledger table with `raw_edge` and `edge_after_vig` as two named columns nothing else is allowed to shadow.

## 3. polakowo/vectorbt (the free/OSS line, not vectorbt.pro) — Apache-2.0 with Commons Clause (non-commercial-resale restriction; internal use at Gridiron is unaffected), 9068 stars, last commit 2026-08-02 (active)

**What it actually does** (`vectorbt/portfolio/logs.py`, 253 lines; `vectorbt/portfolio/base.py`, 5773 lines; `vectorbt/portfolio/nb.py`, 7013 lines):
- Every simulated order attempt — filled, ignored, *or rejected* — is written as one row into a fixed-dtype structured numpy array (`log_dt`), with a `status` (Filled/Ignored/Rejected) and a `status_info` reason code (e.g. `NoCashLong`). Confirmed by reading `logs.py:24-40`'s own doctest: `pf.logs` on a 100-bar/2-column sim returns `filled.count()`, `ignored.count()`, `rejected.count()` all queryable off the *same* log object.
- This is a genuinely different pattern from "log the trades you made": it logs the trades you *tried* to make and *why they didn't happen*, which is exactly what's missing from a point-estimate pipeline that silently drops bets that fail a filter.
- Records are `vectorbt.records.base.Records`-backed — a generic mapped-array abstraction reused for orders, trades, logs, and drawdowns alike, so there is exactly one "make a queryable event table" primitive in the whole codebase, not one per subsystem.

**Adopt: borrow-idea, and port the schema shape (not the numba internals — those are deeply coupled to vectorbt's own JIT dispatch machinery in `nb.py`, 7013 lines, and would take weeks to extract cleanly).**

**Gridiron attachment point:** this is the direct fix for the trial-registry/multiplicity-correction gap and for the fantasy weekly-learning cold-start silent no-op. A single `bet_attempts` log table with one row per (game, market, model-version) carrying `status ∈ {filled, rejected, no_edge}` and `status_reason` would (a) let a Holm/PBO correction be computed honestly over *everything that was tried*, not just what got logged as a bet, and (b) turn "heads is null week 1" from a silent no-op into a visible `status='cold_start_skip'` row instead of nothing.

## 4. martineastwood/penaltyblog — MIT, 220 stars, last commit 2026-09-10 (2 days ago, active)

**What it actually does** — this is the closest single-domain match to Gridiron (football-specific, betting-specific), and it is small enough to have read every line of the relevant modules:
- `penaltyblog/backtest/backtest.py` (163 lines): `Backtest(data, start_date, end_date)` iterates one calendar date at a time; for each date it constructs `lookback = df[df.date < date]` (strict `<`, confirmed at line 115) and `test = df[df.date == date]`, then hands both to a user `logic(ctx)` callback via a `Context` object. **The no-lookahead guarantee is structural, not a convention someone has to remember** — you cannot see today's or a future day's row inside `logic` because it was never sliced into `ctx.lookback`.
- `penaltyblog/backtest/account.py` (61 lines): a single `Account` class is the only thing that can `place_bet(odds, stake, outcome)`; it appends one dict per bet to `self.history` and appends the running bankroll to `self.tracker`. `results()` (in `backtest.py:132`) computes ROI, total bets, win %, max/min bankroll off that one `history` list — one ledger, one results function, full stop.
- Optional `trainer(ctx)` callback re-fits a model once per unique date using only `ctx.lookback`, then that fitted model is attached to `ctx.model` for every fixture on that date — a clean, explicit walk-forward refit hook.
- `penaltyblog/implied/implied.py` (444 lines): `calculate_implied()` dispatches to **seven** distinct, independently-implemented devig methods — `_multiplicative`, `_additive`, `_power` (Shin-family, solved via `scipy.optimize.minimize`), `_shin`, `_differential_margin_weighting`, `_odds_ratio`, `_logarithmic` — all behind one function signature, so comparing devig methods is a one-line change of a string argument, not a rewrite.

**Adopt: port.** Both the `Backtest`/`Account` pair and the `implied.py` devig dispatcher are small, dependency-light (pandas/numpy/scipy only), MIT-licensed, and directly address two named findings.

**Gridiron attachment points:**
1. Replace the 5-7 duplicate audit engines with one `Backtest`+`Account` pair modeled on this: single date-indexed loop with a *structural* `lookback < date` slice (not a WHERE clause someone can typo), one `Account.history` ledger table, one `results()` aggregator. This directly kills the "5 independent, disagreeing CLV implementations over four different tables" finding — there would be exactly one ledger table to disagree with.
2. Port `calculate_implied()` wholesale (or transliterate; it's ~250 lines of real logic once docstrings are stripped) into a `devig.py` module and run Gridiron's actual market prices through all seven methods to pick one with evidence, replacing the "one ad hoc approach" finding.

## 5. georgedouzas/sports-betting — MIT, 787 stars, last commit 2026-07-28 (active, current maintainer)

**What it actually does** (`src/sportsbet/evaluation/_base.py`, 550 lines; `src/sportsbet/evaluation/_model_selection.py`, 530 lines) — this is the most directly transferable of the five because it is explicitly a sports-betting backtest library, sklearn-native, and still maintained:
- **Odds column grammar, solving the exact identity/point-in-time problem Gridiron has** (`_base.py:44-69`, confirmed by reading `find_latest_odds_column`): every odds column is named `{provider}__{market}__{status}__{time}`, and a `STATUS_RANK` ordering plus `parse_event_time` lets the framework pick "the latest odds quote available as of a given snapshot" deterministically, from *many* candidate columns, without ad hoc string matching. This is a real point-in-time quote resolution mechanism — a structural answer to "12.4M-row Polymarket quote tape... essentially unused" and to the team/game identity matching mess in `team-codes.py`/`nfl-contract-key.js` (the grammar generalizes to `{source}__{game_id}__{status}__{time}` for entity resolution across ESPN/nflverse/odds books/Polymarket).
- `BaseBettor` (`_base.py:121`) is a proper `sklearn.BaseEstimator`/`ClassifierMixin`: `fit(X, Y, O)` / `predict_proba` / `bet(X, O)`. `bet()` (`_base.py:398-439`) computes `Y_proba_pred * O > 1` (positive expected value) directly, then for each group of `complementary_events` (e.g. home/draw/away must sum to 1) picks only the single highest-edge outcome per group — a built-in "don't bet all three mutually exclusive outcomes" guard Gridiron's teaser-leg correlation problem doesn't have an equivalent of.
- **`backtest()`** (`_model_selection.py:84-170`, read in full): the entire walk-forward harness is ~40 lines. It sorts by date, requires a `sklearn.model_selection.TimeSeriesSplit` (rejects anything else via `_check_time_series_cv`, `_model_selection.py:27-31` — you cannot accidentally pass a shuffled/random CV splitter), and for each fold calls `_fit_bet()` (`_model_selection.py:34-81`) which fits on `train_ind`, bets on `test_ind`, and returns one dict of results (yield %, ROI %, final cash, per-market breakdowns) keyed by `(Training start, Training end, Testing start, Testing end)`. Folds run in parallel via `joblib.Parallel`. One function, one results schema, no fold can see another fold's test data because `TimeSeriesSplit` enforces strictly increasing train windows.
- `BettorGridSearchCV` extends `sklearn.GridSearchCV` so hyperparameter search reuses the exact same `TimeSeriesSplit` walk-forward discipline — the same object type used for backtesting is used for tuning, so there is no separate "tuning uses a different split than backtesting" bug class.

**Adopt: port.** This is a maintained MIT sports-betting package built by someone who has already solved "walk-forward + point-in-time odds + multi-outcome constraint" for a sport with the same market structure (1X2 / over-under) Gridiron cares about. Direct dependency (`pip install sports-betting`) is plausible for the evaluation module alone, or transliterate the ~1100 lines of `_base.py` + `_model_selection.py` into Gridiron's stack.

**Gridiron attachment points:**
1. `TimeSeriesSplit`-gated `backtest()` replaces the ad hoc train/test splitting implicit in the 5-7 duplicate audit engines — one function, one results schema, structurally impossible to leak future data into a fold.
2. The `{provider}__{market}__{status}__{time}` odds grammar is a direct, generalizable answer to the "5 independent CLV implementations over 4 different tables with different math and sign conventions" finding: store one long odds table with that column grammar, and CLV becomes "closing row minus opening row for the same (game, market)" computed once.
3. `complementary_events`-aware `bet()` (never betting all mutually exclusive outcomes in one group) is a direct, minimal first step toward the missing correlation/copula model for teaser legs and same-game markets — it doesn't model dependence, but it removes the worst-case "betting against yourself" failure mode for free.

## What NOT to adopt
- Don't take backtrader as a runtime dependency (GPL-3.0, dormant 14 months) — reference its design only.
- Don't port vectorbt's numba-JIT simulation core (`portfolio/nb.py`, 7013 lines) — it's built around vectorbt's own dispatch/typing machinery (`_typing.py`, `dispatch.py`) and extracting the log-schema idea cleanly is a week+ job for a piece Gridiron doesn't need at that scale (Gridiron is dozens-of-games-per-week, not thousands-of-assets-per-tick).
- Don't build a 6th bespoke audit engine that "combines the best of all five" — every framework read here converges on exactly one canonical ledger/results object per backtest run; the fix is subtraction (delete 4-6 of Gridiron's engines), not another addition.
