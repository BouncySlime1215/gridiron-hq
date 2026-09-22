# The `wired` total counted betting-only reach as fantasy product

RED `01302e0` · GREEN this commit · `scripts/inventory.mjs`,
`test/inventory-betting-only-grade.test.js`, `docs/inventory/inventory.json`,
`docs/inventory/INVENTORY.md`

`docs/inventory/CONTRACT.md` on PR #99 (`ea7a208`) added the
`wired-betting-only` grade: reachable, and reachable **only** through
`routes/nfl-market.js`, `routes/nfl-betting.js` or `routes/betting-hub.js`.
Betting is out of scope for this product, so such a row is genuinely served and
served somewhere the product is not meant to be using. Counting it inside the
fantasy `wired` total overstates how much of the product is connected, and the
overstatement grows with exactly the rows a reader is least likely to check.

## The count moved

| | before | after |
|---|---|---|
| `wired` | 72 | **53** |
| `wired-betting-only` | — | **19** |

53 + 19 = 72. Nothing was dropped; a test asserts that sum so a future change
cannot lose a row between the buckets. No other status moved: 541
`unclassified`, 183 `half_done`, 56 model, 15 `dead`, 10
`referenced_but_never_created` and 3 `silently_broken` are unchanged.

The 19: 18 pipelines (`betting-fantasy-link`, `nfl-abstention-audit`,
`nfl-context-heads`, `nfl-coordination-audit`, `nfl-execution-attribution`,
`-corridor`, `-decision`, `-exposure`, `nfl-family-contribution`,
`nfl-opponent`, `nfl-page-explain`, `nfl-passing-diagnostic`,
`nfl-prop-grading`, `nfl-prospective-collection`, `page-explain-tools`,
`pick-reasoning`, `system-connectivity`, `trial-statistics`) and one route,
`route:betting-hub`.

## How many rows needed re-tracing: none, and why that is not an evasion

The contract's sweep says any row graded `wired` from a walk that stopped at the
first entry point has not been tested against the grade. **`inventory.mjs` never
walked paths at all.** `reachesLiveSurface()` (`scripts/inventory.mjs:136`) asks
only whether `wiring.route_families`, `wiring.jobs` or `wiring.pages` is
non-empty, and those are **complete enumerated sets** built by the wiring map,
not a first hit. So there was no first-path shortcut to undo, and the regrade is
a read of data already present rather than 72 hand traces.

Two things establish that, neither of them "the code looks right":

1. **The contract's own counterexample, in the data.**
   `player-week-engine.js` carries `/api/model@1` *and* `/api/betting@2` *and*
   16 more families in the same array — the row CONTRACT.md says must stay
   `wired` precisely because it has both. A first-path result cannot contain
   both.
2. **An independent unbounded walk.** I rebuilt reachability myself from the
   map's raw `imports` edges, BFS from every non-betting entry point with no hop
   limit — 158 of them (62 jobs, 2 client, 4 extension, 63 migrations, 27
   non-betting route families) — and asked which of the 19 any of them reaches.
   **None.** All 19 confirmed, by a derivation that shares no code with the one
   under test.

The map does carry a hop cap, `MAX_HOPS = 12` (`scripts/wiring-map.mjs:2361`),
which is the fixed-window shape this thread has been removing elsewhere. It does
not bind here, and that is measured rather than assumed: the **longest
route-to-module distance anywhere in this graph is 8 hops**. Nothing is
truncated at 12, so no family is missing from any set. Worth re-checking if the
graph ever deepens — a cap that does not bind today is not a cap that cannot
bind.

## The pseudo-entry-point that hid 13 of the 19

The first correct-looking implementation found **6**. The other 13 were being
disqualified by a single name.

`boot:server/index.js` appears in the `pages` bucket of 140+ modules. It is the
application root: it mounts every route, the three betting ones included, so it
reaches every reachable module in the repository. Treated as a non-betting entry
point, it makes the grade nearly unassignable — a module is betting-only only if
the app itself cannot reach it, which is never.

So it is excluded **by name**, and only it. Everything else in that bucket is a
real entry point and does disqualify: `client:` (`App.tsx`, `main.tsx`),
`extension:` (4), and the 63 `migration:` surfaces. Jobs disqualify too, and the
live example is in the artifact: `nfl-weather-response.js` reaches
`/api/betting`, `/api/nfl-betting` and `/api/nfl-market` and **nothing else**,
and stays `wired`, because `nfl_model_growth`, `evidence_daemon` and
`nfl_t60_runner` run it. That is reach that never touches a betting route.

The same trap caught the independent check: a first pass that included `boot:` as
an entry point reported all six candidates "reached by a non-betting entry
point", which would have concluded that no row in the repository is betting-only.

## Route files take the grade by identity, not by reach

Asking what reaches `nfl-market.js` is circular — it is reached through
`nfl-market.js`. So a route row qualifies by *being* one of the three, and only
when it would otherwise be `wired`: the grade refines reach and must not
manufacture it. `betting-hub.js` has a page caller, was `wired`, and moves.
`nfl-market.js` and `nfl-betting.js` reach no page, are `half_done`, and stay
there.

