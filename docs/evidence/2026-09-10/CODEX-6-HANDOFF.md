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

---

## Slice 4 — Repair learning and reporting (C04, C07, C08, C09, C10, C16, C17, C06)

| Correction | What was wrong, and the fix |
|---|---|
| **C04** | Opponent EXPOSURE spanned every game in history while the EPA features it adjusts span two seasons — a team's 2016 opponents counted as exposure, then priced with 2024 defensive efficiency. Both windows now move together. The sparse-coverage floor (3 eligible opponents) is explicit rather than emerging from averaging one game. |
| **C07** | The residual fit/score boundary was a row index. `Math.floor(n * 0.7)` lands inside a Sunday slate roughly six times out of seven, and games in one week share a week of common information. The boundary now falls between complete weeks; each component records which weeks trained its slope and which graded it. |
| **C08** | Rule identity shelled out to `git ls-files` under `process.cwd()` and **failed open** — the catch returned null, and a missing hash was accepted as a pass. So the environments where the check could not run were exactly the environments where it silently did not. Now module-closure based, fail-closed, and enforced at **promotion** — the one moment a finding gains authority, and the one place the check was missing. |
| **C09** | `pushes` was initialised and never incremented. A corrupt week was skipped in silence. A zero-bet week never entered coverage at all — precisely the week a weekly average must include. Min–max coverage could not tell "weeks 5–18" from "weeks 5–18 with 9 and 12 missing". Outcomes now aggregate from the authoritative picks and reconcile against the stored summary. |
| **C10** | A sparse cutoff-safe calibration fell through to `PRIOR_VARIANCE`, fitted from every season on record. Reproduced: a 2016 forecast's standard error moved after changing only 2024 scores. The fallback is now a declared, versioned, never-refitted prior, and forecasts resting on it are labelled `insufficient_calibration_evidence`. |
| **C16** | `featureContracts()` read `challenger_only` while the registry spells it `challengerOnly`, so the report saw **zero** challengers where nine exist. Both scoring paths scored an unconditional probability against a decided label: a 0.45/0.10/0.45 forecast on a decided win scored **0.303** instead of the proper conditional **0.25** — punishing exactly the models that got key numbers right. |
| **C17** | `alwaysValidPValue` estimated sigma from the sequence under test, which breaks the martingale property the "always valid" label depends on. A declared sigma now yields `p_always_valid`; a plug-in estimate yields `p_fixed_sample_only` and says why. Decay watch, which runs repeatedly, carries the caveat in every sentence built from the number. |

### C06 — the suite that only passed on one machine

Under the review's own conditions the suite was **1,312 pass / 24 fail**. It is now
**1,449 pass / 0 fail / 24 skip**.

The 24 skips are not the 24 failures renamed. They split into two groups by an explicit rule:

- **Logic tests** moved onto a deterministic seeded league (`test/helpers/seed-league-history.js`) —
  a fixed-seed generator, because a flaky fixture failure is indistinguishable from a real
  regression. All 7 preseason-blend failures were closed this way.
- **Fitted-model validations** — "goal-line carries convert better than open-field ones", "every
  season prices all 32 teams" — were **kept, not deleted**, and now name the history they need. A
  fixture could be built to satisfy any of them, and would prove only that the fixture was tuned.
  All 24 run and pass against the populated database.

CI now **enforces** the offline claim it previously asserted in a comment, and points
`GRIDIRON_DB_PATH` at a nonexistent file so the hosted job cannot read a real database by accident.

---

## Slice 5 — Connect the operation (C12)

`cutoffBatches` and `sequentialCapacity` had test callers and nothing else — the review's phrase was
"a GET packet route is not a scheduled collector."

**The capacity defect.** The API took final slot states with no times attached, so a slot released
at 12:10 wrongly freed capacity for a batch at 12:05 — a later fact changing an earlier decision.
Releases now carry the instant they happened; a release with no recorded time is treated as **still
held**, because "we do not know when it came free" must never resolve to "it was always free".

