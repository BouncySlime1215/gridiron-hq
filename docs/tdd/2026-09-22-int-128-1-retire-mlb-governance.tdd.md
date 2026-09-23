# INT-128-1: retire the 13 MLB governance rows PR #128 left seeding as live

RED `9d2205cb3d8a6747b53c228263a63d5b89a79583` · GREEN `0e23a7f1dbb6b2af252593a7aead63c6f2f2c7e5` · `test/model-integrity.test.js`

## Audit: what exists, extend or build

PR #128 removed MLB from the product (`docs/tdd/2026-09-22-remove-mlb.md`,
`docs/tdd/2026-09-22-remove-mlb-preregistration.md`). Its own preregistration
audit lists `test/model-integrity.test.js` as one of the files carrying MLB
assertions that survive the removal, but its scope section only tracks the
four cross-cutting *services* that read or import MLB modules
(`market-movement.js`, `evidence-daemon.js`, `nfl-shopping-board.js`,
`betting-hub.js`). It does not mention `server/services/model-governance.js`,
whose two seed arrays (`CONTRACTS`, and the `defaults` list inside
`seedRegistry`) are pure data — no import of anything MLB-specific — so
nothing in that audit's "what reaches MLB from outside it" search would have
found them.

Reading `model-governance.js` end to end: it seeds two tables at import time,
`model_feature_contracts` (from `CONTRACTS`, 32 rows before this change) and
`model_registry` (from `seedRegistry`'s `defaults`, 11 rows before this
change). Ten `CONTRACTS` rows and three `defaults` rows are `sport: 'MLB'`,
for three models PR #128 deleted along with their capture path: `nrfi`,
`pitcher_strikeouts`, `batter_total_bases`. `featureContracts('MLB')` and
`registry('MLB')` (`model-governance.js:98-110`) read those rows straight
back as live data — nothing marks them any differently from the NFL rows
sitting next to them.

**Does this file already have a retired/status convention?** No.
`model_feature_contracts`'s schema (`server/db/schema/mlb-model-misc.js:176-183`)
has no status column of any kind — it is keyed on
`(sport,market,feature_key,contract_version)` with no room for a lifecycle
flag. `model_registry` (`:189-194`) does have a free-text `state` column, but
every value it has ever held (`baseline`, `research_only`, `blocked`,
`production` via `promoteEligibleAudit`) describes a model's standing in the
promotion pipeline, not whether the sport itself still exists; the MLB rows
already used `state: 'blocked'` for "not enough evidence yet," which is a
different claim from "there is no capture path any more." Per the unit's
instructions, with no existing convention inside this file, retirement here
means removing the ten and three MLB entries from the two live seed lists —
so a fresh seed no longer inserts them — each replaced with a comment naming
`#128`. This matches the precedent already in the codebase for the same PR:
`evidence-daemon.js:95-117` marks leftover MLB `evidence_capture_windows` rows
`status='retired'` with `mode: 'sport_removed'` and a note naming the same
2026-09-22 removal, because that table *does* carry a status column. Same
event, same word, the convention each table actually supports.

**Extend or build?** Extend. One file (`server/services/model-governance.js`),
two array edits, no schema change, no migration.

**Only a test still exercises them**, per the unit's framing — confirmed:
`server/services/model-governance.js` is the *only* writer of
`model_feature_contracts` and `model_registry` in the whole tree
(`grep -rln "INSERT INTO model_feature_contracts\|INSERT INTO model_registry\b" server/` returns exactly that one file), and the only test reading an
MLB-specific row out of either table was
`test/model-integrity.test.js:1158-1164`'s
`feature contracts make critical missing inputs abstain and gate audits stay
blocked`, which asserted on `featureContracts('MLB')`'s `confirmed_lineup`
row. `test/nfl-team-strength.test.js:177` and
`test/nfl-pick-watch.test.js:122,140` also import from `model-governance.js`
but only ever query `'NFL'`, so neither is affected by this change.

## RED

Commit `9d2205cb3d8a6747b53c228263a63d5b89a79583` —
*test: MLB governance seed must retire the 13 models PR #128 removed*.

Rewrote the one MLB-dependent test to use the equivalent NFL row instead
(`market_consensus`, same `missing_behavior: 'abstain'` /
`leakage_risk: 'critical'` shape as the `confirmed_lineup` row it replaced),
and added a new test asserting the target behaviour:

```js
test('MLB governance models retired by #128 are not seeded as live', () => {
  assert.deepEqual(featureContracts('MLB'), [],
    'PR #128 removed MLB; the seed must not register live feature contracts for it');
  assert.deepEqual(governanceRegistry('MLB'), [],
    'PR #128 removed MLB; the seed must not register live champion/challenger rows for it');
});
```

Run against that commit (unfixed `model-governance.js`, fresh temp sqlite db):

```
$ GRIDIRON_DB_PATH=<temp>.sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  --test-name-pattern="MLB governance models retired" test/model-integrity.test.js
```

Failing assertion, `test/model-integrity.test.js:1172-1173`:

```
AssertionError [ERR_ASSERTION]: PR #128 removed MLB; the seed must not register live feature contracts for it
+ actual - expected
+ [ { sport: 'MLB', market: 'batter_total_bases', feature_key: 'pitch_mix_matchup', ... }, ... 9 more ... ]
- []
```

`actual` was the 10 seeded MLB feature-contract rows; `expected` was `[]`. The
renamed first test (now reading `'NFL'`) passed on its own on this same
commit, confirming the new test failed for the defect and not for an
unrelated break.

## GREEN

