# The start/sit decision curve, with every definition stated

The UI thread owns `lineup-brain.js` and asked two fair questions before
touching `TIE_THRESHOLD` / `CLEAR_THRESHOLD`. Both are answered here from a full
re-derivation rather than from the earlier prose, **and the re-derivation
corrects the table I put in `docs/spec/projection-range.md` §4.** Read this file,
not that section.

---

## 1. What was measured, exactly

**The objective is the point projection — the `week_points` analogue. Not
ceiling, not floor.** UI is right to have asked. `yhat` here is a conditional
median from an MAE-fit ridge, which is the same kind of quantity `week_points`
is. Nothing in this work grades a ceiling or floor objective, and
`lineup-brain.js` is correct to mark those uncalibrated. These numbers must not
be carried onto them.

Every other definition, stated because a win rate is meaningless without them:

- **A pair** is two different players with out-of-sample projections in the
  **same (season, week)**. Nothing is paired across weeks; a start/sit decision
  is always inside one week.
- **The margin** is `yhat_high − yhat_low`.
- **"The higher projection wins"** means that player scored **strictly more
  actual PPR**.
- **Exact ties in actual score** are counted separately and credited as half a
  win, because a tie is neither a right nor a wrong call. Tie rates are printed;
  they run 3.1% at the smallest margins in the all-pairs universe and under 0.7%
  among startable players.
- **Every pair is enumerated, not sampled**, so every `n` below is exact.

## 2. The correction to §4 of the range spec

The table in that section was built from a **sample of 43,200 pairs drawn from
the all-pairs universe**. Two things were wrong with using it to set a
threshold.

**It was a sample, and one bin was misleading.** The sampled 0.0-0.5 bin read
**48.4%**, which says the projection is *anti*-informative at small margins.
Full enumeration of the same universe (2,993,309 pairs) gives **51.4%**. The
projection is weakly informative there, not backwards. The substance of "that
band is a coin flip" survives; the striking sub-50% number does not, and it
should not be quoted.

**The universe was wrong for the question.** All-pairs includes comparisons
nobody makes — a 20-point WR1 against a 2-point WR5. A start/sit decision is
between two players you would actually consider starting. On the startable
universe the win rates are **materially lower**, and that is the universe a
threshold should be set on.

## 3. The curve, both universes

**ALL PAIRS** — 2,993,309 pairs, every projected player in the week.

| projected margin | n | higher wins | ties | mean actual margin |
|---|---|---|---|---|
| 0.0 – 0.5 | 199,023 | 51.4% | 3.1% | +0.24 |
| 0.5 – 1.0 | 198,225 | 54.1% | 3.0% | +0.73 |
| 1.0 – 1.5 | 193,449 | 56.3% | 2.9% | +1.18 |
| 1.5 – 2.5 | 368,277 | 60.5% | 2.6% | +1.96 |
| 2.5 – 4.0 | 494,076 | 66.3% | 2.1% | +3.19 |
| 4.0 – 6.0 | 540,607 | 73.3% | 1.4% | +4.98 |
| 6.0 – 9.0 | 559,500 | 81.4% | 0.9% | +7.51 |
| 9.0 + | 440,152 | 90.4% | 0.4% | +11.72 |

**STARTABLE PAIRS** — 656,705 pairs, both projections ≥ 8.0 PPR. **This is the
one to set thresholds on.**

| projected margin | n | higher wins | ties | mean actual margin |
|---|---|---|---|---|
| 0.0 – 0.5 | 72,373 | 51.0% | 0.6% | +0.24 |
| 0.5 – 1.0 | 68,121 | 53.0% | 0.5% | +0.76 |
| 1.0 – 1.5 | 62,436 | 54.9% | 0.5% | +1.30 |
| 1.5 – 2.5 | 109,944 | 58.4% | 0.5% | +2.16 |
| 2.5 – 4.0 | 130,491 | 63.3% | 0.4% | +3.54 |
| 4.0 – 6.0 | 116,327 | 68.8% | 0.3% | +5.27 |
| 6.0 – 9.0 | 73,285 | 75.0% | 0.3% | +7.55 |
| 9.0 + | 23,728 | 83.9% | 0.3% | +11.21 |

