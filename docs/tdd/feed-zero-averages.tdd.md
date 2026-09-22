# TDD evidence: feed-zero-contaminated averages (PR #87)

Source: coordinator-delegated unit on `nfl-weekly-feature-store.js`, extended
to its v2 study copy and then to v2's `participation()` satellite after an
independent measurement confirmed the same failure in a second, unrelated
feed. LLM spend: $0 for the measurement — a public nflverse CSV download and
a plain Node script, no model calls. Nothing deployed, no league data
touched, no betting logic changed.

Runner:

    node --test --experimental-test-module-mocks \
      test/nfl-weekly-feature-store-feed-zero.test.js \
      test/nfl-weekly-feature-store-v2-feed-zero.test.js \
      test/nfl-weekly-feature-store-v2-participation-feed-zero.test.js

## Five questions

1. **Well built?** Yes — a narrow SQL guard per contaminated column, RED/GREEN
   per call site, full-suite regression after each push.
2. **Stats or made up?** Not a model change. The 0-vs-null distinction is a
   fact about how each feed writes, not a tuned parameter.
3. **How we know:** measured directly against real files (below), not assumed
   by pattern-matching FTN's known bug onto a different feed.
4. **Pointed anywhere else?** `teamHistory()`'s output feeds
   `manager-archetypes.js`, `nfl-feature-coverage.js`, `nfl-team-card.js`,
   `nfl-model-growth.js`, `nfl-n-to-z.js` schema, and `nfl-betting.js` — fixed
   once, at the shared aggregation point, reaches all of them. v2 and
   `participation()` have no server callers; fixed anyway because
   `scripts/backfill-feature-store.mjs` / `scripts/grade-feature-vector.mjs`
   run against them.
5. **How it unifies:** one fix shape (`NULLIF(column,0)` on the SQL side)
   applied identically to two independent feeds (FTN, nflverse) that turned
   out to fail the same way, rather than three separate patches.

## The defect

`AVG()` (SQL) and `add()`/`finite()` (the JS accumulator in `participation()`)
both treat a real `0` and a **sentinel** `0` identically. FTN's charting feed
and nflverse's `pbp_participation` feed both write a literal `"0"` — not a
blank cell — for a play they did not measure. `num()` in `nfl-formations.js`
and `finite()` in the feature-store files correctly parse that literal `"0"`
as the number `0`, not `null`: that parsing is correct, but it means the
unguarded aggregation has no way to tell a real box count of 0 (which never
happens on a real NFL snap) apart from an unmeasured play. The mean is pulled
toward zero by every unmeasured play, silently.

## Discover -> audit -> decide

| Site | Column | Feed | Decision |
|---|---|---|---|
| `nfl-weekly-feature-store.js:149` `teamHistory()` | `defenders_in_box` | FTN (`nfl_play_formations`) | **NULLIF.** Confirmed contaminated by prior measurement (11,601 literal zeros of 48,031 rows, 0 blanks, real 2024 FTN data). |
| `nfl-weekly-feature-store.js:158` `teamHistory()` | `c.defense_box` | FTN (`nfl_play_charting`) | **NULLIF.** Same feed, same measurement. |
| `nfl-weekly-feature-store.js:158` `teamHistory()` | `c.contested` | FTN (`nfl_play_charting`) | **Leave alone.** `0` is a genuine measured "not contested," not a sentinel — confirmed by this PR's own fixture, which keeps the contested rate correct while the other two are fixed. |
| `nfl-weekly-feature-store.js:149` `teamHistory()` | `pass_rushers` | FTN (`nfl_play_formations`) | **Out of scope.** Needs a dropback/play-type gate; `nfl_play_formations` has no such column, and `nfl_play_by_play` uses a different, non-joinable key scheme (ESPN `event_id` vs nflverse `game_id`). Flagged, not silently dropped. |
| n/a (checked, not present) | `n_blitzers` | FTN (`nfl_play_charting`) | **Out of scope, no live bug.** Not read anywhere in either `teamHistory()` file — confirmed by grep — so there is nothing to fix here even though the column exists. |
| `nfl-weekly-feature-store-v2.js:623,632` `teamHistory()` | same two columns | FTN, identical query | **Same fix, mirrored.** v2 is a study-only copy (its own top-of-file note: "NOTHING in the server imports this file"), consumed only by `scripts/backfill-feature-store.mjs` / `scripts/grade-feature-vector.mjs` against the study sqlite — fixed so the study copy does not silently diverge from production. |
| `nfl-weekly-feature-store-v2.js:265` `participation()` | `p.defenders_in_box`, `p.number_of_pass_rushers` | nflverse (`pbp_participation`) | **NULLIF both, independently measured (below).** `rushers` is already gated behind `if (dropback)` in this function — unlike `teamHistory()`'s `pass_rushers`, there is no missing-join blocker, so this is a complete fix. |
| `nfl-weekly-feature-store-v2.js:266` `participation()` | `p.was_pressure` | nflverse (`pbp_participation`) | **Leave alone.** A boolean-rate column where `0` is a real measured value, same reasoning as `contested`. Not independently measured in this pass; flagged as unverified, not asserted safe. |

