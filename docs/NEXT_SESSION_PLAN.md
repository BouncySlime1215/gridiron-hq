# Next session plan — from "everything reports" to "something beats the market"

Written 2026-09-02 at the end of the round that made all sixteen council roles
report on the historical diagnostic (see `DIAGNOSTIC_2026_09_02.md` §7–8).
State at hand-off: branch `phase3-live-draft-reliability`, 384 tests green,
server running via the preview launch config, forward captures live for 2026
Week 1 at zero units.

The measured problem this plan attacks (`GET /api/nfl-betting/specialists/audit`,
run 10, 323 games): no role reduces the market's 11.65-point residual RMSE;
the four loudest roles add error; four roles are one opinion counted four
times (r = 0.74–0.92); when five or more agree they are right 49.6%. The
model does not lack opinions, it lacks **calibrated, independent, market-
orthogonal** ones. Every item below is judged by one question: does it lower
walk-forward RMSE against the market residual on games it never trained on?

Order of work is the order below. Do not start a later section while an
earlier one has a failing gate.

---

## 0. Operating rules (learned the hard way this session)

1. **No edits to `server/`, `scripts/`, `package.json` while an audit week is
   open.** The code freeze hashes those paths; a change voids the run at the
   post-compute recheck (runs 12–13). Docs, client and tests are outside the
   freeze and safe.
2. `node --watch` restarts the API on any server edit and kills in-flight
   worker reports and open audit weeks. Batch server edits; verify between
   batches.
3. Long jobs go in the background with a Monitor; check the store, not the
   log. Report stores: `/api/nfl-market/reports`, `/api/nfl-market/odds-archive`,
   `/api/nfl-betting/blind-audits`.
4. Nothing gets a stake. `NFL_MODEL_STAKE_UNITS` stays 0 until the forward
   gates in `PROFITABILITY_PLAN.md` §2 pass.

---

## 0.5. First: the beat-the-close study (`docs/BEAT_THE_CLOSE_PLAN.md`, Phase 1)

