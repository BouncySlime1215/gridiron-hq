# Weekly data system and 2022–2025 rebuild

## What is true now

The prior database exposes 376 distinct public raw variables across team-week,
player-week, Next Gen Stats, play-by-play, snap counts, injuries, depth charts,
formation participation, FTN charting, and market/game state. PFF is not included
in that number because no licensed PFF rows are installed. The live authority is:

```text
GET /api/nfl-betting/features/coverage
```

That endpoint reports raw variables, rows and year coverage by source. It does
not call a theoretical column “populated.” The longitudinal store derives 13
cutoff-safe measurements from every observed numeric metric: latest, 3/6/12
week means, EWMA, slope, standard deviation, minimum, maximum, one-week change,
league z-score, coverage, and missingness. Frozen vector count and coverage are
reported together. A sparse vector can never market itself as “2,000 features.”

## Fixed after the previous run

- The nflverse injury loader requested `.csv.gz` assets that do not exist. It
  now requests the published `.csv`, stores `date_modified`, and reports every
  source failure instead of treating failure as no injuries.
- Simulator profiles previously accepted a season but could read the completed
  target season. They now use only weeks strictly before the prediction week.
- `null` values in the high-dimensional feature factory could become numeric
  zero through JavaScript coercion. Null, blank, and boolean values now remain
  missing evidence.
- The sequential specialist engine measured directional correctness after it
  had already subtracted its own answer. It now scores against the residual the
  specialist actually received.
- The specialist fit cache no longer prevents a later requested artifact from
  being persisted.
- The play simulator is now `pbp-drive-v3-cutoff-calibrated`; weekly empirical
  rates and play clock are calibrated from earlier plays only.
- The live ledger counts unique games by event id, not season/week pairs.
- Every possession prediction now preserves exact state, both team-card hashes,
  simulator version, simulator calibration hash, probabilities, classification,
  and later Brier/log-loss settlement.
- Historical reconstruction and `forward_live` predictions are separate values
  forever. A reconstructed row cannot be presented as forward proof.
- The blind-audit manifest now includes play-by-play, formations, charting,
  verified events, frozen vectors, frozen team cards, and genuine quote tape.
- PFR advanced weekly files are explicitly reported as beginning in 2024. A
  source 404 in 2022–2023 is visible source absence, not an all-zero player.
- Genuine book, line, price, provider snapshot time and book update time are
  stored separately. Consensus `game_lines` rows do not count as multi-book
  history. The Odds API remains optional; its historical endpoint requires a
  paid plan and key.

## 2021 policy

The new reconstruction sets `NFL_TRUSTED_HISTORY_START=2022` by default. The
2021 rows remain in the database so they can be diagnosed and repaired, but
they cannot enter the new rolling team/player vectors or act as the simulator’s
fallback season. The audit begins at 2022 Week 5, allowing four real 2022 weeks
to exist before the first evaluation. Nothing is silently zero-filled.

## Shared weekly state

Every target team receives one immutable pregame card containing the schedule,
environment, exact market snapshot, full roster/depth model, player ratings,
strictly prior tendencies, weekly high-dimensional vector, cutoff-safe official
injury reports, verified news, verified roster/trade events, coaching, officials,
and evidence hash. The simulator, player builder, specialist team and explanation
layer use that same card. If the same card identity later produces a different
hash, the system raises a conflict rather than rewriting history.

At the end of each finalized week the normal model-growth job now:

1. settles prior forward predictions;
2. ingests public weekly sources and play-by-play;
3. archives timestamped verified injuries, trades and weekly roster changes;
4. freezes next-week team and player vectors;
5. freezes one shared card per team;
6. recalibrates the play simulator from earlier plays;
7. refits specialists on the remaining chronological residual;
8. captures a source/feature coverage snapshot; and
9. freezes next-week forward predictions without auto-promoting them.

## Rebuild and audit command

```bash
node scripts/nfl-2022-2025-rebuild.mjs
```

The runner is checkpointed in `nfl_rebuild_checkpoints`. Restarting it skips
completed phases. It performs the public-source rebuild, verified event archive,
feature vectors, shared cards, calibration artifacts, specialist fits, a
content-addressed audit named:

```text
NFL 2022-2025 cutoff-safe reconstruction audit · shared weekly state v1
```

It then reconstructs possession boundaries. Set `NFL_LEDGER_TRIALS` or
`NFL_LEDGER_GAMES` to bound that final diagnostic phase. The untouched test is
still the 2026 `forward_live` ledger; no 2026 result may be used for fitting.

## Licensed and public sources

- nflverse: play-by-play, weekly player/team data, NGS, snap counts, depth,
  official injuries, weekly rosters, trades, formations, FTN charting, officials.
- ESPN: schedule, live score/play state, and operational news/scoreboard feeds.
- PFF: optional licensed adapter only. The application never scrapes PFF and
  never invents a grade when a licensed export is absent.
- Odds API: optional current and paid historical multi-book quote adapter.

More variables help only when they are timestamped, populated, stable across
years, and judged on later games. Coverage and missingness are therefore model
inputs and audit outputs, not cleanup details.
