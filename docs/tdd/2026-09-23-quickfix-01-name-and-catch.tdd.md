# QUICKFIX-01 — leaguemate name in comment + bare catch on selfRead

## 0. Audit (extend-or-build)

Two isolated hard-rule violations named by the work-queue row, both real and
still present on `origin/main` at the time this unit started:

1. `server/services/trade-tactics.js` (around the `vetoClimate` docstring, was
   lines 411-419 on the coordinator's cited tree — moved slightly after
   `#165` merged; on this unit's base it is lines 415-421) named a real
   leaguemate in a worked example: `"Nick to [the leaguemate's name], McConkey + Achane out for
   Etienne + Nico Collins back"`. Public-repo no-names rule
   (WORK-QUEUE.md §4 rule 12 class; merge-gate v2 §5).
2. `server/services/trade-engine.js:2172` (`attachTactics`) had
   `try { self = selfRead(lg.id, { season: weekNow.season }); } catch { self
   = null; }` — a bare catch. merge-gate v2 §5: "No bare `catch {}`. Errors
   are handled or they throw."

Nothing to extend — both are one-line/one-block fixes on files another PR is
not touching (grepped `git log --oneline -- server/services/trade-engine.js`
open PRs list in WORK-QUEUE.md §2/§3 around line 373 shows other queued
trade-engine.js hunks are in `findTradesUncached`/valuation regions, not
`attachTactics`'s selfRead try/catch at :2172).

Not a statistical unit (no model number, no projection, no pre-registration
needed).

## 1. RED

Commit `e462a1d4` — `test: RED for QUICKFIX-01 (leaguemate name in comment +
bare catch)`. Both assertions fail on that commit's tree (unfixed code):

```
not ok 1 - trade-tactics.js no longer names a real leaguemate in the veto-proof docstring
not ok 2 - a selfRead fault is logged and surfaced as a typed absence, not swallowed by a bare catch
# tests 2
# pass 0
# fail 2
```

Failing assertion #2, inline:
`error: 'a thrown selfRead must be logged via console.error, not swallowed'`
— the bare catch on `origin/main` drops the thrown error with no log and no
trace in the served data.

Command: `node --experimental-test-module-mocks --test --test-reporter=tap
test/quickfix-01-selfread-catch.test.js` run against commit `e462a1d4`.

## 2. GREEN

Commit `267282d9` — `fix: name the fault instead of swallowing it, drop
leaguemate name from comment`. Same command on that tree:

```
ok 1 - trade-tactics.js no longer names a real leaguemate in the veto-proof docstring
ok 2 - a selfRead fault is logged and surfaced as a typed absence, not swallowed by a bare catch
# tests 2
# pass 2
# fail 0
```

## 3. What it does

- `trade-engine.js` `attachTactics`: a thrown `selfRead` error is now logged
  (`console.error('[trade-engine] selfRead lookup failed for league …', err)`)
  and `self` becomes a typed absence
  `{ league_id, available: false, reason: 'self-scout lookup failed' }`
  instead of `null`. `trade-tactics.js:887-888`'s existing
  `self?.available === false ? self.reason : '<generic empty-history
  sentence>'` branch (unchanged) now reads the fault's reason instead of
  reading through as the same sentence a genuine "you've never offered this
  manager anything" empty case produces.
- `trade-tactics.js`: the `vetoClimate` docstring's worked example no longer
  names a real leaguemate (the leaguemate's real name → "a league mate"); the
  numbers (4 of 5 votes) and the point being made (one observed veto-vote
  package is not a model) are unchanged.

## 4. Numbers, with commands

- Grep control (known-nonzero before trusting the 0-count claim):
  `grep -c Etienne server/services/trade-tactics.js` → `1` (player name that
  must survive, proves the grep mechanism works).
- Grep claim (name withheld here per coordinator note): a case-sensitive,
  word-bounded grep for the removed leaguemate name against
  `server/services/trade-tactics.js` → `0` on the GREEN tree (was `1` on
  RED/origin/main); pinned in the test file itself as
  `test/quickfix-01-selfread-catch.test.js`'s first assertion.
- Targeted test: 2 tests, 2 pass, 0 fail (command above), tree `267282d9`.

## 5. Mutation sweep (logic change — required)

Unit mutated: `trade-engine.js:2172-2179` (the catch block). Call site
mutated: `trade-tactics.js:887` (the `self?.available === false` read).
Baseline restored from `/tmp/te.bak` / `/tmp/tt.bak` after each mutant;
final tree confirmed clean (`git status --porcelain` empty,
`git write-tree` = `39bdad121d966eabab70b142a4dec9562deab356`, matching
commit `267282d9`).

| # | Mutant | Result |
|---|---|---|
| M1 | Revert to the original bare `catch { self = null; }` | **killed** — test 2 fails, same failing assertion as RED |
| M2 | Change `reason` string to `'self-scout unavailable'` (drops "lookup failed") | **killed** — regex `/lookup failed/i` assertion fails |
| M3 | `console.error` → `console.log` in the catch | **killed** — `errCalls` mock never fires, "must be logged via console.error" fails |
| M4 (call site) | `trade-tactics.js:887` flip `self?.available === false` → `=== true` | **killed** — the surfaced-fault regex assertion fails (falls through to the generic empty sentence, which is exactly the pre-fix collision this unit fixes) |
| M5 | Designed survivor: reword the log prefix (`"selfRead lookup failed for league"` → `"selfRead failed for league"`), keeping the `selfRead` substring | **survived** — documented known gap, see §6 |
| control | Not-applied baseline: unmutated GREEN tree, same command | pass 2/2, as GREEN §2 |

## 6. Known defects / gaps

- The log-message assertion (`String(args[0]).includes('selfRead')`) only
  pins the presence of the substring `"selfRead"` in the first console.error
  argument, not the full message wording (M5 survives). Acceptable: the
  behavioural claim this unit fixes is "logged vs silently dropped," not the
  exact wording of the log line.
- The RED commit's original test fixture asserted on `d.tactics` for the
  `how_nick_looks` key; the fixture used here produces no pacing/pressure
  chat evidence, so the entry actually lands in `d.tactics_absent` (verified
  by reading `trade-tactics.js:649-905`'s `note()`/`tactics.push` branching).
  Corrected in the GREEN commit before trusting the green result — recorded
  under standing rule 8 (zero/empty needs a known-nonzero control first;
  applies equally to "test passes for the wrong reason").
- No forward/holdout claim: this unit is a code-quality fix (name removal +
  error handling), not a model or projection change. **Holdout looks: none.**
  Not applicable to HOLDOUT-LEDGER.md.

## 6b. Skeptic fix (2026-09-23): name no longer stored in the test

Two skeptics found the RED/GREEN test at `test/quickfix-01-selfread-catch.test.js:43`
contained the leaguemate's name as a regex literal and in the assertion
message, re-adding it to the public repo. Fixed: the test now tokenises
`trade-tactics.js` and compares `sha256(lowercase(token))` against a set of
forbidden hashes; the name itself is not in any committed file on this branch's
diff. A second control proves the hash matcher can find a known token
(`Etienne`) before trusting a zero-hit result.

- `git grep -n -w -i <name> -- test server/services/trade-tactics.js` -> no
  output, exit 1 (tree = this fix commit).
- `node --experimental-test-module-mocks --test --test-reporter=tap test/quickfix-01-selfread-catch.test.js`
  (SCHEDULER_DISABLED=1, GRIDIRON_DB_PATH=mktemp):
  - fix tree -> pass 2 / fail 0
  - same test with `server/services/trade-tactics.js` and `trade-engine.js`
    temporarily restored from `origin/main` (RED sources) -> pass 0 / fail 2;
    files restored afterwards, `git status` showed only the test file modified.
- Out of scope, pre-existing on origin/main (not introduced by this unit): the
  same name appears in `docs/FANTASY-ENGINE-MASTER-PLAN.md`, `docs/STRUCTURAL-RELOOK.md`,
  `docs/tdd/tactics-and-packages.tdd.md`, `server/services/manager-signals.js:451`
  and `study/features/archetypes.md` (found by `git grep -n -w -i <name> HEAD`).
  Follow-up unit needed for a repo-wide scrub.

## 7. Nick's five questions

1. **Well built?** Yes for what it is — a one-line docstring edit and a
   9-line catch-block change, each covered by a targeted, mutation-tested
   assertion.
2. **Stats or made up?** Neither — no model number involved.
3. **How we know:** targeted test (RED/GREEN above) plus a 5-mutant sweep
   (4 killed, 1 designed survivor documented).
4. **Pointed anywhere else on the platform?** No — `attachTactics`'s
   `selfRead` catch and the `vetoClimate` docstring are each single call
   sites; grepped, no duplicate producer of either concern exists.
5. **How it unifies:** `self.available`/`self.reason` is the same typed-absence
   shape `trade-tactics.js:887-888` already expected and reads from a
   healthy `selfRead()` return; this fix makes the *faulted* path produce
   that same shape instead of `null`, so the consumer's existing branch
   (unchanged) now discriminates correctly instead of by accident.

Defect fixed: bare catch at `trade-engine.js:2172` (pre-fix), leaguemate name
at `trade-tactics.js` `vetoClimate` docstring (pre-fix, ~lines 415-417 on
this unit's base tree). Incumbent: none (no prior fix attempt landed on
main). Does NOT cover: any other bare catch elsewhere in the file (out of
scope per coordinator note — other queued PRs touch other trade-engine.js
hunks). Would be wrong if: `selfRead`'s real callers expect `self` to stay
`null` on fault (checked — `trade-tactics.js` only reads
`self?.to_each_manager`, `self?.available`, `self.reason`, all `?.`-guarded
or reached only inside the `available === false` branch, so the typed
absence is a strict superset of what `null` supported).
