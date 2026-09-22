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
| Does main store a trade outcome anywhere? | No. `git grep "trade_outcomes\|trade-outcomes\|outcome_ledger"` over `server scripts client/src test` returns nothing. Control: the same grep for `trade_proposal_cache` finds 10 lines in 3 files (7 in `060_trade_proposal_cache.js`, 2 in `trade-proposals.js`, 1 at `scripts/verify-trade-brain-live.mjs:209`; `git grep -n trade_proposal_cache bd56319b -- server scripts client/src test \| wc -l` → 10), so the grep can find a table that exists. An earlier draft said 9; that is the count for `-- server` alone. | `git grep -n "trade_outcomes\|trade-outcomes\|outcome ledger\|outcome_ledger" origin/main -- server scripts client/src test` |
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
calls `rollbackMigration('067_outcome_ledgers')` by hand.

**Nick's word on migration 067: NOT on record. Merge waits (WORK-QUEUE N9).**
Merge gate v2 §5 needs Nick's own word for a migration. What exists:

- Nick's GO, message `cmsg_01YAsw8AnFv4ioRMQw8dfPmT8hKXRheXe6eCXwGuAPPEAb`,
  2026-09-22 01:25Z, item 4, verbatim from the handoff's copy
  (`PLAN-ITEMS-1-25.md`, `memory/gridiron-go-plan-2026-09-22.md`): "Trade-acceptance
  outcome logging contract; first real row gated on Nick's ESPN cookie, never
  faked." It names the contract. It does not name a migration, a table, or `067`.
- A coordinator note (~19:10Z) reads that GO as covering 067. That reading was
  relayed to this thread; I did not read Nick's words saying so. By the naming
  test in `memory/verify-the-go-before-acting.md`, a relayed conclusion is not
  the go.
- `WORK-QUEUE.md` N9 still lists "#94 067 (confirm GO covers)" as NICK-ONLY,
  "merge waits".

So this PR is built and tested on local copies, and it does not merge until
Nick's own words naming 067 are quoted here and in the PR body, with the
message id and time.

## 2. Liveness on the merged tree: the PR's own record still holds

All runs below are on this Mac, Node v25.9.0, targeted files only, each with
`SCHEDULER_DISABLED=1` and `GRIDIRON_DB_PATH` on a fresh `mktemp` path. "Unfixed"
means `origin/main` `bd56319b` (tree `67fd4d465e8e`), exported with `git archive`
into a scratch directory, with the test file copied in.

| what | tree | result |
|---|---|---|
| RED `92f31b7d` "test: RED — the trade outcome ledger, before it exists", its test file on unfixed code | `bd56319b` + `92f31b7d:test/trade-outcomes.test.js` | exit 1, `tests 1, pass 0`: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/server/services/trade-outcomes.js'`. It still fails for the reason it was written. |
| the PR head's `trade-outcomes.test.js` on unfixed code | `bd56319b` + `8f940546:test/…` | exit 1, the same `ERR_MODULE_NOT_FOUND` |
| the PR head's `trade-tactics.test.js` on unfixed code (the one production behaviour change in `trade-tactics.js`) | `bd56319b` + `8f940546:test/…` | exit 1, `tests 39, pass 36, fail 3`: the three G5b tests (timingRead absence, the programming-error throw, vetoClimate absence) |
| the same two suites on the merged head | `8f940546` (tree `3f0f21c9e744`) | `trade-outcomes` 31/31, `trade-tactics` 39/39 |
| RED `92f31b7d`'s test file on the merged head | `8f940546` | 15 of 17 pass. The two that fail (G3, G4) assert a bare midpoint is accepted, which `762cb868` "fix: the ledger records the band the model states, never a point it does not" deliberately changed. Expected; the current file carries the changed assertions. |
| tree-scanning tests the merge could affect | `8f940546` | `inventory-table-locality` 3/3, `mlb-removed` 5/5 |

**The sweep did NOT reproduce as committed, and the harness was the reason.**
`node docs/tdd/sweeps/trade-outcomes.mutations.mjs` on `8f940546` printed

```
rows 34 | killed 0 | survived 32 | bad 0 | control SURVIVED | not-applied control BAD_ROW
```

while listing the failing test lines next to every "SURVIVED" verdict. The
harness read its kill count from a `# fail N` line and defaulted to 0 when the
line was missing. Node 25's default reporter for a pipe is `spec`, which prints
`ℹ fail 1` instead; Node 22 (CI, and the container the PR was written in)
prints `tap`. So on this Mac every row scored SURVIVED.