## Independent measurement: `pbp_participation` (2026-09-22)

The coordinator relayed R&D-cleanup's finding that nflverse's `pbp_participation`
sentinel-writes zero the same way FTN does, plus their verification script
(`ftn-twocols.mjs`) and hypothesis: a feed that measured nothing writes 0 to
**both** `defenders_in_box` and `number_of_pass_rushers` at once; a feed that
actually measured a play almost never has both at zero (a real defensive box
of 0 defenders is not a thing in the NFL).

Rather than trust that relay or reuse R&D's own copy of the data, this was
independently reproduced against a freshly downloaded copy of the real file.
`api.github.com` (the asset-listing API `nflverse_backfill.py` uses) is
blocked by this session's org egress policy (403, confirmed via the proxy
status endpoint as a clean policy denial, not a transient failure) — but the
actual release-asset host is not:
`https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_2024.csv`
redirects to `release-assets.githubusercontent.com` and returns the real
file, no auth required (nflverse-data is a public release).

    curl -sSL "https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_2024.csv" -o pbp_participation_2024.csv

45,919 data rows — matches the row count Data & techniques R&D reported for
2024 in `PARTICIPATION-SPEC.md` (`/mnt/project-files`), confirming this is
the same release, independently fetched.

    both defenders_in_box=0 AND number_of_pass_rushers=0:  9214
    both NULL (blank cell):                                  14
    box=0 & rushers=NULL:                                     0
    box=NULL & rushers=0:                                     0

9,214 of 45,919 rows (20.1%) carry the "measured nothing" signature; only 14
rows are genuinely unmeasured-and-blank; and there are zero rows where one
column is a sentinel zero and the other is a true null — every sentinel
pairs with its sibling sentinel, which is the write-both-zero-at-once
behavior the hypothesis predicted and the mismatched-null case it predicted
would not appear. Confirms contamination, independently, on a second feed.

## RED -> GREEN

| Fix | RED | GREEN | Shape |
|---|---|---|---|
| v1 `teamHistory()` | `7646404` | `080dc44` | 3 real box counts (6,7,8) + 2 sentinel zeros: 4.2 -> 7 (defenders_in_box); 5,9,0 -> 4.667 -> 7 (charted defense_box); contested rate (1/3) unchanged throughout |
| v2 `teamHistory()` | `057ca79` | `d3a7bae` | identical shape, mirrored fixture |
| v2 `participation()` | `a82c7df` | `74055d8` | 3 real dropback plays (box 6/7/8, rushers 4/5/6) + 2 sentinel rows (both columns literally 0): box 4.2 -> 7, rushers 3 -> 5 |

Full suite after all three pushes: 2993 tests / 2952 pass / 0 fail / 41
skipped, build and smoke green, verified under the corrected tree-guard
(`rc=0; npm run check || rc=$?` — no `set -e`, no `tee`, log outside the
repo — `git status --porcelain` empty and `git write-tree` unchanged both
before and after the run: `d0a16d866f4431a83784e5989f51ad2c74938460`) plus a
post-run `find` sweep (excluding `.git`, `node_modules`, `client/dist`) that
found nothing written outside those.

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/nfl-weekly-feature-store-feed-zero.test.js` | 3 | `defenders_in_box` and `charted_box` exclude sentinel zeros; `contested` rate is unaffected |
| `test/nfl-weekly-feature-store-v2-feed-zero.test.js` | 3 | Same three assertions against the v2 study copy |
| `test/nfl-weekly-feature-store-v2-participation-feed-zero.test.js` | 1 | `participation()`'s team-level `off_box_faced` and `off_rushers_faced` exclude sentinel zeros, via a satellite-db fixture (`NFLVERSE_DB_PATH` pointed at a temp sqlite) |

## What this does NOT settle

- `pass_rushers` in `teamHistory()` (v1 and v2) is still unguarded — it needs
  a play-type/dropback gate that the current schema cannot supply. This is a
  known, flagged gap, not a claim that the column is clean.
- `n_blitzers` was checked for live readers (none found) but not measured
  against real data — there is no bug to fix today because nothing reads it,
  which is different from "this column is safe."
- `p.was_pressure` and other `participation()` columns beyond
  `defenders_in_box`/`number_of_pass_rushers` were not measured in this pass.
  Nothing here asserts they are clean; only that the two columns named in the
  coordinator's hypothesis were checked and are fixed.
- Whether nflverse's `pbp_participation` sentinel-writes zero for other years
  (2022, 2023, 2025) the same way it does for 2024 is unmeasured; the fix does
  not depend on the answer (`NULLIF` is harmless if a season turns out clean),
  but the claim above is scoped to 2024 only.
