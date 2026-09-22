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
