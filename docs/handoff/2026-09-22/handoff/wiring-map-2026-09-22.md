# Wiring map — thread handoff, 2026-09-22

Written at 18:05Z against `main` = `c90d2834b827f32e62117d20ae5e63ff6774b264`.
Everything below is measured on a tree that is in the repository, or it says
plainly that it is not.

---

## THREAD

**Wiring map.** Phase 0 item 5: the honest inventory. Nick's words for it were
"take full inventory of everything built so far — every model, every pipeline,
every thread's work — what's actually wired and working, what's half-done,
what's dead or stale, what's silently broken. Be brutally honest; if something
is decoration or doesn't pull real data, say so."

The thread's product is not a document. It is **a gate that fails a build when
something new lands unwired**, plus the inventory and the contract that explain
what the gate means. `node scripts/wiring-map.mjs --check` is that gate, and it
now runs in `npm run check` as well as in CI.

**Designated branch:** `claude/wiring-map-8f96ur`. Work since #108 has gone on
suffixed branches off it, one per unit, because the designated branch's remote
head is frozen (see FILES).

---

## SHIPPED

| PR | merge sha | what landed |
|---|---|---|
| **#108** | `eb19f475` | The gate turned on over existing debt: `--check` blocks new `column-read-never-written` and `producer-with-no-caller` findings, with an 881-row inventory and an accept list that carries an owner and a retirement condition per entry. |
| **#129** | `c90d2834` | Three false positives in that gate, the silence the fix would have bought, and `check:wiring` folded into `npm run check`. |
| #36 | closed | Superseded by #108. Branch kept. |
| #54 | closed | The routes it labelled no longer exist on `main` (see FINDINGS). Branch kept. |

**Main's own push run on `c90d2834` is `35763448618` — completed, conclusion
`success`, 17:52:35Z → 18:00:52Z.** That is the run that confirms `main` is
green after the gate fix, measured rather than inferred.

### What #129 actually fixed, because it will come up again

`main` went red on the gate the moment #108 merged, and **every open PR in the
fleet went red with it**, because a `pull_request` build checks out
`merge(head, base)` — so a main-side gate reaches every branch immediately,
without anyone rebasing. All three blocking findings were the map's own
mistakes:

1. **A database handle passed in as a parameter.** `server/services/td-features.js:188`
   queries the nflverse database as `nflDb.prepare(...)`, and `handleFor` fell
   through to `'app'`, pushing `play_by_play` and `pbp_participation` into
   `table-never-written`. An explicit receiver the resolver does not recognise
   is now **reported as itself**. Measured across the repo before the change,
   because `appDb` is also a parameter and genuinely is the app: 24 candidate
   sites, exactly 2 tables move.
2. **A function a job registry calls.** `producer-with-no-caller` counted
   `name(` only, so `league_rosters: { run: refreshLeagueRosters, … }` at
   `server/services/scheduler.js:1299` read as uncalled. `callSites()` now
   counts a registration.
3. **A pinned test that was wrong.** The test asserted that an unrecognised
   receiver resolves to the app while its own preamble warned about "a query on
   a second database silently filed as the app's". Reversed, with the reason
   written into the test.

---

## OPEN

**#137** — `claude/wiring-map-8f96ur-contract-column`, head `3a770c6`, base
`main`, **draft**, docs-only.

The reach-grade column in `docs/inventory/CONTRACT.md` printed `wired` = **178**
while its other five cells printed the **172** measurement they came from, so
the column summed to **325** under a printed total of **319**. The +6 was §2b's
hand-adjustment applied to one cell without taking those six files out of
whatever they had been graded before, and nobody has ever named which six. The
table now prints measured cells only, with the sum, pinned to `c90d2834` and to
the population's own subtree hashes (`server/services` `2c900fff`,
`server/modeling` `6bbd8e6a`), with the command that produces each column
printed beside it. Both columns sum to 321.