Before touching the coordinator, spend the first session on the question
that can actually pay: does anything we hold predict the line's move from
open to close? The dataset (per-book openers and closes 2022–2025, verified
events, the model's own outputs stamped by decision time), the CLV-in-points
gate and the deliverables are specified there. The coordinator work below is
still right, but its weights should come from whatever predicts the LINE,
so the study goes first.

## 1. Fix the coordinator: walk-forward shrinkage and de-duplication (the item from the audit)

**Why first.** The coordinator (`nfl-expert-coordinator.js`) is a week-balanced
Huber ridge over sixteen raw forecasts with a missingness mask. It cannot
undo the two measured faults: (a) roles whose forecast SIZE is uninformative
(rulebook 3.8 pts mean, 45.8% direction) still enter at full scale, and
(b) four near-duplicate roles get four coefficients that the ridge spreads
across them, so a duplicated signal is still counted more than once.

**Design — two stages, both fitted strictly on prior settled weeks.**

*Stage A, per-role walk-forward shrinkage.* For each role `i` and target week
`t`, compute on every settled game before `t` (same season and the previous
two, week-balanced) the least-squares scale
`k_i = cov(f_i, r) / var(f_i)` where `f_i` is the role's forecast and `r`
the market residual, with a ridge on `var(f_i)` and a cap `k_i ∈ [0, 1]`.
Also store the role's walk-forward RMSE gain `g_i = RMSE_zero − RMSE(k_i·f_i)`.
A role with `g_i ≤ 0` over its trailing 200 games gets `k_i = 0` for that
week and a recorded reason (`shrunk_to_zero: no walk-forward gain`). This
is the "walk-forward error" fix: forecasts are rescaled by what they have
actually earned, week by week, never by what they claim.

*Stage B, family de-duplication.* Cluster the shrunk forecasts by trailing
correlation (threshold 0.6, computed on prior weeks only). Today that yields
one family {game_replay, specialist_team, rulebook, player_builder} and
singletons. Each family contributes ONE column to the coordinator: the
family mean of the shrunk forecasts (or its first principal component,
sign-aligned). The ridge then fits families, not members. Members keep
their own rows, audit cells and look-back grades; only their influence is
pooled. Record `family_id`, `family_weight` and each member's
`learned_weight = family_weight / members` in the combined-decision trace so
the existing UI and tests keep working.

**Where.** `nfl-expert-coordinator.js` (design vector, fit, `coordinateExperts`
contributions), `nfl-expert-council.js` (`combinedDecisionTrace` gains
`shrinkage` and `families`), `nfl-specialist-audit.js` (report `k_i`, `g_i`
and family membership per role so the audit says whether the fix worked).

**Gate.** Rerun the historical diagnostic (section 4) and compare in
`/specialists/audit`: coordinator `error_ratio` must be < 1.000 with ≥ 300
directional calls, and the family column's correlation with any single
member must be reported. If the coordinator still cannot beat the market
after A+B, that is a finding, not a failure of the plan; move to section 2.

**Tests.** Synthetic weeks where one role is signal at scale 0.3 and three
roles are its copies plus noise: Stage A must recover k≈0.3 for the signal
and shrink the copies; Stage B must place the four in one family and the
combined forecast must beat the raw mean. Add to
`test/model-integrity.test.js` (the coordinator tests live there).

---

## 1b. Close the postgame feedback loop (learn from the assessment, not just record it)

**What exists.** Settlement grades every frozen row (residual, direction,
squared error, Brier); `nfl-postgame-truth.js` records usage surprises,
structural trends, in-game injuries and variance markers (turnovers,
non-offensive scores, explosive plays, reversed challenges); the weekly
look-back chains the grades. **What is missing:** none of that changes the
next prediction. A pick lost to a pick-six and a pick lost to a wrong read
teach the same lesson today.

**Build.**
1. Per game, decompose the actual residual into a *variance share* and a
   *model share* from the play-by-play we already hold: points from
   turnover returns and short fields after turnovers, special-teams and
   defensive touchdowns, missed or blocked kicks, and scoring after the win
   probability passed 97% (garbage time). Store both on the settlement row
   (`variance_points`, `adjusted_residual`) with the itemised markers.
2. Use `adjusted_residual` as the training target for Stage A shrinkage and
   for the matchup and neural refits; keep the raw residual for the ledger
   and the bet grade, because the bet still lost.
3. Grade reasoning separately from result: a role that was directionally
   right on the adjusted residual but wrong on the raw one is recorded as
   `right_read_variance_loss`; the reverse as `wrong_read_variance_win`.
   Both counts go into the look-back and the specialist audit.
4. Weekly "what the league taught us" record: the three largest weight
   moves, the three largest adjusted misses with their markers, and any
   role that flipped from gain to no-gain, written into the look-back's
   `reads`.

**Gate.** On the rerun, the coordinator's error ratio on the ADJUSTED
residual must be reported next to the raw one; if shrinkage learns more
from the adjusted target (lower raw-residual RMSE on held-out weeks), keep
it; if not, the decomposition stays as diagnostics only.

## 2. Make the loud roles honest at the source

Shrinkage rescues the coordinator; it does not fix a role that is wrong by
construction. Each of the four error-adding roles gets one bounded change and
is re-audited; a role that still adds error is left in the registry as a
recorded abstainer, not deleted.

- **Football rulebook** (45.8% direction, worst-scaled): its components are
  simple priors (Elo, point differential, Pythagorean, form, rest). These are
  already IN the market. Replace its forecast with the residual of the priors
  *after* regressing them on the closing line over prior seasons; if that
  residual has no walk-forward gain, the role reports `support` only.
- **Player-built team** (5.15-point mean forecast): cap by uncertainty
  (`|f| ≤ 0.5·σ_walkforward`) and rebuild its roster value from verified
  availability (event archive v2) rather than depth-chart guesses.
- **Game replay simulator** (0.92 correlated with specialist team): it is
  seeded from the ensemble projection, so it re-states it. Seed it from the
  MARKET line plus verified availability only; it then measures the
  simulator's distribution, which is its actual job (its 80% interval
  coverage is the score to watch).