**A slot decision and a FLEX decision are the same problem.** Splitting the
startable universe by whether the two players share a position changes nothing
worth acting on — same position 51.1 / 55.0 / 63.4 / 69.1 / 75.3 / 84.0 against
cross position 50.9 / 54.8 / 63.3 / 68.6 / 74.8 / 83.9. **No slot-specific
threshold is warranted.**

## 4. What the current constants actually buy

A threshold is a *tail* question — "if I call everything above M clear, how
often am I right?" — not a bin question. On startable pairs:

| rule | n | win rate |
|---|---|---|
| below `TIE_THRESHOLD = 1.5` | 202,930 | **52.9%** |
| above 1.5 | 453,775 | 66.5% |
| above 2.5 | 343,831 | 69.1% |
| above `CLEAR_THRESHOLD = 4.0` | 213,340 | **72.6%** |
| above 6.0 | 97,013 | 77.2% |
| above 7.15 | 58,132 | **80.0%** |
| above 9.0 | 23,728 | 83.9% |

- **`TIE_THRESHOLD = 1.5` is well chosen and should stay.** 52.9% is a coin
  flip, correctly named.
- **`CLEAR_THRESHOLD = 4.0` buys 72.6%**, not 80%. My earlier "an 80% call needs
  about 6.0 points" came from the all-pairs universe and is wrong for this
  decision: **on startable pairs an 80% call needs ≈ 7.15 points.**

## 5. Why I think UI's own instinct beats moving the number

UI observed that at 6.085 MAE, "clear" at 6 points still means roughly 1 in 5
clear calls is wrong. That is right, and the data says something stronger:

**There is no band where a weekly start/sit call is near-certain.** Walking the
startable universe from the top, the win rate only reaches 85% above a margin of
9.57 and 90% above 12.71 — by which point there are 2,617 pairs left out of
656,705, four hundredths of a percent of the decisions anyone faces. A word like
"clear" promises something the projection cannot deliver at any threshold.

So: **showing the measured win rate beats relabelling, and relabelling beats
moving the constant.** "Higher projection wins about 73% of the time at this
margin" is a true sentence a user can act on. "Clear" is not.

If a word is kept, define it by win rate rather than points so the boundary
follows a measurement and can be refreshed when the model changes:
coin flip below 60%, lean 60-80%, clear at or above 80% — which on *this*
model's startable curve lands at about 2.5 and 7.15 points.

## 6. The caveat that applies to all of it

**This is my research baseline's projection, not production's `week_points`.**
Startable MAE here is 6.085; `lineup-brain.js:252-258` states its own judgement
as "five to six points for a starter", so they are close but not the same, and
production has `vegasLift` while this baseline has no opponent term at all
(`opp-adj-def-epa-wiring-audit.md`).

The win-rate curve is a property of the projection's error distribution, so a
better or worse projection moves the whole curve. **The boundaries above are not
constants of the game.** Before any constant in `lineup-brain.js` changes, the
curve should be re-derived on production's own out-of-sample `week_points` —
the same requirement §7 of the range spec puts on the band widths, and for the
same reason. The re-derivation is cheap: `pairs.py` needs only a list of
`{season, week, gsis, pos, yhat, y}`.

## The five questions

- **Well built?** It states every definition the earlier version left implicit,
  and it corrects that version rather than quietly replacing it.
- **Stats or made up?** Stats. 2,993,309 all pairs and 656,705 startable pairs,
  fully enumerated, over 25,323 out-of-sample predictions, 2018-2025.
- **How do we know?** Ties are counted rather than assumed away, the tail rates
  are reported on the universe a threshold actually applies to, and the
  same-position / cross-position split is shown so "it depends on the slot" can
  be ruled out rather than argued.
- **Pointed anywhere else on the platform?** `lineup-brain.js:328-329`, owned by
  the UI thread. No server file is changed by this document.
- **How does it unify?** It replaces two stated judgements with a measurement,
  and then says plainly that the measurement does not support the word the UI
  was going to attach the number to.
