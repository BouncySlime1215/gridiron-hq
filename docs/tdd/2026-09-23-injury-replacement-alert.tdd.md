# WV-02: injury replacement alert on the waiver board

Plan item B4 (Diligence Engine), work-queue unit WV-02. Branch
`claude/local-wv-02-injury-replacement-alert`, cut from `origin/main` at
`89f69b3b`.

## 1. Audit: extend or build

Decision: **extend** `server/services/waiver-wire.js#waiverBoard` and the waiver
card that already reads it. Nothing new is built where a producer exists.

| concept | existing producer (on `89f69b3b`) | used as |
|---|---|---|
| this week's designation (Out / IR / Doubtful) | `contingency.js:235 weekDesignation` (the more severe of the NFL report and ESPN's current status); its NFL input reaches the asset as `injury_status` (`trade-engine.js:480`, from `weeklyAvailability`, `contingency.js:933`) and ESPN's status is on the roster entry (`waiver-wire.js:173`) | reused, called with exactly those two inputs |
| IR | ESPN lineup slot 21 or `INJURY_RESERVE` (`waiver-wire.js:177`); `weekDesignation` maps `INJURY_RESERVE` to `out` | reused |
| feed injury flag ("news injury flag") | table `player_metrics`, `source='injury_flag'`, writer `syncSleeper` (`server/routes/aggregates.js:56`, insert at :77) | reused, only when it is current (see known defects) |
| current snap share | `contingency.js:357 roleStates`: mean `offense_pct` over a player's last three appearances before this week, seasons s-1..s, from table `player_week_snaps` (writer `syncSnapCounts`, `server/services/nflverse.js:287`, insert at :300) | reused; the same number that sets the availability role tier |
| a second snap-share number | `player-advanced-stats.js:208` (season mean of `offense_pct`, same table) on the player page | not used here; see "one number" below |
| next waiver processing time | none. `grep -rn -iE 'waiverProcess|acquisitionSettings' server client/src` returns no reader; the ESPN payload already carries `settings.acquisitionSettings` because `server/routes/leagues.js:125` requests `view=mSettings` | built (a pure function over the synced payload; no new table) |
| free agent pool, week projection | `waiverBoard`'s own `unowned` list and `weekPpg` (`waiver-wire.js:130,216`) | reused, so the alert and the claim list read the same numbers |

**One number, one producer.** Two snap-share producers exist on main:
`roleStates` (last three appearances) and `playerAdvancedStats` (season mean).
They answer different questions (current role vs season summary) and are
labelled differently on their surfaces. This unit uses `roleStates` because
"current" is what the unit asks for and because it is the number the
availability model already uses. The two are not unified here; follow-up named
in section 7.

No migration. No new table or column. Nav untouched (only the existing waiver
card on the Lineup page gains a block).

## 2. Pre-registration (committed before any number is run)

The fixture test (acceptance) is not statistical. The ranking rule is: the
alert orders same-team replacements by snap share, which feeds a waiver call.
STATS-METHOD rule 6 asks for a decision win rate against the dumb baseline, and
Nick's rule (e) asks for multiple past seasons by walk-forward as-of replay.

**Grounding.** Rate statistics built on opportunity (snaps, routes, targets)
stabilise in far fewer trials than outcome statistics built on scoring, so an
opportunity measure is the better short-sample estimate of a player's role
(Tango, Lichtman and Dolphin, *The Book*, 2007, on the reliability of rate
stats; the same logic is behind this repo's role tier, `contingency.js:320-327`,
fitted on 2021-2024). Re-using a held-out season erodes it with every look
(Dwork et al. 2015, *Science* 349:636), so 2025 is looked at once and ledgered.

- **Event.** A player P at QB/RB/WR/TE, role tier `starter` in `roleStates(s, w)`
  (share >= 0.60), listed `Out` (report_status matching `out|reserve|ir|pup|suspend`
  through `normReportStatus`) on table `nfl_injuries` for season s, week w.
- **Candidates.** Players with `roleStates(s, w)` team = P's team, same
  position, `gap_bucket` not null, not P, and not themselves Out or Doubtful
  on that week's report. An event needs at least two candidates.
- **Rule under test (snap).** Pick the candidate with the highest
  `roleStates` share. Ties broken by player id.