Commit `0e23a7f1dbb6b2af252593a7aead63c6f2f2c7e5` —
*fix: retire the 13 MLB governance rows PR #128 left seeding as live*.

Removed the 10 MLB entries from `CONTRACTS` (`model-governance.js:24-33` in
the prior revision) and the 3 MLB entries from `seedRegistry`'s `defaults`
(`:86-88`), each replaced with a comment naming `#128`, the models removed,
and stating that any row an existing database already seeded is untouched —
`INSERT ... ON CONFLICT DO NOTHING` means this only changes what a *fresh*
seed writes. No schema change, no `DELETE`, no migration.

```
$ GRIDIRON_DB_PATH=<temp>.sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  --test-name-pattern="MLB governance models retired|feature contracts make critical|champion registry cannot promote" \
  test/model-integrity.test.js

✔ feature contracts make critical missing inputs abstain and gate audits stay blocked (6.290125ms)
✔ MLB governance models retired by #128 are not seeded as live (2.230375ms)
✔ champion registry cannot promote a blocked audit (1.279959ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

Full file (`test/model-integrity.test.js`, all 89 cases): `pass 89, fail 0`.

## Liveness proof

**1. RED fails with the implementation reverted.** Shown above: at commit
`9d2205cb` (RED, before the GREEN diff), the new test fails with `actual`
equal to the 10 live MLB feature-contract rows and `expected` `[]`. Re-run
directly against the reverted tree (`git stash` the GREEN diff, same
command) reproduces the identical failure — same assertion, same 10 rows.

**2. Mutant killed: re-adding one MLB row as live.** On top of the GREEN
tree, re-inserted a single MLB row into `CONTRACTS` —
`['MLB', 'nrfi', 'confirmed_lineup', 'MLB pregame boxscore', 'lineup captured before first pitch', 'on refresh', 30, 'abstain', 'critical']`
— directly after the `game_environment` row, leaving everything else
(including the `seedRegistry` fix) untouched, then re-ran the same test:

```
✖ MLB governance models retired by #128 are not seeded as live (12.391375ms)
  AssertionError [ERR_ASSERTION]: PR #128 removed MLB; the seed must not register live feature contracts for it
  + [ { sport: 'MLB', market: 'nrfi', feature_key: 'confirmed_lineup', ... } ]
  - []
```

Mutant killed — the test catches a single re-added live MLB row, not just
a wholesale revert. The mutant was then reverted; `git status --porcelain`
and `git diff --stat` against the GREEN commit were both empty, confirming
the working tree returned exactly to GREEN before any further commit.

**Designed controls.**
- *Surviving control (defect present):* RED commit, test fails — case 1 above.
- *Not-applied control (fix present, no mutation):* GREEN commit as committed,
  test passes — see the GREEN section's 3/3 pass run.
- *Mutant control (fix present, one row re-added):* case 2 above, test fails
  again. All three states behave as required: the test is red exactly when
  and only when a live MLB row exists in either seed.

## The five questions

- **Well built?** Yes for its stated scope — one file, two array edits, no
  schema or migration risk, and a test that is red on the defect and on a
  single re-added row, not just on a full revert.
- **Stats or made up?** N/A — this is a code/seed correctness fix, not a
  statistical claim. No number here is a backtest or a hand-set constant.
- **How we know:** a RED test (`9d2205cb`) and a GREEN test run
  (`0e23a7f1`), both quoted above with real `node --test` output, plus a
  mutation kill, not narrative.
- **Pointed anywhere else on the platform?** No. `model-governance.js` is the
  sole writer of both tables; the only other readers in the test suite query
  `'NFL'` only (`nfl-team-strength.test.js:177`, `nfl-pick-watch.test.js:122,140`)
  and are unaffected. Four other services still read or import MLB code
  (`market-movement.js`, `evidence-daemon.js`, `nfl-shopping-board.js`,
  `betting-hub.js`, per PR #128's own preregistration audit) — none of them
  reads `model_feature_contracts` or `model_registry`, so none is touched or
  needs to be for this unit.
- **How it unifies:** matches the retirement word PR #128 already established
  for the same event in `evidence-daemon.js` (`status='retired'`,
  `mode: 'sport_removed'`), applied the way each table's own schema supports
  it — a status flag where the column exists, seed-list removal where it
  does not.

## Defect, incumbent, scope, and what would make this wrong

- **Defect fixed:** `server/services/model-governance.js`'s `CONTRACTS` and
  `seedRegistry` defaults (on `origin/main` at `ec336a2b`) seed 10 + 3 = 13
  MLB rows as live via `featureContracts('MLB')` / `registry('MLB')`, months
  after PR #128 deleted the models they describe.
- **Incumbent:** `node --test test/model-integrity.test.js` on `ec336a2b`
  passes 88/88, including the old MLB-dependent assertion — it was green
  because it asserted the bug's own behaviour, not because the bug was absent.
- **Does NOT cover:** the `mlb_*` database tables and rows themselves (not
  touched — task scope is seed code only), the four cross-cutting MLB-reading
  services PR #128 already scoped out, or the stale "32 rows … 11 into
  `model_registry`" head-count in a comment at
  `test/wiring-map-deferred-edges.test.js:11` (now 22 and 8; that comment
  documents a historical script measurement, asserts nothing at runtime, and
  is a different file's territory).
- **What would make this wrong:** if some other module turned out to write
  `model_feature_contracts` or `model_registry` outside `model-governance.js`
  (checked — none does), or if an existing production database needed its
  already-seeded MLB rows physically removed rather than merely not
  re-seeded (explicitly out of scope: "Existing DB rows must not be deleted").
