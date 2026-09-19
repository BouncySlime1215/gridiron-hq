# tactics-and-packages (WA T2) — TDD record

**Item:** the nine tactics as rules over the valuation map, and the edge test.
**Branch:** `cursor/betting-model-audit-fixes-1c85`. **Started from** `2fd8f9c`.
**Gate:** pre-registered in
`/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/wa/tactics-and-packages/GATE.md`,
written before the first test and the first line of code.

Nick, 2026-09-18 03:50: *"Trades are designed by the people they are being sent
to while finding an edge… if someone loves a player then abuse that, vice
versa… sneak a guy in… all the moves and mind games."*

Every measurement below is on a `VACUUM INTO` copy of `server/data.sqlite`
(taken 16:04) with `scripts/build-manager-signals.mjs` run on it, so the
all-league path is exercised rather than assumed. No production write.

## Discover → Audit → Decide

**What existed.** `docs/EXISTING-SYSTEMS-INVENTORY.md` section C has no
"tactics" row at all — the Trade Brain's tactic layer did not exist in any
form. What did exist, and what this item builds on:

| Piece | Where | State before |
|---|---|---|
| the valuation map | `counterparty-pricing.js#playerValuation` | shipped the step before; 8 named, capped sources |
| "how Nick looks" | `counterparty-pricing.js#selfRead` | shipped; offers per manager, known shopping, veto votes |
| the deal read | `#readDeal` → `trade-engine#perceptionFactorFor` | shipped; ±10% of a deal's score |
| decision latency | `league_transactions_raw` | **captured, and read by nothing** |
| `vetoVotesRequired` | `leagues.payload.settings.tradeSettings` | **synced, and read by nothing** |
| the offer ladder | `trade-engine#offerFor` | shipped, but only for a NAMED target, never for a surfaced idea |
| the edge test | — | **specified in the master plan and enforced nowhere** |

**Decision: EXTEND `trade-engine.js` through its one entry point, and add ONE
new module.** The tactics are rules over the map, not a second engine: every
per-player number a tactic quotes comes from the same `playerValuation` the map
and the trade card use, **injected** rather than re-derived, so a tactic and the
card it sits on cannot disagree. `trade-tactics.js` holds no state, opens no
chat DB, and imports only `rows`.

**Four things the inventory did not name, found by auditing before writing:**

1. **The edge test was not enforced, and was being violated on live data.**
   Reproduced independently before the gate was written: league 3 surfaced
   *Tyler Warren for Patrick Mahomes* at +0.006 with a +10.6 perception shift
   and **−0.052 without the counterparty read**; league 4 surfaced one idea with
   a **negative horizon gain** (−0.13) and two with a **negative signed score**.
   `eligible` filtered on shape (mutual, plausible, no red flags) and never on
   whether the deal was good for Nick.
2. **`vetoVotesRequired` differs per league and nothing read it** — 3 / 6 / 2 /
   5 / 4 for leagues 1-5. League 3 needs two of six other owners; league 2 needs
   six of eight. And the one package the league has ever voted against (league
   4, Nick → Rami, 4 votes of 5, 2026-09-17: McConkey + Achane out for Etienne +
   Nico Collins) sits at **+18.1% value skew against the engine's own +18
   ceiling** — the engine was allowed to propose, at its limit, exactly the
   shape the league has already voted down.
3. **`zero` stopped at `readDeal`.** The previous step built a per-source
   ablation switch into `playerValuation` and `perceivedValue`, but `readDeal`
   never took it, so a `findTrades` run with a source suppressed still priced
   every DEAL with it. Measured: zeroing all four chat sources moved **0 of 223
   deal scores** across the five leagues. This is the one edit outside my named
   files (one parameter, default `[]`, no behaviour change when unused).
4. **`bluff-detector#declarationCredibility` costs 436-631 ms on the first
   uncached `findTrades` per process** in league 4 — it opens the private chat
   DB and reads 16k messages. Not this item's code; named for whoever owns it.

## RED → GREEN

| Stage | Commit | Evidence |
|---|---|---|
| RED | `265c0b0` | 30 tests, **2 pass, 28 fail** against a stub declaring only the API surface. The two passed vacuously (loops over tactic tags that did not exist). |
| GREEN | `ffe97c9` | 31 tests, **31 pass**. |
| fixes | `9cee38a` | three things the tactics printed wrong on real data (below). |

