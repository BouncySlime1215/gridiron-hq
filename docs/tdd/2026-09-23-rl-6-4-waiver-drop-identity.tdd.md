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

## 2. RED

`8051e42c` test: RED waiver board cuts a namesake priced 0.0 instead of the rostered player.

- New file `test/waiver-namesake-cut.test.js`: 6 tests, 6 fail on `3ac59fea`'s code.
- The failing assertions, inline:
  - Retired namesake: `assert.equal(claim.drop_candidate.player, 'Marvin Harrison Jr.')`. Actual: `'Marvin Harrison'`.
  - Junk row with `espn_id` 0: expected `'Mike Washington Jr.'`, actual `'Mike Washington'`.
  - Rule (a): `assert.equal(out.immediate.find(r => r.player === 'Jack Strand'), undefined, 'no safe cut exists, so Jack Strand is not an immediate claim')`. Actual: a claim cutting the 0 / 0 namesake.
  - A free-agent namesake of a player rostered elsewhere: `immediate=` is empty, because he was hidden as "owned".
  - Name-fallback label: `roster_coverage.name_fallback` is `undefined`.
  - A fallback onto an asset carrying a different ESPN id: `roster_coverage.unpriced` is `[]`, because he was priced as another person.

## 3. GREEN

`87c996c1` fix: waiver board resolves the roster by ESPN id first and never cuts an unconfirmed match.

Changes:
- **`trade-engine.js#espnPlayerResolver`** (new export, beside `loadRosters`). It returns `{ asset, match }`:
  - ESPN id first.
  - Name + position only when no asset carries that id, and only onto an asset with no ESPN id. A tie between id-less rows resolves to nothing.
  - `loadRosters`' ESPN branch now calls it. The Sleeper branch is unchanged.
- **`waiver-wire.js`**:
  - `mine` is resolved through the resolver, and each entry carries `identity_match`.
  - `rosteredNames` becomes `rosteredAssetIds`, keyed by asset id, so the free-agent pool is "not rostered by id".
  - `cuttable()` skips name-fallback players in `chooseClaimCut` and in the stash cut (`rosBench`).
  - `roster_coverage.name_fallback` lists them. It is served by `GET /api/leagues/:leagueId/waivers` (`routes/trades.js:668`).
  - The now-unused `normalizePlayerName` import is removed.
- **`test/decision-leftovers-waivers.test.js`**: the fixture now carries the ESPN id and `defaultPositionId` that every real ESPN payload entry has. Its entries had neither, so under an id-first join they were unresolvable.
- **`docs/tdd/decision-leftovers.tdd.md` gap 3**: corrected, since it was false after `a38f40ed`.

Follow-up test: `88562df8` test: a player rostered elsewhere is never offered on the wire (kills mutant M6).

Targeted tests on HEAD `88562df8`, each run as `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/<f>.test.js`:

| Test file | Pass / fail |
|---|---|
| `waiver-namesake-cut` | 7 / 0 |
| `decision-leftovers-waivers` | 7 / 0 |
| `decision-leftovers-lineup` | 10 / 0 |
| `lineup-surfaces-agree` | 2 / 0 |
| `league-roster-schedule` | 3 / 0 |
| `post-draft-plan` | 5 / 0 |
| `find-trades` | 3 / 0 |
| `trade-engine-correctness` | 15 / 0 |
| `trade-tactics` | 39 / 0 |
| `trade-evidence` | 9 / 0 |
| `league-brain` | 5 / 0 |
| `valuation-panel` | 3 / 0 |
| `waiver-confidence-is-hand-set` | 7 / 0 |
| `waiver-kicker-defense` | 7 / 0 |
| `b-01-real-record-odds` | 8 / 0 |
| `manager-data-pipeline` | 27 / 0 |
| `manager-identity-seeding` | 6 / 0 |
| `manager-signals-api` | 27 / 0 |
| `lineup-floor-objective` | 3 / 0 |
| `posture-calibration` | 6 / 0 |
| `start-sit-ceiling-uncalibrated` | 7 / 0 |
| `start-sit-decision-curve` | 12 / 0 |

These are every test file whose fixture carries an ESPN `playerPoolEntry` and reaches `loadRosters` or the waiver board. `npm run check` was not run here; the Gate phase runs it once.

## 4. Mutation sweep

Each mutant was run against `waiver-namesake-cut` and `decision-leftovers-waivers`. The sweep ran on `87c996c1`; M6 and the control were re-run on `88562df8`.

| Mutant | Where | Result |
|---|---|---|
| M1: the fallback may land on an asset with its own ESPN id | resolver | killed (1) |
| M2: the name fallback is tried before the ESPN id | resolver | killed (1) |
| M3 (**designed survivor**): a tie between two id-less rows resolves last-wins | resolver | survived. No fixture has two id-less rows with one name and position; the tie rule is defensive. |
| M4: `chooseClaimCut` ignores `cuttable` | call site | killed (1) |
| M5: the stash cut ignores `cuttable` | call site | killed (1) |
| M6: the owned filter matches nothing | call site | survived on `87c996c1`, killed (1) on `88562df8` after the new test |
| M7: `identity_match` is not recorded | call site | killed (1) |
| M8: `name_fallback` is never filled | call site | killed (1) |
| C0 (**not-applied control**): the target text is absent | none | reported NOT APPLIED, not counted |

