# valuation-map (WA / T1) — TDD report

**Item:** the per-manager valuation map — for every manager and every player,
what *that* manager thinks he is worth, next to what we think he is worth.
Master plan 00 → D4: *"The core object is a per-manager valuation map … The gap
on each player is the raw material of every trade."*

**Files owned and changed:** `server/services/counterparty-pricing.js`,
`server/services/talk-vs-model.js`, `test/valuation-map.test.js`, this document.

**Gate:** pre-registered in
`/private/tmp/claude-501/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/scratchpad/wa/valuation-map/GATE.md`,
written before the first test and the first line of code.

---

## 1. Audit — what existed, and the decision

The inventory's default decision for the Trade Brain is **"extend `findTrades`
and `counterparty-pricing`… the per-manager 'their value vs our value' layer is
already there, so the valuation map is an extension, not a new build."**
Confirmed, with evidence, before writing anything:

| What was already there | State found |
|---|---|
| `counterpartyLayer` | receptiveness from chat rank, accept rate and Nick's priors; `players` (raw sentiment) and `reads` (talk-vs-model) attached per manager |
| `perceivedValue` | one multiplier per player: the talk read **or** raw sentiment, nothing else; capped at ±15% per package |
| `negotiationProfilesFor` | a validated loader for the richest artifact we own — **and no reader** |
| `manager_archetypes` luck | copied into `manager_signals` by the signals build — **and no reader** |
| `bluff-detector` stance | wired into ONE binary decision (is this player in the candidate pool), not into any price |
| positional need | `analyzeLeague`, used by `trade-engine#rosterContext`; the inventory counts three copies of needs/surplus already |
| "how Nick looks" | nothing at all |

So five of the seven signals the brief names existed as data with no consumer,
and two (sentiment, talk-vs-model) were already priced but as a bare,
unexplained multiplier.

**Decision: EXTEND, one function.** Every per-player multiplier now comes from
`playerValuation()`. `perceivedValue` → `readDeal` → the trade engine goes
through it, and so does the new `valuationMap()`. The map is a **view** over the
same function, not a second engine, so a number on a trade card and a number on
a manager page cannot disagree. Positional need is read from `analyzeLeague`
rather than becoming a fourth copy.

## 2. RED → GREEN

| Commit | Evidence |
|---|---|
| `9156e53` TDD RED | 24 of 24 fail |
| `ddc673f` TDD GREEN | 24/24 pass; named suites and full suite green |
| (this stage) | +2 tests: the manager-level ablation hook, and the defect in §5 |

## 3. What the map is

`their_value = our_value × ∏(named, individually capped factors)`.

| Source | Cap | Min n | Needs | Direction |
|---|---|---|---|---|
| `talk_vs_model` | 10% | 3 mentions | chat | the crossed read (sales pitch ↓, attachment ↑, buy-low ↓) |
| `chat_sentiment` | 12% | 1 | chat | the fallback where there is talk but no model read |
| `profile_roster_read` | 10% | 1 | chat | his negotiation profile's own over/undervalues, untouchables, quietly-available |
| `hype_vs_usage` | 8% | 2 games | weekly expected points | his own player outscoring the usage that earns it |
| `luck_self_view` | 5% | 4 scored weeks | archetype build | a flattered record prices its own roster high |
| `positional_need` | 8% | 1 | roster read | a hole raises what he pays there; depth lowers it |
| `recency_post_loss` | 5% | 1 | standings | **receptiveness**, not a player's price |
| `untouchable_credibility` | 10% | 1 | chat | a refusal that holds is a real price; a bluffer's is an opening one |

Per player the product is clamped to **±20%**; per package the existing **±15%**
cap is unchanged. Every factor carries `source`, `label`, `effect`, `n`, `cap`,
`fitted: false` and `why`.

**Nothing is charged twice.** `talk_vs_model` and `chat_sentiment` are
alternatives for the same evidence; `hype_vs_usage` fires only where there is no
talk read, because the expectation gap is already that read's discriminator;
`praise_means` is not its own factor — it halves an attachment premium for a
manager the model says hypes before selling, and sharpens a sales-pitch discount.

**A source below its minimum sample is reported inert with its reason, never
dropped.** In week 2 of 2026 that is two of the eight, and both say so:
`hype_vs_usage` ("rests on 1 of the 2 needed") and `luck_self_view` ("rests on 1
of the 4 needed") — the archetype build has one scored week, and one game of luck
is noise.

## 4. Gate results

| Gate | Result |
|---|---|
| G1 composition and caps | PASS — 26/26 tests; zero information returns exactly 1; every factor inside its own cap; the player clamped at ±20% and says so; the package cap unchanged |
| G2 provenance | PASS — every factor names a registry source with n, cap and `fitted: false`; under-sampled sources reported inert with the reason |
| G3 cutoff safety | PASS — a week-5 map's gap rests on 4 weeks; a week-6 map's on 5, with a 60-point week-5 explosion in the fixture that never leaks in |
| G4 degradation | PASS — chat-free leagues get a map and list the absent chat sources; a league with no signals returns `available: false`; a call with no priced universe is refused |
| G5 how Nick looks | PASS — offers per manager with how they answered, what the league knows he is shopping (by source), veto votes against him; he is never a counterparty in his own map |
| G6 evidence | PASS as pre-registered (computed on all 30 with its interval) — **and the result is null**; see §6 |
| G7 ablation | PASS — see §7 |
| G8 no regression | PASS — full suite 2,635 tests, 2,593 pass, 3 fail (the known prop-CLV three), 39 skipped; lint and typecheck clean; league-4 `findTrades` cold +0.9 s median (budget 1.5 s), warm +2 ms (budget 15 ms) |
| G9 LLM spend | $0 — nothing here calls a model |

## 5. The one defect found and fixed after GREEN

Running the map on the real league-4 corpus, `selfRead` reported four players
Nick is known to be shopping. One of them was **"Olave-adjacent throw-ins when
he had him"** — a prose line from the `ME` profile's `quietly_available` list,
presented to Nick as a player. Fixed test-first (`G5b2`): a profile entry now has
to resolve to a real row in `players` before it is listed. Ownership is
deliberately *not* required — he can be known for shopping someone he has since
moved. The live list is now three real names: De'Von Achane (chat **and**
profile), A.J. Brown, Zach Charbonnet.

