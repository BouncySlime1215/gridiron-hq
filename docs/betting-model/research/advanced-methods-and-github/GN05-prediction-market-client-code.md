# GN05 — Prediction-market client code: what's real, what Gridiron already has, what's new

## What Gridiron already has (read, not touched)

`fantasy-football-dashboard/server/services/polymarket.js` (442 lines) and
`polymarket-lines.js` (287 lines) already:
- Capture every open NFL market on Polymarket's gamma API, classify each
  question (`threshold_prop`, `leader_prop`, `futures`, `award`, `other`) via
  `parsePolymarketProp`, and store markets in `polymarket_markets`
  (condition_id, question, event_title, kind, player, stat, threshold,
  clob_token_yes/no).
- Poll the CLOB `/book` endpoint for top-of-book bid/ask on the highest-volume,
  mid-priced (0.12–0.88) markets, storing best_bid/best_ask/spread in
  `polymarket_quotes` — but **discard the rest of the book depth returned in
  the same response** (`server/services/polymarket.js:166-186`, `captureOrderBooks`).
- Pull `/prices-history` per market into `polymarket_price_history`
  (condition_id, ts, price) — this is the 12.4M-row tape referenced tonight.
- Derive an implied spread/total line per game from the game-market ladder via
  isotonic regression + linear-interpolation crossing (`polymarket-lines.js:
  isotonic`, `crossing`), used only for line-movement/CLV, not for anything
  cross-market.

None of this groups markets that share an event (a leader/futures field, or a
game's moneyline vs. spread-implied win prob) to check whether their prices are
internally consistent. That is the gap the client-code reading below fills.

## Repos cloned and read

### 1. Polymarket/py-clob-client
- License: MIT. Stars: 1,233. Last push: 2026-05-25.
- What it actually does (read `py_clob_client/client.py`, `utilities.py`,
  `order_builder/helpers.py`): a full authenticated trading client — order
  creation/signing (EIP-712), order posting/cancelling, balance/allowance
  management, RFQ (institutional request-for-quote) flow, and read endpoints
  (`get_order_book`, `get_midpoint`, `get_spread`, `calculate_market_price`).
- `calculate_market_price` (client.py:1062) walks the **full bid/ask ladder**
  returned by `get_order_book` to compute the size-aware fill price for a
  requested dollar amount (`order_builder.calculate_buy_market_price`), not
  just the top-of-book quote.
- `utilities.py` confirms every book carries a `neg_risk: bool` field and a
  per-market `tick_size`; `price_valid(price, tick_size)` enforces
  `tick_size <= price <= 1 - tick_size` — prices are quantized, not
  continuous, and the quantum is market-specific (0.01 typically, 0.001 near
  the extremes).
- Adopt: **borrow-idea** for the depth-walk math (candidate 2 below);
  **avoid** the trading/auth surface entirely — Gridiron places no bets on
  this venue and doing so would need a funded wallet, private keys and a paid
  infra decision explicitly out of scope tonight.

### 2. Polymarket/clob-client (TypeScript sibling)
- License: MIT. Stars: 514. Last push: 2026-05-25.
- Confirms the neg-risk contract addresses (`src/config.ts`:
  `negRiskAdapter: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`,
  `negRiskExchange: 0xC5d563A36AE78145C45a50134d48A1215220f80a` on Polygon
  mainnet) and that `getNegRisk(tokenID)` is cached per-token
  (`src/client.ts:337-349`) because the client itself treats it as a
  structural, per-market fact, not a per-quote one.
- `examples/getPricesHistory.ts` confirms `/prices-history` is a **single-market**
  call with no batch variant — Gridiron's per-market loop in `polymarket.js`
  is already the only shape this API supports; no efficiency win available
  here.
- Adopt: **reference-only** — same trading surface as py-clob-client, not
  reproduced; the contract-address confirmation is the only thing pulled
  from it.

### 3. Kalshi/kalshi-starter-code-python
- License: none declared (all-rights-reserved by default; treat as
  reference-only, do not vendor code). Stars: 99. Last push: 2025-03-07.
  Confirmed via `Kalshi` GitHub org listing — this is the org's own repo, not
  a third-party clone.
- What it does (read `clients.py`, 233 lines): RSA-PSS request signing against
  Kalshi's **authenticated trading API** (`KalshiHttpClient`) plus a
  websocket ticker subscription (`KalshiWebSocketClient.subscribe_to_tickers`).
  Needs a funded Kalshi account and an API key file — this is not the same
  surface as `api.elections.kalshi.com`, which is what Gridiron's
  `prediction-markets.js` already reads unauthenticated for public trade flow.
- Adopt: **avoid**. No public/unauthenticated capability in this repo that
  Gridiron doesn't already have; the websocket pattern is a real idea (push
  instead of 30-minute poll) but stands up a persistent connection process —
  new infrastructure, out of scope tonight — and needs an authenticated key
  Gridiron doesn't have anyway for the elections API's public feed.

