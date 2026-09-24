# JEV-01b (chat): pre-registration for grading `jev_chat_signals`

Committed before any grade is computed. The results file for this prereg is
`jev-01b-chat-results.md` in this directory, written from the output of
`node scripts/jev-grade-report.mjs`. Nothing here may change after the first
graded run except by an `-addendum-N` file.

## What is graded

Jev labelled every league-chat message with a probability per question
(`jev_chat_signals`: msg x question x probability). Two questions have an
outcome the app records later, without a person reading the chat:

| question | unit | claim | outcome (y = 1) | incumbent |
|---|---|---|---|---|
| `open_to_trade` | manager x weekly cutoff `t` | the highest `open_to_trade` probability on his messages in `[t - 7d, t)`; no message, no unit | his team proposes a trade (`TRADE_PROPOSAL`/`EXECUTE`, `proposed_at`) or is a party to a processed trade (`TRADE_ACCEPT`/`PROCESS`/`EXECUTED`, `processed_at`) in `(t, t + 14d]` | Poisson rate of those events for his team before `t`, shrunk to the league rate with 28 prior days: P = 1 - exp(-14 lambda) |
| `own_roster.untouchable` | one message naming a player the speaker owned at `t` | that message's `own_roster.untouchable` probability | the player is **not** moved off his roster (a DROP or TRADE item from his team, executed) in `(t, t + 14d]` | per-player-day move-off rate for his team before `t`, shrunk to the league rate with 28 prior days, roster size 16: P = exp(-14 mu) |

Weekly cutoffs start at the first recorded transaction in the league-season
(the start of transaction coverage) and step by 7 days. Ownership at `t` is
the player's last roster event before `t` (add = on, move-off = off), or, with
no event before `t`, any `league_roster_snapshots` row for that team. The
speaker is joined to a roster only through a trusted `league_member_identity`
row. Messages from `ME` are excluded, as in bluff-detector.js.

## Leak rules

1. A unit is graded only once its window has closed: `t + 14d <= as_of`.
2. A unit is graded only if its window lies inside transaction coverage:
   `t >= coverage start`.
3. The claim reads only messages stamped before `t`; the outcome reads only
   transactions stamped in `(t, t + 14d]`; the incumbent reads only
   transactions stamped before `t`.

## Fit

- Split by time: the earliest 70% of units fit the calibration map and the
  weight; the latest 30% score them.
- Calibration per question: isotonic (pool-adjacent-violators, linear between
  block centres) at n >= 200 training units; Platt (logistic on the logit,
  small ridge) below.
- Blend per question: `logit(p) = logit(incumbent) + w (logit(cal jev) - logit(incumbent))`,
  one weight `w` in [0, 1] minimising log loss on the training units. `w = 0`
  returns the incumbent exactly.
- Served map and weight are refit on every graded unit.

## Floors (typed unknown below them, never a number)

- n >= 60 graded units, with >= 10 of each outcome, and >= 20 in the holdout.
  Below that the question reports `{ status: 'unknown', reason: 'thin' }` with
  its n and the floor, and no manager row is written for it.

## Decision rule on the holdout

- Primary metric: mean log loss, blend minus incumbent. 90% interval from a
  manager-clustered bootstrap (500 resamples, fixed seed).
- `w <= 0.05`: "incumbent leads" (Jev carries no weight).
- Otherwise the interval's upper end below 0: "Jev leads"; lower end above 0:
  "incumbent leads"; else "undecided".

## Serving

Behind `GRIDIRON_JEV_CHAT_BLEND=1` (default off). With it on, a measured
question writes one `manager_signals` row per chat-identified manager —
`jev_p_trade_14d` and `jev_p_declaration_holds` — under source `jev_blend`,
declared `priceable: false`: shadow context, never a price input, until a
later unit decides otherwise on this grade.

## Prior expectation, stated before looking

r17 (a frozen, draft-fed Jev persona) ranked 2026 trade proposers at AUC
0.47/0.44 against activity count 0.78/0.91. The expectation here is that the
incumbent leads on `open_to_trade`. Transaction capture began 2026-09-17
(ESPN's feed also returns the season's earlier rows), and the 2026 season is
three weeks old, so every question is expected to report `thin` on the first
run.

Forward-only on the 2026 season. 2025 is never opened.
