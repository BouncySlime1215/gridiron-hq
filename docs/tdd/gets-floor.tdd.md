# GETS-FLOOR: the final get must be a Blue chip (83+)

RED `4cbd851` · GREEN follows · `test/campaign-gets-floor.test.js`, 8 cases.

## The rule

Nick, 2026-09-24 (ONE-PLAN 10b.2): the player he ends a plan holding is a Blue
chip, 83+ on the blue-chip score. The floor applies to the final leg's target
only. What he pays with is never floored, so a "Level below" player of his
stays spendable, and a chip picked up on the way to the target is not a final
get.

Before this change nothing enforced it: any target the single-player upgrade
list ranked in its top 3 was searched and served.

## How

- `server/services/campaign/gets-floor.js` reads each candidate get against the
  floor through `adapter.scoreOf` (PLAYER-SCORE's per-player read, PR #375).
  No score source, or no score for a player, fails closed: an unscored player
  is never certified.
- `planner.js`: with the flag on, a below-floor candidate is skipped **before**
  the top-N target slice, so the next Blue chip takes the slot instead of the
  deck coming up short. The suggestions list uses the same filtered order. A
  below-floor player Nick names himself (objective or get stop) is refused and
  named.
- `view.js`: with the floor on and no move, `next_move.reason` says the floor
  emptied the deck, and why (no score source, a named player's score, or the
  count skipped).
- `produce-plans.mjs`: `_run.inputs.gets_floor` carries mode, floor, source and
  counts.

## Flag

`GRIDIRON_GETS_FLOOR`: `1` enforces, `shadow` counts, unset or `0` is off.
Shadow reads every searched target, counts `would_drop`, and moves nothing
served; a test checks targets, best, deck and suggestions are byte-identical to
off. Off, the producer's entry is byte for byte the incumbent's (the committed
contract fixture, checked by two existing tests).

## Measured on the made-up fixture league (before -> after)

Scores given in the test: 11 = 90, 22 = 85, 12 = 75, 32 = 70, 13 = 60.

| mode | off: deck finals under 83 | on: deck finals under 83 | on: targets |
|---|---|---|---|
| safe | 5 / 5 | 0 / 5 | 11, 22 |
| balanced | 1 / 5 | 0 / 5 | 11, 22 |
| all_in | 1 / 5 | 0 / 5 | 11, 22 |

Shadow: 2 would-drop (12 and 13), served output unchanged.
