# Chunk 2/21 — Scoring notes (F03 devig, F04 CLV unification, F05 bitemporal PIT)

Verified directly against fantasy-football-dashboard (read-only, grep/read only, no edits):

- Confirmed `server/services/nfl-neural-replay.js:24-27` still has the local naive
  `implied`/`noVig` pair (proportional split), not `shinNoVig` from nfl-devig.js —
  F03-fix-2's claim stands.
- Confirmed `server/services/nfl-execution-clv.js:59` — `DEFAULT_CLOSING_BOOKS = null`,
  used at lines 99 and 232 as the default reference-book set, with no execution-book
  exclusion visible in that file — F04-F2's claim stands.
- Confirmed `server/services/shadow-ledger.js` settlement query selects only
  `spread,total,team_score,opp_score` from `game_lines` (no `closing_spread`), and its
  inline CLV at lines ~77-91 grades against that live `game.spread` column — F04-F3's
  claim stands; this is a live, currently-active bug path (shadow-ledger runs continuously
  during the season).
- Confirmed `server/services/book-feeds.js` `captureBookFeeds()`: `const at = new
  Date().toISOString()` is computed once, after `await Promise.all(...)` resolves all
  provider fetches, and passed to `ingestQuoteSnapshot(...,{ requestedAt: at, ... })` with
  no `receivedAt` argument at all — F05-F1's claim stands exactly as described.

## Scoring rationale (evidence / applicability / value_per_cost, 1-5; skeptical-statistician
lens: evidence 5 = replicated peer-reviewed OOS vs real benchmark, 3 = single paper, 2 =
practitioner/repo README, 1 = theory/hype; penalize anything needing more data/seasons than
Gridiron has)

**F03-fix-2** (neural-replay noVig swap): grep-confirmed live defect, trivial safe fix,
but the module explicitly never gates production authority — low materiality, high
certainty, near-zero cost. BUILD.

**F03-fix-3** (add power devig method): well-corroborated across 3 independent sources
that power ≥ Shin/multiplicative in general, but NFL-specific applicability of Clarke et
al. (2017) unconfirmed (paywalled, could not verify NFL was one of the 3 sports tested).
Cheap, additive-only change (default not flipped) — safe to build now, let F03-new-1 decide
whether it should ever become default. BUILD.

**F03-new-1** (empirical devig validation harness, own NFL data): directly answers the
open question F03-fix-3 depends on, reuses existing `nfl-replay.js` walk-forward
infrastructure and idle Polymarket/`nfl_line_snapshots` data — no new data acquisition, no
paid API. This is the correct way to earn a default-method change rather than importing an
unverified-for-NFL literature result. BUILD.

**F03-new-2** (single-sided vig estimation via historical book overround): correctly
labeled weak evidence by its own researcher; addresses a narrow edge case (missing
opposite-side quotes) for a small, uncertain accuracy gain at days of cost. LATER.

**F03-new-3** (devig provenance tagging / migration columns): weak evidence but mechanism
is simple and the insurance is cheap (migration only, hours). Directly forecloses the exact
"silent baseline reinterpretation" risk F03-fix-1 found by accident via grep, not by any
existing safeguard. BUILD.

**F04-F1** (canonical computeClv() module): grep-confirmed 6 divergent implementations
across nfl-clv.js, nfl-execution-clv.js, nfl-execution-clv-downsize.js, nfl-prop-clv.js,
forward-ledger.js, shadow-ledger.js; the exact consolidation pattern is already proven in
this codebase by nfl-devig.js's own header (which lists the 5 duplicated proportional
implementations it replaced). High confidence, high leverage, real days-scale refactor.
BUILD.

**F04-F2** (declare reference book set excluding execution book): grep-confirmed live bug
(`DEFAULT_CLOSING_BOOKS = null`); mechanism (execution book leaking into its own benchmark,
biasing CLV toward zero) is basic and well-supported (Buchdahl, Saumarez). Hours-scale fix,
high value. BUILD.