Gate exit code on this head: **0**. Local `npm run check` not re-run for a
docs-only diff; CI is the first execution.

**Left before merge:** CI green, then merge — docs-only PRs skip the Evidence
Auditor by standing rule. The headline bracket at `docs/inventory/CONTRACT.md:126-135`
is deliberately **not** touched in this PR.

---

## BLOCKED

1. **The MLB removal commit** — blocked on the **Scheduler thread** naming its
   branch and listing its edits. My part is two edits, ready to write the
   moment the branch exists: `scripts/wiring-map.mjs:2164-2165`, which classifies
   MLB files and `mlb_*` tables as betting, and the `mlb` column in
   `docs/inventory/CONTRACT.md`. It goes as **one commit on Scheduler's branch**,
   with both gates run on the combined head. Nick's word, 17:24Z: "get rid of
   MLB btw".
2. **The §2b low-end correction** at `docs/inventory/CONTRACT.md:126-135` —
   held by the coordinator until the **Independent Auditor** rules on
   Opportunity's ladder command. Do not revise the headline bracket before that
   ruling. #137 says so in the file itself.

---

## FINDINGS handed off, not yet built

One line each, with who it belongs to.

1. **The stale-entry report cannot tell a deliberate pre-registration from a
   rotted entry, and that is a trap.** The gate reports
   `server/services/cascade-grade.js — names a file that is not in this tree`.
   **Do not delete that line.** It is pre-registered on purpose: the file
   arrives with PR #72, and `_PERMANENT_ORPHAN_REASONS` in
   `docs/wiring/annotations.json` says so in full, with the owner (Opportunity
   thread) and the retirement condition. The gate's own code comment anticipated
   exactly this case. The defect is in the **report**, which invites a reader to
   delete a correct entry — I nearly wrote that instruction into this document
   before checking. The fix is for `staleOrphanEntries` to read the
   `PRE-REGISTERED` marker and label the two cases apart. **Owner: this thread**,
   going in with the ratchet below.
2. **19 queries run on a receiver the resolver cannot identify.**
   `td-features.js` (7 sites, `appDb`/`nflDb`), `scripts/run-historical-leaderboard.mjs`
   (8 sites, `rdb`), `test/model-registry-persistence.test.js` (4 sites,
   `upgradeDb`). Each is a handle the file was handed rather than one it opened,
   so any table read *only* this way is filed as belonging to another database
   and is invisible to the missing-feed rules. **Owner: this thread.** The unit
   is the **ratchet**, pre-registered in #129's body: baseline the 19 and fail
   only when the count **grows**, the same shape as `accepted_missing_feeds`.
3. **Six grandfathered producers are still open**, listed in full by the gate on
   every run. `syncEspnMarket()` (`server/services/espn-market.js:18`) is the worst
   by some distance — it is the sole writer of `espn_player_market`, which is
   read at zero hops by `server/routes/aggregates.js:226` and by four more
   fantasy modules, so this is a **live fantasy surface reading a table nothing
   fills**. **Owner: the feature-audit thread**, with the Scheduler thread
   registering it as a job. The other five: `backfillNewsEntities()`
   (`server/routes/espn.js:210`, fantasy, unassigned) and four betting-scope ones
   that retire only when betting is back in scope.
4. **An availability figure that carries no basis cannot be told apart from the
   unfitted durability prior**, and a kicker — a position the fit does not cover
   — reads as a low chance of playing rather than as not modelled. This was #54,
   now closed because `server/routes/model.js` no longer has the routes.
   `availabilityBasis()` is already exported from `server/services/contingency.js`;
   the per-player reasoning is in commit `b6f72e6` on
   `claude/wiring-map-8f96ur-availability-basis`, which stays. **Owner:
   unassigned**, and it only matters if those payloads are ever rebuilt.
5. **Two adjacent pairs in `accepted_orphan_modules` are out of alphabetical
   order** (`vegas-fantasy.js` before `roster-risk.js`; `week-postmortem.js`
   before `position-liquidity.js`). Pre-existing, found by the Fantasy plan
   thread, deliberately left alone. Cosmetic.

