# AI slate reasoning over the proven execution edges

`server/services/execution-slate-reasoning.js` · `server/routes/execution-slate.js` ·
`test/execution-slate-reasoning.test.js`

A propose → simulate → review → commit loop that decides **which of the live
proven-edge opportunities to take together, and at what size**. Real Claude
reasoning at both ends, a real Monte Carlo in between, a hard cap of two API
calls, and no auto-execution anywhere.

---

## Why this is scoped to execution, and not to picking games

The obvious version of this feature is "AI proposes a spread pick, a simulation
checks it, AI reconsiders". That version would be dishonest here, for a reason
that is measured rather than aesthetic.

`nfl-drive-sim.js` is the only game simulator in this repository, and it is the
thing such a loop would verify against. It is **46.91% directional** — below a
coin flip — and `docs/BETTING_CAPABILITY_AUDIT.md` Cluster 5 records the
standing action item as "repair the simulation". Wrapping a
reasoning-and-verification ritual around a simulator that is worse than guessing
does not make the pick better. It makes a broken pick look rigorous, which is
worse than leaving it plainly broken, because the ceremony is the part someone
would trust. The 21 spread models measured against 15,096 closing lines all
failed the same way, and none of that is repaired by asking a language model to
think about it harder.

So this feature never forecasts a game. It reasons about **allocation** across
opportunities whose edge was already measured without any forecast at all — the
only two in the repository (audit Clusters 4 and 8):

| Source | Measured | Where the edge comes from |
|---|---|---|
| **Line shopping** | 0.813 pts mean line disagreement across 6.4 books on 272 events; 37.5% of markets differ by ≥1 point; best-price selection worth **2.566%/bet**. Second measurement: 652 markets, books disagree 20.9% of the time. | Arithmetic on prices visible before the bet |
| **Wong teasers** | **74.69%** per leg over **1,391 legs, 1999–2025**, SE 1.17pp. +6.51% EV at ‑110, **‑1.29% at ‑130**. | A fixed payout meeting a lumpy margin distribution |

The judgement this adds is real and is not available from either module alone:
on a live slate several of these fire at once and they are **not independent**.
Two teasers sharing a game are one correlated position wearing two tickets. A
shopped side can be the same game a teaser leg needs. Total exposure has to stay
survivable. That is allocation under correlation — a judgement question, asked
only about bets whose edge was established before the model was consulted.

---

## The loop

```
gate  →  PROPOSE (Claude #1)  →  simulate  →  REVIEW (Claude #2)  →  commit
                                     ↑             │
                          400 draws × 4 weeks      └─ revise? re-simulate in JS (free)
```

1. **Gate (no AI).** Live `shoppingBoard()` rows and eligible
   `teaserExecutionBoard()` candidates are sized through the real
   `stakeFor({source})` gate in `nfl-execution-edge.js`. Only what the gate
   already permits to size is ever shown to Claude.
2. **Propose (call 1).** Given the opportunities, their measured rates, their
   per-bet ceilings and which games each settles on: what should be taken
   together, and at what size?
3. **Simulate (no AI, ~4 ms).** A Monte Carlo of the *proposed slate's bankroll
   path*: 400 draws × 4 weeks, each bet's win/loss drawn from its **own measured
   rate**, correlated within a week through a Gaussian copula.
4. **Review (call 2).** Claude reads the simulation's **actual output** and
   reasons about whether its own allocation still makes sense. **This is not a
   threshold gate** — there is no numeric rule in the module that decides
   whether a slate is acceptable. The numbers go over as they came out and the
   decision is the model's.
5. **Commit.** If the review revises, the committed slate is re-simulated in JS
   (milliseconds, no API call) so what ships is the simulation *of the slate
   being recommended*, not of the one abandoned.

**The two-call cap is structural.** `propose` and `review` are each referenced
exactly once in `reasonAboutSlate` and there is no loop construct in the
function, so the bound cannot drift as the code changes — the same discipline
`draft-advice-verify.js` uses on the draft clock.

### Where the win probabilities come from

