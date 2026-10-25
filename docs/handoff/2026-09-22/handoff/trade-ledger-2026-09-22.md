# Handoff — Trade Ledger thread — 2026-09-22

Written 18:02Z. Everything below is `git`-checked against `origin/main` at
**`c90d2834`** unless a line says otherwise. Where I could not check something,
it says so rather than rounding up.

---

## THREAD

**Trade Ledger** (the coordinator addresses it as "Trade-ledger thread";
"Trade Brain" in older notes). Its subject is the trade path: what the app
predicted, what it said when it could not see, and whether those two are ever
confused with each other.

**Designated branch:** `claude/project-thread-3xqh5l` — every branch it owns
carries that prefix.

---

## SHIPPED

Both merged into `main` today, both deployed in `c5ee3b54`.

| PR | Merge sha | What landed |
|---|---|---|
| #91 | `e3e76025` | Every read on the trade path says what measured it |
| #111 | `ac31922d` | A failed archetype read is reported by asking, not by being thrown at |

**#111 is worth knowing about even if you never touch it again.** It fixed a
regression on `main` that was blocking every PR in the fleet, and the cause is
the lesson: #89 (`manager-archetypes.js`) and #91 (`routes/trades.js`) had
**zero file overlap** and still broke each other, through a contract coupling.
#89 made `archetypesFor` return early instead of throwing; #91's `catch` was
waiting for that throw. Both were green alone. Together, red.

---

## OPEN

Six PRs, all draft. Order matters for the first four: they are the merge stack.

### #94 — the trade outcome ledger
- Head **`ff38f5a2`**, rebased onto `c90d2834` at 17:59Z. Base `main`.
- Remote still shows `00319229`; the rebased head is **not pushed yet** — it is
  waiting on the gate run started 17:59:52Z.
- Evidence Auditor: **REAL** on `00319229`. That verdict does **not** travel to
  `ff38f5a2`; re-submit.
- Left before merge: gate exit code, push, Auditor on the new head, then squash.
- Adds `trade_outcomes` (migration `067`) and `server/services/trade-outcomes.js`.
  **No real observed row exists yet** and the PR body says so first — the
  `observed` rows need `scripts/collect-league-transactions.mjs`, which has never
  run here.

### #103 — the bare-catch sweep
- Head **`08c729e1`**, base `ac31922d`, CI green there, Auditor **REAL** there.
- Not rebased yet. Its base predates #108, so `check:wiring` does not exist on
  its tree at all — the gate on it today would be five steps, not six.
- Left before merge: rebase onto whatever `main` is after #94 lands, run the
  gate, re-submit to the Auditor, **and delete the false paragraph at body
  line 95** ("CI is disabled on this repository, so no check will report here").

### #120 — a crashed read stops telling Nick to send the offer
- Head **`a1164dd5`**, base `08c729e1` — **genuinely stacked on #103**, so it
  moves when #103 moves. CI green, Auditor **REAL** on its own tree `9fad5221`.
- Same `check:wiring` gap as #103.
- Left before merge: rebase after #103, gate, re-submit, squash.

### #100 — two reads that said "absent" when they meant "I could not look"
- Head **`29c825cf`**, **pushed**, base `f620a120` (one merge behind `c90d2834`).
- Last full gate: `CHECK_EXIT 0`, 3539 tests / 3498 pass / 0 fail / 41 skipped,
  tree `7a0ad270` unmoved either side, 17:50:48Z–17:59:09Z. `WIRING_EXIT 1` at
  the time — that was `main`'s own failure and is now fixed by #129.
- Left before merge: rebase onto post-#120 `main`, one six-step gate, Auditor,
  squash.

### #70 — say what the Trade Brain is tested on
- Head `10daad70`, base `791b131f`. Very far behind. Evidence-only, one document.
- Body corrected today (the false "no CI / minutes spent" claim, and a stale
  "pushes are frozen"). Its figures were measured 2026-09-20 and are **not**
  re-measured; the body now says so.
- Left: a rebase and a fresh run before anyone treats its numbers as current.

### #41 — every manager read says when it was measured
- Head `12223841`, base far behind. Body corrected today (same false CI claim).
- Same position as #70: figures describe a 2026-09-20 tree, not a merge candidate.

### #136 — the jev/4b port, snapshot only
- Head `7e57a9ba`, 103 commits off base `654ff933`, **conflicts with `main`**,
  no gate run, opened today purely so the work survives the container.
- Conflicts in `routes/trades.js`, `counterparty-pricing.js`,
  `manager-archetypes.js`, `manager-signals.js`, `test/manager-signals-api.test.js`,
  `docs/tdd/manager-page-reads.tdd.md`.
- **Do not rebase it.** Most of its volume is already on `main` by another route.
  Re-derive the three or four pieces that are genuinely still missing, each as
  its own small PR. The PR body lists them.

---

## BLOCKED

