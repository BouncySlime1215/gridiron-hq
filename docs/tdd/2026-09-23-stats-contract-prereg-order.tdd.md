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

## 2. RED

`b074d1dd` test: RED, a results file committed before its prereg must fail the check (GR-05).
`test/check-prereg-order.test.js`, 11 cases at that sha, all failing on the first assertion:

```
not ok 2 - FAILS when the results file is committed before its pre-registration (acceptance)
  error: scripts/check-prereg-order.mjs must load: Cannot find module '.../scripts/check-prereg-order.mjs'
# (same assertion in all 11 cases; the script did not exist on 89f69b3b)
```

## 3. GREEN

- `32cfd269` feat: GREEN, scripts/check-prereg-order.mjs fails when results predate their prereg (GR-05). 11/11 pass.
- `3e0dc29d` feat: check a branch by --rev, and date a file by its oldest add so merged-back PR branches are judged on their own commits (GR-05). This came from the real-data run in section 5, where the first version dated files by main's squash commit on branches that had merged main back. 14/14 pass after `3ab3a20c`.

Command (for every test count in this file): `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr05-XXXX).sqlite node --import ./test/offline-guard.mjs --experimental-test-module-mocks --test --test-reporter=tap test/check-prereg-order.test.js`. Tree: branch head `3ab3a20c`. Result: `# pass 14 # fail 0 # skipped 0`.

## 4. What it does

- `scripts/check-prereg-order.mjs` pairs each results file with its prereg. By name, the two files share a directory: `<stem>-prereg(istration).md` (plus `-addendum-N` / `-amendment-N`) goes with `<stem>.*` or `<stem>-result(s)|output|outcome|findings.*`. By marker, a Markdown file names its prereg in a `<!-- prereg: path -->` line. The check fails when the results file's first commit does not descend from the prereg group's first commit (`git merge-base --is-ancestor`). The first commit is the **oldest** add on `git log --follow`. A rename is followed back to the older name. A copy counts as a new file, so an identical-content twin elsewhere cannot date a file earlier.
- Exit 0 means ok and 1 a violation. A shared (squash) commit is reported and passes, and fails under `--strict`. Exit 2 is a shallow clone, which gives no verdict rather than a pass. Exit 3 is any other error, including an option-shaped `--rev`.
- `--rev <ref>` checks any branch without checking it out: it reads `ls-tree` and `git show` from that ref.
- Wiring: `test/check-prereg-order.test.js` is a `test/*.test.js` file, so `npm test` runs it, and so does the CI step "Test" (`.github/workflows/ci.yml`). `npm run check:prereg-order` runs the script by hand. The real-repo case skips itself on a shallow checkout, which is what CI gets. Proven in a depth-1 clone of this branch: `ok 14 ... # SKIP shallow checkout`, `# pass 13 # skipped 1`. The CLI there printed the shallow message and returned `exit=2`.
- `docs/STATS-CONTRACT.md` is the entry point. It links STATS-METHOD rules 1-8 instead of copying them and adds rule 9 (clustered CIs), rule 10 (forward-only grading for LLM-touched output) and rule 11 (win rate vs ESPN, historical). It also holds the 14-field prereg template and says what CI proves and what it does not. Both look-ahead citations were checked by web search on 2026-09-23: arXiv:2309.17322 and SSRN 4754678 (ICML 2025).

## 5. Numbers (each with command and tree)

