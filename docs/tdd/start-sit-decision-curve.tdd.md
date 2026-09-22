# The start/sit confidence label, measured instead of judged

RED `ef50607` · GREEN `b30cb86` · branch `claude/project-thread-xiezr0-data-freshness`
off `origin/main 654ff93`.

## 1. The defect

`lineup-brain.js` labelled every start/sit call `coin flip`, `lean` or `clear`
from two constants, and said in its own comment that they were guesses:

> This is not fitted — it is a judgement, stated here in one place so it can be
> argued with rather than buried inside a comparison.

It was argued with. Model evidence audit enumerated the curve in
`docs/evidence/2026-09-22/start-sit-decision-curve.md` (their branch,
`origin/claude/project-thread-w0gpjt` at `c58c20e`). On the startable universe —
656,705 same-week pairs with both projections at least 8.0 PPR, fully
enumerated over 25,323 out-of-sample predictions, 2018-2025 — the tail rates
are:

| margin at least | pairs | higher projection wins |
|---|---|---|
| 1.5 | 453,775 | 66.5% |
| 2.5 | 343,831 | 69.1% |
| 4.0 | 213,340 | **72.6%** |
| 6.0 | 97,013 | 77.2% |
| 7.15 | 58,132 | **80.0%** |
| 9.0 | 23,728 | 83.9% |
| 9.57 | not published | 85% |
| 12.71 | 2,617 | 90% |

So `CLEAR_THRESHOLD = 4.0` bought 72.6%, and the page rendered those calls as
"N points ahead of him, comfortably". Better than one in four of them was
wrong.

The larger finding is that no constant repairs that. 90% needs a 12.71-point
margin, which is 2,617 of 656,705 pairs — four hundredths of a percent of the
decisions anyone faces. **There is no band where a weekly start/sit call is
near-certain**, so any word strong enough to mean "certain" overclaims at every
threshold a real lineup reaches.

`TIE_THRESHOLD = 1.5` was examined and left alone. The band below it measures
52.9%, which is the coin flip the label already claims.

## 2. A definition this nearly got wrong

The table above holds **tail** rates — "of the calls whose margin was at least
M, this share won". The first draft of the test read the 52.9% figure as the
rate *at* 1.5 and asserted `decisionWinRate(1.5) === 0.529`. It is the rate
*within the band below* 1.5; the tail rate at 1.5 is 66.5%. The draft was
corrected against the evidence file before the RED commit, and both quantities
are now carried under names that cannot be swapped: `DECISION_CURVE.points`
(tail) and `TIE_BAND_WIN_RATE` (band).

## 3. The fix

- `DECISION_CURVE` — the eight measured anchors, each with the pair count
  behind it, plus `source`, `universe` and `measured_on`. `n: null` where the
  source publishes a rate without a count: not published, not zero.
- `decisionWinRate(margin)` — the rate of the largest anchor at or below the
  margin. Never interpolated between anchors, never extrapolated past the last
  one, and `null` below the smallest, so a margin nobody measured gets no
  number rather than an invented one.
- `CLEAR_THRESHOLD` is **derived**, not typed in: the smallest anchor whose tail
  rate reaches `CLEAR_WIN_RATE = 0.80`, which on this curve is 7.15. Stating the
  boundary as a rate is the point — re-derive the curve on a better projection
  and the threshold moves with it instead of leaving a stale constant behind a
  strong word.
- Every call carries `confidence_win_rate`, and the sentence the page already
  renders (`Lineup.tsx:301`) says it out loud: "5 points ahead of him. At a gap
  this size the higher projection has won about 72.6% of the time." The word
  "comfortably" is gone.
- `confidence_curve` on the payload carries the provenance to the client, since
  `JSON.stringify` drops properties hung off an array — which is why the curve
  is an object with a `points` array rather than an array with attributes.

## 4. What changed on screen

A 5.0-point margin, the case pinned by the fixture:

| | before | after |
|---|---|---|
| label | `clear` | `lean` |
| sentence | "5 points ahead of Quarterback Two, comfortably." | "5 points ahead of Quarterback Two. At a gap this size the higher projection has won about 72.6% of the time." |
| `confidence_win_rate` | absent | `0.726` |

## 5. Mutation sweep

