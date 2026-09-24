# JEV-01b (chat): grade, calibrate and blend Jev's chat labels

<!-- prereg: docs/evidence/2026-09-24/jev-01b-chat-preregistration.md -->

RED `67abbb23` · GREEN follows · `test/jev-01b-calibrate.test.js` (9 cases),
`test/jev-01b-chat-grader.test.js` (6 cases).
Pre-registration `2b15b18b`, committed before the tests; addendum 1 before any
real-data run.

## What was missing

`jev_chat_signals` (Jev's per-message probabilities) fed manager rollups,
bluff-detector.js and person variables at face value. Nothing ever checked a
claimed probability against what the manager did next, so a 0.9 meant
whatever Jev meant by it.

## What this adds

- `server/services/jev/calibrate.js`: isotonic (PAV) at n >= 200, Platt below.
- `server/services/jev/stack.js`: one weight `w` in [0, 1] on the logit gap
  between calibrated Jev and the incumbent; `w = 0` returns the incumbent
  exactly; a manager-clustered bootstrap for the 90% interval.
- `server/services/jev/chat-grader.js`: builds the units for `open_to_trade`
  (manager x weekly cutoff -> trade activity in 14 days) and
  `own_roster.untouchable` (declaration -> player still his in 14 days) from
  the chat DB, `league_member_identity`, `league_transactions_raw` and
  `league_roster_snapshots`; grades each question under the pre-registered rules.
- `manager-signals.js`: behind `GRIDIRON_JEV_CHAT_BLEND=1`, a measured question
  writes `jev_p_trade_14d` / `jev_p_declaration_holds` under a new source
  `jev_blend`, declared `priceable: false` (context only).
- `scripts/jev-grade-report.mjs`: aggregates-only report for the local run.

## RED

Both files failed on `ERR_MODULE_NOT_FOUND` for the three new modules, and on
nothing else.

## On the way to GREEN

Three implementation defects, each fixed in the implementation and each now
pinned by a test that fails on the unfixed code:

1. **Platt diverged on a constant claim.** An arm that always says 0.9 mapped
   to 0.9999, not 0.3: undamped Newton from `a = 1` on an uncentred logit.
   Fix: centre the logit.
2. **Platt was fitted on the clamped log loss.** The clamp puts a kink in the
   objective, and Newton (smooth gradient) stalled short of the minimum:
   a = 2.08 against 2.63 on separable claims. Fix: fit the smooth logistic
   loss; clamp only when a map is applied. Liveness: the new test
   "Platt lands on the minimum..." run against the committed calibrate.js
   fails `not a minimum along (0.01, 0)`.
   Removing the step damping after that fix exposed a third case: plain
   Newton did not converge on 168 uninformative claims. The fit now throws
   when it does not converge, and it damps.
3. **Weight fitted on in-sample calibration** paid a noise arm weight it had
   not earned (0.110 vs 0.007 out-of-fold on the n=300 seed-6 fixture).
   Fix: fit the weight out-of-fold (pre-registration addendum 1).

Three corrections to the tests. Each test was wrong, not the code:

1. The leak case expected cutoff 6 to ignore a message stamped one hour after
   cutoff 5. That message is inside cutoff 6's lookback `[t - 7d, t)` by the
   pre-registered rule, so cutoff 6's claim is 0.99. What the case checks is
   that cutoff 5 does not see it, and cutoff 5 does not.
2. The worse-arm case also asserted `fitWeight` on **raw, uncalibrated** noise
   claims <= 0.05 (0.068 measured). That is not the spec's item 3, which is
   about the graded weight. The line was removed.
3. The worse-arm fixture drew outcomes at random, so the sample rates drifted
   from the incumbent's 0.15 / 0.75, and shrinking toward the middle genuinely
   lowered log loss (served weight 0.107). That is correct behaviour on that
   data, and the fixture did not test the claim. Outcomes are now fixed by
   construction (3 in 20, 3 in 4), so the incumbent is exactly right.

Two tests were added because the sweep found them missing: `ME` as a
roster-5 identity (M6 survived without it), and the negative-class floor
(M5 survived).

## Mutation sweep (final tree)

Each mutant applied alone and the two JEV test files run; "killed" = at least
one failure.

| id | mutant | result |
|---|---|---|
| M1 | outcome window reaches before the cutoff | killed |
| M2 | claim reads messages after the cutoff | killed |
| M3 | unsettled windows graded | killed |
| M4 | ownership at the message ignored | killed |
| M5 | negative-class floor dropped | killed |
| M6 | `ME` graded | killed |
| M7 | flag always on (unit) | killed |
| M8 | flag ignored at the call site (manager-signals.js) | killed |
| M9 | `jev_blend` declared priceable | killed |
| M10 | weight-0 shortcut removed | killed |
| M11 | weight floor ignored in the leader rule | killed |
| M12 | isotonic below n=200 | killed |
| M13 | Platt undamped | killed |
| M14 | Platt ridge 0 | killed |
| M17 | weight fitted on in-sample calibration | killed |
| M18 | Platt fitted on the clamped loss | killed |
| M16 | Platt non-convergence returned instead of thrown | **survived**: no fixture makes damped Newton fail to converge; the throw is a guard |
| C1 | control: "Jev leads" text precision 4 -> 5 digits | survived, as designed |
| C2 | control: pattern absent from the file | not applied, as designed |

## GREEN

15 of 15. `npm run check` result is in the PR body.

## Not covered

- No real-data grade yet. The report runs on the local DB copy (`LOCAL:` line
  in the PR); the pre-registration expects `thin` on every question this week.
- Ownership before the first roster event falls back to "ever in a snapshot",
  the same looseness bluff-detector.js documents.
