# U8 WANTS-MENU: stated vs revealed wants, shadow

RED `6228c601` · GREEN `7f6fcb9f` + `602c10d9` (grader folded into wants.js) · `test/wants-menu.test.js`, 10 cases.

## RED

`test/wants-menu.test.js` imported `server/services/campaign/wants.js`, which did not exist:
`ERR_MODULE_NOT_FOUND ... server/services/campaign/wants.js` (1 file, 0 pass, 1 fail).

## GREEN

10 of 10 pass. What each case pins:

1. Stated (chat asks, chat shopping, ESPN block) and revealed (his own finalize / analyzer screens) are two lists per roster, never merged; an unread or unknown read contributes nothing and says so.
2. Both menus are rule-filtered: 160 / 80 / 277 never on a give menu; 290 never on a get menu; sold-this-season, below-83, unscored and no-FantasyCalc-value players dropped; each drop counted by reason (the "N ideas hidden by your rules" count).
3. No trade ledger means no get menu at all (the no-buy-back rule cannot be checked, so it fails closed); no board means every get is unscored.
4. The tie-break compares only exact score ties, one family at a time, and never reorders its input.
5. Only `GRIDIRON_WANTS=1` switches it on; `GRIDIRON_PREVIEW_UNCONFIRMED=1` does not.
6-8. The grader: hit / miss / open window / repeat; trailing base per player per week over the same roster's prior 28 days; a planted predictive family passes while a never-true family fails, graded apart.
9. Planner: flag off, the result has no `wants` key; flag on, everything except `wants` is deep-equal to flag off, and `toEntry` writes `_run.inputs.wants`.
10. The grader's inputs: revealed from `chat_trade_interest` rows (espn ids), stated from dated chat mentions (undated counted).
