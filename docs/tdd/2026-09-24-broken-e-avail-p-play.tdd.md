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

## GREEN

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
