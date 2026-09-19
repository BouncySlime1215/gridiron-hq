# TDD evidence: availability honest degradation (2026-09-19)

**Item:** re-investigation of B4's `silent-failure-hunter` finding — "the validated
chance-to-play role layer silently isn't running in production, a bare `catch` turns any
read error into 'treat as absent' with no log or warning anywhere."
**Files:** `server/services/contingency.js` (`liveEspnStatuses`, `availabilityDegradation`,
the shared read-failure rule), `server/services/lineup-brain.js` (`lineupCall`'s
`availability_note` and warnings), `client/src/pages/Lineup.tsx`; test
`test/availability-honest-degradation.test.js`.
**Source plan:** `docs/FANTASY-ENGINE-MASTER-PLAN.md` B4, `review:silent-failure-hunter`
(`a717da9ae86fd8579`); prior work `docs/tdd/play-chance.tdd.md`,
`docs/tdd/play-chance-live.tdd.md`, `docs/tdd/review-fixes-2.tdd.md` finding 1.
**LLM spend:** $0. No Anthropic calls were made.
**Environment:** cloud box, **no database**. `server/data.sqlite` is gitignored and
absent. Nothing here was verified against production — the live "Jayden Daniels 57%"
observation cannot be reproduced in this box, and every number below is from a fixture or
from the records above. Section 7 lists what only the Mac session can settle.

## 1. Audit: what the finding asked about, and what has already shipped

**Verdict: partly fixed. The original bare catch is gone. Two holes of the same shape
were still live on the Start/Sit surface, and both are fixed here.**

**The path.** `Lineup.tsx` → `GET /trades/:id/lineup` (`server/routes/trades.js:337`) →
`lineup-brain.lineupCall` (`lineup-brain.js:558`) → `trade-engine.assetUniverse` →
`contingency.weeklyAvailability(season, week)` (`contingency.js:766`) →
`playerActiveProbability` (`contingency.js:569`) → `fitted.roleLookup` over
`nfl_availability_role_rates`. The "57% likely to play" string is built at
`lineup-brain.js:585` and rendered under "Check before kickoff" at `Lineup.tsx:148-159`.

**Already fixed (review-fixes-2 finding 1, RED `2688ecf` / GREEN `0a657f6`).** The bare
`catch {}` pair in `fittedAvailability()` is gone. `no such table` is now a named state —
`availabilityBasis()` returns `{ basis: 'role' | 'pooled' | 'constants', missing, stamp }`,
warned once per `availabilityFitStamp()` (`contingency.js:575-580`) — and every other read
error throws. `test/availability-fit-loader.test.js` 7/7 pins it. **That part of the
finding is closed and no code was changed for it here.**

**Still live, hole 1 — `contingency.js:228`, a second bare catch of the same shape.**
`liveEspnStatuses()` read the `leagues` table inside `catch { return null; }`. `leagues`
is created by the legacy schema migration at import of `server/db/index.js`
(`server/db/index.js:184-187`), which `contingency.js` imports, so the table exists in
every process that can reach that line — the catch could only ever fire on a real fault
(a column from another schema version, a locked database past the 15 s `busy_timeout`).
When it fired, the entire ESPN designation layer vanished. That matters because reserve
lists never appear on the NFL injury report (`play-chance-live.tdd.md` §1), so an ESPN
OUT or INJURED RESERVE player has no report row at all and falls straight back onto his
healthy-starter role cell. The catch was introduced by `build:play-chance-live`, i.e.
after the review that found the first one.

**Still live, hole 2 — the number is served bare.** `availability_basis` has been on
`lineupCall()` since `0a657f6` "so the page can say so". No page read it: the only
references in the client were none (`grep availability_basis client/` — empty). So with
the role layer inert, Start/Sit printed `about 57% likely to play this week` for a player
with no injury of any kind, in a card headed "Check before kickoff", visually identical
to the validated number. That is the finding's own measured live effect, and it was still
exactly reproducible from the served payload.

## 2. Reproduction (fixture, before any fix)