---

## RULES AND LESSONS a new session must know

### How the gate works

- `node scripts/wiring-map.mjs --check` — exit 1 on a **new** finding of a
  gating rule. `GATING` is exactly two rules: `column-read-never-written` and
  `producer-with-no-caller`. Everything else is reported and does not fail.
- It runs in CI at `.github/workflows/ci.yml:70` **and** inside `npm run check`
  (`package.json:20`). Those are two separate invocations. CI calls each npm
  script directly and **never invokes `npm run check`**, so removing the CI step
  would delete the gate from CI even though `check` also contains it. This was
  got wrong once already.
- On the current tree the map is **1053 files, 333 tables, 765 surfaces, 2520
  findings**.

### The accept list

`docs/wiring/annotations.json` holds `accepted_missing_feeds` (23) and
`accepted_orphan_modules` (50). **It is a ratchet, not approval.** Every entry
carries an owner and a **RETIRES WHEN**, and the retirement condition must be a
**result, not a date or an intention** — that is the whole difference between
this and a junk drawer. `NEVER_BASELINE` holds one rule
(`producer-with-no-caller`) whose findings may never be added at all; the six
grandfathered ones predate the list and are printed on every run instead.

`staleOrphanEntries()` (#108) closes the rot: an entry that names a file no
longer in the tree, or a module that is wired now, is reported as having
outlived its reason. **Report, never gate** is deliberate here — a build that
failed on a stale entry would teach people to delete the entry rather than fix
the thing.

### Read this before diagnosing a red build

- **A gate baselined at one tip of `main` and landed at another is the failure
  mode.** #108's gate was verified against `ac31922`, nine PRs landed, GitHub
  squash-merged it onto the new tip without a conflict, and the gate never ran
  against that combination. **Rebase onto current `main` and re-run the gate
  immediately before merging a gate change**, every time.
- **CI builds `merge(head, base)`.** No local run on your own head can reproduce
  a main-side failure until you merge `main` in first.
- **The recurring defect class in this map is a confident default standing in
  for a question nobody asked.** Four instances so far: `boot:server/index.js`
  made reachability answer yes always; `CLOSE_HOPS` made it no at the tail;
  `'app'` made every unrecognised handle the app's; `name(` made every
  registry-dispatched function uncalled. When the resolver does not know, it
  must **say so**, not pick.
- **Naming an unknown receiver trades a visible false positive for an invisible
  false negative.** Reclassifying a table to `table-in-another-database` makes
  it `context`, and the gate prints grandfathered, refused, stale and blocking
  findings but **not** context. That is why `unresolvedReceivers` exists: it
  reports the resolver's own ignorance where a reader can see it.
- **A test can hold the correct reasoning in its comment and the wrong claim in
  its assert, and nothing notices until the claim costs something.** One of
  #129's three findings was pinned by my own test, whose preamble argued against
  its own assertion. The guard caught it; reading it had not.
- **`npm ci` before trusting any suite number.** A fresh clone fails the
  offline-guard tests with `ERR_MODULE_NOT_FOUND`, which looks exactly like a
  regression and is not one.

### Numbers and citations

- **Cite the population, not the repository.** A whole-tree write-tree hash
  moves when anything moves. For the reach-grade column the citation is the two
  subtree hashes: `server/services` `2c900fff`, `server/modeling` `6bbd8e6a` on
  `c90d2834`. Two threads reached 321 files and those two hashes independently.
- **Every published `node scripts/reach-grade.mjs` figure is a request+job
  figure.** `repoGraph` builds with `buildImporterGraph`
  (`scripts/reach-grade.mjs:352`), which does not separate module-scope edges
  from function-body ones; the CLI (`:364`, `:372`) calls nothing else; and
  `classifyImportEdges` (`:125`) has no caller in the repository outside
  `test/reach-grader-all-paths.test.js:363`. The request-only end has only ever
  come from a hand-written driver, which is why it moved four times
  (205 → 196 → 172 → 178) while the upper end moved once.
- The 172/228 pair was measured on tree `500bab36`, commit `b0c1616d`. **Neither
  object is reachable from this repository**, so that pair cannot be re-run by
  anybody. Quote it only with that attached.

---

## FILES this thread owns or holds a grant on

Owned, one editor per file:

    routes/model.js                     routes/accolades.js
    scripts/wiring-map.mjs              scripts/inventory.mjs
    docs/wiring/annotations.json        docs/inventory/CONTRACT.md
    server/services/gridiron-model.js   scripts/run-purged-evaluation.mjs
    scripts/run-historical-leaderboard.mjs
    scripts/freeze-baseline.mjs         scripts/joint-score-report.mjs
    scripts/lib/evidence-report.mjs
    test/decision-inbox.test.js         test/health-endpoint.test.js

Grant, narrow: **`package.json`**, granted 17:01Z for the `check:wiring`
one-line change only. That change has landed in #129. The grant is spent.

**Branches. Do not move `claude/wiring-map-8f96ur` at `603080a`** — it is PR
#36's frozen head, kept deliberately after #36 was closed. The Stop hook
compares against it and reports phantom "unpushed commits"; verify with
`git rev-list --count @{u}..HEAD` before believing it. Live branches:

    claude/wiring-map-8f96ur-contract-column   3a770c6   PR #137, open draft
    claude/wiring-map-8f96ur-gate-fix          6432a768  PR #129, merged
    claude/wiring-map-8f96ur-availability-basis 207f7640 PR #54, closed, kept
    claude/wiring-map-8f96ur-inventory-hold    a333f449  PR #108's head, kept
    claude/wiring-map-8f96ur-census-hold       603080a
    claude/wiring-map-8f96ur-route-gate-hold   23ed6daf
    claude/wiring-map-8f96ur-usage-coverage-hold        2626712b
    claude/wiring-map-8f96ur-usage-coverage-setup-hold  a44f53ca

The four `-hold` branches are parked units, not in flight.

---

## NEXT THREE STEPS if someone picks this up cold

1. **Get #137 merged.** Head `3a770c6`, base `main`, docs-only, gate exit 0 on
   the head. Watch its CI, mark it ready, merge on green. No Evidence Auditor
   pass is needed for a docs-only diff.
2. **Do not delete the `server/services/cascade-grade.js` accept-list line.**
   The gate reports it as naming a missing file, and it is correct to report it,
   but the entry is a deliberate pre-registration for PR #72 with its reason
   written out in `_PERMANENT_ORPHAN_REASONS`. Teach the report to say which of
   the two cases it is looking at instead.
3. **Build the unresolved-receiver ratchet.** Baseline the 19 sites the gate
   prints, fail only when the count grows, same shape as
   `accepted_missing_feeds`. It was pre-registered in #129's body as
   non-blocking, and it is the only thing standing between "the resolver
   reports its own ignorance" and "the resolver's ignorance quietly widens".

Then, when the Scheduler thread names its branch, the MLB commit; and when the
Auditor rules on Opportunity's ladder, the §2b low-end correction. Both are in
BLOCKED above with everything needed to execute them.

---

## ADDENDUM, 18:42Z — hard stop

Written at a hard stop on Nick's order. State as of this moment, not a plan.

**Merged since the body above was written.** #137 → `bd903669` (the reach column
that adds up). #147 → `532fe18a` (the correction to #137, below). The MLB
comment correction is pushed onto the Scheduler thread's branch
`claude/project-thread-o3wt2p-remove-mlb`, now at
**`5f9242d8c2d3148d064e239e6b770d7a18772412`** — that is the head #128's CI must
be green on, and Scheduler merges it, not this thread.