Fix, `b11b74c7` "test: the ledger sweep pins its reporter and refuses a count it
could not read": `--test-reporter=tap` pinned, and a missing count is now a
BAD_ROW, not a zero. On `b11b74c7` (tree `963613d21381`; the code under test is
byte-identical to `8f940546`):

```
$ node docs/tdd/sweeps/trade-outcomes.mutations.mjs
rows 34 | killed 32 | survived 0 | bad 0 | control SURVIVED | not-applied control BAD_ROW
$ SWEEP_REPORTER=spec node docs/tdd/sweeps/trade-outcomes.mutations.mjs     # known-nonzero control for the new guard
rows 34 | killed 0 | survived 0 | bad 33 | control BAD_ROW | not-applied control BAD_ROW
```

The first line is the acceptance figure (34 rows, 32 killed, both controls
behaving). The second shows the new guard firing: with a reporter that prints
no `# fail N`, every applied row is refused instead of being scored.

## 3. The defect the merged tree still carried: the recorder read shapes no producer emits

Verifying the consumer rather than the producer (merge gate v2 §4): the route
at `server/routes/trades.js:777` hands `recordProposalSlate` the engine's deals
and the proposals pass's result. The recorder read neither in its real shape.

| the recorder read | the producer emits | effect on the real route |
|---|---|---|
| `proposal.idea_id` | `proposal.idea_ids`, a list (`trade-proposals.js` `REQUIRED_PROPOSAL_FIELDS`, checked by `verifyProposals`) | nothing counted as sent: every sent idea written `considered_only`, "the model did not select it" |
| `rejected[].idea_id`, `.reason` | `{ proposal, violations }` (`verifyProposals` return) | the verifier's words never recorded |
| `idea.give` / `idea.get` | `i_give` / `i_get` (`trade-engine.js:1691`) | `give_json` and `get_json` stored as `[]` |
| `idea.counterparty.roster_id` | `partner_id` (`trade-engine.js:1689`); `counterparty` is the manager read and has no roster id | `counterparty_team_id` always null |
| (any result) | a refused run: `call_failed`, `unreadable`, … (`proposalsFor`) | a run that never reached the model written as a slate of non-selections |

Every slate test passed because the fixtures used the invented shapes too. The
same shapes predate this PR's RED (`d.id = ideaKey(d)` and `idea_ids` both
arrived in `cfa0e6f2`), so this was never correct; the merge did not cause it.
It matters before merge because the route writes on every non-cache proposals
call, and a wrong row in production cannot be deleted without Nick's word.

Also fixed, same file: `partiesOf` and `sidesOf` parsed `items_json` inside a
catch that defaulted to `[]`, so a corrupt payload was reported as "the raw row
names no counterparty in its items". It now says the items could not be read.

**RED** `88ed3722` "test: RED — the ledger read the proposals run in shapes no
producer emits", on the unfixed service (identical to `8f940546`):

- `test/trade-outcomes.test.js`: 36 tests, 9 fail. At `:503`
  `assert.equal(r.proposed, 1)` got `0 !== 1`; at `:657` (the result built by
  the real `proposalsFor` and verifier) `assert.equal(r.proposed, 1, 'the one
  proposal the verifier passed is app_proposed')` got `0 !== 1`; at `:685`
  `assert.equal(r1.state, 'no_decision_made')` got `'recorded'`; at `:203` the
  corrupt-JSON skip reason was `'the raw row names no counterparty in its
  items, and a deal with one side is not a deal'`.
- `test/trade-outcomes-route.test.js` (new; the real route, proposals pass,
  verifier, cache and migration, with `findTrades` and `callClaude` stubbed):
  3 tests, 1 fails. At `:134` `assert.equal(res.body.outcome_ledger.proposed, 1)`
  got `0 !== 1`: through the real route, the one proposal the verifier passed
  was not recorded as sent.

**GREEN** `031e4931` "fix: GREEN — the ledger reads the proposals run as it is
shaped": `trade-outcomes` 36/36, `trade-outcomes-route` 3/3, `trade-tactics`
39/39. On the final head `b2c2d500`, with the `npm test` offline guard
(`NODE_OPTIONS='--import ./test/offline-guard.mjs'`): the same three plus
`trade-proposals` 55/55.

