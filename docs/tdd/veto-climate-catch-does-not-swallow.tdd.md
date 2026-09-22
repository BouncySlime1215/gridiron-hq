# TDD evidence: the vetoClimate/timingRead bare catch no longer swallows a fault

Source: flagged by the Trade Brain thread while fixing `vetoClimate`'s own
`read_state` contract (their commit `a68f5fd`, `claude/project-thread-3xqh5l-outcome-ledger`,
not on this tree — see their message quoted in full below the mutation table).
Routed through the coordinator; confirmed independently before any code
changed. Nothing pushed, no PR opened. LLM spend not tracked here.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u).sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' \
      node --experimental-test-module-mocks --test --test-concurrency=1 \
      test/veto-catch-does-not-swallow.test.js

## The defect

`server/services/trade-engine.js`'s `attachTactics`, at `654ff93`:

```js
  let timing = new Map();
  let climate = null;
  let self = null;
  try { timing = timingRead(lg.id, { season: weekNow.season }); } catch { timing = new Map(); }
  try { climate = vetoClimate(lg, { season: weekNow.season, priceOfPlayer: valueOfEspn }); }
  catch { climate = null; }
  try { self = selfRead(lg.id, { season: weekNow.season }); } catch { self = null; }
```

Bare, no bound error, no log — the exact pattern CLAUDE.md names by name: "No
bare `catch {}` that swallows a fault... this project has shipped two real
bugs of exactly that shape."

**Why it matters here specifically.** `vetoClimate`'s own "nobody has voted in
this league" case is a RETURN, not a throw — its early return on an absent
transactions table is right there in its source
(`trade-tactics.js:389`, `if (!tx.length) return climate;`). So anything that
reaches this catch is a real fault: a renamed column, a bad payload, a
programming error. The bare catch converted that fault into `climate = null`
— the same shape `vetoRiskFor` (`trade-tactics.js:438`) produces for a
genuinely empty league. A DB fault and "nobody has voted here" read
identically downstream, and nothing on the surface says which one happened.
`timingRead` has the same shape and the same catch.

## RED

`test/veto-catch-does-not-swallow.test.js` mocks `vetoClimate` and
`timingRead` (named-export spread over the real module, per the pattern in
`test/decision-leftovers-waivers.test.js`) to throw distinct, identifiable
errors, then calls `findTrades` against a real, priced, deliberately lopsided
six-team league (fixture follows `test/trade-tactics.test.js`'s BARE-league
recipe — six *evenly* valued teams produce no trade at all, so the lopsided
shape and the `dynasty_values`/`player_season_stats` rows are load-bearing).

At `654ff93` (bare catch), both assertions fail — not with an exception, but
because nothing was logged and `tactics_absent` carried none of the fault:

```
not ok 1 - a veto-climate and timing read that throw are named and logged, not silently dropped
  error: 'expected a logged veto-climate failure naming the real error; got: []'
not ok 2 - the fault reaches every shown deal on tactics_absent, not just the log
  error: deal 3 tactics_absent must name the veto-climate fault: [..., {"key":"veto_proof","reason":"this league's ESPN settings do not carry a veto threshold, so there is nothing to price league-perceived fairness against"}, {"key":"timing","reason":"no captured transactions for this league, so there is nothing that says when this manager answers"}, ...]
```

That second failure is the defect made visible: the injected fault landed on
`tactics_absent` as `veto_proof`/`timing` — the SAME reasons a genuinely
empty league produces — with no trace that anything actually threw.

## Fix

Name the fault, log it (matching the existing `rosFailure` precedent at
`trade-engine.js:291-297`, same file), and carry it onto `tactics_absent` —
the `{ key, reason }` array `trade-tactics.js`'s own `note()` helper already
uses for exactly this shape, so no new vocabulary:

```js
  let timingFailure = null;
  let climateFailure = null;
  try { timing = timingRead(lg.id, { season: weekNow.season }); }
  catch (error) {
    timingFailure = `veto timing unavailable (${error.message})`;
    console.error(`[trade-engine] league ${lg.id}: ${timingFailure}`);
    timing = new Map();
  }
  try { climate = vetoClimate(lg, { season: weekNow.season, priceOfPlayer: valueOfEspn }); }
  catch (error) {
    climateFailure = `veto climate unavailable (${error.message})`;
    console.error(`[trade-engine] league ${lg.id}: ${climateFailure}`);
    climate = null;
  }
```

and, inside the per-deal loop, right before `d.tactics_absent` is assigned:

```js
    if (climateFailure) out.tactics_absent.push({ key: 'veto_climate', reason: climateFailure });
    if (timingFailure) out.tactics_absent.push({ key: 'veto_timing', reason: timingFailure });
    d.tactics = out.tactics;
    d.tactics_absent = out.tactics_absent;
```

`selfRead`'s catch is untouched — nothing in Trade Brain's report or my own
read of `selfRead` names it as having a return/throw split like the other two,
so it stays out of scope rather than being swept in on a guess.

`git hash-object server/services/trade-engine.js`: before `c482cb9b31f0500eb273a969f6f1266fd830f4e1`,
after `e617cae721fea885c162e29790b09bb4c8b8a358`.

## GREEN

Both tests pass at the fix. Regression-checked against the five other test
files that exercise this code path or the sibling `trade-tactics.js` module —
all unaffected:

| File | Result |
|---|---|
| `test/find-trades.test.js` | 3/3 |
| `test/trade-tactics.test.js` | 32/32 |
| `test/trade-engine-correctness.test.js` | 15/15 |
| `test/trade-evidence.test.js` | 6/6 |
| `test/manager-data-pipeline.test.js` | 23/23 |

Full local suite (`test/*.test.js`, same harness): **2988 tests, 2947 pass, 0
fail, 41 skipped**, tree unchanged across the run (`69440335b063` before and
after; no other files touched in the window).

## Discrimination: two mutations, each dying at its own assertion, not the other's

The two assertions in test 1 (and the two `.some()` checks per deal in test 2)
are independent claims — a version that only catches one fault correctly
must not pass by accident on the other's strength.

| Mutation | Result |
|---|---|
| `timingRead` restored to the real function (only `vetoClimate` still throws) | Test 1's veto-climate assertion **passes**; its veto-timing assertion **fails**: `expected a logged veto-timing failure... got: ["[trade-engine] league 301: veto climate unavailable (...)"]`. Test 2 fails at the veto-timing `.some()` check specifically. |
| `vetoClimate` restored to the real function (only `timingRead` still throws) | Mirror image: the veto-timing assertion passes, the veto-climate assertion fails at test 1 and test 2's veto-climate `.some()` check. |

## NO-OP control

The unmodified test file, re-run standalone after the two mutation runs
above (each of which used a disposable scratch copy, never the committed
file): 2/2 pass, same as the original GREEN run — confirms the mutation
copies, not the committed test, were what changed.

## What this does NOT settle

Whether `selfRead`'s own bare catch needs the same treatment — no evidence was
gathered either way, so it is left alone rather than guessed at. Whether
Trade Brain's `read_state` contract (`'present'` | `'source_table_absent'`,
committed at `a68f5fd`, not on this tree) changes what `vetoClimate`'s
*legitimate* return path should mean to a caller is a separate question from
this one: this fix only concerns what happens when the function throws,
which their own message identified as orthogonal to their `read_state` work.