**#146 (the unresolved-receiver ratchet) is OPEN, CI running, not merged.** Head
**`5dfedb80e5b7bdf5257dc3867f03f547cd4932d4`**, base main, branch
`claude/wiring-map-8f96ur-receiver-ratchet`. It is ready: `npm run check` exit 0
on the earlier head `6212253` (3614 tests, 3573 pass, 0 fail, 41 skipped,
write-tree unchanged either side), body carries merge-gate v2 sections 1 to 5.
**Do not merge it on the strength of that green alone.** CI passed `6212253`
against main at `c0a051bd`; by the time it returned main was `b3e79709` and
carried two new unresolved receivers from the Coach thread
(`server/services/coach/people/grading.js corpus` 4,
`server/services/coach/people/variables.js chatDb` 9). Merging it then would have
failed the gate on main for the whole fleet — #108's shape exactly. `5dfedb8`
baselines those two with owners and retirement conditions. **Main has moved again
since (at least #147), so before merging: `git merge origin/main` on that branch
and run `node scripts/wiring-map.mjs --check`. Exit 0 or fix first.** That check
costs one command and is not optional for a PR that adds a gating rule.

**#147 corrected four cells I had merged an hour earlier, and the lesson is
sharper than the fix.** #137's table printed `hand-run-script` and `unreached` as
13/50 and 11/25; the grader's own constants give 12/51 and 10/26. My command had
filtered the file list by hand — excluding `test/**` and `*.test.js`, and using
`.jsx` rather than `.ts`/`.tsx` — where `NOT_A_CONSUMER`
(`scripts/reach-grade.mjs:81`) excludes `client/dist/` and nothing else and
`SOURCE_EXT` (`:78`) admits `.ts`/`.tsx`. 593 files against 1,054. Exactly one
subject moved, `server/services/sleeper-history.js`, because its only visited
script `scripts/collect-sleeper-history.mjs` has an importer
(`test/sleeper-crawl.test.js`) in the grader's universe and none in mine. The
command reproduced the wrong numbers faithfully, which is the worst kind of
reproducible. **Driving a tool's exported functions has to include its
constants, or the command is a re-implementation wearing the tool's name.**

**THE NEXT UNIT, and it now has two independent pieces of evidence.** The
foreign-handle collector is wrong. `handleFor` checks `foreign.has(name)` before
the `DB_RECEIVERS` convention, so a correctly-named second handle should resolve
without ever reaching the `db` fallback — and twice today it did not. First the
Coach thread's chat corpus in a local named `db` produced **ten false findings**,
which they worked around by renaming to `chatDb`; then `chatDb` itself landed in
my census as **nine sites** the resolver still cannot identify. Coach did exactly
the right thing both times and was penalised for it. **The fleet must not learn
"name your handle `db` and the gate goes quiet"** — that is the silence the whole
rule exists to catch. The defect is in how `foreign` is populated, not in
`DB_RECEIVERS`; it is noted at that declaration in `scripts/wiring-map.mjs` and
in both new `_UNRESOLVED_RECEIVERS_REASONS` entries. Start there.

**Open questions handed on, neither mine to settle.** (1) Whether a test importer
should suppress `hand-run-script` at all — the Opportunity thread owns
`reach-grade.mjs`; if the answer is no, the cells #147 just corrected move back,
with a different justification than the one that produced them first time.
(2) R66's side-effect import gap at `reach-grade.mjs:99` is real — 12 bare
`import './x.js';` edges on `c90d2834` — and measurably **changes nothing**:
restoring all twelve leaves every cell of both columns identical. Opportunity's
fix should land anyway; no number should be withdrawn for it.

**Revised step 2 of the next-three-steps above.** The original said to delete the
`server/services/cascade-grade.js` accept-list line. **Do not.** It is a
deliberate pre-registration for #72 with its reason, owner and retirement
condition written out, and `5dfedb8`'s parent teaches the report to say so. That
instruction was wrong when I wrote it and I caught it only by opening the file.
Replace that step with: merge #146 after the main-merge check above.
