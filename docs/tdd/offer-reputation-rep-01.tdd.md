# TDD evidence: REP-01 offer fatigue and reputation gate

**Branch** `claude/cloud-rep-01`. RED then GREEN, in that order, in
`test/offer-reputation.test.js`, `server/services/offer-reputation.js` and
`server/routes/trades.js`. Spec: ENGINE-SPECS.md REP-01 row (branch
`claude/handoff-package-2026-09-22`, `docs/handoff/local/ENGINE-SPECS.md:296`).

## The gap

Nothing stopped the app sending a manager a fourth lowball in a week. The only
per-manager brake was the hand-set `HARD_TIER_FACTOR` (trade-engine.js:1681),
which scales a score and never says "not now". No counter of offers sent,
declines in a row or lopsided offers existed anywhere in `server/`
(`git grep -n -i "decline_streak\|offers_7d\|lopsided" -- server` on `12a6de9`: no match).

## Commits

| step | sha | subject |
|---|---|---|
| RED | `fcacb5d` | test: REP-01 RED - offer fatigue and reputation gate |
| GREEN | `d72de09` | feat: REP-01 GREEN - offer fatigue and reputation gate on the trade finder |

RED failed because the unit did not exist:
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/offer-reputation.js'` — pass 0, fail 1.

One test was corrected after RED: the R9 fixture wrote `model_basis = 'fixture'`,
which the trade_outcomes CHECK (067_outcome_ledgers.js) refuses. It now writes
`'heuristic_unanchored'`. The test was wrong, not the code. `gateDeals` and its
test (R9, test 23) were added in GREEN because the wiring check refused an
orphan module; their liveness is M9/M10 below.

## What the gate does

`offerGate({ offer, history, tier, now, overrides })` is pure. Checks, first hit wins:

1. tier `never` -> **deny**
2. offer cost alone > manager or league budget -> **deny** ("make it fairer")
3. unanswered offer to him, inside `open_offer_wait_days` -> **delay**
4. declines in a row >= cap -> **delay** `streak_cooldown_days` from the last one
5. last answer a decline/ignore/expiry, inside `decline_cooldown_days` -> **delay**
6. offers in last 7 days >= cap -> **delay** until the oldest leaves the window
7. decayed lopsided spend + cost > his budget -> **delay** until it decays
8. same, league-wide -> **delay**
9. otherwise **allow**

| limit | fair | hard |
|---|---|---|
| max_offers_7d | 3 | 2 |
| max_decline_streak | 3 | 2 |
| decline_cooldown_days | 1 | 3 |
| streak_cooldown_days | 14 | 21 |
| open_offer_wait_days | 2 | 3 |
| lopsided_budget | 2 | 1 |

League budget 4; half-life 14 days; lowball proxy line P(accept) band high < 0.2.
**Every number above is a guess** (hand-set, not fitted). trade_outcomes has no
settled app offer to fit on.

## Liveness: mutation sweep

A throwaway script (not committed; each mutant applied to
`offer-reputation.js`, `node --test test/offer-reputation.test.js` run, file restored).

| mutant | where | result | killed by |
|---|---|---|---|
| M1 hard weekly cap = fair's | unit | died | R7 stricter on every limit |
| M2 counter no longer resets streak | unit | died | R3 reset |
| M3 no decay | unit | died | R5 decaying budget |
| M4 league budget check removed | unit | died | R6 |
| M5 never tier allowed | unit | died | R1 |
| M6 open offer ignored | unit | died | R4 |
| M7 proxy line flipped | unit | died | R5 proxy |
| M8 adapter counts every proposer | call site (adapter predicate) | died | R9 adapter |
| M9 gateDeals drops the band | call site (argument) | died | R9 gateDeals |
| M10 gateDeals turns a failure into allow | call site | died | R9 gateDeals |
| C1 deny wording changed | designed surviving control | survived | — |
| C2 pattern not in file | designed not-applied control | not applied | — |

**Survivor, recorded:** removing the `gateDeals(...)` wrap in `GET /find`
(server/routes/trades.js) is not killed by any test. The seeded route fixture
returns no deals (the seed has no projections; see
test/trade-lineup-value-route.test.js:91), so a route test cannot show a stamped
deal without a priced fixture. Open item.

## Nick's five questions

1. **Well built?** Pure function, `now` injected, deterministic under input order
   (R8), no DB write, no migration. Adapter throws on an unreadable league; the
   finder hook turns that into `decision: null` with the reason, never an allow.
2. **Stats or made up?** Made up: every limit is a declared guess.
3. **How we know:** hand-set constants. No backtest; trade_outcomes has 0 settled app offers (spec C28).
4. **Pointed anywhere else?** `GET /api/trades/:leagueId/find` now carries
   `deal.reputation`. No client renders it yet. The campaign producer does not exist
   in code yet; it calls `offerGate` / `offerGateFor` when it lands.
5. **How it unifies:** one gate, one reader of trade_outcomes + manager_profiles
   tier (the same tier `managerProfiles` serves). It does not touch
   `acceptanceBand` or `selfRead`; the spec's P(accept) reputation factor is a
   later step on trade-acceptance.js.

- **Not covered:** the P(accept) `reputation` factor in trade-acceptance.js:142;
  `selfRead` "HOW NICK LOOKS" lopsidedness; TM-01 ranking by gain per reputation;
  priced lopsidedness on the counterparty's screen (proxy only).
- **What would make it wrong:** managers who do not tire of offers (the caps then
  cost trades), or the p_accept < 0.2 proxy mislabelling fair-but-unlikely offers
  as lowballs.
