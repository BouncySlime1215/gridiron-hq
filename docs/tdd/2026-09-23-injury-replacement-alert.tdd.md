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

## 3. RED / GREEN

All tests: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> node --experimental-test-module-mocks --test --test-reporter=tap test/waiver-injury-alerts.test.js`.

| step | commit | result |
|---|---|---|
| pre-registration | `f1cc794a` docs: pre-register WV-02 injury replacement ranking check | before any number |
| RED 1 | `9ccfdc32` test: RED for WV-02 injury replacement alert on the waiver board | 0 pass / 5 fail on `origin/main` code; first failure `assert.ok(Array.isArray(out.injury_alerts), 'the board carries injury_alerts')` -> `expected: true, actual: false`; also `nextWaiverRun is not a function` |
| GREEN 1 | `fdbebc42` feat: WV-02 injury replacement alert on the waiver board | 5 / 5 pass; with `test/decision-leftovers-waivers.test.js` 12 / 12 |
| result | `d64561dd` docs: WV-02 walk-forward result, snap-share order fails its non-inferiority bound | section 5; ledger rows L159, F004 |
| RED 2 | `cfc4edaa` test: RED for WV-02 default same-team order after the snap-share check failed | 4 pass / 2 fail on `fdbebc42` code: `assert.deepEqual(alert.replacements.same_team.map(r => r.player), ['Handcuff Low', 'Handcuff High'])` got `['Handcuff High', 'Handcuff Low']`; `assert.equal(r.order, 'snap_share')` got `undefined` |
| GREEN 2 | `a5660d52` feat: WV-02 same-team order defaults to projection, snap-share order default-off | 6 / 6; with decision-leftovers 13 / 13 |
| mutants | `57bf864d` test: WV-02 kill surviving mutants (waiver-hour boundary, teammate as best FA, clock-independent date) | 7 / 7 |

The fixture in RED 1 was written for snap-share order (the unit row's wording).
The pre-registered check then failed, so RED 2 changed that one assertion to the
default order and moved the snap-share assertion under its option. The test was
changed because the evidence changed the rule, not to make code pass.

## 4. What it does

`GET /api/trades/:leagueId/waivers` (`server/routes/trades.js:670`) ->
`waiverBoard` (`server/services/waiver-wire.js`) now also returns:

- `injury_alerts[]` (`waiver-wire.js:331,352`, built by
  `injuryReplacementAlerts`, `:502`): one per starter of mine (ESPN lineup slot
  not bench 20 / IR 21, kept on the roster row at `:183`) whose designation from
  `weekDesignation` (via `designationOf`, `:463`) is `out` (includes IR and
  suspension) or `doubtful`, or who has a current feed injury flag
  (`currentFeedFlags`, `:453`) and no designation at all. Questionable does not
  alert. Each alert carries `replacements.same_team` (up to 3 healthy, claimable
  same-team same-position players, free agents or already mine, each with
  `snap_share`, `projected_ppg`, `on_your_roster`), `same_team_count`, `order`,
  `ranked_by`, `best_free_agent` (highest this-week projection at the position on
  another NFL team, from the board's own free-agent pool) and `claim_by`.
- `waiver_run` (`nextWaiverRun`, `:420`): the next processing day and hour from
  `payload.settings.acquisitionSettings`, read on a US Eastern clock (a guess,
  labelled `zone_basis`), or `{ known: false, reason }`.
- Reader: the waiver card on the Lineup page, `InjuryAlerts`
  (`client/src/components/lineup/WaiverWire.tsx:153,386`), shown above the claims
  only when there is an alert. `client/src/pages/Lineup.tsx:264` renders the card.
  SK-01 (command center) can read the same field later; nothing else reads it yet.

**Liveness on real rows** (local copy, not production; tree `57bf864d`; scratch
script calling `waiverBoard(lg, {})` for each of the 5 synced leagues, output
counts only). Independent count: my starters whose ESPN `injuryStatus` is OUT,
DOUBTFUL or INJURY_RESERVE, straight from each payload.

| league | starters | ESPN-hurt starters (independent) | alerts | source / designation | same-team options | best FA | waiver run |
|---|---|---|---|---|---|---|---|
| 1 | 9 | 1 | 1 | espn / doubtful | 2 | yes | WED 2026-09-23 h11 |
| 2 | 9 | 0 | 0 | | | | WED 2026-09-23 h11 |
| 3 | 9 | 1 | 1 | espn / doubtful | 2 | yes | WED 2026-09-23 h11 |
| 4 | 9 | 0 | 0 | | | | WED 2026-09-23 h11 |
| 5 | 9 | 0 | 0 | | | | WED 2026-09-23 h11 |

The alert count equals the independent count in all five leagues. In league 1
the top same-team option has no snap rows yet (`snap_share: null`), shown on the
card as "no snaps yet".

Feed-flag control: `SELECT COUNT(*), SUM(f.fetched_at >= r.fetched_at) FROM
player_metrics f JOIN player_metrics r ON r.player_id=f.player_id AND
r.source='sleeper_rank' WHERE f.source='injury_flag' AND f.value>0` -> `234|234`.
Every flag on the copy is current because only one Sleeper sync has run
(2026-09-22 19:45:31), so the staleness guard has nothing to exclude yet; it is
proven by the fixture and mutant M3 only.

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
| 2025 (held out, one look, L159) | 120 | 29 | 0.672 | 0.231 | +1.013 [+0.039, +1.987] |
| 2026 forward (F004) | 3 | 1 | 1.000 | 1.244 | not measurable |

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

## 6. Mutation sweep

Harness: each mutant is a string replacement in `server/services/waiver-wire.js`,
applied, the test file run, the file restored (scratch script; a mutant whose
text is not found reports NOT APPLIED). Run on `a5660d52`'s tests and again on
`57bf864d`'s.

| mutant | tests at `a5660d52` | tests at `57bf864d` |
|---|---|---|
| M1 drop `doubtful` from `ALERT_DESIGNATIONS` | killed | killed |
| M2 count a bench slot as a starter | killed | killed |
| M3 remove the feed-flag freshness condition | killed | killed |
| M4 allow teammates on other rosters | killed | killed |
| M5 waiver-hour boundary `>=` -> `>` | **survived** | killed (on-the-hour case added) |
| M6 call site: `roles: new Map()` instead of `roleStates(...)` | killed | killed |
| M7 call site: `sameTeamOrder` not forwarded | killed | killed |
| M8 call site: `nextWaiverRun(payload, new Date())` ignores `now` | **survived** (fixture date was the day before the real clock, so the real clock gave the same Wednesday) | killed (fixture moved to 2026-10-06) |
| M9 best free agent may be a teammate | **survived** | killed (teammate at 14 ppg added) |
| M10 default order flipped to snap share | killed | killed |
| S1 designed survivor: `SAME_TEAM_SHOWN` 3 -> 4 (fixture has 2 teammates) | survived | survived, as designed |
| C1 not-applied control (text absent) | NOT APPLIED | NOT APPLIED |

**Correction (skeptic review, 2026-09-23).** The table above said "M1-M10 all
killed" and offered that as the test-strength claim. That overstated the sweep: it
never tried the `healthy()` filters or the own-roster branch. An independent
skeptic ran three more mutants on `e022aaca`'s tests and all three survived
(`# pass 7 # fail 0`). Commit `f6f9234c` adds one test (an Out and a Doubtful
same-team free agent, an Out other-team free agent projecting above Other Back,
and a healthy same-team back on my own bench). Same harness, re-run on `f6f9234c`
(each mutant applied with perl, test file run, `git checkout` restores the file):

