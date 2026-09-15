# Chunk 8/21 scoring notes — verification against fantasy-football-dashboard (read-only)

All file/line citations below were verified live against the repo at
/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only; no edits, no tests run,
no server touched).

## F17 (drive-sim / margin-distribution) group

- `server/services/nfl-drive-sim.js:903` `calibrationReport()` confirmed to check exactly 3 summary
  moments (mean total, mean margin, margin SD) against `game_lines` since 2021 — matches F17-new-5's
  claim verbatim.
- `server/betting/nfl/strategy/margin-distribution.js` confirmed to exist, exports `marginPmf()`,
  `coverProbability()`, `teaserLegProbability()`, `fitMarginModel()` etc. — this module is the
  **standalone teaser/key-number model**, walk-forward fit via Newton's method on a conditional-logit
  spec (atoms + tilt basis), and produces an O(1) (per query) closed-form margin PMF *already
  calibrated to key numbers*. This directly undercuts F17-new-7's core claim that "nothing in
  Gridiron currently offers a sub-millisecond margin CDF" — `marginPmf()` already is that. F17-new-7's
  "how" section also claims edgeHunt()/backtest() in nfl-drive-sim.js "re-run full drive simulations
  for every candidate line" to get P(margin>x) — checked `edgeHunt()` at line 1056: it calls
  `simulateGame()` in a trials loop and only ever computes a **mean** margin/total, never a P(margin>x)
  CDF query. The specific integration point claimed doesn't exist. Recommend reject.
- `simulateGame()`'s overtime block (nfl-drive-sim.js:540-556) uses a literal variable named `had`
  with a `had < 8` loop condition and sudden-death break after 2 possessions if scores differ — this
  is an exact, verbatim match to F17-new-6's citation ("both simulateGame's `had<8` loop"). Confirms
  the OT mechanism really is "resimulate full regulation-style drives," supporting F17-new-6's premise.
  `simulateRemainder()` (773-903) has no "overtime" or "halftime" string anywhere in its body —
  confirms the separately-verified finding that the season-remainder simulator has no OT/halftime.
- No NFL Poisson/compound-Poisson total-points model exists anywhere in `server/services/` or
  `server/betting/` — grep for `Poisson` only hits MLB's `mlb-projections.js` (a same-pattern compound
  Poisson via Panjer recursion for a different sport) and generic RNG helpers in `stats-util.js`.
  F17-new-8 is a genuinely new capability for the NFL side, not overlapping existing code.

## Audit/CLV architecture consolidation group

- Verified three genuinely different CLV conventions exist exactly as claimed:
  - `nfl-clv.js:241` inverts sign for totals-Under (`clvPoints = b.market === 'totals' && b.side ===
    'Under' ? ...`).
  - `nfl-execution-clv.js:219` `spreadClvPoints()` explicitly comments "Both lines are already
    expressed from the backed side's perspective by the contract key" and does **not** invert —
    a different assumption about upstream normalization than nfl-clv.js.
  - `nfl-prop-clv.js` stores `clv_probability`/`clv_cents` (a probability-delta, confirmed via
    `nfl_prop_clv` schema column names in the INSERT statements at lines ~250-380) rather than
    signed points.
  This is a strong, concretely verified three-way disagreement — supports fix-1 fully.
- `server/migrations/005_model_registry_integrity.js` confirmed to create `model_dataset_versions`,
  `model_feature_versions`, `model_backtests`, `model_metrics`, `model_promotion_history`,
  `model_audit_log`. Grepping for these table names across `server/` and `test/` shows they are used
  **only** in `server/modeling/sqlite-store.js`, `server/routes/model.js`, and
  `test/model-registry-persistence.test.js` — never in `nfl-blind-audit.js` or `audit-registry.js`,
  which maintain their own separate `codeHash()`/`dataSignature()` (audit-registry.js:46,62). Confirms
  fix-2's central claim of total non-interoperation.
- Grep for `createHash('sha256')|codeHash|dataSignature|configurationHash|stableJson` across
  `server/services/*.js` and `server/modeling/*.js` hits **43 files** — same order of magnitude as the
  claimed 37 (exact count differs, phenomenon confirmed). `nfl-engine-registry.js:14` has its own
  `digest()` (`crypto.createHash('sha256').update(JSON.stringify(value))...`), and
  `server/modeling/contracts.js:6-14` has `stableJson`/`configurationHash` doing the same thing with a
  canonical (key-sorted) serializer. Both cited primitives are real and exist today. Confirms fix-3.
- `contracts.js:3` `PIPELINE_VERSION = 'gridiron-fantasy-walk-forward@1.0.0'`;
  `assertTimestampedObservation` (line 20) is used only in `contracts.js`, `walk-forward.js`, and
  `routes/model.js` — never against `nfl_team_week_features`/`nfl_play_by_play` or from
  `nfl-blind-audit.js`. Confirms fix-4's leakage-guard gap.
- `server/modeling/registry.js:47` `compare(ids) { return ids.map(id => this.store.get(id))
  .filter(Boolean); }` — confirmed literally zero statistics attached, exactly as new-4 claims.
  `server/services/backtest-significance.js` confirmed to export both `pairedBootstrapDiff` (line 57)
  and `alwaysValidPValue` (line 216) already, tested and ready to compose. Strong evidence for new-4.
- `registry.js:4` `REQUIRED_GATES = ['schema', 'leakage', 'data_quality', 'baseline_improvement',
  'tests']` — confirmed exactly, no forward/shadow-window gate present. Confirms new-2's premise.
- new-1 (ML Test Score rubric) and new-3 (point-in-time feature store) are plausible, well-grounded
  in real external patterns (Breck et al. 2017; Uber Michelangelo), but both are weeks-scale
  meta-infrastructure with no single concrete existing consumer forcing the issue today — lower
  value_per_cost than the other fixes in this group.

## N01 (time-series foundation models) group

- `server/db/schema/nfl-n-to-z.js:154` confirms `CREATE TABLE IF NOT EXISTS nfl_team_week_features`.
- `server/services/nfl-team-strength.js` and `server/services/player-week-engine.js` both confirmed
  to exist.
- `player-week-engine.js:50` confirms `const TEAM_PASS_ATTEMPT_DISPERSION = 47;` used at line 535 via
  `randNegBinomial(passMean, TEAM_PASS_ATTEMPT_DISPERSION)` — a hand-fit dispersion constant exactly
  as N01-C2 describes.
- The `heads` null-guard in `player-week-engine.js` (`explainPlayerWeek`, ~line 573-577:
  `if (!engine || !heads) return { ... 'No current-season games are available before this cutoff, so
  no weekly outcome update was applied.' }`) confirms N01-C3's cold-start-silent-no-op mechanism
  almost verbatim.
- `server/services/model-governance.js:12` confirms the exact governance row
  `['NFL', 'spread', 'team_efficiency', 'nflverse play-by-play', ...]` cited by N01-C1 as the pattern
  a new TSFM-gated contract would mirror.
- `player_week_usage` table confirmed in `server/db/schema/mlb-model-misc.js:257` (also referenced
  from NFL-side code via `nfl-a-to-m.js:600`'s table list) — real, if oddly-named, cross-sport table.

All citations in this chunk check out at a high fidelity rate; the one candidate whose core
"gap" claim does not survive verification is F17-new-7 (closed-form margin CDF), because the
capability it proposes building already exists in `margin-distribution.js`'s `marginPmf()`.
