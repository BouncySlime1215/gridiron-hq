# Codex 6 handoff — what was done, and how

**Status: evidence, not a work queue.** The single active plan is
[`docs/CLAUDE-NEXT-STEPS.md`](../../CLAUDE-NEXT-STEPS.md). This file is the running record of the
work executed against the September 10 review, in the order that plan requires.

Started 2026-09-10. Branch `main`, from `bbcdae2`.

---

## Slice 0 — Reconcile

**What the plan asked for:** "Match latest files to C01–C17; preserve dirty edits and old evidence;
update this plan's status table." Exit evidence: an exact source/diff manifest, with no claim that
later changes were reviewed automatically.

### What was found

The review's "latest captured uncommitted source" — `nfl-t60-packet.js` v2, `server/db/schema/nfl-n-to-z.js`,
migration `029_quote_tape_commence_index.js` and the packet tests — was **already committed** as
`bbcdae2`, the only commit after the reviewed `401a5d0`. Nothing was stashed, reset, pulled or
overwritten. The working tree was clean before any edit.

### The test-baseline finding that matters

Running `npm test` on this machine gives **1,342 tests, 1,341 passed, 0 failed, 1 skipped** — which
looks like it contradicts the review's 24 failures. It does not, and it is not evidence that C06 is
closed. That run resolves `GRIDIRON_DB_PATH` to the developer's own populated `server/data.sqlite`,
so the tests that need saved audit runs and real history find them.

Re-run under the review's actual conditions — an isolated fixture database plus an external-network
guard — the result is **1,312 passed, 24 failed, 6 skipped**, reproducing the review exactly. (The
+5 passes versus the review's 1,307 are `bbcdae2`'s new packet tests.) The 24 failures are real and
are C06's subject.

```bash
GRIDIRON_DB_PATH=/tmp/fallback.sqlite NODE_OPTIONS="--import file:///tmp/guard.mjs" npm test
```

### How C01–C17 stood at HEAD

Confirmed still live by reading the source: C01, C02, C03, C05, C06, C08, C09, C12, C13, C14, C15,
C16, C17. Deferred to their own slices for verification: C04, C07, C10, C11.

Notable confirmations:

- **C01** — `nfl-auto-picks.js` emits `edge_points`; `nfl-decision-tape.js` hashed `d.edge`. The
  field does not exist on the board, so every fingerprint saw `undefined` and every persisted `edge`
  column was NULL.
- **C02** — `recordDecisionRun` inserted the header and then looped the children with no transaction
  around either. 027 created `nfl_decision_runs_no_update` but **no** `no_delete` trigger: a
  populated run was protected only accidentally, via its children's own delete trigger, while an
  empty run header could simply be deleted.
- **C03** — `027_decision_tape.js` `DROP TABLE nfl_execution_opportunities` runs while
  `nfl_execution_lifecycle_events` still holds `ON DELETE CASCADE` to it *and* its append-only
  delete trigger is installed. The cascade trips the trigger and aborts the upgrade. Confirmed by
  source order; the child rebuild that correctly drops its triggers happens second, too late.
- **C12** — `cutoffBatches` / `sequentialCapacity` have test callers only. No production caller.

### What was changed

| Path | Change |
|---|---|
| `docs/CLAUDE-NEXT-STEPS.md` | The September 10 review, reconciled in as the single canonical plan, with a new **§0 status register** (corrections, slices, reconciliation notes) in the format §12 requires. |
| `docs/evidence/2026-09-10/superseded-plan-2026-09-09.md` | The previous 846-line plan, preserved verbatim under a header that removes its authority. |
| `docs/evidence/2026-09-10/slice0/SOURCE-MANIFEST.md` | Branch, HEAD, diff against the reviewed snapshot, runtime. |
| `docs/evidence/2026-09-10/` | The review's own deliverables staged into the repo: `AUDIT-EVIDENCE.md`, `AUDIT-VERIFICATION.zip`, `implementation-checks.json`. |
| `docs/reference/architecture/folder-map.csv` | Refreshed from the review's 793-path disposition inventory. |
| `CLAUDE_FEEDBACK.md`, `CODEX_SUGGESTIONS.md`, `MODEL_OPERATIONS.md` | Headed as non-authoritative and pointed at the canonical plan. Their content extraction and relocation is **slice 9** work, per §10.4 and the existing disposition table — deliberately not done early, because the plan orders reorganization after the corrections. |
| `docs/reference/model-governance-manual.md` | Fixed a stale pointer to `docs/PROFITABILITY_EXECUTION_PLAN.md`, a file consolidated away on 2026-09-10. |

