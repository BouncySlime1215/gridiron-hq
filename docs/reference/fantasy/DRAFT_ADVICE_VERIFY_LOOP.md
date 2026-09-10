# Draft advice: propose → verify → retry once

**Status:** built 2026-09-07. Route `GET /api/drafts/:id/advice`.
**Code:** `server/services/draft-advice-verify.js`, wired in `server/routes/drafts.js`.
**Tests:** `test/draft-advice-verify.test.js` (21).

## The problem

`/:id/advice` was one unchecked Claude call. It read the scouting dossiers for the
top five targets, named a player, and that was the answer. Nothing ever asked
whether the named player actually *held up* — whether taking him now leads to a
better finished roster than taking one of the alternatives it was shown.

Meanwhile `server/services/draft-lookahead.js` already answers exactly that
question, in JS, by playing the rest of the draft out a few hundred times per
candidate. The two never spoke to each other.

## The design

Four steps, at most two Claude calls, ever.

1. **Propose.** Unchanged from before: the same shortlist of five, the same
   dossiers, the same JSON schema, the same allow-list name check. Claude names a
   pick and argues for it.
2. **Verify.** `lookahead()` simulates the *whole shortlist* — 200 worlds per
   candidate, under common random numbers, so every candidate is scored inside
   the same simulated seasons and the same simulated draft orders. `judgeProposal()`
   then asks: is the proposed player's expected finished-roster value at or near
   the top, or is a shortlisted alternative meaningfully ahead?
3. **Retry, once.** If the simulation clearly contradicts the proposal, Claude
   gets one more call carrying the actual numbers — its original prompt, its own
   answer, then the challenge — and whatever it says next is final. Not a loop.
   A loop is an unbounded latency, and on a 90-second pick clock an unbounded
   latency is the same thing as a wrong answer.
4. **Commit.** The response carries a `verification` block saying whether the
   first instinct held or was corrected, with the numbers that decided it.

### The verify step is free

**The simulation runs while the propose call is in flight.** The shortlist comes
from `rankTargets()` and is fixed before Claude is asked anything, and the
lookahead simulates all five candidates rather than just the eventual proposal —
so it has no dependency on Claude's answer. `proposeVerifyRetry()` therefore
starts the HTTP request, runs the Monte Carlo synchronously while that request is
outstanding, and only then awaits. The ~1.9s of simulation lands inside the ~10s
the model spends generating and costs the pick clock nothing.

This ordering is load-bearing and is pinned by a test
("the simulation is started while the propose call is still in flight"); if it
regresses the feature silently gets two seconds slower on every pick.

### The retry re-decides the choice, not the scouting

`players[]` — pros, cons, camp line, status per shortlisted player — is a read on
each *player*, which a roster simulation has no bearing on. It is carried over
rather than regenerated. That is most of the first call's output tokens, and
output tokens are essentially the whole latency of this feature: the retry
therefore returns ~205 tokens instead of ~1,030 and costs 2.7s instead of 10.4s.

The per-player `verdict` field *is* choice-dependent, so it is reconciled — the
final pick reads `take`, and a player who lost the argument stops claiming it.

### What is untouched

`rankTargets()`, the instant deterministic board, renders immediately and never
waits on any of this. Nothing in this feature touches it. The advice layer stays
what it always was: secondary, non-blocking, and cached per pick number.

## The retry threshold

A contradiction must clear **both** bars. `VERIFY_THRESHOLD` in
`draft-advice-verify.js` is the single source of truth.

```
gap          = best_alternative.expected − proposed.expected
noise_bar    = SE_FACTOR × CRN_FACTOR × sqrt(sd_p²/n + sd_c²/n)      # 2 × 0.75 × …
material_bar = MATERIAL_FRAC × best_alternative.expected             # 1%
contradicted = gap > max(noise_bar, material_bar)
```

### Why these numbers

**`CRN_FACTOR = 0.75` was measured, not assumed.** `lookahead()` publishes only
each candidate's marginal `sd`, so the naive noise estimate is the *unpaired*
`sqrt(sd_p²/n + sd_c²/n)`. That overstates the real uncertainty, because common
random numbers cancel most of the shared noise out of the *difference*. To find
out by how much, the same round-2 board was simulated at 200 sims under eight
different seeds:

