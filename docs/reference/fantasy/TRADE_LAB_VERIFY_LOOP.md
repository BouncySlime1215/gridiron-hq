# Trade Lab: propose → verify → retry once

**Status:** built 2026-09-07. Route `POST /api/trades/:leagueId/sense-check`.
**Code:** `server/services/trade-verify.js`, wired in `server/routes/trades.js`.
**Tests:** `test/trade-verify.test.js` (24).

## The problem

`/sense-check` was one unchecked Claude call. It read a deal the deterministic
engine had already scored — lineup points, market value, floor/ceiling, the
season-by-season record of every player changing hands — graded it `sound` /
`worth a second look` / `risky` / `lopsided`, and that was the answer.

Meanwhile `server/services/season-sim.js#tradeImpact()` has answered a strictly
better question the whole time. It plays the rest of the season out hundreds of
times **with the trade and without it**, under common random numbers, and reports
what the deal does to **both teams' championship odds**. It values depth, byes,
weekly variance and the playoff bracket simultaneously, without any of them
needing a rule.

The two never spoke. A user could be told a deal was "sound" while the
simulator, unasked, would have said it cost them title odds — and nothing in the
sense-check's inputs would ever have revealed that, because **points per week is
the proxy and championship odds are the thing it proxies for**, and they
disagree more often than people expect.

## Which of the three trade-related Claude calls this wraps

There are three, and only one of them issues a verdict on a specific deal.

| Call | File | What it does | Wired? |
|---|---|---|---|
| `trade-pitch` | `routes/tradelab.js` | Builds a *negotiation ladder* — invents anchor/fair packages between two rosters | **No.** It proposes deals rather than judging one; there is no verdict for a simulation to contradict, and it emits several packages at once. |
| `trade-explain` | `routes/trades.js` | Writes the *negotiation copy* for an already-scored deal | **No.** Its own prompt says "the analysis is already done — do not re-argue the numbers". It produces a pitch, a counter-read and a walk-away line. Nothing it emits is a recommendation to verify. |
| **`trade-sense-check`** | `routes/trades.js` | An *independent verdict* on one specific, fully-specified deal | **Yes.** It emits `verdict` (one of four grades) and `agrees_with_engine`. It is the only one of the three whose output a user acts on as a recommendation, and the only one whose subject is a single deal `tradeImpact()` can be pointed at. |

## The design

Four steps, at most two Claude calls, ever.

1. **Propose.** Unchanged: the same prompt, the same `evidenceLines` /
   `playerEvidence` / `sideRisk` machinery, the same four-verdict JSON schema.
2. **Verify.** `tradeImpact()` runs the league twice — as it is and as it would
   be — with one shared projection build and one shared seed, so the difference
   is the trade and not the gap between two noisy simulations.
   `judgeTradeVerdict()` then asks whether the simulated season supports the
   verdict or contradicts it.
3. **Retry, once.** If it clearly contradicts, Claude gets one more call carrying
   the actual numbers — its original prompt, its own verdict, then the challenge
   — and whatever it says next is final. Not a loop.
4. **Commit.** The response carries a `verification` block saying whether the
   first read held or was corrected, with the numbers that decided it.

### Both sides, from one simulation

`tradeImpact()` returns `me` **and** `them` from a single paired run, so checking
what the deal does to the counterparty costs nothing extra. The contradiction
test is on **my** title-odds delta — that is the quantity the user's decision is
about — but the other side's numbers go into the challenge prompt and the
committed payload, because "this gains me 3pp and them 6pp" is a fact worth
having in front of the model.

### Verdict → stance

The gate needs a number, and the prompt emits a word. `STANCE_OF_VERDICT` is the
only place that mapping lives:

| verdict | stance | contradicted when |
|---|---|---|
| `sound` | accept | title delta < −bar |
| `risky`, `lopsided` | reject | title delta > +bar |
| `worth a second look` | caution | \|title delta\| > bar |

`lopsided` is directionally ambiguous in English — a deal can be lopsided in my
favour — but not in this prompt, which grades a deal *I am considering
accepting* and lists it as the most severe of the four. It reads as "do not do
this". That reading is load-bearing and it is what catches the worked example
below.