---

## Slice 1 — Protect evidence (C01, C02, C03)

### C01 — Decision identity collapses different forecasts · C02 — Partial writes and empty-run deletion

**Approach.** The tape was rewritten rather than patched, because the defect was structural: one
`board_hash` column was being asked to answer two different questions at once.

**New primitive: `server/platform/code-identity.js`.** C01 requires "real identities, not arbitrary
trusted hash strings". This walks the actual ES module graph from the spread decision roots
(`nfl-auto-picks.js`, `nfl-policy.js`, `nfl-execution-pipeline.js`), reads each file from disk and
hashes its bytes — 186 files in the current closure. It deliberately never shells out to git and
never reads `process.cwd()`, both of which are how the existing `trainingAuditCodeHash` gets this
wrong (C08). It reports `complete: false` and names the modules with computed dynamic imports rather
than silently hashing an incomplete closure.

**Content identity vs observation identity.** These are now separate columns with separate rules:

- `content_hash` — the canonical content: every candidate's contract, quote, **forecast**
  (probability, projected margin, signed edge, forecast identity, calibration identity, active model
  set), economics, and every stated policy reason, plus the policy, engine mode, horizon, cutoff,
  schedule version, code identity and data-provenance status.
- `observation_key` — the declared observation: experiment, horizon, cutoff, job, observation id.
  **Not** the retry attempt, so attempt 2 resolves to the same run.
- `board_hash` — 027's existing UNIQUE column, repurposed to hold `sha256(observation ‖ content)`,
  which is the value that genuinely must be unique.

That last choice is deliberate: removing the UNIQUE constraint would have meant rebuilding
`nfl_decision_runs`, whose children carry `ON DELETE CASCADE` plus an append-only delete trigger —
**exactly the trap C03 describes in 027**. Repeating it here to tidy a constraint would have been
indefensible.

**Honest data provenance.** A run records `data_identity_status` of `frozen_packet` /
`unfrozen_live_tables` / `unavailable`. Until C11's real packet exists, the pipeline records
`unfrozen_live_tables` and refuses to carry a data hash. The status is inside the content hash, so
today's weaker evidence can never later be mistaken for packet-backed evidence.

**Atomicity and completeness.** Header and children now insert inside one `BEGIN IMMEDIATE`. The
retry path verifies the stored child count against the header's claim and refuses to report a
half-written run as "already recorded". `decisionRun()` computes `complete` rather than trusting the
header. `computation_status` distinguishes a healthy all-abstention observation (`complete`, zero
selected) from a missed capture (`unavailable`), which keeps a missed game in the denominator.

**Invalidation, not rewriting.** `nfl_decision_run_invalidations` is append-only. Migration 031
appends an invalidation against any legacy run whose events do not match its header, and leaves the
run itself byte-identical.

**Exact-contract links.** `findDecisionEvent` now takes the full contract (matchup, market,
selection, line, book, price) and **throws** when more than one event matches, instead of the old
`ORDER BY id LIMIT 1`. The pipeline passes the full contract.

**Files changed**

| Path | Change |
|---|---|
| `server/platform/code-identity.js` | New. Module-closure code identity, git-free and cwd-free. |
| `server/services/nfl-decision-tape.js` | Rewritten. Validation, atomic writes, separate content/observation identity, full forecast in the fingerprint, real edge persisted, unique-or-fail contract links, append-only invalidation. |
| `server/migrations/031_decision_identity.js` | New. Observation identity, computation/data status, forecast columns on events, invalidations table, the missing `nfl_decision_runs_no_delete` trigger, legacy backfill, and a `down()` that **refuses** rather than losing evidence. |
| `server/services/nfl-execution-pipeline.js` | Supplies a declared observation, real code identity and honest data status; resolves decision links by full contract. A caller that declares no observation gets `unspecified_on_demand`, never a `T-60` claim. |
| `test/nfl-decision-tape.test.js` | Rewritten: 27 tests. Finding E6's original four acceptance criteria, plus every "close with" bullet from C01 and C02. |
| `test/nfl-decision-identity-pipeline.test.js` | New: 5 tests running the **real** `runExecutionPipeline` end to end, because the original defect was a mismatch *between* board and tape that neither component's own tests could catch. |

**Test results** — 32 passed, 0 failed.