**The runner.** `server/betting/nfl/strategy/t60-runner.js`, registered as `nfl_t60_runner` on the
live scheduler tier. It opens a prospective observation before each cutoff, freezes the packet when
the cutoff arrives, and marks anything still uncaptured afterwards as **missed**.

That last part is the whole point. A system that only writes rows when it succeeds cannot tell a
quiet week from a broken collector, and coverage computed from such rows is always 100%.

**Test results** — 11 pass (runner) + 14 pass (protocol).

---

## Slice 6 — The shared dataset

`research/betting/nfl/dataset.py`. `tree_lab.py` carried a comment saying the duplication out loud:
*"everything above this line mirrors market_lab.build_dataset's setup"*. Two copies of a chronology
is two chronologies; they agree today because someone kept them in step by hand, and the first time
one is fixed and the other is not, two experiments quietly stop being comparable.

Parity tests require the extraction to reproduce the labs' own publication instants and result
history exactly. **12 pass.**

---

## Slice 9 — Reorganize and consolidate

The repository root now contains **one** markdown file: `README.md`.

| Was | Now | Treatment |
|---|---|---|
| `CODEX_SUGGESTIONS.md` (931 lines) | `docs/evidence/historical/platform-audit-2026-08-24-findings.md` | 73 lines of dated observations kept; **858 lines of proposal backlog and per-page roadmap removed**. §10.4 is explicit that relocating a queue is not consolidating it. |
| `CLAUDE_FEEDBACK.md` | `docs/evidence/history/platform-audit-implementation-2026-09-08.md` | Verification record kept. |
| `MODEL_OPERATIONS.md` | `docs/reference/model-governance-manual.md` §18 | Merged as operating reference, per "retain operational instructions in the reference manual". |

`docs/evidence/historical/profitability-baselines.md` carried 24 unchecked boxes. Each is now
resolved in a disposition table naming where it went — three to implemented corrections, three to
partially-implemented ones, and four marked out of scope for a spreads-only mandate. **Zero open
task lists remain anywhere outside the canonical plan.**

Three stale code comments pointing at the relocated files were updated.

**What was deliberately NOT done.** The `server/` ownership moves in §10.2 are not executed. §10.4
requires packaging and path-resolution tests first, and `nfl-research-lab.js` still derives its root
from `../..` while the DB default path depends on its module location — the exact traps that section
names. Moving those files before those tests exist would be the "successful build alone does not
test runtime file loading" failure the plan warns about.

**Verification after consolidation:** typecheck, lint (574 files), build, and the real-server
startup smoke test all pass. The folder map was recomputed against `fced8d9`: **820 dispositions,
none undisposed.**

---

## Slice 10 — The decision record

[`DECISION-RECORD.md`](DECISION-RECORD.md). The short version: **continue, no promotion, no wager
authority.** The question "can this select profitable spread bets" is now *askable*, which it was
not before — but it has not been asked, because no prospective observation exists. Slices 7 and 8
stay closed because §9.1 stages them behind a frozen comparison that has not been run.

---

## The §10.3 additions, and the two that were missing

Section 10.3 lists the boundaries the plan says to add, with the standing warning that these "are
proposed interfaces, not permission to duplicate current services."

