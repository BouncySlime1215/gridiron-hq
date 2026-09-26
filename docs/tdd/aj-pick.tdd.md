# AJ-PICK: A.J. Brown only for players Nick approves, as "Needs your OK" cards

RED `<this branch's test commit>` · GREEN follows · `test/aj-pick.test.js` (13 cases) and
`test/rule-fuzz.test.js` (AJ-PICK sweep + the `aj_needs_ok` rule).

## Why

Nick's rule: A.J. Brown (277) may be traded only for a consistent Blue chip. The automated
"consistent" reader failed its pre-registration (#483, merged unwired), so 277 stayed pinned in
`never-give.js` with a `consistentOf` hook nobody fed. Nick approved a manual route instead: he
picks the players he would take for A.J.; the app may then build trades giving 277 only for one of
those picks, and only as cards he OKs one by one.

## What the tests pin (RED before the change)

1. `aj.allow` / `aj.revoke` / `aj.confirm` are request kinds Nick alone can write. Coach is refused
   even with `confirmed = 1` (the usual plan-request escape hatch does not apply).
2. The fold (`aj-pick.js#foldAj`): latest allow/revoke wins; retracted, Coach and unreadable rows
   never count; state is per league.
3. `never-give.js#ajMayMove` is true only when a step's gets hold a pick who is 83+ on the served
   board now. `ruleVerdict` then passes the step with `requires_nick_confirm: true`; every other rule
   (never 160/80, 83+ gets, FantasyCalc overpay cap, sold/290) still applies to it.
4. `ruleGate.filter` / `ok` drop a needs-OK suggestion on every surface except for the exact
   `move_id` Nick confirmed (`needs_nick_ok` counted inside `dropped_by_rule`).
5. The planner: no picks → 277 appears nowhere (unchanged). Picks → A.J. paths are searched only
   toward a pick, every 277 step must get the pick, and the paths go through the same filters as any
   other (FC value, held floor, FLIP-STRANDED, trade memory, confirm dice, STEP-REGRET). Unconfirmed
   ones never rank into the deck, the hero, a backup, the risk-mode sheet or catch-up; they appear
   after the deck as "Needs your OK" cards (at most 2). An OK'd card competes as a normal card; if
   it does not rank into the deck it still shows after it (an OK never makes a card vanish).
6. The plans contract: `requires_nick_confirm` / `nick_confirmed` / `aj_for` on a move,
   `requires_nick_confirm` on each 277 step; a waiting card can never be `next_move` and never sits
   ahead of a served card.
7. The UI: the deck card shows "Needs your OK: gives A.J. Brown for <player>" and an OK button, and
   cannot be copied, picked or marked sent while waiting; Go get shows "Allow A.J. for him" only on
   83+ targets when A.J. is on Nick's roster; the context bar chip counts the picks.

RULE-FUZZ oracle (`test/fixtures/nick-rules.mjs`, independent of the planner): `aj_brown` now means
"277 only for a Blue chip in `opts.ajAllow`"; new `aj_needs_ok` checks that no card giving 277 is
served (best, backups, risk-mode picks, catch-up) unless its whole path is one Nick OK'd, and that
waiting cards carry the flag and sit after every served card.

## Result

`test/aj-pick.test.js` 13/13; `test/rule-fuzz.test.js` all pass, AJ-PICK sweep (51 leagues holding
A.J., balanced and all-in) at 0 violations: 19 / 33 leagues build a needs-OK card, every one of them
is served once OK'd, and no unconfirmed card is ever the next move.