## Defect injection

Baseline `scripts/inventory.mjs` sha256 `e638ccb8c718…`, 10/10 in
`test/inventory-betting-only-grade.test.js`.

| # | mutation | sha256 after edit | result | killed by (title) |
|---|---|---|---|---|
| N1 | grade on the first path (`some` → `every`) | `1888c4d02b07…` | **9 pass / 1 fail** | `one non-betting path is enough to stay wired` |
| N2 | ignore job and page entry points entirely | `1fcb25d47571…` | **8 pass / 2 fail** | `a scheduled job is a non-betting entry point`, `client and extension and migration reaches are non-betting entry points` |
| N3 | stop excluding the app root | `95b6708ed8e6…` | **9 pass / 1 fail** | `the app root does not disqualify, because it reaches everything` |
| N4 | a module no route reaches counts as betting-only | `2810f3f5cdae…` | **9 pass / 1 fail** | `no route reach at all is not betting-only` |
| N5 | control: a comment above `bettingOnly` | `b043d67e95b4…` | 10 pass | — (no-op by construction) |

N1 is the defect the contract names; N3 is the one that actually bit. N5's
checksum moves while its result does not, so no green row is the harness failing
to apply an edit. The file was restored to `e638ccb8c718…` afterwards and
re-verified.

## Not reconciled, and said so rather than smoothed over

Across all 658 modules in the map, **67** are betting-only by this rule, 63 of
them under `server/services|betting|models`. Opportunity's reach grader is
reported as finding **51 of 319** service/modeling files reachable only via
betting routes. Those are different denominators — 319 files against my 658
modules — and possibly different entry-point handling, since the `boot:` and
`migration:` decisions above each move the answer by double digits. **The two
numbers are not yet reconciled and should not be quoted as agreeing.** When that
grader lands on #99, the right move is to run both over one file list and diff
the disagreements; a matching total would prove less than a matching set.

Only 19 of the 67 appear here, because the grade refines `wired`: the other 48
are `half_done` or `unclassified` and were never in the fantasy total to begin
with.

## The five questions

- **Well built?** The rule reads the complete surface sets the map already
  computes, excludes exactly one name and says why, and refines `wired` without
  inventing reach. Ten tests, four mutations killed.
- **Stats or made up?** Measured. Every number here — 72→53+19, the 8-hop graph
  diameter against a 12-hop cap, 140+ modules carrying `boot:`, 13 of 19 hidden
  by it, 67 across the map — is read off the real map and the real artifact.
- **How do we know?** Two independent derivations agreeing on the same 19, one
  of which shares no code with the generator, plus the injection table.
- **Pointed anywhere else on the platform?** Yes, and it is the same shape as the
  night's other findings: `boot:server/index.js` is a surface that reaches
  everything, so including it makes a reachability question answer "yes" always —
  the mirror image of a fixed window making it answer "no" at the tail. Any other
  reachability question asked of this map needs the same exclusion.
- **How does it unify?** A count is a claim. `wired: 72` was read as "72 pieces
  of the fantasy product are connected", and 19 of them were serving a surface
  this product is not meant to have.

---

# Addendum: two defects in this rule, found by diffing the sets

The section above closed with "the two numbers are not yet reconciled and should
not be quoted as agreeing", and said the right move was a set diff. Opportunity
did it, over `/mnt/project-files/reach-grade-server-all-2026-09-22.tsv` (458
tracked files under `server/`, post-fix). **52 of the sets agreed. 15 rows were
only mine and 2 only theirs, and most of the 15 were mine being wrong.**

## Defect 1 — a script in `package.json` is an entry point

`CONTRACT.md`'s `wired` test names "a route, a scheduled job, a script in
`package.json`, or the client". The first version of `bettingOnly()` ignored the
map's `scripts` bucket entirely, because `reachesLiveSurface()` ignores it. That
is correct for `reachesLiveSurface` — a script is not a live *surface* — and
wrong here, because this question is not "what surface serves this row" but "is
every way in a betting route", and `npm run build:role-scenario-lab` is a way in.

**12 rows measured wrong.** Each has a `scripts` entry that `package.json` names:
`nfl-blind-audit.mjs` (4 rows), `build-role-scenario-lab.mjs` (3),
`run-news-event-impact.mjs` (2), `build-evidence-dataset.mjs`,
`diagnose-passing-components.mjs`, `audit-passing-specialists.mjs`.

**One of the 12 is `role-scenario-engine.js` — `CONTRACT.md`'s own worked
example for this grade.** The contract says it "reaches an entry point only as
`<- role-scenario-lab.js <- nfl-research-lab.js <- routes/nfl-market.js`, so it
takes this grade". It also reaches `scripts/build-role-scenario-lab.mjs`, which
is `npm run build:role-scenario-lab` in `package.json`. The specimen does not
satisfy its own rule, and both graders had to get the rule right before that was
visible.