```
test/nfl-decision-tape.test.js              27 pass / 0 fail
test/nfl-decision-identity-pipeline.test.js  5 pass / 0 fail
```

Covering, by name: material-field independence (21 fields, all distinct hashes, on both the unit and
the real pipeline path); same-observation retry idempotence; identical forecasts at two horizons;
two distinct observations with byte-identical numbers; one observation refusing two answers;
ambiguous same-side different-line resolution; duplicate exact contract refusal; arbitrary code
identity refusal; second-child failure rolling back header and first child; restart after failure;
duplicate-observation rejection at the schema level; empty **and** populated run delete rejection;
count reconciliation; append-only invalidation; missed observation retained as `unavailable`;
pre-write validation.

**Remaining limitation.** `data_identity_status` is `unfrozen_live_tables` for every run the current
pipeline records, because no frozen packet exists yet. That is recorded truthfully, but it means no
decision made today is reproducible from stored inputs. C11 is what changes that.

### C03 — Populated migration 027 fails and downgrade loses evidence

Delegated to a parallel worker with the migration paths (`server/migrations/**`, `server/db/**`)
reserved to it and migration number **030**; number **031** was reserved for C01/C02 so the two
could not collide. Result recorded below when it lands.

**Result.** The preflight repair, the injectable database, and both refusing `down()` functions were
written by a parallel worker that died before writing any tests. Its code was reviewed line by line
and kept — the SQLite reasoning is correct, including the detail that `PRAGMA foreign_keys` is
silently ignored inside a transaction, which is why the repair cannot be a migration. The tests were
written afterwards, here.

| Path | Change |
|---|---|
| `server/db/preflight.js` | New. Versioned repairs that run BEFORE the migration runner, outside any transaction, where the foreign-key pragma still means something. Refuses loudly if it discovers it is inside a transaction. |
| `server/db/migrate.js`, `server/db/index.js` | The database is now a parameter, so migrations can be driven against a fixture built at an older version. A test using the process connection can only ever exercise the empty case — the case that already worked. |
| `server/migrations/027_decision_tape.js` | Refuses loudly if reached with a populated ledger by a path that skipped the repair. `down()` refuses rather than deleting terminal states 023 cannot represent. |
| `server/migrations/028_settlement_corrections.js` | `down()` refuses rather than deleting settlement corrections. |
| `test/migration-027-populated-upgrade.test.js` | New: 10 tests against real populated 026-era fixture databases. |

**Test results** — 10 passed, 0 failed. Covering: the reproduction itself (027 applied the old way
still aborts); populated 026 → current with byte-identical row-by-row preservation; already-past-027;
fresh empty; idempotence; failure rollback; restart; `foreign_key_check`; a `VACUUM INTO` backup
proven to restore; and both downgrade refusals.

**Remaining limitation.** The repair is exercised against fixture databases only. No installation
carrying real execution rows has been upgraded, because none exists — the developer's own database
reached 028 with zero opportunity rows, which is why this was never hit in the first place.

---

## Slice 2 — Correct clocks and contracts (C11, C13, C14)

### C11 — the packet identified a game by kickoff and a receipt by request time

Three defects in one query, all confirmed at HEAD before changing anything.

**The game.** The predicate was the kickoff range alone. A kickoff instant is not an event identity —
the NFL runs up to nine games at 1:00pm Eastern. Migration 029 had indexed that lookup; speed was
never what was wrong with it. The fix keeps the kickoff range leading (it is what the index can use,
and it narrows 1.3M rows to a handful) and then resolves the canonical event in JS, because the tape
stores full team names while the schedule stores abbreviations.

**Fail-closed on identity.** `teamCodeFor` returns null for anything it cannot map, and `null === null`
would have made an unidentifiable game match *every* row in the window — the cross-game bug wearing
the costume of a scoped query. An event that cannot be named canonically now has no packet.

**The period and market.** Absent entirely. Today's ingestion writes `full_game` for everything, so
this was latent rather than harmless: the first first-half feed would have started poisoning packets
silently.

**The clock.** `requested_at` is stamped *before* the request goes out. Since `requested_at <= received_at`
always, using it made every quote look like it arrived earlier than it did. Migration 032 adds the
real clock and deliberately does **not** backfill it — one line would have kept every historical
packet working, and that is the defect written into the data instead of the query. Legacy batches are
marked `legacy_request_time_only` and cannot support a prospective claim.

The honest consequence: **existing quote history is no longer prospective evidence.** It remains fully
usable for labeled historical work.