`test/availability-honest-degradation.test.js` builds one team of WR starters, 2025 weeks
1-5 at 0.9 snap share, a league payload whose live ESPN scoring period is 2025 week 6, and
both fit tables **present and populated** — so the role layer is running and the basis is
`role`. Then the `leagues` read is broken (`ALTER TABLE leagues RENAME COLUMN fetched_at`).

| player | ESPN status | leagues readable | leagues read faults |
|---|---|---|---|
| Honest Healthy | ACTIVE | 0.953 (`noreport/none/starter/g0`) | 0.953 |
| **Honest EspnIR** | INJURY_RESERVE | **0.006** (`out`) | **0.953**, `espn_status: null` |

No throw, no log line, and `availabilityBasis()` still reported
`{"basis":"role","missing":[]}` — full confidence. The IR player is startable. That is the
defect reproduced: a layer failing open to "treat as absent" while the number keeps
looking fitted.

Hole 2 reproduces from the served payload directly: with
`availability_basis = { basis: 'pooled', missing: ['nfl_availability_role_rates'] }` and a
player at 0.574, `lineupCall().warnings[0].issue` was the bare string
`about 57% likely to play this week`, and `availability_note` did not exist.

## 3. What changed

- **`liveEspnStatuses` follows the file's own rule.** `no such table` is the one
  legitimate absent state (a database built before the migration) — said once, naming
  ESPN and the table, and it carries on; every other read error throws, exactly as
  `fittedAvailability()` already does. `missingTable` and a new `warnOnce` are lifted into
  one shared block with the rule written above them; `resetAvailabilityCache()` clears the
  said-once set.
- **`availabilityDegradation(basis)`** (contingency.js): `null` when the validated role
  layer is pricing, otherwise `{ inert, basis, reason, effect, fix, stamp }` — the shape
  `counterparty-pricing.js` uses for a source it cannot price on (`inert.push({ source,
  reason })`, `absent.push({ source, reason })`, `{ available: false, reason }`).
- **`lineupCall()`** serves `availability_note`, and each chance-to-play warning carries
  the reason inline when the number is not the fitted one, plus its own
  `availability_basis`. A bye warning is a fact and is left alone.
- **`Lineup.tsx`** renders the note above "Check before kickoff" and passes it to the page
  assistant, so the assistant cannot answer a question about those percentages while
  believing them.

**No served number moves.** The percentages are byte-identical; only what is said about
them changed. (This is the same identity rule review-fixes-2 held itself to; it could not
be re-run on a production copy here — see §7.)

## 4. Gate

No model was fitted and no rate changed, so there is no statistical gate. The behavioural
gate is the test specification in §6 plus the neighbour regression in §5, and one
pre-registered rule: **a fix in this item may not move a served chance to play.** Held —
the only changed outputs are `availability_note` (new), `warnings[].availability_basis`
(new) and the `warnings[].issue` suffix, which appears only when
`availability_basis.basis !== 'role'`.

## 5. Regression

