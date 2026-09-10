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
