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
  `:201`, table `manager_signals`, written by `buildManagerSignals` `:349`, insert at `:424`). Hits: the definition and one test
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