`worth a second look` is a shrug, so it is contradicted **symmetrically**: a
shrug loses to the simulation having a clear answer in either direction. That is
not a lower bar, it is the same bar applied to the absolute value.

`agrees_with_engine` is deliberately **not** gated on. It is Claude grading
Claude against the lineup-points engine — the proxy. It is reported, never acted
on.

### The verify step is (almost) free

**The simulation runs while the propose call is in flight.** The trade is fully
specified by the request body before Claude is asked anything, so `tradeImpact()`
has no dependency on the proposal. `proposeVerifyRetryTrade()` fires the HTTP
request, runs the Monte Carlo synchronously while that request is outstanding,
and only then awaits.

Measured, this hides the *entire* simulation: ~11–14s of Monte Carlo inside a
~20–22s propose call. This ordering is pinned by a test ("the simulation is
started while the propose call is still in flight"); if it regresses the feature
silently gets twelve seconds slower on every check.

## The retry threshold

A contradiction must clear **both** bars. `TRADE_VERIFY_THRESHOLD` in
`trade-verify.js` is the single source of truth.

```
delta        = me.title_delta                                   # a probability
noise_bar    = SE_FACTOR × NOISE_SD × sqrt(REFERENCE_RUNS / runs)   # 2 × 0.0155 × …
material_bar = MATERIAL_TITLE_DELTA                                 # 0.01
bar          = max(noise_bar, material_bar)
```

At the shipped 1,200 runs that is **2.2 percentage points of championship odds**.

### Why these numbers — and why not the draft loop's

`draft-advice-verify.js` measures a gap in *points of finished-roster value* and
lands on a 47.5-point bar. That number is meaningless here: title odds are a
probability whose entire interesting range in a 12-team league sits within a few
points of 1/12. Nothing was imported; this quantity was measured on its own.

**`NOISE_SD_AT_REFERENCE_RUNS = 0.0155` was measured, not assumed.**
`tradeImpact()` publishes a `title_delta` and **no standard error for it**, so
unlike the draft loop there is no published `sd` to correct — the noise had to be
sampled directly. Three real deals from the trade finder on a live 12-team ESPN
league (league 29) were each re-simulated under **six different seeds** at 600
runs:

| deal (my side gives → gets) | mean title delta | seed-to-seed sd |
|---|---|---|
| Justin Jefferson + Stefon Diggs → Quinshon Judkins + Jalen Hurts | −3.81pp | 0.0069 |
| Lamar Jackson → TreVeyon Henderson + Jared Goff | +1.53pp | 0.0122 |
| CeeDee Lamb → Chris Olave + Tyler Shough | −1.47pp | 0.0139 |

**The 1/sqrt(runs) rescaling was verified, not assumed.** The noisiest of the
three was re-measured across an eightfold range of run counts:

| runs | measured sd | 1/√runs prediction from the 600 figure | seconds |
|---|---|---|---|
| 300 | 0.0190 | 0.0197 | 10.1 |
| 600 | 0.0139 | — | 11.5 |
| 1200 | 0.0107 | 0.0098 | 18.2 |
| 2400 | 0.0067 | 0.0070 | 23.7 |

It tracks. Rescaling all five figures back to the 600-run reference gives 0.0134
/ 0.0139 / 0.0151 / 0.0134 (plus the 0.0069 and 0.0122 deals); **0.0155 sits just
above the worst of them**, so the bar errs toward *not* firing the retry.

**`SE_FACTOR = 2`** is the ordinary two-standard-errors convention.

**`MATERIAL_TITLE_DELTA = 0.01`.** Even a statistically real title-odds change
can be too small to act on. A season is one sample; a deal that moves a
championship from 8.3% to 8.6% has, in the only run of the season that will ever
happen, changed nothing a manager can perceive or plan around. At 1,200 runs the
noise bar binds; this floor only starts to matter above ~5,800 runs, and it
exists so that raising the run count can never drive the bar to zero.

### The run count was set by measurement, and it moved

600 was the initial default, on the assumption that the simulation had to stay
small to stay hidden inside the propose call. Measuring the real route proved
that wrong in a useful direction: the propose call takes ~20s and 600 runs take
~8s, so **more than half the budget was going unused**. 1,200 runs take ~11–14s —
still inside the propose call — and cut the bar from 2.9pp to 2.2pp.

That was not cosmetic. On the Jefferson + Diggs deal at the fixed `seed: 1` the
route actually ships with:

| runs | measured delta at seed 1 | bar | outcome |
|---|---|---|---|
| 600 | −2.2pp | 2.9pp | inside the bar — **no check fired** |
| 1200 | −3.6pp | 2.2pp | clears — the simulation's objection is visible |

Going further is a losing trade: 2,400 runs take ~24s and would start adding real
wall clock for another 0.7pp. The bar rescales itself (`contradictionBar`), so
moving this dial never requires a second calibration.

### Calibration check: does the bar separate?

Deliberately lopsided controls in both directions, plus a wash, at 600 runs
(bar 2.9pp — the harder test):

| deal | my title odds | verdict fed in | result |
|---|---|---|---|
| Give away Justin Jefferson + CeeDee Lamb for a D/ST and a kicker | 4.3% → 0.5% (**−3.8pp**) | `sound` | **contradicted** ✓ |
| Take Jonathan Taylor + Brock Bowers for a kicker and a D/ST | 4.3% → 21.2% (**+16.8pp**) | `risky` | **contradicted** ✓ |
| Swap two similar bench pieces (Chig Okonkwo ↔ Kenyon Sadiq) | 4.3% → 5.5% (+1.2pp) | `worth a second look` | **confirmed** ✓ |
| Lamar Jackson → Henderson + Goff (a real finder deal) | +1.5pp | any | confirmed ✓ |
| CeeDee Lamb → Olave + Shough (a real finder deal) | −1.5pp | any | confirmed ✓ |

Both absurd deals fire in the correct direction; all three realistic ones
confirm. The bar is dull by design and it is dull in the right place.

## Measured latency

Real Haiku 4.5 calls, real `tradeImpact()` on a real 12-team ESPN league,
warm caches, at the shipped 1,200 runs.

| | propose | simulate | retry | **wall clock** |
|---|---|---|---|---|
| **Confirmed first try** | 20.3s | 10.7s *(inside propose)* | — | **20.6s** |
| **Revised after retry** | 22.4s | 13.8s *(inside propose)* | 6.2s | **28.8s** |

At the earlier 600-run setting, three confirmed runs measured 17.6 / 17.9 / 17.9s
wall with 7.9–8.5s of simulation, all fully hidden.

**Verification adds 0 ms of wall clock on the confirmed path** — the whole
simulation hides inside the propose call. The retry path costs **+6.2s** over the
old single-call behaviour, and only on deals where the simulation actually
objects.

### Is that acceptable here?

**Yes, and honestly it is the propose call that is slow, not the verification.**
Trade Lab has no 90-second clock; the sense-check is an on-demand button on a
trade card, next to the existing "simulate title odds" button that already costs
~7s on its own. A user who presses it is asking for a considered answer.

The honest framing: the *old* unchecked call was already ~20s, and 20s of that is
the model generating ~1,100 tokens of prose. The added cost of being
simulation-checked is **zero** on the common path and **+6.2s** on the minority
of deals where the check fires. That is a good trade, and it is a materially
different bargain from the draft advisor's, where the same design had to justify
itself against a live clock.

**One caveat, and it is the same one the draft loop has:** the first call in a
cold process pays cache warm-up on the projection build and the correlation
table. `tradeImpact` builds projections once per call and shares them across both
halves of the pair, so it is warm within a single request, but a cold process
will overrun the propose call the first time.

## The worked example — the verify step catching a real thing

A rival offers Jonathan Taylor + Brock Bowers for Harrison Butker + a D/ST. The
engine scores it at **+6.8 ppg and +14,592 of market value in my favour** and
labels the fairness **"lopsided my way"**.

Claude, reading that, proposed **`lopsided`**.

That is a defensible read of the word and a **wrong answer to the question**. The
user is deciding whether to *accept*, and `lopsided` in this prompt's grading
scale reads as a warning. The model had turned "this deal is enormously in your
favour" into a reason for caution.

The simulation, run concurrently and never having seen the verdict:

```
1200 paired simulated seasons: my championship odds 5.2% → 21.3%  (+16.1pp)
                               their championship odds            (−16.3pp)
bar 2.2pp → contradicted
```

One retry, carrying those numbers. The committed answer:

> **verdict:** `sound` *(revised from `lopsided`)*
>
> "The simulation's +16.1pp championship gain for MET outweighs the weekly points
> deficit because Taylor's role (75% of IND carries, 19.1/game) and 2025
> production (362 pts, RB4) provide playoff-schedule leverage that raw ppg cannot
> measure. The engine's verdict was rooted in lineup points and market value; the
> simulation values depth, schedule fit, and optimal playoff construction."

`note`: *"Revised after simulation: the first read was "lopsided", but the verdict
reads as "do not take this deal", but 1200 paired simulated seasons put my
championship odds at 5.2% → 21.3% (+16.1pp) — a gain past the 2.2pp bar… —
changed to "sound"."*

And the confirming case from the same run: Jefferson + Diggs → Judkins + Hurts,
which the lineup engine likes at **+15.01 ppg**. Claude proposed `risky` anyway,
on the multi-season records. The simulation agreed — **−3.6pp** of championship
odds — and the answer shipped **confirmed on one call**, with the number now
visible next to the verdict rather than absent from it.

That pair is the feature in miniature: it corrected a verdict that was wrong for
a subtle reason, and it left alone a verdict that was right for a reason the
simulation independently supported.

## Response shape

Everything below is added to the existing sense-check payload; nothing was
removed.

```jsonc
"verification": {
  "status": "confirmed" | "revised" | "upheld" | "unverified",
  "revised": true,
  "claude_calls": 2,
  "proposed_verdict": "lopsided",
  "final_verdict": "sound",
  "note": "Revised after simulation: …",
  "simulation": {
    "runs": 1200, "seed": 1, "paired": true, "compute_ms": 13802,
    "contradicted": true, "stance": "reject", "reason": "…",
    "my_team":    { "owner": "MET", "title_before": 0.0517, "title_after": 0.2125,
                    "title_delta": 0.1608, "playoff_delta": 0.29, "wins_delta": 1.9 },
    "their_team": { "owner": "…",   "title_delta": -0.1625, … },
    "title_delta": 0.1608,
    "threshold": { "required_gap": 0.0219, "noise_bar": 0.0219, "material_bar": 0.01,
                   "se_factor": 2, "noise_sd": 0.0155, "reference_runs": 600 }
  },
  "latency_ms": { "propose_ms": 22366, "simulate_ms": 13802, "simulate_overlapped": true,
                  "judge_ms": 0, "retry_ms": 6223, "total_ms": 28589 }
}
```

The four statuses:

- **`confirmed`** — the simulation agreed, or disagreed only within the bar. One
  Claude call, answer returned exactly as proposed.
- **`revised`** — the simulation objected, Claude got the numbers, and it changed
  the verdict. Two calls.
- **`upheld`** — the simulation objected, Claude got the numbers, and it kept the
  verdict. Two calls. A legitimate outcome, not a failure: the simulator does not
  know about injury designations, camp reporting, or a multi-season floor being
  sold for a one-year spike. The challenge prompt says so explicitly rather than
  leading the model to capitulate.
- **`unverified`** — no check was possible. **Never spends the retry**, never
  blocks the answer.

## The deal body is re-validated before it is simulated

`simulationArgsFor()` in `routes/trades.js` re-resolves every id in the
client-supplied deal against the live rosters: both roster ids must be real teams
in this league, every player I am sending must actually be on my roster, and
every player I am receiving must actually be on theirs. A deal failing any of
those comes back `unverified` with the reason, rather than simulated wrongly.

This matters because of a genuine gap in `tradeImpact()` — see below.

## The hard cap, and why it is structural

"At most 2 Claude calls" is not a counter someone has to remember to check.
Inside `proposeVerifyRetryTrade()` there is no loop construct at all and `retry`
is referenced exactly once.

The test that matters is the one that would defeat a naive "retry until they
agree": the retry comes back with a verdict the same simulation contradicts just
as clearly. A loop would keep going. This stops at two and takes the second
answer. **The simulation is also deliberately not re-run to re-judge the retry —
re-judging is the first half of a loop.**

## A real bug found in `tradeImpact()` while reading it (NOT fixed here)

`tradeImpact()`'s comment says common random numbers make it a paired experiment:
*"the same simulated football worlds are used before and after, so Monte Carlo
noise cannot masquerade as trade impact."* The intent is right and the seeding is
right. **The pairing is weaker than that claim, because the player→draw
assignment is permuted between the two runs.**

Inside `simulateSeason`, the player universe is built in team order:

```js
const roster = [...new Map(teams.flatMap(t => t.players.map(p => [p.id, p]))).values()]
  .filter(p => SCORED.has(p.position));
```

`sampleWeeks()` is then called for each player **in that array order**, consuming
the seeded random stream sequentially. A trade does not change the *set* of
rostered players — it only moves them between teams — but it does change their
position in the flattened array. Measured on the Jefferson + Diggs deal in league
29: the set is identical (166 scored players before and after) but the **order
diverges from index 3 onward, with 23 of 166 players sitting at a different
index**. Those 23 players therefore draw from a different part of the random
stream in the "after" run than in the "before" run, so they do not experience the
same simulated seasons.

**Consequence:** the paired design cancels less noise than it should, which is
directly why the seed-to-seed sd measured above (0.0069–0.0139 at 600 runs) is as
large as it is, and therefore why the bar has to be as dull as 2.2pp.

**The fix is one line** — sort `roster` by `p.id` (or any trade-invariant key)
before building `weekData`, making the draw assignment identical in both halves
of the pair. It was **not applied here**, because this work was explicitly scoped
not to change `season-sim.js`'s existing behaviour and that change would shift
every title-odds number the app currently reports, including the cached
`/title-trades` board. It should be a deliberate, separately-verified change.

If it is made, `NOISE_SD_AT_REFERENCE_RUNS` should be **re-measured** — the bar
would get meaningfully tighter, and the run count could probably come back down.

## Known limitations

- **A single fixed seed.** The route uses `seed: 1` so a given deal's answer is
  reproducible across re-opens of the card. That is the right call for a UI, but
  it means the check sees one draw from a distribution whose sd is ~0.011 at 1,200
  runs. The bar is set to survive that, and the calibration table above is the
  evidence it does — but a deal whose true impact sits near the bar can land on
  either side of it depending on the seed.
- **The pairing bug above** is the main thing standing between this check and a
  substantially sharper one.
- **Calibrated on one league.** Three real deals plus three controls, one
  12-team ESPN redraft league. `NOISE_SD_AT_REFERENCE_RUNS` should be re-checked
  against a second league, and especially against a different team count — title
  odds in an 8-team league have a different baseline and probably a different
  noise scale.
- **The check is on my side's title odds only.** The counterparty's numbers are
  reported and go into the challenge prompt, but they do not fire the retry.
- **Not registered in `gridiron-model.js`.** The betting equivalent registers
  itself as `advisory`; this one does not yet, because that file was being edited
  concurrently. It should be added as **advisory** — the loop has never been
  measured against outcomes, and it may inform a verdict without owning one.

## Tests

24 tests in `test/trade-verify.test.js`: the verdict→stance vocabulary, the bar's
construction and its run-count rescaling, contradiction in all three stances,
both-sides reporting, the confirmed / revised / upheld / unverified paths, the
two-call cap (including a retry the simulation would like even less, and a retry
that returns nothing usable), the propose/simulate overlap ordering, error
containment on both the propose and simulate sides, and the real lopsided deal
above as a fixture with its measured numbers.

Suite: **940 tests, 939 pass, 0 fail, 1 skipped** (baseline before this work:
915 / 914 / 0 / 1; the extra test beyond this module's 24 arrived from
concurrent work on the draft lookahead). `npm run typecheck` and `npm run lint`
clean.
