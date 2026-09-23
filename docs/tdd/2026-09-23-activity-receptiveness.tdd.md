# RL-11-1: manager activity in trade receptiveness ("chance he completes a trade")

Unit RL-11-1, plan item B6 (receptiveness). Branch `claude/local-rl-11-1-activity-receptiveness`,
cut from origin/main `ad3bb9f6`. Pre-registration:
`docs/evidence/2026-09-23/activity-receptiveness-preregistration.md`, committed before any number.

## 1. Audit: extend or build

Greps on `ad3bb9f6` (`git grep -n <term> -- server client scripts test`):

- **Receptiveness has one producer**: `counterpartyLayer` in `server/services/counterparty-pricing.js:241`,
  score at `:312-340` (chat openness, `tx_accept_rate` blend at `:323-327`, Nick's priors, `postLossFactor`).
  Readers: `trade-engine.js:1708` (`managerFactor = counterparty.receptiveness * tierFactor(tier)`),
  `routes/trades.js:388,480-490` (the Brain managers board), `serializeManagerRead` `:862` (ManagerRead card),
  `valuationMap` `:975-987`. **Extend**, do not build a second score.
- **Activity is computed and read by nothing**: `tx_waiver_moves` (`manager-signals.js:221`, writer `txSignals`
  `:201`, table `manager_signals`, written by `buildManagerSignals` `:365`, insert at `:424` (line numbers on `ad3bb9f6`)). Hits: the definition and one test
  assertion (`test/manager-data-pipeline.test.js:346`). Known-nonzero control: `tx_accept_rate` has readers at
  `counterparty-pricing.js:323-326` and the factor entry.
- **Unit map, ESPN rows to adds**: on a local copy (not production), 2026, executed WAIVER/FREEAGENT rows = 134,
  ADD items in them = 134, DROP items = 105. One add per row today, so `tx_waiver_moves` = adds on this data;
  the new metric counts ADD items so a multi-add row would still count right.
  `sqlite3 .local-db/data.sqlite "select json_extract(j.value,'$.type'), count(*) from league_transactions_raw t, json_each(t.items_json) j where season=2026 and t.type in ('FREEAGENT','WAIVER') and t.status='EXECUTED' group by 1"`.
- **No weeks denominator exists**: `tx_waiver_moves` is a season count. The per-week rate is new
  (`tx_adds_per_week`, n = weeks averaged over).
- **Dead starters, two concepts**: `lineup_dead_starters` (`manager-signals.js:318-323`, `rosterSignals`) counts
  OUT/IR/DOUBTFUL players in the CURRENT, unlocked lineup from `leagues.payload`, read by nothing but the generic
  signal list on ManagerBoard. The corpus measure is a starter who did not play in LAST week's final lineup. Those
  are different weeks, so this unit adds `lineup_dead_starts_last_week` from `league_roster_snapshots`
  (source `final`, writer named in section 4) and leaves the current-lineup count as it is. In the final
  snapshots `injury_status` is empty for all 848 starter rows, and `actual_points = 0` covers 17 starter rows, 3 of
  5 distinct non-DEF players among them had snaps that week, so zero points alone is not "did not play"; the
  `nfl_snaps` check is required.
- **Display**: ManagerRead renders any `receptiveness_factors` entry through `Factors`
  (`client/src/components/trade/ManagerRead.tsx:101`). ManagerBoard prints the whole `receptiveness` object through
  `asText` (`client/src/components/brain/ManagerBoard.tsx:134`), so factors come out as one run-on string. Extend
  ManagerBoard to list factors.
- **Tilt (post-loss) weights**: unchanged, per the unit. Noted weak in section 7.

## 2. RED / GREEN

- **RED** `4919e528` "test: RED for activity and checked-out terms in trade receptiveness". Run on the unfixed
  tree, all five failed; A1's assertion: `'busy 1 must read above idle 1'` (two managers, twelve adds vs none, both
  at receptiveness 1.0 because nothing read activity). A2 `'withheld is reported, not dropped'`, A4
  `'checked out lowers receptiveness'`, A5 no `function ReceptivenessFactors` in ManagerBoard.
