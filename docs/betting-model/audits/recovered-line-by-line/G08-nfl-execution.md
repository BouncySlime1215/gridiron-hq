# G08-nfl-execution — the NFL money path, line by line

Reader: G08-nfl-execution. Date: 2026-09-11 (NFL Week 1 weekend). Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` (read-only). 30 files, 8,755 lines, every line read (each file's `lines_read` equals `wc -l`). DB observations were taken with `node:sqlite { readOnly: true }` against `server/data.sqlite`; nothing was written, no process was touched.

All paths below are relative to the repo root unless absolute.

---

## 0. Answers to the focus questions

### 0.1 The money path, traced

```
game_lines (ESPN reference quote)  ──►  nfl-auto-picks.js#computeDecisionBoard (ensemble → calibrated cover probability)
        │                                        │ applyNflPolicy (nfl-policy.js:186)  ← minEdge 3, calibration gate, EV ≥ 0.01 after 0.01 haircut
        │                                        ▼
        │                          nfl-execution-pipeline.js#runExecutionPipeline (:96)
        │                              ├─ recordDecisionRun → nfl-decision-tape.js (:354)   [append-only, triggers verified live]
        │                              ├─ contractKey → nfl-contract-key.js (:149)
        │                              ├─ resolveQuoteBasis (:42) — quote tape or single ESPN sample
        │                              ├─ openOpportunity / recordObserved / recordDecision → nfl-execution-lifecycle.js
        │                              └─ replayDelayLadder → nfl-execution-replay.js (preview only)
        ▼
POST /api/nfl-market/execution/:id/accept  (nfl-market.js:362, model:execute)
        └─ attemptAcceptance → nfl-execution-decision.js (:120)
               ├─ exposure gate      nfl-execution-exposure.js#checkExposureBudget (3u/game, 8u total)
               ├─ corridor gate      nfl-execution-corridor.js (11.5 pts) — only if model_line & market_line frozen
               ├─ suspect-price gate nfl-execution-attribution.js#challengeExtremePrice (fair EV > 0.15)
               ├─ refreshedEconomics (:71) — EV at the accepted price vs minExpectedReturn
               └─ recordAcceptance → lifecycle (:297)  source='user_recorded', fill_confirmed=0 (schema)
        ▼
POST /api/nfl-market/execution/settle → settleExecutionOpportunities (pipeline:256) → settleOpportunity (lifecycle:320)
        └─ realized P&L from the ACCEPTED event's own price/stake; corrections append (lifecycle:381)
        ▼