| mutant | tests at `e022aaca` (skeptic) | tests at `f6f9234c` |
|---|---|---|
| U1 same-team filter drops `&& healthy(a)` | survived (7/7) | killed: 7 pass / 1 fail, "an Out teammate is not a replacement" |
| U2 same-team filter `(holder == null \|\| holder === rosterId)` -> `(holder == null)` | survived (7/7) | killed: 7 pass / 1 fail, same_team missing 'My Bench Back' |
| U3 best-free-agent filter drops `&& healthy(a)` | survived (7/7) | killed: 7 pass / 1 fail, best_free_agent 'Hurt Other Back' instead of 'Other Back' |

Unmutated `f6f9234c`: 8/8 pass. S1 still survives by design: the new fixture has
exactly 3 healthy same-team backs, so showing 4 changes nothing. Command for every
row: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node
--experimental-test-module-mocks --test --test-reporter=tap test/waiver-injury-alerts.test.js`.
M1-M10 were not re-run on `f6f9234c`; the commit only adds a test, so no earlier
kill can turn into a survivor.

## 7. Known defects and follow-ups

1. **Feed flag never clears** (writer `syncSleeper`, `server/routes/aggregates.js:76-78`,
   table `player_metrics`): it sets `injury_flag = 1` for any Sleeper injury status,
   Questionable included, and never resets it. This unit reads a flag only when it
   is at least as new as the same player's `sleeper_rank` row, and only when no
   designation exists. The writer fix belongs to whoever owns `aggregates.js`.
2. **The waiver hour's zone is a guess** (US Eastern). ESPN's settings give an hour
   with no zone. The page says "guess". If ESPN means another zone, the date can be
   off near midnight and the hour label is wrong.
3. **Two snap-share producers**: `roleStates` (last three appearances, used here and
   by availability) and `playerAdvancedStats` (season mean, player page,
   `server/services/player-advanced-stats.js:208`). Not unified here; follow-up:
   label the player-page one "season snap share" or switch it to `roleStates`.
4. **Default order not graded historically.** This week's projection orders the
   same-team list; no as-of projection replay was run for this ordering.
5. **ESPN leagues only.** `waiverBoard` reads the ESPN payload shape; a Sleeper
   league's board returns its existing error and no alert.
6. The acceptance line says "snap-share-ranked replacement"; per the pre-registered
   check the default order is projection and snap share is shown on each row. Nick
   decides whether to switch the default on the 2025 result alone (0.672), which
   the pre-registered rule does not allow.

## 8. Nick's five questions

1. **Well built?** It extends the existing waiver board and card; no new table,
   column or migration; parameterised SQL (one `IN (?,...)` read of
   `player_metrics`); no bare catch; nav unchanged (only
   `WaiverWire.tsx` gains a block). 7 targeted tests, 11 of 11 applied mutants
   behave as designed after the fixes.
2. **Stats or made up?** The trigger is the app's own designation
   (`weekDesignation`); the snap share is the availability model's number
   (`roleStates`); the deadline is ESPN's own setting. The -0.5 point
   non-inferiority margin and the US Eastern zone are hand-set (the zone is a
   guess).
3. **How we know.** Fixture tests plus a walk-forward check on 2022-2024
   (272 Out-starter events): snap-share pick won 0.531 of 98 disagreements, mean
   difference -0.179 PPR [-0.772, +0.385]; 2025 held out 0.672 of 29, +1.013
   [+0.039, +1.987]; 2026 not measurable. Failed its non-inferiority bound, so
   snap order is default-off. Live: alert count matched an independent count in 5
   of 5 leagues (local copy, not production).
4. **Pointed anywhere else?** Only the waiver card reads `injury_alerts` today;
   SK-01's command center is the named future reader. `SS-01`'s dead-starter guard
   (not on main) should reuse `injuryReplacementAlerts`' trigger rather than add a
   second one.
5. **How it unifies.** One designation producer (`weekDesignation`), one snap-share
   producer for "current" (`roleStates`), one week number (`weekPpg`, the same one
   the claim list ranks on), one free-agent pool (the board's own). The second
   snap-share producer on the player page is named above, not merged.

## 9. Baseline availability (the table search the pre-registration names)

`sqlite3 .local-db/data.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND
(name LIKE '%proj%' OR name LIKE '%consensus%' OR name LIKE '%espn%')"` -> `espn_settings
espn_cache espn_line_moves espn_player_market espn_player_market_weekly`. The only
per-week projection table, `espn_player_market_weekly` (`week_proj`), holds 1,042 rows,
all 2026 week 2 (`SELECT season, COUNT(*), MIN(week), MAX(week) ... GROUP BY season` ->
`2026|1042|2|2`). No past-season ESPN or consensus projections exist to grade against,
so the recent-points pick is the real baseline available for 2022-2025. The HX-01
harness, once merged, is the place to re-grade against ESPN projections.
