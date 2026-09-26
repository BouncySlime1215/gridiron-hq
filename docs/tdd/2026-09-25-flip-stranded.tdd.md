# FLIP-STRANDED: every holding between legs passes the Blue chip floor

Nick's Batch D plan (2026-09-25), item 1: "gets-floor.js checks only the path END.
Every intermediate holding after each executed leg must also pass the 83+ floor,
no-buy-back and overpay rules, so Nick is never stranded if leg 2 fails. Add a
'stranded_hold' rule to RULE-FUZZ."

Flag: `GRIDIRON_FLIP_STRANDED`, on by default like `GRIDIRON_GETS_FLOOR` (a hard
rule filter, not a model). `shadow` counts only; an explicit `0` turns it off and
the producer logs a loud warning. `GRIDIRON_PREVIEW_UNCONFIRMED` does not touch it.

## Pre-registration (written before the first test)

- Metric: `stranded_hold` violations from the RULE-FUZZ oracle
  (`test/fixtures/nick-rules.mjs`), meaning a player Nick did not start with, held
  after any leg but the last of a served plan, flip or ladder card, who scores under 83.
  Measured over RULE-FUZZ seeds 1..300 in every risk mode.
- Pass bar: 0 in every mode with the served env (`{}`); each mode keeps its RULE-FUZZ
  deck-share floor (safe 0.40, balanced 0.85, all_in 0.85); and the other eight
  rules stay at 0.
- What fails it: any stranded hold served; any deck share under its floor; shadow
  moving `best` or `deck`; a per-leg overpay, never-give or buy-back.

## Evidence

- RED `302292c`: 8 of 10 in `test/campaign-flip-stranded.test.js` failing, and
  RULE-FUZZ `stranded_hold` failing in all 3 modes.
- Main, before (`GRIDIRON_FLIP_STRANDED=0` reproduces it), seeds 1..300:
  stranded holds safe 43 (26 leagues), balanced 182 (85), all_in 168 (78);
  decks 145 / 296 / 296; 20,885 candidate plans.
- After (default on): stranded holds 0 / 0 / 0; decks 143 / 294 / 296 (floors
  120 / 255 / 255); 18,842 candidate plans (-9.8%). Other rules 0.
- With `GRIDIRON_LADDER=1`, seeds 1..100: before 31 / 164 / 185, after 0 / 0 / 0.
- Producer contract fixture: only `_run.inputs.flip_stranded` is added (0 dropped
  on the fixture league); no served field moves.

## Assumed

- Per-leg overpay and buy-back were already checked per step (search.js
  `nickOverpays` per step; trade-memory.js `stepMemory` per step; both flip legs), so
  the unit adds only the floor on holdings between legs. A test pins the per-leg
  rules at 0 on every served plan.
- A flip's leg-1 player is a holding between legs: both `flip.top` and
  `flip.realised` entries under the floor are dropped.