**F04-F3** (freeze shadow-ledger to closing_spread): grep-confirmed live, currently-active
bug (shadow-ledger grades against a column `syncCurrentLines` can overwrite post-kickoff).
forward-ledger.js already has the correct pattern to copy. Hours-scale, unambiguous
correctness fix. BUILD.

**F04-N1** (decorrelation-aware ensemble objective): single paper (Hubáček & Šír 2020,
arXiv, not peer-reviewed venue-confirmed) but methodologically strong — Theorem 4.1 is a
formal proof, and the real-data soccer experiment shows profit and accuracy moving in
*opposite* directions as correlation-with-market is reduced, which is a striking, directly
relevant result given tonight's own finding that Gridiron's ensemble is ~0.68+0.632·market
(a de facto shrinkage-to-market estimator). Not shown to generalize from soccer to NFL
spreads (author's own stated limitation). The proposed plan is appropriately conservative:
add an observability metric first, backtest before ever touching the live blend. This is
the single most interesting research item in this chunk relative to Nick's actual "zero
edge" problem, but it needs the backtest gate before it can be trusted. TEST-FIRST.

**F04-N2** (devig bake-off incl. proportional/Shin/power/additive): substantially
duplicates F03-new-1's harness, and — worse — proposes building a separate "additive"
method that F03's own research independently proved is mathematically identical to Shin
for every two-outcome market (which is 100% of Gridiron's NFL markets, confirmed by two
independent sources in F03's notes). Building it would just be F03-new-3's own
"do not do" item recreated by a different research thread. REJECT (subsume into
F03-new-1; do not build the additive arm at all).

**F04-N3** (PBO / deflated-Sharpe trial registry): moderate evidence — Bailey et al.'s
demonstration is a generic null-skill illustration (random walks, a direct-mail worked
example), not an NFL-specific validation, but the method itself (combinatorial CV + Sharpe
deflation by trial count) is standard and directly answerable using Gridiron's own already-
run 21-model historical search and existing 2021-25 backtest splits. This protects the one
number Nick already treats as load-bearing (the 21-model, zero-materiality-gate result)
from being undone by a 22nd model that only looks good from selection. BUILD.

**F05-F1** (receipt-clock fix, book-feeds.js): directly verified myself via grep — `at` is
captured post-Promise.all (a genuine receipt time) but only ever passed as `requestedAt`,
never `receivedAt`, so this feed's rows are permanently mislabeled
`legacy_request_time_only` and excluded from `received_by_cutoff`. This is the ONLY quote
feed currently running (paid Odds API credits are gone per project state), the fix is a
~4-line diff with the schema already in place (migration 032), and it does not touch the
live DB tonight (this candidate is a plan, not an applied change). Highest-confidence,
highest-urgency, lowest-cost item in the whole chunk. BUILD.

**F05-F2** (thread receivedAt through nfl-quote-tape.js's unwrap() + add columns to
nfl_quote_tape): same defect class as F05-F1, verified plausible from the notes' line
citations (not independently re-grepped this pass), but the functions it would make
trustworthy — `quoteSurface`, `closingQuotes`, `bestExecutableQuote` — are stated by the
researcher to currently have zero callers anywhere in the codebase. Fixing correctness in
dead code paths is real but not urgent; a schema migration + rewrite is days-scale for
code nothing calls yet. LATER (do this when/if those functions actually get wired into
execution or backtest code — flag it as a prerequisite at that time, not now).

**F05-F3** (per-provider receipt timestamps in captureBookFeeds): researcher's own
characterization — understates freshness for fast providers, does not create a look-ahead
bias (the dangerous direction), "worth doing alongside F05-F1" but modest on its own.
LATER.

**F05-F4** (CI guardrail against omitted receivedAt): cheap (hours), directly closes the
structural hole that let F05-F1 happen silently in the first place (a null default that
downgrades silently rather than erroring). Good regression insurance to pair with F05-F1.
BUILD.
