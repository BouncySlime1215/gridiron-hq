---
name: gridiron-planner-role-and-path-facts-2026-09-22
description: R&D-cleanup thread is now the Planner in Nick's three-stage R&D loop; plus the consumer-path facts every plan depends on (what actually reaches a served projection).
metadata:
  type: project
  modified: 2026-09-22T08:44:00.000Z
---

**Role, Nick 2026-09-22 08:07Z** ("ONE EXPLORES - ONE SEES IF WE CAN DO IT AND PLANS
IT - then sends it to the plan - then repeat"): three-stage loop. Data & techniques
R&D **explores and prices**; this thread (`claude/project-thread-2oztzw`) is the
**Planner** — feasibility + build spec + a one-line "can we do it" for Nick; a
**builder** implements (Fantasy plan owns `projections.js`); Auditor gates each unit.
**The Planner does not build.** Sweeps are what this thread does when the queue is
empty. Coordinator adds a second planner if the backlog passes eight.

Plan shape: (1) feasibility — data ingested? which table? which file owns it? does a
consumer exist or need wiring? what is the incumbent? (2) build spec — files,
functions, the RED test that fails today, gate metric, Auditor criteria verbatim;
(3) one-line yes / yes-with-X / no-because.

Delivered: **PLAN 01** `/mnt/project-files/PLAN-01-graded-injury-participation-2026-09-22.md`.

## CONSUMER-PATH FACTS — verified by grep, reusable by every future plan
- **`projections.js` IS the production path.** Imported by `player-week-engine.js`,
  `ros-projection.js`, `season-sim.js`, `ceiling-lineup.js`, `trade-engine.js`,
  `draft-assist.js`, `week-postmortem.js`.
- **`projections.js` has NO injury-report term.** Its "availability" is a *role*
  forecast — share of team games historically played — and says so at `:601-608`:
  "This is a *role* forecast, not an injury forecast."
- **`role-scenario-engine.js` does NOT reach a served projection.** Chain:
  role-scenario-engine → role-scenario-lab (sole importer) → nfl-research-lab (sole
  importer) → `routes/nfl-market.js` as research-lab STATUS. Any plan told to "beat
  the incumbent at role-scenario-engine.js:127" is being pointed at a lab.
- **The injury grading already exists and is thrown away.**
  `measureInjuryEffect` (`nfl-player-context.js:307-308`) buckets into clean /
  questionable / limited / dnp_but_played / returning; `limitedRoleMultiplier`
  (`role-scenario-engine.js:96-108`) pools two of the five into one clamped scalar
  and ignores two more.

## THE LOOK-AHEAD TRAP (applies to any injury-designation work)
`nfl_injuries` **UPSERTs in place** (`nfl-advanced.js:356-360`), so it holds only the
FINAL designation — "Wednesday's full participation leaves no trace once Friday's
designation overwrites it." **Fitting a lineup-lock projection on `nfl_injuries` is a
look-ahead leak.** The as-of history lives in `nfl_feature_revisions` via
`nfl-bitemporal.js`, already read that way by `nfl-t60-packet.js`. Fit and serve from
the revision store with an explicit as-of stamp. NOT yet measured: whether
`nfl_feature_revisions` has enough per-season depth to fit on.

## Evidence-line rule for specs (coordinator 08:23Z, tightened 08:28Z)
Name the offline rig — `/mnt/project-files/load-rig.mjs`, `replaySeasonWeekly` +
`pairedBootstrapDiff` — and put **"rig, not production"** in the same sentence as
every number. **The Auditor has adopted the rig for DIRECTIONS ONLY, NEVER MAGNITUDES:
quote a rig direction, never a rig gain as an expected production gain.**

**THE RIG CANNOT SEE ABSENCES.** nflverse weekly stats carry no row for a player ruled
Out — 2023: 980 Out rows, 288 map to skill players, **zero** have a usage row. So a rig
null on any absence-related term is an **under-powered non-test, not a failure**. This is
why #17 was withdrawn by the Explorer itself, and the same limit binds #13/#14 and
PLAN 01 and PLAN 02: **do not set those gates on a rig figure until the rig has absence
rows** (Explorer's next strand).

**Auditor condition B:** every rig submission must state which of `nfl_snaps`,
`nfl_injuries`, `nfl_qbr_weekly`, `nfl_depth` the change touches, and **"cannot tell"
replaces any null the rig returns on those**.

## SATURATION CAP — 7.4083-7.8177 at throughWeek 18 (unit 15 08:49Z; 7.55-7.89 withdrawn)
Weekly-path `n` cap, a range by bye placement, ALWAYS quoted with throughWeek:
**7.4083-7.8177 at throughWeek 18**; **7.2282-7.6985 at throughWeek 17**. 7.725, 8.13,
8.62 and 7.55-7.89 are all superseded. Consequences (throughWeek 18):

| constant | positional prior keeps, permanently |
|---|---|
| `K.share = 6` | **43.4%-44.7%** (43.8-45.4% at throughWeek 17) |
| `K.team_volume = 10` | **56.1%-57.4%** |

## PLAN 03 finding — `positionalPriors` has NO recency weighting at all
`projections.js:386-405`: `positionalPriors(log)` takes only `log` and iterates
**unweighted** — no `recency`, no `roleRecency`, no `seasonWeight`, no decay. A 2022
player-week counts the same as a 2025 one. So the player's own share IS recency-weighted
(`rr` at `:453`) while **the prior he is shrunk toward lags by construction and always
will** — structurally, not with a half-life. Combined with the cap above: **43-44% of
every TE's projected target share is a flat, unweighted, stale positional average**, and
no amount of playing time reduces it. Consumer is `projections.js:465` inside
`buildProjections` — the served path, seven production importers.

## Queue state 08:30Z
Live: snap-share term, TE drift, volume-side K (K.share=6 / K.team_volume=10),
#14 baseline under-scaled 5%. Held for a rig re-measure: #17 committee split.
**Withdrawn by the Explorer, do NOT plan against: #8 and #11** (every larger
`K.yards_per` is monotonically worse on the rig; "raise 34" is dead, 34 stays pending
the Auditor). #15/#16 are negatives — record, never re-explore.

Related: [[gridiron-feed-zero-contamination-2026-09-22]],
[[gridiron-cleanup-thread-stop-2026-09-22]], [[gridiron-v2-outage-version-bump]].