The packet now carries the actual rows — quote ids, books, lines, prices, receipt times — not counts
and a latest timestamp.

**Test results** — 24 passed, 0 failed (`test/nfl-t60-packet.test.js`), including the query-plan check
Codex asks for.

### C13 / C14 — closing-line grading

Done together because they are the same function and the same sign convention; splitting them across
two slices would have meant editing one function twice and merging against myself.

**C13.** The close is now scoped to the canonical event and full-game period, deduplicated to the
latest quote *per book* (the old rule kept only rows sharing one snapshot instant, which dropped books
that had stopped updating), and drawn from a declared bookmaker set an independent reference can use
to exclude the book we bet at. Handicap movement and price movement became separate measurements with
separate denominators: the plan is explicit that a method requiring the exact accepted line
"naturally returns zero point movement and cannot stand in for a moving main-line benchmark."

**C14.** Accepted −110 against a −120 close returned −10 while the code's own comment said positive was
better. Price CLV is now measured in probability space, where that case is **+0.0089**. Prices are
averaged by converting to decimal return first — American odds are discontinuous across the ±100
boundary, so the median of raw American numbers that defined the closing price was not a price. The old
field is kept under a name stating what it is, so an older exported number still reconciles.

**Test results** — 18 passed, 0 failed.

### The shared probability contract

`server/betting/nfl/contracts/spread-probabilities.js` — the single probability and payout authority
§10.3 asks for, with §5.1's mathematics stated once.

Its property tests, written against an independent oracle, **found two real bugs in it before anything
consumed it**: `isHalfPoint(-3)` returned true (the test was whether `h*2` is a whole number, equally
true of integers), and the away-side conversion negated both the margin and the handicap, which scores
an away +3 as an away −3.

**Test results** — 15 passed, 0 failed.

---

## Slice 3 — Correct probabilities and authority (C05, C15)

### C05 — impossible probabilities, and a ranking that contradicted its own economics

`coverProbabilities(3, -10.5)` returned **win −0.125, loss 1.125, push 0**. The cause was combining an
assumed coin-flip anchor with the unconditional distribution of *absolute* margins — two things that do
not describe the same random variable. Migrating mass between distant lines under that mixture could
remove more probability than the anchor had.

A negative probability is not a number that needs clipping; it means the object producing it was never
a distribution. So the mixture is gone, replaced by one coherent signed object: the empirical residual
`r = home margin + home spread`, binned onto integers relative to the line being priced. Push behaviour
then falls out rather than being asserted — a half-point line cannot be equalled by an integer margin,
so its push mass is zero by construction.

The ranking was `line_edge * 2 + price_edge`, which contradicted the economics printed beside it: it
ranked +2.5/+100 above +3/−150 while its own expected returns were −0.1500 and −0.1417. Ranking is now
by expected net return at the actual line and price, under the same distribution. `line_edge` and
`price_edge` survive as **diagnostics**, and nothing on the board claims to be a qualified edge —
these probabilities come from the market's own posted number.

`bestExecution` now refuses explicitly when no valid distribution exists, and `nfl-shopping-board.js`
reports that refusal instead of crashing on a null best book.

**Test results** — 20 passed, 0 failed.

### C15 — the policy gate was incomplete at price refresh

Policy identity bumped to **1.2.0**: the expected-return gate had been added at 1.1.0 without moving
past it, so two materially different economics ran under one version.

**Push semantics.** The board never emitted `push_probability`, and `?? 0` priced every integer line as
though a push were impossible. A −3 spread pushes on roughly one game in ten. An unknown push on an
integer line is now `push_probability_unknown` and abstains; a half-point line is zero *by arithmetic*,
not by assumption. Migration 033 freezes the push treatment onto the opportunity so the refreshed gate
re-prices under the assumption the original decision was made with.

**Negative haircut.** A negative haircut *increases* the modelled win probability and can flip a
rejection into a selection. Rejected as a configuration error.

**The refresh gate itself.** `attemptAcceptance` now re-checks expected return at the price actually
being accepted. A changed handicap refuses rather than reusing a probability that describes a different
contract. Missing forecast provenance refuses the *recommendation*.

**Off-policy tickets.** A bet Nick actually placed is a fact about the world. Refusing to record it does
not un-place it — it removes a real loss from the ledger and quietly improves the record. So an
off-policy ticket is always recordable, always labelled on its face, and settles exactly as an
authorized one does.

**Test results** — 16 passed, 0 failed.