- **GREEN** `ce7d6137` "feat: activity and checked-out terms in trade receptiveness". 5/5 pass.
- **Fix after grading** `3c09a682` "fix: count processed trades and ship activity terms default-off". Two
  changes found while running the numbers: (a) completed trades now come from `TRADE_ACCEPT / PROCESS / EXECUTED`
  rows, which carry both sides' items; the first version read accept `EXECUTE` rows and took parties from the
  proposal, but 8 of 17 accept rows have no proposal row in the table, so it saw 6 trades instead of 9; (b) the
  terms ship default-off because H1 missed (section 4). A0 and A3b were added; the behaviour tests pass
  `activity: true`. Final run: 7/7 pass (`test/receptiveness-activity.test.js`), and the four neighbouring files
  still pass: valuation-map 47/47, manager-data-pipeline 27/27, trade-manager-read 20/20, trade-brain-surface 13/13.
  `tsc --noEmit` exit 0, `scripts/wiring-map.mjs --check` exit 0, `scripts/lint.mjs` clean.

## 3. What it does

- `manager-signals.js` (`txIndex` / `activitySignals` / `deadStartSignals`, writer `buildManagerSignals`, table
  `manager_signals`) adds `tx_adds_per_week` (ADD items in executed WAIVER/FREEAGENT rows through the last completed
  period, divided by that period; n = weeks), `tx_completed_trades` (processed trades through that period), and
  `lineup_dead_starts_last_week` (final-lineup starters, not DEF, 0 points, no `nfl_snaps` row with a snap), or
  `lineup_zero_point_starters_last_week` when `nfl_snaps` has nothing for that week (unknown, not "no"). A manager
  with no rows gets 0 adds per week, not a missing value; a league with no transaction rows gets nothing.
- `counterparty-pricing.js` `activityFactor` turns adds per week and "has traded" into a relative change in the
  chance he completes a trade, against his league's own mean, using the corpus constants in `ACTIVITY_FIT`; it
  enters the score before the observed accept-rate blend. `checkedOutFactor` is a flag worth -0.18 on the score
  (-0.11 on receptiveness). Both appear in `receptiveness_factors` as `trade_activity` ("How active he is
  (chance he completes a trade)") and `checked_out`, with n, cap and `fitted: true`.
- **Default-off**: unless `GRIDIRON_RECEPTIVENESS_ACTIVITY=1` (or `activity: true`), each entry has `effect: null`,
  `would_effect` set, and a `why` beginning "not applied (default-off: 2024 held-out AUC 0.644 missed its 0.645
  bar; unconfirmed forward)". Receptiveness is unchanged from main.
- Below 5 completed weeks the activity entry is withheld with "withheld until 5 weeks of pickups: N of 5 weeks".
- ManagerBoard lists the factors (`ReceptivenessFactors`); ManagerRead already renders any factor through
  `Factors` and shows an `effect: null` entry as "not scored".
- Tilt (`postLossFactor`, cap 0.05, ramp to a 30-point loss) is unchanged. Noted weak: the corpus puts a loss at
  +1.3 to +1.7 points on a 24% base, and flat in margin, not a ramp (package section 2a/2b).
- No migration, no new table, no column (`git diff --stat origin/main...HEAD -- server/migrations` is empty).

## 4. The numbers

Pre-registration committed first: `b367dd08`.

**H1, Sleeper 2024 held out, the shipped function** (tree `3c09a682`; the grade reads only the pure functions,
unchanged since `ce7d6137`):
`node scripts/rnd/grade-activity-receptiveness.mjs --corpus ~/gridiron-local/rnd/skill/team_seasons.sqlite`.
Same sample as the package (27,468 fit / 7,744 confirm team-weeks). Within-league-week AUC, 90% interval from 1,000
chain resamples; sign: above 0.5 = the higher score went to the team that traded.

