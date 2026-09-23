# PROJ-02-a sharp chain: pre-registration

Unit PROJ-02-a (TRADE-INSANE-RND Layer 2 v2 item 2, "Sharp chain"). Branch
`claude/local-proj-02-a-sharp-chain`, based on `origin/main` `62f9530a`.
Committed before any number is run. Nothing below has been measured yet.

## 1. Audit: extend or build (read on `62f9530a`)

| Link | What exists | Decision |
|---|---|---|
| plays (pace) | `teamVolume` (`server/services/projections.js:371`) shrinks each team's pass and rush attempts per game toward the league (`K.team_volume` or the fitted `team_pass_att`/`team_rush_att` k). Summed from `player_week_usage` rows (writer `syncWeeklyUsage`, `server/services/nflverse.js:247`, INSERT at :262). | Extend: plays = pass_att + rush_att from this one producer. |
| plays and pass rate vs the line | `gameScriptFor` (`server/services/gamescript.js:389`) returns `pass_mult`/`rush_mult` from a walk-forward OLS of team attempts on spread and total (`fitObservations`, :320; cutoff refit `modelAt`, :369). Consumed downstream by `fantasy-coordinator.js:312,409`, `season-sim.js:360`, `nfl-props.js:59`, `waiver-brain.js:166`. It returns no win-probability number; its spread term is the script effect. | Read, never refit (one producer). The chain does NOT create a second win-probability producer. Because those consumers already multiply `params` by the script, served volume stays pre-script and the scripted values are exposed on the link only, so the script is never counted twice. |
| shares | per-player shrunk `target_share` (:595-601, prior 0.06, `K.share` or fitted k) and `carry_share` (:602-605). Nothing makes a team's shares sum to 1. `targets = tgtShare x pass_att` (:607) treats nflverse `target_share` (targets / team targets) as if it were targets / pass attempts, i.e. an implicit target rate of 1. | Extend: normalize over an as-of roster, multiply by a measured team target rate. |
| redistribution | `opportunity-redistribution.js` (off by default): conserving vacated volume inflated survivors ~1.6x and made 2025 MAE worse (its header). | Prior evidence against conservation. Recorded here as the reason the share link may well lose; the test below is honest about it. |
| efficiency | `shrink` with `activeKVectorFor` (`shrinkage-fit.js`) / `K` (:618-640). | Unchanged, exposed as `links.eff`. |
| TDs | per-opportunity TD rates shrunk with `K.td_rate` (:627-636). No red-zone share, no implied-team-TD link. | Unchanged, exposed as `links.td`. Red-zone share x implied TDs is NOT built in this unit. |
| scoring | `scoreSim` (`server/services/scoring.js:157`), last. | Unchanged. |

Stale drafts not depended on: #88 (projection-range) and #44 (sim basis) both edit
`projections.js`; overlap is listed in the evidence file section 1.

## 2. The chain (what is built)

For every projection of `buildProjections` (`projections.js:504`), a `links` object:

- `links.plays`: team plays per game. `chain` = pace (`pass_att + rush_att` from
  `teamVolume`) with the week's script applied: `pass_att x pass_mult + rush_att x rush_mult`
  from `gameScriptFor(team, through, throughWeek + 1)` when the cutoff is in-season and a
  line exists; neutral (multipliers 1) otherwise. `incumbent` = the team's season-to-date
  average plays (as of the cutoff). `value` = whichever the ship rule picked.
- `links.pass_rate`: `chain` = `pass_att x pass_mult / plays_chain`. `incumbent` = the
  team's season-to-date pass rate (no script).
- `links.share`: normalized `target_share` and `carry_share` over the as-of roster (below),
  the raw shrunk shares they came from, and the team `target_rate`.
- `links.volume`: `targets.chain = norm_target_share x team_pass_att x target_rate`,
  `carries.chain = norm_carry_share x team_rush_att` (pre-script, see the audit);
  `incumbent` = today's `targets_per_game` / `carries_per_game`; `value` = the served one.
- `links.eff`, `links.td`: the existing shrunk rates, unchanged.

**Target rate.** Team targets / team pass attempts from the same `player_week_usage` rows,
recency-weighted like `teamVolume`, shrunk to the league rate with the team-volume k
(`pickK(k, 'team_target_rate', ...)`, falling back to `K.team_volume`; no fitted k exists
for it, so it runs on the hand-set 10 weighted games: a hand-set constant, said plainly).

