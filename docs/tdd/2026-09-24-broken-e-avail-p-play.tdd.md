# BROKEN-E: one avail.p_play with a typed "unknown"

BROKEN-NUMBERS row E: chance to play is read per caller, and a missing number is
filled with `?? 0.92` (DEFAULT_ACTIVE_PROBABILITY, a constant nothing fitted) at
trade-engine.js:387, trade-engine.js:3198 and season-sim.js:385 (the row cites :359;
the line has since moved). A player with no games on file, no injury-report line and
no fitted role cell is also served exactly 0.92 by contingency.js, because his
durability prior is that same constant. Both look like a reading and are not one.

## Change

- `server/services/avail-p-play.js` (new): `availPPlayWeek(season, week)` is the one
  reader. It fixes the arguments (`through = season - 1`, role and ESPN on) and returns
  per player `{ status: 'ok' | 'unknown', p_play, basis, reason?, prior? }`.
  - `unknown` reasons: `no_row` (unfitted_position), `no_number` (unvouched /
    unrecognised), `no_games_no_report` (the constant priced him).
  - An unknown player's `p_play` is `null`. The number a simulation uses is the
    labelled prior: role-fit no-report cell (with n) → mean of this week's measured,
    unlisted players at the position (n ≥ 20) → the constant, labelled `fitted: false`.
- trade-engine.js asset build, lineup-diff swap, season-sim.js pool: read it when on.
  The asset carries `p_play`; the swap says `p_basis: 'unknown_prior'`; the sim's pool
  meta carries `p_play_status`. The asset cache key gains `:pplay` when on.
- TradeCard.tsx: "active unknown (priced at X%: <source>)" for an unknown player.
- `contingency.js#fittedAvailability` exported (no body change).

Default off: `GRIDIRON_AVAIL_P_PLAY=1`, or `GRIDIRON_PREVIEW_UNCONFIRMED=1` via
preview-mode.js (then `preview: true` + reason on each p_play).

## RED (commit e0746a7a)

`test/avail-p-play.test.js` against main: the file fails to load,
`ERR_MODULE_NOT_FOUND: .../server/services/avail-p-play.js`. 1 file, 0 pass, 1 fail.

## GREEN (commits 9dbecb2a, 58195475; merged with main at 547d0d68)

Mutation sweep on 58195475 (test/avail-p-play.test.js): 7 of 7 mutants die.
M1 drop no_games_no_report (4 fail), M2 unknown value = 0.92 (2), M3 trade-engine
asset ignores p_play (2), M4 season-sim ignores p_play (1, source pin only), M5 lineup
diff ignores p_play (1, source pin only), M6 flag always off (2), M7 cache key drops
`:pplay` (1). Controls: comment edit survives (0 fail); not-applied pattern, 0 fail.


`test/avail-p-play.test.js`: 11 pass, 0 fail. Fixture numbers (not the live DB):
the unseen rookie is served 0.92 on the old path; with the flag on he is
`unknown / no_games_no_report`, priced at the fitted mean of 25+ measured unlisted
WRs, and `current_week_ppg` moves from 20 × 0.92 = 18.4 to 20 × prior. With the flag
off the asset is byte-identical (no `p_play` field, 0.92).

## Not covered

- season-sim and the lineup diff are pinned by a source test (the default is only the
  flag-off arm), not by a full simulation run.
- Four other `?? 0.92` sites are outside row E: roster-risk.js:257,
  role-scenario-engine.js:124, news-fantasy-impact.js:87, contingency.js
  DEFAULT_DURABILITY_PRIOR itself.

## Nick's five questions

1. Well built? One reader, typed status, default off, 11 tests, 7/7 mutants killed.
   Sim and lineup-diff wiring are pinned by source only.
2. Stats or made up? The prior is fitted: the role table's no-report cell (fit on
   2021-24, n stated), else a mean over this week's measured players (n ≥ 20). It falls
   back to 0.92 only when there is nothing to fit, and then it is labelled `fitted: false`.
3. How we know: no backtest of the unknown-player prior. The role cell is the fit
   scripts/fit-availability.mjs already graded. MIN_PRIOR_N = 20 is a hand-set constant.
4. Pointed elsewhere? The trade-engine asset feeds the trade cards, Start/Sit swaps and
   season-sim title odds. Four other `?? 0.92` sites are not converted (listed above).
5. How it unifies: trade-engine and season-sim read one `availPPlayWeek` with fixed
   arguments. This matches EA-06/07's `avail.p_play` field shape (`status` + value), so
   the spine producer can wrap it.

## Sweep fixes (2026-09-24): FIX-285-1 and FIX-285-2

- **FIX-285-1**: roster-risk.js (fragility), role-scenario-engine.js
  (buildPlayerScenarios) and news-fantasy-impact.js (newsFantasyTracker) read
  `availPPlayWeek` through `chanceToPlay` when the flag is on. An unknown player is priced
  at his labelled prior and the typed unknown is served (`p_play`, `baseline_p_play`).
  The flag-off default is one function, `contingency.js#legacyActiveProbability`.
  trade-engine.js, season-sim.js and number-audit.js call it instead of typing 0.92. A
  ratchet (`test/avail-p-play-sites.test.js`) fails on any `?? 0.92` in server/ or
  client/src outside contingency.js.
- **FIX-285-2**: `pPlayCacheTag()` ('' / ':pplay' / ':pplay-preview') is part of the GET
  /simulate memo key (`routes/model.js#simulateMemoKey`), the titleOddsTrades cache key,
  and the asset-universe key (which already carried ':pplay').
- **RED**: `test/avail-p-play-sites.test.js` + `test/avail-p-play-cache.test.js`, 4 pass /
  8 fail. The role scenario, news and fragility sites served 0.92 where the fitted prior
  is 0.759. The ratchet found three sites. Both caches returned the other flag state's
  odds (expected 'on', actual 'off'; expected 0.05, actual 0.01).
- **GREEN**: 12 of 12. `test/avail-p-play.test.js` 11 of 11.
  `test/historical-consensus-head-to-head.test.js` 39 of 39: its source pin now follows
  the default into contingency.js.
- The first full run found one real failure. `test/b-01-real-record-odds.test.js` bans a
  `fromWeek` token outside season-sim.js, and the new key helper used that parameter
  name. It was renamed to `clientWeek`.
