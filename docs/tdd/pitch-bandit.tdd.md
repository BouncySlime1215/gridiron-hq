# M5 pitch bandit — TDD record

Unit M5 (IDEA-037, NORTH-STAR-PLAN row 25, PEOPLE-WIRING step 5): a
Thompson-sampling bandit over message framings, per manager, learning from the
CLONE-01b b1 offer loop (#239, which this branch is based on).

## What it is

- **Arms:** `need_first`, `fairness_first`, `urgency_first`, `face_safe_short`.
- **Prior:** Beta per arm, hand-set base mean 0.30, raised to 0.45 for an arm
  whose keywords appear in the manager's `how_to_approach`. Strength: 4
  pseudo-offers. Arms named in `what_shuts_him_down` are vetoed.
  `face_safe_short` is never vetoed. `fitted: false` on every prior.
- **Update:** every sent offer whose linked choice has settled.
  accepted = 1, countered = 0.5, declined / expired / ignored = 0. Pending
  offers and choices that were never sent count for nothing.
- **Capped exploration:** only arms whose posterior mean is at least
  `max(0.10, 0.5 × best mean)` are sampled. If no arm clears that floor, the
  best mean is played and the reason text says so.
- **Log:** `pitch_choices` (migration 085) stores the arm, samples, posterior,
  eligible arms, floor, reason and prior basis. "I sent this" links the choice
  to the `trade_outcomes` row, at most one choice per offer.
- **Callers:** `pitchFor` is the single call the campaign producer (#233)
  makes per step message. `POST /api/trades/:leagueId/pitch` is the app-side
  call site until then.

## Gates (pre-registered in test/pitch-bandit.test.js)

| Gate | Claim |
|---|---|
| P1 | how_to_approach keywords raise that arm's prior; no profile gives a flat prior, and the basis text says which |
| P2 | a veto in what_shuts_him_down means that arm is chosen 0 times in 200 draws |
| P3 | only settled, sent, linked offers count; countered counts half; pending and unsent choices count nothing |
| P4 | an arm leading 6/6 is chosen in more than 160 of 200 draws; with flat priors each arm is chosen more than 40 times in 400 |
| P5 | an arm below the floor is chosen 0 times in 500 draws; when every arm is below it, the best mean is played |
| P6 | every choice writes one row; "I sent this" links the latest unlinked choice or the one named; a second tap does not relink |
| P7 | one manager's outcomes never move another manager's posterior |
| P8 | `frameMessage` keeps the ask, adds no number that was not in the engine text, and face-safe drops the need line and every fact |
| P9 | migration 085 adds one table, leaves `trade_outcomes` without `pitch_json` (that column belongs to b2), and allows one choice per offer |
| P10 | `pitchFor` logs, frames and returns the choice id that "I sent this" links |
| R1, R2 | route cases: `/offers/sent` honours a named `pitch_choice_id`; `/pitch` logs against the deal and gets linked |

## Record

- **RED** `ddf833f5`: 0 of 9 pass, with `ERR_MODULE_NOT_FOUND` on
  `server/services/pitch-bandit.js`.
- **Fixture correction before GREEN:** the RED fixture called `recordSentOffer`
  without `model_version`, and with a band in the wrong shape
  (`{low, high}` rather than `{band: {low, mid, high}, basis}`). The writer's
  refusals were correct, so the test was changed, not the writer.
- **GREEN** `c3fc6d49` ("feat: M5 pitch bandit — Thompson sampling over framing arms per manager, logged with the offer (GREEN)"): P1–P10 pass 10/10, and the route file passes 9/9.
- **Added after GREEN:** P10 and the two route cases, which came with
  `pitchFor` and the `/pitch` route. Those were written in response to the
  wiring gate (`module-only-tested`), not test-first. Mutant M11 below shows
  the route case bites.

## Mutation sweep (test/pitch-bandit.test.js unless noted)

| Id | Mutant | Result |
|---|---|---|
| M1 | countered reward 0.5 → 1 | killed (P3) |
| M2 | FLOOR_ABS 0.10 → 0 | killed (P5) |
| M3 | vetoes ignored | killed (P2) |
| M4 | link the oldest unlinked choice, not the latest | killed (P6) |
| M5 | posterior not filtered by manager | killed (P5, P7) |
| M6 | face-safe keeps the need line | killed (P8) |
| M7 | how_to_approach hits ignored | killed (P1) |
| M8 | pending status counted | killed (P3 + 1) |
| M9 | floor not applied | killed (P5 + 1) |
| M10 | `recordSentOffer` never links | killed (5 fail) |
| M11 | route drops `pitch_choice_id` (route test) | killed (1 fail) |
| C1 | FLOOR_REL 0.5 → 0.45 (control) | survives, as designed: no fixture sits between the two |
| C2 | a search string absent from the file (control) | not applied, as designed |

## Full guard run

`npm run check` exited 0 on tree `383e6cc8` (head `84bef7d3`). That head is
GREEN merged with origin/main `12a6de93`. Tests: 4841, pass 4799, fail 0,
skipped 42. Typecheck, lint, `check:wiring`, build and start:smoke all
exited 0. The tree was the same before and after the run, and the worktree
stayed clean.

## Nick's five questions

1. **Well built?** It is one service, `server/services/pitch-bandit.js`, plus
   one additive table (migration 085) and a four-line link in
   `recordSentOffer`. The route sends nothing to ESPN.
2. **Stats or made up?** The mechanism is standard Thompson sampling on Beta
   posteriors. The numbers are made up (hand-set): base 0.30, boost 0.45,
   strength 4, floors 0.10 / 0.5×, reward 0.5 for a counter.
3. **How we know:** only fixtures and a mutation sweep. There is no backtest
   and no real data: `trade_outcomes` has 0 real sent rows, so every
   posterior today is its prior.
4. **Pointed anywhere else?** It reads the negotiation profiles through
   `negotiationProfilesFor` (counterparty-pricing.js) and writes
   `pitch_choices`. `recordSentOffer` links the two tables. JEV-01b's
   `pitch_framing` grader can read the same arms.
5. **How it unifies:** there is one offer ledger (`trade_outcomes`) and one
   choice log keyed to it. The producer (#233) calls `pitchFor` and the page
   posts `pitch_choice_id` back. Nothing else stores a pitch arm.
