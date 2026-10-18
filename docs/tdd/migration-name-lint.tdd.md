# TDD evidence: migration-name-lint (PR #39)

Source: the September 2026 release train landed two migrations sharing the
number 062, which prompted a read of how `server/db/migrate.js` actually
identifies a migration. It is the `name` export, not the number — and nothing
in the repository checked that those names behave. No live database was
written and no migration was run. LLM spend: $0.

Runner:

    NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test test/migration-name-check.test.js

## No RED commit, and the reason

As with `boot-restart-cycle.tdd.md`, this did not start from a specification:
the rule was written first, from reading `migrate.js`, and shipped with no test
at all. A RED commit manufactured afterwards would prove only that the author
can write one. So the RED evidence is mutation — the form
`week2-numbers.tdd.md` already uses here — and every row below was RUN against
the merged source at `7bcce55` + this commit, with the output pasted.

**8 guarded rules, 8 with a mutation shown failing.** No exceptions.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| `server/db/migrate.js` | Counts PENDING migrations by **filename**, and that count is what decides whether `backupBeforeMigration` takes a `VACUUM INTO` snapshot. The apply-once guard keys on the **name** (`mod.name ?? basename`). The two disagree whenever a file is half-renamed. | **Build new**: a lint rule, because the failure is in the names, not the runner. |
| A half-renamed migration | Its basename is already recorded so it counts as applied — no snapshot — while its name is not, so `up()` runs against the live database. Clean output, no error, no backup. | **Reject at lint.** The most dangerous of the three and completely silent. |
| Two files sharing a `name` | The second is recorded as applied and skipped. Nothing errors, and `schema_migrations` shows no trace of it having been passed over. Easiest to hit by copying a migration as a template. | **Reject at lint.** |
| Two files sharing a number | Cosmetic: the runner never reads the number. But it costs a reader the ability to tell what ran before what. **062 is exempt** — those two already ran against the live database, and renaming an applied migration re-runs it (README rule 1), so they are permanent. | **Reject new ones, exempt what landed.** |
| A `name` export the check cannot parse | Without a rule, the guard would silently fall back to the basename while the runner used something else: a check that passes by not looking. | **Reject at lint**, rather than assume. |
| The rule's own testability | `checkMigrationNames()` hardcoded `server/migrations` and called `process.exit(1)`, so it could not be exercised against a directory built to break it. A rule nobody can show failing is the shape this project keeps finding. | **Extract**: `scripts/migration-name-check.mjs` exporting `migrationNameProblems(dir)`, which returns `{ problems, checked }` and never exits. `scripts/lint.mjs` keeps the exit. |

## RED -> GREEN, by mutation

Each row: an edit to `scripts/migration-name-check.mjs`, the test output it
produced, then a restore. All run at this commit.

| Mutation | Result |
|---|---|
| delete the name/filename mismatch rule | 6 pass, 2 fail — "a name that does not match its filename is reported"; "two files sharing a name are reported…" |
| ignore the declared name (`const effective = basename`) | 6 pass, 2 fail — same two. The guard would inspect the filename the runner does not use. |
| delete the duplicate-name rule | 7 pass, 1 fail — "two files sharing a name are reported, because the second is skipped in silence" |
| disable the duplicate-number rule | 7 pass, 1 fail — "a repeated migration number is reported" |
| empty `LANDED_DUPLICATE_PREFIXES` | 6 pass, 2 fail — "062 is exempt…"; **"the real migrations directory passes its own rule"**, which is the one that proves the exemption is not decorative |
| delete the unreadable-`name`-export branch | 7 pass, 1 fail — "a name export this check cannot read is reported rather than assumed" |
| widen the file filter to any `.js` | 7 pass, 1 fail — "files that are not numbered migrations are ignored" |
| invert the mismatch condition (`===`) | 2 pass, 6 fail — including "a clean directory has nothing to report" and the real directory. A rule that fires on correct input is as bad as one that never fires, and this is what pins the two negative tests. |

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/migration-name-check.test.js` | 8 | A clean directory reports nothing; a name/filename mismatch is reported; two files sharing a name are reported; a repeated number is reported; 062 stays exempt; a `name` export the check cannot read is reported rather than assumed; non-migration files are ignored; and the real `server/migrations` passes its own rule. |

Fixtures are throwaway directories built per case and removed in `test.after`;
nothing writes to `server/migrations`.

## What this does NOT do

- It does not check that a migration is correct, reversible, or additive — only
  that its name behaves.
- It does not renumber anything, and the duplicate-number message says so:
  renaming an applied migration re-runs it.
- The 062 exemption is a list of numbers that LANDED. A third 062 claimant in
  flight is covered by the exemption and should not be read as permission to
  add more.
