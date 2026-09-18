# TDD evidence: manager-data-pipeline (2026-09-18, WA)

**Status: built, tested and gated on a copy of production. Not live yet.** Production
(`server/data.sqlite`) was not written. The data goes live when E2 adds
`scripts/build-manager-signals.mjs` to the refresh loop (the exact call is below). The code changes go
live at the next integration restart.

**Modules:** `server/services/manager-identity.js`, `manager-signals.js`, `counterparty-pricing.js`,
`bluff-detector.js`, the new `scripts/build-manager-signals.mjs`.
**Test:** `test/manager-data-pipeline.test.js` (22 tests). **Gate:** written before any code ran,
kept in the item's scratch `GATE.md`; results are copied below.
**LLM spend:** $0. No calls were made.

## Audit: what existed and what was found (Discover -> Audit -> Decide)

| System | Found | Decision |
|---|---|---|
| `matchIdentities` | No caller. Only league 4 had rows: 10, all confirmed by hand. **Re-running it would have destroyed those confirmations**: they exist only in the table, and without them league 4's roster 7 ("Aiden Smith" on ESPN) name-matches the chat's "Josh Smith", a different person. | **Extend.** Carry stored confirmations forward. Chat-free leagues get ESPN-only rows. Write a row only when it changed. |
| `identityMap` | Returned every row with a chat name, including `likely` and `uncertain` matches. The module's own header says those should be shown for review first, never used silently. | **Fix.** Trust only `confirmed` and `exact`. |
| `buildManagerSignals` | No caller. League 4 was a one-off snapshot from 09-17 22:04 (247 rows). **Its transaction counts were wrong** (details below). | **Extend and fix.** Corrected transaction reader, new sources, write only on change, all-league refresh. |
| `manager_signals` / `manager_player_view` | League 4 only. Nothing rebuilt them. | Rebuilt for all 5 leagues by the new script. |
| `negotiation_profiles` (chat DB) | 10 rows, all 10 valid against the builder's schema. Read by nothing. | **New reader:** `negotiationProfilesFor`, which validates each profile and returns 'ME' separately as Nick's self-profile. |
| `declarationCredibility` | Opened the chat DB and joined the 500k-row classifier table (89 ms) on every uncached `findTrades` call, **for every league, including the four with no chat**. It returned a `Map` when the DB was absent and `{byManager, events}` otherwise. | **Re-engineer.** Cache keyed on the chat data, one return shape, and skip it for leagues with no chat. |
| `counterpartyLayer` "hard" tier | 0.55 applied here and again in `trade-engine.js`, so a "hard" manager was discounted to 0.30. | **Fixed on this side.** trade-engine is now the single place the tier applies. |
| `readDeal` `perception_delta` | With no chat read on any player in a deal, it returned our own value gap. The ±10% perception factor then rewarded Nick a second time for giving value away, on top of the fairness term that is capped to stop exactly that. This was latent in league 4, and **it would have spread to every manager in leagues 1, 2, 3 and 5 once their signals existed.** | **Fix.** Null when uninformed. Added `perception_shift`, the part his views add. |
| `untouchablesFor` | Dead. It had no caller and duplicated `untouchableStance`. | **Retired.** |
| Chat DB path | Hard-coded. The test suite read the private corpus. | `GRIDIRON_CHAT_DB_PATH` override, with `busy_timeout`. An absent DB returns null; any other error is raised, not hidden. |

### The transaction defect, measured on `league_transactions_raw`
ESPN writes several rows per action. The old reader counted all of them under `team_id`:
- An accepted trade leaves `TRADE_ACCEPT/EXECUTE` under the manager who said yes **and**
  `TRADE_ACCEPT/PROCESS` under the **proposer** (6 rows in the table), plus `CANCEL` when the trade is vetoed. So proposers were credited with accepts they never made.
- Every proposal that closes gets a `TRADE_PROPOSAL/CANCEL` record under the proposer. Across the table, 56 real proposals were counted as 128.
- `WAIVER` rows include cancelled and failed claims.

Effect on league 4's live counterparty read (old snapshot, then rebuilt):

| Roster | Old accept rate | New accept rate | New receptiveness |
|---|---|---|---|
| 5 (Nick) | 0.80 (n 5) | 0.43 (n 7) | — (never his own counterparty) |
| 1 (Raj) | none (0 decisions) | 0.20 (n 5) | 1.30 -> 1.14 |
| 10 (Lars) | none (n 4) | 0.38 (n 8) | 1.17 -> 1.04 |
| 7 (Haiden) | none (n 4) | 0.40 (n 5) | 1.13 -> 1.07 |

League 3: roster 3 has 0.17 (n 6) and roster 8 has 0.00 (n 5), giving receptiveness 0.92 and 0.90. These are the first observed-behaviour reads outside league 4.

