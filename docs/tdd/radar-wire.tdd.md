# RADAR-WIRE (ONE-PLAN section 5, night 8): "why now" on every flip row

Spec (ONE-PLAN s5 night 8): flip rows "why now" = a validated O1 radar cell (n, CI), or
`fc_trend30` (a new adapter field; the campaign adapter never read it), or a 48 h news
contradiction (only while the news extractor is alive; otherwise "news dead" is printed)
-> "check first". RADAR-GRADE ledger graded at +2 weeks.

## Pre-registration (written before the code)

Flag: `GRIDIRON_RADAR_WIRE` (`=1` on, `=0` off and vetoes preview, unset follows preview mode).
Default off. It moves no number: `why_now` is a label with its evidence.

| # | Metric | Pass bar | What fails it |
|---|---|---|---|
| 1 | Byte-diff of the plans file, flag off vs on, same fixture league and seed | every differing JSON path contains `why_now`; flag off is byte-identical to the file without this change | any other path differs (a flip leg, price, player, spread, deck move, target) |
| 2 | Ledger coverage | one RADAR-GRADE ledger row, stamped `as_of` = the run's `generated_at`, per served flip row (with or without a reason) | a served `why_now` with no ledger row, or a row without `as_of` |
| 3 | Honest inputs | news with no signal in 48 h prints "news dead" and never raises "check first"; no O1 radar on the build prints so; `fc_trend30` with < 7 days of `dynasty_value_history` is a `watch` label, never `act` | any of the three served as if live |
| 4 | Priority | validated cell > `fc_trend30` (|30-day move| >= 10% of the prior value) > none; a 48 h negative news signal overrides to `check_first` | a lower source served over a higher one |

Promotion gate (weekly, the #402 style): RADAR-GRADE. Every ledger row with a direction
predicts the sign of the player's FantasyCalc value change over the next 14 days. On each
Tuesday grade: gain = mean(hit - base), where base is the share of that week's ledger
players whose value moved the same way. 90% bootstrap CI clustered by `as_of` week. The
flag may default on only after the lower bound is above 0 on 2 consecutive Tuesdays; an
upper bound below 0 demotes. Fewer than 20 graded direction rows = `not_enough_data`.

## Record

RED and GREEN commits and results are appended below as they land.
