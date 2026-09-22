# Landing #94: the trade outcome ledger on current main

**No real observed row exists. Every `observed` row in every test is a fixture.
The first real one needs Nick's ESPN cookie on the live transaction collector,
and nothing here fakes one.**

Work-queue unit F-05 (plan Foundation item 4, "trade-acceptance outcome logging
contract; first real row gated on Nick's ESPN cookie, never faked"). Branch
`claude/project-thread-3xqh5l-outcome-ledger`, merged with `origin/main`
`bd56319b` at `8f940546` (merge, not rebase; `bin/update-pr.sh 94`). The PR's own
record is `docs/tdd/trade-outcomes.tdd.md`. This file is what the landing pass
re-measured on the merged tree, and what it had to fix.

## 1. Audit: extend or build (written before any test in this pass)

What exists for this surface on `origin/main` `bd56319b`:

| question | answer | command |
|---|---|---|
| Does main store a trade outcome anywhere? | No. `git grep "trade_outcomes\|trade-outcomes\|outcome_ledger"` over `server scripts client/src test` returns nothing. Control: the same grep for `trade_proposal_cache` finds 7 hits in `060_trade_proposal_cache.js` and 2 in `trade-proposals.js`, so the grep can find a table that exists. | `git grep -n "trade_outcomes\|trade-outcomes\|outcome ledger\|outcome_ledger" origin/main -- server scripts client/src test` |
| Who reads accept/decline today? | Two read-time passes over `league_transactions_raw`, neither stored: `counterparty-pricing.js:1071-1072` and `manager-signals.js:210-211` (line numbers on `bd56319b`; the PR's comments cite `:815` and `:190` from `654ff93`). | `git grep -n "TRADE_ACCEPT\|TRADE_DECLINE" origin/main -- server` |
| Is `067` free on main? | Yes. Main has `063`, `064`, `070` and no `067`. The runner applies any unapplied file by its `name` export (`server/db/migrate.js`, `runMigrations`), so `067` after `070` on a deployed database is fine. | `ls server/migrations` |
| Who else builds on this branch? | #103 (base is this branch), and #100 and #120 in the same stack. Not touched here; F-07 lands them. | `gh pr list --state open` |

**Decision: extend.** #94 is the only ledger; nothing on main overlaps it. The
landing pass keeps its design (migration 067, four writers, one reader, the
route write) and fixes only what does not hold on the merged tree.

**Migration 067 is additive:** `CREATE TABLE IF NOT EXISTS trade_outcomes`,
`CREATE TABLE IF NOT EXISTS trade_outcomes_synthetic`, and five
`CREATE [UNIQUE] INDEX IF NOT EXISTS`. It drops, renames, or rewrites nothing
in `up()`. `down()` drops only what `up()` created and runs only when someone
calls `rollbackMigration('067_outcome_ledgers')` by hand. Nick's Foundation GO
covers the logging contract (coordinator note, 2026-09-22 ~19:10Z).