| rows | team-weeks | trade sides | activity term | activity + checked out | MDE80 |
|---|---|---|---|---|---|
| fit 2021-23 (in-sample) | 27,468 | 6,624 | 0.6591 [0.6504, 0.6678] | 0.6587 | 0.0101 |
| **2024 held out** | 7,744 | 1,783 | **0.6439 [0.6299, 0.6577]** | 0.6428 [0.6287, 0.6569] | 0.0194 |
| 2024, w >= 5 (gate releases) | 5,108 | 1,174 | 0.6445 [0.6266, 0.6619] | 0.6427 | 0.0239 |
| 2024, w 2-4 (gate holds back) | 2,636 | 609 | 0.6428 [0.6206, 0.6662] | 0.6429 | 0.0332 |

- **H1 FAILS**: 0.6439 < 0.645. The miss is 0.0011, well inside the interval, so the function is not worse than
  the bar by any test either; it just did not clear it. Cause (measured): 3,387 of 7,744 rows (44%) sit at the
  +-0.5 activity cap, and the ties lose ranking the uncapped linear score had (the validator's uncapped LPM score:
  0.652). Changing the cap now and re-grading on 2024 would be a second look at the same held-out season, so it is
  not done here (follow-up, section 6).
- The checked-out flag adds nothing to ranking (0.6428 vs 0.6439), as the package found for the pain features.
- The gate costs nothing measurable: weeks 2-4 rank as well as weeks 5+ (0.643 vs 0.645).

**H2, 2026 forward** (local copy, not production, tree `3c09a682`):
`node scripts/rnd/grade-activity-receptiveness.mjs --app-db .local-db/data.sqlite`. Known-nonzero control first:
9 processed trades in 5 leagues. Only one league had trades in periods 2-3, so 20 team-weeks, 6 trade sides,
1 cluster.
- AUC 0.6875 (activity), 0.6750 (with checked out). No interval: one league, so the bootstrap is degenerate.
  MDE80 0.359. By the literal rule 5 "holds" (point above 0.5, interval not below), but this is anecdote-sized.
- An earlier run on `ce7d6137`, before the trade-count fix, saw 6 trades and gave 0.7568; recorded, superseded.
- Secondary, descriptive (no ship weight): responder accept vs decline, 27 decisions (10 accepts) in 3 leagues,
  AUC 0.285, MDE80 0.291. More active responders declined MORE in these 27. Too few to read, but it points the
  other way from "active means yes", which is why the label says "chance he completes a trade", not acceptance.

**Decision grade (discipline d)**: AUC is the win rate of "pitch the higher-scored of two managers in the same
league-week" against flat receptiveness (a coin flip, 0.5): 64.4% on 2024, if it were on.

**Ship rule outcome**: H1 failed, so per the pre-registration the terms ship **default-off**, reported, labelled
"unconfirmed forward". Receptiveness on main is unchanged.

**Liveness on real rows** (local copy, not production, tree `3c09a682`, league period 3, so 2 completed weeks):
46 managers in 5 leagues, all 46 have `tx_adds_per_week` (mean 1.13) and a `trade_activity` entry, withheld "2 of 5
weeks". `checked_out` entries appear with `would_effect -0.1824`, e.g. "1 starter last week did not play".
Command: a scratch script calling `buildManagerSignals` then `counterpartyLayer(id, {season: 2026, week: 3})` per
league. One league's rebuild refused (trusted chat identities, no chat DB in the worktree), and its rows had been
rebuilt with `chat: null` by the H2 run on the same copy; copy only.

**Two dead-starter producers, same input** (local copy): `lineup_dead_starters` (current, unlocked lineup) vs
`lineup_dead_starts_last_week` (last final lineup), 46 managers: both >0 for 2, only current for 7, only last week
for 4. They measure different weeks; neither is replaced. Follow-up named in section 6.

