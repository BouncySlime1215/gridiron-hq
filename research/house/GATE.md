# The gate — written 2026-11-17 21:07 UTC, before any forward data was looked at

One question decides whether this goes any further: **does a newcomer's reward
survive being filled at bad prices?** The recorder answers the first half and
public trades the second. This file fixes how, so the answer cannot be shaped
after the fact.

## Window

2026-11-18 00:00 UTC to 2026-11-25 00:00 UTC. Recorder sweeps (`data/scores`)
and public trades for the same markets.

## The pretend trader

- $50 of collateral on one side of one market, resting at that side's reference
  price, re-posted at each sweep (`shadow.joiner`).
- In the portfolio for an interval only if, **at the previous sweep**, the
  snapshot counted and the same $50 would have earned at least 1% a day.
  Selection uses nothing from the interval it is paid on.
- No look-ahead on program length: a program's reward is summed per program and
  **set to zero if it comes to less than $1.00**, as Kalshi's rule does.

## What is measured

1. Reward per collateral-day, cautious version (`reward_lo`: nothing for an
   interval in which the reference price moved or the snapshot stopped counting).
2. Fill profit or loss per collateral-day, pessimistic fills (`shadow.fills`:
   first in the queue, filled by any trade at our price or worse), marked two
   ways: at the quote midpoint from the first sweep at least 60 minutes later,
   and at settlement where the market has settled by 2026-12-02.
   Maker fees are charged where the series has them.
3. Net = 1 + 2.

Uncertainty: bootstrap over events (markets in one event share their news),
10,000 draws.

## Pass, all of:

- net at the 60-minute mark is at least +0.25% a day, and its 95% lower bound is above zero;
- fill losses are no more than half of the reward;
- at least 500 different markets contribute;
- the sign holds in each half of the week separately.

## Otherwise

It is dead as designed. Say so, publish the numbers, do not rescue it with a
new filter on the same week. A changed rule needs a new week.

## If it passes

Still not proof: fills are simulated and our sweeps are minutes apart. The next
step is a pilot with real orders, which needs Nick's Kalshi account, his
explicit go-ahead, a hard cap (proposed: $300 total, $10 a position), and
orders priced to trade, not to be pulled.

## Already known going in (2026-11-17)

- One snapshot, 20:15 UTC: $93k a day on $64.5M qualifying; half of side-markets
  would pay a small newcomer 0.58% a day or more at the margin; a tenth, 7% or more.
- That figure falls with program age: 7.1% a day in the first hour, 0.32% after
  three days. Persistence is exactly what the week measures.
- History, 365,290 paid windows, $25.8M: reward was 1.84% of the dollars traded
  inside the windows; $13.2M of it was paid in windows where under $1,000 traded
  (`results/history_step_a.json`). What fills cost in the busy half needs
  settlement results, being pulled now.
