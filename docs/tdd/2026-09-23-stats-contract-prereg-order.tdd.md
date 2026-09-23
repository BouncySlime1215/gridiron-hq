# GR-05 (C12/C18): the statistical contract and the pre-registration order check

Unit GR-05, plan items 12 (beat-the-dumb-baseline gates) and 18 (Goodhart /
accuracy-theater guards), grading half. New files: `docs/STATS-CONTRACT.md`,
`scripts/check-prereg-order.mjs`, `test/check-prereg-order.test.js`, one npm
script (`check:prereg-order`) and this evidence file. Base tree: `origin/main`
at `89f69b3b` (#161). Every number below names the command and the tree.

## 1. Audit: extend or build (written before the first test)

What already exists on `origin/main` `89f69b3b` for this surface:

| # | Existing thing | What it does | Gap GR-05 fills |
|---|---|---|---|
| 1 | `docs/evidence/STATS-METHOD.md` (675 lines, S-00, #154) | Eight rules: pre-register first (rule 1), holdout ledger (2), BH across the feature-lift family (3), MDE at 80% power on every decline (4), forward rule on 2026 (5), decision win rate vs the dumb baseline (6), configuration B (7), claim hygiene (8) | Rule 1 says the prereg commit "must be an ancestor of the result's commit" but **nothing checks it**. No rule for week/player-clustered CIs as a requirement (only mentioned in rule 8's house ship rule), none for LLM-touched grading, none for the ESPN comparison, no fill-in prereg template |
| 2 | `docs/evidence/HOLDOUT-LEDGER.md` (457 lines, #154) | Every look at 2025 | Reused as is; the contract points at it |
| 3 | `scripts/weekly-construction-grade.mjs:57-60` | Refuses to grade if **its own** prereg file is untracked or dirty | Guards one script's run, at run time; does not compare first commits of a prereg/results pair, and covers one file |
| 4 | `server/services/nfl-blind-audit.js:213`, `server/services/audit-registry.js:253` | App-database preregistration of blind audits, counted by prereg order | Rows in the app DB, not committed evidence files |
| 5 | `server/services/backtest-significance.js:57` `pairedBootstrapDiff(..., { groups })` | Block (cluster) bootstrap when `groups` is passed | Canonical cluster CI producer; the contract names it |
| 6 | `server/services/gates/baseline-gate.js:32,56,106,176` | `MDE_Z`, player-clustered two-factor `pigeonholeBootstrap`, `gradeDecisions`, `baselineGateVerdict` | Canonical decision-win-rate / MDE producers; the contract names them |
| 7 | `league_roster_snapshots.projected_points` (ESPN statSourceId 1), writer `scripts/collect-roster-snapshots.mjs:113`, table from `server/migrations/058_league_roster_snapshots.js` | ESPN's weekly projection per rostered player, kept since 2026-09-18 | The only ESPN weekly-projection history in the DB; the contract names it as the "vs ESPN" baseline where it has a number |

Commands (tree `89f69b3b`):

```
git ls-files | grep -i -E 'prereg|holdout|stats-contract|STATS'
#   8 prereg files under docs/evidence/2026-09-22 and docs/tdd, HOLDOUT-LEDGER.md, STATS-METHOD.md; no STATS-CONTRACT.md
git grep -n -i -E 'prereg.*(commit|order|ancestor)|merge-base --is-ancestor' -- scripts test server
#   known-nonzero control: finds scripts/weekly-construction-grade.mjs:57 (the grep can see a prereg guard);
#   no ancestry / first-commit comparison anywhere
git grep -n -E 'HX-01'   # only a prereg addendum mentions it: the historical harness is not merged
```

**Decision: EXTEND, not rebuild.** `STATS-METHOD.md` stays the one producer of
the rules. `docs/STATS-CONTRACT.md` is the short entry point every unit reads:
it indexes the eight rules by link (no second copy), adds the three missing
rules (clustered CIs, forward-only grading for anything an LLM touched, the
ESPN comparison), and carries the fill-in prereg template. **BUILD** the check
script, because nothing compares a results file's first commit with its prereg
file's first commit.

**Statistical unit?** No. GR-05 produces no model number (no projection,
availability, odds, trade value, share or threshold), so no pre-registration is
written and no 2025 look is taken; the holdout ledger is untouched.
