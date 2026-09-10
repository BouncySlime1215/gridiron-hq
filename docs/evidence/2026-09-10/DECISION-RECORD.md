# Decision record — September 10, 2026

**Status: evidence, not instructions.** The single active plan is
[`docs/CLAUDE-NEXT-STEPS.md`](../../CLAUDE-NEXT-STEPS.md).

Slice 10 of that plan asks for an "explicit continue/reject/advance record" with "no automatic
profitability claim." This is that record. It is deliberately short, because most of what it has to
say is what the evidence does *not* establish.

---

## 1. The question, and the answer available today

**The question:** can Gridiron select obtainable NFL spread bets with positive expected returns
after the offered price?

**The answer available today: unknown, and not yet askable.** That is not a hedge. Until this round
the system could not tell two different decisions apart, could not say when it had received a
price, and priced contracts with a distribution that returned negative probabilities. A record
produced by that system would not have answered the question either way — it would have been
noise with a decimal point on it.

What changed is that the question is now *askable*. Nothing here says the answer will be yes.

## 2. What the evidence actually supports

| Claim | Supported? | By what |
|---|---|---|
| The software records what it decided, reproducibly | **Yes** | C01/C02: 32 tests, including the real board→pipeline path. Every material field changes the content hash; no field silently collapses. |
| An installation with real execution rows can upgrade and start | **Yes** | C03: 10 tests against populated 026-era fixture databases, with byte-identical row preservation and a restorable `VACUUM INTO` snapshot. |
| Spread probabilities are coherent | **Yes** | C05: property tests over generated line pairs; the reported `coverProbabilities(3, -10.5)` counterexample now returns a valid distribution rather than win −0.125. |
| The suite passes on a clean checkout | **Yes** | C06: 1,449 pass / 0 fail under CI conditions, from a 24-failure baseline. |
| A decision is reproducible from its stored inputs | **No** | Every run records `data_identity_status: unfrozen_live_tables`. The packet exists and is correct; no forecast consumes it yet. |
| Any Gridiron forecast beats the market | **No evidence either way** | Nothing has been qualified. The shopping board's probabilities come from the market's own posted line and report `qualified: false` on their face. |
| The T−60 protocol works in practice | **Not yet observed** | The runner is built, tested and registered on the live scheduler tier. It has never run against a real slate. Zero prospective observations exist. |
| The historical record improved | **Not claimed, and must not be** | The 2021–2025 record is preserved unchanged: 153 spread bets, −11.85 units, −7.75% ROI. A repaired strategy gets a new identity and a new evaluation. |

## 3. What was found that changes how earlier evidence should be read

Three findings are worth carrying forward independently of any code:

**The clock error had a direction.** `requested_at` is stamped before a provider request goes out,
and `requested_at ≤ received_at` always. Using it as a receipt made every quote look like it
arrived *earlier* than it did — the direction that admits evidence a decision could not have had.
Any historical analysis that treated quote availability as established by that column was
systematically optimistic, not randomly wrong.

**The scoring error punished the right models.** The family report scored an *unconditional* win
probability against a *decided* binary label, and the penalty scaled with predicted push mass. A
model that correctly identified key numbers scored worse than one that ignored them. Any ranking
produced by that report is suspect in a specific direction.

**Existing quote history is no longer prospective evidence.** This is a consequence of the fix, and
it is a real loss. Batches that only ever recorded a request time are now marked
`legacy_request_time_only` and cannot support a prospective claim. They remain fully usable for
labeled historical work. Backfilling a receipt time would have preserved the appearance of evidence
by writing the defect into the data.

## 4. The decision

**Continue, at the current stage, with no promotion and no wager authority.**

Specifically:

- **Advance** slices 0–6 and 9 to closed. Their exit evidence exists and is named in the plan's
  status register.
- **Do not advance** to a profitability judgement. There is nothing to judge: no prospective
  observation has been recorded.
- **Do not open** slices 7 and 8 (family adaptation, combination). §9.1 stages them behind a frozen
  first comparison that has not been run, and running families before that comparison is how a
  research budget disappears into diagnostics.
- **The next thing that resolves anything** is turning on permitted all-game observation and letting
  the T−60 runner record real captures. That produces coverage numbers — how often a packet
  actually freezes, how often a quote is there, how often a capture is missed — which is the first
  evidence in this project that would be genuinely new.

## 5. What would change this record

A qualified forecast consuming the frozen packet, on a declared universe, with a stated endpoint.
Nothing short of that. In particular, none of the following would:

- More components in the ensemble.
- A larger historical rerun.
- The full test suite passing.
- Another correction register being closed.

The plan's own words, kept here because they are the standard this record is written against:
*"Do not make 'more data,' 'more models,' 'all tests pass,' or 'waiting for football' substitutes
for the specific missing evidence."*
