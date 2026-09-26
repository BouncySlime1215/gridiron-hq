# PROJ-01-a-2025: one-time 2025 confirmation of two ESPN blind spots

## 0. What this is, and why it deviates from proj-01-preregistration.md section 6

`docs/evidence/2026-09-23/proj-01-preregistration.md` section 6 says the 2025 confirmation
of any proven PROJ-01-a spot belongs to a later unit (PROJ-01-b), with its own
HOLDOUT-LEDGER row written before it looks. Nick commissioned this one-time confirmation
directly, now, as unit PROJ-01-a-2025, of the two spots PR #222 proved on 2021-2024:
`qb_change` and `blowout_underdog_rb`. That approval, and the separate approval to pull a
2025 ESPN archive at all, is ledger row `L162`
(`docs/evidence/HOLDOUT-LEDGER.md`). This file is that later unit's pre-registration and
result together, in the same commit as the ledger rows it produces (`L163`, `L164`), per
`STATS-METHOD.md` rule 2.

## 1. Pre-registration (fixed before any 2025 error was computed)

- **Hypothesis, one sentence each.** `qb_change`'s pooled excess error keeps its sign
  (negative) in 2025. `blowout_underdog_rb`'s pooled excess error keeps its sign
  (negative) in 2025.
- **Metric and sign convention.** Pooled cluster-robust (by player) mean excess error:
  each spot row's `actual - ESPN` minus the mean `actual - ESPN` of the same
  season+position rows NOT in the spot (`spotTest` in `scripts/rnd/espn-mistake-map.mjs`,
  frozen, unchanged by this unit). Negative = ESPN over-projects the spot relative to its
  complement, which is the direction both spots proved on 2021-2024.
- **Split.** Fit/definition seasons: 2021-2024 (already frozen, PR #222). Graded season:
  2025 only, one look, weeks 1-17, ESPN projection >= 5.0, same population rule as the
  frozen study.
- **Incumbent.** No served number exists for either spot (PROJ-01-a produces no served
  number, section 5 of the original pre-registration); the "incumbent" here is the 2021-2024
  pooled result itself, which this unit checks for a same-season repeat, not a fit.
- **Ship rule.** This unit ships no served number and changes no threshold. "Confirm" =
  the 2025 sign matches the predicted (2021-2024) sign; that is a research verdict, not a
  ship decision. Rule 5's forward-2026 check does not apply (no model growth job reads
  this unit).
- **Minimum detectable effect / power.** Not separately computed; this is a single
  pre-registered replay of an already-derived statistic, not a new-design test. The
  95% CI on each estimate is reported instead (below).
- **Replay configuration.** `node scripts/rnd/espn-mistake-map.mjs --confirm-2025 L163
  --db .local-db/data.sqlite` (`GRIDIRON_PROJ_01_A_2025_ENABLED=1`), same `assemble()` /
  `spotTest()` code path as the frozen 2021-2024 grade, restricted to season 2025 via a
  new `seasons`/`allowHoldout` parameter (default behavior for every other caller is
  unchanged: `refuseHoldout()` still throws on 2025+ unless `allowHoldout: true` is passed
  explicitly, which only `--confirm-2025` does).
- **Literature grounding.** This is a direct pre-registered replay, not a new statistical
  procedure; the clustering and CI method are PR #222's (Cameron, Gelbach & Miller 2011,
  cluster-robust variance, cited there). No new correction is introduced.

## 2. Baseline (measured first, before any code change, local DB copy)

Command: `node scripts/rnd/espn-mistake-map.mjs --grade --db .local-db/data.sqlite`
(tree `29b77bf0`, the unmodified worktree at PR #222's branch head).

| spot | 2021-2024 pooled excess | 95% CI | proven |
|---|---|---|---|
| `qb_change` | -0.5678 | [-0.9459, -0.1898] | yes |
| `blowout_underdog_rb` | -0.6615 | [-1.2271, -0.0958] | yes |

Matches the task's stated baseline (-0.57 [-0.95,-0.19] and -0.66 [-1.23,-0.10]) to
rounding. Full output: `.local-db/baseline-2124.json` (local copy, not committed).

## 3. 2025 result

Command: `GRIDIRON_PROJ_01_A_2025_ENABLED=1 node scripts/rnd/espn-mistake-map.mjs
--confirm-2025 L163 --db .local-db/data.sqlite --out .local-db/confirm-2025.json`
Tree: `ad5a31b5` (this unit's branch, `claude/local-proj-01-a-2025-v3`). Local copy of the
app database (`.local-db/data.sqlite`, backed up from `~/gridiron-local/data.sqlite`,
deleted after this unit). ESPN 2025 archive:
`~/gridiron-local/rnd/loop/data/espn_proj_hist/espn_leaguedefaults3_2025.json.gz` (local
only, never committed; pulled under `L162`).

| spot | predicted sign | 2025 pooled excess | 95% CI | p | n (clusters) | same sign as 2021-2024 |
|---|---|---|---|---|---|---|
| `qb_change` | - | **-0.9779** | [-1.7406, -0.2153] | 0.0120 | 282 (132 players) | **yes — CONFIRMED** |
| `blowout_underdog_rb` | - | **+0.1028** | [-0.8964, +1.1020] | 0.8401 | 122 (48 players) | **no — NOT CONFIRMED** |

Population census for 2025: `.local-db/confirm-2025.json` (`census.2025`), 3,270 kept
rows, 1 row with no team match (dropped), 0 rows with a missing ESPN actual line.

## 4. Verdict

- `qb_change`: **confirmed**. 2025 sign matches 2021-2024, effect is larger in 2025
  (-0.98 vs -0.57) and remains significant at 95%.
- `blowout_underdog_rb`: **not confirmed**. The 2025 sign flips positive and the interval
  straddles zero (p = 0.84). The 2021-2024 result does not repeat in this one 2025 look.
- No frozen spot definition, sign, threshold, or the `SEASONS`/`WALK_FORWARD`/`DECIDING`
  constants changed. `refuseHoldout()` is still the default for `--baseline`, `--grade`,
  and every other caller; only the new `--confirm-2025 <ledger-row>` path, gated by
  `GRIDIRON_PROJ_01_A_2025_ENABLED=1` and a required existing HOLDOUT-LEDGER row id, can
  open 2025.
- No re-fit happened: this unit calls the same frozen `spotTest()`/`assemble()` code on
  2025 rows only; no coefficient, threshold, or spot definition was estimated from 2025.

## 5. Local-copy cleanup

`.local-db/data.sqlite`, `.local-db/baseline-2124.json`, `.local-db/confirm-2025.json` are
under `.git/info/exclude` (never committed) and are deleted at the end of this unit
(`rm -rf .local-db`). The live databases (`~/gridiron-local/data.sqlite`,
`~/Documents/GitHub/gridiron-hq`) were never written.
