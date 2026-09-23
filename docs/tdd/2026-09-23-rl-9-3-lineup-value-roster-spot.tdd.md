# RL-9-3: Trade Machine lineup value that charges the roster spot

Unit: RL-9-3 (WORK-QUEUE §9 round 9; R&D `rnd/loop/r9-internal-trade-fairness-ignores-roster-spots.md`). Plan items TR-03 / TM-01 / TM-42.
Branch `claude/local-rl-9-3-roster-spot-lineup-value`, base origin/main `ca64b2cc`.

## 1. Audit (written before the first test): extend, do not build

- **The summed value.** `server/services/trade-engine.js:1141-1142` (`side()` in `evaluate()`) sums `max(0, value)`; `:1166` `value_delta`; `:1167` `roster_spots = gets.length - gives.length` is computed and priced nowhere. Command: `git grep -n -i "roster.spot\|2-for-1" origin/main -- server/services/trade-engine.js server/routes/trades.js` -> only `trade-engine.js:1167`.
- **The lineup solver (reused, one producer).** `bestLineup` `trade-engine.js:637`. `side()` already solves the post-trade lineup (`ppg_delta`, `:1138`, `:1153`) but never fills the slot the 1-player side frees, and never charges the 2-player side a drop. `lineupDiff` (`:2814`) is the Start/Sit week diff on `week_points`, not a trade surface; nothing here reuses it beyond `bestLineup`.
- **No existing lineup-value or wire producer in the trade path.** `git grep -n -i "lineup_value\|lineupValue\|leagueWire" origin/main -- server client/src` -> 0 rows. Known-nonzero control for the same grep shape: `git grep -n -i "replacementLevel" origin/main -- server` -> `draft-assist.js:143` and `edge.js:36` (a draft-time positional replacement from a projected pool, not a league's live wire; not the same concept, not reused).
- **The league's wire (TM-42) exists once, inline.** `server/services/waiver-wire.js:152` `waiverBoard()` builds the free-agent pool inline (`rosteredNames` `:133`, `unownedAll`/`onNflTeam` `:222-227`). Extend: lift that filter into an exported `leagueWire(lg, assets)` that `waiverBoard` itself calls, and have the trade engine read the same producer. Input tables: `leagues.payload` (rosters; writer = league sync) and the priced asset universe `assetUniverse()` `trade-engine.js:283`; no new table, no migration.
- **Weeks remaining.** `trade-horizon.js:78` `horizonWeights()` already returns `regular_weeks_left` and `playoff_weeks_left` from `leagueSchedule(lg)` (`:55`); reused, not re-derived.
- **Open PR overlap (reported, not edited).** `gh pr list --state open` touching `trade-engine.js`/`waiver-wire.js`: #191 (replaces `rosteredNames` with an asset-id map), #178 (waiver alerts), #179, #174, #171 and others. #191 and this unit both touch the owned filter in `waiver-wire.js`; whichever merges second moves `leagueWire` onto the id map.

Decision: EXTEND `evaluate()`'s `side()` with a lazy `lineup_value` field, add `lineupValue()` + `lineupValueContext()` in `trade-engine.js` on top of `bestLineup`, and `leagueWire()` in `waiver-wire.js`. Expose on `POST /:leagueId/evaluate` and `GET /:leagueId/find`. No ranking, gate, tag or fairness input reads it (RL-8-2b pending Nick).

## 2. Pre-registration

Not a statistical unit in this PR: it runs no number on real data and ships no model number ON. `lineup_value` is a deterministic lineup solve labelled `status: 'not yet validated'`; whether it should replace the summed value in any decision is RL-8-2b's pre-registered gate (pending Nick). No 2025 row is read, so no holdout look is recorded.
