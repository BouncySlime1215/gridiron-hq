# E1-FIX: league-wide offers, as-of scoring, anytime-valid judgement

RED `bad310f` · GREEN follows · stacked on PR #235 (`claude/cloud-eval-graders`).

`test/eval-e1-league.test.js` (11, new), `test/eval-graders.test.js` (E1/E2
small-n tests rewritten, one E2 sequential test added),
`test/brain-report-store.test.js` (E1 ledger test updated, league-wide DB test
added). RED run against #235's graders: 8 failing, 35 passing. GREEN: 59 of 59
across the eval and brain-report files.

## What changed

| before (#235) | after |
|---|---|
| E1 read only `app_proposed` rows (Nick's own offers) | every resolved offer in each ESPN league: `trade_outcomes` observed + app_proposed, unsettled `league_transactions_raw` proposals, `offer_log` |
| withdrawn offers: n/a | cancelled by the proposer (TRADE_PROPOSAL/CANCEL, no answer) excluded and counted |
| offers without a stored prediction: dropped | replayed through `acceptanceBand` fed only what was resolved before the offer was proposed (`basis: replay_anchor_only`) |
| baseline counted offers proposed earlier, even if answered later | baseline counts only offers RESOLVED before this one was proposed |
| fixed n = 50 (E1), n = 30 (E2), then a bootstrap CI | 95% anytime-valid confidence sequence (betting CS, Waudby-Smith & Ramdas 2024); readable at any n |
| per-offer slope, no pooling | pooled hierarchical calibration: population slope + per-manager random intercepts, tau by empirical Bayes |

## What each test pins

| test | pins |
|---|---|
| league offers from other managers count | 5 offers from 4 non-app proposers graded; withdrawn 1, unanswered 1 excluded |
| settled raw proposal counted once | `trade_outcomes` espn_tx_id dedups the raw read |
| ESPN copy of an app offer dropped | the app row with its recorded prediction wins |
| as-of scoring | later outcomes never change earlier scores; an offer answered after the proposal is not in its prior |
| overconfident model failing at small n | 95% said, ~20% accepted: failing at n = 24, CS upper < 0, e-value > 1/alpha |
| coin-flip difference not_enough_data | 0.5 +/- 0.02 vs truth 0.5, n = 400: CS covers 0 |
| no offers | needs the computed floor (10) offers, with the missing source named |
| CS validity | covers the mean, narrows with n; true null excluded on <= 4 of 40 runs |
| hierarchy | slope ~1 on honest p; a 3-offer manager shrunk toward 0; all-one-class -> null |
| only the anytime-valid rule fails E1 | inverted model at n = 12 warns on slope, not failing |
| E2 sequential | 95% accepted where 50% predicted: failing at 20 offers |

The "only the anytime-valid rule fails E1" test was added in the GREEN phase, after benchmarking showed the
slope interval would have flagged an inverted model at n = 9. Full `npm test`
on the GREEN tree: 4833 tests, 4791 pass, 0 fail.