Tests strengthened after GREEN, never weakened: `G2i` (six tactics must fire
through the real entry point, not only as unit calls), `G3b` (a direct probe
assertion), `G4b` (**the ablation must move a score**), `G5a` (the draft must
not leak into the activity sample), `G8a` (the ladder ranks on net cost).
Two expectations in my own test were corrected against the intent stated in
their own assertion message: `other_owners` for a six-team league is 4, not 5;
and the offers to Hayden number five, not four, once the space-formatted row is
counted.

## The edge test, and what it takes away

Four checks, all on OUR numbers, enforced in `findTradesUncached` before a deal
reaches the returned list, and carried on every deal as `edge`:

| check | rule |
|---|---|
| `this_week` | `me.ppg_delta > 0` |
| `horizon` | horizon-weighted gain > 0 (this week + the playoff weeks) |
| `after_value_cost` | `score_signed > 0` |
| `not_only_perception` | the same score with the perception factor removed > 0 |

A negative **playoff leg** alone is not a failure — a deal worth more now than
it costs in weeks 15-17 is a real win-now trade, and the horizon weighting is
the number the plan ranks on. It is flagged on the card (`edge.playoff_leg`).

**What it removed, per league, on the production copy:**

| league | both-teams-improve | plausible | ideas removed (mutual / plausible) |
|---|---|---|---|
| 1 Matta - Kodsi | 21 | 56 → 51 | 0 / 5 |
| 2 DMV | 4 | 25 → 23 | 0 / 2 |
| 3 My 2025 | 21 → 20 | 72 → 60 | 1 / 12 |
| 4 Transfer portal | 20 → 16 | 66 → 57 | 4 / 9 |
| 5 My 2026 | 9 | 39 → 32 | 0 / 7 |

**34 of the 35 removed ideas fail `not_only_perception`** — they were positive
only because of what the other manager thinks. One fails `horizon` alone.

## Runtime (G8)

Three alternating pairs, median, `findTrades` through the one entry point, both
trees pointed at the same chat corpus. Budget, pre-registered: cold +500 ms,
warm +20 ms.

| league | cold before | cold after | delta | warm before | warm after | delta |
|---|---|---|---|---|---|---|
| 1 | 15,270 ms | 14,688 ms | **−582** | 33 ms | 42 ms | +9 |
| 2 | 5,329 | 5,174 | **−155** | 37 | 46 | +9 |
| 3 | 4,836 | 5,026 | +190 | 35 | 38 | +3 |
| 4 | 6,455 | 6,482 | +27 | 51 | 42 | **−9** |
| 5 | 5,276 | 5,320 | +44 | 40 | 37 | **−3** |

The tactics themselves cost 62-83 ms per league. The first attempt at this
measurement was **invalid and was thrown away**: the `before` worktree has no
`data/derived/`, so it ran with no chat DB at all —
`declarationCredibility` returned instantly and league 4 priced no counterparty,
which showed as a fake +966 ms regression. Both arms now set
`GRIDIRON_CHAT_DB_PATH`.

## Three things the tactics printed wrong, found on real data and fixed

1. **The active-hours read was reporting the draft.** Every manager's picks land
   inside one league-wide sitting, so all ten managers in a league shared the
   same "busiest hour" — the hour of the draft — off 16-21 actions of which 16
   were picks. Draft rows and league waiver `PROCESS` rows no longer count.
2. **Sneak-in was a quarterback detector.** Points per unit of market price is
   not comparable across positions: a one-QB-league starter scores like a WR1 at
   a quarter of the price, so measured against the running back he rode along
   with, every QB looked like a steal. It fired on 18 of 60 league-3 ideas, led
   by *Jalen Hurts*. It now measures against the **median at the player's own
   position** in that league: 18 → 8 in league 3, 17 → 9 in league 5.
3. **The ladder showed a different return than the idea.** Rungs were keyed on
   the headline incoming piece, so the opening ask under "Ladd McConkey + Juwan
   Johnson for D'Andre Swift" was "open with De'Von Achane" — for a return that
   also included Cam Skattebo. Rungs are now the packages that land **exactly
   the same return**, ranked on what the offer costs net.

## LLM spend

**$0.** Nothing in this item calls a model. `ai_usage` for the window shows only
the hourly `nfl-news-typed-extraction` job.

## Files

- `server/services/trade-tactics.js` (new)
- `server/services/trade-engine.js`
- `server/services/counterparty-pricing.js` — `readDeal` takes `zero`; see (3) above
- `test/trade-tactics.test.js` (new, 31 tests)
