# A second script that bills by default: build-negotiation-profiles.mjs (2026-09-22)

**Item:** Coordinator-assigned unit. The R&D-cleanup thread's evidence for the first
application of this guard (`docs/tdd/paid-run-opt-in.tdd.md`) named
`scripts/build-negotiation-profiles.mjs` as "the closest sibling to this defect... the
obvious second application of the same guard," left alone under one editor per file.
Coach owns this script's sibling (`scripts/build-person-profiles.mjs`) and was handed this
one directly by the coordinator.
**Files:** `scripts/build-negotiation-profiles.mjs` (the fix), `scripts/paid-run-optin.mjs`
(copied verbatim, not authored here — see §1), `test/build-negotiation-profiles-paid-run.test.js`
(new).
**Source:** `scripts/build-negotiation-profiles.mjs:38-56` (before), current shape below;
`docs/tdd/paid-run-opt-in.tdd.md` (the first application, whose lesson and guard file this
reuses); `server/services/manager-signals.js:85` (the existing `GRIDIRON_CHAT_DB_PATH`
convention this reuses rather than invents); the standing rule, CLAUDE.md: "R&D: NOTHING
PAID ever."
**LLM spend:** $0 — this unit makes no Anthropic API calls itself; it is entirely about
preventing another script's accidental ones.
**Environment:** cloud box, new branch `claude/coach-paid-run-guard-negotiation-profiles`
off `main` (this defect and its fix are independent of the coach-grounded-4l8hno branch's
own held work), isolated temp paths per test.

## The five questions

- **Well built?** Yes, and deliberately small: the guard call is one conditional line
  (`if (!DRY) assertPaidRunOptIn();`) placed before the one database open this script does
  at module scope, reusing the exact guard module the first application already proved
  (copied, not reimplemented — §1) and an existing env-var convention
  (`GRIDIRON_CHAT_DB_PATH`) rather than inventing a new one. RED (`0d98795d`) fails 1 of 3
  new tests against the pre-fix code; GREEN (`5753c55d`) passes 3/3.
- **Stats or made up?** Not a measurement — a reachability fact, same as the first
  application. The script's own header and `docs/tdd/paid-run-opt-in.tdd.md`'s own audit
  table both already establish that `scripts/build-negotiation-profiles.mjs:244,:402`
  reaches `callClaude` with no environment opt-in; this unit's own contribution is the fix
  and the tests proving it, not a new finding.
- **How do we know?** RED fails exactly the one meaningful assertion (the no-opt-in/no-dry-run
  case crashes on a poisoned DB path instead of refusing cleanly) while the other two tests
  pass vacuously (no guard exists yet to not-fire) — confirmed by running the suite against
  the pre-fix commit, not just inspecting the diff. GREEN turns all three, `node --check`
  and `npm run lint` clean. 2x-verify below, guard pair on the local tree, held short of a
  push per the coordinator's standing push-hold order.
- **Pointed anywhere else?** No route, no client file, and no other script touched.
  `scripts/build-manager-archetypes.mjs` and the route files were explicitly out of scope
  for this unit and were not opened. `scripts/paid-run-optin.mjs` itself is unmodified —
  copied, not edited (§1).
- **How does it unify?** Same guard, same module, applied a second time rather than
  reinvented — the two scripts that spend money by default now share one opt-in mechanism
  instead of each growing its own. The one real difference (`--dry-run` must stay usable
  without the opt-in) is handled by gating the guard call on `!DRY`, not by a second
  version of the guard.

## 1. `scripts/paid-run-optin.mjs` is a copy, not new work

This branch does not author the guard module. It is fetched verbatim from the R&D-cleanup
thread's own unpushed branch (`claude/project-thread-2oztzw` @ `85598b6`, bundled at
`/mnt/project-files/2oztzw-paid-run-optin-85598b6.bundle`) and checked byte-for-byte:

```
sha256sum scripts/paid-run-optin.mjs
c360de39c94f26c552240e0a86077d68602bdd36f9307ff8b5cba2f2d3c3f317  scripts/paid-run-optin.mjs
```

matching the hash the coordinator's addendum gave for the source commit, and the tree hash
of the fetched commit (`72c1ef78a32fcce9b19fffecb962fe9dd1ba5e4e`) was confirmed against
the bundle before copying. It lands once in the eventual merge order — whichever of the two
branches merges second will find the file already present, unchanged, and the merge is a
no-op on this path. Nothing in this unit edits it.

## 2. What was wrong, same shape as the first application

`scripts/build-negotiation-profiles.mjs`'s own header already says it calls the Anthropic
API (`callClaude`, imported dynamically at `:244`, called at `:402`) and names cost control
as a design goal ("Nick: 'for API stuff keep it low'"). But the only flag that exists,
`--dry-run`, is an **opt-out** — `DRY = process.argv.includes('--dry-run')` defaults to
`false`, so `node scripts/build-negotiation-profiles.mjs` with no arguments is a valid,
billed invocation, the same "a bare command line spends money" shape
`docs/tdd/paid-run-opt-in.tdd.md` fixed in `run-news-event-impact.mjs`. No environment
opt-in existed here either.

## 3. The fix, and the one real difference from the first application

```js
import { assertPaidRunOptIn } from './paid-run-optin.mjs';
...
const CHAT_DB = process.env.GRIDIRON_CHAT_DB_PATH || path.join(ROOT, 'data/derived/league_chat.sqlite');
const DRY = process.argv.includes('--dry-run');
...
if (!DRY) assertPaidRunOptIn();

const chat = new DatabaseSync(CHAT_DB);
```