Sweep run on `b30cb86`. Hashes are the first 12 of the file's SHA-256, recorded before the edit, after it, and again after the restore.

| # | mutation | aimed at | hash before → after | pass/fail | outcome |
|---|---|---|---|---|---|
| 1 | M1 the lookup interpolates up to the next anchor instead of flooring | T1 no interpolation | `2a12811e7a31` → `0b3b689d07b7` | 7/5 | **killed** by "the reported rate is a measured anchor, never an interpolation"; "a margin below the smallest measured anchor has no rate rather than a made-up one"; "a four-point margin no longer earns the strongest label"; "the coin-flip threshold is left where the measurement supports it"; "a five-point margin is a lean carrying its measured rate, not a comfortable clear" |
| 2 | M2 a margin past the last anchor is extrapolated | T2 no extrapolation | `2a12811e7a31` → `78a4874e00a1` | 11/1 | **killed** by "nothing is extrapolated past the largest measured margin" |
| 3 | M3 a margin below the smallest anchor gets an invented rate | T3 null below the curve | `2a12811e7a31` → `d2ed840862c0` | 11/1 | **killed** by "a margin below the smallest measured anchor has no rate rather than a made-up one" |
| 4 | M4 an anchor dips, so the reported rate falls as the margin grows | T4 monotone, T5 curve rising | `2a12811e7a31` → `e3a044ee64cb` | 10/2 | **killed** by "the reported rate never decreases as the margin grows"; "the curve itself is ordered and rising, so a lookup down it is meaningful" |
| 5 | M5 an anchor is out of order, so the lookup walks a jumbled curve | T5 curve ordered | `2a12811e7a31` → `2c18a8d90031` | 11/1 | **killed** by "the curve itself is ordered and rising, so a lookup down it is meaningful" |
| 6 | M6 the clear threshold is typed in at 4.0 again instead of derived | T6 threshold on an anchor, T7 4.0 is not clear, T10 a 5.0 margin | `2a12811e7a31` → `1c97af59b877` | 9/3 | **killed** by "the clear threshold sits on a measured anchor, not a judgement"; "a four-point margin no longer earns the strongest label"; "a five-point margin is a lean carrying its measured rate, not a comfortable clear" |
| 7 | M7 the tie band carries a rate it did not measure | T8 coin-flip band | `2a12811e7a31` → `fcc1ae2a68c0` | 11/1 | **killed** by "the coin-flip threshold is left where the measurement supports it" |
| 8 | M8 the tie threshold moves off the point the evidence endorsed | T8 coin-flip threshold | `2a12811e7a31` → `5aa3168cdbd7` | 11/1 | **killed** by "the coin-flip threshold is left where the measurement supports it" |
| 9 | M9 the curve stops naming the universe it is valid for | T9 provenance | `2a12811e7a31` → `5f54533cbe27` | 10/2 | **killed** by "every curve point carries the universe it was measured on"; "the payload says which curve the rates came from" |
| 10 | M10 the curve stops saying which projection it was measured on | T9 provenance | `2a12811e7a31` → `0eb210fe1051` | 11/1 | **killed** by "every curve point carries the universe it was measured on" |
| 11 | M11 the call stops carrying the rate its margin measured | T10 the rate on a call | `2a12811e7a31` → `ec4d94ec0051` | 11/1 | **killed** by "a five-point margin is a lean carrying its measured rate, not a comfortable clear" |
| 12 | M12 the sentence claims comfort again | T11 no comfort at any margin | `2a12811e7a31` → `ff43538de4da` | 11/1 | **killed** by "no call describes itself as comfortable, at any margin" |
| 13 | M13 the payload stops naming the curve the rates came from | T12 provenance on the wire | `2a12811e7a31` → `0d6edf84ab81` | 11/1 | **killed** by "the payload says which curve the rates came from" |
| 14 | C1 NO-OP: a multi-site anchor must be refused, not mutated | the runner itself — designed NOT APPLIED | `2a12811e7a31` → `2a12811e7a31` | — | **NOT APPLIED** (anchor x2) — as designed |
| 15 | C2 NO-OP: a comment-only edit changes no behaviour and must survive | the suite itself — designed SURVIVING | `2a12811e7a31` → `a24397d15fb4` | 12/0 | **SURVIVED** — as designed |