| Proposed addition | Built? | Why |
|---|---|---|
| `server/platform/paths.js` | **Yes** | §10.4 says to do this *first*. Three services derived the project root by walking `../..` from their own file — which works, is invisible, and silently means a different directory the moment the file moves. Imports still resolve, the build still succeeds, and at runtime it reads nothing. All three now import `PROJECT_ROOT`. |
| `contracts/forecast-packet.js` | **Yes** | §4.1's eight contract groups as one validated schema authority. A packet carrying counts instead of values is refused; so is one claiming prospective status on a request-time clock, and one whose evidence arrived after its own cutoff. |
| `contracts/spread-probabilities.js` | **Yes** | The single probability and payout authority. |
| `strategy/t60-runner.js` | **Yes** | The durable orchestration C12 found had no caller. |
| `research/betting/nfl/dataset.py` | **Yes** | The chronology the two labs duplicate. |
| `strategy/capacity-ledger.js` | **No** | §10.3 says "needed only if existing lifecycle cannot own reservation events cleanly." Migration 034's `nfl_capacity_events` sits alongside the existing ledger with one transaction authority. A second position ledger is what that row warns against. |
| `forecast/spread-family-adapters.js` | **No** | Slice 7 work, and slice 7 is correctly not started. |
| `research/.../market_surface.py`, `lineup_lab.py` | **No** | Explicitly conditional on §8's adoption gates, and §10.3's own instruction: "Do not create empty scaffolds and call the family delivered." |

## A defect this work introduced, found by the real data

The C09 rewrite aggregated outcomes from the authoritative picks rather than the stored per-week
summary — correct, and it passed eight synthetic tests. Against the real database it reported
**153 spread bets and a null win rate**, because the stored runs write `"Won"`/`"Lost"` while the
comparison was lower-case. Every historical pick fell through to `unknown_results`.

It did not throw. It produced a confident report with the right denominator and no outcomes — the
exact failure mode C09 is about, reintroduced while fixing C09.

Corrected, run 27 now reproduces independently from the picks: **153 bets, 72 wins, 78 losses,
3 pushes, −11.855 units, −7.75% ROI** — matching §1.2's table exactly. Two regression tests cover
the case handling and the per-week rounding tolerance.

The lesson is the one the plan states in §12: *"'Already done' without a caller and test is not
closure."* Eight passing synthetic tests were not enough; the real data was.

## What is still not true

Stated plainly, because the plan asks for it and because these are the things that would otherwise
be inferred from a green suite:

1. **No decision is reproducible from stored inputs.** Every run records `unfrozen_live_tables`.
   The packet is correct and the contract exists; nothing consumes it. This blocks §12's return
   item 4 outright.
2. **Nothing is qualified.** No model, no family, no combination. The highest state any correction
   reached is `connected`.
3. **No prospective observation exists.** The T-60 runner is built, tested and registered on the
   live tier. It has never run against a real slate.
4. **The hosted CI job has not been run.** Everything here was measured on Node 25 locally; CI
   pins Node 22.
5. **The `server/` ownership moves are not executed.** Deliberately — §10.4 requires packaging and
   path-resolution tests first, and `paths.js` is the prerequisite that now exists for them.
6. **The historical record is unchanged and must stay that way.** 153 spread bets, −11.85 units,
   −7.75% ROI. A repaired strategy gets a new identity and a new evaluation.


## A second defect this work introduced, found by importing rather than checking

While wiring `PROJECT_ROOT` into its consumers, an import was inserted into the middle of a
multi-line import specifier in `role-scenario-lab.js`:

```js
import {
import { PROJECT_ROOT } from '../platform/paths.js';   // <- here
  ROLE_SCENARIO_ENGINE_VERSION, buildPlayerScenarios,
} from './role-scenario-engine.js';
```

**`node --check` passed on that file.** It does not validate ES module import placement. Only
actually importing the module surfaced it — which is precisely the shape of failure §10.4 warns
about in a different context: *"A successful build alone does not test runtime file loading."*

Two things came out of it. Every module changed in this work is now import-checked, not
syntax-checked (44 of them, all clean). And `test/platform-paths.test.js` — §10.3's own acceptance,
*"Test launch from another working directory and installed/packaged mode"* — now includes both a
real `chdir` test and a guard that fails if any service goes back to deriving the project root from
its own location. That guard immediately found a fourth offender, `nfl-evidence-dataset.js`, that
the original grep had missed.

---

## Addendum — the five-agent Wong × model investigation (2026-09-10)

**Question asked:** can the spread model and the Wong teaser window be combined
into something profitable?

**Answer: no, and the reason is specific rather than disappointing.** The two
things do not compose, because the model has no information about the quantity
a teaser leg depends on.

