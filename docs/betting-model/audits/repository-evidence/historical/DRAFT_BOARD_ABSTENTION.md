# An abstention/confidence gate for the draft board — declined

**2026-09-07.** Ranked candidate #2 from `docs/BETTING_CAPABILITY_AUDIT.md`, ported
from `nfl-abstention-audit.js` + `confidence-tier.js` + `nfl-slice-diagnostic.js`.
Code: `server/services/draft-abstention-audit.js`. Tests:
`test/draft-abstention-audit.test.js` (18 tests, all passing). Baseline verified
before this work: 798 tests, 797 pass / 1 skip / 0 fail. After: 824 tests, 823 pass
/ 1 skip / 0 fail — this work accounts for 18 of the 26 new tests; the other 8
arrived from other work in flight the same day.

## Verdict

**The gate separates nothing. Do not ship it.** Zero of three held-out seasons
cleared the bar, at every gate strength tested. Wherever the point estimate had a
sign at all, it pointed the wrong way: the picks the gate flagged as thin
*out-performed* the picks it kept, in all three seasons, on the board's own hit
definition. This is the same inversion the betting side found and correctly
refused to ship (`NFL_MODEL_STATUS.md`: top-3-confidence picks 45.1%, z = -2.42,
against 51.0% for all games).

## The bar, stated before the numbers

The kept set's calibration/reliability is **significantly better than the declined
set's in ≥2 of 3 held-out seasons** (2023, 2024, 2025), 90% bootstrap interval
excluding zero, per the repo's standing rule. Kill condition, stated in advance:
declined performs no worse than kept.

## What was tested

**Panel.** `docs/DRAFT_AUDIT_2021_2025.md`'s real-outcomes panel, rebuilt through
`preseason-model.js`'s validated ECR→gsis join: 750 graded top-150 skill-position
slots, 150 per season, 2021–2025. The rebuild reproduces the audit's published
replacement levels **exactly** (QB11/RB27/WR27/TE8 = 2021 301/163/203/164; 2022
287/168/189/147; 2023 278/183/215/181; 2024 287/181/201/173; 2025 282/167/183/184),
which is the check that this is the same panel and not a lookalike.

**Gate inputs — coverage-side only, all known before Week 1.** Four flags, no
outcome-derived term anywhere (pinned by a test that flips every outcome field on
a pick and asserts the flags do not move):

1. `thin_history` — no prior-season usage on record, **or** rookie with no NFL
   snaps. Folded into one flag deliberately: they are near-collinear (a rookie has
   no prior usage by construction), and counting them separately would make a
   "two or more flags" rule mean "is a rookie" while looking broader.
2. `no_projection` — the in-house projection does not cover him
   (`has_projection = false`).
3. `wide_band` — his position × draft-tier `p20`/`p80` width exceeds the median
   cell width, both fitted on training seasons only.
4. `high_rank_std` — expert disagreement above the 75th percentile *within his
   position*, fitted on training seasons only (a pooled cut just flags every TE).

**DECLINE = "widen the disclaimer", never "hide the player."** Nothing here
touches `rankTargets`, the VORP math, or which players appear.

**Walk-forward.** For held-out season T, every threshold and every slot norm is
fitted on seasons strictly < T. `fitGate` is deterministic on a fixed training
set, which a test asserts.

**Outcome metric.** Realized VORP+ against the audit's own convention (points
minus the QB11/RB27/WR27/TE8 finisher, floored at zero), compared to the slot's
expectation (VORP+ of the player who actually *finished* at the drafted positional
rank). Per-pick reliability = `|realized − expected|`.

**The confound, and the fix.** Thin-coverage picks are overwhelmingly *late*
picks, and late slots sit at replacement, so their raw absolute error is small for
a purely structural reason. Comparing raw error would have reported "the gate
works" from nothing but draft position. Every headline below is therefore the
**slot-adjusted residual**: `|realized − expected|` minus the training seasons'
mean error for that overall-ECR band (`nfl-slice-diagnostic.js`'s
`MIN_SLICE_SAMPLE = 30` floor applies; thinner cells fall back to the global mean).

**Statistics.** `pairedBootstrapDiff` is used where it is valid — each set graded
against its own slot-norm benchmark, two forecasts of the same picks, clustered by
NFL team because teammates share one offense's volume. It is *not* valid for
kept-vs-declined (different players; nothing to pair), so that gap uses a cluster
two-sample bootstrap written to the same convention: 90% interval, significant only
when it excludes zero. Pooled across held-out seasons, the cluster is the season.

## The numbers

Primary gate, decline at ≥2 of 4 flags. `resid` = slot-adjusted error per pick
(lower = more reliable). `sep` = mean(declined resid) − mean(kept resid); **positive
would mean the gate works.**

| Season | kept n | kept hit | kept resid | decl n | decl hit | decl resid | sep | 90% CI | sig |
|---|---|---|---|---|---|---|---|---|---|
| 2023 | 113 | 34.5% | +2.34 | 37 | 37.8% | −3.75 | **−6.09** | [−12.14, +0.62] | no |
| 2024 | 127 | 37.0% | +0.56 | 23 | 56.5% | +8.38 | **+7.94** | [−2.12, +18.45] | no |
| 2025 | 107 | 38.3% | +2.56 | 43 | 46.5% | −1.15 | **−3.77** | [−10.61, +3.26] | no |
| pooled | 347 | 36.6% | +1.75 | 103 | 45.6% | +0.05 | −1.39 | [−5.20, +2.67] | no |

