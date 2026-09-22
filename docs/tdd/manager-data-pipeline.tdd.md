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

The "old" column is the 09-17 snapshot, built from less data. Most of the move from "none" to a rate
comes from transactions captured after that snapshot, not from the reader fix. The old reader run on
the SAME data (verifier, production copy) gives Nick 0.56 (n 9), Raj 0.43 (n 7), Lars 0.44 (n 9) and
Haiden 0.50 (n 6). The reader fix's own effect is 0.56 -> 0.43, 0.43 -> 0.20, 0.44 -> 0.38 and
0.50 -> 0.40.

League 3: roster 3 (Tyler Weiss) has 0.17 (n 6), giving receptiveness 0.92. This is the only
observed-behaviour read on a counterparty outside league 4. Roster 8 (0.00, n 5) is **Nick's own
team** (my_team_id 8), so it is never used as a counterparty read.

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

## Adversarial verification (2026-09-18)

Re-run by a separate verifier on its own production copy (10:49) with the real chat DB opened read-only.
Scripts and gate: the `wa/verify-manager-data-pipeline/` scratch folder.

| Check | Result |
|---|---|
| RED before GREEN | f2248c0 fails 21/21 and cff411d fails 1/22 in their own trees. HEAD passes 22/22. The 17 neighbour files pass 114/114. |
| G1, G2, G4, G5, G6, G10 | Reproduced: 46 identity rows, league 4 unchanged, 1,273 signals, idle re-run unchanged (stamps identical), 0.38 s, sync_log ok, 9 profiles plus ME. |
| G3, all 5 leagues | Decisions, proposals, veto votes and accept rates match an independent SQL count for all 46 rosters. |
| G7 | The tier applies once: receptiveness is identical with the tier set to fair or hard. The output ratio is within 0.0054 of 0.55 across 11 real deals. That spread is rounding (score to 3 decimals, value cost to 2). GATE.md pre-registered ±0.001, but the test and the results use ±0.002 without saying so. |
| G8 | The build leaves the top 10 unchanged in all 5 leagues. In the full lists, only deals with league 3 roster 3 and league 4 Raj, Lars and Haiden move. With the old code on the built DB, every league's ranking would have moved through the perception term. |
| Fixed | 46ce795 (RED) and fe1b81a (GREEN): a missing `manager_chat_profile` (the rollup's DROP/CREATE window, or a crashed rollup) used to fail all 5 leagues. It now fails league 4 alone, which keeps its rows. |

## The cache fingerprint gave two different absences one word (2026-09-22)

Hand-off item **T0.3** above put `counterpartyDataKey(lg.id)` into the
`findTrades` fingerprint, which is what makes this defect matter rather than
merely read badly. `trade-engine.js#findTradesKey` concatenates the key into the
string a whole findTrades result is stored under, so two states that fingerprint
alike are two states whose cached answers are interchangeable.

### What it said, and what it meant

Every part of the key was read inside a catch that answered `'absent'`:

```js
const part = (table, stamp) => {
  try {
    const r = rows(`SELECT COUNT(*) AS n, MAX(${stamp}) AS m FROM ${table} WHERE league_id = ?`, leagueId)[0];
    return `${r?.n ?? 0}:${r?.m ?? ''}`;
  } catch { return 'absent'; }
};
```

`'absent'` is a true statement about one state and a false one about the other:

| State | What is true | What the key said |
|---|---|---|
| the table is not there | a league that has never built signals; there is nothing to stamp | `absent` |
| the table is there and the read throws | drifted schema, a renamed column, a half-applied migration — there IS data and we could not see it | `absent` |

So an answer computed while `manager_signals` was unreadable was stored under
the same key a league with no signals at all produces, and served to it
afterwards. The second state is the dangerous one precisely because it is
temporary: the table reads again later, the key goes back to `ms:N:stamp`, and
the entry written during the outage stays behind under the absent key.

The chat DB's `negotiation_profiles` had the identical shape, on the identical
`catch { np = 'absent'; }`.

### Why no test had found it

No writer in this repository can produce the second state. A test routed through
today's writer cannot reach a table whose shape has drifted, so the state that
has no writer is the state that has no test — the same reason four CHECKs on
`trade_outcomes` had none. Both tests here drive it through raw SQL instead.

The two existing key tests (`'stable key when nothing changed'` and `'new data
must change the key'`) both pass with the defect present and would pass with the
whole catch deleted. They measure that the key MOVES, never that it says
anything true when it cannot read.

### RED -> GREEN

| | commit | result |
|---|---|---|
| RED | `d3e0260` | 24 tests, 23 pass, **1 fail**, at `:440` — the assertion naming the collision, not a neighbour |
| GREEN | `73794cf` | 25 tests, **25 pass**, 0 fail |

**This table said 25 tests, 23 pass, 2 fail at `:440` and `:493` until
2026-09-22, and that was wrong in a way worth recording rather than quietly
editing.** The figure itself was never invented — re-run today, GREEN's test
file against RED's source gives exactly 25 tests, 23 pass, 2 fail, and `:493`
is the chat-half assertion at its GREEN line number. But that pair is a
combination no commit represents. It was labelled `d3e0260`, and `d3e0260`
holds 24 tests and one failure. Found by the chat-sync thread sampling this
branch; the command it disagreed with is the one that settles it, and it did.

This is the same error the whole branch exists to stop, turned on its own
evidence: a figure measured on one tree and reported under another tree's name.
The rule that catches it is the one already written here — a figure carries the
identity of the tree it was measured on — and it had not been applied to this
file's own RED row.

**The substantive half, which the numbers were hiding.** The chat-half test
(`'the chat half of the key says WHICH absence as well'`) does not exist at
`d3e0260`. It arrived with GREEN, so that half of the fix never had a committed
RED. That is a real gap in the TDD record and history cannot be rewritten to
close it. What can be established is whether it *would* have been red, so that
was measured rather than asserted: GREEN's test file run against `d3e0260`'s
source fails that test. The behaviour was genuinely absent at RED; only the
commit boundary is wrong, not the claim that the test discriminates.

The one RED assertion is preceded by two that pass: dropping the table and
breaking its shape each move the fingerprint away from the live one. Only
telling those two apart fails, so the row is valid in every respect except the
rule under test. The same holds for the chat half under the re-run above.

### The fix

Existence is asked of `sqlite_master` before the read, so `'absent'` is a
positive finding about the schema rather than whatever is left once a catch has
swallowed everything. A read that still throws is named `'unreadable'`.

It is reported, not thrown. One drifted table must not take down every trade
search. But it is reported **as a fault**, which is the whole point: nothing
computed blind is reused as an answer computed from an empty table.

Two fixes rather than one, because two connections — `hasTable` has to be asked
of the chat handle for `negotiation_profiles`, not of the app's.

No key changes for a healthy league or for a genuinely absent table, so no
existing cache entry is invalidated. Established from the diff rather than
measured: the success expressions and the final return template are untouched,
and the new guard returns the same literal `'absent'` on the same condition the
catch used to return it on.

### The restore, and why the test asserts it

`withTableReplaced` takes the DDL and the indexes out of `sqlite_master` rather
than retyping them — a retyped copy drifts from the migration that owns the
table, and the test then pins a shape the app does not have. Each test ends by
asserting the fingerprint came back to what it was. Without that, a restore that
rebuilt the table wrong would leave every later test in the file reading it, and
they would fail somewhere else entirely.

### What this is an instance of

A served value carries the stamp of the process that measured it, and **an
absence must say which absence it is**. This is the same defect as `read_state`
on `vetoClimate`, which set the field on two paths of three: a consumer that
asks "is this really empty?" gets an answer it cannot distinguish from "I could
not look."

### The five questions

**Is it well built?** The fix is four lines of guard and one `sqlite_master`
query, and it is well built in the narrow sense that it converts a guess read
out of an error into a positive finding about the schema. The weakest part is
that `hasTable` is asked twice per key on two different connections and its
answer is not memoised; that is a handful of `sqlite_master` lookups per
fingerprint and it was left alone deliberately, because caching the existence of
a table inside a function whose job is to notice the table changing is how this
class of bug starts.

**Are these statistics or are they made up?** Neither — no model moves and no
served number changes. The cache fingerprint is a string, not an estimate. The
one measured claim in this file is the RED/GREEN table above, and it is now
corrected to what the commits actually produce rather than to what a neighbouring
tree produced.

**How do we know?** RED `d3e0260`, 24 tests with the one failure at `:440`;
GREEN `73794cf`, 25 of 25. Both re-run on 2026-09-22 in a detached worktree at
those exact commits rather than quoted from when they were written, which is how
the mislabelled row was caught. The chat half's missing RED is established by
running GREEN's test file against RED's source, stated above as the measurement
it is.

**Is it pointed anywhere else?** Yes, and that is the risk this fix was worth
taking for: `trade-engine.js#findTradesKey` concatenates this fingerprint into
the key a whole `findTrades` result is stored under. Two states that fingerprint
alike are two states whose cached answers are interchangeable, so an unreadable
table was serving a league the answer computed for a league that had genuinely
never built anything. Nothing else consumes the key directly.

**How does it unify?** It is the branch's one rule applied to a cache key
instead of to a page: an absence must say which absence it is. The fingerprint
was the last place on the trade path where two different absences still shared a
word.