- **Specialist team** (family council of the ensemble): report it as the
  family aggregate it is, weight 1/n inside its family.

Gate per role: `verdict` in `/specialists/audit` moves off `adds error` on the
rerun, with the sample stated.

---

## 3. New evidence the market may not price — with sources

Each candidate becomes a council role only through the same path the four
Priority 4 roles took: `nfl-matchup-specialists.js`-style ridge on
strictly-prior profiles, prior-games-only fit, capped, abstaining, then the
audit decides. Build in this order; stop adding when the audit shows the
coordinator has nothing left to gain.

### 3a. Sharp-versus-soft divergence (the archive we now have)

We hold per-book opening and pre-kickoff lines for 2022–2025 (`nfl_odds_archive`,
11 books incl. Pinnacle, Bovada, BetOnline, Lowvig). Features per game:
Pinnacle's move minus the soft-book median move; the fraction of books that
moved with Pinnacle; the spread dispersion across books at close; whether
the closing number crossed a key (3, 7). This is market microstructure the
single-consensus `line_movement` role cannot see. Fit on 2022–2023, hold out
2024–2025 first (cheap, and a real test of the archive's value).

### 3b. QB-adjusted Elo (FiveThirtyEight method)

- Source: `github.com/fivethirtyeight/data/tree/master/nfl-elo` — `nfl_elo.csv`
  with `qb1_value_pre`, `qbelo1_pre`, `elo_prob1` through the 2023 season
  (archived, static). Method write-up in the repo README.
- Use: the QB-adjusted pregame Elo spread versus the closing line as a
  feature; for 2024+ reproduce the update rule from the README (it is a
  documented formula) on our `game_lines` scores and the verified event
  archive for starter changes. Rulebook's Elo is unadjusted; this is the
  version that carries the quarterback.

### 3c. Weekly QBR and pressure from nflverse releases (free, versioned)

- `github.com/nflverse/nflverse-data/releases` — `espn_qbr` (weekly ESPN QBR,
  2006+), `ftn_charting` (already ingested as `nfl_play_charting`, 2022+:
  pressure, blitz, motion, play action), `pbp_participation` (2016–2023
  players on field per play and `defenders_in_box` — we ingested formations
  for 2022–2023; extend back to 2016 for training depth), `contracts` (OTC
  contract data — starter salary lost to injury is a cheap replacement-
  quality proxy), `draft_picks`, `combine`.
- Roles: `qb_state` (weekly QBR trend + starter change from the event archive
  + contract-value at QB), `pressure_matchup` v2 (charting pressure and blitz
  rates rather than sack-rate proxies), `replacement_quality` (salary-
  weighted snaps lost, from contracts × snaps × availability).

### 3d. Historical weather at kickoff

- Source: `github.com/meteostat/meteostat-python` (free, station/hourly
  history, no key) with stadium coordinates from nflverse `stadiums`.
- Use: replace nflverse's coarse `temp`/`wind` with kickoff-hour wind speed,
  gusts and precipitation for outdoor games; a totals-side role
  (`weather_total`) fitted on the total residual, which nothing in the
  council models today (the council forecasts spread residual only — add a
  `score: 'total_residual'` lifecycle so totals roles are graded correctly).

### 3e. Special teams and hidden yards

From our own play-by-play: punt and kickoff EPA per team, field-goal
expectation vs. made (kicker quality by distance), return EPA. Historically
ST is where "the market is slow" claims come from; test it, do not assume it.

### 3f. Officiating crews

`nfl-officials.js` already joins crews to games (21,977 matched). Feature:
crew's trailing penalty yards per game and offensive-holding rate versus
league; role `crew_tendency` on the total residual.

### 3g. Do NOT build (yet)

Deep sequence models over possessions, player interaction graphs, LLM
readers (Priority 5). They cannot be audited on the sample we have and the
evidence so far says the problem is calibration, not capacity.

---

## 4. Run the full historical diagnostic the resumable way

1. `npm run` the rebuild: `node scripts/nfl-2022-2025-rebuild.mjs` in the
   background. It now backfills the odds archive as a phase, preregisters,
   opens weeks and, if interrupted, **resumes** at the next unopened week
   instead of sealing the run. About 70 weeks at 1.5–2.5 min each.
2. While it runs: nothing in `server/` or `scripts/` changes. Client, docs
   and tests are fine.
3. After: `/specialists/audit`, `/diagnostic/slices`, the manifest's
   `reporting` block (must be all weeks complete, zero missing cells), and
   the Training page trail (look-backs under every week).
4. Record the numbers in `DIAGNOSTIC_2026_09_02.md` §9 and tick the plan's
   "Re-run the correctly named historical diagnostic" item.

---

## 5. Remaining Priority 1–2 items (in order)

- Manifest v2: per-phase latency from `nfl_blind_audit_week_performance`
  (already recorded), retry counts (add a column when the runner retries),
  and calibration on settled rows (the slice diagnostic's calibration block
  can be embedded).
- Evidence-provenance verifier for the forward ledger: walk each frozen
  expert payload for timestamps (`published_at`, `captured_at`, `available_at`,
  `book_updated_at`) and flag any later than `evidence_cutoff`. Report per
  week in the look-back as `evidence_check`.
- Audit UI: one honest path on the Training page — coverage → frozen
  evidence → weekly decisions → look-back → manifest — with the slice
  diagnostic and specialist audit as tabs. Client-only, safe during runs.
- Empty-state and partial-source tests for the report store and the archive
  route (a fresh database must render every page without a stack trace).

---

## 6. Forward ledger through Week 1–4 (do not touch, do watch)

- Week 1 kicks 2026-09-09 (SEA v NE) and 09-10 (LAR v SF, Melbourne,
  neutral, open-air). The server must be running; captures are timers.
- Check daily: `/api/nfl-market/evidence/status` (missed windows), Polymarket
  line watch, free book feeds, the `combined_decision` rows per game.
- After Week 1 settles, the first forward look-back appears in
  `/api/nfl-betting/expert-council/game/:season/:week/:home`; the plan's
  200-settled-decision gate is months away and nothing here shortens it.

---

## 7. Checklist for the session

```
[x] 0.5 Beat-the-close study, Phase 1 (BEAT_THE_CLOSE_PLAN.md) — done; Phase 2 live
[x] 1  Coordinator: Stage A shrinkage + Stage B families, tests, audit fields (every role shrinks to zero on run 10; one family of four)
[x] 1b Postgame decomposition (variance vs model share), adjusted target in the coordinator and audit; reasoning-vs-result grades still open
[ ] 2  Rulebook / player builder / game replay / specialist team changes, re-audited
[ ] 3a Sharp-vs-soft role from the odds archive (hold out 2024–25)
[ ] 3b QB-adjusted Elo role (538 data + reproduced update rule)
[ ] 3c espn_qbr + pbp_participation back to 2016 + contracts; qb_state, pressure v2
[ ] 3d Meteostat kickoff weather; weather_total role; total-residual lifecycle
[ ] 3e/3f Special teams and crew tendency roles (only if 3a–3d leave gain on the table)
[ ] 4  Full 2022–2025 diagnostic via the resumable rebuild; numbers into the docs
[ ] 5  Manifest v2, evidence-provenance verifier, audit UI path, empty-state tests
[ ] 6  Forward ledger watched, untouched
```

Each ticked item ends with: tests green, `npm run lint`, commit, push to
`origin/phase3-live-draft-reliability`.