Nothing is blocked on another thread as of 18:02Z. The block that held all day
is **cleared**: `main` was red on `check:wiring` from `eb19f475` (#108, which
added the gate to a `main` that already failed it) until #129 merged as
`c90d2834` at ~17:55Z.

The only thing outstanding is sequencing: #94 → #103 → #120 → #100, each rebased
and re-gated after the one before it lands, with the Evidence Auditor as the
serial gate.

---

## FINDINGS HANDED OFF, NOT BUILT

| Finding | Owner |
|---|---|
| `docs/NUMBER-PROVENANCE.md` is stale on the counterparty layer: cites `counterparty-pricing.js:49, 120` where the constants now sit at `:28`, `:30`, `:98`, `:101-105`, `:112`, `:172-187` | whoever owns that document |
| `waiver-brain.js:269` hardcodes `accept_probability: 0.9` and serves it as `confidence` at `:309` — a constant presented as confidence | waivers |
| Six more bare catches over a SQL read of a table no migration creates, from a scan of `main` that found eight across six objects; #100 and #103 take the first two | the bare-catch unit |
| Eight shas in `manager-data-pipeline.tdd.md` (lines 65-68, 157, 162) and `valuation-map.tdd.md` (49-50) cite PR #34's branch, closed unmerged, unreachable from `main` | whoever owns those merged files — explicitly **not** this thread |
| Read-only production SQL probe for the trade-ledger state (queries 1-5 plus a `PRAGMA` on `league_transactions_raw`) | with Scheduler, in the post-deploy paste block |

---

## RULES AND LESSONS a new session must know

**A rebase can move which commit is the GREEN, not just its sha.** On #100,
`bdb97355` closed its RED/GREEN pair on the old base and does not on
`f620a120`: `main`'s `transactionsCollected` reads `last_seen_at` unguarded, so
the test now throws out of the accessor before the fix under test is reached.
The pair closes two commits later at `f7977515`. After any rebase, re-run each
cited commit in a detached worktree; do not relabel shas and carry the figures.

**Zero file overlap does not mean no interaction.** See #89/#111 above. It has
now happened twice in one day.

**`npm run check` was five of CI's six steps until today.** `check:wiring` was a
separate script at `package.json:36`. #129 folded it in, so on `c90d2834` the
one command is the whole gate. **Any evidence file saying "local check exit 0"
written before 17:55Z means five steps, not six.**

**A tool's output order is not its control flow.** I read a CI log positionally
and named the stale accept-list entry as the cause of `check:wiring`'s exit.
Wrong: that block only `console.log`s, and the sole `process.exit(1)` is at
`scripts/wiring-map.mjs:4095`, driven by the blocking findings. The comment at
`:4060-4066` says that entry is a deliberate pre-registration and that failing a
build on it "would teach people to delete the entry rather than land the file" —
which is what my wrong comment recommended. Corrected on #94.

**Citation rule (Auditor R52.2), with its caveat.** Cite RED/GREEN as `#N`,
subject, sha; carry the RED's failing assertion text, not its line number; fix
any cited sha unreachable from the **PR head**. It is scoped to open PRs on
purpose: an audit of every commit-shaped citation in `docs/tdd`,
`docs/inventory` and `docs/evidence` on `main` found **198 of 324 unreachable
(61%, across 74 files)** — the normal result of squash-merging. Merged
citations are preserved by `refs/pull/N/head` and are **not** to be rewritten.

**The compute cache can make a second search silently return the first.**
`tradeIdeasFingerprint` (`trade-engine.js:1446`) reads `manager_profiles`' row
COUNT and `MAX(updated_at)`, and `fingerprint()` counts globally
(`compute-cache.js:55`). A fixture that edits a tier in place moves neither.
Scanned this stack: one test runs two searches, zero update in place, so none
was vulnerable — but the proof was accidental, so `29c825cf` now asserts it
outright, mutation-verified.

**The tree-hash guard needs both halves.** `git write-tree` hashes the *index*,
so `git status --porcelain` is the load-bearing half. Capture both before **and**
after. An empty `node_modules` mtime means the worktree has none, and the
offline-guard tests then fail with `ERR_MODULE_NOT_FOUND`, which looks exactly
like a regression and is not one.

**Freeze a script before running it in the background.** A runner overwritten
mid-run made `bash` re-read it at a byte offset and die at the guard's closing
lines; the run completed but its exit code was never recorded. Run a frozen copy.

**Worktrees:** `git worktree add --detach <dir> <sha>` then
`cp -al /home/user/gridiron-hq/node_modules <dir>/node_modules`. Hard links, no
`npm ci`, same mtime. Verify the mtime matches.

---

## FILES this thread owns or holds grants on

