# TDD evidence: ESPN credential shared-slot lock-in in routes/espn-connect.js

2026-09-22. Base: `60d1378` (this branch, on top of `654ff93`/main).
RED `674e07c`, GREEN `ec0b3de`.

## 1. Where this came from

`gridiron-google-sign-in` team memory (audited 2026-09-19, re-verified against
current code before touching anything) flagged `server/routes/espn-connect.js`'s
`getCookies()` as the "dangerous half" of the connect flow: an empty global
`app_settings` pair falls back to whichever ESPN league was most recently
fetched, then **persists** that league's cookies into the shared global slot —
which `/status`, `/discover` and `/add` all treat as "the account of record"
from then on. Nothing connects anything; a routine sync bumping `fetched_at`
is enough.

Picked as this thread's next Phase-A-adjacent unit because `espn-connect.js`
is Google sign-in's file under the one-editor rule, the gap was independently
re-confirmed live against current code (not just trusted from a two-day-old
memory), and it's contained to one file with no schema change — unlike the
larger per-user encrypted-credential-ownership redesign the same memory note
also flags, which is out of scope here and left as a separate, bigger unit.

## 2. Verified before touching anything

- `getCookies()` is not exported and not called from any other file
  (`grep -rn getCookies server/` — one file, three call sites, all internal:
  `/status`, `/discover`, `/add`). The fix's blast radius is exactly this file.
- `server/routes/leagues.js:51` (`UPDATE leagues SET ... espn_s2 = COALESCE(?,
  espn_s2), swid = COALESCE(?, swid) WHERE id = ?`) is a real, live write path
  that lets two different league rows carry two different accounts' cookies —
  confirming the lock-in scenario isn't hypothetical.
- `grep -rn "app_settings.*espn_s2\|espn_s2.*app_settings" server/` —
  `espn-connect.js` is the only file that reads or writes the shared slot.

## 3. RED (`674e07c`)

Two tests added to `test/espn-connect.test.js`:

1. `reading a per-league credential through the fallback does not pin it as
   the shared global account of record` — one league carries its own cookies,
   `app_settings` starts empty; `GET /status` must still read through
   (`connected: true`) but must leave `app_settings` untouched.
2. `a later sync of a second account's league cannot silently flip the
   account status/discover already read` — two leagues, two different
   accounts' cookies, `fetched_at` ordering exercised exactly as the memory's
   scenario describes; asserts no standing global identity survives a read.

Both failed against the pre-fix code (2 failing, 22 pre-existing passing) —
the pre-fix `getCookies()` writes the winning league's cookies into
`app_settings` on the very first read.

## 4. GREEN (`ec0b3de`)

Removed the two `INSERT INTO app_settings ... ON CONFLICT` calls from the
fallback branch. The branch now returns the most-recently-fetched league's
cookies directly, re-derived from `leagues` on every call, never persisted.
The early-return bookmarklet path (`app_settings` already populated) is
unchanged. 24/24 tests pass.

This does not fix per-user credential attribution — the single shared slot
is still the design, and once populated via the bookmarklet it's still
one account for the whole install. What it removes is the *silent,
permanent, connect-action-free* reassignment of that identity to whichever
league a background sync happened to touch last.

## 5. Side effects checked

- `/status`'s `source: 'manual form'` label is unchanged behavior (still
  returned, just no longer written anywhere) — no client contract change.
- `/add` and `/discover` both call `getCookies()` per-request already; making
  the fallback read-through instead of write-once-cache changes nothing about
  their control flow, only removes the persistence.
- No other route reads `app_settings` keys `espn_s2`/`swid` (checked in §2),
  so nothing downstream depended on the fallback's backfill ever having run.

## 6. Mutation sweep

`node` script (avoids sed escaping issues), same shape as prior sweeps on
this branch: verify each anchor occurs exactly once, mutate, run
`test/espn-connect.test.js`, restore, verify restored sha256 matches
baseline.

| Injection | Result |
|---|---|
| Reintroduce the `app_settings` backfill (the original bug) | caught: 2 failing |
| Fallback query drops the `fetched_at` ordering | **NOT caught** — all 24 green |
| Fallback returns `source: 'bookmarklet'` instead of `'manual form'` | **NOT caught** — all 24 green |
| Bookmarklet-slot short-circuit removed (always falls through) | caught: 2 failing |
| Absent-pattern control | SKIP-BAD-ANCHOR (0 matches, correctly not silently applied) |
| NO-OP control (whitespace only) | all 24 green (correct — behavior-neutral) |

File restored byte-identical (sha256 match) after every case.

The two survived mutations are real, honestly reported gaps — this suite
proves the persistence bug is fixed, not that `getCookies()`'s exact
tie-break or label are pinned. Neither is what this unit is claiming to fix;
not closing them here rather than quietly expanding scope.

## 7. Full check — isolated, tree-hash guarded

Both runs are on dedicated `git worktree add --detach` checkouts of commit
`ec0b3de`, in the scratchpad, never the primary checkout.

**Run A — source-isolated** (`node_modules` symlinked from the primary
checkout's install, same dependency tree, no install ran):

`git write-tree` before and after: `74c94abd389002c21f47766aceb7e8949b7d5081`
— unchanged. `git status --porcelain` checked empty after the run (the guard
command captured write-tree atomically either side; status was read back
immediately after — not captured inside the same atomic command, so this
run predates the coordinator's later four-part guard-form correction and is
accepted as evidence under the grandfather clause given for runs already
in flight when that correction landed).

`npm run check` — exit 0:
- typecheck: clean
- lint: clean, 883 JavaScript files
- test: 2,996 tests, 2,955 passed, 0 failed, 41 skipped
- build: clean
- start:smoke: "Application startup smoke passed on isolated database (32 teams)"

**Run B — fully isolated** (own `npm ci`, own dependency tree; confirmed by
`node_modules` mtime `1790064271`, distinct from the primary checkout's
`1789834668`):

`git write-tree` before and after: `74c94abd389002c21f47766aceb7e8949b7d5081`
— unchanged (identical to Run A's, since both start from the same commit).
`git status --porcelain` checked empty after the run, same caveat as Run A.

`npm run check` — exit 0:
- typecheck: clean
- lint: clean, 883 JavaScript files
- test: 2,996 tests, 2,955 passed, 0 failed, 41 skipped
- build: clean
- start:smoke: "Application startup smoke passed on isolated database (32 teams)"

Two independent runs, two different dependency-tree setups, identical
figures: **2,996 / 2,955 / 0 fail / 41 skipped, exit 0.** This is the number
that goes in the PR body — not the §7b figure from the prior unit, which
was a different tree.