The same prose problem is handled at the other end by `profileListHit`, which
searches only the part of an entry before the first bracket or em dash: the real
corpus contains *"Ashton Jeanty (demands Achane + Chase Brown-level return…)"*,
and matching the whole string would have attributed Achane and Chase Brown to
the list as well.

## 6. Evidence check (G6) — the honest answer is "no measurable difference"

Population: all 30 decided 2026 proposals whose related offer carries trade items
(6 accepts, 24 declines; leagues 2, 3 and 4; 13 distinct deciders; 130 of 130
trade items resolved to real players; none skipped).

| Arm | What it prices on | AUC |
|---|---|---|
| A | our own value gain for the decider | **0.813** |
| B | the map, **cutoff-safe** | 0.806 |
| C | the map, today's data (contaminated) | 0.833 |

Decider-clustered bootstrap, 2,000 resamples, stable across four seeds:

| Comparison | Median | 95% interval |
|---|---|---|
| B − A | 0.000 | −0.017 … 0.000 |
| C − A | +0.017 | 0.000 … +0.065 |

On the 16 decisions made by **someone other than Nick** — the ones the map is
actually for — B − A is exactly 0.000 (interval 0.000 … 0.000).

Arm B rebuilds each manager's chat sentiment from the messages strictly before
that decision's own timestamp, takes the expectation gap as of that week, and
takes ownership from the offer itself (a man gives what he owns). The sources
that cannot be rebuilt as of the date — the negotiation profiles (written
2026-09-18 from the whole corpus), today's rosters and today's luck — are zeroed
in B and present in C. That is why C is not evidence: its lift is exactly the
part that can see the future.

**Reading it plainly:** with 6 accepts, our own value already separates accepts
from declines well (AUC 0.81 — people mostly decide on value). The chat layer's
contribution is smaller than 30 decisions can detect. The map ships because it
is a *read* that the tactics and the Coach are built on, not because this
measured it; the pre-registered red flag (a negative difference whose interval
excludes zero) did not fire, and the number is reported rather than buried.

Re-testable as proposals accrue — that is the master plan's own plan for this
number (E1: "tested on what exists, shown as a band; re-tested as proposals
accrue").

## 7. Ablation (G7) — league 4, week 2

Each source zeroed in turn. The arithmetic is exact, not approximate: zeroing a
player-level source can only move `perceptionFactor`, and zeroing
`recency_post_loss` can only move `managerFactor`, so each deal's score rebuilds
from its own parts. Two controls run first and the table is not reported unless
both pass — every unablated score rebuilds to < 1e-6, and `perception_shift`
recomputed here with nothing zeroed equals the engine's own number on every
deal. Both passed.

| Source | Deals repriced (of 15 mutual / 61 plausible) | Top-10 membership changed | Top-10 order changed |
|---|---|---|---|
| `profile_roster_read` | 7 / 39 | 0 | **2 / 6 positions** |
| `positional_need` | 5 / 40 | 0 | 0 |
| `recency_post_loss` | 15 / 61 | 0 | 0 |
| `chat_sentiment` | 2 / 14 | 0 | 0 |
| `talk_vs_model` | 0 / 6 | 0 | 0 |
| `untouchable_credibility` | 0 / 0 | 0 | 0 |
| `hype_vs_usage` | inert (1 of 2 games) | — | — |
| `luck_self_view` | inert (1 of 4 weeks) | — | — |

**No source changes which ideas surface.** One source changes their order. The
binding constraint is not the map: `perceptionFactorFor` in `trade-engine.js`
bounds the whole counterparty read to ±10% of a deal's score, and it is applied
to `perception_shift`, which by construction cancels our own value gap. That
constant is hand-set and belongs to a file this item does not own — it is named
in the handoff rather than widened here.

What the map *does* change is what Nick is told about each deal and each
manager, which is what the tactics step (T2) and the Coach consume.

## 8. Coverage, live

| League | Map available | Sources firing |
|---|---|---|
| 4 Transfer portal | yes | chat_sentiment, talk_vs_model, profile_roster_read, untouchable_credibility, positional_need, recency_post_loss |
| 1, 2, 3, 5 | yes | positional_need, recency_post_loss (the chat sources listed absent with the reason) |

On the production database as it stands, leagues 1, 2, 3 and 5 have **no**
`manager_signals` rows at all, so their maps return `available: false` until
`scripts/build-manager-signals.mjs` next runs — it is already on the refresh
loop (`scripts/refresh-live-data.mjs`) and has not ticked since it was wired.
Everything above was measured on a `VACUUM INTO` copy with that build run, which
is why the all-league path is exercised rather than assumed. No production write
was made.