### The five deep dives

| # | question | verdict |
|---|---|---|
| 1 | volume, obtainable price, bankroll | 15–33 tickets/season; **zero teaser prices have ever been recorded** |
| 2 | is the edge decaying | **no** (trend +0.0073/yr, z=+0.99); but `game_lines.spread` is corrupted for 2025–2026 |
| 3 | other key-number windows | 4,060 candidates searched, **none survive**; SE correction lowers z to 1.80 |
| 4 | does model info select legs | corr(edge, ATS residual) = **−0.007**, p=0.72, n=2,761; 20/21 is noise |
| 5 | do model inputs predict close games | 501 hypotheses, **0 survive** BH q<0.10 |

### The 20/21 finding is dead, and it is worth knowing how

Three independent kills, any one of which is sufficient:

1. **It exceeds the perfect-model ceiling.** Shifting the dog-window residual
   pool by the backed legs' full mean edge (3.66 pts) — i.e. assuming the model
   is 100% right — caps the achievable leg rate at **83.3%**. The observation
   was 95.24%. A true 95.24% would need a *15.5-point* real edge. It is above
   what a perfect model could produce, which makes it a statement about the
   sample rather than about the model.
2. **It does not replicate.** Discovery (2021–25) 89.3% vs 76.0% rest, p=0.020.
   Holdout (2016–20) 80.0% vs 77.9%, p=0.41. Cleanest holdout (2018–20, after
   the cold-start era) is **−1.2pp — negative**.
3. **It does not exist often enough to matter.** Only **2 of 70 audit weeks**
   produced ≥2 model-backed legs, and a 2-team teaser needs two. That is once
   every three seasons. Confirming the most generous possible version needs 173
   backed legs ≈ **41 years**.

Multiplicity: ~37 trials across both passes. Bonferroni threshold 0.0014. Holm
step-down over the nine primary tests: **nothing passes**, best p = 0.135.

### Why nothing downstream could have worked

Two structural facts, measured independently, that close the question:

- **σ(margin − spread) ≈ 12.7 and does not move with the line.** Fitted log-σ
  slope on |spread|, 2016–2022: −0.0008, p = 0.86. σ is 12.73 at a 1-point
  spread and 12.64 at a 10-point spread. The single most informative variable
  in the system carries **zero** dispersion information.
- **`model_margin = 0.744 + 0.647 × market_margin`** (r = 0.87), and
  corr(market_margin, edge) = −0.70. The model is a shrunk copy of the market,
  so its "edge" is mechanically a dog preference — which is why 52 of 410 policy
  picks land in a Wong dog window and **zero** land in a favourite window.

A teased leg's outcome is a deterministic function of the margin. A signal with
no information about the margin residual cannot select legs. Everything else
follows from that.

### Three corrections to numbers this project has been quoting

1. **z is 1.80, not 1.99.** Same-week legs in different games are positively
   correlated (joint 57.75% vs p² = 55.79%, ρ ≈ +0.082; a cross-week placebo
   gives +0.06pp, which validates the measurement). The cluster-robust SE is
   **1.29pp, not 1.17pp**. One-sided p = 0.036. Still clears the bar, less
   comfortably than the docstring claims.
2. **EV at −110 is nearer +9% than +6.5%.** The same correlation that widens
   the SE *helps* an all-must-win ticket, so `p^n` understates the payoff. The
   two corrections pull in opposite directions and both should be applied.
3. **The disagreement-inflation term is decoration.**
   `server/services/nfl-ensemble.js:220` widens the predictive interval by
   `1 + min(0.25, disagreement/30)`. On the clean 2016–2022 panel the log-σ
   slope of component disagreement is **−0.64% per SD, p = 0.70** — the wrong
   sign. On the deep panel it reads −2.1%/SD in discovery and **+8.4%/SD in
   holdout**, a sign flip. There is no stable relationship. Not a bug; not a
   measurement either.