- **Teaser** — the measured Wong leg rate to the power of its leg count,
  recomputed from the database (`wongHistory()` returns 1,391 legs at 0.7469 on
  the live DB today, matching the audit). Legal only because
  `compileTeaserRoutes` enforces different games; the module re-checks.
- **Shopped line** — `NO_FORECAST_BASE` (0.500) **plus the measured line edge**,
  because a de-vigged spread is a coin flip by construction and this module
  claims no forecasting skill. The price advantage lives in the payout, never in
  the probability.

---

## What cannot happen, structurally

`stakeFor({source})` is the repository's staking gate: `'execution'` may size,
`'model'` returns zero units until proven CLV. A reasoning layer on top is
exactly the shape of thing that could quietly launder a model pick into looking
execution-grade. Three properties prevent it, each with a regression test:

- **`SOURCE_OF_KIND` is a closed enum** mapping opportunity *kind* → staking
  source. The source is **derived from the kind, never read off the candidate**.
  An unrecognised kind maps to `'model'` and therefore to zero. A candidate
  arriving with `staking_source: 'execution'` set on it is ignored.
- **Every ceiling comes from `stakeFor` itself**, called before Claude is
  consulted. Claude never sees a bet the gate zeroed.
- **`applyAllocation` clamps.** Claude may lower a stake or drop a bet; it
  cannot raise one above the ceiling, cannot introduce an id that was not
  offered, and cannot exceed the 8u portfolio cap. Its judgement is allowed to
  be more conservative than the arithmetic and never less.

Nothing here places a bet. It returns a recommendation for a human to approve,
following the convention `nfl-teaser-execution.js` sets: the server validates and
records an execution a human decided to make. `nfl-execution-edge.js`,
`staking.js`, `nfl-teasers.js` and `line-shopping.js` are read and called, never
modified.

Registered in `gridiron-model.js` as `betting.slate_allocation` at
**`advisory`** — not `authoritative`. It adds no edge of its own; the allocation
judgement has never been measured against outcomes. It may inform and rank, and
it may not size on its own authority.

---

## Measured latency

Real `callClaude` (Haiku 4.5), nine end-to-end runs across three slates.

| Path | propose | simulate | review | re-simulate | **total** |
|---|---|---|---|---|---|
| **Confirmed** (n=6) | 3070 ms | 4 ms | 3774 ms | 0 ms | **6848 ms** (6290–7440) |
| **Revised** (n=3) | 4133 ms | 7 ms | 5378 ms | 5 ms | **9523 ms** (9334–9798) |

The simulation is **~4 ms** — 400 draws × 4 weeks × 4 bets. Essentially all
latency is the two API calls; the verification itself is free. A revision costs
~2.7 s more, spent almost entirely on the longer review completion.

---

## The verify step reasoning over simulation output

The design question was whether step 4 would be real thinking over real numbers
or a shallow check. Three findings, all from live runs.

### 1. It reads the numbers and identifies the actual mechanism

Slate: a shopped Rams ‑2.5 (3u) plus a Wong teaser whose legs include the same
Rams game (1.79u). Claude's own first-pass reasoning had called the teaser
diversifying. After seeing the simulation:

> "The 0.80 correlation between the two bets means they fail together…the worst
> single week is ‑4.79u (the full slate size), and the p95 drawdown of 13.8% is
> driven almost entirely by correlated loss. **The gap between edge-present
> (+1.61u) and edge-absent (‑0.54u) is only +2.15u over 4 weeks, which does not
> justify the concentration.**"
>
> *changed_my_mind:* "I assumed the two bets were sufficiently independent
> because they span different games, but the 0.80 correlation (driven by shared
> Rams exposure) means they fail together far more often than I priced."

That is not a threshold firing. It cites the drawdown, the worst week, the
correlation coefficient and the edge-vs-no-edge gap, and names the specific
assumption it got wrong.

### 2. It correctly declines to revise, citing why a scary number isn't scary

Single shopped bet, 6.34pp edge, 2.5u:

> "A **59.8% chance of a losing month is ordinary variance** for a small
> fractional-Kelly edge, **not a warning sign**. The gap between measured-edge
> and no-edge scenarios (+1.37u) confirms the edge is real and working."
> — *changed_my_mind: "Nothing."*