## 4. The sweep, extended to the new code and the call site

`b2c2d500` "test: sweep rows for the producer shapes, the call site, and a
designed survivor" added M33-M40 (each puts back one invented shape or removes
one new guard), C1-C7 (each changes one argument or line at the call site in
`routes/trades.js`, which no row touched before), and C-EQUIV, an equivalent
mutant at the call site that must survive (`lg.season ?? null` → `lg.season`;
the column is never undefined, and `requireFields` treats null and undefined
alike).

```
$ node docs/tdd/sweeps/trade-outcomes.mutations.mjs          # b2c2d500, tree 97b82992b071
rows 50 | killed 47 | survived 0 | bad 0 | control SURVIVED | not-applied control BAD_ROW | designed survivor SURVIVED
tree before = tree after = 97b82992b0716ed0428a78271227027adab75490, working tree clean
wall 72 s
```

Every M33-M40 and C1-C7 row was killed, by the suites named in the file.

Re-run after `1898948e` "test: the route test reads a body as JSON only when the
server says it is", because that commit changed a suite the C rows depend on:

```
$ node docs/tdd/sweeps/trade-outcomes.mutations.mjs          # 1898948e, tree 45bc29a9b6bb
rows 50 | killed 47 | survived 0 | bad 0 | control SURVIVED | not-applied control BAD_ROW | designed survivor SURVIVED
tree before = tree after = 45bc29a9b6bbc1a831d0ba231b07cf0052bb2953 (two uncommitted doc files, unchanged across the run)
wall 63 s
```

## 5. What it does, and what it does not

**Does:** migration 067 creates `trade_outcomes` and `trade_outcomes_synthetic`.
The writers are all in `server/services/trade-outcomes.js`: `settleObservedOutcomes`
(:113, insert at :167), `recordProposedOutcome` (:234), `recordConsideredOnly`
(:262), `recordSyntheticOutcome` (:286, the synthetic table only), and
`recordProposalSlate` (:321), which the route calls. The route is
`GET /api/trades/:leagueId/proposals` (`server/routes/trades.js:741`, the call
at :783 on `cd444d78`), and the ledger's state reaches its response as
`outcome_ledger` (:789).

**Does not:**
- **No observed row, and no caller for the observed writer.**
  `settleObservedOutcomes` has no caller outside tests on this tree
  (`git grep -n "settleObservedOutcomes" -- server scripts` finds only its
  definition; the same grep for `recordProposalSlate` finds the route, so it can
  find a caller). The first real observed row needs three things: Nick's ESPN
  cookie on the live collector (NICK-ONLY N1), F-06's derivation proof on real
  transactions, and then a caller. The caller is deliberately not added here: it
  would write production rows from real ESPN data before anyone has checked the
  derivation on real data.
- **No reader.** `outcomesFor` (:420) has no caller. The calibration read is a
  follow-on.
- **`countered` and `expired`** are allowed by the CHECK and nothing writes them.

## 6. Known defects and what would make this wrong

- The line cites in the PR's own code comments (`counterparty-pricing.js`
  "around :815", `manager-signals.js` "around :190") are from `654ff93`. On
  `bd56319b` those passes are at :1071 and :210. They are comments, and this pass
  left them alone.
- The route test stubs `findTrades`. If the engine renames `partner_id`,
  `i_give` or `i_get`, the route test's stub will not notice. The service test's
  real-producer case builds the band with the real `acceptanceBand` and the
  result with the real `proposalsFor`, but the deal itself is still built by
  hand. A deal from a real `findTrades` run is the one shape nothing here builds.
- **What would make it wrong:** a proposals result shape other than
  `{ proposals: [{ idea_ids }], rejected: [{ proposal, violations }] }` reaching
  the route, or an engine deal without `partner_id` / `i_give` / `i_get`.

## 7. Nick's five questions

1. **Well built?** Yes, now. It stores what was already being computed and thrown
   away, and this pass made its one real writer read the producers' actual
   shapes. Before this pass, the only writer that runs in production would have
   recorded every sent trade as "not selected", and (found by review, §9) with no
   proposing team on any row the app's own page writes.
2. **Stats or made up?** No statistic is produced. The ledger records the
   acceptance model's band and basis as the model states them (`fitted: false`,
   "not a calibrated probability"). Nothing here is a model number.