| Claim | Value | Command | Tree |
|---|---|---|---|
| Pairs found in this repo (docs/evidence + docs/tdd) | 6 pairs, 0 violations, 6 same-commit | `node scripts/check-prereg-order.mjs` | `3ab3a20c` (history of `89f69b3b` main) |
| Why all 6 are same-commit | main is squash-merged, so each PR's prereg and results share one commit | same output, shas `b3e79709`, `26a5002a`, `51b64512`, `bd56319b` | `3ab3a20c` |
| Pre-squash branches, where the order is provable | 4 distinct pairs, 0 violations. R25: prereg `9a08fc31` -> results `44944a94` (origin/shrinkage-efficiency-weighting). target-share-prior: `d2f04ff4` -> `5b529a95` (pr/68). weekly-construction-grade: `dd4d2055` -> `0f397736` (origin/claude/local-s-02-weekly-construction-grade). remove-mlb: `8c0afdf7` -> `fc2db402` (origin/claude/project-thread-o3wt2p-remove-mlb) | `node scripts/check-prereg-order.mjs --rev <ref> --json` | branch head `3e0dc29d` script |
| Known-nonzero control for the "0 violations" | the fixture with results committed first fails (test 2); the merged-back-branch fixture fails at `--rev feature` (test 12) | test file | `3ab3a20c` |
| Whole-repo scan (`--prefix .`) | first run: 1 violation, my own `docs/STATS-CONTRACT.md` quoting a marker with a `...` path (true positive); after rewording: ok, 7 pairs | `node scripts/check-prereg-order.mjs --prefix .` | pre-`3ab3a20c` working tree, then `3ab3a20c` |
| Default scan runtime | 7.7 s wall for 826 commits | `time node scripts/check-prereg-order.mjs` | `3e0dc29d` |
| Lint-equivalent syntax and wiring | `node --check` ok on both files; `node scripts/wiring-map.mjs --check` exit 0, "no missing-feed findings" | as named | `32cfd269` |

### 5a. Skeptic round 1: head failed its own check (fixed)

The skeptic was right. At `997469c5` this file's section 4 quoted a marker in inline code, and the old `MARKER_RE` matched it anywhere, so it read as a marker pointing at an uncommitted file named `path`. `node scripts/check-prereg-order.mjs` printed that VIOLATION and exited 1, and the test file gave `# pass 13 # fail 1` (not ok 14, the real-repo case). My earlier "pass 14 / 0 violations" rows ran on `3ab3a20c`, before this file existed. CI missed it because the real-repo case skips on a depth-1 checkout.

Fix, in the checker rather than by rewording this file: a marker now counts only when it stands alone on its own line (leading and trailing spaces allowed). A marker quoted mid-line, in prose or inline code, is ignored. `docs/STATS-CONTRACT.md` and the script header say so.

| Claim | Value | Command | Tree |
|---|---|---|---|
| RED | `# pass 14 # fail 2`: not ok 8 (quoted-marker fixture) and the real-repo case | test command below | `953d2ca0` |
| GREEN | `# pass 16 # fail 0 # skipped 0` | test command below | `a50f8dbe` |
| This repo, default prefixes | ok, 6 pairs, 0 violations, 6 same-commit, exit 0 | `node scripts/check-prereg-order.mjs` | `a50f8dbe` working tree |
| Whole repo | ok, exit 0 | `node scripts/check-prereg-order.mjs --prefix .` | `a50f8dbe` working tree |
| Mutant: drop the start-of-line anchor | KILLED (not ok 8) | sed on the regex, run, restore | `a50f8dbe` |
| Mutant: drop the end-of-line anchor | KILLED (not ok 8) | same | `a50f8dbe` |
| Mutant: drop the multiline flag | KILLED (not ok 6, 7, 9) | same | `a50f8dbe` |

