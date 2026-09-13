# Final integration report — 2026-09-12 unify sweep

Integration branch: `unify-2026-09-12-integration`, built from
`model-2026-09-12-integration` in worktree `/tmp/gridiron-unify-worktrees/integration`.
Seven branches merged, `--no-ff`, in the order given: `u1-week-sync`,
`u2-market-identity`, `u3-beat-the-close`, `u4-prop-reconcile`,
`u5-clv-endpoints`, `historical`, `unify-systems`. Nothing pushed, nothing
merged to `main`, the live server was never started, and every check in this
report either reads `server/data.sqlite` with `{ readOnly: true }` or writes
only to a fresh `/tmp` scratch database.

**Read this first if you read nothing else:** §5 below is not a merge note —
it is evidence that a *prior* session, before this integration began, already
executed a real write against your live production database. It is not
something this session did, and the change itself looks like a genuine
correction rather than damage, but you have not yet been told about it and
should decide what to do about it.

---

## 1. The seven urgent fixes — what they claimed, what I confirmed

Every number below was re-checked by me, independently, read-only against
`server/data.sqlite`, in addition to whatever each branch's own author
already checked. Where I disagree or flag something, it's called out.

### u1-week-sync — not a bug

Investigated the reported "14 of 16 Week-1 games missing scores." **Confirmed
non-issue**: 2 of the week's 16 games had actually finished as of the
validation timestamp (2026-09-13 ~00:03 EDT), the sync job scored exactly
those 2 on schedule, and the other 14 genuinely had not kicked off yet.
`currentNflWeek()` returning `week=1` was already correct. The branch still
adds a real safety net — `scheduleDerivedWeek()`, a kickoff-time-only cross
check that overrides the score-derived week if it looks stalled (>50% of a
week's games >6h past kickoff with no score) — verified against both the
real, healthy case (no change) and a synthetic stalled-sync fixture (correct
recovery). Merged clean, no conflicts.

### u2-market-identity — confirmed, and it changed what the historical
verdict means

Adds an explicit `is_market_identity` flag: whether the production
`market_residual` blend actually produced an independent model opinion, or
silently returned the market line by arithmetic because nothing cleared the
residual-promotion gate. **I independently re-ran the underlying count
myself** (see §2) rather than trusting the commit: 848 real fit artifacts,
26,288 real component-cutoff rows, **zero** ever passed the gate — exact
match to the branch's own claim. The 16 real rows ever written to
`nfl_pick_decisions` all carry `edge=0` and `market_residual` — also
independently confirmed. This is the single most important fact this whole
sweep surfaces: the model has never, in its entire real history, produced an
opinion different from the market.

One real merge conflict here — see §4.

### u3-beat-the-close — real, narrower fix than advertised, and it says so

Widened `settleBeatTheClose()`'s Pinnacle-near-kickoff requirement so a
settlement can't silently grade against a months-old archived "close" once a
live capture lapses. The branch's own report **could not reproduce** the
orchestrator's stated baseline ("9 past-kickoff events, 4 of 9 settle") — at
inspection time only 2 of 16 week-1 games had actually kicked off, both
already settled cleanly. It found and fixed a more severe, precisely
quantified version of the same risk class instead (some archived `close` rows
for this week sit 2,490+ hours from kickoff — a preseason line) rather than
fabricating agreement with a number it couldn't verify. **I agree this was
the right call and flag the same discrepancy for you**: if "9 past-kickoff"
was a real observation, it was made at a different time or with a different
method than what exists in the database now. Worth 30 seconds to reconcile,
not urgent.

### u4-prop-reconcile — the code is fine; **what it did to your database is
not covered by "fine," see §5**

Fixes a real bug: the scheduler's routine reconciliation pass only revisits
prop-quote rows with a NULL/`legacy_unclassified` match status, so ~101k rows
an old matcher bug stamped with some other terminal status (e.g.
`identity_unresolved`) were stuck forever even after the matcher itself was
fixed. Adds `scripts/backfill-prop-quote-reconcile.mjs` as a deliberate,
manually-invoked, one-time exception — never wired into the scheduler, so it
does not recur automatically. **The code merged into this branch is inert
and safe** (it only runs when a human runs it). **The problem is that,
per its own commit message, it was already run once — against the real,
live `server/data.sqlite`, before this integration session started.** Full
detail and confirmation in §5.

### u5-clv-endpoints — confirmed clean

Two independent pieces, both verified: (1) abstention-inclusive CLV grading
— every passed-on opportunity now gets graded against the last quote seen
before declining, not just accepted tickets, so the denominator is every
decision the model reached rather than only the ones it acted on; (2)
declared-sigma pre-registration for the mSPRT always-valid p-value, which had
been silently `NULL` on all 15 real sealed audits because nothing had ever
committed to a variance in advance. I independently confirmed the declared
point-CLV sigma (2.5737, n=1394, 2021-2025 home-team open-to-close spread
movement) reproduces exactly against the live table, and confirmed **the
preregistration script itself was NOT run against real data** — the real
`audit_registry` still holds exactly the same 15 rows it held before this
branch, with no `all-game point CLV` / `all-game price CLV` rows added. This
one did the read-only-validation thing correctly throughout. Merged clean.

### historical — see §2, verified in full, not just spot-checked

### unify-systems — see §3 for the architecture, and §4 for the one real
conflict it created against u2

---

## 2. The historical verdict — reproduced, not just spot-checked

Full report: `HISTORICAL_VERDICT_REPORT.md` (root of this worktree), raw data
in `docs/evidence/2026-09-13/historical-leaderboard-report.json`.

**I did not stop at spot-checking headline numbers. I re-ran the entire
`scripts/run-historical-leaderboard.mjs` pipeline myself**, independently, in
this fully-merged integration branch, against a fresh scratch database
(`GRIDIRON_DB_PATH=/tmp/leaderboard-verify-*.sqlite`), reading the real
`server/data.sqlite` only with `{ readOnly: true }`. **The output is
byte-for-byte identical to the committed JSON report**, field for field,
except the `generated_at` timestamp. Every DSR, PBO, Sharpe, z-score, and
win/loss record in the leaderboard reproduces exactly.

I additionally hand-verified the following directly against
`server/data.sqlite`, independent of the report script, by writing my own
read-only queries:

| Claim | Independently confirmed |
|---|---|
| 848 real ensemble fit artifacts, 26,288 real component-cutoff rows | Exact match |
| `residual_gate_passed=true` count across all of them | 0 — exact match |
| `residual_weight>0` count across all of them | 0 — exact match |
| 16 real rows in `nfl_pick_decisions`, all `market_residual`, all `edge=0`, all abstained | Exact match |
| `nfl_execution_opportunities`/`nfl_execution_log`/`nfl_bet_log`/`nfl_replay_bets`/`forward_picks` all empty | Exact match, all 0 |
| `nfl_teaser_executions`: 1 row, paper, open | Exact match |
| `shadow_decisions`: 189 total (128 abstain, 61 observe) | Exact match |
| `audit_registry`: 15 real rows; id 9 = 468-447 CLV (z=0.69); id 13 = 194 bets, 85-109 (z=-2.39); id 14 = 57 bets, 33-24 (57.89%); id 15 = 242 bets, 117-125 (48.35%, z=-1.26); id 1's `detail_json` has no win/loss field at all (confirming the report's claim that its prose-cited record doesn't actually exist in its own evidence) | Exact match on every field |

**The bottom line, in the report's own words, which I am not softening**:
nothing in the current model/betting stable clears the bar, and this is now
measured with real error bars instead of a synthetic fixture's.

- The production blend (`market_residual` — what the live board actually
  serves) has never once produced an opinion independent of the market: 0 of
  26,288 real fits ever cleared the promotion gate, 0 of 16 real decisions
  ever carried nonzero edge. Grading its "accuracy" would be grading the
  market's own accuracy under a different name.
- The raw-blend ensemble (21 components) has 0 of 21 ever demonstrating real
  held-out value against a real closing line, in this project's entire
  history.
- The best-looking execution/teaser result (Sharpe 0.1117, 57 bets) is a
  partial, early look at a hypothesis whose completed real sample (242 bets,
  5 seasons) **loses money** (48.35%, z=-1.26) — and even the partial look's
  own DSR (0.349, corrected for ~32 effectively-independent real looks in the
  registry) is under even odds that it reflects skill rather than the best
  of many tries.
- The newest models (joint scoring / forecast-combination) have **zero**
  real evaluation — their own authors only measured them on a synthetic
  fixture, and this report could not fix that without running a script that
  applies pending migrations to the live database mid-capture, which is
  exactly what the safety rules forbid.
- The one thing worth keeping without qualification: **line-shopping**
  (routing to the best real available price across books) — the only
  candidate in the entire registry that doesn't require forecasting anything
  to be worth something.

This conclusion was reached independently by the historical branch, restated
identically by my own from-scratch rerun of its pipeline, and is consistent
with u2's independent same-count confirmation (848/26,288/0) and with an
entirely separate eigendecomposition finding cited in `MODEL_BUILD_REPORT.md`
(`blend = 0 + 1·market`, R²=1). Four independent instruments, one answer.

---

## 3. Architecture unification — before / after

Full detail: `UNIFICATION_REPORT.md` (root of this worktree).

**CLV.** Before: math lived in `clv-core.js`, but `nfl-clv.js` was still a
live, separately-scheduled, separately-routed thin wrapper holding the real
`nfl_bet_log` ledger (`recordBet`, `gradeClosingLineValue`, `clvReport`, …).
After: `nfl-clv.js` is deleted; its ledger code moved into `clv-core.js`
verbatim; every importer (routes, scheduler, `nfl-sharp.js`, tests)
repointed. One CLV module.

**Replay/backtest engines.** Before: `nfl-neural-replay.js` (one real
importer) and `nfl-replay.js` were two files implementing genuinely different
mechanisms — a static ensemble replay and an evolving online network — with
one real caller between them. After: merged into one file,
`nfl-replay.js`, as two distinct exported entry points; the neural code kept
its own internal helpers (renamed to avoid the one real naming collision)
rather than being forced onto the ensemble replay's loop shape.
`nfl-props-replay.js` and `weekly-walkforward.js` were investigated and
deliberately left separate — different observation shapes, different holdout
semantics, both now documented in-code so the question isn't re-opened later.

**Decision writer.** Before: two independent, disagreeing write paths to
`nfl_pick_decisions` — the scheduler called both `persistPickDecisions` and
`recordDecisionRun` from the same board, and `nfl-market.js`'s
`/sync-and-pick` route called `persistPickDecisions` **alone**, with no
append-only tape record at all. After: `persistPickDecisions` is gone.
`recordDecisionRun` (`nfl-decision-tape.js`) is the only writer of the
append-only tape (`nfl_decision_runs`/`nfl_decision_events`), and it now also
rebuilds the `nfl_pick_decisions` latest-view cache as a side effect
(`refreshPickDecisionsCache`) — every former caller of the old function,
plus `t60-runner.js` and the execution pipeline (which never wrote the cache
before), now go through the one path. Verified: `nfl-auto-picks.js` no
longer exports `persistPickDecisions` at all (asserted by a new test), and a
full-repo grep found zero remaining call sites.

**T-60 packet consumption.** New in this merge: `autoPickDecisionBoardForPacket()`,
a packet-sourced counterpart to the live weekly board that runs the *exact*
same per-game math (via a newly shared `buildCandidate()`) but sources its
market quote from a frozen T-60 evidence packet instead of a live re-read of
`game_lines` — closing the gap where a decision was recorded on the tape as
`frozen_packet` evidence while the board computing it still read live,
mutable tables underneath.

---

## 4. The one real merge conflict, and what I found while resolving it

`server/services/nfl-auto-picks.js` conflicted for a real reason: u2 had
added `is_market_identity` to the old *inline* per-game decision logic;
unify-systems, cut from an earlier commit, had independently extracted that
same logic into a shared `buildCandidate()` function (to support the new
packet-sourced board) with no knowledge `is_market_identity` existed yet.

**Resolution**: kept unify-systems' extraction (needed for the packet board)
and re-added `is_market_identity` — top-level and under
`coordinated_decision_head` — plus the board-level
`blend_mode`/`market_identity_games`/`total_games` fields into the new
`buildCandidate()`. A duplicate copy of the function left over from the raw
merge was removed. Second conflict, same file: unify-systems deletes
`persistPickDecisions` outright (part of the "one writer" consolidation,
confirmed intentional and tested); took that side.

**What I found while resolving it, not what either branch reported on its
own**: `refreshPickDecisionsCache()` — the new function that replaces
`persistPickDecisions` and is now the *only* code that writes
`nfl_pick_decisions` — was written before u2 existed and did not carry
`is_market_identity` from `nfl_decision_events` into the cache it rebuilds.
Merging the two branches as-is would have silently dropped u2's flag from
the one table its own real-data validation actually reads, the moment this
merge shipped. **Fixed as part of this merge**: `refreshPickDecisionsCache`
now includes `is_market_identity` in its UPSERT, sourced from the tape event
it's already reading. This is not new scope — it's what both branches
already required of each other, and neither branch could have caught it in
isolation because neither could see the other's diff.

All migration-number collisions (three of them — u5's `041` collided with an
existing `041`, and u2's/historical's independently-chosen `045`/`046`
collided with each other) were renumbered to the next free slot
(`046`/`047`/`048`) with the exported `name` constants and every prose
reference updated to match. Final migration sequence: `000` through `048`,
no gaps in logic, no duplicate numbers.

---

## 5. What needs Nick's own review — starting with the one that matters most

### 5a. A prior session already wrote to your live production database

This did not happen in this integration session, and I have not written
anything to `server/data.sqlite` myself — every check in this report used
`{ readOnly: true }` or a `/tmp` scratch path. But it happened, and you
haven't been told:

`unify-2026-09-12-u4-prop-reconcile`'s own commit message
(`7aef3e9`) states: *"Validated against the real server/data.sqlite (read via
node:sqlite, then the intended UPDATE-only repair run once): 101,414 of
101,820 rows were non-modeled before the run; all 101,414 were reviewed and
updated by the fixed matcher. Modeled rows went 406 -> 75,377."*

