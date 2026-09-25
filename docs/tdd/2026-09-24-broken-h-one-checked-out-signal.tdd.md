# BROKEN-H: one "checked out" signal in Trade Brain under preview

Row H of `BROKEN-NUMBERS.md` (handoff branch): under `GRIDIRON_PREVIEW_UNCONFIRMED=1`,
Trade Brain could show two checked-out signals for one league-mate at once:

- `activity.manager` (LIVING-01a, #220): P(checked out) from the engagement-state model,
  shown through `readActivityManager` whenever the flag or preview is on;
- `checkedOutFactor` (`counterparty-pricing.js:396` on main): last week's dead starts,
  applied to receptiveness under the same preview switch.

The producer already declares `replaces: ['counterparty-pricing.js#checkedOutFactor']`
(`activity-model.js` registerProducer). Nothing enforced it.

## Change

- New `server/services/checked-out-signal.js#activityCheckedOut`. When an
  `activity.manager` row is visible (a live row, or `GRIDIRON_LIVING01A_ENABLED=1` /
  preview showing the shadow row), it builds the checked-out term from that row:
  P(checked out) × the corpus dead-start coefficient the old factor applied at full
  strength. It cites the row id, lane and version. If the replacement owns the term
  but the team has no row, the term is withheld with that reason. It is never refilled
  from the legacy factor or from the league prior.
- `counterparty-pricing.js:396` → `:399-400` calls `checkedOutTerm`
  (`:574-578`), which calls `checkedOutFactor` only when the replacement does not own
  the term.
- With the flag and preview both off, and no live row, nothing changes. The existing
  default-off gate (`GRIDIRON_RECEPTIVENESS_ACTIVITY`, `offUnless`) still decides
  whether the term moves the score.

## RED (`41a395e5`, test only, code unchanged)

`test/broken-h-checked-out.test.js`: 1 pass (the off-preview control), 3 fail.

- "under preview there is ONE checked-out signal per manager, and it is activity.manager":
  the served entry was the legacy "left a starter in who did not play" factor.
- "the LIVING-01a flag alone hands the term over": `checked-out-signal.js` did not exist.
- ratchet: the one `checkedOutFactor(` call was unconditional.

## GREEN

- `test/broken-h-checked-out.test.js`: 4/4.
- `test/receptiveness-activity.test.js`: 17/17. Two assertions changed. They required
  the legacy checked-out term to be applied under preview, which is the second signal
  this row removes. They now require one checked-out entry, sourced from
  `activity.manager` (withheld in that fixture: it has no activity row).
- Full `npm test` on the GREEN tree: 4882 tests, 4839 pass, 0 fail, 43 skipped, exit 0
  (633 s).
- `npm run lint` and `npm run check:wiring` pass.

## Ratchet

- Call sites of `checkedOutFactor(` under `server/` and `client/src`: at most 1. That
  one must sit behind `a.replaced ? a.factor :`. The count can only fall, to 0 when
  the promotion PR deletes the legacy factor.
- The test also fails if `activity-model.js` stops declaring the `replaces`.

## Mutation sweep (`test/broken-h-checked-out.test.js`, 4 tests)

| mutant | where | result |
|---|---|---|
| M1 call site always calls the legacy factor (`a.replaced && false ?`) | counterparty-pricing.js:577 | killed (2 fail) |
| M2 replacement only for a live row, preview ignored (`if (!live)`) | checked-out-signal.js | killed (2 fail) |
| M3 no activity row → hand back to the legacy factor | checked-out-signal.js | killed (1 fail) |
| M4 effect not scaled by P(checked out) | checked-out-signal.js | killed (1 fail) |
| control: unmutated | none | 4/4 pass |

The designed not-applied control is test 1: with the flag and preview off, the legacy
term is still served, reported and not applied.
