# BANDIT-01 — pitch bandit scaffold (IDEA-037, people-model M5)

RED `f0a647b5` (test: RED for BANDIT-01) · GREEN: the next commit ·
`test/pitch-bandit.test.js` 10 cases + `test/pitch-bandit-route.test.js` 2 cases.
Branched from #239 (CLONE-01b b1 offer loop) because `trade_outcomes.sent_at`
exists only there (migration 080); origin/main `21c9da4` merged in.

## What it is

Thompson sampling over four message framings — `need_based`, `value_based`,
`face_saving`, `urgency` — per manager. The evidence is a `trade_outcomes` row
that Nick sent (`sent_at`), that carries an arm (`pitch_json`, migration 087),
and that ESPN has answered (settled by #239's `settleOfferLoop`).

- **Reward:** accepted 1, declined 0, expired 0 (silence is a no), countered
  `COUNTER_REWARD` = 0.5. The 0.5 is a pre-registered guess, not a fitted value.
- **Shared prior:** Beta(1, 1) plus the *other* managers' replies on that arm,
  capped at `PRIOR_STRENGTH` = 4 pseudo-offers. A manager's own replies never
  enter his own prior.
- **Per-manager posterior:** the shared prior plus his own replies.
- **Offline:** nothing reads the pick. The label is always
  `learning, n=<graded offers>`. The pick is served only when
  `previewUnconfirmed()` is on.

## Gates (pre-registered before GREEN)

| Gate | Fixture | Pass |
|---|---|---|
| B1 | empty ledger | `learning, n=0`; every arm Beta(1,1); `mean` null |
| B2 | flag off / on | off: section `unknown` + reason naming preview, no arm; on: `ok`, `preview: true`, an arm |
| B3 | 4 answered + 5 ineligible rows | n=4, s=1.5; pending and unarmed are counted as excluded |
| B4 | others 5/5, 0/5, 100/100 | prior leans with the others; α+β ≤ 2+4; own accepts are not in own prior |
| B5 | 3 accepts vs 3 declines | own declines < neutral manager < own accepts |
| B6 | seeded picks | repeatable; at n=0 each arm ≥ 60/400; the dominant arm wins at 21/23 ± 3 SE |
| B7 | recordPitchArm | writes once; refuses unknown arm, unsent row, second arm, missing row |
| B8 | plans contract | the section validates with the flag off and on; `source: pitch.bandit` |
| B9 | migration 087 twice | one `pitch_json` column; row count unchanged |
| B10 | Beta(3,7), Beta(.5,.5) | means within 0.02 and 0.03 |
| R1 | GET `/pitch-bandit` | off: `enabled: false`; on: `learning, n=0`; no `team_id` returns the section |
| R2 | POST `/offers/sent` + `pitch_arm` | arm written; a bad arm returns 400 and writes no row |

## RED

0/10 service cases and 0/2 route cases. Every failure is
`pitch-bandit: not implemented`, `no such column: pitch_json`, or the missing
route.

## GREEN, and one test corrected

The first GREEN run failed B6 at 188/200. The test was wrong, not the code: the
Beta(21, 1) arm wins with probability E[x²] = 21/23 = 0.913, so ≥ 190/200 was
never the expected rate. B6 now checks 2,000 seeds against 21/23 ± 3 SE. That is
a stronger test than the old floor.

## Mutation sweep: 14 mutants, all killed (12 in the unit, 2 at the route call site)

| # | Mutant | Killed by |
|---|---|---|
| M1 | own replies included in own prior | B4, B5 |
| M2 | counter scored 1 | B3 |
| M3 | unsent rows count | B3 |
| M4 | prior not capped | B4 |
| M5 | argmin instead of argmax | B6 |
| M6 | preview flag ignored | B2, R1 |
| M7 | mean shown on a flat prior | B1 |
| M8 | pending rows count | B3 |
| M9 | route skips arm validation | R2 |
| M10 | route drops the arm | R2 |
| M11 | re-arming allowed | B7 |
| M12 | arming an unsent row allowed | B7 |
| M13 | call site: GET route drops `team_id` | R1 (assertion added after the first sweep) |
| M14 | call site: tap records `chosen_by: 'thompson'` | R2 (assertion added after the first sweep) |

Controls:
- **C1: `PRIOR_STRENGTH` 4 → 5 survives, by design.** B4 reads the constant, so
  it pins the cap's rule and not the constant's value. The value is hand-set.
- **C2 reports not-applied.** Its target string is not in the file.

The script is `mut.sh`, run from the scratchpad. Each mutant swaps one string
and runs both test files. It restores the file before the next mutant starts.

## Not confirmed

- **The arm definitions come from the task text.** The REASON/CAMPAIGN playbook
  on the handoff branch never names them.
- **Nothing on the client picks an arm yet.** The route accepts `pitch_arm`, but
  TradeCard's "I sent this" button does not send one. n stays 0 until a surface
  asks which framing was used.
- **No War Room consumer on main.** The view is #231. The section is in the
  contract and in the producer fixture only.