3. **How we know:** no backtest; this is a recorder. RED and GREEN on the unfixed
   and fixed code (§2, §3, §9), a 53-row mutation sweep with 50 killed, no
   unexpected survivors, one designed survivor, and both controls behaving (§9),
   and the real route on a local copy of the database (§9).
4. **Pointed anywhere else?** Nothing reads it yet. The one writer that runs in
   production is the proposals route. The observed writer has no caller (§5).
5. **How it unifies:** it is the join that did not exist: what the app predicted,
   what it sent, what it considered and dropped, and later what ESPN says
   happened, keyed by `(league_id, season, idea_id | espn_tx_id)`. C-08
   (considered-not-proposed plus counters) and F-06 (observed derivation) extend
   this table rather than making a new one.

## 8. Merge gate status for this head

- §1 guard: the branch contains `origin/main` `bd56319b` (merge `8f940546`).
  `npm ci` was skipped: `package-lock.json` is byte-identical to the main
  checkout's (`cmp`), and that checkout's `node_modules` is symlinked in.
  `npm run check` has **not** been run in this pass. The unit's Gate phase runs
  it once, on the pushed head, and records the result in the PR body. The one
  gate stage run here was `node scripts/wiring-map.mjs --check`, which exited 0
  on `031e4931`.
- §2: RED/GREEN above. All of `92f31b7d`, `e363b35c`, `88ed3722`, `031e4931`,
  `b2c2d500`, and (skeptic pass, §9) `1ea59528`, `f953a5d6`, `74d0ad7c` and
  `cd444d78` are ancestors of the pushed head.
- §5: no bare catch was added (the one in the route test was replaced in
  `1898948e`). All SQL is parameterised. No credential column is read or
  written. The only migration is additive `067`, and Nick's own word on it is
  not yet on record (§1, N9): merge waits. Nav, pages and the client are
  untouched.
- Main moved during this pass. `f9cf30a8` merges `origin/main` `d6d7bd5a`
  (#116). That merge touched only `scripts/symbol-reach.mjs`, its test, and its
  doc (`git diff --name-only 6a61a905 f9cf30a8`). The `server` subtree hash is
  `3fa8b5079d19` on both `1898948e` (where the 50-row sweep ran) and `f9cf30a8`,
  and so is every swept file's blob. So the figures above describe the pushed
  code. `test/symbol-reach-two-counts.test.js` passed 18/18 on `f9cf30a8`.

## 9. Skeptic pass: two gaps reviewers found on `169ada38`, and one count

Three independent reviewers re-ran this unit's claims on `169ada38` (tree
`067017c2ba8e`). Their blocking findings, and what this pass did:

### 9a. Every live row had `proposer_team_id` NULL (fixed)

The route passed `proposerTeamId: req.query.team_id ?? null`. The app's only
caller, `client/src/components/brain/ProposalSlate.tsx:242` (mounted from
`client/src/pages/TradeBrain.tsx:126`), calls `/trades/${leagueId}/proposals`
and sends no `team_id` (`git grep -n team_id -- client/src/components/brain/ProposalSlate.tsx`
→ 0 lines; control: the same grep over `client/src` finds `api.ts`,
`EspnConnect.tsx`, `EspnConnectGate.tsx`). `findTrades` still priced the slate
for the league's own team (`trade-engine.js:1518`) and returned it as
`found.me.roster_id` (`:1817`), which the route dropped. Every route test sent
`?team_id=1`, so none used the client's shape. Table `trade_outcomes`; writers
`recordProposedOutcome` (`server/services/trade-outcomes.js:234`) and
`recordConsideredOnly` (`:262`), via `recordProposalSlate` (`:321`).

**RED** `1ea59528` "test: RED — the ledger stamps the query's team, not the team
the slate was priced for". The `findTrades` stub now returns `me` the way the
engine does, and two route tests are added: the client's call with no `team_id`
on a league whose own team is `'5'`, and an engine that prices for a team other
than the one asked for (`?team_id=99`, engine team `'1'`, the `teams[0]`
fallback at `:1518`). On the unfixed route: `trade-outcomes-route` 5 tests,
2 fail. At `:212` `assert.deepEqual([...new Set(written.map(r =>
r.proposer_team_id))], [own])` got `[null]` instead of `['5']`; at `:228` got
`['99']` instead of `['1']`.