| candidate | mean gap-to-best | seed-to-seed sd of that gap |
|---|---|---|
| Trey McBride | 4.7 | 9.7 |
| Brock Bowers | 21.1 | 12.5 |
| Jeremiyah Love | 28.1 | 23.7 |
| Breece Hall | 28.1 | 23.7 |
| Javonte Williams | 35.6 | 21.4 |

against an unpaired SE of 32.6 — ratios of 0.30 to 0.73. `0.75` sits just above
the worst case observed, so the bar still errs toward *not* firing the retry
without erring by the factor of ~1.4 the uncorrected formula did.

The uncorrected version was visibly too dull. Calibration check on a real
round-2 board, 12-team league, 23 picks made:

| proposal | gap to best | uncorrected bar (66) | calibrated bar (47.5) |
|---|---|---|---|
| Trey McBride (a real shortlist candidate) | 8.9 | confirm | confirm |
| Javonte Williams (ditto) | 9.5 | confirm | confirm |
| Brock Bowers (ditto) | 25.1 | confirm | confirm |
| **Brandon Aubrey — a kicker, in round 2** | 55.6 | **confirm** ✗ | **contradict** ✓ |
| **MarShawn Lloyd — ~90 spots down the board** | 65.9 | confirm ✗ | **contradict** ✓ |

The uncorrected bar waved a round-2 kicker through. The calibrated one separates
cleanly: all five genuine shortlist candidates confirm, both bad picks trigger.

**`SE_FACTOR = 2`** is the ordinary two-standard-errors convention.

**`MATERIAL_FRAC = 0.01`.** Even a statistically real gap can be too small to
matter. 1% of a finished roster's expected value is ~20 points over a season:
about one starter tier, and comfortably more resolution than anyone should claim
for a preseason projection. Below that the two picks are the same pick and the
dossier reasoning is a better tiebreak than a third decimal of Monte Carlo. At
200 sims the noise bar is the binding one; the material bar matters if the sim
count is ever raised.

**`MAX_SNIPED_PCT = 25`.** A candidate gone before the user's turn in most
simulated worlds has an `expected` conditioned on the minority of worlds where he
survived — a selection-biased number, not comparable to a candidate available
everywhere. Such a player is neither judged nor used as the challenger.

### The threshold gets duller, never twitchier, as the simulation gets honest

`draft-lookahead.js` is gaining real player-outcome variance (a Gaussian copula
over the fitted archetype correlations, with lognormal marginals from the
recalibrated p20/p80 band). That widens `sd`, which *raises* the noise bar, which
makes the retry *rarer*. That is the correct response to admitting more
uncertainty, and it happens automatically — this module consumes `lookahead()`'s
published output shape and nothing else. Both properties are pinned by tests.

## Measured latency

Real Haiku 4.5 calls, real `lookahead()` over a real in-progress board (draft 16:
12 teams × 16 rounds, 23 picks made, round 2), 3 reps each, warm caches.

| | propose | simulate | retry | **wall clock** |
|---|---|---|---|---|
| **Confirmed first try** | 10.4s | 1.9s *(inside propose)* | — | **10.5s** (9.2–12.7s) |
| **Revised after retry** | 10.3s | 2.0s *(inside propose)* | 2.7s | **13.1s** (13.0–13.1s) |

Token counts behind those: propose 3,876 in / 1,028 out; retry 4,215 in / 205 out.

Verification adds **0 ms of wall clock** on the confirmed path — the whole
simulation hides inside the propose call. The retry path costs **+2.6s** over the
old single-call behaviour.

### Is that fast enough for a 90-second pick?

**Yes, comfortably, and with the important caveat that none of it blocks the
screen.** `rankTargets()`'s board is on screen at ~0s and this layer is
non-blocking and cached per pick. So the honest framing is not "13 seconds of a
90-second clock" but "the AI's second opinion, already simulation-checked,
arrives 13 seconds in, on top of a board that was instant."

