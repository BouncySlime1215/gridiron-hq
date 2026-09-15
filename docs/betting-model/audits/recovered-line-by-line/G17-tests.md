# G17-tests — line-by-line audit of the Gridiron HQ test suite

Reader: **G17-tests**. Date: 2026-09-12.
Repo: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` (read-only throughout; no
process started/stopped, no migration run, no paid API called, the live DB opened only via
`node:sqlite` read-only one-liners — in the event none were needed, every claim below is sourced
from file text).

**Scope (globs expanded with `ls`, every line of every file read):**

| group | files | lines |
|---|---|---|
| `test/*.test.js` | 175 | 31,975 |
| `test/helpers/*` | 2 | 180 |
| `test/offline-guard.mjs` | 1 | 39 |
| `test/fixtures/**/*` | 16 | 2,881 |
| **total** | **194** | **35,075** |

1,624 `test(...)` declarations across the 175 spec files.

---

## 0. Executive verdict

The suite is, in the main, unusually good. It is not a smoke-test suite: it encodes economic
claims (teaser leg rates, CLV, Kelly-with-push, Shin de-vig), it has property-based tests
(`fast-check` in five files), it has walk-forward/cutoff-leakage tests, it drives real migrations
against populated fixture databases, and it repeatedly refuses the cheap option — see
`test/helpers/requires-real-history.js:21-23`, which explicitly says the disposition helper "is
deliberately NOT a general escape hatch."

The suite has one systemic hole, and it is the one that matters today:

> **`npm test` applies neither the offline guard nor database isolation. Both live only in
> `.github/workflows/ci.yml`.** Twenty-two spec files therefore open the live
> `server/data.sqlite` **read-write** when the suite is run the way the `package.json` script
> says to run it — the same file the T-60 capture server is writing to during an NFL weekend.

Everything else below is smaller than that.

**Structure verdict: acceptable.** The test code itself is well organised and heavily documented;
the *harness* around it (the `npm test` script, the guard's delivery mechanism) is the weak part,
along with a real coverage hole on the two paths Nick cares about most.

---

## 1. Focus question 1 — hermeticity: does it touch the real DB path?

### 1.1 How the real path is reached

`server/db/index.js:10`:

```js
const DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(__dirname, '..', 'data.sqlite');
```

and immediately, at import time, with no read-only mode anywhere in the module:

```js
export const db = new DatabaseSync(DB_PATH);            // server/db/index.js:13
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;                            // server/db/index.js:18
  PRAGMA busy_timeout = 15000;
`);
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (…)`);   // server/db/index.js:22-27
```

and further down:

```js
db.exec(`CREATE TABLE IF NOT EXISTS db_health_checks (…)`);    // server/db/index.js:171-176
const integrityMode = String(process.env.GRIDIRON_DB_INTEGRITY_CHECK ?? 'quick').toLowerCase();
…
      db.prepare(`INSERT INTO db_health_checks(check_name,checked_at,result,duration_ms)
VALUES (?,datetime('now'),?,?) ON CONFLICT(check_name) DO UPDATE SET …`)   // server/db/index.js:193-196
```

So *importing* `server/db/index.js` — directly or through any service that imports it — is a
**write** against whatever file it resolves. `test/offseason-model.test.js:619-620` states the
same thing in its own words: "`server/db/index.js` has no read-only mode: importing it runs
`PRAGMA journal_mode = WAL` and a page of `CREATE TABLE IF NOT EXISTS` against whatever file it
is pointed at." That file then gates itself behind `GRIDIRON_REAL_DB_SMOKE=1`
(`test/offseason-model.test.js:627-629`). It is the only file in the suite that does.

### 1.2 The guard is CI-only

`package.json:14` — the command every developer and every agent runs:

```json
"test": "node --experimental-test-module-mocks --test --test-concurrency=1 test/*.test.js",
```

No `NODE_OPTIONS`. No `GRIDIRON_DB_PATH`. No `SCHEDULER_DISABLED`.

`.github/workflows/ci.yml:78-82` — the only place the three are set:

```yaml
        run: npm test
        env:
          SCHEDULER_DISABLED: '1'
          NODE_OPTIONS: '--import ./test/offline-guard.mjs'
          GRIDIRON_DB_PATH: '${{ runner.temp }}/gridiron-ci-fixture.sqlite'
```

`test/offline-guard.mjs:17-19` believes this is how it is always loaded:

```js
 * Loaded via NODE_OPTIONS="--import ./test/offline-guard.mjs" so it applies to
 * the test runner and every worker beneath it, rather than depending on each
 * test file remembering to install it.