Holding is a real outcome, and a hold that cites the numbers is worth more than
a rule that never fired.

### 3. Two failures the build caught — and what fixed them

Both were faults in **what the model was told**, not in its reasoning, and both
were found only because latency was measured end-to-end on real calls.

**(a) The briefing stated the correlation *rule* as boilerplate.** Every slate
was told "bets sharing a game are correlated at 0.80" regardless of whether it
had any shared games. On a fully diversified slate the model read that as a fact
about the bets in front of it and revised an allocation to manage a correlation
that did not exist. `describeCorrelation` now reports the **realised** matrix,
naming the correlated pairs or stating plainly that the slate is uncorrelated.

**(b) An unanchored losing-month rate caused systematic over-cutting.** Before
the fix, **9 of 9 runs revised downward** — including the lone well-priced bet
above, cut nearly in half. A ~50–60% chance of a losing month is the *ordinary*
condition of a small edge in fractional-Kelly units; presented alone it reads
like an alarm. The briefing now also simulates **the same bets at the same
stakes with no edge at all** (every win probability replaced by the price's
implied probability) and shows both columns, so the edge is legible as the *gap*
rather than the absolute level. Costs one extra JS simulation (~2 ms), no extra
API call. After the fix the decisions discriminate correctly: the genuinely
concentrated slate revises (3/3), the clean and single-bet slates confirm (6/6).

**A revision that changes nothing is labelled as such.** On the correlated
slate, the model reasoned correctly and then "revised" by swapping one teaser
for another containing the *same* shared game — identical exposure, identical
drawdown, identical path. `revisionEffect` compares the committed slate's
simulation against the abandoned one and reports:

> "The revision swapped tickets but did not change the simulated risk — same
> exposure, same drawdown, same losing-month rate. **Treat the stated rationale
> with suspicion: the bets changed and what is at risk did not.**"

A `status: revised` flag alone would have reported that as the loop working. It
is the loop producing a confident sentence attached to a null edit — the exact
failure mode this feature exists to avoid on the prediction side — so the
comparison is made on simulated *risk*, not on the bet list.

---

## What the live slate actually looks like

Run against real captured quotes today: **7 offered, 33 blocked**, all 33 for
*"no edge at this price"*, and every offered ceiling between **0.12u and 1.04u**.
No teaser was eligible (the teaser board needs recorded reachable payouts).

That is the honest headline, and it falls out of the sizing rather than being
asserted: **best-price selection alone does not beat the vig.** A coin flip at
‑105 is still a losing bet. Shopping moves the break-even from ~52.38% to ~51.1%
— it removes about a quarter of the hurdle and does not clear it. Only a book
disagreeing about the **number** by enough to matter — in practice, crossing 3 or
7, where the margin mass actually sits — makes a shopped side standalone +EV.

So most live rows arrive with a zero ceiling and are shown to the reasoning step
as context rather than as bets, and the real slates this feature reasons over are
small. That is the measurement stated correctly, not a defect.

---

## Endpoints

- `POST /api/execution-slate/recommend` — the full loop. Body: `{market?, limit?}`.
  Returns the committed slate, both simulations (with the no-edge reference),
  the revision effect, per-stage latency, and the gated/blocked lists.
- `GET /api/execution-slate/opportunities` — the gated opportunity list alone.
  No AI call, no cost.

An API key is required only when there is something to reason about; an empty
slate is a real and common answer that costs nothing.

## Tests

31 tests in `test/execution-slate-reasoning.test.js`, covering the
anti-laundering gate (including a smuggling attempt), the zero-stake result for
price-only shopping, teaser refusals, the correlation matrix, copula behaviour
(a correlated slate must show a worse tail than an independent one at equal
stake), seed determinism, clamping, the two-call bound, the hollow-revision
detector, and both briefing fixes above.

Suite: **915 tests, 914 pass, 0 fail, 1 skipped** (baseline before this work:
870/869/0/1). `npm run typecheck` and `npm run lint` clean.