Test command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr05-XXXX).sqlite node --import ./test/offline-guard.mjs --experimental-test-module-mocks --test --test-reporter=tap test/check-prereg-order.test.js`. The final numbers on the pushed head are in the report for that commit.

## 6. Mutation sweep

Script: `scratchpad/gr05-sweep.mjs`, not committed. It applies one string replacement, runs the test file, restores the file, and at the end checks `git status` (clean after every mutant, apart from the uncommitted test edit it was run against). Tree: `3e0dc29d` plus the rev-message assertion that `3ab3a20c` committed.

| Mutant | Result |
|---|---|
| M1 ancestry check inverted | KILLED (8 fail) |
| M2 same commit silently ok (not reported) | KILLED (3) |
| M3 copies followed past (twin dates the file) | KILLED (2) |
| M12 newest add wins instead of oldest | KILLED (1) |
| M13 call site: `--rev` not passed to `git log` | KILLED (2) |
| M14 option-shaped `--rev` guard removed | KILLED (1), after the test was tightened to match the refusal message; it survived the first sweep because git also errors with exit 3 |
| M4 anchor = latest prereg | KILLED (1) |
| M5 shallow guard removed | KILLED (1) |
| M6 call site: CLI always exits 0 | KILLED (3) |
| M7 call site: `--strict` ignored | KILLED (1) |
| M8 marker regex broken | KILLED (2) |
| M9 `.tdd.md` paired by name | KILLED (1) |
| M10 uncommitted prereg treated as pending | KILLED (1) |
| M11 prefix ignored | KILLED (2) |
| Designed survivor: tie order (amendment named before base in the same squash) | SURVIVED, as designed: it changes which file the report names, not the verdict |
| Designed survivor: `npm run check:prereg-order` path typo | SURVIVED, as designed: no test runs the npm alias; CI reaches the script through the test file's import |
| Not-applied control | NOT APPLIED (the sweep reports it and does not count it as a pass) |

## 7. Known defects and limits

1. **CI checks out at depth 1**, so in CI the real-repo case skips, and only the fixture cases (which carry the acceptance) run. Follow-up: set `fetch-depth: 0` on the checkout step in `.github/workflows/ci.yml` so every PR branch is scanned. That needs a file grant, which this unit does not have.
2. **Squash merges** mean main alone can never prove order: 6/6 pairs are same-commit there. The verdict lives on the PR branch (`--rev`, or a local run before pushing).
3. **Pairing is by naming convention or marker.** A results file named differently from its prereg is not checked. The start-sit gate's evidence is one example: `docs/tdd/2026-09-22-start-sit-baseline-gate.tdd.md` has no marker. The contract tells units how to name files, and existing files are not edited here (one editor per file).
4. `git log --follow` follows a single name and uses git's similarity heuristic. A rename with less than 50% similarity counts as a new file. That can only make a file look newer, so the check misses a case rather than raising a false violation.
5. `docs/evidence/STATS-METHOD.md` does not link back to `docs/STATS-CONTRACT.md` yet. It is S-00's file, so the back-link is a follow-up.

## 8. Holdout looks

None. GR-05 produces no model number and took no look at 2025.

## 9. Nick's five questions

1. **Well built?** One script with pure, exported helpers (`preregStem`, `resultStem`, `firstAddCommit`, `checkPreregOrder`). The tests use fixture repos with hermetic git (no global config, hooks or signing). 14 tests, 14 mutants killed, 2 designed survivors, 1 not-applied control.
2. **Stats or made up?** No model numbers. Every count above comes from a named command on a named tree. The two look-ahead papers were verified by search. The Brill et al. and Cameron-Gelbach-Miller citations are the ones already in `server/services/backtest-significance.js` and standard references. The Cameron-Gelbach-Miller volume and issue come from memory, not re-fetched: a guess-level detail.
3. **How do we know?** The acceptance fixture fails when results come first and passes otherwise (tests 2 and 3). Real branches: 4 pre-squash pairs were checked and are correctly ordered. The whole-repo scan caught a true positive in this unit's own draft.
4. **Pointed elsewhere?** The CI test runs from `npm test`. `npm run check:prereg-order` and `--rev` let the coordinator check any branch. The contract is linked from its own evidence and points at STATS-METHOD, HOLDOUT-LEDGER and the gate producers by file:line.
5. **How does it unify?** One rulebook producer (STATS-METHOD), one entry page (STATS-CONTRACT) and one enforcement script. The contract names the canonical producers for clustered CIs (`pairedBootstrapDiff`, `pigeonholeBootstrap`), MDE and win rate (`gradeDecisions`) and the ESPN baseline (`league_roster_snapshots.projected_points`) so units reuse them instead of writing new ones.