`assertPaidRunOptIn()` is gated on `!DRY` — the one difference from
`run-news-event-impact.mjs`, which has no dry-run mode and calls the guard unconditionally.
`--dry-run` is this script's existing, legitimate no-cost mode (it prints what it would
send instead of calling `callClaude`, checked at `:398`, well after this guard). A guard
that also blocked `--dry-run` would make the one flag that exists specifically to avoid
spending unusable without first opting into spending — backwards from what the guard is
for. The opt-in variable name (`GRIDIRON_ALLOW_PAID_RUN`) and its presence-only-never-value
discipline are unchanged from the shared module; nothing about that logic was touched or
needed touching.

`CHAT_DB` was also changed to read `GRIDIRON_CHAT_DB_PATH` when set — not a new convention:
`server/services/manager-signals.js:85` already reads exactly this variable for exactly
this path (`data/derived/league_chat.sqlite`), and `build-negotiation-profiles.mjs` had
simply never picked it up. This is what makes the ordering test in §4 possible without
inventing new script surface area.

## 4. Test specification, and the ordering-proof technique

`docs/tdd/paid-run-opt-in.tdd.md`'s own ordering test pointed `GRIDIRON_DB_PATH` at a path
whose parent is a file (so the directory-create fails with `ENOTDIR` regardless of who is
running) and checked that the refusal happens before that path is ever touched. This
script's first database open is the chat DB, not the app DB, so the same technique is
applied to `GRIDIRON_CHAT_DB_PATH` instead — the one addition in §3 that makes this
possible; without it there was no way to steer this script's DB open to a
guaranteed-failing path from outside.

Because this script has a legitimate no-opt-in mode (`--dry-run`), three tests were needed,
not two:

| test | poisoned `GRIDIRON_CHAT_DB_PATH`, opt-in, `--dry-run` | asserts |
|---|---|---|
| no opt-in, no `--dry-run`: refuses cleanly, before the DB opens | yes / unset / no | exit 1, stderr is exactly one line naming `GRIDIRON_ALLOW_PAID_RUN` and "billed", empty stdout — the guard fired and nothing after it ran |
| no opt-in, `--dry-run`: the guard does not fire | yes / unset / yes | exit non-zero (the poisoned path still fails), but stderr does **not** mention the opt-in variable and is **not** the one-line shape — instead it's the multi-line `DatabaseSync` crash, proving execution reached the (poisoned) DB open, i.e. got past the `!DRY` guard as intended |
| opt-in set, no `--dry-run`: the guard does not fire either | yes / set / no | same shape as above — an accepted opt-in must not print its own refusal |

The second and third tests do not need a working chat database or a real league fixture —
deliberately: proving "the guard was skipped" only requires observing that some *later*,
already-poisoned, always-failing step was reached, not that the whole pipeline (which needs
real league/manager data well beyond `:244`) completes. This keeps the test cheap and
independent of fixture data, the same discipline the first application's own tests used.

```
node --test test/build-negotiation-profiles-paid-run.test.js
# tests 3
# pass 3
# fail 0
```

`node --check scripts/build-negotiation-profiles.mjs scripts/paid-run-optin.mjs` — clean.
`npm run lint` — clean (884 files; one new test file).

**Full suite, 2x-verify, guard-v3 form** (no `set -e`; `rc=0; npm run check || rc=$?`; no
`| tee`; log outside the repo; `find . -path ./.git -prune -o -newermt "@$t0" -type f -print`
afterward), run on the local tree at commit `5753c55d` — **held short of a push** per the
coordinator's standing push-hold (resume non-pushing work only until Nick restores push):

| pass | worktree | exit | tree hash before/after | status before/after | tests | files touched outside `client/dist/` |
|---|---|---|---|---|---|---|
| 1 | `/tmp/claude-0/negprof-verify-1` | 0 | `e2e098f7` / `e2e098f7` (unchanged) | empty/empty | 2948/2948 pass (2989 incl. 41 skipped), 0 fail | none |
| 2 | `/tmp/claude-0/negprof-verify-2` | 0 | `e2e098f7` / `e2e098f7` (unchanged) | empty/empty | 2948/2948 pass (2989 incl. 41 skipped), 0 fail | none |

Both passes identical. (Test/pass counts are lower than the coach-grounded-4l8hno branch's
figures because this branch is built directly off `main` and does not carry that branch's
own unmerged test files — expected, not a regression.)

## 5. File ownership

`scripts/build-negotiation-profiles.mjs` was previously unclaimed in
`gridiron-file-allocation.md`; checked before starting, per the coordinator's instruction.
`scripts/build-manager-archetypes.mjs` and the route files named in
`docs/tdd/paid-run-opt-in.tdd.md`'s own "other billed paths" table were explicitly out of
scope and untouched.

## 6. Known limits

- **Not a spend cap.** Same limit as the first application: this is the weakest gate that
  works (an environment presence check), not an interactive confirmation or a hard dollar
  cap like `build-manager-archetypes.mjs`'s `JEV_MAX_USD`. `docs/tdd/paid-run-opt-in.tdd.md`
  already put "which of those this should be" on Nick's morning list; this unit does not
  reopen that question, only ships the same answer a second place.
- **`server/scripts/run-nfl-ai-replay.js` and the nine route files** that reach `callClaude`
  (also listed in `docs/tdd/paid-run-opt-in.tdd.md`'s table) are request/worker-driven, not
  command-line scripts a person can mistype — neither this unit nor the first one touches
  them, and neither claims to.
- **Push held.** Code (`0d98795d`, `5753c55d`) and this evidence file exist only on the
  local tree as of this commit, and a durability bundle, per the coordinator's separate
  request — nothing here has been pushed to `origin`.
