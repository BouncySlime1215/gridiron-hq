# RL-6-4: the waiver card cuts the player you actually roster

Unit RL-6-4 (plan item B4 waivers, URGENT). Page: Start/Sit (`/lineup`) → Waiver wire card, served by `GET /api/leagues/:leagueId/waivers` (`server/routes/trades.js:668-677` → `waiverBoard`, `server/services/waiver-wire.js`).

Branch `claude/local-rl-6-4-waiver-drop-identity`, cut from origin/main `3ac59fea`.

Not a statistical unit: no model number is produced or changed, so there is no pre-registration. It is an identity join. 2025 was not opened, so there are no holdout looks (none appended to `docs/evidence/HOLDOUT-LEDGER.md`).

## 1. Audit: extend or build

- **The defect** (`waiver-wire.js` on `3ac59fea`):
  - `:164-165` builds `assetByName`, a normalised-name map over every asset. Last row wins, and `normalizePlayerName` strips `Jr.`.
  - `:173` looks each roster entry up by name only. The payload's `playerPoolEntry.player.id` (the ESPN id) is ignored.
  - `:133-141` `rosteredNames` and `:225`: a free agent counts as owned when any rostered name normalises to his.
  - Written by `a38f40ed` ("Stop the waiver board and the league sync reporting missing data as findings"). Before it, the code took the first match.
- **What already exists: the canonical ESPN-id-first join.**
  - `trade-engine.js:527-561` `loadRosters`: `byEspn.get(String(pl.id)) ?? byKey.get(name|position)`.
  - Its readers are the trade routes (`routes/trades.js:115,840,867,934,1205`), `waiver-brain.js:219` and `td-regression.js:353`.
  - `lineupDiff` (`trade-engine.js:2833-2841`) is also id-first.
- **Why not call `loadRosters` directly.** It returns bare assets and drops the payload entry. The waiver board needs `lineupSlotId` and `injuryStatus` per entry (the IR rule, and WV-02 #178's `lineup_slot`). It also silently discards entries it cannot resolve, and the board reports those in `roster_coverage.unpriced`.
- **Decision: extend.** The per-entry resolver is lifted out of `loadRosters` as `espnPlayerResolver(assets)` in `trade-engine.js`, next to `loadRosters`. `loadRosters` and `waiverBoard` both call it, so there is one producer of "which asset is this ESPN roster entry".
- **Tightening, shared by both callers.** The name + position fallback runs only when no asset carries the entry's ESPN id. It lands only on an asset with no ESPN id of its own, since an asset carrying a different ESPN id is a different person. It returns nothing when two such assets tie.
- **The same bug class, outside this unit:**
  - `lineup-posture.js#rosterAssets` (`:185-197`) does a name-only join. It is not in this unit's file list, and is named as a follow-up.
  - `routes/players.js` `newsFor` takes the suffix as the surname. That is a side lead from the package, and also a follow-up.
- **Coordination.** Both are open and not on main, so there was nothing to merge first.
  - WV-02 #178 edits `waiver-wire.js` (`mine.push`, `injuryReplacementAlerts`). Its `owned.get(normalizePlayerName(a.name))` reads the name map this unit replaces; see Known defects.
  - RL-5-3 #179 edits `trade-engine.js` in `buildAssetUniverse`, `bestLineup`, `evaluate` and `selfScout`, not near `loadRosters`.