Worst case measured is 13.1s — 15% of the clock. Even the old unchecked call was
10.5s, so the *added* risk here is 2.6s and only on the minority of picks where
the simulation actually objects.

**One real caveat: the first advice request of a draft pays cache warm-up.** The
preseason band curve and the correlation table are lazily fitted and memoised. On
a cold process the simulation took 15.0s rather than 1.9s, which overran the
propose call and pushed one observed request to **23.0s**. Still inside 90s, but
worth knowing. In normal use it does not arise: the board and the `/lookahead`
route warm the same caches, and both run before anyone opens the advice panel.

## Response shape

Everything below is added to the existing advice payload; nothing was removed.

```jsonc
"verification": {
  "status": "confirmed" | "revised" | "upheld" | "unverified",
  "revised": false,
  "claude_calls": 1,
  "proposed_pick": "Jeremiyah Love",
  "final_pick": "Jeremiyah Love",
  "note": "Confirmed on the first pass — the simulation also ranks Jeremiyah Love first…",
  "simulation": {
    "sims": 200, "compute_ms": 1916, "contradicted": false,
    "reason": "…",
    "proposed":        { "name": "…", "expected": 2162.5, "sd": 329, "sniped_pct": 0 },
    "best_alternative":{ "name": "…", "expected": 2153.6, "sd": 359.5, "sniped_pct": 0 },
    "gap": -8.9,
    "threshold": { "required_gap": 47.5, "noise_bar": 47.5, "material_bar": 21.6,
                   "se_factor": 2, "crn_factor": 0.75, "material_frac": 0.01 }
  },
  "latency_ms": { "propose_ms": 10379, "simulate_ms": 1794, "simulate_overlapped": true,
                  "judge_ms": 0, "retry_ms": null, "total_ms": 10379 }
}
```

The four statuses:

- **`confirmed`** — the simulation agreed, or disagreed only within the bar. One
  Claude call. The advice is returned exactly as proposed.
- **`revised`** — the simulation objected, Claude was given the numbers, and it
  changed the pick. Two calls.
- **`upheld`** — the simulation objected, Claude was given the numbers, and it
  kept its pick anyway. Two calls. This is a legitimate outcome, not a failure:
  the simulation knows the board, roster construction and scarcity, but it does
  not know the dossier, and a camp report or an injury designation is a real
  reason to hold. The challenge prompt says so explicitly rather than leading the
  model to capitulate.
- **`unverified`** — no check was possible (the draft is over, the proposal was
  an off-list name, the named player is sniped in >25% of worlds, or the
  simulation errored). **Never spends the retry**, and never blocks the answer: a
  live draft cannot afford to fail closed.

`gap` is the proposal's *signed shortfall* against the best alternative, so a
proposal that is itself the sim's favourite reports a negative gap.

## The hard cap, and why it is structural

"At most 2 Claude calls" is not a counter someone has to remember to check.
Inside `proposeVerifyRetry()` there is no loop construct at all and `retry` is
referenced exactly once, so the cap cannot drift as the code changes.

The test that matters here is the one that would defeat a naive
"retry until they agree": the retry comes back with a *third* name that the
simulation likes even less. A loop would keep going and blow the pick clock. This
stops at two and takes the second answer, agreement or not. The simulation is
also deliberately **not** re-run to re-judge the retry — re-judging is the first
half of a loop.

## Known limitations

- **The comparison is closed over the shortlist.** The sim asks "was this the
  best of the five options Claude was shown", not "is there something better
  further down the board". The latter is `rankTargets()`'s job and is already on
  screen. This keeps the propose call at its existing five-player scope.
- **`gap` is judged against the marginal `sd`, not a paired one.** A paired
  standard error, computed from the per-simulation value differences, would be
  the exact quantity rather than an empirically corrected approximation of it.
  That needs `lookahead()` to expose per-sim values, which it does not; the
  measured `CRN_FACTOR` is the stand-in until it does.
- **`CRN_FACTOR` was calibrated on one board.** Eight seeds, one round-2
  12-team state. The 0.30–0.73 spread across candidates on that single board is
  wide enough that 0.75 should be re-checked if the lookahead's variance model
  changes materially.
- **Cold-start.** See the latency caveat above.
