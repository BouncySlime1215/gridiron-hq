# AUTO-PARK: shadow units that stall get a "park?" flag

RED `771ce334` · GREEN follows · `test/auto-park.test.js`, 9 cases.

## The ask (plan item 52)

Any shadow unit with no progress toward its bar for 3 weeks is flagged "park?" in BENCHMARKS.md,
with a one-line reason.

## What was built

- `BENCHMARKS.md` gains a `## Shadow units` table between `shadow-units` markers: unit, flag,
  status (shadow / live / parked), bar, registered, last progress, progress note, park. 18 units
  whose flags are on `main` today are seeded; registered is the day the flag reached `main`.
- `scripts/auto-park.mjs` reads that table plus an optional JSONL progress log, and for each
  `shadow` row computes days since the newest progress (or since registered, when there is none).
  At 21 days or more the park cell reads `park? no progress toward its bar for N days (...)`.
- Dry run by default. `--write` rewrites only the park cells and is refused unless
  `GRIDIRON_AUTO_PARK=1`. A bad date or status exits 2; nothing is skipped as fresh.
- The benchmark rows the merge gate reads (`scripts/check-benchmarks.mjs`) are untouched; the test
  asserts `parseBenchmarks` is equal before and after a write.

## Pre-registered bar (B1-B6), all fixture

| bar | what | test |
|---|---|---|
| B1 | 21 days without progress flagged with a one-line reason, 20 not; no progress counts from registered | B1, B1b |
| B2 | live and parked rows never flagged | B2 |
| B3 | a newer progress-log entry resets the clock, an older one does not | B3 |
| B4 | bad dates, unknown status, bad log lines, missing markers fail loudly | B4 |
| B5 | only park cells change, idempotent, dry run default, `--write` needs the flag | B5, B5b |
| B6 | committed table parses, every flag exists in server/ or scripts/, park cells current on 2026-09-26 | B6 |

RED: the module did not exist (`ERR_MODULE_NOT_FOUND`). GREEN: 9/9.

## Today

Dry run on 2026-09-26: 18 shadow units, 0 flagged (every flag reached `main` 2026-09-24 or later).
Dry run with `--as-of 2026-10-16`: 17 flagged; PLAYOFF-SEEDING (registered 2026-09-26) is the one
still inside its window.