**A hand-run script still does not disqualify**, and that is the same contract
speaking: "Record it as `reached from: hand-run script`, never as `wired`."
Nothing in the repository causes one to run. So the test is `package.json`
membership, not the existence of a script.

## Defect 2 — a betting prefix is a prefix

`server/routes/wong.js` is mounted at `/api/betting/wong`, under the betting hub.
Comparing family names against the three prefixes for **equality** turns a
sub-path of a betting surface into a fourth, non-betting one. Now matched on
prefix with a `/` boundary, so `/api/bettingsomething` still does not join the
family.

## The count, corrected

| | before the regrade | first version | corrected |
|---|---|---|---|
| `wired` | 72 | 53 | **55** |
| `wired-betting-only` | — | 19 | **17** |

55 + 17 = 72 still. `pipeline:nfl-passing-diagnostic` and
`pipeline:pick-reasoning` moved back to `wired`.

## What the boot question turned out to be

Opportunity re-ran all 319 of its files with and without `server/index.js` as an
entry point: **identical tallies, zero grade changes**. Its grader drops the
`server/index.js -> server/routes/*` edges rather than excluding the file,
because a mounted route is already an entry point while everything *else*
`index.js` imports — the scheduler, legacy-access — is genuinely reached at boot.

**That rule is better than mine, and I checked rather than assumed.** Re-running
the BFS from `index.js` with only the boot→route edges dropped reaches 229
modules, and **0 of the 67** my by-name exclusion calls betting-only. So the two
rules agree on this graph, and mine is right here by coincidence rather than by
construction: a module reached from `index.js` via the scheduler but not via any
route would be graded betting-only by mine and `wired` by theirs. No such module
exists today. `test/inventory-betting-only-grade.test.js` keeps the by-name
exclusion, because `inventory.mjs` reads the map's precomputed surface sets and
does not walk edges at all — re-implementing the walk to drop two edges would
duplicate the map's job to reach the same answer.

## What remains unreconciled, and whose it is

Five rows, down from seventeen:

| row | mine | theirs | reading |
|---|---|---|---|
| `routes/wong.js` | betting-only | `wired` | **Mine.** Mounted at `/api/betting/wong`. |
| `betting/nfl/strategy/teaser-scan.js` | betting-only | `wired` | **Mine**, same cause — its only entry is `wong.js`. |
| `services/nfl-evidence.js` | `wired` | betting-only | **Contract gap**, see below. |
| `services/nfl-profitability.js` | `wired` | betting-only | Same. |
| `services/nfl-features.js` | betting-only | `wired` | **Unresolved.** Their row gives it `scripts/nfl-blind-audit.mjs`; my map records no script reach for it at all. Their TSV is computed on #99's branch and my map on mine, so this may be tree drift. It needs one run of both on one tree, not an argument. |

**The contract gap.** Both remaining "only theirs" rows carry
`/api/execution-slate` alongside their betting families, and
`server/routes/execution-slate.js` is a betting-execution surface that
`CONTRACT.md`'s three-file list does not name. `wong.js` is the mirror image —
a betting route file the list also does not name, which my prefix rule catches
only because it happens to be mounted *under* `/api/betting`. So the list of
three is incomplete, and which surfaces belong on it is a contract decision
rather than a grader's. Raised, not decided here.

## On the dynamic-import false negative

62 of the 91 files Opportunity's grader calls unreached are `server/migrations/`,
loaded by `readdirSync` plus a computed `import()` at `server/db/migrate.js:49`
(`await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href)`).

**My walk does not resolve that edge either.** `scripts/wiring-map.mjs` handles a
dynamic import with a *literal* specifier (`await import('./x.js')`, :572-580);
a computed path is invisible to it, as it is to any graph built from specifiers.

It did not matter for this question, and the reason is specific rather than
lucky: the map already carries all 63 migration files as `migration:` surfaces,
and my independent check seeded its BFS from every one of them as an entry point
in its own right — which subsumes the missing edge instead of resolving it.
Separately, **no inventory row is a migration FILE**, which is the thing their 62
counts. `KINDS` is model, pipeline, job, route, page, table and script; there is
no migration kind, and no row's unit is a migration module. 59 rows do carry a
`server/migrations/` path, and every one of them is `kind: table` citing the
migration that creates it — `table:audit-log` at
`server/migrations/002_platform_audit_log.js:4`, and so on. A table row's reach
is computed from the code that reads the table, never from whether the file
holding its `CREATE TABLE` is imported, so the dynamic-import blind spot does not
touch them either.

(The first draft of this paragraph said "0 rows under `server/migrations/`". That
was written before the query ran and is wrong: the answer is 59, all of them
tables. The claim it was making — that their 62 unreached migration *files* have
no counterpart in my artifact — survives, but it needed the real number to be
worth anything.)

So I quote no "unreached" figure over migrations, and the 62 is a fact about
their file population, not a disagreement with mine.
