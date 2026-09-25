# BITEMPORAL — injury availability clock + standings check vs ESPN (TDD record)

Unit 17 of the 2026-09-24 queue. ONE-PLAN 4d night 7 ("bitemporal inputs
(event_time + availability_time) on the tables that feed decisions; reconcile
standings with ESPN's official record") and 4b row 12 (`nfl_injuries.modified_at`
NULL for every 2025-26 row).

## Pre-registration

- Metric 1: share of `nfl_injuries` rows the loader writes that carry an
  availability stamp (`available_at`). Pass: 100% of rows written or re-synced
  after migration 100; `modified_at` (event clock) never filled with our clock.
- Metric 2: the standings check agrees with a hand-computed ESPN fixture
  (`match`) and names every roster id whose wins or points-for differ.
- Fails if: an unchanged re-sync moves `available_at`; a NULL source stamp is
  replaced with ours; a sim output changes with the flag off; a different-week
  official record is reported as a mismatch.

## RED

Commit `test: RED for BITEMPORAL ...`: `test/bitemporal-inputs.test.js` fails
with `ERR_MODULE_NOT_FOUND` for `server/services/standings-reconcile.js` (and
`available_at` does not exist on `nfl_injuries`).

## GREEN

- `server/migrations/100_bitemporal_inputs.js`: adds `nfl_injuries.available_at`.
- `server/services/nfl-advanced.js#syncInjuries`: changed row -> capture instant;
  unchanged -> keeps its stamp; legacy NULL -> capture instant (late, never early).
- `server/services/nfl-bitemporal.js#weekKeyedTableMutationRisk`: reports
  `available_stamped` per season beside the unchanged source-clock verdict.
- `server/services/standings-reconcile.js`: `reconcileStandings` +
  `standingsCheckField` (flag `GRIDIRON_STANDINGS_RECONCILE=1`, default off).
- `server/services/season-sim.js#playSeasons`: spreads the field from the records
  it already carries in.

`test/bitemporal-inputs.test.js`: 15/15 pass. Related suites unchanged green:
nfl-injuries-bitemporal 6/6, nfl-t60-packet 44/44, nfl-team-card-injury-cutoff
5/5, asset-cache-stamps 5/5, b-01-real-record-odds 11/11.