**I confirmed this against the live database myself, right now, read-only**:
`nfl_prop_clv` currently holds exactly 75,377 rows with
`model_match_status='modeled'`, 24,131 `role_ineligible`, 2,264
`projection_missing`, 48 `unsupported_participant` — zero rows remain in the
old `identity_unresolved` status the commit says it cleared — out of 101,820
total rows, unchanged from before. **This is not ambiguous: the backfill
script ran for real, against your live database, before this integration
session began**, most likely during whatever session produced the
`u4-prop-reconcile` branch.

What this is *not*: it is not schema damage, it did not touch `-wal`/`-shm`
directly, it did not change row counts, and by its own accounting it
reclassified rows that a previously-fixed matcher bug had stuck with a wrong
terminal status — the numbers read like a genuine repair, not corruption.
What it *is*: a write to the one file this entire multi-session sweep was
explicitly forbidden from writing to, executed anyway, with the resulting
state now baked into production and already re-derived by (and consistent
with) everything downstream that reads `nfl_prop_clv`. I have not attempted
to verify or second-guess the correctness of the 74,971 reclassifications
themselves — that would require re-deriving the matcher's logic against real
player identities, which is out of this report's scope — only that the write
happened and what it changed. **You should decide** whether this needs
anything further (an audit of the reclassifications, a policy conversation
with whatever produced that branch, or nothing at all because the result
looks correct) — it is not mine to decide, and I have not touched the
database in either direction.