## 5. The numbers (local copy, not production)

- **Copy:** `sqlite3 ~/gridiron-local/data.sqlite ".backup '<wt>/.local-db/data.sqlite'"`.
- **League payloads:** `leagues.fetched_at` is 2026-09-23 09:09:40-41 for all 5. This is a later sync than the package's 07:05Z one.
- **Trees:** `3ac59fea` (origin/main, a scratch detached worktree) against branch `87c996c1`.
- **Script:** session scratchpad `rl64_check.mjs <tree>`. It calls `waiverBoard(lg, { limit: 50 })` for my team in each league and collects every distinct cut (immediate, stash and held-back `would_cut`). It uses an explicit `leagues` column list, and `espn_s2` and `swid` are never selected.

| Measure (5 leagues) | origin/main | this branch |
|---|---|---|
| Cuts priced 0 this week and 0 ROS | 4 (L1, L3, L4, L5) | **0** |
| Cuts whose name is not on my ESPN roster | 1 (L1) | **0** |
| Cuts whose asset ESPN id is not on my roster | 3 (L1, L3, L4) | **0** |
| `held_back_count` | L3 0, L4 0 | L3 **1**, L4 **1** |
| Immediate claims | L3 29, L4 25 | L3 28, L4 24 |
| Other leagues' boards (immediate, stashes, held back) | unchanged | unchanged |
| Roster priced / unpriced | 14-15 / 0 in every league | same |
| `name_fallback` | n/a | 0 in every league |

- **Where the drops went.** In L3 and L4, the one claim that moved is now held back by rule (a). That matches the package's Jack Strand case, but the name was not checked (counts only). Both leagues show 2 distinct cuts: the claims' cut plus the held-back `would_cut`. All are rostered and non-zero.
- **Identity metric.** Command: scratchpad `rl64_namejoin.mjs` on `3ac59fea` (old normalised-name map against the ESPN id).
  - My roster: 1, 0, 1, 1, 1 misjoins in L1-L5, so 4 of 5 on this copy.
  - All teams: 2, 3, 2, 4, 3 misjoins.
  - L2 shows 0 on this copy. This is a guess: its roster changed after the package's sync. The known-nonzero control is the 4 other leagues.
  - Branch: every one of my rostered entries resolves by ESPN id. `name_fallback` is 0, unpriced is 0, and `entries_with_no_asset_by_espn_id` is 0 in all 5 leagues (129-172 entries each).
- **`loadRosters` is unchanged on real data.** The per-team sorted asset-id lists from `loadRosters` on both trees are byte-identical: `cmp rl64_lr_RL-6-4-base.json rl64_lr_RL-6-4.json` exits 0, with 758 players over 5 leagues. The tightening only bites on the fixture cases, because every real entry resolves by id.

**Decision grading and historical replay (discipline d/e): not applicable.**
- No projection or ranking changed. The fix changes which player a price belongs to, not the price.
- The decision effect is deterministic: 2 claims that cut a real player worth more ROS than the claim are now held back.
- A walk-forward replay would need historical ESPN roster payloads keyed to namesake rows, and none were opened. There is no holdout look.

## 6. Known defects and follow-ups

1. **WV-02 #178 must adapt when it merges.**
   - Its `injuryReplacementAlerts` reads `owned.get(normalizePlayerName(a.name))` for the holder team. This unit removes `owned` and `rosteredNames`, and the replacement is `ownedById.get(a.id)` (asset id → team id).
   - The break is loud, not silent: `owned` would be undefined. Either #178 merges main and switches, or this branch merges after it and does the switch.
2. **`lineup-posture.js#rosterAssets` (`:185-197`)** is still a name-only join. It misjoins Travis Hunter to the CB row for 3 opponents (package §2). It is not in this unit's file list, so it is a follow-up that uses the same `espnPlayerResolver`.
3. **`routes/players.js` `newsFor`** takes the suffix as the surname. This is the package's side lead, and a follow-up.
4. **The tie rule has no test** (designed survivor M3).
5. **Junk rows** (e.g. `players` row with `espn_id` 0) remain in the table. The resolver makes them harmless here, and deleting them is out of scope (no data deletion).

## 7. Nick's five questions

1. **Well built?** One resolver is shared by the trade side and the waiver board. It has 7 new tests, 8 mutants (7 killed, 1 designed survivor) and a not-applied control.
2. **Stats or made up?** Nothing is estimated. It is a join fix, and every count above has its command and tree.
3. **How we know?** On the local copy (not production), before against after: zero-priced cuts go from 4 to 0 across 5 leagues, and cuts not on my ESPN roster go from 3 to 0. `loadRosters` output is byte-identical.
4. **Pointed elsewhere?** Yes, `lineup-posture.js` and `players.js` news. See follow-ups 2 and 3.
5. **How it unifies?** `waiverBoard` and `loadRosters` now call the same `espnPlayerResolver`, so the waiver card and the trade pages cannot disagree on who is on a roster.
