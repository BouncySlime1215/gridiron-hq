# Claude's changes — handoff for Codex review

Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`, branch
`feat/model-honest-rebuild`. This is the live instance the user actually runs (port 5177),
not the isolated git worktree a separate Claude session started in. Three commits so far:

```
06eae54  Fix live-draft ESPN sync: bad D/ST filter, silent error swallowing, races
b518983  Make Trade Lab suggest real trades, fix league-switch stale-data flash
7a1ac35  Add Live Draft Hub: ESPN live-draft sync with AI pick advice
```

**Important:** `7a1ac35` bundles two different things. The bulk of it — `client/src/pages/LiveDraft.tsx`,
`server/services/draft-assist.js`, `server/services/espn-draft.js`, the wiring in `client/src/App.tsx`
and `server/routes/drafts.js` — was **pre-existing uncommitted work that already existed in this
checkout before Claude touched it** (likely yours). Claude found it, made one bug fix inside it
(described below), and committed the whole thing as one snapshot so it wouldn't be lost. **Claude
has not reviewed that pre-existing code beyond the specific bugs listed here** — treat all of
`espn-draft.js`, `draft-assist.js`, and `LiveDraft.tsx` as needing your own pass, not just the diffs
credited to Claude below.

---

## Changes Claude actually made, by file

### `server/services/draft-assist.js` — K/DEF invisible to the AI assistant
`boardState()`'s player pool came entirely from `computeConsensus()` (`server/routes/aggregates.js`),
which structurally excludes kickers/defenses (no ADP/market value → filtered out). Result:
`positions.K`/`positions.DEF` always reported `available: 0` regardless of reality, so `rankTargets()`
and the `/advice` Claude prompt (built from the same pool) could never recommend a K or DEF, even in
the last two rounds. The scoring logic already there (`'far too early for a kicker'` /
`'stream a defense at the end'`) was dead code with no candidates to ever reach it.
**Fix:** tail-inject undrafted `position IN ('K','DEF') AND fantasy_relevant=1` players at a late
rank, same idiom `buildMarketPool()` in `server/routes/drafts.js` already used. Verified live:
`positions.K.available` went from 0 to 47 on a real draft.

### `server/services/espn-draft.js` — live-draft sync bugs (the "draft feature didn't work" report)
Four issues, all in `syncLiveDraft`:
1. **D/ST detection used a guessed numeric range** (`playerId > 0 || playerId < -1000`) instead of
   ESPN's actual "unfilled slot" sentinel, which the file's own top comment says is exactly `-1`.
   Any real pick whose id fell in the gap between those two ranges was silently treated as still
   empty and never mirrored. **Fixed** to `playerId != null && playerId !== -1`.
2. **The insert's catch block swallowed every failure**, not just the one case it was written for
   (a player re-mirrored under a different pick number after an ESPN-side trade). A real bug there
   would vanish with zero log, zero error. **Fixed**: only swallow the specific
   `UNIQUE ... player_id` case; log everything else via `console.error` and collect into a
   `failures` array now returned from `/sync`.
3. **Unmapped team → corrupted `team_slot`.** If `slotOf.get(p.teamId)` came back undefined, the old
   code fell back to storing the raw ESPN team id as if it were a draft-slot number — `team_slot`
   drives "is this my pick" everywhere downstream. **Fixed**: skip the pick (it'll retry next poll)
   instead of writing a wrong number.
4. **No overlap guard**, client or server, on the 4-second poll. ESPN can respond slower than 4s
   during a real draft; two overlapping `/sync` calls could race through player-resolution/insert.
   **Fixed**: an in-flight `Map` per `draftId` server-side (`syncLiveDraft` now dedupes concurrent
   calls to the same draft), plus a `syncing` ref client-side in `LiveDraft.tsx`'s `tick()`.

Also added: a `desynced` flag (`mirrored count < ESPN's own pick count`) returned from `/sync` and
surfaced as a red "⚠ OUT OF SYNC WITH ESPN" banner in `LiveDraft.tsx`, so a future drift is visible
instead of silent. **This was not tested against a real live ESPN draft** — there wasn't one running
to test against. It's logic-reviewed and the server boots/responds fine, but the actual failure mode
(a real draft, real ESPN payloads, real network timing) is exactly what couldn't be exercised.