**As-of roster** for team T: players whose most recent team is T and who have a
`player_week_usage` row for T in one of T's last 3 played weeks in the evidence log (all
rows at or before the cutoff). Players outside it keep `links.share.roster = false` and
their incumbent volume.

**RED (hard, not statistical):** for every team-week in a fixture and in the 2024
replay, `sum(links.volume.targets.chain)` over the roster equals
`team_pass_att x target_rate` within 0.5%, and `sum(links.volume.carries.chain)` equals
`team_rush_att` within 0.5%.

## 3. Statistical test, per link

- **Hypothesis (one per link, four tests):** the chain value has lower MAE vs actuals than
  the incumbent. H1 plays: chain plays vs season-average plays. H2 pass rate: chain pass
  rate vs season-to-date pass rate. H3 targets: chain targets vs today's
  `targets_per_game`. H4 carries: chain carries vs today's `carries_per_game`.
- **Rig (configuration B):** `buildProjections({ through: s, throughWeek: w - 1,
  roleRecency: WEEKLY_ROLE_RECENCY })`, no `kOverride`, so k comes from
  `activeKVectorFor` (walk-forward refit `cutoffSafeKVector` for 2023/2024, stored fit #1
  for 2026). k control: the run stops if `activeKVectorFor(WEEKLY_ROLE_RECENCY,
  { predictingSeason })` has no `target_share.ALL` (that would mean `K.share = 6`).
- **Seasons and weeks:** 2023 and 2024, weeks 2-18 (week 1 has no in-season history, so
  there is no season-average incumbent), walk-forward as-of. **2025 is not opened** (used
  holdout; no ledger row). **Forward:** 2026 week 2 (the only 2026 week with a prior week
  on the local copy): reported as an anecdote, never a verdict, logged as a forward row.
- **Rows.** Team links: every team-week with a usage row for the team and at least one
  prior in-season week. Player links: player-weeks where the player is on T's as-of roster
  and has a `player_week_usage` row for T that week (conditional on playing). Secondary:
  DNP-included (roster players with no row that week count as actual 0).
- **Metric:** MAE; paired difference `chain - incumbent` (**sign: negative favours the
  chain**). Interval: 90% cluster bootstrap, 2,000 resamples, clusters = team (team links)
  or player (player links), 2023 and 2024 pooled, seed 20260923.
- **Ship rule, per link:** the chain MAE is lower in 2023 AND in 2024, AND the pooled 90%
  interval is entirely below 0, AND (player links) the DNP-included MAE is no worse in
  either season. A link that passes ships ON only if the 2026 week-2 difference has the
  same sign; otherwise it ships default-off, labelled "unconfirmed forward". A link that
  fails keeps the incumbent value (`value = incumbent`, `served: 'incumbent'`), recorded.
- **Plays and pass rate are served nowhere in this unit either way:** the script already
  reaches every weekly consumer through `gameScriptFor`; these two links are exposed for
  grading and for PROJ-04 only.
- **MDE:** every link reports the minimum detectable effect at 80% power,
  `2.49 x SE(paired difference)` (two-sided 90%), so "underpowered" is not read as "no effect".
- **Decision grade (d, e):** if a volume link is served, start/sit pair accuracy (same
  position, same week, both played: did the higher structural `ppg` score more) for the
  served head vs the incumbent head, 2023 and 2024 walk-forward. Consensus / ESPN
  baselines are not available to this rig (HX-01 owns that); not claimed.

## 4. Literature

Team play volume and run/pass mix move with the point spread and total, and the spread
maps monotonically to win probability (Stern 1991, "On the probability of winning a
football game", *The American Statistician* 45:179-183); the one line producer here
(`gameScriptFor`) already encodes that as a linear spread term. Per-player efficiency is
shrunk toward the positional mean in proportion to sample size (Efron and Morris 1975,
*JASA* 70:311-319). Shares of a fixed team total are compositional and must sum to one
(Aitchison 1986, *The Statistical Analysis of Compositional Data*), which is the
constraint RED enforces; whether imposing it improves the forecast is H3/H4.