## User journeys
- As Nick, I want every league's trade ideas to know how each manager actually behaves, not only the league that has a group chat.
- As Nick, I want my own confirmations of who is who to survive every refresh, so one person's chat is never pinned on another.
- As Nick, I want a manager's accept rate to count only the offers he actually said yes to.
- As the Trade Brain (T1), I want one validated reader for the negotiation profiles, with my own profile kept separate.

## RED -> GREEN

| Stage | Commit | Evidence |
|---|---|---|
| RED | f2248c0 | 21/21 fail, each for the intended reason. Examples: `actual: null, expected: 'ME'` (confirmation wiped on re-run); `expected 0.55, got 0.3022 (0.3025 = applied twice)`; `actual: 10, expected: null` (perception of an uninformed deal). One test first passed only because the old code read the real chat DB. It was rewritten to use a hand-built record, and it then failed as intended. |
| GREEN | e3b9f53 | 21/21 pass. 17 neighbouring files (everything importing trade-engine or these modules) pass 114/114. |
| RED | cff411d | Chat guard: 1 of 22 fails. `buildManagerSignals(4)` with the chat DB missing rewrote league 4 without chat. |
| GREEN | 86b1e3e | 22/22 pass. |

Command: `GRIDIRON_DB_PATH="$(mktemp -u ...).sqlite" SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-concurrency=1 test/manager-data-pipeline.test.js`

## Test specification

| # | What is guaranteed | Test |
|---|---|---|
| 1 | A chat-free league gets one ESPN row per team, no chat name, and no warnings | identity: a league with no chat corpus… |
| 2 | Stored confirmations survive a re-run, and a disagreeing name match is recorded in `note` | identity: a re-run keeps Nick's confirmations… |
| 3 | An idle re-run leaves `updated_at` untouched | identity: a re-run with nothing new… |
| 4 | Only confirmed or exact identities attribute chat data; `likely` appears in the warnings | identity: only confirmed or exact… |
| 5 | Chat-free leagues get roster/standings/tx/draft/outcome signals and never chat or priors; every source is declared; draft is not priceable | signals: a league with no chat… |
| 6 | Decisions count only the responder's EXECUTE rows; close-out records are not proposals; withdrawn rate, veto votes and executed waiver moves are correct | signals: trade decisions are credited… |
| 7 | Standings and last-week margin come from the ESPN record and the last decided matchup | signals: standings… |
| 8 | Draft and outcome come from this league-season only (no career or other-league leakage) | signals: draft and outcome… |
| 9 | Chat signals and player views appear only for trusted identities | signals: chat and player views… |
| 10 | An idle rebuild writes nothing and keeps `counterpartyDataKey`; new data rewrites the league and changes the key | signals: a re-run with no new data… |
| 11 | A chat league is never rebuilt without its chat DB | signals: a chat league is never rebuilt… |
| 12 | One refresh covers every league, uses chat names only where Nick confirmed them, skips unsynced leagues, and never echoes credentials | refresh: … |
| 13 | The counterparty layer reports the tier but does not apply it | pricing: the counterparty layer does not apply… |
| 14 | Perception is null when uninformed; `perception_shift` is the view-driven part | pricing: perception is neutral… |
| 15 | `untouchablesFor` is gone | pricing: untouchablesFor is retired |
| 16 | The profile loader validates each profile, returns ME as self, reports invalid and unmapped profiles, and refuses chat-free leagues | pricing: one validated loader… |
| 17 | The validator names each violation (enum, unexpected key, missing key, leaked markup) | pricing: the profile validator… |
| 18 | Credibility is cached per window and invalidated by new chat rows | bluff: credibility is cached… |
| 19 | An absent chat DB returns the same shape as a present one | bluff: an absent chat DB… |
| 20 | An untrusted identity never borrows a declaration record | bluff: an untrusted identity… |
| 21 | In `findTrades`, with signals built, "hard" costs exactly 0.55 | trade engine: … exactly once |
| 22 | The script builds all leagues, writes `sync_log`, never prints credentials, and a second run changes nothing | script: … |

Coverage (`--experimental-test-coverage`, this test file): lines 100% manager-identity, 97.4% manager-signals, 94.4% counterparty-pricing, 94.6% bluff-detector. Branch coverage is 64-73%. Untested branches are mostly error paths: a missing `negotiation_profiles` table, and the data key for a chat league.

## Gate results (production copy + the real chat DB, read-only)