**0 of 3 seasons separating.** The interval straddles zero every time, and the
point estimate changes sign between seasons — the signature of noise, not of a
weak-but-real effect.

Neither arm beat its own slot norm either: kept vs slot-norm `pairedBootstrapDiff`
was +2.33 [−2.02, +6.98] in 2023, +2.65 [−2.47, +8.51] in 2025; declined was −3.81
[−7.35, +0.88] and −1.08 [−4.86, +3.35]. Nothing clears.

### Sensitivity — the result is not an artifact of the ≥2 threshold

| Gate | seasons separating | pooled kept hit | pooled decl hit | pooled hit-rate z (p) |
|---|---|---|---|---|
| ≥1 flag | 0 of 3 | 33.2% (n=178) | 42.3% (n=272) | −1.95 (0.052) |
| ≥2 flags | 0 of 3 | 36.6% (n=347) | 45.6% (n=103) | −1.65 (0.098) |
| ≥3 flags | 0 of 3 (**1 inverted**) | 37.9% (n=412) | 47.4% (n=38) | −1.15 (0.250) |

At ≥3 flags, 2023's separation is significant **and negative**: −9.24, CI90
[−13.75, −4.71]. The strictest gate is the one that most clearly picks the wrong
players.

### The inversion

The declined set hit more often than the kept set in **every** held-out season, at
**every** gate strength — nine of nine cells. The single most extreme case is 2024
at ≥1 flag: kept 29.5%, declined 47.2%, z = −2.17, p = 0.030 — nominally
significant in the direction opposite the hypothesis.

**Honest reading of that inversion.** It is partly structural and must not be
over-claimed. `docs/DRAFT_AUDIT_2021_2025.md` warns that hit rate in deep tiers is
inflated by construction (a player drafted RB40 "hits" whenever enough backs above
him bust), and the declined set skews late. That is exactly why hit rate is the
*secondary* number here and the slot-adjusted residual is the primary one. The
residual — which removes the draft-position effect — shows nothing in either
direction. So the defensible claim is the weaker one: **coverage-side thinness
does not identify picks that land further from their slot's expectation.** The
stronger claim ("thin picks are actually better") is suggested by the hit-rate
column and is not established.

### Per-flag, no single fact rescues it

No individual flag separated in a stable direction either. `wide_band` is the only
flag that ever clears the 30-pick read floor in more than one season (n=78 in both
2024 and 2025), and its slot-adjusted residual flips sign between them: +2.57 in
2024 (flagged picks worse) and −0.16 in 2025 (flagged picks better). `thin_history`
runs +15.66 in 2024 and −1.59 in 2025 on 13 and 16 picks — both below the read
floor, and reported only so the null cannot be attributed to having pooled a good
flag with bad ones.

## Why this is a real answer and not a failure to find one

The instrument works. It grades the road not taken, it reproduces the published
panel exactly, it refuses to read slices below 30, it reports the declined set's
own record alongside the kept set's, and its verdict string is a pure function of
the ≥2-of-3 rule — pinned by a test, so nobody can later relax the gate into a pass
without moving the bar in plain sight.

What the instrument found is that the draft board's coverage-side thinness is not
informative about which of its calls turn out to be coin flips. Every player in the
top 150 is substantially a coin flip: the panel's own pooled hit rate is under 40%
and round one busts 32% of the time regardless of position. The board is *already*
uniformly uncertain, and a gate can only separate what is actually separable.

## What this CAN and CANNOT say

- **CAN** — a coverage-side gate fitted walk-forward on 2021–2025 did not flag
  picks that landed further from their slot's expectation than the picks it kept,
  in any of three held-out seasons, at any of three gate strengths.
- **CANNOT** — say the board's presentation is well-calibrated. This tests one
  specific gate built from five specific facts. A different confidence signal
  (in-season role volatility, depth-chart contest, injury history) is untested and
  is not licensed or forbidden by this result.
- **CANNOT** — say that softening the board's tone on thin picks would be harmful.
  The result is that it would be *uninformative*, which is a reason not to spend
  the pixels, not evidence of damage.

## Not shipped

No `confidence` or `reliability` field was added to `evidenceHeadline` /
`evidenceLines`, and nothing was wired into `client/src/components/draft/`. The
proposal that would have followed a pass — a `reliability: 'standard' | 'thin'`
field on the evidence output, rendered as a `SourcePill`-style qualifier on
`EvidenceTable` rows — is recorded here and explicitly **not** recommended: a
badge that varies for reasons uncorrelated with outcome is worse than no badge,
because it spends the reader's trust on noise.

`server/services/draft-abstention-audit.js` is kept as an instrument, not as a
feature. It is not imported by any route or by `draft-assist.js`. Re-run it if the
panel grows a sixth season; the bar does not move.

## Related

- `docs/BETTING_CAPABILITY_AUDIT.md` — candidate #2, and the ranked list this came from.
- `server/services/nfl-abstention-audit.js` — the betting-side original, and the CAN/CANNOT framing.
- `docs/DRAFT_AUDIT_2021_2025.md` — the panel, its join, and its validation (r=0.9987 vs ESPN).
- `server/services/backtest-significance.js` — `pairedBootstrapDiff` and the clustering rationale.