### `server/services/trade-engine.js` + `server/routes/tradelab.js` — Trade Lab realism
The live UI (`TradeLab.tsx` → `server/routes/trades.js` → `trade-engine.js`) scored every trade
purely on lineup-points/market-value math, blind to real roster construction. Separately, a much
better analysis engine already existed at `server/routes/tradelab.js` (`analyzeLeague()` — real
per-position needs/surplus off VOR, contention-window classification) but **was never wired into
the UI anything actually calls** — confirmed via `grep`, zero references from `TradeLab.tsx`.
**Fix:** `trade-engine.js` now calls `analyzeLeague()` (via a new `rosterContext()` helper) inside
`findTrades()` and `offerFor()`, and `evaluate()` gained a `ctx` param that:
- hard-blocks any package that would leave the counterparty with an empty starting lineup slot
  (`bestLineup().holes` was already computed, just never checked before deciding a deal was worth
  showing — `ev.them.new_holes.length > 0` now excludes it before it's even scored)
- flags (`red_flags`) a package that digs into a position that's already a real need for them,
  unless it clearly improves their lineup overall anyway
- surfaces `their_window` (Rebuild/Win-now/Juggernaut/etc.) on every deal object
`TradeCard.tsx` renders both new fields. **Found and fixed en route:** `analyzeLeague` in
`tradelab.js` wasn't `export`ed — importing it broke the server on first restart; one-line fix,
verified back up immediately after.
**Known, deliberate non-fix:** `pickInventory()` (draft-pick trading) is Sleeper-only by upstream
ESPN-API limitation — ESPN exposes no traded-pick ledger. Draft picks still never appear in
suggestions for ESPN leagues (all of this user's leagues). Not something wrong in this codebase to
fix; would require new ESPN scraping/integration if ever wanted.

### `client/src/api.ts` + `client/src/pages/TradeLab.tsx` — league-switch stale data
`useApi`'s "keep old data during a background refetch" guard (`hasData` ref) didn't distinguish
"refreshing the same resource" from "the path changed because you switched leagues" — switching
leagues showed the **old** league's roster/rankings/trade data under the **new** league's label
until the fetch resolved. **Fix:** track the previous `path` in a ref; reset `data`/`hasData` when
the path identity changes to something different, not just on every call. Also reset
`TargetPlayer`'s and `MockTrade`'s local selection state (`picked`, `give`/`get`/`result`) on
`leagueId` change in `TradeLab.tsx` — same staleness bug at the component level, same fix pattern.

---

## What Codex should specifically look for

1. **`espn-draft.js`/`draft-assist.js`/`LiveDraft.tsx` pre-existing code, wholesale** — Claude only
   patched the four specific sync bugs and the K/DEF pool gap above. Everything else in those files
   (cookie/auth handling, the ESPN payload parsing beyond D/ST ids, the Claude `/advice` prompt
   construction, all of `LiveDraft.tsx`'s rendering) has not been reviewed by Claude at all.
2. **The `desynced` banner and in-flight guard are untested against a real live ESPN draft.** Worth
   deliberately exercising if you have a way to (a real or mock live draft session) rather than
   trusting the logic read.
3. **`rosterContext()` in `trade-engine.js` calls `analyzeLeague(lg)` fresh on every `findTrades()`/
   `offerFor()` call** — that's a full roster re-fetch/re-enrichment on top of the one `trade-engine.js`
   already does for the same league in the same request (`assetUniverse`/`loadRosters` vs.
   `leagueRosters` in `tradelab.js` — two separate, near-duplicate roster-loading implementations
   now both running per request). Not wrong, but worth checking for a perf/latency issue on larger
   leagues, and it's the kind of duplication that drifts out of sync with itself over time if one
   copy gets a bugfix and the other doesn't.
4. **`hurtsNeed`/`leavesHole` gating in `evaluate()`** is new logic with no automated tests (there is
   no test suite anywhere in this repo) — worth hand-checking against a couple of real trade
   scenarios in the user's actual leagues to confirm it doesn't over-block (e.g. reject too
   aggressively and make `findTrades` return suspiciously few deals for some teams).
5. **No test suite exists in this repo at all** (`grep` for `*.test.*`/`*.spec.*` returns nothing,
   no test script in `package.json`). All verification above was manual `curl` against the live
   server plus `npm run build` — there is no regression safety net for any of this.
6. User separately asked for: (a) a "sense check" AI layer on top of the trade engine's math — an
   independent Claude pass that sanity-checks a suggested deal rather than just writing pitch copy —
   and (b) a full UI/theme redesign across every tab. Neither has been started as of this handoff;
   flagging so you don't duplicate work if you pick either up.