- **Dumb baseline (ppg).** Pick the candidate with the highest PPR points per
  game over the same last three appearances before w (the season-average pick
  a user has without a snap column). No consensus projection history is on
  file (table search in section 5), so this is the real baseline available.
- **Outcome.** Each pick's PPR points in week w from `player_week_usage`
  (receptions + 0.1 x rush/rec yards + 6 x rush/rec TD + 0.04 x pass yards
  + 4 x pass TD - 2 x INT - 2 x fumbles lost; no usage row = 0 points).
- **Metrics.** (1) decision win rate of snap over ppg on events where the picks
  differ, ties in points counted as half; (2) mean PPR difference
  (snap pick minus ppg pick) over all events, with a 90% bootstrap interval
  (2,000 resamples of events, seed 1). **Sign: positive favours snap share.**
- **Splits.** Primary: 2022-2024 pooled, walk-forward (every input is from
  before week w). Held-out: 2025, one look, ledgered. Forward: 2026 weeks already
  played where the report and usage exist.
- **Ship rule.** Snap-share ordering ships ON if, on 2022-2024: win rate on
  disagreements >= 0.50 AND the 90% interval of the mean difference has lower
  bound > -0.5 points (non-inferiority margin, a hand-set constant); AND on 2025
  the win rate on disagreements >= 0.50; AND on 2026 forward the win rate >= 0.50
  where there are at least 10 disagreements (else "forward not measurable",
  reported as such). If it fails, the same-team list is ordered by the ppg
  baseline instead, snap share stays visible, and the evidence says so.
- **Configuration.** No projection engine in the loop, so replay configuration B
  (STATS-METHOD rule 7) is not applicable; no k, no role recency option.
- **MDE.** Reported for every split at 80% power, two-sided alpha 0.10, for the
  win rate against 0.50: MDE = (1.645 + 0.842) x sqrt(0.25 / n).

## 5. The numbers (local copy, not production)

Command, on tree `fdbebc42` (script added in the result commit, no production code
changed between):

```
sqlite3 ~/gridiron-local/data.sqlite ".backup '.local-db/data.sqlite'"
GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite GRIDIRON_DB_INTEGRITY_CHECK=off SCHEDULER_DISABLED=1 \
  node scripts/wv02-injury-replacement-history.mjs
```

Inputs: tables `nfl_injuries`, `player_week_usage`, `player_week_snaps`, `players`
(read only). Known-nonzero control: 272 primary events found, so the empty 2026
split below is small, not broken.

Sign: positive favours snap share. Win rate counts point ties as half.

| split | events | picks differ | snap win rate when they differ | MDE (80% power) | mean PPR diff, all events [90% CI] |
|---|---|---|---|---|---|
| 2022-2024 (primary) | 272 | 98 | 0.531 | 0.126 | -0.179 [-0.772, +0.385] |
| 2025 (held out, one look, L154) | 120 | 29 | 0.672 | 0.231 | +1.013 [+0.039, +1.987] |
| 2026 forward (F001) | 3 | 1 | 1.000 | 1.244 | not measurable |

By position on the primary split, where picks differ: WR 72 (0.507), TE 19 (0.711),
QB 4 (0.000), RB 3 (0.667). Only WR has enough cases to say anything.

**Ship rule verdict: FAIL.** Win rate 0.531 >= 0.50 passes, but the primary
interval's lower bound (-0.772) is below the -0.5 non-inferiority margin. 2025 holds
(0.672), 2026 is not measurable (1 disagreement; rule needs 10). So snap-share
ordering ships **default-off, "unconfirmed"**, as the pre-registration says.

Decline read (STATS-METHOD rule 4): the primary split can detect a win rate 12.6
points away from 0.50 at 80% power; the observed +3.1 is well inside that, so this
is "not shown non-inferior", not "snap share is worse". The two picks agree on 64%
of primary events and 76% of 2025 events, so the order question only touches about
a third of alerts.

**Deviation from the pre-registration, stated.** The fallback said "ordered by the
ppg baseline". The baseline's last-three-appearances PPR ppg has no producer in
the app, and adding one would put a second recent-points number next to the week
projection (one number, one producer). The default order is instead this week's
projection (`weekPpg`, the number the claim list ranks on and STATS-METHOD rule 6's
"add highest projected FA" baseline). That order was **not** graded historically:
no as-of projection history is replayed here. Snap share stays on every row, and
the snap-share order is one option away (`sameTeamOrder: 'snap_share'`).