### Two findings that are not about Wong at all

**`game_lines.spread` is corrupted for 2025 and 2026, and 2026 is live.**
Integer share of closing spreads: 2021 49.5%, 2022 51.1%, 2023 48.4%, 2024
47.7%, **2025 24.9%, 2026 16.2%** (verified directly against the live database,
not only by the agent). Against `nfl_odds_archive`'s 10 real books, `game_lines`
is off by exactly 0.5 in **57.1% of 2025 games** where the real close is an
integer, versus ~30% in 2022–24. Integers −1, −2, −4, −5, −8, −9, −12, −13, −15
are **entirely absent** from 2025 while the archive holds all of them; only −3,
−6, −7, −10, −14 survive. The 2026 ESPN feed shows the identical
missing-integer signature. Ten books agree with each other; `game_lines` is the
outlier.

Consequence: 2025's 99 qualifying legs — the largest count in 27 years — is
partly manufactured; real lines give 68–70. It barely moves the 27-year headline
(74.69% → 74.52%) but it makes every *season-level* read of 2025 unusable, and
it will mis-classify live 2026 legs. `nfl_odds_archive` is the reference.

**No teaser price has ever been recorded, anywhere.** `nfl_teaser_price_ledger`:
0 rows. Its only writer, `recordTeaserPrice()` at
`server/services/nfl-profitability.js:47`, has never been called. All 1,153
quote batches requested `spreads,totals,h2h` only. Zero of 1,382,936
`nfl_quote_tape` rows contain the string "teaser". The `−115` floor in
`findTeaserLegs` has never once been checked against a real quote.

This is the single number that decides the answer, and it is the only one that
was assumed rather than measured:

| price | break-even | P(edge > 0) | EV/ticket |
|---|---|---|---|
| −110 | 72.37% | 0.78 | +6.7% |
| −115 | 73.14% | 0.70 | +4.5% |
| −120 | 73.85% | 0.61 | +2.4% |
| −130 | 75.18% | 0.44 | −1.1% |

The code already knows. `compileTeaserRoutes` gates every candidate on a fresh
reachable ledger price, so with an empty ledger the system emits **zero**
executable candidates today and says so.

### What the business case actually looks like

At the point estimate and −110, 30 tickets/season on a 100u bankroll: **+3.48u
per season**, sd 9.25, **32% of seasons finish red**, median in-season drawdown
7.8u, and **27 seasons before the P&L is distinguishable from zero**. At the
95% lower bound the staking rule collapses the stake to 0.03u at −110 and to
*zero* at −115 — the pessimistic case is not "you lose money," it is "you did
all this for a 0.00% return."

### The one thing worth adding

**The cross-both rule**, derived from the mechanism rather than searched: the
exact set of lines where six points strictly crosses both 3 and 7 is favourites
**−7.0 to −8.5** and dogs **+1.5 to +3.0**. The classic window omits −7.0 and
+3.0. It yields 3,015 legs at 73.90% against the classic 1,391 at 74.69% —
**more than double the supply at a slightly lower rate**, which matters when the
classic window's median is 3 legs a week and only 36% of weeks offer four.
Use it for volume, not for edge; at −120 it is a coin flip while the classic
still shows +0.84pp.

Two agents independently found the same execution trap: **shopping −7.0 into
−7.5 is a downgrade** (74.95% → 74.23%), and it is the single most common
shop-in (35 of 115 cases). Shop by measured teased-line rate, never by "does it
qualify."

### Standing recommendation

Bet the classic window opportunistically at **−110 or better**, hard stop at
−115, unconditionally — do **not** let the model pick the legs. Do not build
infrastructure for it. The one measurement that would change any of this is
twenty rows of real two-team six-point teaser prices in
`nfl_teaser_price_ledger`; the write path and the routing layer are both already
built and waiting.

**Rigor note:** across the five agents, roughly 4,600 formal tests were run.
The only p < 0.05 survivors of any multiplicity correction were none.
