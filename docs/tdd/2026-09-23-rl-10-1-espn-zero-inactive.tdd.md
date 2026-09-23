# RL-10-1: ESPN projects 0 feeds SS-01's inactive hook

Unit RL-10-1 (plan item Diligence Engine SS-01). Branch `claude/local-rl-10-1-espn-zero-inactive-feed`,
built on PR #185 (`claude/local-ss-01-dead-starter-guard`, head 8985e03c) because #185 is **not merged**
(`git merge-base --is-ancestor 8985e03c origin/main` -> not an ancestor, 2026-09-23), then merged with
origin/main (ca64b2cc) as 85de71fe.

## 1. Audit: extend or build

| What | Where | Finding |
|---|---|---|
| The hook | `server/services/dead-starters.js:45-49` `NO_LIVE_INACTIVES` (PR #185) | `covered: false`, empty `ids`; `deadReason()` checks it LAST (`:82`), after IR, season-ending, the canonical Out/Doubtful (`contingency.js#weekDesignation`) and bye. So a player already Out/Doubtful/IR can never come back as `inactive`. |
| Call site | `server/services/lineup-brain.js:420` `lineupCall(..., inactive = NO_LIVE_INACTIVES)`, `:455` `deadStarters(...)`; route `server/routes/trades.js:220` (`GET /api/trades/:leagueId/lineup`) never passes `inactive` | Every live request gets the empty hook. |
| The data | table `league_roster_snapshots` (migration 058); writer `scripts/collect-roster-snapshots.mjs:65` `rowsFromEntries` (`projected_points` at `:92`, `periodPoints(pl.stats, season, period, 1)` = ESPN statSourceId 1), written by `writePeriod` (`:108`); run by the local refresh loop `scripts/refresh-live-data.mjs:128` | Already stored every capture, per league/week/team/player, with `injury_status`. No migration needed. |
| Other inactive producers | `grep -rn -i inactive server/services` on this tree: only `dead-starters.js` and the regex in `beat-reporter-accuracy.js:42` (a text classifier for beat reports, not an availability feed). RL-3-2's `live-inactive-monitor.js` / Bluesky arm (PR #184) is not on this tree. | No existing producer of "gameday inactive". This unit is the one producer; #184 is deliberately **not** wired. |
| Card | `client/src/pages/Lineup.tsx:122-136` renders `dead_starters.items[].why` | `SENTENCE.inactive` says "is on the gameday inactive list", which would be false for a projection-based signal. The sentence must name the source. |

**Decision: extend.** New producer `server/services/espn-zero-inactive.js` returns the hook's shape
(`covered`, `source`, `reason`, `ids`) plus the sentence to print; `lineupCall()` uses it when the caller
passes no `inactive`. `dead-starters.js` only learns to print the hook's own sentence.

## 2. Pre-registration (committed before any number is run)

Historical grade already exists and is cited, not re-run: `rnd/loop/r10-external-espn-zero-is-the-inactive-feed.md`
(R&D round 10, 2021-24 REG, ESPN retained at-lock projections + nflverse): recall 220/238 (92.4%) of
fantasy-relevant Q-or-undesignated gameday inactives had ESPN at 0; precision 630/704 (89.5%) of relevant
players at 0 did not play. That was measured **at ESPN's final pregame projection**; when ESPN flips to 0
on a Sunday (timing) is untested (RL-10-2 poller, W4-W5).

Literature grounding: using a bookmaker/aggregator's own posted number as the signal rather than re-deriving
it follows the efficient-market result that public information is priced into the close (Fama 1970;
for NFL betting markets, Levitt 2004, *Economic Journal*); an availability flag here is a classifier, so it is
graded on precision and recall against the realised label (Davis & Goadrich 2006, ICML) rather than MAE.

Forward check on 2026 (weeks already played), local copy, not production:

- **Hypothesis.** Among rostered QB/RB/WR/TE rows in `league_roster_snapshots` for 2026 week w (w >= 2),
  with max `projected_points` >= 5 in week w-1 (any team), `projected_points` < 0.05 in week w, ESPN
  `injury_status` not mapping to Out/Doubtful through `contingency.js#weekDesignation` (OUT, DOUBTFUL,
  INJURY_RESERVE, SUSPENSION...), and not on bye in week w, the player did not play.
- **Label.** Did not play = no `player_week_snaps` row with `offense_snaps` > 0 for (player, 2026, w)
  (writer `server/services/nflverse.js:287` `syncSnapCounts`). The label is only used for weeks where
  `player_week_snaps` has 2026 rows (known-nonzero control: count of rows for that week > 0 first).
  Deduplicate by player per week (one player can be in several leagues).
- **Metric.** Precision = did-not-play / flagged; also mean `actual_points` of flagged players who played.
  Recall (forward): among relevant (prior >= 5), not Out/Doubtful/IR, not-bye rostered players with no
  snaps, the share flagged.
- **Held-out split.** 2026 W2-W3 only (forward). 2025 is not opened (every query filters season = 2026).
- **Baseline.** The dumb baseline "start the highest ESPN projection" already benches a 0 projection; the
  guard's decision is against the **submitted** lineup (keep the starter). Decision win = flagged starter
  scored 0 (any healthy bench player with a projection beats him); reported as a rate with n.
- **Sign convention.** None signed; rates are shares in [0, 1].
- **Ship rule.** Default-ON if forward precision >= 0.80 on n >= 5 flagged players. If n < 5 (not enough
  forward data), the flag ships **default-off, labelled "unconfirmed forward"**, per Nick's rule (b), with
  the MDE reported; if n >= 5 and precision < 0.80, decline.
