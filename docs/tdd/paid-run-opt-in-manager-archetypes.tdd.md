# A third billed script, and the one shaped differently: build-manager-archetypes.mjs (2026-09-22)

**Item:** Coordinator-assigned unit. `docs/tdd/paid-run-opt-in.tdd.md`'s own audit table named
this script as one of the three that reach a billed call: "exits 1 when
`AI_GATEWAY_API_KEY` is unset, and caps spend with `JEV_MAX_USD`... a key-presence check
rather than a spend opt-in, but it is a gate." This applies the same
`scripts/paid-run-optin.mjs` guard here, the third application after
`run-news-event-impact.mjs` and `build-negotiation-profiles.mjs` (`docs/tdd/paid-run-opt-in-negotiation-profiles.tdd.md`).
**Files:** `scripts/build-manager-archetypes.mjs` (the fix), `scripts/paid-run-optin.mjs`
(copied verbatim, not authored here — see §1), `test/build-manager-archetypes-paid-run.test.js`
(new, 4 tests).
**Source:** `scripts/build-manager-archetypes.mjs:27-45,120-135` (before/after below);
`docs/tdd/paid-run-opt-in.tdd.md`'s "other billed paths" table (the finding this unit acts
on); `test/offline-guard.mjs:124-140` (the credential-stripping this unit's own testing ran
into — see §5); the standing rule, CLAUDE.md: "R&D: NOTHING PAID ever."
**LLM spend:** $0 — every test case in this unit runs against a freshly migrated, empty
database (0 eligible managers), which makes the one place that could call the gateway
(`evaluate()`) unreachable regardless of guard outcome or credentials.
**Environment:** cloud box, new branch `claude/coach-paid-run-guard-manager-archetypes`, off
`main` and rebased onto it a second time after `#111` landed a fix elsewhere on `main` (see
§6), isolated temp DB per test run, real `runMigrations()` against it (not a poisoned path —
see §3 for why).

## The five questions

- **Well built?** Yes — one conditional line (`if (!DRY_RUN) assertPaidRunOptIn();`) placed
  first inside the one block that can spend money, reusing the same guard module the first
  two applications already proved. RED (`f5236e6a`, post-rebase sha) fails 1 of 4 new tests
  against the pre-fix code; GREEN (`535ae107`) turns it. A real environment-dependent bug in
  the test itself (not the fix) was found and corrected in a third commit (`a1e5439a`) — see
  §5, the most interesting finding in this unit.
- **Stats or made up?** Not a measurement — a reachability fact, already established by the
  first application's own audit table. This unit's contribution is the fix, the tests, and
  the mutations proving both, not a new finding about what the script does.
- **How do we know?** RED fails exactly the meaningful assertion; GREEN passes 4/4. Three
  manual mutations (dropping the `!DRY_RUN` condition, inverting it, moving the guard past
  the Jev header print) were run and killed by the existing tests with no new tests needed —
  §4. Re-confirmed under `NODE_OPTIONS='--import ./test/offline-guard.mjs'` (the real `npm
  test` invocation shape), not just standalone, after §5's fix. One clean guard run on the
  rebased tree: exit 0, tree unchanged, 3074/3074 pass (§6).
- **Pointed anywhere else?** No. `server/services/manager-archetypes.js` (the service file)
  was read only, never modified — it stays Chat-sync's per the file-allocation map; only the
  CLI script, which was unclaimed, was touched. `scripts/paid-run-optin.mjs` is unmodified.
- **How does it unify?** Third application of the same guard, same discipline — but the
  first one where the script's OWN existing gates (an opt-in flag, a dry-run mode, a
  key-presence check, a budget cap) already did most of the work, which is exactly why
  `docs/tdd/paid-run-opt-in.tdd.md`'s table called it "a gate" rather than "unguarded." This
  unit closes the one real gap: a real key already exported (routine in this project's own
  environment — confirmed present and unscrubbed outside the test harness, see §2) and a
  reasonable cost estimate let `--jev` spend with no opt-in at all.

## 1. `scripts/paid-run-optin.mjs` is a copy, not new work

Fetched verbatim from `origin/claude/project-thread-2oztzw` @ `3c580eb8` — PR #92, **open,
not yet merged** at the time of this unit. Checked byte-for-byte:

```
sha256sum scripts/paid-run-optin.mjs
c360de39c94f26c552240e0a86077d68602bdd36f9307ff8b5cba2f2d3c3f317  scripts/paid-run-optin.mjs
```