| Gate | Result | Evidence |
|---|---|---|
| G1 identities | PASS | 46/46 teams have rows. League 4: 10/10 confirmed, identical before and after (roster 7 is still Haiden Bonczek). Leagues 1, 2, 3, 5: no chat names. |
| G2 signals | PASS | Every roster in every league has signals. All 160 chat and prior rows are in league 4. |
| G3 transactions | PASS | tx_decisions_made matches a hand-written SQL count for all 10 league-4 rosters. |
| G4 idempotent | PASS | Second run: all 5 leagues unchanged, and the timestamps are identical. |
| G5 fast | PASS | 0.37 s wall for a cold process covering 5 leagues. |
| G6 sync_log | PASS | `manager_signals` row, status ok, with per-league detail. |
| G7 hard tier once | PASS | Ratio 0.55 ± 0.002 on every paired deal (was 0.3022). |
| G8 no regression | PASS | Same code, same DB, only the manager tables swapped, run back to back: the top 10 in all 5 leagues are identical to 3 dp. Code A/B in clean worktrees: leagues 1, 2, 3, 5 identical; league 4 differs only through the perception fix (below). |
| G9 cache | PASS | Real chat DB: 89 ms cold, 1.07 ms warm, same object returned. |
| G10 profiles | PASS | League 4: 10/10 valid, 9 counterparties plus ME as self (roster 5). League 1: `available=false` with a reason. |

**League 4, code effect only** (old vs new code, same data, clean worktrees). The #1 deal is unchanged (Deebo + Juwan Johnson for Stevenson, score 0.867 -> 0.938, because its perception of −7.6 had been pulling it down). The idea "Deebo for Coker" left the mutual list. Under the old code, the version where Nick adds Juwan Johnson (Parth gets +10.6% value) won the idea, because the double-counted perception term gave it ×1.10. Now the version where Nick keeps Johnson scores higher (0.436 vs 0.427). That version does not improve both lineups, and trade-engine collapses variants of an idea **before** applying the mutual filter, so the whole idea is hidden. That ordering belongs to T0 (see hand-off).

## What each league's manager read contains now (production copy)

| League | Teams | Identities (trusted chat) | Signals | Player views | Accept rates (n ≥ 5) | Real proposals | Veto votes |
|---|---|---|---|---|---|---|---|
| 1 Matta-Kodsi | 8 | 8 (0) | 192 | 0 | 0 | 1 | 0 |
| 2 DMV | 10 | 10 (0) | 240 | 0 | 0 | 9 | 0 |
| 3 My 2025 | 8 | 8 (0) | 195 | 0 | 2 | 12 | 0 |
| 4 Transfer portal | 10 | 10 (10) | 406 | 119 | 4 | 32 | 7 |
| 5 My 2026 | 10 | 10 (0) | 240 | 0 | 0 | 2 | 0 |

Sources by league:
- Every league has roster (6 per manager), standings (5), tx (5-7), draft (3: auto rate, reach rate, pick vs consensus; not priceable) and outcome (5).
- League 4 also has chat (14 per manager) and Nick's priors (20 rows in total).
- The outcome block comes from the archetype build of 2026-09-18 01:38, which covers week 1 only.

## Hand-off
- **E2 (refresh loop):** after `chatBackfill()` in `scripts/refresh-live-data.mjs`, run it sequentially, in the same pattern as `transactionsCapture`:
  `spawnSync(process.execPath, ['--env-file-if-exists=.env', 'scripts/build-manager-signals.mjs'], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 2 * 60 * 1000 })`.
  Exit 0 means ok. Exit 1 means at least one league failed; the reason is in `sync_log.last_detail`.
  It must run **after** the chat rollup, not beside it. The rollup (`scripts/chat/extract_league_chat.py#rollup`) drops and recreates `manager_chat_profile` and `manager_player_sentiment` outside a transaction. Observed: a run that overlapped the live rollup failed with "no such table: manager_chat_profile". It failed loudly and wrote nothing.
- **T0 (trade-engine):**
  1. The hard tier now applies only in trade-engine. Keep the 0.55 there; `counterparty.receptiveness` no longer includes it.
  2. `perception_delta` is null for uninformed deals (the factor becomes 1). For informed deals it still includes our own value gap. `perception_shift` is the view-only part; switching the ±10% factor to it removes the remaining double count.
  3. Add `counterpartyDataKey(lg.id)` to the `findTrades` fingerprint `extra`. Rebuilt signals currently serve stale rankings. Also, `manager_profiles` is fingerprinted by row count only, so a tier change with the same count is a cache hit.
  4. `unique` is taken before the mutual filter, so a non-mutual variant can hide a mutual variant of the same idea (league 4, Deebo for Coker).
- **T1 (Trade Brain):**
  - `negotiationProfilesFor(leagueId)` returns `{available, reason, byRoster, self, invalid, unmapped}`.
  - Only `priceable` sources in `SIGNAL_SOURCES` may enter a price.
  - League 3 roster 2 is the same ESPN member as league 4 roster 7 (Haiden). His chat reads and profile are **not** carried across by this item, per the brief. Whether a person's profile transfers between leagues is T1's call.
- **Owner of `scripts/build-negotiation-profiles.mjs`:** import `NEGOTIATION_PROFILE_SCHEMA` and `negotiationProfileErrors` from counterparty-pricing instead of carrying a second copy.
- **Tests (suite owner):** add `GRIDIRON_CHAT_DB_PATH ??= '/nonexistent/...'` to `test/offline-guard.mjs` so no test can read the private corpus. After this change the existing trade tests no longer open it, but nothing enforces that.