| suite | result |
|---|---|
| availability-honest-degradation (new) | 7/7 |
| availability-fit-loader | 7/7 |
| availability-role | 17/17 |
| play-chance-live | 19/19 |
| player-availability | 15/15 |
| lineup-floor-objective / lineup-surfaces-agree | 3/3, 2/2 |
| decision-leftovers-lineup / -home-away | 10/10, 5/5 |
| lineup-diff-urgency / lineup-evidence | 10/10, 16/16 |
| asset-universe-fingerprint / asset-cache-stamps | 5/5, 5/5 |
| refresh-loop-steps / pinned-baselines / ros-projection-failures | 19/19, 3/3, 4/4 |
| role-scenario-engine / posture-calibration / weekly-early-week-blend | 9/9, 6/6, 19/19 |
| find-trades / trade-evidence | 3/3, 6/6 |
| model-integrity | 93/94 — **pre-existing**, proved by re-running the suite with this
  item's three source files stashed: the same single failure, `evidence daemon status
  exposes feed gaps` (`odds_feed`, betting side, nothing to do with availability) |

`npm run lint` clean (831 files). `npm run typecheck` clean.

## 6. Test specification

| # | Guarantee | Test | Result |
|---|---|---|---|
| 1 | The fixture really prices an ESPN INJURY_RESERVE starter as out while `leagues` reads (the guard that makes #2 meaningful) | `the fixture prices the ESPN INJURY_RESERVE starter…` | PASS |
| 2 | A real `leagues` read fault throws instead of deleting every ESPN designation | `a leagues read fault throws instead of…` | PASS |
| 3 | No `leagues` table is a named state: null, said once with its reason, never per call | `no leagues table at all is a named state…` | PASS |
| 4 | A non-role basis is reported with its inert layer, reason, effect and fix | `an inert role layer is reported on the lineup call…` | PASS |
| 5 | No note when the role layer is pricing, and none invented when no basis was carried | `no note when the fitted role layer is…` | PASS |
| 6 | A chance-to-play warning is never bare while the layer is inert, and never caveated while it is not | `a chance-to-play warning never reads as a fitted number…` | PASS |
| 7 | The page renders the note rather than leaving it on the wire (what went wrong with `availability_basis`) | `the Start/Sit page renders the note…` | PASS |

**RED → GREEN:**
- `f7ee045` RED: 7 tests, 1 pass / 6 fail. The one pass is the fixture guard; the six
  failures are the defect (no throw on a `leagues` fault, no warning, no
  `availability_note`, a bare warning string, no page reading it).
- `78811b1` GREEN: 7/7.

**Command:** `GRIDIRON_DB_PATH=… SCHEDULER_DISABLED=1 NODE_OPTIONS='--import
./test/offline-guard.mjs' node --experimental-test-module-mocks --test
--test-concurrency=1 test/availability-honest-degradation.test.js`

## 7. Known limits and what only the Mac session can settle

1. **Whether the role layer is actually live is still a database fact, not a code fact.**
   Nothing here writes rates. The last recorded state (`review-fixes-2.tdd.md` §1) is
   `nfl_availability_rates` 139 rows, `nfl_availability_role_rates` absent —
   `basis: 'pooled'`, the layer inert. **Mac: read it directly —
   `sqlite3 server/data.sqlite 'SELECT COUNT(*) FROM nfl_availability_role_rates'`, or
   `availability_basis` on any `GET /trades/:id/lineup` response.** If it is 0, the WA
   integration restart in `play-chance-live.tdd.md` §6 has not happened and Nick's
   Start/Sit percentages are still the pooled ones — the page will now say so out loud
   instead of hiding it, but the numbers are still low until the fit runs.
2. **The fix that makes the numbers right is the fit, not this item.** Restart on this
   code with `SCHEDULER_DISABLED=1`, run
   `node --env-file-if-exists=.env scripts/fit-availability.mjs`, expect `DECISION: PASS`,
   139 rows to `nfl_availability_rates` and 871 to `nfl_availability_role_rates`
   (k=5, byPosition=true), then confirm `availabilityBasis().basis === 'role'` and that
   the new degradation card disappears from Start/Sit.
3. **The identity check was not re-run.** review-fixes-2 proved its fixes moved 0 of
   43,200 asset numbers on a production copy. There is no copy in this box. The argument
   here is structural (no arithmetic was touched) and the neighbour suites agree, but the
   43,200-asset identity run belongs to the Mac session before the restart.
4. **A `leagues` fault now throws through `weeklyAvailability`.** That is deliberate and
   matches the rule `fittedAvailability()` already ships, but it means a genuinely locked
   database turns the Start/Sit request into a 500 rather than a wrong lineup. **Mac:
   watch for it once after the restart** — if `busy_timeout` exhaustion is common under
   the report-cache worker load described in `server/db/index.js`, the right follow-up is
   a retry on `SQLITE_BUSY` at the `rows()` layer, not a catch here. Queued as a WD item,
   not silently absorbed.
5. **Not covered here:** free agents still have no ESPN status (payloads carry rosters
   only), and IR/OUT still apply to the live week only — both already logged in
   `play-chance-live.tdd.md` §7.