— the same hash as the copy already on `claude/coach-paid-run-guard-negotiation-profiles`
(PR #109), confirming both copies are the identical, unmodified file. It lands once in the
eventual merge order across all three branches that now carry it; this branch does not edit
it.

## 2. What was actually wrong, and why this script is shaped differently

Unlike the first two applications, `build-manager-archetypes.mjs` was never a bare command
line that bills by accident: the default invocation (no flags) only measures draft-revealed
preference and never touches the gateway — `--jev` is itself required to reach a billed
call, and `--jev --dry-run` already existed as a no-cost estimate-only preview. What was
missing was an opt-in on `--jev` itself: with a real `AI_GATEWAY_API_KEY` already exported
(true in this project's own execution environment, confirmed directly — its value is never
printed or committed, only its presence checked) and a cost estimate under the `JEV_MAX_USD`
budget (default $1, easy to clear), `node scripts/build-manager-archetypes.mjs --jev` ran
straight through to `evaluate()` with nothing to stop a mistyped or habitual `--jev` from
spending real money. The existing `AI_GATEWAY_API_KEY` check and `JEV_MAX_USD` cap are gates
on the *call itself* (a missing key, an estimate too large), not on *running it at all* —
exactly the distinction `docs/tdd/paid-run-opt-in.tdd.md`'s table drew.

## 3. The fix

```js
import { assertPaidRunOptIn } from './paid-run-optin.mjs';
...
let jevReport = null;
if (WANT_JEV) {
  if (!DRY_RUN) assertPaidRunOptIn();

  const eligible = rows(`SELECT member_id, value AS seasons FROM manager_archetypes ...`);
  ...
```

Placed as the first statement inside the `WANT_JEV` block — before the eligibility query,
the token/cost estimate, the `AI_GATEWAY_API_KEY` check, and the `--- Jev ---` header print.
`--dry-run` stays exempt, matching `build-negotiation-profiles.mjs`'s precedent: it is this
script's existing no-cost mode, and gating it too would make the flag that exists to avoid
spending unusable without first opting into spending.

**Why "before the database opens" isn't the ordering proof here**, unlike the first two
applications: `build-manager-archetypes.mjs` opens the main database unconditionally on
every invocation, `--jev` or not — stage 1 (`luck-panel.mjs`) and stage 2
(`buildManagerArchetypes`) both need it and neither is ever billed. Pointing the guard at
"before the DB opens" would be meaningless (the DB is *always* going to open) and, worse,
would have required gating the default measure-only path too, which was never part of this
defect. The provable claim instead is "before anything Jev-specific runs" — checked in §4
by confirming none of the Jev block's own output (its cost-estimate header) appears when the
guard refuses.

## 4. Test specification, and the mutations

Four tests, run against a freshly migrated, empty test database (0 rows in
`manager_archetypes`, so `states` is always `[]` inside the `WANT_JEV` block — the gateway
loop body never executes in any of them, which is what makes it safe to pass a placeholder
`AI_GATEWAY_API_KEY` in the third case without any risk of a real call):

| test | flags | opt-in | asserts |
|---|---|---|---|
| refuses, before any Jev work | `--jev` | unset | exit 1, one-line stderr naming the variable and "billed", stdout never contains `--- Jev ---` |
| `--dry-run` exempt | `--jev --dry-run` | unset | exit 0, no opt-in refusal text, the existing preview output appears |
| opt-in set, proceeds past the guard | `--jev` | set | no opt-in refusal text, execution reaches the Jev block's own `--- Jev ---` output (see §5 for why this test does **not** assert exit 0) |
| default path untouched | (none) | unset | exit 0, no opt-in refusal text, no Jev output at all — the guard code is never even reached |

```
node --test test/build-manager-archetypes-paid-run.test.js
# tests 4
# pass 4
# fail 0
```

**Three manual mutations**, each run against the fix and confirmed caught by the existing
four tests with no new test needed — the same proportionality the earlier units used:

| # | mutation | verdict |
|---|---|---|
| M1 | drop the `!DRY_RUN` condition (guard fires even on `--dry-run`) | killed — the `--dry-run`-exempt test fails |
| M2 | invert to `if (DRY_RUN)` (guard fires only on `--dry-run`) | killed — two tests flip |
| M3 | move the guard to after the `--- Jev ---` header print | killed — the "refuses, before any Jev work" test's stdout assertion fails |

`node --check` on both changed script files and `npm run lint` — clean.

## 5. What the one-clean-guard-run actually found: an environment-dependent test bug

The first full-suite run (`npm run check`, guard-v3 form, isolated worktree) showed **2**
failures, not the 1 expected from the known pre-existing `manager-signals-api.test.js` issue
(fixed independently on `main` by `#111` partway through this unit — see §6). The second
failure was this unit's own third test, "opt-in set, no `--dry-run`," which had passed
standalone moments earlier.

**Root cause**: `test/offline-guard.mjs`, loaded via `NODE_OPTIONS='--import
./test/offline-guard.mjs'` for every `npm test` / `npm run check` invocation, deliberately
deletes `AI_GATEWAY_API_KEY` (and every other provider credential) from `process.env` at
import time — the project's own credential hygiene, so a key present on the box can never
leak into a test run. `NODE_OPTIONS` is inherited by this test's `spawnSync`'d child
process, so the offline-guard runs inside `build-manager-archetypes.mjs`'s own process too,
and strips the placeholder key the test had just set. The script then correctly refuses at
its own **pre-existing** `AI_GATEWAY_API_KEY` check — a real, different, already-existing
gate — rather than the exit-0 the test assumed.

The test asserted `exit 0` and a specific JSON field, both of which only held standalone
(outside `npm test`'s environment). **Fixed** (commit `a1e5439a`) to assert only what
actually has to hold in either environment: the opt-in guard's own refusal text never
appears, and execution reaches at least as far as the Jev block's own `--- Jev ---` output —
proof the guard under test did not fire, agnostic to what an unrelated, pre-existing gate
does afterward. Verified 4/4 pass both standalone and under the real
`NODE_OPTIONS='--import ./test/offline-guard.mjs'` invocation; the three mutations from §4
were re-run and re-confirmed killed under the offline-guard too, not just standalone.

This is the same category of lesson CLAUDE.md already names from `nfl-news-events`/
`page-explain`'s history: a test's assumption about its own environment, not the code under
test, was what was wrong — found here by running the *actual* suite invocation rather than
trusting a standalone pass.

## 6. Regression, and rebasing across a moving main

```
node --test test/build-manager-archetypes-paid-run.test.js
# tests 4 / pass 4 / fail 0
```

This branch was built off `main` @ `1a136145`. Mid-unit, the coordinator reported `main`
carried a `trades.js`/`manager-signals-api.test.js` regression that another thread was
actively fixing; that fix landed as `#111` (`main` → `ac31922d`). Rebased onto the new
`main` before the final guard run rather than working around the known-red base — clean, no
conflicts. New shas after rebase: RED `f5236e6a`, GREEN `535ae107`, test-fix `a1e5439a`.

**One clean guard run, isolated worktree, independent `npm ci`, guard-v3 form** (no `set -e`;
`rc=0; npm run check || rc=$?`; no `| tee`; log outside the repo; `find . -path ./.git
-prune -o -newermt "@$t0" -type f -print` afterward), run on the rebased tree:

| pass | worktree | exit | tree hash before/after | status before/after | tests | files touched outside `client/dist/` |
|---|---|---|---|---|---|---|
| 1 | `/tmp/claude-0/bma-verify3` | 0 | `ca0501b8` / `ca0501b8` (unchanged) | empty/empty | 3074/3074 pass (3115 incl. 41 skipped), 0 fail | none |

Fully clean — no pre-existing failure to call out this time, since the base was current.

## 7. File ownership

`scripts/build-manager-archetypes.mjs` was checked against `gridiron-file-allocation.md`
before starting: unclaimed. `server/services/manager-archetypes.js` (the *service* file,
distinct from this CLI script) is Chat-sync's per that map and was read but never edited.
`run-nfl-ai-replay.js` (also named in `docs/tdd/paid-run-opt-in.tdd.md`'s table, betting-side)
was not touched, per the coordinator's explicit scope.

## 8. Known limits

- **Same weakest-gate caveat as the first two applications.** This is a presence check, not
  a spend cap by itself — though this script, uniquely among the three, already had a real
  budget cap (`JEV_MAX_USD`) before this unit; the opt-in adds "was this run started on
  purpose" on top of "is the estimate affordable," which the budget cap alone never asked.
- **The default (no-`--jev`) path was never examined for spend risk beyond confirming it
  cannot reach `evaluate()`** — `luck-panel.mjs` and `buildManagerArchetypes` are read-only
  measurement, and nothing in this unit's scope re-audits that claim beyond what the
  script's own three-stage design already documents.
- **Not yet merged.** This lands as a draft PR against `main`; merge follows the project's
  merge-as-they-go rule (CI green + Evidence Auditor ruling), not this unit's own judgment.