`server/services/manager-signals.js` (confirmed by the coordinator 17:01Z),
`server/services/counterparty-pricing.js`, `server/services/trade-tactics.js`,
`server/services/trade-outcomes.js`, `server/routes/trades.js`,
`server/migrations/067_outcome_ledgers.js`,
`test/trade-outcomes.test.js`, `test/trade-tactics.test.js`,
`test/valuation-map.test.js`, `test/manager-data-pipeline.test.js`,
`test/helpers/with-table-replaced.js`, `test/swallow-scan.test.js`,
`docs/tdd/trade-outcomes.tdd.md`, `docs/tdd/valuation-map.tdd.md`,
`docs/tdd/manager-data-pipeline.tdd.md`, `docs/tdd/sweeps/trade-outcomes.mutations.mjs`.

One editor per server file is a standing rule. Check with the coordinator before
touching anything not on that list.

---

## NEXT THREE STEPS, cold start

1. **Read `$S/rb94-run4.log`** (scratchpad) for `CHECK_EXIT` on `ff38f5a2`. If
   0 and the guard is clean either side, push #94 (`git push -u origin
   claude/project-thread-3xqh5l-outcome-ledger`, no force needed — the rebase
   rewrote history, so `--force-with-lease=<branch>:00319229`), send head plus
   exit code to the coordinator and the Evidence Auditor, and merge on REAL.
2. **Rebase #103 onto the new `main`**, delete the false CI paragraph at body
   line 95, run the six-step gate, submit, merge. Then #120, which is stacked on
   it, then #100.
3. **Re-derive #136's surviving pieces** one at a time, as separate small PRs.
   Do not rebase that branch.

Backup refs for every rewritten head are in the local repo under `backup/`
(`backup/ledger-00319229`, `backup/datakey-0cfd96d4`, `backup/datakey-2ef11634`,
`backup/ledger-f0fa58d7`, `backup/ledger-8406ecbd`, `backup/tactics-81f5b09e`,
`backup/enginefault-89de8326`). **These are local only** — they die with the
container. Everything that matters is on a pushed branch or in a PR above.

---

## ADDENDUM — 18:45Z, stopped mid-stack on a usage freeze

Nothing merged after 18:02Z. The thread stopped on Nick's own word about token
spend, with #94 pushed and both its gates in flight — so the state below is
"pushed and unverified", not "ready".

**`main` is now `ea69d9f3`**, eleven squash merges past the `c90d2834` the body
of this document was written against (#62, #55, #90, #121, #127, #132, #85,
#123, #72, #122, #137). Every head named earlier is at least one rebase behind.

| PR | Head now | Base it sits on | What it still needs |
|---|---|---|---|
| #94 | **`0dbc9976`** (pushed 18:33Z) | `ea69d9f3`, rebased clean, porcelain 0 | CI on the exact head was **still running when this stopped — unverified**; the local six-step guard was killed mid-test-run and produced no exit code; the sweep has not been re-run on the merging tree `7d092a83`; the PR body is still the old one and needs replacing from `$S/pr94-body-v2-top.md` |
| #100 | `29c825cf` | `f620a120`, twelve merges behind | rebase, one guard, CI, body edit, squash |
| #103 | `08c729e1` | `ac31922d`, far behind; `check:wiring` does not exist on its tree | rebase, guard, **delete the false "CI is disabled" paragraph at body line 95**, squash |
| #120 | `a1164dd5` | `08c729e1` — genuinely stacked on #103, moves when it moves | rebase after #103, guard, squash |

**What #94 gained since this document was written**, all of it pushed: RED/GREEN
are now `92f31b7d` → `e363b35c`; a designed **not-applied control** was added to
`docs/tdd/sweeps/trade-outcomes.mutations.mjs` and proved live (as written: 34
rows, 32 killed, 0 survived, CONTROL SURVIVED, NOTAPPLIED BAD_ROW; with its
`find` made matchable by a parsing-valid no-op replace: exit 1, `NOTAPPLIED
SURVIVED`, detector message fired); and the evidence file's citations were
repointed with its false "CI is not run, Actions minutes are spent until
2026-10-01" paragraph struck.

**The figures carry across that rebase and the reason is checkable, not
assumed:** `test/trade-outcomes.test.js` is blob `2fef09bf` at both the old and
the new RED and at both the old and the new GREEN, and
`server/services/trade-outcomes.js` is absent at both REDs and blob `c46d60de`
at both GREENs. Same bytes, same run. Never carry a figure across a rebase
without that check — the moved-GREEN lesson above is what happens when it does
not hold.

**Do not report #94 as gated.** The last completed six-step run on this branch
was on `0074abe2` / tree `9ac8471f` (exit 0, 3630 tests / 3589 pass / 0 fail /
41 skipped, 474.4 s), and `0074abe2` is one rebase and three commits behind the
pushed head. Re-run the gate before anyone treats `0dbc9976` as measured.

**PR activity subscriptions were dropped at 18:45Z** so no CI webhook wakes a
session for these. Whoever picks this up re-subscribes to the one PR they are
actually driving, not to all four.

**Local-only, dies with the container:** `backup/ledger-9cd8038b` and the
worktree at `$S/rb94`. The pushed branch carries everything that matters.