**GREEN** `f953a5d6` "fix: GREEN — the ledger stamps the team the engine priced
the slate for": `proposerTeamId: found?.me?.roster_id ?? null`
(`server/routes/trades.js:784`). `trade-outcomes-route` 5/5, `trade-outcomes`
36/36. No query fallback: when `found` has no `me`, `findTrades` returned
`{ error }` with no deals, so there is nothing to stamp, and a query value the
engine did not use would be a wrong stamp, not a missing one.

**The real route on a local copy (local copy, not production).** Real route,
real `findTrades`, real `proposalsFor` and verifier, real ledger and migration
067; only `callClaude` stubbed (nothing paid); offline guard on. A fresh
`sqlite3 .backup` of the local database (sha256 prefix `6d33a780121d9870`),
copied once per code version. Script adapted from the reviewer's
(`scratchpad/f05-fix/e2e-proposer.test.mjs`; not committed).

| code | league | ledger | `proposer_team_id` values | equal to `leagues.my_team_id` |
|---|---|---|---|---|
| `169ada38` (unfixed, `git archive` export) | 1 | recorded, 1 proposed, 2 considered | `[null]` | false |
| `cd444d78` | 1 | recorded, 1 proposed, 2 considered | `["1"]` | true |
| `cd444d78` | 2 | recorded, 1 proposed, 11 considered | `["4"]` | true |

In all three runs `found.me.roster_id` equalled `leagues.my_team_id`, and no row
had its proposer equal to its own counterparty.

### 9b. The observed writer's package direction was untested (test added)

Swapping the two branches in `sidesOf` (`server/services/trade-outcomes.js:98-99`,
`give.push` ↔ `get.push`) passed every suite: on the old test file, with the swap
applied, `trade-outcomes` 36/36. G1 checked status, parties and stamps and never
read `give_json` or `get_json`. `74d0ad7c` "test: G1 pins the direction of the
observed package" asserts `give = [101]` and `get = [202]` for `items(1, 2)`
proposed by team 1. With the swap applied: 36 tests, 1 fails, G1 at
`test/trade-outcomes.test.js:140`, "give is what left the proposer's roster".
Without it: 36/36. The code was already right; this is a missing assertion, not
a defect. `settleObservedOutcomes` still has no production caller (§5).

### 9c. The sweep, with rows for both

`cd444d78` "test: sweep rows for the package direction and the engine's proposer"
adds M41 (the swap above), C8 (the route's old query-string proposer) and C9 (the
engine's team, but the query wins when both are present), and points C1-C4 at the
new call-site line.

```
$ node docs/tdd/sweeps/trade-outcomes.mutations.mjs          # cd444d78, tree 089db0cf6cfe
rows 53 | killed 50 | survived 0 | bad 0 | control SURVIVED | not-applied control BAD_ROW | designed survivor SURVIVED
tree before = tree after = 089db0cf6cfeb0380bbaf90a1d40a452ff0cdc7c, working tree clean
wall 75 s
```

M41 killed by G1 (`test/trade-outcomes.test.js:140`); C8 killed by both new route
tests (`:212`, `:228`); C9 killed by the engine-team test (`:228`); C4 killed by
three route tests. C-EQUIV (designed survivor) survived; CONTROL survived;
NOTAPPLIED came back BAD_ROW.

### 9d. Other runs on `cd444d78` (`server` subtree `6d1940c40e08`)

Each with `SCHEDULER_DISABLED=1`, `GRIDIRON_DB_PATH` on a fresh `mktemp` path,
and `NODE_OPTIONS='--import ./test/offline-guard.mjs'`: `trade-outcomes` 36/36,
`trade-outcomes-route` 5/5, `trade-tactics` 39/39, `trade-proposals` 55/55.
`node scripts/wiring-map.mjs --check` exit 0; its output has 0 lines matching
`trade_outcomes|trade-outcomes` (it does name other tables, e.g. `model_audit_log`).
`npm run check` is still left for the Gate phase.

### 9e. The control count

§1's control said 7 + 2 = 9 lines. The stated command gives 10 lines in 3 files
(the tenth is `scripts/verify-trade-brain-live.mjs:209`); 9 is the count for
`-- server` alone. Corrected in §1 and the PR body. The control's purpose (the
grep finds a table that exists) is unchanged.

### 9f. Migration 067

Not fixable by a builder. §1 now quotes what Nick's GO says and says what it
does not say. N9 stays open, and merge waits on Nick's own words.