**Mutation sweep** (`python3 docs/evidence/2026-09-23/mutate-activity-receptiveness.py`, final tree): baseline 7 ok.
M1 sign flipped KILLED (A0,A1); M2 gate removed KILLED (A2); M3 inactive manager dropped KILLED (A0,A1,A3,A3b);
M4 zero points counted as dead KILLED (A4); M5 vetoed trades counted KILLED (A3b); M6 adds after the last
completed week counted SURVIVED on the first sweep, then the fixture got an in-progress-week add and it is KILLED
(A3); M7 call site, effect never added KILLED (A0,A1); M8 call site, flag ignored KILLED (A0); M9 call site, signal
build skips activity KILLED (A0,A1,A2,A3,A3b); M10 call site, board stops rendering factors KILLED (A5).
S1 designed survivor (cap 0.5 to 0.45) SURVIVED: the magnitude is graded by the script, not unit tests.
C1 not-applied control NOT APPLIED.

### Holdout looks

| unit | date | hypothesis | metric | result |
|---|---|---|---|---|
| RL-11-1 | 2026-09-23 | H1: shipped activity term ranks 2024 Sleeper trade sides at AUC >= 0.645 | within-league-week AUC | 0.6439 [0.6299, 0.6577], FAIL |
| RL-11-1 | 2026-09-23 | H2: same function holds on 2026 weeks 1-2 | within-league-week AUC | 0.6875, n 20 / 6 sides, 1 league; F002 in HOLDOUT-LEDGER |

2025 was not opened (the corpus query asserts `season <= 2024`; the app copy has no 2025 transactions).

## 5. Known defects

- The forward check is one league and 6 trade sides; it cannot confirm anything.
- The corpus outcome mixes proposers and responders; the 27 ESPN decisions point the other way (descriptive).
- `nfl_snaps` is matched by player name; a name mismatch would count a player who played as dead. In the 2026
  final snapshots the check matched 3 of 5 zero-point players to their snaps.
- `txIndex` (`manager-signals.js:195`) still has a pre-existing bare `catch { items = []; }` for proposal items; not
  touched here. The new parsers throw with the tx_id.
- The completed-trade rule differs from what `txSignals` uses for accepts (it counts responder `EXECUTE` rows,
  which is right for decisions); both are documented in place.

## 6. Follow-ups

1. Re-specify the cap (e.g. no activity cap, only the [0.7, 1.3] clamp), pre-register it, and grade it on 2026
   forward weeks once W6-W8 give about 60 decisions; 2024 is spent for this question.
2. Decide whether `lineup_dead_starters` (current lineup) should stay a signal now that last week's version exists.

## 7. Nick's five questions

1. **Well built?** One producer extended (`counterpartyLayer`), metrics in the one signal table with their samples,
   a named flag, 7 tests, 10 of 10 real mutants killed, no migration.
2. **Stats or made up?** Stats for the sizes (Sleeper 2021-23 fit, n = 27,468). Two guesses, stated: the +-0.5 cap
   (chosen to match the chat term's reach) and the 5-week gate (from the queue row, "like tx_accept_rate").
3. **How we know:** backtest on the Sleeper 2024 held-out season, 0.644 AUC against a pre-registered 0.645: missed,
   so it is off. Forward 2026: 0.69 on 6 trade sides, anecdote.
4. **Pointed anywhere else?** Receptiveness feeds `trade-engine.js:1708` (idea ranking), the ManagerRead card and the
   Brain managers board. With the flag off none of those numbers move; the factor text shows on both pages.
5. **How it unifies:** `tx_waiver_moves` had no reader; activity now has one producer (`activitySignals`) and one
   consumer (`activityFactor`), and the grade script imports the same function the app runs.

- Gap fixed: `tx_waiver_moves` computed at `manager-signals.js:221` and read by nothing (origin/main `ad3bb9f6`).
- Incumbent: flat on activity; A1 on the RED tree gave 1.0 vs 1.0.
- Not covered: acceptance (P(yes)); post-loss tilt sizes; turning the term on.
- What would make it wrong: activity not predicting trades in Nick's leagues (the 2026 forward grade at W6-W8).
