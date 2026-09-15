# Gridiron HQ — Master Plan v2 (research-informed)
**2026-09-12, overnight.** Supersedes the v1 plan sent earlier tonight. Built from: the verified
audit-system review (22 gaps), 20+ completed full-codebase subsystem reads, and a 121-agent
research sweep (56 research/GitHub agents, 90 repos surveyed / 63 cloned, 158 sources read in
full, 315 candidates independently judged). One correction the research made to tonight's earlier
claims, stated plainly: **the drive simulator's "inverted kneel rule" does not hold up.** A direct
trace of `kneelDecision()` found it logically correct. Only the *timeout-decrement* half of that
finding is real — the decision is computed but never written back, so a leading team is never
actually threatened by the defense's remaining timeouts. The plan below reflects that correction.

---

## What changed from v1

- Security items (orphaned tunnel, unauthenticated Anthropic spend, forgeable teaser settlement)
  are unchanged and still not yet built — they carry forward as-is.
- The drive-simulator section is narrower than v1 claimed: 3 confirmed mechanical bugs, not 6.
  The away-team-spread-sign bug and the flat 7-point home-field lump are both independently
  re-confirmed at the highest confidence score in the whole research batch. The kneel-rule
  "inversion" is retracted; the OT gap is narrower than stated (only the season-length remainder
  simulator lacks OT — the single-game simulator already has real overtime logic).
- Every fix below now carries a literature-backed mechanism and, where one exists, a real
  GitHub reference implementation, not just a description of the bug.
- A genuine ADD list now exists, gated to build only after the FIX list lands, per your own
  stated sequencing.

---

## Phase 0 — Security (unchanged from v1, still not built, do first)

1. Kill the orphaned `cloudflared` process; restart `scripts/tunnel.mjs`; fix `launcher.mjs:89`
   to health-check the registrar, not just the child process.
2. Gate `POST /explain/page` (`betting-hub.js:878`) and `POST /scout/:id` (`edge.js:259`) behind
   the same permission check their sibling routes already use.
3. Auth-gate and fix `settleTeaserExecution` (`nfl-teaser-execution.js:307-360`) to look up the
   real score from `game_lines` instead of trusting the request body.

## Phase 1 — Urgent, time-sensitive (do before Sunday's games settle)

4. **Fix the live receipt-clock bug right now.** `book-feeds.js:390-419` computes a genuine
   post-response timestamp but passes it in as `requestedAt`, never as `receivedAt` — so every
   batch this feed has ever written, **including this weekend's live Week 1 captures**, is
   permanently mislabeled `legacy_request_time_only` and discarded by the T-60 packet filter.
   One-line-shaped fix: capture the timestamp after the `Promise.all`, pass it as `receivedAt`
   with `receiptClockSource: 'response_completion'`. Exit test: the next live batch carries the
   real label — verify before Sunday's games settle, not after.

## Phase 2 — Fantasy (cheapest, highest-confidence, do first per your standing priority)

5. **Cross-season transfer for the ensemble heads.** `priorScores()` in `player-week-engine.js:123-126`
   only queries `season=? AND week<?`, never crossing a season boundary — so every Week-1 head is
   null. Fix: fall back to the same player's prior-season weeks using the season-decay weight
   already shipped in `projections.js` (`SEASON_WEIGHT={0:1,1:0.55,2:0.28,else:0.12}`). Hours.
6. **Structural fallback so Week 1 stops silently discarding itself.** `weekly-learning.js:69`
   does `if (!engine?.heads) continue` — zero forward snapshots have ever been captured for any
   season. Mirror the fallback pattern already shipped in `player-head-registry.js:55` (degrade
   to structural, never null) and capture a `mode='cold_start_structural_only'` row instead of
   skipping. Hours.
7. **Report curve source and disagreement in every dynasty-value response.** Purely additive —
   `dynastyAgeAdjustment()` already returns the right shape; just add `curve_source`,
   `sample_size`, `cross_method_disagreement` fields. The single best value-per-cost item found
   all night. Hours.
8. **Empirical replacement-level baseline for handcuff valuation**, replacing a hand-tuned
   constant table whose own code comment calls it "a monotone prior, not production
   coefficients" — data (`player_week_usage`, `nfl_snaps`, `nfl_depth`) already exists to fit it
   the nflWAR way. Hours.

## Phase 3 — Simulation (corrected scope — 3 confirmed bugs, not 6)

9. **Fix the away-team win-probability sign bug.** `nfl-sim-policy.js` computes `lead` flipped
   for the offense but passes the un-flipped `spread` into `liveWinProbability()`, whose
   docstring requires both in the home-team frame — every away-possession policy call (kneel,
   onside, 4th-down, variance) is mispriced. Port nflfastR's one-line
   `posteam_spread = home ? spread : -spread` transform. Hours. Highest-confidence item in the
   whole simulation bucket (3/3 independent verification).
10. **Remove the flat 7-point post-OT home-field lump.** `nfl-drive-sim.js`'s single Bernoulli
    +7 draw, applied after the game is already final, corrupts the score distribution exactly at
    the key number the whole betting stack cares about. Fold home-field advantage into a
    per-drive/per-play rate instead, per fivethirtyeight/nfl-elo-game's architecture. Hours to
    relocate, days to thread properly into per-play rates.
11. **Wire the timeout decrement that's computed but never applied.** `timeoutPolicy()`'s
    decision at `nfl-drive-sim.js:475` is calculated but never written back to
    `timeouts[possession]`, so a leading team is never actually threatened by the defense's
    remaining timeouts. This is the one real half of the earlier "kneel rule" finding — the
    kneel logic itself checked out correct on direct trace and should not be touched without a
    concrete game-state failure to point at. Hours.