```

Nothing in `package.json` does that. The guard is inert locally.

### 1.3 The 22 files that reach the live database under `npm test`

153 of the 175 spec files set `GRIDIRON_DB_PATH` to an `fs.mkdtempSync` path before their first
`await import('../server/db/index.js')`, which is the correct pattern and is applied consistently.
The following 22 do not, yet still load `server/db/index.js` — six directly, sixteen through a
service import chain (chains resolved by walking the relative `import` graph):

| test file | how it reaches `server/db/index.js` |
|---|---|
| `test/always-valid-significance.test.js` | `services/backtest-significance.js → services/backtest.js → db/index.js` |
| `test/betting-fantasy-link.test.js` | `services/betting-fantasy-link.js → services/gamescript.js → services/team-codes.js → db/index.js` |
| `test/contextual-coordinator.test.js` | `services/nfl-expert-coordinator.js → db/index.js` |
| `test/execution-slate-reasoning.test.js` | `services/execution-slate-reasoning.js → services/nfl-execution-edge.js → db/index.js` |
| `test/gridiron-model.test.js` | `services/gridiron-model.js → db/index.js` |
| `test/league-brain.test.js` | `services/league-brain.js → services/lineup-brain.js → services/waiver-brain.js → db/index.js` |
| `test/nfl-advanced-depth.test.js` | `services/nfl-advanced.js → services/team-codes.js → db/index.js` |
| `test/nfl-audit-overview.test.js` | **direct** (`test/nfl-audit-overview.test.js:12`) |
| `test/nfl-drive-tape.test.js` | **direct** |
| `test/nfl-execution-staking-policy.test.js` | `services/nfl-execution-staking-policy.js → services/nfl-execution-edge.js → db/index.js` |
| `test/nfl-execution-stress.test.js` | `services/nfl-execution-stress.js → services/nfl-execution-edge.js → db/index.js` |
| `test/nfl-family-contribution.test.js` | `services/nfl-family-contribution.js → services/nfl-ensemble.js → services/nfl-availability.js → db/index.js` |
| `test/nfl-replay-opener-disclosure.test.js` | `services/nfl-replay.js → services/nfl-ensemble.js → services/nfl-availability.js → db/index.js` |
| `test/nfl-team-strength.test.js` | `services/nfl-gbm.js → db/index.js` |
| `test/paired-bootstrap-clustering.test.js` | `services/backtest-significance.js → services/backtest.js → db/index.js` |
| `test/pick-reasoning.test.js` | `services/pick-reasoning.js → services/nfl-reasoning.js → services/nfl-pbp.js → db/index.js` |
| `test/player-state.test.js` | `services/nfl-player-state.js → db/index.js` |
| `test/rookie-evidence.test.js` | `services/nfl-rookie-ingest.js → services/scheduler.js → services/nfl-espn-pbp.js → services/nfl-live.js → db/index.js` |
| `test/td-regression.test.js` | **direct** |
| `test/teaser-leg-rates.test.js` | **direct** (`test/teaser-leg-rates.test.js:28`) |
| `test/waiver-brain.test.js` | `services/waiver-brain.js → db/index.js` |
| `test/weekly-trends.test.js` | `services/weekly-trends.js → db/index.js` |

Of these 22, exactly one — `test/teaser-leg-rates.test.js:26` — sets
`process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off'`, and it explains why
(`test/teaser-leg-rates.test.js:19-21`: "a PRAGMA quick_check that last took 159 seconds on this
9.8 GB file, it writes a row when it runs"). The other 21 will, on the first run of any day, run
`PRAGMA quick_check(1)` against the 9.8 GB live database and `INSERT` a `db_health_checks` row —
21 separate processes (`node --test` forks one process per file), serialised only by
`--test-concurrency=1`, each contending on the same WAL with the live capture server.

**Mitigating facts, stated fairly:**
- `node --test` runs each file in its own child process, so `process.env` mutations
  (`GRIDIRON_DB_INTEGRITY_CHECK`, `SCHEDULER_DISABLED`) do **not** leak between files. No defect
  there.
- `server/services/scheduler.js` starts nothing at import — `startScheduler()` is an exported
  function (`server/services/scheduler.js:1066`) and no test calls it. `test/rookie-evidence.test.js`
  pulling in `scheduler.js` is noisy, not dangerous.
- None of the 22 issues a write *statement* of its own; the writes are `db/index.js`'s own
  import-time bootstrap. That is still a write.

### 1.4 Files that deliberately and correctly touch the real database

- `test/offseason-model.test.js:627-645` — opt-in behind `GRIDIRON_REAL_DB_SMOKE=1`, runs in a
  **child process** via `execFileSync` with `env: { …, GRIDIRON_DB_PATH: '' }` (line 645), and
  documents the hazard in a 10-line comment. This is the correct pattern and should be the
  template for the other 22.
- `test/nfl-audit-overview.test.js` and `test/teaser-leg-rates.test.js` both open with a
  "WHY THIS RUNS AGAINST THE REAL DATABASE" rationale. The intent is defensible (an economic
  claim cannot be proved by a fixture you tuned); the *mechanism* — read-write import of a live
  WAL database while a capture server holds it — is not.

### 1.5 The network guard is narrower than it claims

`test/offline-guard.mjs:23-24` wraps **only** `globalThis.fetch`:

```js
const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, options) {
```

`http.request`, `https.request`, `net.connect`, `dns.lookup` and any native/agent-based client are
untouched. A dependency using `node:http` directly — or the Anthropic SDK if it ever stops going
through `fetch` — passes the guard silently. The suite works around this per-file with
`mock.module('node-fetch', …)` and `globalThis.fetch = …` stubs, which is exactly the
"assertion about the suite rather than a property of the run" the guard's own header
(`test/offline-guard.mjs:5-7`) sets out to eliminate.

Second gap in the same file: the `catch` at `test/offline-guard.mjs:28-31` lets a **relative**
URL through with the comment "there is no host to reach". Under `undici` a relative URL throws
rather than resolving, so this is currently harmless, but it is a fail-open branch in a
fail-closed guard.

---

## 2. Focus question 2 — tests that skip silently

39 conditional `{ skip: … }` sites across 8 files. **37 of them are exemplary**: they skip on the
*string* returned by `realHistoryDisposition()` (`test/helpers/requires-real-history.js:41-45`),
so the runner prints a full sentence naming the tables, the row minimum, and why a fixture cannot
substitute. `test/nfl-preseason-blend.test.js:57-58` writes its own equivalent sentence inline.

**The exception is `test/nfl-audit-overview.test.js`.** Five of its seven tests skip on a bare
boolean:

```js
const run27Exists = () => row(`SELECT status FROM nfl_blind_audit_runs WHERE id=27`)?.status === 'complete';
```
— `test/nfl-audit-overview.test.js:15`, used at lines 22, 36, 48, 58 and 66.

On any machine where run 27 is absent — a fresh checkout, CI, or a rebuilt database — the runner
reports five skips with no reason. The assertions they carry are the audit path's ground truth
(`weeks_sealed === 70`, `spread_only.bets === 153`, `units ≈ -11.855`, and the "runs 27 and 31 are
byte-identical" reproducibility claim at lines 68-71). Those are precisely the numbers that must
not quietly stop being checked. This file is also the one that did *not* adopt the convention the
rest of the suite adopted, despite the convention existing specifically for this case.

There is a second, subtler silence in the same file: `run27Exists()` is evaluated at
**collection** time against a database that, under `npm test`, is the live one. If run 27 is later
superseded, the skip flips with no signal.

---

## 3. Focus question 3 — tests that assert on development data

Four files assert numbers that exist only in Nick's populated database.

**`test/teaser-leg-rates.test.js`** — the strongest example, and the most consequential, because
Wong teasers are the only measured +EV strategy in the project.

```js
    assert.equal(all.n, 2894, 'every candidate leg, pushes included');   // :189
    assert.equal(all.wins, 2124);                                        // :190
    assert.equal(all.pushes, 26);                                        // :191
    closeTo(all.rate_of_decided, 0.7406, RATE_TOLERANCE, 'pooled family rate');  // :193
```

with the policy stated at `test/teaser-leg-rates.test.js:47-49`: "Counts (`n`, `wins`, `pushes`)
are integers and are asserted EXACTLY: a count that drifts means the population changed, and that
must never pass quietly." That is a defensible design decision for a regression lock — but it is a
lock on **one developer's database contents**, gated by `realHistoryDisposition(…, {min: 5000})`
(`test/teaser-leg-rates.test.js:37-40`). Any legitimate backfill of 1999–2024 spreads changes 2894
and the test fails as a false alarm; any *corruption* that removes rows drops the count below
5,000 and the test silently skips instead of failing. The failure mode is inverted: data loss
disarms the check, data gain trips it.

**`test/nfl-audit-overview.test.js:25-31`** — run 27's 70 sealed weeks / 153 bets / −11.855 units.
Same shape, plus the silent skip from §2.

**`test/gridiron-model.test.js`, `test/nfl-team-strength.test.js`, `test/td-regression.test.js`,
`test/nfl-drive-tape.test.js`** — these assert *properties* of a fitted model (ordering by
goal-line proximity, 32 canonical teams per season, no market-derived column reaching the market
model, the Rams keeping their QB1 QBR delta on the LAR key rather than the LA alias) rather than
literal magic numbers. That is the right way to depend on real data, and these are not defects.

**`test/nfl-preseason-blend.test.js:52`** — `assert.ok(c.games_pooled > 1000)` runs
unconditionally, satisfied either by real history or by the 1,632 seeded rows. Fine.

---

## 4. Focus question 4 — coverage gaps: server modules with zero tests

299 modules under `server/services/` (270) and `server/routes/` (29). 218 distinct
`server/{services,routes,lib,db,migrations}/*.js` specifiers appear in `test/`. **88 modules are
never imported by any test.**

### 4.1 The money path — this is the important half

| module | lines | why it is money | test status |
|---|---|---|---|
| `server/services/nfl-teasers.js` | 291 | **The only structurally +EV bet in the project.** Its own header (lines 1-2): "Wong teasers — the one structurally +EV NFL bet this database can defend." | **zero tests.** Only the *execution ledger* sibling `nfl-teaser-execution.js` is covered, plus the pure-math `server/betting/nfl/strategy/teaser-leg-rates.js`. The module that turns the leg rates into recommendations is untested. |
| `server/services/nfl-user-bets.js` | 69 | Nick's own tracked bets. Writes real money records: `INSERT INTO nfl_user_bets`, `DELETE FROM nfl_user_bets`. Header (lines 3-5): "Same grading rules as the auto-pick engine, kept in a separate table so a user's own action never contaminates the model's own graded track record." | **zero tests.** The separation-of-track-records invariant is unenforced. 5 exports. |
| `server/services/live-edge.js` | 245 | The in-game edge that its own header (lines 8-14) calls "the single exception" among 22 failed models — Brier 0.1708, skill 0.317 — and "the first place in the project where the three things needed for a bet actually line up at once." | **zero tests.** |
| `server/services/nfl-live-ledger.js` | 209 | The immutable possession-by-possession prediction ledger, with "four immutability triggers" (lines 9-12). 7 exports. | **zero tests.** The append-only guards on the live ledger are never exercised, unlike the quote-tape/decision-run triggers, which `test/nfl-execution-integrity.test.js` and `test/migration-027-populated-upgrade.test.js` do cover. |
| `server/services/nfl-opening-lines.js` | 347 | CLV measurement against the opener — the header calls it "the only edge measurement that gives a verdict" (lines 11-12). Writes: `UPDATE game_lines`. | **zero tests.** A module that issues `UPDATE game_lines` and defines the project's headline metric has no test. |
| `server/services/nfl-sharp.js` | 302 | Sharp-money following; per the header "the only group that reliably beats the closing line." 6 exports. | **zero tests.** |
| `server/services/nfl-prop-grading.js` | 221 | Grades the prop model — and props are, per the project brief, the model's real skill. Header documents a live failure mode it exists to catch: `structural_75_last3_25` beat production on MAE and was correctly rejected on rank quality. | **zero tests.** |
| `server/services/nfl-props-replay.js` | 275 | Prop replay/backtest. | **zero tests.** |
| `server/services/nfl-prop-correlation.js` | 379 | Prop correlation — the input to any multi-leg prop staking decision. | **zero tests.** |
| `server/routes/edge.js` | 532 | The largest untested route; the `/api/edge` surface. | **zero tests.** |
| `server/routes/props.js` | 223 | `/api/props`. | **zero tests.** |
| `server/routes/execution-slate.js` | — | `/api/execution-slate`. The *service* `execution-slate-reasoning.js` is tested; the route is not. | **zero tests.** |

### 4.2 The audit path

| module | lines | zero tests |
|---|---|---|
| `server/services/nfl-abstention-audit.js` | 195 | yes — and its header (lines 6-8) says "Nothing has ever scored the road not taken, so 'the policy is appropriately humble' and 'the policy is uselessly timid' have been indistinguishable." The module that makes them distinguishable is itself unverified. |
| `server/services/nfl-specialist-audit.js` | 115 | yes — the scale/conviction/duplication audit of the twelve specialists. |
| `server/services/nfl-feature-coverage.js` | — | yes |
| `server/services/nfl-model-watch.js` | — | yes |
| `server/services/weekly-walkforward.js` | 247 | yes — the cutoff-safe weekly refit. The *generic* walk-forward/leakage tests exist elsewhere in the suite, but this specific implementation is uncovered. |
| `server/services/weekly-backtest.js` | 223 | yes |
| `server/services/nfl-sim-calibration.js` | — | yes |
| `server/services/nfl-candidate-analysis.js` | 313 | yes — note `test/nfl-candidate-findings.test.js` (237 lines) covers the *findings state machine* thoroughly, including the human-only promotion gate; the *analysis* that proposes candidates is untested. |
| `server/services/source-validation.js` | — | yes |
| `server/services/decision-basis.js` | 336 | yes — writes `INSERT INTO decision_basis`. Its header (lines 10-11) argues it exists precisely because the LLM gate "cannot be re-run to reproduce an audit". A reproducible-by-design audit artefact with no reproducibility test. |

### 4.3 Full untested list (88)

**Routes (8):** `analysis.js`, `edge.js`, `espn.js`, `execution-slate.js`, `mlb.js`, `props.js`,
`rankings.js`, `teams.js`.

**Services (80):** `ceiling-lineup`, `compute-cache`, `decision-basis`, `draft-ingest`,
`draft-survival`, `espn-market`, `espn-player-notes`, `ffopportunity`, `football-context`,
`football-first`, `game-cutoff`, `live-edge`, `matchups`, `mlb-research`, `model-intelligence`,
`news-fantasy-impact`, `news-lag-trader`, `nfl-abstention-audit`, `nfl-candidate-analysis`,
`nfl-capture-dispatch`, `nfl-coaches`, `nfl-context-heads`, `nfl-diagnostic`,
`nfl-espn-line-watch`, `nfl-espn-pbp`, `nfl-feature-coverage`, `nfl-features`, `nfl-formations`,
`nfl-live-ledger`, `nfl-live`, `nfl-model-watch`, `nfl-offseason-change`, `nfl-opening-lines`,
`nfl-opponent`, `nfl-page-explain`, `nfl-passing-specialists`, `nfl-player-context`,
`nfl-prop-correlation`, `nfl-prop-grading`, `nfl-prop-head-validation`, `nfl-props-replay`,
`nfl-reasoning`, `nfl-rebuild-progress`, `nfl-research`, `nfl-rookies`, `nfl-scheme`, `nfl-sharp`,
`nfl-sim-calibration`, `nfl-sim-policy`, `nfl-specialist-audit`, `nfl-spread-context`,
`nfl-team-card`, `nfl-team-tendencies`, `nfl-teammate-competition`, `nfl-teasers`,
`nfl-transactions`, `nfl-tweet-line-correlation`, `nfl-unified-engine`, `nfl-user-bets`,
`pick-confidence`, `picks`, `player-case`, `player-ids`, `prediction-markets`, `press-conference`,
`role-scenario-lab`, `roster-risk`, `signal-latency`, `source-validation`, `system-connectivity`,
`title-odds-trades`, `trend-exploits`, `trend-watch`, `twitterapi-io`, `vegas-fantasy`,
`week-postmortem`, `weekly-backtest`, `weekly-learning`, `weekly-walkforward`, `who-plays`.

Note `server/services/nfl-espn-pbp.js` (638 lines) and `server/services/nfl-sim-policy.js`
(618 lines, 22 exports — "twenty strategic modules the simulated coaches consult") are the two
largest untested modules in the repo.

---

## 5. Defects

Severity: **P1** = wrong money / decision / data-integrity / leakage / security.
**P2** = wrong number or misleading output. **P3** = hygiene.

---

### G17-T01 — P1 — `npm test` opens the live `data.sqlite` read-write; the offline guard and DB isolation are CI-only

`package.json:14`

```json
"test": "node --experimental-test-module-mocks --test --test-concurrency=1 test/*.test.js",
```

`.github/workflows/ci.yml:79-82` is the *only* place `NODE_OPTIONS=--import ./test/offline-guard.mjs`
and `GRIDIRON_DB_PATH` are set. `test/offline-guard.mjs:17` nevertheless asserts "Loaded via
NODE_OPTIONS=…" as though it were universal.

**Impact.** Running the documented test command on Nick's machine causes 22 spec files (§1.3) to
open `server/data.sqlite` in WAL read-write, each in its own child process. `server/db/index.js:18`
sets `journal_mode = WAL`; lines 22-27 and 171-176 issue `CREATE TABLE IF NOT EXISTS`; lines
193-196 `INSERT INTO db_health_checks` after a `PRAGMA quick_check(1)` that the suite itself
records as taking 159 seconds on the 9.8 GB file (`test/teaser-leg-rates.test.js:20`). During an
NFL weekend the same file is being written by the T-60 capture server. With no guard active,
nothing prevents a test from reaching a paid provider either.

**Fix.** Move the three CI env vars into the `test` script (or a `pretest`), e.g.
`GRIDIRON_DB_PATH=$(mktemp -d)/test.sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --test …`,
and add a second script (`test:real`) for the deliberate real-history run. Then give the 22 files
in §1.3 an explicit disposition the way `test/offseason-model.test.js:627-629` already does.

---

### G17-T02 — P1 — the offline guard wraps only `globalThis.fetch`; `node:http`/`net` are unguarded

`test/offline-guard.mjs:23-24`

```js
const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, options) {
```

**Impact.** The guard's stated purpose (`test/offline-guard.mjs:5-9`) is to convert "no network by
construction of the test suite" from an assertion into an enforced property, because a test that
"quietly reached a provider would have passed … until it cost money." Any client that uses
`node:http`/`node:https`/`net.connect` — including an SDK that switches transports in a minor
version bump — bypasses it entirely and reaches the Odds API, Anthropic or twitterapi with real
credentials, and CI would go green.

Secondary fail-open at `test/offline-guard.mjs:28-31`: an unparseable input is passed straight to
`originalFetch` with the comment "there is no host to reach, so nothing to guard."

**Fix.** Also patch `http.request`/`https.request` (and `net.Socket.prototype.connect`) with the
same `LOCAL_HOSTS` allowlist, and make the parse failure throw rather than pass through.

---

### G17-T03 — P2 — `nfl-audit-overview.test.js` silently skips five of seven tests, and they are the audit path's ground truth

`test/nfl-audit-overview.test.js:15`

```js
const run27Exists = () => row(`SELECT status FROM nfl_blind_audit_runs WHERE id=27`)?.status === 'complete';
```

used at lines 22, 36, 48, 58, 66 as `{ skip: !run27Exists() }`.

**Impact.** A bare boolean produces a skip with no reason. The rest of the suite solved exactly
this with `realHistoryDisposition()` (`test/helpers/requires-real-history.js:41-45`), whose own
header (lines 4-6) quotes the requirement: "failures/skips have explicit disposition." The
assertions lost when this skips are `weeks_sealed === 70`, `spread_only.bets === 153`,
`units ≈ −11.855` (lines 25-31) and the reproducibility claim that runs 27 and 31 are
byte-identical across their shared 70-week prefix (lines 68-71). On a rebuilt database these go
quiet and the audit path stops being checked with no signal.

**Fix.** Replace with a disposition string naming run 27 and what it is.

---

### G17-T04 — P2 — the teaser regression lock is disarmed by data loss and tripped by data gain

`test/teaser-leg-rates.test.js:189-193`

```js
    assert.equal(all.n, 2894, 'every candidate leg, pushes included');
    assert.equal(all.wins, 2124);
    assert.equal(all.pushes, 26);
    …
    closeTo(all.rate_of_decided, 0.7406, RATE_TOLERANCE, 'pooled family rate');
```

gated at `test/teaser-leg-rates.test.js:37-40` by
`realHistoryDisposition(rows, ['game_lines'], …, { min: 5000 })`.

**Impact.** These are the numbers behind the only +EV strategy Nick has. The gate is a row count
on `game_lines`. If the historical spreads are corrupted or partially deleted such that the table
drops below 5,000 rows, the test **skips** rather than fails — the exact scenario the assertion
exists to catch. Conversely a legitimate backfill (more seasons, a re-scrape) changes `n` from
2894 and produces a hard failure that is not a defect. Note the file already knows about a
corruption episode: it asserts the 2025/2026 spread-corruption exclusion elsewhere.

**Fix.** Assert `n` relative to a stored expected-population fingerprint rather than a literal, or
add a distinct assertion that the measurement window's row count has not *decreased*.

---

### G17-T05 — P2 — `nfl-preseason-blend.test.js` seeds synthetic games, under real NFL team codes and real seasons, into an inherited database

`test/nfl-preseason-blend.test.js:30-32, 39-40, 43`

```js
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-preseason-blend-'));
const usingFixture = !process.env.GRIDIRON_DB_PATH || !fs.existsSync(process.env.GRIDIRON_DB_PATH);
if (usingFixture) process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
…
seedTeams(db);
if (!hasRealHistory(rows)) seedLeagueHistory(run);
…
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
```

`test/helpers/seed-league-history.js:104-111` then inserts, for seasons 2019–2024, weeks 1–17,
under **real** NFL abbreviations (`KC`, `BAL`, `BUF`, `SF`, `LAR`, … — lines 43-52):

```js
    run(`INSERT OR IGNORE INTO game_lines
      (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,gametime)
      VALUES (?,?,?,?,1,?,?,?,?,?,'13:00')`,
      season, week, home, away, spread, total, homeScore, awayScore, gameday);
```

**Impact.** When `GRIDIRON_DB_PATH` is already set *and* that file exists, this file does **not**
create its own fixture — it runs `runMigrations()` (line 36) and seeds into the inherited
database, and `test.after` (line 43) deletes only the temp directory it never used, so the seeded
rows persist. `game_lines`'s primary key is `(season, week, team)`
(`server/db/schema/core-and-fantasy.js:691`), so on a *fully* populated database
`hasRealHistory` is true (≥5 seasons, ≥2,000 completed home games —
`test/helpers/seed-league-history.js:130-133`) and nothing is seeded. The hazard is a
**partially** populated database — a fresh install mid-backfill, or a restored copy with fewer
than 2,000 completed games — pointed at by `GRIDIRON_DB_PATH`, which is exactly the documented
way to run the real-history tests. There, 1,632 fabricated `game_lines` rows with fabricated
spreads, totals and final scores land under real team codes in real seasons, in every
`(season, week, team)` slot the real data has not filled — real bye weeks being the obvious ones.
Those rows then feed CLV, the teaser measurement and every backtest, permanently and invisibly.

**Fix.** Always use the mkdtemp fixture; never write into an inherited `GRIDIRON_DB_PATH`. If the
real-history variant is wanted, gate it the way `test/offseason-model.test.js:627-629` does and
never seed.

---

### G17-T06 — P2 — no test asserts which routers are intentionally unauthenticated, and two money-adjacent routers have no auth at all

`server/index.js:102-103`

```js
app.use('/api/props-tickets', propsTicketsRouter);
app.use('/api/decision-inbox', decisionInboxRouter);
```

— no `legacyAuthenticated`, unlike lines 78, 88, 91, 97, 98. Neither
`server/routes/props-tickets.js` (57 lines) nor `server/routes/decision-inbox.js` (190 lines)
contains `requireAuth`, `legacyAuthenticated`, `req.auth`, an actor or a permission check.

The tests mirror this faithfully and therefore cannot catch it:

```js
const app = express();
app.use(express.json());
app.use('/api/props-tickets', propsTicketsRouter);      // test/props-saved-tickets.test.js:19-21
```
```js
const app = express();
app.use(express.json());
app.use('/api/decision-inbox', decisionInboxRouter);    // test/decision-inbox.test.js:31-33
```

`test/legacy-route-security.test.js:24-29` is the suite's auth-coverage file and it mounts exactly
six routers — `leagues`, `news`, `players`, `tradelab`, `trades`, `dev`. Nothing enumerates the
remaining 23.

**Impact.** Saved betting tickets and the decision inbox — the two surfaces that hold what Nick
intends to bet — are readable and writable by any caller that can reach the port, and no test
would notice if a currently-authenticated router lost its middleware. Mitigating: the app is
local-first, though `docs`-recorded phone access via a cloudflared tunnel widens the reachable
surface.

**Fix.** Add a test that enumerates every `app.use('/api/…')` in `server/index.js` against an
explicit allowlist of intentionally-public prefixes, and fails on any router not in either set.

---

### G17-T07 — P2 — the two Wong/teaser route suites run against a schema no production database is ever at

`test/teaser-season.test.js:29-36`

```js
// Just the one migration this fixture needs: the teaser execution ledger.
// `runMigrations()` would import every file in server/migrations/, which
// couples this suite to migrations that have nothing to do with teasers —
// and at the time of writing 035 is mid-flight and does not parse. …
const ledgerMigration = await import('../server/migrations/012_teaser_execution_ledger.js');
migrate(ledgerMigration.name, () => ledgerMigration.up(db));
```

`test/wong-routes.test.js:26-29` does the same.

**Impact.** These two files build their fixture at *legacy schema + migration 012*, skipping
013–035. The stated justification is stale: `node --check server/migrations/035_alt_spread_capture.js`
exits 0 — 035 parses. Today the shortcut is harmless (I checked: `server/routes/wong.js` touches
only `nfl_teaser_executions`, `nfl_teaser_execution_legs`, `nfl_teaser_price_ledger` and
`schedule_games`, all from legacy schema + 012). But the Wong path is the money path, and the day
a migration adds a column or an append-only trigger to a teaser table, these suites will keep
passing against a schema that no longer exists anywhere.

**Fix.** Delete the stale sentence and switch to `runMigrations()`, which
`test/migration-027-populated-upgrade.test.js` already proves works against populated fixtures.

---

### G17-T08 — P2 — the only +EV strategy's recommendation engine has no test

`server/services/nfl-teasers.js:1-2`

```js
/**
 * Wong teasers — the one structurally +EV NFL bet this database can defend.
```

291 lines, 4 exports, zero test imports. `grep` across `test/` finds only
`server/services/nfl-teaser-execution.js` and
`server/betting/nfl/strategy/teaser-leg-rates.js`.

**Impact.** The leg-rate mathematics is covered to 514 lines of test
(`test/teaser-leg-rates.test.js`) and the execution ledger is covered; the module that selects
which legs to actually recommend this week is not. A bug there produces wrong bets with every
surrounding test green.

---

### G17-T09 — P2 — `nfl-user-bets.js` writes the user's own money ledger with no test

`server/services/nfl-user-bets.js:3-5`

```js
 * rules as the auto-pick engine, kept in a separate table so a user's own
 * action never contaminates the model's own graded track record.
```

69 lines, 5 exports, `INSERT INTO nfl_user_bets` and `DELETE FROM nfl_user_bets`, zero tests.

**Impact.** The stated invariant — Nick's own bets never contaminate the model's graded record —
is exactly the kind of separation that a refactor breaks silently, and nothing checks it. Both the
grading rules and the table separation are unverified.

---

### G17-T10 — P3 — `test/platform-paths.test.js` mutates process-wide CWD

`test/platform-paths.test.js:47-55, 60-69, 78-85`

```js
  const originalCwd = process.cwd();
  try {
    process.chdir(os.tmpdir());
```

Restored in `finally` each time, and `node --test` isolates per file, so this is contained. Worth
noting only because a future `--test-concurrency` change above 1 would make it unsafe, and the
file itself is the one that exists to prove path resolution does not depend on CWD.

---

### G17-T11 — P3 — `test/nfl-execution-integrity.test.js` drops and restores append-only triggers

`test/nfl-execution-integrity.test.js:81-88`

```js
function mutateFixture(sql, ...params) {
  assert.equal(dbPath, path.join(temp, 'fixture.sqlite'));
  const triggers = rows("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('nfl_quote_tape','nfl_quote_batches','nfl_execution_lifecycle_events')");
  try {
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);
    if (params.length) run(sql, ...params); else db.exec(sql);
  } finally { for (const t of triggers) db.exec(t.sql); }
}
```

This is **correctly done** — the `assert.equal(dbPath, …)` on line 82 is a real guard that the
target is the temp fixture, the restore is in a `finally`, and the whole thing exists to inject
corruption the immutability triggers are supposed to prevent. Recorded here only because it is the
single most dangerous primitive in the suite and its safety rests entirely on line 82; if
`GRIDIRON_DB_PATH` handling ever changed under it, that assertion is the only thing between the
suite and dropping triggers on the live tape.

---

## 6. `test/helpers/` — full sections

### `test/helpers/requires-real-history.js` — 46 lines

**Purpose.** Supplies the "explicit disposition" Codex correction C06 demands (header, lines 1-6),
so a check that genuinely needs real NFL history reports a sentence instead of failing with a bare
assertion on a clean checkout.

**Key functions.**
- `hasRows(rows, tables, { min = 1 })` (lines 27-35) — `SELECT COUNT(*)` per table, `try/catch`
  returning `false` for an absent table (line 32: `return false; // table absent entirely`).
- `realHistoryDisposition(rows, tables, requirement, { min = 1 })` (lines 41-45) — returns `false`
  when the data is present, else the sentence `"requires real history in <tables> (at least <min>
  row(s) each). <requirement> A synthetic fixture could be tuned to satisfy this assertion, which
  would prove only that the fixture was tuned. Run against the populated database to check it."`

**Data.** Read-only; executes only `SELECT COUNT(*)`.

**Wiring / `imported_by`.** `test/gridiron-model.test.js:16`, `test/nfl-drive-tape.test.js:16`,
`test/nfl-team-strength.test.js:36`, `test/td-regression.test.js:23`,
`test/teaser-leg-rates.test.js:29`. Zero importers outside `test/` — correct for a test helper,
not orphaned.

**Defects.** None. Lines 21-23 explicitly forbid using it as a general escape hatch, and the suite
honours that: 37 of the 39 conditional skips route through it or an equivalent inline sentence.

**Verdict: good.** This is the file the rest of the suite should be measured against, and
`test/nfl-audit-overview.test.js` is the one that isn't (G17-T03).

---

### `test/helpers/seed-league-history.js` — 134 lines

**Purpose.** A deterministic 16-team, 6-season synthetic league so that *logic* tests do not need
the developer's database. Header (lines 63-72) explains the design constraints: team strength
carries over between seasons with real drift so a year-over-year prior variance is estimable, and
spreads are the true edge plus a small market error so the residual `margin + spread` is
non-degenerate.

**Key functions.**
- `FIXTURE_TEAMS` (lines 43-52) — 16 entries, **real NFL abbreviations and names** (`KC`, `BAL`,
  `BUF`, `CIN`, `SF`, `SEA`, `DAL`, `PHI`, `GB`, `DET`, `MIA`, `NYJ`, `LAR`, `ARI`, `TB`, `NO`).
- `seedTeams(db)` (lines 55-61) — no-ops if `nfl_teams` has any row (line 57), else one bulk
  `INSERT` with ids 1..16.
- `seedLeagueHistory(run, { seasons = [2019..2024], weeksPerSeason = 17, seed = 20260910 })`
  (lines 74-117) — `mulberry32(seed)`, per-season drift `value * 0.6 + normal(rand, 0, 4)`
  (line 85), home-field `+2.1` (line 95), margin noise σ=12, market error σ=2.5 rounded to the
  half (line 98), total `44 + normal(0,6)`. Two `INSERT OR IGNORE INTO game_lines` per game
  (lines 104-111) — one home row, one away row. 6 × 17 × 8 = 816 games = 1,632 rows.
- `hasRealHistory(rows, { minSeasons = 5, minGames = 2000 })` (lines 130-133) — counts
  `game_lines WHERE home = 1 AND team_score IS NOT NULL`.

**Data written.** `nfl_teams` (guarded), `game_lines` (1,632 rows, real abbreviations, real
seasons 2019–2024, weeks 1–17, fabricated spreads/totals/scores).

**Wiring / `imported_by`.** `test/nfl-preseason-blend.test.js:37` only. Zero importers outside
`test/` — correct.

**Defects.** Contributes to **G17-T05**. The helper itself is sound in isolation (`INSERT OR
IGNORE` plus the `hasRealHistory` guard at its call site); the hazard is the call site's
willingness to run it against an inherited `GRIDIRON_DB_PATH`. A defensive improvement would be
for `seedLeagueHistory` to refuse when the target is not a freshly created file.

**Verdict: good, with one sharp edge.** Determinism, drift and non-degenerate residuals are all
done properly; using real team codes is what makes the sharp edge sharp.

---

### `test/offline-guard.mjs` — 39 lines

**Purpose.** Enforced external-network guard (header lines 1-19, citing Codex correction C06).

**Key logic.** `LOCAL_HOSTS` allowlist (line 21) = `localhost`, `127.0.0.1`, `::1`, `[::1]`,
`0.0.0.0`. `globalThis.fetch` replaced (lines 23-24); non-local hostname throws a named error
(lines 32-37); unparseable input passes through (lines 28-31).

**Wiring / `imported_by`.** Referenced only by `.github/workflows/ci.yml:81`. **Not** referenced by
`package.json`. This makes it an entry point loaded via `--import`, so it is not orphaned, but it
is applied in exactly one of the two ways the suite is run.

**Defects.** **G17-T02** (fetch-only, plus the fail-open parse branch) and it is the second half of
**G17-T01** (never loaded locally).

**Verdict: acceptable in intent, insufficient in reach.**

---

## 7. `test/fixtures/` — full sections

All 16 fixtures are captured provider payloads, trimmed to a handful of events. Every one has
exactly one importer; none is orphaned. All are static data read by parsers; none is written.

| fixture | bytes | lines | shape | imported by |
|---|---|---|---|---|
| `bovada-nfl.json` | 5,825 | 1 | Bovada `displayGroups[].markets[]`; 2 events (NE@SEA, SF@LAR); spread/moneyline/total with `price.american` and `handicap` | `test/book-feeds.test.js` |
| `kambi-nfl.json` | 7,381 | 1 | Kambi `events[].betOffers[]`; `line` in milli-points (`-3500` = −3.5), `oddsAmerican` as a string; SF@LAR carries `"extraInfo":"Game to be played in Melbourne, Australia"` and the `NEUTRAL_VENUE` tag | `test/book-feeds.test.js` |
| `pinnacle-matchups.json` | 2,384 | 1 | Pinnacle matchup metadata; 2 matchups (1630877987 SF@LAR, 1630865292 GB@MIN) with `participants[].alignment` | `test/book-feeds.test.js` |
| `pinnacle-markets.json` | 16,239 | 1 | Pinnacle prices keyed `s;0;s;-3.5` etc.; `isAlternate` flags and `limits[].maxRiskStake` (5000 spread / 3000 total / 1000 team-total) — the alt-spread ladder the teaser path needs | `test/book-feeds.test.js` |
| `fanduel-nfl.json` | 17,613 | 723 | FanDuel `attachments.markets{}` keyed by `marketId`; `americanDisplayOdds`, `handicap`, plus a Super Bowl futures market | `test/book-feeds.test.js` |
| `oddstrader-nfl.json` | 37,331 | 1 | OddsTrader GraphQL `eventsByDateByLeagueGroup.events[].currentLines[]`; `mtid` 401=spread / 402=total / 83=moneyline, `paid` = book id, `adj` = line, `ap` = American price | `test/book-feeds.test.js` |
| `oddstrader-archive-2022.json` | 72,404 | 1 | Same shape plus **`openingLines[]`** — 2 completed 2022 games (IND@DEN, CHI@MIN), 66 current + 66 opening quotes each, 11 books (`paid` 3,8,9,10,15,20,28,29,36,82,84). This is the opener/CLV fixture. | `test/odds-archive.test.js` |
| `rotowire-nfl.json` | 28,934 | 926 | RotoWire per-team rows, one object per side; 11 books as flat `<book>_spread` / `<book>_spreadML` columns plus `best_spreadBook` / `best_spread` — the line-shopping fixture. `hardrock_*` is all `null`, exercising the missing-book path. | `test/book-feeds-extra.test.js` |
| `sbr-pointspread.json` | 20,623 | 779 | SBR `pageProps.oddsTables[].oddsTableModel.gameRows[]` with `openingLine`/`currentLine` per book and a `consensus` block. Contains a deliberate anomaly: `bet_rivers_co` current line is `homeSpread: 0, awaySpread: 0` with `homeOdds: -192` — a pulled market that a naive parser would read as a pick'em. | `test/book-feeds-extra.test.js` |
| `nfelo-games.csv` | 2,844 | 7 | nfelo per-game model output; 47 columns incl. `nfelo_home_line_close`, `home_clv_from_open`, push probabilities | `test/nfelo.test.js` |
| `nfelo-hps.csv` | 3,922 | 7 | nfelo HPS rows; `market_regression_factor`, `regressed_dif`, `bet_size` (blank for 4 of 6 rows — the no-bet path) | `test/nfelo.test.js` |
| `nfelo-lines.csv` | 3,702 | 7 | nfelo open/last lines with `*_source` and `*_timestamp` columns; two rows have empty ticket/money percentages | `test/nfelo.test.js` |
| `nfelo-qb-elos.csv` | 3,575 | 8 | 538-style QB-adjusted Elo; one 2019 row (NE/PIT) and six 2024 rows | `test/nfelo.test.js` |
| `nfelo-stadiums.csv` | 6,868 | 8 | Stadium metadata; 7 rows with 52 columns. Includes two `is_current=False` rows (OAK00, SFO00) and the OAK/LV dual-abbreviation case — the relocation/alias path. | `test/nfelo.test.js` |
| `espn-fpi.json` | 7,221 | 344 | ESPN FPI `categories[0].names[]` + `teams[].categories[0].values[]`; 4 teams, ranks all `"-"` (preseason) | `test/nfl-external-ratings.test.js` |
| `teamrankings-predictive.html` | 3,765 | 66 | Trimmed TeamRankings HTML; header comment (line 1) records the exact source URL and fetch date, `data-sort` attributes carry the parse-critical values (`509.91156` → displayed `9.9`) | `test/nfl-external-ratings.test.js` |

**Defects.** None found. Two observations worth recording:
- The fixtures are genuinely adversarial where it matters — the pulled BetRivers market in
  `sbr-pointspread.json`, the all-null Hard Rock book in `rotowire-nfl.json`, the Melbourne
  neutral-site flag in `kambi-nfl.json`, the OAK/LV relocation rows in `nfelo-stadiums.csv`. These
  are the shapes that break parsers in production, and somebody chose them deliberately.
- `teamrankings-predictive.html:1` is the only fixture that records its provenance inline. The 15
  JSON/CSV fixtures do not, so there is no way to tell from the file when or from what URL it was
  captured — only the mtimes (2026-09-02 to 2026-09-10).

**Verdict: good.**

---

## 8. Full inventory — all 175 `test/*.test.js`

`hermeticity` column: `isolated` = sets its own `GRIDIRON_DB_PATH`; `pure` = never loads
`server/db/index.js`; `**LIVE DB**` = loads it with no override (the 22 from §1.3).

| file | lines | tests | hermeticity | purpose |
|---|---|---|---|---|
| `alt-spread-import.test.js` | 700 | 34 | isolated | Alternate-spread capture import. |
| `always-valid-significance.test.js` | 114 | 6 | **LIVE DB** | first test: under a true null, continuous peeking inflates a fixed-N test far past its nominal alpha |
| `audit-overview-counting.test.js` | 229 | 10 | isolated | Codex correction C09: "Audit overview miscounts pushes and coverage." |
| `audit-registry-always-valid.test.js` | 83 | 4 | isolated | first test: an audit with a real growing sequence and a real p-value passes both gates |
| `beat-the-close-weekly-read.test.js` | 117 | 7 | isolated | first test: a rule with consistently positive CLV across three weeks is not retired |
| `beat-the-close-wind.test.js` | 103 | 5 | isolated | first test: wind at or above threshold, total unmoved: freezes an Under decision |
| `beat-the-close.test.js` | 102 | 4 | isolated | first test: the opener comes from the archive and the best reachable price is the most favourable line then price |
| `betting-fantasy-link.test.js` | 24 | 3 | **LIVE DB** | first test: every reliability entry states proven status, a reason, and where the evidence lives |
| `blind-audit-lookback.test.js` | 102 | 3 | isolated | first test: weekly input records a game × specialist matrix with the production pick, and completeness flags absent cells |
| `book-feeds-extra.test.js` | 195 | 7 | isolated | first test: Rotowire Eastern kickoffs land on the UTC date the other feeds key by |
| `book-feeds.test.js` | 210 | 11 | isolated | first test: the team resolver handles every feed spelling |
| `boom-bust.test.js` | 167 | 7 | isolated | first test: a top-ADP player who actually produces is graded |
| `cfbd.test.js` | 92 | 6 | isolated | first test: without a configured key, sync is a graceful no-op |
| `confidence-tier.test.js` | 83 | 10 | pure | first test: a real, walk-forward-validated expert with a full season-plus of independent weeks scores high |
| `consensus-weights.test.js` | 313 | 12 | isolated | first test: the two live sources with no history are reported as unfittable, not silently fitted |
| `contextual-coordinator.test.js` | 15 | 1 | **LIVE DB** | first test: weekly diagnosis labels phase, market shape, disagreement, and evidence coverage |
| `coordinator-shrinkage.test.js` | 79 | 2 | isolated | first test: shrinkage recovers a small scale for the signal and zero for noise; families pool the copies |
| `db-snapshot-headroom.test.js` | 79 | 4 | isolated | The pre-migration snapshot must refuse a disk it cannot finish on. |
| `decay-watch.test.js` | 172 | 7 | isolated | first test: a finding whose true effect has vanished after approval is flagged as decayed |
| `decision-inbox.test.js` | 337 | 16 | isolated | first test: 020_decision_recommendations ran and created the table |
| `draft-abstention-audit.test.js` | 362 | 18 | isolated | first test: replacement level is the Nth-best actual finisher, at the audit\ |
| `draft-active.test.js` | 101 | 8 | isolated | first test: no drafts at all -> draft: null |
| `draft-advice-verify.test.js` | 400 | 21 | pure | first test: the proposal is confirmed when the simulation also ranks it first |
| `draft-assist-bestball.test.js` | 114 | 8 | isolated | first test: redraft: an early RB gets no Zero-RB penalty |
| `draft-authorization.test.js` | 179 | 8 | isolated | first test: missing, invalid, and forged role credentials cannot create drafts |
| `draft-capture-client.test.js` | 284 | 8 | pure | first test: pure helpers: URL filter and SWID scrubbing |
| `draft-capture-route.test.js` | 93 | 4 | isolated | first test: bookmarklet href is a small loader with draft, key and origin baked in |
| `draft-engine.test.js` | 119 | 11 | pure | first test: snake order alternates direction every round |
| `draft-ingest.test.js` | 425 | 17 | isolated | first test: parseFrame handles every documented frame type |
| `draft-lookahead-variance.test.js` | 319 | 12 | isolated | first test: a drawn season outcome is a distribution, not the point estimate repeated |
| `draft-reconcile.test.js` | 274 | 16 | isolated | first test: a fresh reconciliation inserts every resolvable pick exactly once |
| `draft-state-machine.test.js` | 270 | 14 | isolated | first test: makePick inserts the pick, bumps revision, and advances the clock |
| `dynasty-age-curve.test.js` | 100 | 7 | isolated | first test: ageDecayMultiplier reproduces the cited curve anchors exactly |
| `empty-state.test.js` | 53 | 2 | isolated | first test: ${moduleName}.${fn} answers on an empty database |
| `ensemble-window-and-split.test.js` | 173 | 8 | isolated | Codex corrections C04 and C07 — the two chronology defects in the ensemble. |
| `espn-connect.test.js` | 308 | 19 | isolated | first test: extractEspnCookies pulls both values out of a raw document.cookie dump |
| `espn-draft-sync.test.js` | 216 | 12 | isolated | first test: linking a league with no draft activity yet creates a draft with zero mirrored picks |
| `evidence-dataset.test.js` | 139 | 8 | isolated | first test: contractKey refuses an unresolved team rather than guessing |
| `evidence-provenance.test.js` | 41 | 1 | isolated | first test: timestamps are collected from nested payloads and late ones are flagged per role |
| `execution-slate-reasoning.test.js` | 418 | 33 | **LIVE DB** | first test: an UNQUALIFIED shopped line cannot size, which is what the real board sends |
| `family-contribution-scoring.test.js` | 116 | 7 | isolated | Codex correction C16: "The new family report overstates what it tested." |
| `fantasy-coordinator.test.js` | 146 | 8 | isolated | first test: a genuinely predictive expert earns positive shrinkage; pure noise shrinks to zero |
| `fantasy-workflows.test.js` | 140 | 7 | isolated | first test: fresh seed has enough fantasy_relevant players for a full 12x16 draft |
| `find-trades.test.js` | 95 | 3 | isolated | first test: requireMutual=false still only returns real, fair, no-red-flag deals — not everything unfiltered |
| `forecast-packet-contract.test.js` | 193 | 14 | pure | The forecast-packet contract (Codex plan section 4.1, module required by |
| `format-bestball.test.js` | 58 | 9 | pure | first test: sleeper: settings.best_ball === 1 is recognized |
| `forward-ledger.test.js` | 148 | 6 | isolated | first test: NFL wall-clock kickoff converts through daylight and standard time |
| `gamescript-closing-line.test.js` | 165 | 2 | isolated | first test: syncCurrentLines freezes the true close and never lets a post-kickoff number touch it |
| `gridiron-model.test.js` | 160 | 15 | **LIVE DB** | The consolidation, tested as an enforcement mechanism rather than as a report. |
| `historical-adp-scrapes.test.js` | 103 | 5 | isolated | first test: retains every preseason scrape date per player-season, not just the newest |
| `historical-adp.test.js` | 83 | 4 | isolated | first test: syncs the last preseason scrape per season/player, excluding wrong ecr_type and post-kickoff rows |
| `league-brain.test.js` | 95 | 10 | **LIVE DB** | The brain's claims, tested as claims. |
| `league-removal.test.js` | 162 | 8 | isolated | first test: removal impact reports the draft history at stake before anything is destroyed |
| `league-roster-schedule.test.js` | 69 | 2 | isolated | first test: league_rosters is a real scheduled job that re-syncs every connected league\ |
| `legacy-route-security.test.js` | 85 | 4 | isolated | first test: legacy league/news/trade/player/dev route families reject anonymous callers |
| `line-move-study.test.js` | 105 | 2 | isolated | first test: the dataset is one row per game and market, stamped by decision time, with drops counted |
| `lineup-evidence.test.js` | 226 | 16 | isolated | The evidence layer behind a start/sit call, tested on a temp database. |
| `local-auth.test.js` | 64 | 3 | isolated | first test: only literal loopback addresses qualify for automatic local sign-in |
| `migration-027-populated-upgrade.test.js` | 575 | 14 | isolated | Codex correction C03: "Populated migration 027 fails and downgrade loses |
| `mlb-nrfi-shrinkage.test.js` | 167 | 4 | isolated | first test: arcsine transform round-trips and shrinkRate guards degenerate inputs |
| `model-integrity.test.js` | 1396 | 89 | isolated | first test: expert council registers every modelling role and missing evidence abstains instead of becoming zero |
| `model-registry-persistence.test.js` | 602 | 22 | isolated | first test: spoofed role headers cannot authenticate model mutations |
| `modeling-news.test.js` | 65 | 6 | pure | first test: timestamp guard rejects future features and duplicate observations |
| `news-ingest.test.js` | 258 | 15 | isolated | first test: parseRssItems extracts title/link/description/pubDate and unwraps CDATA |
| `nfelo.test.js` | 166 | 9 | isolated | first test: the CSV parser keeps quoted commas inside one field |
| `nfl-advanced-depth.test.js` | 15 | 2 | **LIVE DB** | first test: historical depth sync addresses the published plural uncompressed asset |
| `nfl-audit-overview.test.js` | 77 | 7 | **LIVE DB** | Work package 0 (2026-09-10): auditOverview/compareAuditRuns against the |
| `nfl-blind-audit-team-scope.test.js` | 55 | 2 | isolated | Real bug found tonight: run 28 crashed 22 weeks in because a live |
| `nfl-candidate-findings.test.js` | 237 | 20 | isolated | Phase 3 of the 2026-09-09 learning-pipeline plan: the missing middle |
| `nfl-cover-identity.test.js` | 152 | 7 | isolated | first test: forecast identities normalize equivalent configuration and distinguish every implemented forecast choice |
| `nfl-decision-identity-pipeline.test.js` | 237 | 5 | isolated | Codex correction C01, closed on the REAL path: "real board-to-pipeline tests |
| `nfl-decision-tape.test.js` | 483 | 27 | isolated | The decision tape's evidence contract. |
| `nfl-devig.test.js` | 82 | 9 | pure | first test: americanToProb converts both sides of a standard -110/-110 line to 0.5238 |
| `nfl-drive-tape.test.js` | 53 | 3 | **LIVE DB** | first test: formation model respects team shotgun tendency and game situation |
| `nfl-ensemble-authority.test.js` | 148 | 7 | isolated | first test: strong challenger diagnostics remain visible but cannot enter champion weight normalization |
| `nfl-ensemble-opponent-adjustment.test.js` | 146 | 3 | isolated | Codex audit finding M13 (2026-09-10): `nfl-ensemble.js`'s `opp_adjusted` |
| `nfl-execution-attribution.test.js` | 144 | 12 | isolated | first test: fairPriceProbability uses Shin no-vig when the opposite price is known |
| `nfl-execution-clv-downsize.test.js` | 249 | 20 | pure | first test: weekClusteredMeanCi treats each week as one observation regardless of how many bets it holds |
| `nfl-execution-clv.test.js` | 357 | 18 | isolated | Codex audit finding E9 (2026-09-10): "accepted positions, CLV and staking |
| `nfl-execution-corridor.test.js` | 174 | 19 | pure | first test: deriveCorridorThreshold: quantile matches a value computable by hand |
| `nfl-execution-decision.test.js` | 350 | 16 | isolated | first test: a normal acceptance within budget, with an ordinary price, is allowed |
| `nfl-execution-edge.test.js` | 485 | 26 | isolated | Codex audit finding E5 (2026-09-10): `bestExecution`'s shopped-line |
| `nfl-execution-exposure.test.js` | 89 | 11 | pure | first test: an empty book allows a normal-sized bet |
| `nfl-execution-integration.test.js` | 111 | 4 | isolated | first test: a lifecycle opportunity opened from a real quote-tape row carries a genuine quote_id |
| `nfl-execution-integrity.test.js` | 259 | 12 | isolated | first test: repeated matchup selects this kickoff and the latest eligible price; future quotes cannot leak |
| `nfl-execution-lifecycle.test.js` | 359 | 19 | isolated | first test: a full walk through OFFERED -> OBSERVED -> DECISION -> REFRESHED -> ACCEPTED -> SETTLED |
| `nfl-execution-pipeline.test.js` | 167 | 9 | isolated | first test: sideFor: resolves home or away from the candidate\ |
| `nfl-execution-replay.test.js` | 318 | 27 | isolated | first test: filled_as_decided: nothing moved between decision and execution |
| `nfl-execution-staking-policy.test.js` | 150 | 15 | **LIVE DB** | first test: isCalibrated requires every gate to pass, not just most of them |
| `nfl-execution-stress.test.js` | 80 | 8 | **LIVE DB** | first test: QB scratch: every delay bucket after the scratch comes back suspended or worse, never a confident fill |
| `nfl-external-ratings.test.js` | 195 | 10 | isolated | first test: ESPN FPI sync writes canonical team codes for the requested season and week |
| `nfl-family-contribution.test.js` | 237 | 17 | **LIVE DB** | Codex plan section 8.6 — "Prove the existing information earns its |
| `nfl-gbm-weather-fallback.test.js` | 85 | 2 | isolated | first test: a game missing schedule-CSV temp/wind uses the real Open-Meteo reading, not the fixed 60F/5mph default |
| `nfl-matchup-specialists.test.js` | 101 | 4 | isolated | first test: a role abstains with a reason when there are not enough prior settled games |
| `nfl-model-fixes.test.js` | 157 | 4 | isolated | first test: the movement family does not attach a 2026 line move to a 2016 game for the same team |
| `nfl-moneyline-domain.test.js` | 173 | 5 | isolated | Regression coverage for moneyline as a real, gradeable domain. |
| `nfl-news-event-impact.test.js` | 199 | 10 | isolated | first test: reactionPairs finds the last quote before, and first quote after, a pivot time |
| `nfl-news-events.test.js` | 240 | 8 | isolated | first test: extraction accepts a claim whose evidence span is verbatim in the source, and rejects one that is not |
| `nfl-offseason-cycle.test.js` | 94 | 6 | isolated | Phase 1 of the 2026-09-09 learning-pipeline plan: closes a confirmed real |
| `nfl-pick-watch.test.js` | 160 | 6 | isolated | first test: a pick with no live snapshot yet is reported, not silently dropped |
| `nfl-policy-contract.test.js` | 90 | 8 | pure | first test: historical replay and live publication have explicit different calibration contracts |
| `nfl-preseason-blend.test.js` | 200 | 15 | isolated | Phase 2 of the 2026-09-09 learning-pipeline plan: nothing in this codebase |
| `nfl-prop-player-heads.test.js` | 207 | 8 | isolated | first test: a season-T explosion never reaches the feature attached to season T |
| `nfl-prop-player-weekly-heads.test.js` | 284 | 11 | isolated | first test: the features actually vary week to week — the whole point of the redo |
| `nfl-prospective-collection.test.js` | 142 | 9 | isolated | first test: with no Odds API key and an empty news_items table, both halves skip honestly and nothing crashes or spends anything |
| `nfl-qbr.test.js` | 46 | 2 | isolated | first test: the profile before week 4 is starter A from this season and last, with no change flagged |
| `nfl-replay-error-analysis.test.js` | 186 | 7 | isolated | Phase 0 of the 2026-09-09 learning-pipeline plan: `analyzeErrors` was the |
| `nfl-replay-opener-disclosure.test.js` | 92 | 5 | **LIVE DB** | Codex audit finding M07 / main plan section 3 task 4 (2026-09-10): a |
| `nfl-replay-qualitative-segments.test.js` | 118 | 3 | isolated | The qualitative half of Phase 3's "insane" rolling-leaderboard pattern |
| `nfl-rolling-leaders.test.js` | 109 | 6 | isolated | The "insane" part of Phase 3 (2026-09-09 learning-pipeline plan): cutoff-safe |
| `nfl-roster-strength-pff-normalization.test.js` | 103 | 7 | isolated | first test: too few observed grades at a position returns null rather than a guessed default |
| `nfl-slice-diagnostic.test.js` | 78 | 2 | isolated | first test: nothing recorded reports unavailable rather than empty slices |
| `nfl-t60-packet.test.js` | 399 | 24 | isolated | Codex plan section 6.3, the evidence-packet half: |
| `nfl-t60-protocol.test.js` | 226 | 14 | pure | Codex plan section 6.3, the T−60 decision-time protocol — specifically the |
| `nfl-team-strength.test.js` | 187 | 12 | **LIVE DB** | first test: buildGbmDataset without extraFeatures is byte-identical to the champion panel |
| `nfl-total-calibration.test.js` | 147 | 3 | isolated | Regression coverage for the missing NFL totals calibration gate. |
| `nfl-weather-forecast.test.js` | 92 | 3 | isolated | first test: a forecast is written for an outdoor game ahead of kickoff, and skips the dome entirely |
| `nfl-weather-history.test.js` | 129 | 4 | isolated | first test: sync writes one row per lead for the past outdoor game and skips the dome and the future game |
| `nfl-weekly-state.test.js` | 97 | 5 | isolated | first test: weekly transforms preserve trend, volatility, coverage, and missingness separately |
| `nfldata-roster-sync-partial-status.test.js` | 97 | 2 | isolated | first test: a single team\ |
| `nfldata-roster-sync.test.js` | 74 | 2 | isolated | first test: a roster sync now updates head_coach from ESPN\ |
| `odds-archive.test.js` | 80 | 2 | isolated | first test: the archive parser yields per-book open and close quotes with the book timestamp |
| `offseason-data.test.js` | 500 | 14 | isolated | first test: shared CSV parser handles the quoting nflverse actually emits |
| `offseason-model.test.js` | 653 | 24 | isolated | Offseason model: feature builder, effect direction, and the shipped API. |
| `page-explain.test.js` | 278 | 7 | isolated | first test: POST /explain/page returns {paragraph, limitations, audit} grounded in the visible_summary it was sent |
| `paired-bootstrap-clustering.test.js` | 117 | 5 | **LIVE DB** | first test: ungrouped bootstrap under-covers when units are correlated within game (reproduces the bug) |
| `parlay-api.test.js` | 190 | 6 | isolated | first test: with no key, every ParlayAPI call no-ops instead of throwing |
| `phone-pairing.test.js` | 107 | 7 | isolated | first test: the Mac itself still auto-provisions |
| `pick-explanation-audit.test.js` | 24 | 1 | isolated | first test: post-pick AI translations preserve the frozen deterministic reasoning hash |
| `pick-reasoning.test.js` | 120 | 12 | **LIVE DB** | The reasoning layer, tested on the two things that make it trustworthy: |
| `platform-paths.test.js` | 125 | 7 | isolated | Codex plan section 10.3's acceptance for `server/platform/paths.js`: |
| `player-availability.test.js` | 58 | 3 | isolated | first test: a roster cut naming one player does not flag every other player who shares that surname |
| `player-career.test.js` | 140 | 8 | isolated | first test: weekly points use the PPR weights from scoring.js |
| `player-identity.test.js` | 103 | 13 | pure | first test: curly and straight apostrophes normalize to the same name |
| `player-repair.test.js` | 57 | 2 | isolated | first test: repair plan is read-only and separates safe shadows from stable-id collisions |
| `player-state.test.js` | 26 | 2 | **LIVE DB** | first test: official roster moves receive team-facing state transitions |
| `polymarket-lines.test.js` | 136 | 5 | isolated | first test: crossing interpolates the 50% point of a ladder and flags extrapolation |
| `port-guard.test.js` | 42 | 2 | pure | first test: startup guard names the PID holding the API port |
| `post-draft-plan.test.js` | 140 | 5 | isolated | first test: post-draft-plan requires a synced league |
| `preseason-band-calibration.test.js` | 134 | 8 | isolated | The p20/p80 band's calibration properties. |
| `preseason-blend-cutoff.test.js` | 106 | 5 | isolated | Codex correction C10: "Sparse preseason uncertainty still uses future-fitted |
| `preseason-model.test.js` | 460 | 20 | isolated | first test: feature builder reads prior seasons only, and encodes what it claims to |
| `price-shopper-archive.test.js` | 45 | 1 | isolated | first test: per-book timestamps still yield a multi-book board, and post-kickoff or stale rows are ignored |
| `prop-clv-free-capture.test.js` | 84 | 4 | isolated | first test: a captured batch is copied into nfl_prop_clv with a real devigged probability and the resolved week |
| `prop-feeds.test.js` | 137 | 5 | isolated | first test: Action Network: supported markets are captured, milestones are counted and skipped, the opener is flagged |
| `props-saved-tickets.test.js` | 127 | 8 | isolated | first test: 018_saved_prop_tickets ran and created the table |
| `props-team-volume-dispersion.test.js` | 114 | 3 | isolated | first test: the old hardcoded dispersion (12) overstates real team-week attempt/carry variance by ~2x |
| `qbr-projection-signal.test.js` | 112 | 6 | isolated | first test: a QB well above league-average trailing QBR gets a small positive nudge |
| `quote-clock.test.js` | 14 | 1 | pure | first test: current quote clock rejects malformed, future, expired and started events |
| `report-cache.test.js` | 59 | 4 | isolated | first test: an unknown report is refused |
| `residual-decomposition.test.js` | 61 | 2 | isolated | first test: returns, short fields, missed kicks and garbage time are variance; ordinary drives are the model share |
| `role-scenario-engine.test.js` | 144 | 9 | isolated | first test: scanChangepoint finds an obvious mid-series shift and reports its direction |
| `rookie-evidence.test.js` | 9 | 1 | **LIVE DB** | first test: combine percentiles respect metric direction and ties |
| `scoring.test.js` | 47 | 4 | pure | first test: a real 1-point-PPR league scores a reception as 1 point, not 2 |
| `seed-idempotence.test.js` | 91 | 4 | isolated | first test: seeding repeatedly does not multiply players |
| `sharp-lag.test.js` | 153 | 5 | isolated | first test: one Pinnacle move, attributed to the side it moved toward; follow latency per soft book in minutes |
| `shopping-board-staleness.test.js` | 72 | 3 | isolated | first test: a quote captured at the fresh instant but stamped weeks old is excluded from the board |
| `slate-risk-staking.test.js` | 131 | 5 | pure | first test: zero-edge floor holds even with a large correlated openBets slate |
| `sportsgameodds.test.js` | 84 | 4 | isolated | first test: extractQuotes reads the documented oddID shape into spread/total/moneyline rows |
| `spread-probabilities.test.js` | 212 | 15 | pure | The shared spread probability and price contract (Codex plan section 5.1, |
| `t60-runner.test.js` | 159 | 11 | isolated | Codex correction C12 and plan section 7: the durable T-60 operation. |
| `td-regression.test.js` | 115 | 8 | **LIVE DB** | The touchdown-regression model, and the two errors that would silently ruin it. |
| `team-codes.test.js` | 64 | 3 | isolated | first test: every feed spelling of a code maps to the canonical nflverse code |
| `teaser-execution.test.js` | 112 | 3 | isolated | first test: route compiler pairs only different games at the same book |
| `teaser-leg-rates.test.js` | 514 | 26 | **LIVE DB** | The cross-both teaser family, and the three ways it could quietly go wrong. |
| `teaser-scan.test.js` | 236 | 8 | isolated | The weekly teaser scan. |
| `teaser-season.test.js` | 512 | 16 | isolated | The Wong teaser as a season: settings, ticket selection, and projection. |
| `teaser-staking.test.js` | 406 | 19 | isolated | Staking for the Wong teaser. |
| `trade-evidence.test.js` | 234 | 6 | isolated | The evidence layer on a trade evaluation, tested on a temp database. |
| `trade-verify.test.js` | 332 | 24 | pure | Trade Lab's propose → verify → (retry once) → commit loop. |
| `verified-events-cutoff.test.js` | 71 | 2 | isolated | first test: a week-1 pregame read sees only week-1 facts published before that kickoff |
| `waiver-brain.test.js` | 98 | 8 | **LIVE DB** | The waiver half of the brain, and the horizon it prices on. |
| `week1-readiness.test.js` | 174 | 7 | isolated | first test: a week is finalized only when every game in it is final |
| `weekly-trends.test.js` | 107 | 12 | **LIVE DB** | The statistics behind every trend claim. |
| `wong-routes.test.js` | 682 | 19 | isolated | The Wong teaser desk's HTTP contract. |

---

## 9. What the suite does well (so it does not get traded away)

Recording these because an audit that lists only defects invites a "rewrite it" response, and this
suite should not be rewritten.

1. **The isolated-DB pattern is applied correctly 153 times.** `fs.mkdtempSync` →
   `process.env.GRIDIRON_DB_PATH = …` → `await import('../server/db/index.js')` → `test.after`
   closing the handle and `rmSync`-ing the directory. The ordering constraint (env before import)
   is respected everywhere I checked.

2. **Real migrations are driven against populated fixtures.** `test/migration-027-populated-upgrade.test.js`
   (575 lines) builds databases at the `026_…` mark and runs the real migration machinery over
   them, including a *generalised* guard test — "no migration writes to an append-only table
   without restoring its guard" — that scans `server/db/schema` and `server/migrations` sources
   rather than enumerating known cases. That is the right shape for a guard test.

3. **Property-based testing where it earns its keep.** `fast-check` in `spread-probabilities`,
   `nfl-execution-edge`, `nfl-execution-integrity`, `nfl-ensemble-authority` and `teaser-staking` —
   i.e. on the probability transforms, the edge computation and the staking maths, which is
   exactly where an example-based test is weakest.

4. **Leakage and cutoff safety are first-class.** Walk-forward tests, `verified-events-cutoff`,
   `nfl-team-strength`'s "no market-derived column is exposed to the market model" (line 84) and
   "every evaluated season resolves teams from a pre-Week-1 source, not season-T usage" (line 77).

5. **Statistics are done properly, not decoratively.** Paired and week-clustered bootstraps,
   always-valid (mSPRT) p-values, Šidák and Holm corrections, Shin de-vigging, a three-outcome
   (push) Kelly solver, Beta posteriors — each with its own spec file.

6. **The human-only gate is tested.** `test/nfl-candidate-findings.test.js:196` asserts that a
   season already used as `discovery` can never be reused as `holdout`
   (`/already used as 'discovery'/`), and the promotion path requires an explicit actor. The veto
   is scoped: `test/nfl-candidate-findings.test.js:228-236` proves a promoted "small edge (<4)"
   segment vetoes an edge-1 bet and *not* an edge-9 bet.

7. **`model-integrity.test.js`** (1,396 lines) pulls ~60 services into one temp database and
   covers the expert council/coordinator, postgame truth, CLV, staking, policy, calibration, the
   blind-audit manifest, the risk lab and weekly weights in one place.

---

## 10. Recommended order of work

1. **G17-T01** — move the CI env into `package.json`'s `test` script. One line; removes the
   live-database hazard entirely and is the only finding with a same-day operational risk during
   an NFL weekend.
2. **G17-T02** — extend the guard to `node:http`/`node:https`/`net`. This is the one that protects
   against a paid-API bill.
3. **G17-T05** — make `nfl-preseason-blend.test.js` always use its own mkdtemp fixture.
4. **G17-T08 / G17-T09** — first tests for `nfl-teasers.js` and `nfl-user-bets.js`. These are the
   money path and they are the largest coverage gap with the smallest surface (291 + 69 lines).
5. **G17-T03 / G17-T04** — give the audit-path and teaser-rate assertions dispositions that fail
   loudly on data loss.
6. **G17-T06** — the router-enumeration auth test.
7. **G17-T07** — de-stale the migration comment and switch to `runMigrations()`.

---

## 11. Open questions for the parent

1. Is `GRIDIRON_DB_PATH` ever set in Nick's shell profile? If so, G17-T05's blast radius changes
   from "CI fixture" to "whatever that points at", and G17-T01's changes in the other direction.
   I did not read the shell profile (out of scope).
2. `server/routes/props-tickets.js` and `server/routes/decision-inbox.js` having no auth
   (G17-T06) is a **production** finding surfaced by a test-suite audit. Another reader may own
   `server/routes/`; this should be reconciled rather than double-reported.
3. Is run 27 (`nfl_blind_audit_runs`) still `complete` in the live database? If not, five of
   `nfl-audit-overview.test.js`'s seven tests are already silently off, and have been for some
   time. I did not query the live database to check.
4. `test/teaser-season.test.js:32` claims migration 035 "does not parse". `node --check` says it
   does. Either the comment is stale or 035 was fixed and the comment was not updated — worth
   confirming against `git log` by whoever owns `server/migrations/`.
