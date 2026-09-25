# CLONE v2 challenger (batch D rebase of #288)

ONE-PLAN night 9: "Rebase #288 CLONE v2 (flag off; logged `p_yes_challenger`; VETO-01 inside it
stays `fitted:false`)". Batch D item 4b: "a LIVE-BLEND challenger arm only".

## Pre-registration

- **Metric 1 (served invariance).** With `GRIDIRON_CLONE_V2` unset, set to anything but `1`, or with
  only `GRIDIRON_PREVIEW_UNCONFIRMED=1`, the finder's acceptance and cache key are byte-identical to
  main. With it `1`, the served acceptance (band, basis, `p_gate`, blend weights) is byte-identical
  and one extra key, `p_yes_challenger`, rides beside it.
  - Pass: S1, S2, S3 and B10 green. Fail: any served field differs, or preview mode switches it on.
- **Metric 2 (the clone model is #288's).** B1, B1b, B1c, B1d, B3, B8, B8b, B9 (unchanged from
  #288) and S4 (P(complete) = P(accept) x (1 - P(veto)), inert with a reason when the league states
  no `vetoVotesRequired`).
- **Metric 3 (the fits ledger).** B6, B6b, B7, B13: `manager_clone_fits` (migration 111) is
  rewritten whole and idempotently by `settleOfferLoop`.
- **Metric 4 (graders run).** B14 (E1 grade on raw terms) and B16 (Arm 1).
- **Promotion is NOT decided here.** The clone becomes a LIVE-BLEND arm only if E1's forward-only
  grade clears its bar (#288's: 90% CI lower bound > 0 vs activity-only; ONE-PLAN night 13: the
  anytime-valid CS > 0 at ~50 settled 2026 offers). #288's last numbers: Arm 2 n = 37, -0.0150
  [-0.0488, +0.0151] (undecided, worse in direction); Arm 1 primary +0.0499 [+0.0464, +0.0533].

## Record

- RED `57f16ce8`: `test/clone-v2-challenger.test.js` against main's source, 0 of 19 pass (19 fail:
  missing exports, table and scripts).
- GREEN `16995a82`: 19 of 19 pass.

## What changed from #288, and why

| #288 | here | why |
|---|---|---|
| `clone` factor inside `acceptanceBand` (cap 0.30) | removed; `challengerOf` builds a separate block | the band is LIVE-BLEND's `clone` arm; moving it would move the served P(yes) |
| `clone` valuation source in `counterparty-pricing.js` | not carried | it moves `perception_delta`, so ranking and packages |
| veto `completion` on the band | on the challenger block only | shadow |
| `cloneMode` honours preview mode | own flag only | batch D rule |
| `trade_outcomes.pitch_json` + `/offers/pitch-arms` | not carried | logging-only, separate unit; keeps this PR small |
| TradeCard follow-up chip | not carried | Trades client files are frozen for the coordinator's cleanup |
| terms from `trade_proposal_snapshots` first | raw rows only | the table (#247) is not on main; the wiring gate blocks a read with no writer |
| migration 096 | 111 | 106-110 are taken by open batch-D PRs |
