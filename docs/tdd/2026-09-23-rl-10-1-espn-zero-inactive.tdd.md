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
| The data | table `league_roster_snapshots` (migration 058); writer `scripts/collect-roster-snapshots.mjs:65` `rowsFromEntries` (`projected_points` at `:92`, `periodPoints(pl.stats, season, period, 1)` = ESPN statSourceId 1), written by `writePeriod` (`:109`); run by the local refresh loop `scripts/refresh-live-data.mjs:128` | Already stored every capture, per league/week/team/player, with `injury_status`. No migration needed. |
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

## 3. RED / GREEN

- **RED** `test: RL-10-1 RED, ESPN projects 0 feeds the dead-starter inactive hook` (9b376078). Stub producer
  returning an empty, uncovered hook. 3 of 5 fail: `RED acceptance ...` fails at
  `assert.equal(hook.covered, true, 'week-2 and week-1 snapshots exist')` (expected true, actual false);
  the card test fails at `assert.equal(item?.reason, 'inactive')` (actual undefined); the no-snapshot test
  fails at `assert.match(hook.reason, /league_roster_snapshots/)` (actual 'not built').
- **GREEN** `feat: RL-10-1 ESPN projects 0 feeds the dead-starter inactive hook` (dd81c748).
  `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/espn-zero-inactive.test.js`
  -> pass 5 fail 0; same command on `test/dead-starter-guard.test.js` (PR #185's file, unchanged) -> pass 9 fail 0.

## 4. What it does

`GET /api/trades/:leagueId/lineup` (`server/routes/trades.js:220`) -> `lineupCall()` (`lineup-brain.js:420`)
now passes `espnZeroInactive(lg.id, { season, week })` as the dead-starter guard's `inactive` hook unless a
caller supplies one. A starter ESPN projected at >= 5 last week and at 0 now, who is not already
Out/Doubtful/IR/Suspended, shows on the red Start/Sit card as "<name> (<slot>) ESPN projects 0: likely
inactive. Start <bench player> instead", with a second line naming the source: ESPN's weekly projection from
the league roster snapshot, 92% of surprise scratches at 0 **at ESPN's final pregame projection**, "timing
not yet tested". `dead_starters.inactive_source` carries `covered`, `source: 'espn_projection_zero'`, the
capture time and the label. No migration, no new table or column; `items[].source_label` is read by
`client/src/pages/Lineup.tsx`.

## 5. Numbers (local copy, not production)

DB: `sqlite3 ~/gridiron-local/data.sqlite ".backup '.local-db/data.sqlite'"` at 2026-09-23 07:39 local; tree dd81c748.

- Coverage of the source: `select scoring_period_id, source, count(*), sum(projected_points<0.05) ... from
  league_roster_snapshots where season=2026 group by 1,2` -> W1 final 753 rows (29 at 0), W2 final 757 (58),
  W3 live 789 (58). Final rows carry **no** `injury_status` (all null; W3 live rows do).
- Label control: `player_week_snaps` 2026 has W1 524 rows / W2 517 rows, none for W3. Of 147 relevant
  (W1 ESPN >= 5) rostered QB/RB/WR/TE in W2, 132 have offense snaps > 0 (known-nonzero control for the label).
- **Liveness** (producer on the copy, `node scratchpad/live.mjs` with `GRIDIRON_DB_PATH=.local-db/data.sqlite`):
  W2 flags per league [5,8,6,8,11], 11 distinct players; W3 flags 0. Known-nonzero control for the W3 zero:
  7 distinct W3 rows have prior >= 5 and projection 0, all ESPN DOUBTFUL, so the producer excluded them
  (the "not double-flagged" rule on real rows). `lineupCall(<league 1>)` returns
  `inactive_source {covered: true, source: 'espn_projection_zero'}`, week 3.
- **Forward check (pre-registered, section 2), 2026 W2, with two deviations recorded here:**
  1. The pre-registered Out/Doubtful filter used ESPN `injury_status`; W2 final rows have none, so the filter
     could not run as written. Substituted the other half of `weekDesignation`, the NFL report
     (`nfl_injuries.report_status`, joined on `players.gsis_id`), after the first query. Split of the 11 flagged:
     report Out 4, Doubtful 1, Questionable 3, none 3.
  2. After listing the rows, the label was tightened to "no offense snaps AND actual_points = 0": one
     relevant RB with no `player_week_snaps` row scored 11.2, so the snap table has mapping holes.
  - Precision, surprise slice (Q or none): **6 of 6 did not play** (all 11 flagged did not play).
    Exact 95% lower bound 0.54 for 6/6 (0.715 for 11/11). `python3 -c "print(0.025**(1/6))"`.
  - Recall, surprise slice: 6 of 7 relevant Q-or-none players who did not play were at 0 (86%; historical 92%).
  - MDE at 80% power: with n = 6 an exact one-sided test of precision >= 0.80 (alpha 0.05) only detects a
    true precision of 0.27 or lower; n = 30 would detect 0.57. So the forward check can catch a broken
    signal, not a modest drop from 0.90. (Binomial enumeration in the session, `python3` with `math.comb`.)
  - **Ship rule:** n = 6 >= 5 and precision 1.00 >= 0.80 -> **default-ON**. Caveat: passed under
    deviation 1, on one week, and on captures taken after the games (the at-lock projection), so it says
    nothing about Sunday timing.
  - Decision grade (anecdote, one week): 38 league-roster instances flagged in W2, 2 of them set as starters;
    both scored 0, so the swap to any projected bench player wins 2 of 2. The dumb baseline "start the
    highest ESPN projection" would also have benched them; the guard's value is against the submitted lineup.
- Historical grade (multi-season, walk-forward): not re-run; cited from R&D r10
  (`nice -n 10 python3.12 -u rnd/loop/scripts/r10x_espn_zero_flag.py` -> `data/r10x-espn-zero-flag-output.txt`,
  2021-24 REG, weeks 2-17): recall 220/238, precision 630/704, false flags averaged 2.84 PPR.

Holdout looks: none. 2025 was not opened (every query filters season = 2026), so no
`docs/evidence/HOLDOUT-LEDGER.md` row is owed.

## 6. Mutation test (`python3 scratchpad/mut.py`, test/espn-zero-inactive.test.js, tree dd81c748)

| Mutant | Result |
|---|---|
| M1 PRIOR_MIN 5 -> 5.01 | killed (RED acceptance) |
| M2 drop the already-Out check | killed (RED acceptance) |
| M3 ZERO_MAX 0.05 -> 0.5 | killed (RED acceptance) |
| M4 drop `on_roster = 1` | killed (RED acceptance) |
| M5 status check reads only pregame_injury_status | killed (RED acceptance) |
| M6 call site: producer not called (lineup-brain.js) | killed (card test) |
| M7 call site: caller-supplied hook ignored | killed (caller-hook test) |
| M8 card: hook sentence ignored (dead-starters.js) | killed (card test) |
| M9 card: source_label dropped | killed (card test) |
| M10 prior MAX -> MIN (**designed survivor**) | survived: fixtures put each player on one team, so a player traded mid-week with two prior rows is untested |
| M11 not-applied control | not applied (harness reports it, no false kill) |

## 7. Known defects

- Timing untested: the 92% recall is at ESPN's final pregame projection; the app only sees what the local
  refresh loop captured (`as_of` on the hook). RL-10-2's W4-W5 poller answers when ESPN flips.
- Final (post-week) snapshot rows carry no ESPN status, so for a past week the producer's ids can include
  NFL-report Out players; on the card `deadReason()` checks the NFL report and ESPN status first, so they show
  as Out, never twice. For the current week the live rows carry ESPN status.
- The source is written only by the local refresh loop (`scripts/refresh-live-data.mjs:128`); where it has not
  run for the week, the hook is `covered: false` and says why.
- M10 survivor above (multi-team prior rows).
- The first schema look (`.tables`) was run read-only against `~/gridiron-local/data.sqlite` before the copy
  was made; every number above is from the copy.

## 8. Nick's five questions

1. **Well built?** One new module, three one-line call-site changes, no migration; 5 tests, 9 of 9 behaviour
   mutants killed, PR #185's own 9 tests still pass.
2. **Stats or made up?** The 92% / 90% are R&D r10's measured 2021-24 rates; the 2026 check is 6 of 6 on W2
   (small; MDE says it only rules out a broken signal).
3. **How do we know?** Section 5 commands on the local copy; the flag fired on 11 real W2 players who all sat.
4. **Pointed elsewhere?** It reads the snapshot table the refresh loop already writes; nothing else changes.
   The Bluesky arm (#184) is deliberately not wired.
5. **How it unifies?** One producer of "likely inactive" (`espn-zero-inactive.js`), consumed through SS-01's
   single hook; Out/Doubtful still come from `contingency.js#weekDesignation`, so the card cannot disagree
   with Start/Sit's week_points.
