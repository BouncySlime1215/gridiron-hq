# TELLS-01b: tells as named clone features, graded by E1, shown as a tells card

RED `4d4b7748` (test: TELLS-01b RED …) · GREEN `4f72e10d` (feat: TELLS-01b tells as named clone features …) · test fix `0e98cee5` · stacked on PR #246 (`claude/cloud-e1-fix-pvd8q8`, itself on #235).

`test/tells-clone-features.test.js` (14, new). RED run: the file fails to load
(`ERR_MODULE_NOT_FOUND` for `server/services/tells/clone-features.js`), so all 14 fail.
GREEN: 14 of 14. RED's first failure, quoted: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../server/services/tells/clone-features.js' imported from .../test/tells-clone-features.test.js`.

## Liveness: mutation sweep (on `0e98cee5`, `test/tells-clone-features.test.js` only)

| mutant | result |
|---|---|
| M1 reply_latency drops the as-of cut | killed (reply_latency, as-of safety) |
| M2 counter window unbounded | killed (counter_style) |
| M3 price ignores the capture date | killed (prior_accept_price) |
| M4 default shrink penalty removed | survived on `4f72e10d` (the 1.5 cap hid it); test fixed in `0e98cee5` to compare uncapped fits; killed |
| M5 call site: `cloneScores` trains on every offer, not only those resolved before | killed (walk-forward) |
| M6 chat_wants_player graded | killed (chat, fitWeights, card chat) |
| M7 flag bypassed in `card.js` | killed (flag) |
| M8 unknown card value served as 0 | killed (card) |
| control: COUNTER_SHRINK 3 -> 4 (designed survivor, no test pins the constant) | survived, as designed |
| control: pattern absent (designed not-applied) | not applied |

## Benchmarks (synthetic, scratch scripts, `4f72e10d`; 400 offers, 200 in the target league)

| world | clone E1 gain [95% CS] | production replay gain | runtime |
|---|---|---|---|
| no tell planted (p = 0.3) | -0.0037 [-0.148, +0.140] | -0.0084 | 0.36 s |
| latency planted as a per-team constant | +0.0045 [-0.140, +0.148] | -0.0060 | 0.34 s |
| price planted per offer (logit -0.8 + 2.5 x ratio) | +0.1467 [-0.008, +0.288] | -0.0179 | — |

A per-team constant is already inside the activity-only baseline (the responder's own shrunk accept rate),
so latency can only add what the baseline has not yet learned; the price tell varies per offer and is where
a clone can beat activity-only. All three stay `not_enough_data` at n = 200 under the anytime-valid rule.

## Nick's five questions

1. **Well built?** Pure functions over rows, one loader with typed absence (missing tables listed, not thrown),
   walk-forward by construction and pinned by tests plus 8 killed mutants. The route recomputes on every request
   (about 0.4 s at 400 offers), which is acceptable only behind the flag; the engine spine (#216) is not on main,
   so nothing is written to `engine_state` yet.
2. **Stats or made up?** The weights are fitted; the penalty (prior sd 0.5), the cap (1.5), MIN_TRAIN (20),
   the 72 h counter window and the shrink constants (3, 2) are hand-set guesses.
3. **How we know:** synthetic benchmarks above only. No real-offer number yet: the league-4 E1 grade needs the
   local DB and is requested by a `LOCAL:` line in the PR.
4. **Pointed anywhere else?** Only `GET /api/tells/:leagueId/card` and the Trade Brain card. A guard test pins that
   trade-acceptance.js, counterparty-pricing.js and trade-engine.js never import it; served P(accept) is unchanged.
5. **How it unifies:** it reuses E1's baseline (`activityBaseline`), priors (`priorCounts`), loader
   (`loadLeagueOffers`) and grader (`grade`) instead of a second grader, so the clone and today's band are
   graded on the same offers by the same rule.

- **Gap filled:** no per-manager tell entered any graded model (TELLS-01a's library covers adds/checkout on Sleeper
  only, `server/services/tells/library.js` on main `12a6de9`).
- **Incumbent:** `acceptanceBand` replayed as of each offer (`eval/e1-league.js#replayAsOf` on #246).
- **Not covered:** engine_state writes and the ENGINE-00b nightly registration (need #216/#242); the
  `prior_trades` factor in counterparty-pricing.js (needs #229 first); TELLS-01a's adds/checkout tells on the card.
- **What would make it wrong:** ESPN answer rows whose `proposed_at` is not the answer time (latency would be
  measured wrong); `dynasty_value_history` covering only recent weeks (the price tell is then missing on older
  offers and the clone falls back to activity-only on them).

## What was built

| piece | file |
|---|---|
| four named features, each as of an offer's proposal time | `server/services/tells/clone-features.js` `featuresAsOf` |
| walk-forward L2-penalised logistic fit on top of E1's activity-only baseline, weights capped at 1.5 | `fitWeights`, `cloneScores` |
| E1 grade of the clone and of today's replayed band on the same league offers | `gradeClone` (calls `eval/e1.js#grade`) |
| per-manager card: value, n, weight, direction, E1 evidence, reason chain | `tellsCard` |
| flagged response (`GRIDIRON_TELLS_CARD=1` or `previewUnconfirmed()`) | `server/services/tells/card.js`, `GET /api/tells/:leagueId/card` |
| Trade Brain card above the manager board, renders nothing when off | `client/src/components/brain/TellsCard.tsx` |
| read-only aggregate report for the local DB | `scripts/eval/tells-clone-e1.mjs` |

## What each test pins

| test | pins |
|---|---|
| reply_latency | responder median vs league median at the cut; under 2 replies is missing (0 in the model) |
| counter_style | a proposal back within 72 h of a decline counts, one after 72 h does not; a `countered` status counts |
| prior_accept_price | offer ratio minus accepted ratio shrunk by n/(n+2); a price captured after the proposal day is not used |
| chat_wants_player | graded:false, never in the fit; a mention after the offer is ignored; the reason says "not dated" |
| as-of safety | an offer resolved, or a proposal made, 1 s after the cut changes no feature |
| fitWeights | under 20 offers: zeros plus a reason; above: the penalty shrinks the weight, the cap holds |
| walk-forward | flipping the answers of later offers leaves every earlier p unchanged |
| gradeClone | E1-shaped rows, target league only; with no usable tell the clone equals activity-only (gain 0) |
| card | every entry has n, predicts, as_of and the E1 status; unknown is `value: null` with a reason |
| card chat | unproven, weight null, player names and n shown |
| loader | offers and proposal items read; absent value/chat/player tables are listed, not thrown |
| flag | off without the switch (no card in the body); on in preview mode, labelled a preview |
| guard | trade-acceptance.js, counterparty-pricing.js, trade-engine.js never import the tells files |
| guard | the tells files carry no league or manager names |