GET /api/nfl-market/execution/clv → executionClvReport (nfl-execution-clv.js:232) — read-only projection vs quote-tape close
```

The stake itself is **never sized by the model on this path**: `stakeUnits` is a human-supplied number (`nfl-market.js:365-377`), and the pipeline never calls `stakeFor`. Kelly sizing exists only on two side paths — the Wong teaser path and the execution-slate recommender — and both derive `source: 'execution'`.

### 0.2 Where exactly `stakeFor({source:'model'})` returns zero

`server/services/nfl-execution-edge.js:623-633`:

```js
export function stakeFor({ winProbability, americanPrice, source = 'model',
  bankrollUnits = 100, fraction = 0.25, provenClv = null, maxUnitsPerBet = 3 } = {}) {
  if (source === 'model' && !(provenClv > 0)) {
    return {
      units: 0, blocked: true,
      reason: 'A model-derived probability has not demonstrated closing-line value. ...'
    };
  }
```

Two properties of that line matter:

1. It is a **deny-list on the literal string `'model'`**. `source: null`, `source: 'Model'`, `source: 'forecast'`, `source: 'execution '` (trailing space) all fall through to Kelly. The commit 14c5e65 message states the principle "a sizing gate that defaults to permitting is not a gate" and this gate defaults to permitting for every unrecognised source. Today the only callers pass fixed strings (`'execution'` from `nfl-teasers.js:273`; `SOURCE_OF_KIND[c.kind] ?? 'model'` from `execution-slate-reasoning.js:312`), so it is latent, not live. Defect D03.
2. `provenClv > 0` unblocks a model source on any positive number — `provenClv: 1e-9` passes — while the reason text promises "positive median CLV over ~200 settled bets". No caller passes `provenClv`. Defect D19.

### 0.3 Can any path size a stake on a model edge?

Every path that produces a stake number, and what gates it:

| Path | File:line | Sizes on | Gate | Persists? | Auth |
|---|---|---|---|---|---|
| `stakeFor` (edge) | `nfl-execution-edge.js:623` | winProbability | `source==='model'` → 0 | no | n/a |
| Teaser legs | `nfl-teasers.js:271-273` | `ev.probabilities.win` (measured leg family) | source `'execution'`, price ≥ -115, EV > 0 | no (display) | GET /betting/teasers/candidates — none |
| Slate recommender | `execution-slate-reasoning.js:302-320` | `c.win_probability` | `kind→source` enum; shopped_line refused unless `qualified===true` (always false today) | no | POST /execution-slate/recommend — model:execute |
| `staking.js#stakeFor` | `staking.js:116` | any `winProb` | **none** | no | GET /nfl-betting/stake — none (labelled `validation_gate_applied:false`) |
| `staking.js#safeStakeFor` | `staking.js:292` | any `winProb` | `calibrationPassed`, `forwardSettled≥250`, `uncertaintyWidth≤24` — **all client-supplied query/body flags** (`nfl-betting.js:973-976, 999-1002`) | no | none |
| `compareStakingPolicies` | `nfl-execution-staking-policy.js:104` | shrunk model probability | `isCalibrated(scorecard)` | no | **unwired** (test-only importer) |
| Auto-picks `units_staked` | `nfl-auto-picks.js:39` | n/a | `process.env.NFL_MODEL_STAKE_UNITS || 0` | **yes** (`nfl_auto_picks`) | scheduler |
| Pick watch `recommended_stake_units` | `nfl-pick-watch.js:101` | n/a | `marketGateOpen` AND env var | yes (`nfl_pick_watch_log`) | scheduler |
| Acceptance | `nfl-execution-decision.js:120` | human `stakeUnits` | exposure/corridor/suspect/EV | **yes** (lifecycle ledger) | model:execute |
| Teaser execution | `nfl-teaser-execution.js:222` | human `stake_units ≤ 5` | candidate must be `eligible` on the live board | **yes** (`nfl_teaser_executions`, mode `placed` allowed) | POST /betting/teasers/executions — **none** |
| Wong direct path | `routes/wong.js:459-620` | human stake | validated legs; hub gates only if the hub board can see the book | **yes**, same tables | POST /betting/wong/tickets — **none** |
| User bets | `nfl-user-bets.js:9` | human `units_staked` (default 1) | none | yes (`nfl_user_bets`) | model:execute |

So: **no code path sizes a persisted stake on a model probability.** The only persisted stakes are human-entered (`attemptAcceptance`, `recordTeaserExecution`, `recordWongTicket`, `addUserBet`) or the env-var constant (currently unset; `.env` has no `NFL_MODEL_STAKE_UNITS`). The two unpersisted calculators (`/nfl-betting/stake`, `/nfl-betting/stake/safe`) will print a nonzero unit figure on a model probability — the first by design and labelled, the second whenever the caller asserts `calibrated=1&forward_settled=250&interval_width=10` (D08).

Live DB state confirms zero model-sized money: `nfl_execution_opportunities` 0 rows, `nfl_execution_lifecycle_events` 0 rows, `nfl_execution_log` 0 rows, `nfl_decision_runs` 0 rows, `nfl_pick_watch_log` 0 rows. `nfl_auto_picks` has 5 rows for 2026 wk 1 at `units_staked=1` each, but all five were **voided** on 2026-08-28 (they predate the policy columns; `policy_id` is NULL) and `standing()` excludes voids (`nfl-auto-picks.js:273`). `nfl_teaser_executions` has one paper ticket (1u, DraftKings +100). `nfl_user_bets` has one row (CAR +2.5, 1u).

### 0.4 Commit 14c5e65 — what was open, and is it closed at the line?

The commit says four things were open. Checked against the current tree:

| Claim | Where it is now | Closed? |
|---|---|---|
| `POST /api/execution-slate/recommend` had no auth and would size real stakes | `server/routes/execution-slate.js:60` — `r.post('/recommend', requireModelPermission('model:execute'), …)` | Yes |
| `shoppedLineOpportunity` stripped `qualified` so the gate could never read it | `execution-slate-reasoning.js:188` carries `qualified: rowIn.qualified === true`; `:302-309` blocks `kind==='shopped_line' && qualified !== true` with `ceiling_units: 0` | Yes; a missing flag blocks |
| `dec()`/`impliedProb()` accepted \|price\|<100 | `nfl-execution-edge.js:65-74` `assertRealPrice` throws on `Math.abs(american) < 100` | Yes in edge.js — **but** three sibling copies were not patched: `nfl-shopping-board.js:32` (`dec`), `execution-slate-reasoning.js:108` (`dec`), `staking.js:90-91` (`americanToDecimal`/`americanToProb`), and `nfl-execution.js:38-40` (`payoutPerUnit(0)` = `100/0` = Infinity). See D05, D14, D20. |
| Teaser stake sized on `hist.win_rate ** 2` | `nfl-teasers.js:271-273` uses `ev.probabilities.win`; `nfl-teaser-execution.js:81-86` uses `ticketProbabilities([perLeg, perLeg]).win` | Yes |

What the commit did **not** do, and says so: the board still *ranks* by the same biased empirical cover rate. `shoppingBoard()` sorts every side across every game by `expected_net_return` (`nfl-shopping-board.js:205-212`), and `coverProbabilities` (edge:375) is the historical cover rate near the posted number, which carries the underdog bias the commit measured (+6.5 → 53.53%, +10 → 55.28%). Dogs float to the top of the board and `executionBoardSummary().best_expected_return` (`:414`) reports the biggest of them. It is labelled `qualified: false` (D11), so it cannot reach a stake, but the number Nick reads first on that board is bias, not edge.

One historical artifact of the pre-fix path survives in the ledger: `nfl_teaser_executions` id 1 (paper, logged 2026-09-11T01:00Z, before the 02:38Z commit) carries `expected_ticket_probability 0.5485` (= 0.7406²) and `expected_ev 0.0969` — the superseded squared-rate and the pre-push-correction +9.70%. The row is mutable (no trigger) and unlabelled (D16).

### 0.5 Is the decision tape truly append-only?

Yes, at the schema level, verified in the live DB (`sqlite_master`, read-only): `nfl_decision_events_no_update`, `nfl_decision_events_no_delete`, `nfl_decision_runs_no_update`, `nfl_decision_runs_no_delete`, `nfl_decision_run_invalidations_no_update/_no_delete`, and `nfl_execution_lifecycle_events_no_update/_no_delete` all exist. Migration sources: `server/migrations/027_decision_tape.js:118-126`, `031_decision_identity.js:168-170, 189-193, 227-229`, `023_execution_lifecycle_ledger.js:101-106`, `028_settlement_corrections.js:61-66`. The partial unique index `idx_lifecycle_single_state … WHERE state NOT IN ('refreshed','settlement_correction')` is present, matching 028. `recordDecisionRun` writes header and children in one `BEGIN IMMEDIATE` (`nfl-decision-tape.js:430-484`) and refuses same-observation/different-content (`:400-406`) and incomplete legacy runs (`:411-417`).

Two things are **not** append-only and matter to the money path:

- `nfl_execution_opportunities` has **no triggers at all** (grep of migrations: none; live `sqlite_master`: none). Its `status` column is meant to change (`lifecycle.js:243`), but so can `model_line`, `model_probability`, `market_line_at_decision`, `push_probability` — the very columns `attemptAcceptance` reads as "authoritative … never from the request body" (`nfl-execution-decision.js:28-39, 160-162`). A plain `UPDATE` (or a future migration) can rewrite the frozen forecast the safety gates check. D04.
- `nfl_teaser_executions` / `nfl_teaser_execution_legs` are updated in place by `settleTeaserExecution` (`nfl-teaser-execution.js:355-360`), `nfl_user_bets` rows are hard-deleted by `removeUserBet` (`nfl-user-bets.js:26`), and `nfl_pick_decisions` is an UPSERT (`nfl-auto-picks.js:208-217`). All three are outside the tape by design, but the first is the forward ledger of the only measured-positive strategy (D01, D21).

### 0.6 Fourteen `nfl-execution-*.js` files — which are redundant?

| File | Lines | Importers outside test/ | Verdict |
|---|---|---|---|
| nfl-execution.js | 300 | betting-hub, lifecycle, pick-watch, attribution, stress, replay, teaser-execution, db/schema | active — but its `logExecution/executionLedger` + `nfl_execution_log` is a **second routing ledger** (0 rows) parallel to the lifecycle ledger |
| nfl-execution-edge.js | 810 | betting-hub, abstention-audit, polymarket-lines, nfl-execution, shopping-board, teasers, slate-reasoning, staking-policy, espn-line-watch, stress | active; the staking authority |
| nfl-execution-decision.js | 212 | routes/nfl-market | active |
| nfl-execution-pipeline.js | 302 | routes/nfl-market, platform/code-identity, client NflExecutionDesk | active |
| nfl-execution-lifecycle.js | 491 | nfl-market, pipeline, clv, decision | active |
| nfl-execution-clv.js | 354 | routes/nfl-market | active |
| nfl-execution-clv-downsize.js | 484 | **only** nfl-execution-staking-policy.js (itself orphaned) | **orphaned chain** — 484 lines of control law + derivation with no production consumer |
| nfl-execution-corridor.js | 211 | decision | active |
| nfl-execution-attribution.js | 205 | decision (only `challengeExtremePrice`); `threeWayAttribution`/`attributePnl` have no production caller | half-active |
| nfl-execution-exposure.js | 107 | decision, stress | active |
| nfl-execution-replay.js | 429 | pipeline, stress | active (preview only) |
| nfl-execution-staking-policy.js | 132 | **none** (test only) | **orphaned** — the prop-market calibrated-Kelly path was never wired to `propMarketScorecards` |
| nfl-execution-stress.js | 166 | **none** (test only) | **orphaned** — scenario harness; belongs under test/ or research/ |
| nfl-execution-validation.js | 48 | pipeline, lifecycle, replay, decision | active |

Redundancy beyond the fourteen: `staking.js` re-implements `kellyFraction`/`stakeFor` (`staking.js:99-136`) without the source gate or the price guard; `nfl-policy.js:120-133` defines an `expectedNetReturn({winProbability, americanPrice, pushProbability})` while `nfl-execution-decision.js:46` imports a *different* `expectedNetReturn({win, loss, americanPrice})` from `server/betting/nfl/contracts/spread-probabilities.js:176` under the same name; `parseEventKey` is duplicated verbatim in `pipeline.js:242` and `clv.js:186`; `modeOf`/`modeOfLines` in `clv.js:192` and `edge.js:402`; `americanToDecimal` in `staking.js:90`, `nfl-user-bets.js:30`, `nfl-auto-picks.js:231`; and spread settlement is implemented three times (`nfl-user-bets.js#gradeBet:32`, `nfl-auto-picks.js#gradePick:238`, `pipeline.js#settleExecutionOpportunities:256`).

---

## 1. Per-file notes

Format: purpose · key functions · data read/written · wiring · defects (path:line + snippet) · verdict.

### 1.1 server/services/nfl-execution.js (300 lines, read 300)

**Purpose.** Book routing for a *decided* bet: `rankBooks` scores every book's quote for one side against a synthetic median (price in probability space, line via `lineMoveValue`), `routeBet`/`routeSlate` pick the best book, `logExecution`/`executionLedger` keep `nfl_execution_log`.

**Reads.** `nfl_line_snapshots` via `simultaneousQuotes` (shopping-board). **Writes.** `nfl_execution_log` (`:265-276`).

**Wiring.** Imported by betting-hub (GET `/execution/route`, `/execution/slate`, POST `/execution/log`, GET `/execution/ledger` — all unauthenticated), lifecycle (`payoutPerUnit`), replay (`breakEvenRate`), pick-watch (`rankBooks`), attribution, teaser-execution, stress.

**Defects.**
- D05 (P2) `:38-40` `payoutPerUnit = odds => … odds > 0 ? odds/100 : 100/Math.abs(odds)` and `:79` `usable = quotes.filter(q => Number.isFinite(priceOf(q)))` — a price of `0` is finite, `payoutPerUnit(0)` is `Infinity`, `breakEvenRate(0)` is `0`, so that book ranks **best** with `saved_vs_worst_pct` ≈ 0.5. This is not hypothetical: `nfl_line_snapshots` holds `betrivers | h2h | San Francisco 49ers | price 0 | provider free:kambi | captured 2026-09-11T03:09:25Z` (not the latest capture for that event, so today's board is clean). Commit 14c5e65 guarded `edge.js` only; the routing path — the module whose header calls itself "the only module in the project built on a measured positive" — still routes to a fake price and would log it as savings.
- D13 (P3) `:71-73` and `:199-202`: docblock and returned `note` say "For spreads a better LINE beats a better price … price only breaks ties at equal lines", but `advantage()` at `:115-130` scores line and price on one probability scale precisely because the line-first heuristic was wrong (`:104-109`). The note contradicts the code it ships with.
- D17 (P2, shared) `routes/betting-hub.js:557-566` POST `/execution/log` writes `nfl_execution_log` with `stake_units` from the query string and no auth; `logExecution` (`:263`) validates nothing about `stake_units`.

**Verdict.** Correct arithmetic after the C05/2026-09-10 fixes; the price-0 hole and the stale note are the residue. The ledger is empty and duplicates the lifecycle ledger's job.

### 1.2 server/services/nfl-execution-edge.js (810, read 810)

**Purpose.** Execution-edge pricing and the staking authority: margin distributions (`marginDistribution`, `marginResidualDistribution`, `marginsByPostedLine`, `noForecastMarginDistribution`), `lineMoveValue`/`lineMoveTransitions`, `coverProbabilities`, `bestExecution` (rank books by expected net return at each book's line+price), `kellyFraction`, `stakeFor`, `RISK_MODES`/`riskModes`, `realBreakEven`, `executionEdgeSummary`.

**Reads.** `game_lines` (scores, spread, spread_odds). **Writes.** none.

**Wiring.** The gate every sizing consumer is supposed to route through (`stakeFor`). `bestExecution` feeds `shoppingBoard`; `lineMoveValue` feeds `rankBooks`, `nfl-espn-line-watch`, `polymarket-lines`.

**Defects.**
- D03 (P2) `:625` `if (source === 'model' && !(provenClv > 0))` — deny-list on one literal; any other string sizes. Should be `source !== 'execution'` (or a closed enum) so the gate fails closed. Latent today (callers pass fixed strings).
- D19 (P3) `:625` `provenClv > 0` — any positive value satisfies a gate whose own reason text (`:630-631`) demands "positive median CLV over ~200 settled bets"; no magnitude or sample-size check. No caller passes it.
- D10 (P2) `:93-94`, `:218-219`, `:276-277` — all three distribution queries read every season of `game_lines` with no season bound. `nfl-teasers.js:33-38` documents that `game_lines.spread` is corrupted for 2025 and 2026 ("integer share falls 47.7% → 24.9% → 16.2%; -8.0 and +2.0 buckets hold zero rows") and excludes them via `MEASUREMENT_SEASONS`. Live DB confirms: integer-spread share 276/570 (2023), 272/570 (2024), **142/570 (2025), 92/544 (2026)**. The key-number mass that `lineMoveValue` and `noForecastMarginDistribution` price half-points from is therefore pooled with two seasons the same repo calls contaminated. This moves `expected_net_return` on the shopping board (display), not stakes.
- D18 (P3) `:782` `const probs = g.map(x => impliedProb(x.spread_odds))` — `impliedProb` now throws on \|odds\|<100; one bad `spread_odds` row would 500 `executionEdgeSummary`. Live DB: 0 such rows today.
- D06 (P2, shared with shopping-board) `:422` `usable = (quotes ?? []).filter(q => Number.isFinite(q.american_price))` then `:429` `usable.map(q => dec(q.american_price))` — `dec(0)` throws `TypeError`. The feed does emit price 0 (see D05), so the intended "feed stops" is "the whole `shoppingBoard()`/`executionBoardSummary()` call 500s" rather than "that quote is dropped".
- (P3) `:588` `kellyFraction` does not validate `fraction` (a `fraction` of 4 sizes four-times-Kelly); `riskModes` at `:715` re-validates its own inputs but `stakeFor` at `:623` does not validate `fraction`, `bankrollUnits`, or `maxUnitsPerBet`.

**Verdict.** The strongest file in the group; the residual defects are gate shape (deny-list) and data hygiene (season contamination, price-0 crash).

### 1.3 server/services/nfl-execution-decision.js (212, read 212)

**Purpose.** Gated acceptance: `refreshedEconomics` re-prices the frozen forecast at the accepted price; `attemptAcceptance` runs exposure → corridor → suspect-price → economics, then `recordAcceptance`.

**Reads.** `nfl_execution_opportunities` (via `getOpportunity`), open exposure. **Writes.** lifecycle event via `recordAcceptance`.

**Wiring.** `routes/nfl-market.js:362` (model:execute). The route never passes `offPolicy`, so the economics gate cannot be bypassed from HTTP; `line`/`price`/`book`/`stakeUnits` are caller-supplied, forecast inputs are read from the persisted row (`:160-162`).

**Defects.**
- D12 (P3) `:88-93` the `line_changed_no_qualified_distribution` branch is unreachable from `attemptAcceptance`: for spreads `:152` `assertSpreadLine(opportunity.contract_key, line)` already throws `contract_line_changed` (400) on any line mismatch; for non-spreads `spreadContractTerms` returns null so `contractLine` is null and the comparison is skipped. Dead code inside the gate; only a direct unit test can reach it.
- D24 (P3) `:46` imports `expectedNetReturn` from `spread-probabilities.js` (signature `{win, loss, americanPrice}`) while `nfl-policy.js:120` exports another `expectedNetReturn` (`{winProbability, americanPrice, pushProbability}`). Same name, different contract, both on the money path; arithmetic agrees today (`decided*(p*b-(1-p))` both ways) but only by inspection.
- (P3) `:102` `Math.min(Math.max(frozenProbability - active.probabilityHaircut, 0), 1)` clamps at 0 rather than refusing a probability that a haircut pushed negative; harmless with haircut 0.01.

**Verdict.** Sound; the E4 fix (forecast inputs from the row) is real. Its authority rests on the opportunity row being frozen, which it is not at the schema level (D04).

### 1.4 server/services/nfl-execution-pipeline.js (302, read 302)

**Purpose.** Connect the decision board to the ledger: tape the whole board, then for each selected spread candidate resolve a quote basis, open OFFERED→OBSERVED→DECISION, attach a replay preview. `settleExecutionOpportunities` grades accepted spreads from `game_lines`.

**Reads.** `game_lines` (kickoff, scores), `nfl_quote_tape`, decision board (cached). **Writes.** tape run + events, opportunities + lifecycle events, settlement events.

**Wiring.** POST `/nfl-market/execution/run` (model:train), POST `/execution/settle` (model:train); client `NflExecutionDesk.tsx:130,136`. No scheduler job calls it (`nfl-market.js:313-317`).

**Defects.**
- D22 (P3) `:128` `recordDecisionRun(season, week, board, …)` with default `computationStatus:'complete'`; `nfl-decision-tape.js:277-281` throws when a complete computation carries zero decisions. A week with no `game_lines` rows (bye/offseason, or an early call before lines sync) makes `/execution/run` 500 instead of recording `unavailable`.
- (P3) `:19` — `import` placed after a `const` at `:18`; ESM hoists it, but it reads as if the constant depended on ordering.
- (P3) `:242-245` `parseEventKey` duplicated in `nfl-execution-clv.js:186-189`.
- Settlement is correct: `:288-291` grades from the selected team's own row (`margin > -accepted.line`), matches `nfl-auto-picks.js:250-252` and `nfl-user-bets.js:38-43`; three copies of the same rule (merge candidate).

**Verdict.** Acceptable; correct on the settled path, and honest about what it does not do (no acceptance, no scheduler).

### 1.5 server/services/nfl-execution-lifecycle.js (491, read 491)

**Purpose.** The state machine and ledger: `openOpportunity`, `recordState` (transition guard + append), `recordAcceptance`, `settleOpportunity` (P&L from the accepted event), `correctSettlement` (delta append), `netRealizedUnits`, `getOpportunity`, `listOpportunities`, `openExposure`, `lifecycleFunnel`.

**Reads/Writes.** `nfl_execution_opportunities`, `nfl_execution_lifecycle_events` (INSERT only; the header's `status` is UPDATEd at `:243`).

**Defects.**
- D07 (P2) `:470-476` `lifecycleFunnel` sums `realized_pnl_units` over `e.state='settled'` only; `correctSettlement` (`:381-410`) stores the **delta** on a `settlement_correction` row and documents that "realized economics are the NET of ledger events, never 'whatever the last row says'" (`:373-375`). After any correction the funnel's `realized_pnl_units` (`:486`) disagrees with `netRealizedUnits` (`:417`) and with `executionClvReport.economics` (`clv.js:330`). The scorecard route `/execution/funnel` (`nfl-market.js:351`) reports the stale figure.
- D04 (P2) `:166-177` the header row carries `model_line, model_probability, market_line_at_decision, push_probability, push_treatment` — the frozen forecast the acceptance gates treat as authoritative — and nothing in the schema (no trigger, checked live) prevents an `UPDATE` of those columns. Only lifecycle *events* are guarded.
- (P3) `:447-453` `openExposure` runs one query per accepted opportunity (N+1); at 5,000 rows this is the first slow endpoint. Harmless at 0 rows.
- (P3) `:206-208` "occurredAt cannot precede the previous lifecycle event" is compared against the *last inserted* row; a `settlement_correction` recorded with a backdated `occurredAt` (the real time the score was corrected) is refused. Minor.

**Verdict.** Good ledger; one wrong aggregate (D07) and one unguarded header (D04).

### 1.6 server/services/nfl-execution-clv.js (354, read 354)

**Purpose.** Read-only CLV projection over accepted/settled opportunities: `kickoffForEvent` (from `game_lines`), `closingQuoteForContract` (last pre-kickoff quote per book from `nfl_quote_tape`, exact market/period/side, canonical event via team codes), `executionClvReport` (clv_points vs closing main line; clv_probability at the exact line; separate denominators).

**Reads.** `nfl_execution_opportunities`, `nfl_execution_lifecycle_events`, `game_lines`, `nfl_quote_tape`. **Writes.** none.

**Wiring.** GET `/nfl-market/execution/clv` (model:execute). No client caller found.

**Defects.**
- D26 (P3) `:118-119` comment says "The kickoff is matched as a one-second range", but `:127-131` binds `commence_time >= kickoff-8h AND < kickoff+1s` — an eight-hour window. Correctness is rescued by the JS team-code filter (`:135-140`), since a franchise plays once per day. The comment is wrong, not the query.
- (P3) `:129` `q.snapshot_at < ?` and `:150` `q.snapshot_at > held.snapshot_at` are lexical comparisons; the comment at `:119-120` says "both ISO spellings present in the column sort inside it". Live tape: 1,592,221 rows, **100%** use the `T` separator (checked), so the mixed-format risk is theoretical today; a space-separated `snapshot_at` would compare below every `T` timestamp at the same date and pass the pre-kickoff filter.
- (P3) `:233-234` calls `listOpportunities` twice with the same `limit` — fine, but `limit` applies per status, so `coverage.accepted_positions` can be up to `2*limit`.

**Verdict.** Good; the C13/C14 corrections are real and the denominators are honest. Zero rows to grade today.

### 1.7 server/services/nfl-execution-clv-downsize.js (484, read 484)

**Purpose.** Rule 2 control law: non-overlapping 6-week blocks, Student-t CI on week means (own `logGamma`/`betacf`/`betainc`/`studentTCdf`/`studentTCritical`), ladder `[1, 0.5, 0.25, 0]`, `replayClvDownsizeLadder`, `currentClvDownsizeMultiplier`, `applyClvDownsize`, and a frozen simulated derivation.

**Reads/Writes.** none (pure).

**Wiring.** Imported only by `nfl-execution-staking-policy.js`, which is imported only by its test. **Orphaned chain.** Its header (`:98-120`) admits "This project has recorded ZERO real settled CLV observations large enough to fit or validate a control law against".

**Defects.** None functional. `:378-381` `applyClvDownsize` clamps to [0,1] correctly. `:323` sorts `week` with `>`/`<`, so mixed-type week keys (string vs number) would order lexically — caller contract, documented at `:314-315`.

**Verdict.** Well-built research artifact with no consumer; 484 lines carrying a derivation that describes a seeded simulation, not this project's data. Keep only if the prop-scorecard sizing path is ever wired; otherwise archive under research/.

### 1.8 server/services/nfl-execution-corridor.js (211, read 211)

**Purpose.** Rule 1: `deriveCorridorThreshold` (quantile of \|model−market\|), frozen `CORRIDOR_DERIVATION`, `MARKET_LINE_CORRIDOR_POINTS = 11.5`, `marketLineCorridorCheck`.

**Wiring.** `nfl-execution-decision.js:175`. Active only when `model_line` and `market_line_at_decision` are both frozen on the opportunity (`pipeline.js:186,188` supply them from `feature_snapshot.raw_forecast`).

**Defects.** None. `:186-192` returns `not_evaluated` rather than a pass on missing inputs; `:194-196` throws on a non-positive corridor. The sign-frame trap at `:177-184` is documented and owned by the caller: pipeline passes `projected_margin` and `market_margin` (both home-margin frame, `nfl-auto-picks.js:106-108`), which is consistent.

**Verdict.** Good.

### 1.9 server/services/nfl-execution-attribution.js (205, read 205)

**Purpose.** `fairPriceProbability` (Shin no-vig or implied), `fairPriceEv`, `challengeExtremePrice` (EV > 0.15 → suspect), `priceImprovement` (rankBooks wrapper), `threeWayAttribution`, `attributePnl` (exact four-way identity with luck as residual).

**Wiring.** Only `challengeExtremePrice` has a production caller (`decision.js:183`). `threeWayAttribution` and `attributePnl` are test-only.

**Defects.**
- (P3) `:48` `fairPriceProbability` falls back to `impliedProbability(ownPrice)` from `nfl-execution.js:32` — a vig-included probability labelled as such, fine; but `challengeExtremePrice` at `:68` is called by `decision.js:183` with `fairProbability = opportunity.model_probability` — i.e. the **model's** calibrated cover probability, not an independent fair price. The gate then asks "is the model's own EV at this price > 15%?", which is a sanity bound on the model, not the "independent no-vig fair probability" the header at `:19-22` describes. Naming/semantics mismatch, not a wrong number.
- (P3) `:177,:390` `payoutPerUnit(price)` for `price 0` → Infinity (same family as D05); inputs are validated finite only.

**Verdict.** Acceptable; two-thirds of the file has no caller.

### 1.10 server/services/nfl-execution-exposure.js (107, read 107)

**Purpose.** Hard caps: 3u/game, 2u/participant, 8u total, evaluated *after* adding the candidate; `correlatedSlateShockLoss` groups by shock factor.

**Wiring.** `decision.js:164-168` (budget default), `stress.js`.

**Defects.** None. `:37-39` throws on non-positive stake; `:40` requires `event_key` equality; `:63` total cap. Note the budget is a **default parameter** (`decision.js:122`) — a caller could pass a looser budget, but the HTTP route does not forward one.

**Verdict.** Good.

### 1.11 server/services/nfl-execution-replay.js (429, read 429)

**Purpose.** Deterministic delayed-execution replay: `replayDelayedExecution` (outcomes: filled_as_decided/repriced/disappeared/suspended/capped/no_decision_quote/decision_stale_unknown/stale_unknown/pending/post_kickoff_unknown/ambiguous_quote; `availability_basis` reported separately), `replayDelayLadder`, `timelineFromQuoteTape` (batch-level `removed`/`ambiguous` evidence), `timelineFromFrozenRows`, `replayFromFrozenDataset`.

**Reads.** `nfl_quote_tape` ⨝ `nfl_quote_batches`. **Writes.** none.

**Wiring.** `pipeline.js:217` (preview attached to the DECISION event's detail), `stress.js`.

**Defects.**
- (P3) `:269-270` `breakEvenRate(decisionSample.price)` inherits `nfl-execution.js` price-0 behaviour (D05) — a `0` price yields `breakeven_slippage_bps` of ±Infinity → `r2` → `null`. Silent, not wrong money.
- (P3) `:139` sorts by `snapshot_at.localeCompare`, `:129-136` compares by `Date` — two clocks in one function; consistent as long as the strings are ISO (they are, 100% `T` format live).
- `DEFAULT_MAX_STALENESS_SECONDS = 1800` (`:110`) is derived from the median/p90 capture gap — good; `DEFAULT_BOOK_LIMIT_UNITS = null` (`:111`) is honest.

**Verdict.** Good; pure, deterministic, and it never claims a fill it did not observe (E7 fix at `:216-230` is in place).

### 1.12 server/services/nfl-execution-staking-policy.js (132, read 132)

**Purpose.** Fixed paper stake vs calibration-shrunk fractional Kelly for prop markets: `isCalibrated`, `shrinkProbability` (n/(n+200)), `uncertaintyShrunkKelly` (Kelly × CLV-downsize multiplier), `compareStakingPolicies`.

**Wiring.** **None outside test/.** The header (`:16-23`) says "The caller (a route, or a future scheduled job) passes in the real scorecard when this is used live" — no such caller exists.

**Defects.**
- (P3) `:51-54` `isCalibrated` is `every(Boolean)` over `gates` — a scorecard with an empty `gates` object is refused (`length` check), good; but a scorecard whose gates object carries an unexpected extra truthy key passes. Contract with `propMarketScorecards` is by convention only.
- (P3) `:88-89` recomputes `shrink_weight` with `Math.max(0, settledSamples || 0)` while `shrinkProbability` at `:67` uses `Number(settledSamples) || 0` — a string `"50"` shrinks correctly at `:67` and reports `NaN` weight at `:88`.

**Verdict.** Orphaned. Correct as far as it goes; delete or wire.

### 1.13 server/services/nfl-execution-stress.js (166, read 166)

**Purpose.** Four scenario builders (QB scratch, feed outage, correlated slate shock, model-probability error) composed from replay/exposure/edge.

**Wiring.** Test-only. **Orphaned.**

**Defects.** (P3) `:138` `Math.min((sized.stake_fraction ?? 0) * bankrollUnits, bankrollUnits)` — no per-bet cap, deliberately, to show full Kelly damage; fine for a scenario, but it is the one `kellyFraction` consumer without the 3u cap and it lives in `server/services/`.

**Verdict.** Move to `test/` or `research/`.

### 1.14 server/services/nfl-execution-validation.js (48, read 48)

**Purpose.** `executionInputError` (400), `validAmericanPrice` (integer, \|p\|≥100), `assertExecutionPrice`, `assertExecutionStake`, `executionTime` (SQLite space-format → UTC), `spreadContractTerms` (parse the v1 key), `assertSpreadLine`.

**Wiring.** pipeline, lifecycle, replay, decision.

**Defects.** None. `:7` requires `Number.isInteger` — a `-102.5` quote would be rejected; American prices are integers in every feed here. `:33-36` hard-codes the 10-part v1 key layout; `nfl-contract-key.js:191-193` produces exactly 10 parts for `team_pair` markets (event key contributes 3 via `|`), consistent.

**Verdict.** Good.

### 1.15 server/services/nfl-policy.js (268, read 268)

**Purpose.** `NFL_PRODUCTION_POLICY` (v1.2.0: minEdge 3, maxDisagreement 4.5, 5 picks/week, calibration required, minExpectedReturn 0.01, haircut 0.01), `FORWARD_SAMPLE_TARGETS` (200/75), `NFL_HISTORICAL_REPLAY_POLICY` (diagnostic_only), `expectedNetReturn`, `normalizeNflPolicy` (domain validation), `applyNflPolicy` (abstention reasons, EV gate, weekly cap).

**Wiring.** 14 importers; the spine of the decision board.

**Defects.**
- D24 (P3) `:120` — second `expectedNetReturn` (see 1.3).
- D09 (P3, cross-file) `:78-82` declares 200/75 as *the* frozen v1.3 gates and says four services carried their own 250/200 copies; `staking.js:299` still hard-codes `forwardSettled < 250` and `:328` `minimum_forward_settled: 250`. One of the "four copies" survived.
- (P3) `:177` `return { ...NFL_PRODUCTION_POLICY, ...raw, … }` — `raw` is spread **after** the defaults, so an unknown key in `raw` (e.g. `authority`) rides through unvalidated; intended for the replay policy, but it means `normalizeNflPolicy({ id: 'x', version: 'y' })` mints a policy identity with production economics. Pipeline stamps `policy.id/version` onto the tape from the same object (`pipeline.js:130`).

**Verdict.** Good; the C15 corrections (push unknown ≠ zero, haircut domain, null minExpectedReturn preserved) are all present at `:154-169, 225-241`.

### 1.16 server/services/nfl-profitability.js (286, read 286)

**Purpose.** `EXTERNAL_MODEL_SOURCES` registry, `recordTeaserPrice` (validated insert into `nfl_teaser_price_ledger`, `qualified_wong_price` flag), `teaserPriceLedger` (`wong_price_gate_passed` iff latest reachable 2-leg/6-pt price ≥ -115), `historicalLineCoverage`, `profitabilityPhases`/`profitabilityOperations` (status dashboard aggregating prop-CLV, growth, neural, risk-lab, teaser ledgers).

**Reads.** `nfl_teaser_price_ledger`, `game_lines`, `nfl_blind_audit_runs`, `nfl_ai_replay_runs`, `nfl_teaser_executions`, `nfl_teaser_execution_legs`, `nfl_tweet_line_watch`, plus everything its 10 imports read. **Writes.** `nfl_teaser_price_ledger`.

**Wiring.** routes/nfl-betting, nfl-diagnostic, teaser-execution (side-effect import at `nfl-teaser-execution.js:13`, unused binding), db/schema.

**Defects.**
- (P3) `:86` `latestReachable = prices.find(price => price.reachable === 1 && …)` over the last 100 rows ordered by `captured_at DESC` — a reachable price captured with an *older* `captured_at` but a newer id is shadowed; `nfl-teaser-execution.js:55-63` picks by `MAX(id)`, so the two "latest reachable" definitions can disagree. Live ledger has one DraftKings row (+100, reachable, captured `2026-09-10T00:00:00.000Z` — a midnight timestamp that looks hand-entered).
- (P3) `:284` `staking_authority: gates.every(passed) ? 'human-reviewed capped pilot only' : '0 model-derived units'` — the gates include `teaser_price`, which is not a *model* gate; a reachable teaser price flips the wording for the whole prop program.
- (P3) `:9-14` the import chain (`nfl-evidence`, `nfl-model-growth`, `nfl-online-neural`, `nfl-risk-lab`, `weekly-learning`, `nfl-engine-registry`) is why `nfl-execution-staking-policy.js` refuses to import `nfl-prop-clv.js`; `nfl-teaser-execution.js:13` still imports this module for side effects only.

**Verdict.** Acceptable dashboard glue; nothing here sizes money.

### 1.17 server/services/staking.js (410, read 410)

**Purpose.** Second Kelly implementation: `americanToDecimal`/`americanToProb`, `kellyFraction(winProb, odds)`, `stakeFor` (raw quarter-Kelly, 5% cap), `estimateBetCorrelation` (rule-based), `slateRiskCheck` (sqrt(wᵀCw) + Monte-Carlo drawdown), `safeStakeFor` (blockers → then `stakeFor`), `TIERS`/`tierFor`/`evaluateSizing` (research).

**Wiring.** `routes/nfl-betting.js:41` (GET `/stake`, `/stake/safe`, POST `/stake/safe/slate`, `/stake/slate-risk`, GET `/stake/evaluate` — none authenticated), `execution-slate-reasoning.js:102` (`estimateBetCorrelation` only).

**Defects.**
- D08 (P2) `:292-329` `safeStakeFor` gates on `calibrationPassed`, `forwardSettled`, `uncertaintyWidth`, all of which the routes take from the request (`nfl-betting.js:973-976`, `:999-1002`). `?calibrated=1&forward_settled=250&interval_width=10` returns `execution_eligible: true` with nonzero `units` on any model probability. The payload does not say the gates were self-asserted; `/stake` (`:949-961`) at least says `validation_gate_applied: false`.
- D20 (P3) `:90-91` `americanToDecimal(0)` = `1 + 100/0` = Infinity; `:101` `b = Infinity`, `:104` `f = (Infinity*p - q)/Infinity` = NaN → `f > 0` false → 0. Survives by accident; `americanToProb(0)` = `0/100` = 0 → `edge = winProb`. No `assertRealPrice` here.
- D09 (P3) `:299`, `:328` 250 vs the frozen 200 (see 1.15).
- (P3) `:99-136` duplicates `nfl-execution-edge.js:588-648` with different parameter names (`winProb`/`americanOdds` vs `winProbability`/`americanPrice`) and no `source` gate — the "laundering guard" the slate module describes (`execution-slate-reasoning.js:110-113`) does not exist on this copy.

**Verdict.** Messy: a pre-gate Kelly library kept alive by unauthenticated calculator routes. `slateRiskCheck`/`estimateBetCorrelation` are the only parts with a production consumer.

### 1.18 server/services/line-shopping.js (248, read 248)

**Purpose.** `snapshotLines` (paid Odds API → `nfl_line_snapshots` + quote tape ingest + board cache clear), `latestSnapshotPayload` (rebuild API shape from stored quotes, freshness-filtered), `shopSlate` (best vs worst price at identical number), `numberDisagreement` (line spread across books, key-number crossing), `closingLineValue` (stub).

**Reads.** `nfl_line_snapshots`. **Writes.** `nfl_line_snapshots` (`:48-55`), via dynamic import the quote tape.

**Wiring.** 11 non-test importers (scheduler, evidence daemon, capture dispatch, sharp, clv, research, expert council, teaser-execution side-effect import).

**Defects.**
- D23 (P3) `:232-248` `closingLineValue()` computes no closing-line value: it counts snapshots and returns `{ available: true, tracked, snapshots, window }`. The docblock (`:221-231`) promises CLV. Real CLV lives in `nfl-clv.js` and `nfl-execution-clv.js`.
- (P3) `:24` `americanToProb` — fourth private copy; `:146-147` `best`/`worst` by raw American price, which is fine only because the key includes the point (`:135`), so like is compared with like.
- (P3) `:52` `ON CONFLICT DO NOTHING` depends on a unique index on `nfl_line_snapshots` existing (schema owner elsewhere); no assertion here.

**Verdict.** Acceptable; one misnamed stub.

### 1.19 server/services/nfl-shopping-board.js (429, read 429)

**Purpose.** `signedMarginDistribution`, `simultaneousQuotes` (latest same-instant multi-book set per event, fresh-quote and clock-valid filtered, memoised), `shoppingBoard` (bestExecution per side, sorted by expected_net_return), `priceMiddle`/`findMiddles`, `bookHold` (NFL and MLB), `executionBoardSummary`.

**Reads.** `nfl_line_snapshots`, `game_lines`, `mlb_market_quotes`. **Writes.** none.

**Wiring.** routes/execution-slate, betting-hub (`/execution/board` used by `LineShop.tsx:91`), nfl-execution, pick-watch, teaser-execution, book-feeds, sportsgameodds, line-shopping (cache clear).

**Defects.**
- D06 (P2) `:143` `bestExecution(quotes, …)` receives every quote whose price is finite; `simultaneousQuotes` (`:97-107`) drops stale quotes but not \|price\|<100 ones. One `price 0` row in the latest capture → `dec(0)` throws inside `bestExecution` → `shoppingBoard()` throws → `/betting/execution/board`, `/execution-slate/recommend`, `executionBoardSummary` all 500. Evidence such rows occur: `nfl_line_snapshots` betrivers/h2h/SF@LAR price 0 (2026-09-11T03:09Z).
- D14 (P3) `:32` `const dec = american => (american >= 0 ? 1 + american/100 : 1 + 100/-american)` — the pre-14c5e65 unguarded copy; `priceMiddle` (`:235-236`) would compute a 99× payout on price -1 before `impliedProb` at `:259` throws.
- D11 (P2) `:205-212` cross-side/cross-game sort by `expected_net_return`, where every probability is the empirical cover rate near the posted number (`edge.js:375-383`). The commit 14c5e65 message quantifies the bias (+6.5 → 53.53%, +10 → 55.28% vs 52.38% break-even). Within one side the bias cancels (same distribution for every book), so "best book for this side" is right; the *order of sides* and `executionBoardSummary.best_expected_return` (`:414`) are dog bias presented as the best number on the board, under a `qualified: false` label at `:417`.
- (P3) `:82` and `:116` `quoteClockValid(q)` is applied to the *event* object, not per quote — fine if `quoteClockValid` reads `captured_at`; noted for the owner of `nfl-quote-clock.js`.

**Verdict.** Acceptable; it does what the plan says (rank obtainable contracts) but leads with a biased number.

### 1.20 server/services/nfl-teasers.js (291, read 291)

**Purpose.** Wong teaser mechanism: `wongLeg` (membership delegated to `teaser-leg-rates.js`), `wongHistory` (1999-2024 by default; pushes split out), `teaserEV` (two-leg ticket with push bucket via `ticketEV`, refuses legs≠2), `findTeaserLegs` (qualifying legs + `stakeFor({source:'execution'})` on `ev.probabilities.win`).

**Reads.** `game_lines`. **Writes.** none.

**Wiring.** betting-hub GET `/teasers/candidates` (`:404-417`, no auth, display only), teaser-execution, execution-slate route, `teaser-leg-rates.js` (circular-ish: teasers imports leg-rates, leg-rates imports teasers per the importer grep — not verified inside leg-rates, out of scope).

**Defects.**
- (P3) `:165` `hist = legRate == null || standardError == null ? wongHistory() : null` then `:200` `hist?.push_share ?? wongHistory().push_share` — when a caller supplies both `legRate` and `standardError` (as `findTeaserLegs:247` and `compileTeaserRoutes:153-154` do) `wongHistory()` is called a second time at `:200` for the push share. Cached upstream, so cost only.
- (P3) `:169-170` `payout = 1/imp`, `need = imp^(1/legs)` are computed but `payout` is unused after the `ticketEV` refactor; `breakeven_leg_rate` at `:217` still reports the two-state `need`, which is the *pre-push-correction* break-even (the docblock at `:57-59` says -120.22 under stake-back grading; `need` does not encode that).
- `findTeaserLegs:248` `priceOk = americanPrice >= minPrice` with `minPrice = -115` — the operating floor; consistent with `TEASER_POLICY.operating_price_floor`.

**Verdict.** Good; the 14c5e65 corrections are in place at `:200-213` and `:271-273`.

### 1.21 server/services/nfl-teaser-execution.js (367, read 367)

**Purpose.** Operational Wong routing: `latestTeaserPrices` (latest reachable per book), `compileTeaserRoutes` (per-book same-book leg pairs, price gates: reachable, fresh ≤7d, ≥ mathematical break-even, ≥ -115, line age ≤18h, EV>0), `teaserExecutionBoard`, `recordTeaserExecution` (paper/placed, ≤5u, must be an eligible live candidate), `teaserExecutionLedger`, `settleTeaserExecution` (client scores → leg results → ticket status/profit).

**Reads.** `nfl_teaser_price_ledger`, `nfl_line_snapshots` (via board), `nfl_teaser_executions`, `_legs`. **Writes.** `nfl_teaser_executions`, `nfl_teaser_execution_legs` (INSERT and **UPDATE**).

**Wiring.** betting-hub (`/teasers/execution-board`, POST `/teasers/executions`, GET `/teasers/executions`, POST `/teasers/executions/:id/settle` — **none authenticated**), wong.js (POST `/tickets`, `/tickets/:id/settle` — none authenticated; `recordWongTicket` writes the same tables directly when the hub board cannot see the book, `wong.js:496+`), teaser-season, client `WongSeason.tsx`.

**Defects.**
- D01 (P1) `:302-367` `settleTeaserExecution(id, input)` grades legs from `input.scores` — caller-supplied `team_score`/`opponent_score` — with no lookup against `game_lines`, then `UPDATE … SET status, settled_at, profit_units` (`:359-360`). Routes: `betting-hub.js:450` and `wong.js:629`, neither behind `requireModelPermission`, on routers mounted without `legacyAuthenticated` (`server/index.js:107-108`). The forward record of the one measured-positive strategy (`teaserExecutionLedger.summary.placed_profit_units`, `forward_leg_rate`; surfaced in `profitabilityPhases` at `nfl-profitability.js:131-137, 156-164`) can be written to any value by any client that can reach the API, and the rows are mutable so the write leaves no trace. The scores exist in `game_lines` (`nfl_teaser_execution_legs` carries `event_id`, `team`, `opponent`) — settlement should read them there, as `settleExecutionOpportunities` does.
- D17 (P2) `:222-263` `recordTeaserExecution` accepts `mode: 'placed'` and up to 5 units from an unauthenticated POST (`betting-hub.js:433`), while the sibling user-bet ledger requires `model:execute` (`nfl-market.js:294`). Inconsistent authority for equivalent writes.
- D16 (P3) live row id 1 (`candidate_id 'wong:71e0…'`, paper, +100, 1u, logged 2026-09-11T01:00Z) stores `expected_ticket_probability 0.5485` and `expected_ev 0.0969` — the superseded squared leg rate and the two-state EV — with no version column to say which formula produced them. `:246-247` writes `history.win_rate` and the candidate's probability without a formula/version tag.
- (P3) `:82-83` `perLeg = { w: (1 - pushShare) * history?.win_rate, t: pushShare }` — pooled push share for the family, applied before the pair is known; `teaserEV` at `:153-154` is then called *without* `pushShare` for the specific pair, so a two-half-point pair is still priced with a push bucket it cannot have (the exact error 14c5e65 fixed in `teaserEV` by adding the `pushShare` argument — this caller never passes it).
- (P3) `:120` `priceReachable = price?.reachable === 1 || price?.reachable === true` fine; `:123` `price.american_price >= mathematicalBreakEvenPrice` compares American prices numerically — correct only because both are on the same side of ±100 for this family (break-even ≈ -116).

**Verdict.** Messy at the edges that touch money: gates are good, settlement trusts the client, auth is absent.

### 1.22 server/services/nfl-user-bets.js (69, read 69)

**Purpose.** User-tracked spread bets: `addUserBet`, `removeUserBet` (DELETE), `gradeBet` (from `game_lines`), `userBetsFor`, `allUserBets`, `userBetsStanding`.

**Wiring.** nfl-market (`/bets` GET/POST/DELETE; POST/DELETE require `model:execute`), db/schema.

**Defects.**
- D21 (P3) `:26` `run('DELETE FROM nfl_user_bets WHERE id = ?', id)` — hard delete of a bet record; the rest of the money ledgers are append-only or void-flagged (`nfl_auto_picks.voided_at`).
- (P3) `:11-14` no validation of `american_price` magnitude or `line` half-point; `units_staked` defaults to 1 on any non-positive input rather than refusing.
- (P3) `:30` fourth `americanToDecimal`; `:32-44` third spread-grading implementation.

**Verdict.** Acceptable for what it is (Nick's own paper record); separate from the model's ledger as intended.

### 1.23 server/services/picks.js (118, read 118)

**Purpose.** **Fantasy** draft-pick capital (Sleeper traded picks, pick values, taxi discount). Not a betting module; grouped here by filename only.

**Wiring.** `routes/tradelab.js:6`, `services/trade-engine.js:26`. (The broad grep also matched `nfl-auto-picks.js` importers; the precise grep shows exactly these two.)

**Defects.** None found. `:60-63` skips completed-draft seasons; `:92-93` drops picks held by rosters that left the league (silent loss of value from the league total — a fantasy-side note, not a betting one).

**Verdict.** Good; misfiled in this audit group. Relevant to Nick's fantasy-first priority (trade engine).

### 1.24 server/services/pick-confidence.js (278, read 278)

**Purpose.** Calibrated pick-confidence: `pickFeatures`, `fitConfidence` (logistic GD on ≤5 prior seasons of `replaySeason` bets, ≥60 samples), `confidenceModel` (cached), `pickConfidence` (shrunk to base rate, k=100), `confidenceCalibration` (out-of-sample buckets, Brier, ECE).

**Reads.** `game_lines` seasons; replay bets via `nfl-replay.js`. **Writes.** compute cache.

**Wiring.** routes/nfl-betting, report-cache, forward-ledger.

**Defects.**
- (P3) `:47` `BREAK_EVEN = 0.5238` hard-codes the -110 convention that `nfl-execution-edge.js:758-777` measures as overstated (real mean 51.33%); `:187-190` labels and `:197-200` copy are all against -110.
- (P3) `:121-133` 4,000 GD iterations with fixed lr on every cache miss; `:96` swallows replay errors per season, so a partially failing replay silently shrinks the training set.

**Verdict.** Acceptable; explanatory only, no money.

### 1.25 server/services/pick-reasoning.js (337, read 337)

**Purpose.** Deterministic English explanation of a pick: `explainPick` (call, causal driver attribution from component weights, descriptive context from `spreadContext`, factor comparison from `nfl-reasoning.js`, counter-case), `attribute` (exact weighted-mean attribution with reconstruction check), `explainWeek`.

**Wiring.** routes/nfl-betting, nfl-blind-audit.

**Defects.**
- (P3) `:63` `backingHome = pick.side === home || edge > 0` — if `pick.side` is a team name equal to `home` this is right; if `side` is a signed line string (as `nfl-auto-picks.js:149` writes, e.g. `"+3.5"`), the first clause is always false and direction falls back to the edge sign. Works for the replay shape the docblock describes (`:52-53`), not for `nfl_auto_picks` rows.
- (P3) `:209-211` the counter-case cites "the sealed audit on simulator ATS" — a document reference, not a computed number.

**Verdict.** Acceptable; no money.

### 1.26 server/services/nfl-pick-watch.js (234, read 234)

**Purpose.** Re-shop open `nfl_auto_picks`/`nfl_total_picks` against `simultaneousQuotes`, log every check to `nfl_pick_watch_log`, `pickWatchBoard`, `pickWatchLog`. `recommended_stake_units` is 0 unless `marketGateOpen` (a production champion in `model-governance.js`) **and** `NFL_MODEL_STAKE_UNITS`.

**Reads.** `nfl_auto_picks`, `nfl_total_picks`, `game_lines`, `nfl_teams`, snapshots. **Writes.** `nfl_pick_watch_log` (0 rows live — the scheduler job has not run, or ran with no open picks; all 2026 wk1 picks are voided and `:63` filters `voided_at IS NULL`).

**Wiring.** scheduler (`nfl_pick_watch`), betting-hub, page-explain-tools, db/schema.

**Defects.**
- D25 (P3, shared) `:101` `Number(process.env.NFL_MODEL_STAKE_UNITS) || 0` — an environment variable, not an evidence gate, is what turns a model pick into staked units here and at `nfl-auto-picks.js:39` and `nfl-props.js:758`. Unset today (`.env` checked for that key only). The docs (`docs/evidence/contracts/beat-the-close-original.md:137`) say it "stays 0"; nothing enforces that.
- (P3) `:82-83` `findEvent` matches `e.event_id.endsWith('AWAY@HOME')` — works for `nfl:date:AWAY@HOME` ids from the free feeds (live row: `nfl:2026-09-11:SF@LAR`) and never for Odds-API hex ids; picks on a game only the paid feed covers read `watching_no_market_data`.

**Verdict.** Acceptable monitoring; honest about being zero-stake.

### 1.27 server/services/nfl-auto-picks.js (285, read 285)

**Purpose.** `ensurePicksFor` (lock top-5 spread picks, idempotent), `autoPickDecisionBoard` (fingerprint-cached), `computeDecisionBoard` (ensemble → neural substitution if eligible → Shin no-vig → calibrated cover probability → promoted-finding veto → `applyNflPolicy`), `persistPickDecisions` (UPSERT latest view), `gradePick`, `pickResultsFor`, `allPickResults`, `standing`.

**Reads.** `game_lines`, ensemble, calibration, pregame snapshots. **Writes.** `nfl_auto_picks`, `nfl_pick_decisions`.

**Wiring.** 11 non-test importers; `runExecutionPipeline` consumes `autoPickDecisionBoard(...).selected`.

**Defects.**
- D02 (P2) `:208-217` `INSERT … ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET line=…, american_price=…, book=…, quote_at=…, quote_source=…, edge=…, disagreement=…, eligible=…, abstention_reason=…, policy_rank=…, feature_snapshot_json=…, recorded_at=…` — **`policy_version` is not in the SET list** and not in the conflict key. Live evidence: `nfl_pick_decisions` for 2026 wk 1 holds 16 rows, all `policy_version = '1.1.0'`, all `recorded_at = 2026-09-12T02:16:33Z` (tonight), while `NFL_PRODUCTION_POLICY.version` is `'1.2.0'` (`nfl-policy.js:19`, committed 2026-09-10 13:17 in 8d950b0; the live server PID 56651 started 2026-09-11 00:55 local, i.e. on 1.2.0 code). The rows were re-decided tonight under 1.2.0 economics (the EV-at-refresh gate) and are labelled with the 1.1.0 identity that `nfl-policy.js:10-18` says "must never be compared … as though the policy had not changed". The tape (`nfl_decision_runs`, 0 rows) is the designated evidence, but this latest-view table is what the UI and `forward-ledger`/`nfl-evidence` readers see.
- (P3) `:39` env-var stake (D25).
- (P3) `:110-111` `home = (edge ?? 0) > 0; selection = home ? game.home : game.away` — a null edge selects the away team and then abstains on `missing_model_edge`; harmless but the row's `selection` is arbitrary for abstentions and is part of the tape's exact-contract key (`nfl-decision-tape.js:337-340`).
- (P3) `:231` fifth `americanToDecimal`; `:238-255` second spread grader.

**Verdict.** Acceptable; the UPSERT omission is a real identity leak in the latest view.

### 1.28 server/services/nfl-decision-tape.js (574, read 574)

**Purpose.** Append-only decision tape: `decisionContentFingerprint` (contract + quote + forecast + identity + economics + policy outcome), `contentHash`, `observationKey`, `validateObservation`, `validateDecisionBoard` (finite/probability/eligibility/duplicate-contract checks), `recordDecisionRun` (atomic; idempotent retry; refuses divergent content and incomplete legacy runs), `invalidateDecisionRun`, readers, `findDecisionEvent` (full-contract, refuses ambiguity).

**Reads/Writes.** `nfl_decision_runs`, `nfl_decision_events`, `nfl_decision_run_invalidations` (INSERT only; triggers refuse UPDATE/DELETE — verified live).

**Wiring.** pipeline only (plus tests). `spreadDecisionCodeIdentity()` from `server/platform/code-identity.js` is required to be a real sha256 (`:380-382`).

**Defects.**
- D22 (P3) `:277-281` see 1.4 — the pipeline's default `complete` status plus an empty week throws.
- (P3) `:190` sort key `${matchup}|${market}|${selection}|${line}|${book}|${american_price}` stringifies `null` as `"null"`; consistent, so hashes are stable.
- (P3) `:250` `attempt` is validated but, by design, excluded from `observationKey` (`:209-214`) and written to the header (`:446`); a retry with attempt 2 of identical content returns `created:false` and the stored `attempt` stays 1 — the header under-reports retries. Documented intent, minor.

**Verdict.** Good. This is the best-guarded table in the group and it has zero rows: no run has been recorded since the tape landed (the T-60 runner froze a packet on 2026-09-10 but no forecast consumed it — plan §0.3 #4).

### 1.29 server/services/nfl-forecast-identity.js (67, read 67)

**Purpose.** `ENSEMBLE_FIT_VERSION` (v10), `spreadForecastIdentity` (sha256 of a descriptor: regime, blend, weighting, families, challengers, neural/reliability versions, Shin method), `coverCalibrationVersion` (validates id against descriptor).

**Wiring.** auto-picks, coordination-audit, ensemble, cover-calibration.

**Defects.** None. `:38-40` refuses unknown regimes; `:61-66` re-hashes to validate.

**Verdict.** Good.

### 1.30 server/services/nfl-contract-key.js (243, read 243)

**Purpose.** Exact contract identity: `PERIODS` (overtime treatment), `MARKETS` registry (sides, line rule, bounds, push/void rules), aliases, `easternGameDate`, `eventKey` (`nfl|YYYY-MM-DD|AWAY@HOME`), `contractKey` (10-part key + hash + settlement metadata), `mirrorContract`, `QUARANTINE_REASONS`.

**Wiring.** t60-runner, pipeline, alt-spread-import, evidence-dataset.

**Defects.**
- (P3) `:56` `HALF_POINT` accepts any multiple of 0.5 including integers — correct for spreads/totals; `:168` error text "is not a half point" is misleading for a quarter-point input (it means "not a multiple of a half").
- (P3) `:117` `toLocaleDateString('en-CA', { timeZone: 'America/New_York' })` relies on ICU being present in the Node build (full-icu is default since Node 13; fine on this machine).
- `overtime_rule_source: 'us_default_convention'` (`:201`) is carried onto the OFFERED event (`lifecycle.js:161-163`) — the declared, unverified assumption is visible on the ledger row, as the header promises.

**Verdict.** Good.

---

## 2. Defect register

| ID | Sev | File:line | Claim |
|---|---|---|---|
| D01 | P1 | nfl-teaser-execution.js:307-360 (+ betting-hub.js:450, wong.js:629) | Teaser settlement grades from client-supplied scores, UPDATEs a mutable ledger, on unauthenticated routes |
| D02 | P2 | nfl-auto-picks.js:212-217 | `persistPickDecisions` UPSERT never updates `policy_version`; live rows say 1.1.0 with tonight's timestamp under 1.2.0 code |
| D03 | P2 | nfl-execution-edge.js:625 | `stakeFor` gate is a deny-list on the literal `'model'`; every other source string sizes |
| D04 | P2 | nfl-execution-lifecycle.js:166-177 | Frozen forecast columns on `nfl_execution_opportunities` have no update trigger though acceptance gates treat them as authoritative |
| D05 | P2 | nfl-execution.js:38-40, 79 | `rankBooks`/`routeBet` rank a price-0 quote best (Infinity payout); such a row exists in `nfl_line_snapshots` |
| D06 | P2 | nfl-shopping-board.js:143 / nfl-execution-edge.js:422-429 | One \|price\|<100 quote in the latest capture throws inside `bestExecution` and 500s the whole board and recommender |
| D07 | P2 | nfl-execution-lifecycle.js:470-476 | `lifecycleFunnel.realized_pnl_units` ignores `settlement_correction` deltas |
| D08 | P2 | staking.js:292-329 / routes/nfl-betting.js:965-1006 | `safeStakeFor` gates are client-asserted flags; reports `execution_eligible: true` on a model probability |
| D10 | P2 | nfl-execution-edge.js:93-94, 218-219, 276-277 | Margin distributions pool 2025-26 seasons the repo documents as corrupted (`nfl-teasers.js:33-38`); DB confirms integer share collapse |
| D11 | P2 | nfl-shopping-board.js:205-212, 414 | Board sorts sides by a no-forecast cover rate with measured underdog bias; `best_expected_return` is that bias |
| D17 | P2 | routes/betting-hub.js:433, 557; routes/wong.js:622 | Ledger writes (teaser `placed`, execution log, wong tickets) have no `requireModelPermission` while `/nfl-market/bets` does |
| D09 | P3 | staking.js:299, 328 | Forward-sample gate 250 vs frozen 200 in `nfl-policy.js:78-82` |
| D12 | P3 | nfl-execution-decision.js:88-93 | `line_changed_no_qualified_distribution` branch unreachable from `attemptAcceptance` |
| D13 | P3 | nfl-execution.js:71-73, 199-202 | Docblock/note claim line-first ranking; code scores on one probability scale |
| D14 | P3 | nfl-shopping-board.js:32, execution-slate-reasoning.js:108, staking.js:90-91 | Unguarded `dec`/`americanToDecimal` copies survive 14c5e65 |
| D16 | P3 | nfl-teaser-execution.js:240-249 (+ live row id 1) | Ledger stores probability/EV with no formula version; existing row carries the superseded squared-rate figures |
| D18 | P3 | nfl-execution-edge.js:782 | `realBreakEven` throws on any \|spread_odds\|<100 row |
| D19 | P3 | nfl-execution-edge.js:625 | `provenClv > 0` accepts any positive number; no sample-size check despite the reason text |
| D20 | P3 | staking.js:90-136 | Duplicate ungated Kelly; `americanToDecimal(0)` = Infinity |
| D21 | P3 | nfl-user-bets.js:26 | Hard DELETE of a bet record |
| D22 | P3 | nfl-execution-pipeline.js:128 / nfl-decision-tape.js:277-281 | Empty week → `complete` run with zero decisions → throw |
| D23 | P3 | line-shopping.js:232-248 | `closingLineValue()` computes no CLV |
| D24 | P3 | nfl-policy.js:120 vs nfl-execution-decision.js:46 | Two `expectedNetReturn` functions, same name, different signatures |
| D25 | P3 | nfl-auto-picks.js:39, nfl-pick-watch.js:101 | `NFL_MODEL_STAKE_UNITS` env var can stake model picks with no evidence gate (unset today) |
| D26 | P3 | nfl-execution-clv.js:118-131 | Comment says one-second kickoff range; query is kickoff−8h..kickoff+1s |

---

## 3. Data flows

- ESPN reference lines → `game_lines` → `computeDecisionBoard` → `applyNflPolicy` → (a) `nfl_auto_picks`/`nfl_pick_decisions` latest view, (b) `nfl_decision_runs`/`nfl_decision_events` tape (0 rows), (c) `nfl_execution_opportunities` + lifecycle events (0 rows).
- Odds API / free feeds → `nfl_line_snapshots` (1.77M rows, 25 books, last 2026-09-12T02:42Z) → `simultaneousQuotes` → `shoppingBoard`/`rankBooks`/`findMiddles`/`compileTeaserRoutes`/`reshopOpenPicks`.
- Odds API → `nfl_quote_tape` ⨝ `nfl_quote_batches` (1.59M rows, append-only) → `timelineFromQuoteTape` (replay), `closingQuoteForContract` (CLV), `resolveQuoteBasis` (pipeline).
- Human acceptance → lifecycle ACCEPTED (source `user_recorded`, `fill_confirmed` 0) → settle from `game_lines` → CLV projection from the tape.
- Manual teaser price → `nfl_teaser_price_ledger` → `latestTeaserPrices` → routes → `nfl_teaser_executions` (paper/placed) → client-graded settlement (D01).
- `game_lines` (all seasons, incl. contaminated 2025-26) → margin distributions → every half-point valuation on the board (D10).

## 4. Open questions

1. Is the live server (PID 56651, started 2026-09-11 00:55) actually running the 1.2.0 tree? The `nfl_pick_decisions` rows say 1.1.0 tonight; the UPSERT explains it without a stale process, but a `git stash`/worktree difference would too. Not checkable without touching the process.
2. Where did the single `price 0` betrivers/h2h row come from (`free:kambi`), and does the kambi adapter emit 0 for suspended markets? If so, D05/D06 will recur on every suspension.
3. Does `nfl_teaser_price_ledger`'s DraftKings +100 (captured exactly `2026-09-10T00:00:00.000Z`, reachable) reflect a price Nick actually saw, and when? The whole teaser pilot's eligibility hangs on that one row.
4. `execution-slate-reasoning.js` (not in this group, 800+ lines) is the only production consumer of `stakeFor` with `source:'execution'` for shopped lines — and it blocks all of them today. Who reads its `blocked` list?
5. Who is the intended consumer of `nfl-execution-staking-policy.js` / `clv-downsize.js` — the prop scorecards (`nfl-prop-clv.js`) — and is that still planned, given fantasy-first?