### 5b. u2 / u3's own flagged items, still open

- **u2**: `nfl_decision_events` (the append-only tape) is still empty in
  production (0 rows) even after this merge — `recordDecisionRun` exists and
  is wired into `unify-systems`' consolidated call sites, but nothing has
  actually invoked it against a real week yet. The 16/16 "100% market
  identity" figure is real, but was measured off the older
  `nfl_pick_decisions` mutable view, not the tape. Worth watching the first
  real `recordDecisionRun` call land correctly in production before trusting
  the tape's own copy of `is_market_identity` the way this report trusts the
  mutable-view copy.
- **u3**: could not reproduce the orchestrator's cited baseline ("9
  past-kickoff, 4 of 9 settle") against live data at inspection time (only 2
  of 16 games had kicked off). Not alarming — the fix it built addresses a
  more severe, independently-quantified version of the same risk — but worth
  30 seconds to figure out where that number came from.
- **u1**'s `SCORE_GRACE_HOURS=6` and **u3**'s `NEAR_KICKOFF_HOURS=6`/`STALE_BOOK_HOURS=72`
  are judgment calls, documented in code, not specified by any prior
  constant in the codebase. Reasonable, not gospel.

### 5c. The historical verdict itself is not a "needs review" item — it's the
answer

Nothing about the model or betting stable is ready to bet real money on. That
isn't a gap in this integration; it's what four independent measurements of
your own real history say. The one exception (line-shopping, row 4e) already
requires no forecasting to be worth keeping.