## What's new (3 candidates), grounded in the code above

### Candidate 1 — Neg-risk complementary-set consistency scanner
Every Polymarket **leader/futures/award market** Gridiron already classifies
(`kind IN ('leader_prop','futures','award')`) shares an `event_title` with
every other candidate in that field, and per the neg-risk mechanism confirmed
in both clob-client repos (a NO share on any outcome converts 1:1 into YES
shares on every other outcome in the same event, via the on-chain
`NegRiskAdapter`), the sum of YES mid-prices across a complete field must
equal ~1.00 minus a small vig — not "should be close to 1 empirically", but
"is contractually forced to converge to 1, priced deviations are a real
combinatorial arbitrage." Nothing in Gridiron currently groups markets by
event and sums them; `polymarket_markets` + the existing 12.4M-row
`polymarket_price_history` already carry everything needed to replay this
historically with zero new API calls.

This mirrors the finding in arXiv:2605.00864 ("Arbitrage Analysis in
Polymarket NBA Markets"), which detects the same class of opportunity
(implied-probability sums across mutually exclusive outcomes falling below
1.0) in Polymarket's NBA markets and explicitly flags that the theoretical
arbitrage exists but is liquidity-constrained in practice — exactly the
caveat `polymarket.js`'s own docstring already states ("depth is thin outside
futures markets... a quoted price you cannot get filled at in size is not a
price").

### Candidate 2 — Depth-aware executable price at capture time
`captureOrderBooks` (`polymarket.js:140-190`) fetches the full `/book`
response (arrays of `{price, size}` bids and asks) but keeps only the best
level. `py_clob_client.calculate_market_price` / `calculate_buy_market_price`
is the reference implementation for walking that same array to a target
dollar size and returning the size-weighted fill price — arithmetic on data
already in hand, not a new API call. Storing that (e.g. fill price at $50 /
$200 / $1,000 tranches) alongside best_bid/best_ask turns "spread" into an
actual cost curve, which is what the file's own commentary says is missing
("A quoted price you cannot get filled at in size is not a price") and what
candidate 1's arbitrage scanner needs to size any flagged opportunity
honestly.

### Candidate 3 — Tick-size-aware ladder crossing
`polymarket-lines.js`'s `isotonic`/`crossing` functions treat Polymarket
ladder prices as continuous when interpolating the 50%-crossing spread/total.
`py_clob_client.utilities.price_valid` and the `TickSize` type confirm prices
are quantized per-market (commonly 0.01, tighter near 0/1) — so some of the
"noise" the isotonic fit is smoothing over is mechanical quantization, not
thin-book noise, and the two have different implications for how much to
trust an extrapolated (off-ladder) crossing. This is a calibration/audit fix
to an existing tool, using a fact (`tick_size` per book) that Gridiron's own
capture code already receives from the same `/book` payload used in
candidate 2 and currently discards.

## Rejected (do not build)

- **Kalshi websocket ticker stream** — real idea (push vs. 30-min poll) but
  requires a persistent connection process (new infrastructure) and an
  authenticated Kalshi key; out of scope tonight.
- **Porting the trading/order-signing surface from either clob-client** —
  Gridiron does not and should not place bets through this pipeline; that
  code is EIP-712 signing and wallet management, not a signal.
- **RFQ (request-for-quote) flow in py-clob-client** — institutional
  block-trade negotiation API; irrelevant to a historical-tape signal and
  needs an authenticated, funded account.
