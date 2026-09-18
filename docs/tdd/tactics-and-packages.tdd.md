# tactics-and-packages (WA T2) — TDD record

**Item:** the nine tactics as rules over the valuation map, and the edge test.
**Branch:** `cursor/betting-model-audit-fixes-1c85`. **Started from** `2fd8f9c`.
**Gate:** pre-registered in
`/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/wa/tactics-and-packages/GATE.md`,
written before the first test and the first line of code.

Nick, 2026-09-18 03:50: *"Trades are designed by the people they are being sent
to while finding an edge… if someone loves a player then abuse that, vice
versa… sneak a guy in… all the moves and mind games."*

## Discover → Audit → Decide

**What existed.** `docs/EXISTING-SYSTEMS-INVENTORY.md` section C has no "tactics"
row at all — the Trade Brain's tactic layer did not exist in any form. What did
exist, and what this item builds on:

| Piece | Where | State before |
|---|---|---|
| the valuation map | `counterparty-pricing.js#playerValuation`, `#valuationMap` | shipped the step before; 8 named, capped sources |
| "how Nick looks" | `counterparty-pricing.js#selfRead` | shipped; offers per manager, known shopping, veto votes |
| the deal read | `#readDeal` → `trade-engine#perceptionFactorFor` | shipped; ±10% of a deal's score |
| decision latency | `league_transactions_raw` | **captured, and read by nothing** |
| `vetoVotesRequired` | `leagues.payload.settings.tradeSettings` | **synced, and read by nothing** |
| the offer ladder | `trade-engine#offerFor` | shipped, but only for a NAMED target, not for a surfaced idea |
| the edge test | — | **specified in the master plan and not enforced anywhere** |

**Decision: EXTEND `trade-engine.js` through its one entry point, and add ONE new
module.** The tactics are rules over the map, not a second engine: every
per-player number a tactic quotes comes from the same `playerValuation` the map
and the trade card use, injected rather than re-derived, so a tactic and the
card it sits on cannot disagree. `trade-tactics.js` holds no state, opens no
chat DB, and imports only `rows`.

**Three things the inventory did not name, found by auditing before writing:**

1. **The edge test was not enforced, and was being violated on live data.**
   Reproduced independently on my own `VACUUM INTO` copy before writing the
   gate: league 3 surfaced *Tyler Warren for Patrick Mahomes* at score +0.006
   with a +10.6 perception shift and **−0.052 without the counterparty read**;
   league 4 surfaced one idea with a **negative horizon gain** (−0.13) and two
   with a **negative signed score**. `eligible` filtered on shape (mutual,
   plausible, no red flags) and never on whether the deal was good for Nick.
2. **`vetoVotesRequired` differs per league and nothing read it** — 3 / 6 / 2 /
   5 / 4 for leagues 1-5. League 3 needs two of six other owners; league 2 needs
   six of eight. And the one package the league has ever voted against (league
   4, Nick → Rami, 4 votes of 5, 2026-09-17) sits at **+18.1% value skew against
   the engine's own +18 ceiling** — the engine was allowed to propose, at its
   limit, exactly the shape the league has already voted down.
3. **`zero` stopped at `readDeal`.** The previous step built a per-source
   ablation switch into `playerValuation` and `perceivedValue`, but `readDeal`
   never took it — so a `findTrades` run with a source suppressed still priced
   every DEAL with it. Measured: zeroing all four chat sources moved **0 of 223
   deal scores** across the five leagues. See "the one edit outside my files".

## RED → GREEN

| Stage | Commit | Evidence |
|---|---|---|
| RED | `cd18d19` | 30 tests, **2 pass, 28 fail** against a stub that declares only the API surface. The two that passed did so vacuously (loops over tactic tags that did not exist). |
| GREEN | `ffe97c9` | 31 tests, **31 pass**. |
| ablation fix | (see below) | `zero` threaded through `readDeal`; a new assertion fails if zeroing a source moves no score. |

Tests strengthened after GREEN, never weakened: `G2i` (seven tactics must fire
through the real entry point, not only as unit calls), `G3b` (a direct probe
assertion so the rule is covered whether or not this week's search happens to
produce one), `G4b` (the ablation must move a score). Two expectations in my own
test were corrected against the intent stated in their own assertion message:
`other_owners` for a six-team league is 4, not 5, and the five offers to Hayden
include the one written in the space-separated format.

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

## LLM spend

$0. Nothing in this item calls a model.

## Files

- `server/services/trade-tactics.js` (new)
- `server/services/trade-engine.js`
- `server/services/counterparty-pricing.js` — one parameter, see above
- `test/trade-tactics.test.js` (new)