---

## 6. Ready to merge to `main` with confidence

All seven branches' own code changes, as merged into this branch:

- **u1-week-sync** — safety net only, verified not to change today's real
  answer, fixture-proven for the stalled case.
- **u2-market-identity** — purely additive, exact real-data reproduction,
  now with the cache-rebuild gap (§4) fixed.
- **u3-beat-the-close** — narrows a real, quantified staleness risk; no
  regression to the two real settlements that already exist.
- **u4-prop-reconcile — the *code* only** (see §5a for the database write,
  which is a separate decision from whether this code is safe to merge going
  forward; the script itself is inert unless manually invoked again).
- **u5-clv-endpoints** — clean on every axis checked.
- **historical** — the report and its instrumentation (not a "fix" to merge
  so much as the record itself); reproduced in full.
- **unify-systems** — the architecture consolidation, including this
  session's own fix to `refreshPickDecisionsCache`.

Full suite: **1918 / 1958 tests pass**, 1 failure, 39 skipped.
`npm run typecheck`: clean. `npm run lint`: clean, 665 files.

The one failure —
`test/nfl-execution-pipeline.test.js:62`, `resolveQuoteBasis: prefers the
real multi-book quote tape when this event is actually covered by it` — is
not new. It is the same date-boundary-sensitive failure independently
confirmed as pre-existing, on the unmodified base branch, by no fewer than
six prior reports across this project's last two sweeps
(`GIANT_PLAN_BUILD_REPORT.md`, `MODEL_BUILD_REPORT.md`,
`BETTING_MODEL_REPORT.md`, and now u1/u2/unify-systems's own reports here). I
confirmed the file this test lives in was untouched by any of the seven
branches merged tonight. It has never been fixed by anyone; it is not this
merge's regression to own, but it is worth someone finally tracking down the
real bug in `resolveQuoteBasis` instead of it being waved through an eighth
time.

## What still needs Nick, in one list

1. **Decide what to do, if anything, about the u4 database write (§5a)** —
   this is the only item in this whole report that is a decision rather than
   a finding.
2. Reconcile u3's "9 past-kickoff" figure against what's actually in the
   database now (§1/§5b) — low stakes, quick to check.
3. Watch the first real `recordDecisionRun` invocation land in production
   before fully trusting the append-only tape's own copy of
   `is_market_identity` (§5b).
4. Everything else in this report is a finding, already checked, not a
   decision.