All 12 tests appear in a `killed_by` list, so none of them is decorative. Every
applied row's hash moved and every row restored to its before-hash.

The two controls are designed outcomes, not luck. **C1** uses an anchor that
matches twice (`DECISION_CURVE.points`) and must come back NOT APPLIED — the
runner refuses a multi-site anchor rather than mutating whichever site comes
first, which is the failure mode that makes a real mutation read as a no-op.
**C2** edits a comment, applies, moves the hash and must survive, which is what
proves a kill elsewhere came from behaviour rather than from the suite being
broken.

## 6. The full check

`npm run check` (typecheck, lint, suite, build, start:smoke) on GREEN `b30cb86`:

- **exit 0**
- **3031 tests, 2990 pass, 0 fail, 41 skipped**
- `git write-tree` `595d89fffeabfe9a6c3a6b7bf79fa0fab6208b3b` before and after the
  run — identical, so nothing the run did changed the tree it measured.
- `node_modules` mtime `1789853354` before and after.
- State: **source-isolated** — own source tree, `node_modules` symlinked to
  `/home/user/gridiron-hq/node_modules`.

The eight lineup files that consume these labels
(`decision-inbox`, `lineup-floor-objective`, `lineup-evidence`,
`decision-leftovers-lineup`, `lineup-surfaces-agree`,
`availability-honest-degradation`, `availability-fit-loader`,
`eval-lineup-objectives`) were also run alone: 68 tests, 68 pass, 0 fail.

## 7. What this does not settle

- **The curve is not production's.** It was measured on a research baseline
  whose startable MAE is 6.085; production has a betting-line lift the baseline
  has no term for. `lineup-brain.js` states its own error as "five to six points
  for a starter", so they are close, not equal. The curve is a property of a
  projection's error distribution, so a better or worse projection moves all of
  it. This caveat is carried in `DECISION_CURVE.measured_on` rather than left in
  a document, and re-deriving on production's own out-of-sample `week_points`
  is the next real step. The derivation needs only a list of
  `{season, week, gsis, pos, yhat, y}`.
- **Ceiling and floor objectives are still uncalibrated**, and now doubly so:
  `confidence_basis` already said the labels were not calibrated for them, and
  the win rates are not either. Nothing in this change grades a ceiling or a
  floor.
- **The `lean` band is not bounded below by a measurement.** 1.5 stands on the
  band rate below it, not on a derived rate, because the 60% boundary the
  evidence suggests reads differently under tail and band semantics. It is the
  one constant here still standing on a judgement, and it is flagged as such in
  the code.
- **No slot-specific threshold.** Same-position and cross-position pairs behave
  the same (51.1/55.0/63.4/69.1/75.3/84.0 against 50.9/54.8/63.3/68.6/74.8/83.9),
  so one threshold covers a slot decision and a FLEX decision alike.

## The five questions

- **Well built?** The boundary is derived from data rather than typed in, the
  lookup cannot interpolate or extrapolate by construction, and the two kinds of
  rate are named so they cannot be read for each other — the mistake this file
  documents having made.
- **Stats or made up?** Stats. 656,705 fully enumerated pairs over 25,323
  out-of-sample predictions. What is *not* measured is labelled: `n: null` where
  a count was not published, `null` from `decisionWinRate` below the smallest
  anchor, and `measured_on` naming the projection the curve is not.
- **How do we know?** 15 mutations, every one of the 12 tests killed by at
  least one, two controls with designed outcomes, hashes recorded either side of
  every edit and every row restored. Full check exit 0 with the tree hash
  identical before and after.
- **Pointed anywhere else on the platform?** `Lineup.tsx:301` prints the
  sentence, so the rate reaches the user with no client change;
  `Lineup.tsx:265` and `WaiverWire.tsx:288` key on the band names, which are
  unchanged deliberately. `confidence_win_rate` and `confidence_curve` are
  served and not yet read as fields — a page that wants to show the number
  apart from the prose now can.
- **How does it unify?** It replaces a stated judgement with a measurement, and
  then says plainly that the measurement does not support the word the label was
  carrying — the same move as the freshness registry, where "did the sync run"
  was replaced by "is the data current".