## Phase 4 — Betting-model (numeric correctness, all hours-scale)

12. **Closed-form ridge fix for team-strength opponent-blindness.** `blendedTeamRating`'s
    in-season mean is provably opponent-blind by construction (two teams with the same raw
    average margin against different schedules get identical ratings, checkable directly, not a
    claim). Glickman & Stern's own closed-form paired-comparison ridge estimator
    (`θ̂=(X'X+λI)⁻¹(X'y+λγ)`) fixes it in a single matrix solve — no MCMC, no new dependency.
    The single cheapest, highest-confidence item in the entire betting-model bucket.
13. **Split-conformal quantile replacing the pooled-Gaussian win-probability read.**
    `nfl-market.js:435` uses one global SD for every game; replace with a split-conformal
    quantile of the residuals the file already computes. About 15 lines.
14. **Weight the existing residual bootstrap by recency**, since it currently draws uniformly
    from 1999-2024 pooled residuals while the same file already has a fitted decay parameter it
    ignores. Surgical fix to code that already has the right shape.
15. **Extend the existing two-outcome devig method** (`nfl-devig.js`) to replace
    `prediction-markets.js`'s `exchangeVsBook()`, which uses a normal-CDF approximation its own
    docstring admits is not a real no-vig price.
16. **Wire the already-computed per-team wind/EPA delta into `weather_total`.** `nfl-features.js`
    computes real per-team dome/wind EPA deltas that `nfl-ensemble.js` currently throws away in
    favor of one flat `-2.4` applied identically to every team. Cheapest, best-evidenced fix in
    the weather bucket.
17. **Fix the second, unaudited game-key join.** `polymarket-lines.js:251-252` builds its own raw
    string key straight from `espn_line_moves`, bypassing the tested `eventKey()`/
    `canonicalTeamCode()` resolver entirely. Route it through the existing tested function.

## Phase 5 — Audit-system consolidation (bigger, days-scale, the actual "wire it all together")

18. **Delete the four independent CLV calculators into one.** Confirmed by direct code read:
    `nfl-clv.js` inverts sign for totals-Under, `nfl-execution-clv.js` assumes pre-inverted
    lines and does not invert, `nfl-prop-clv.js` stores a probability-delta instead of points.
    One module, one signed-points function, one fair-probability function, one `clv_grades`
    table with a market column. **This is the precondition for trusting any other CLV number in
    this plan — single highest-leverage item on the whole list.**
19. **Build the append-only trial registry** (`research_studies`/`research_trials`/
    `research_trial_corrections`), promoting the existing 5 ad-hoc per-lab preregistration
    files into one queryable table with a DB-enforced `scored_at >= declared_at` trigger, closing
    the "re-run until favorable" loophole. Gives the 21-model historical search a real
    `effective_n_trials` denominator for the first time.
20. Route decisions through the append-only tape instead of the self-overwriting upsert, and
    guard the shadow ledger against post-kickoff capture (both carried forward unchanged from v1).

---

## The ADD list — build only after Phase 0–5 land

Fantasy first, cheapest first, per your own stated sequencing:

- **One-time historical player-season import from nflverse** — the explicit prerequisite every
  other fantasy-modeling addition below depends on.
- **Depth-chart usage-propagation graph** (2-hop, scheme-weighted) — every input table already
  exists; the literature search found *no* credible open-source model to port, which means this
  is genuinely open territory, not a gap in something that already exists elsewhere.
- **Empirical, data-fit dynasty aging curve** replacing a hand-typed literature table (QB
  currently gets a flat 1.0 "for lack of a published curve" — an absence, not a fit), once the
  historical import lands.
- **Hierarchical Bayesian props model** for touchdowns and yardage — needs a `pymc`/`numpyro`
  toolchain Gridiron doesn't have yet; this is the one genuinely new piece of infrastructure the
  whole plan requires, and it should ship after the walk-forward suite it will be gated behind.
- **Score-driven dynamic bivariate Poisson/Skellam joint scoring model** — the strongest single
  empirical result in the entire research batch (beats a full state-space model at 1/360th the
  compute) and doubles as the real mechanism for same-game correlation pricing that today is
  assumed independent.
- **Governed paired-comparison evaluation harness** — both required statistical primitives
  already exist and are tested elsewhere; composing them would have caught the ensemble's fake
  diversity and the -2.28 CLV drift months ago.

**Explicitly rejected, with reasons, so nobody re-proposes them:** genetic-programming feature
discovery, mixture-of-experts learned gating, deep generative play-sequence models, and
reinforcement-learning play-calling all need 10-100x more independent observations than
Gridiron's few-hundred-games-per-season tables carry — five separate researchers independently
reached the same verdict against the literature's own stated sample sizes. Live social-media
sentiment and cross-venue Kalshi/Polymarket arbitrage both turned up thin-to-negative evidence
even in their own best published case (Polymarket NBA arbitrage nets $210-560 total across an
entire league-month). Don't build execution infrastructure for either.

---

## Coverage note

The full 23-subsystem codebase audit finished all its reading and is still completing its
verification and final synthesis pass in the background — its cleanup plan (dead code, file
organization, data-directory disposition) isn't in this document yet and will be appended when
it lands. Nothing above should change materially; that pass covers organization and hygiene,
not the fixes and additions above.

## Tonight's actual build scope

Given the real cost/confidence split above, tonight's implementation targets every **hours-scale**
item across Phases 0-4 (18 fixes) plus the two cheapest ADD items, all built and tested in
isolated git worktrees against fixture databases — never the live server, never
`server/data.sqlite`, never a paid API call. Phase 5's bigger consolidation items (CLV
unification, trial registry) are staged as a tested, ready branch for review rather than merged
blind. Starting now.
