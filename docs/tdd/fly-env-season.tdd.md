# NFL_SEASON in the deployment config — PR #52

Evidence for `Tell the deployment which NFL season it is playing`
(`fly.toml`, `test/fly-env-season.test.js`).

## Why this file has no RED commit

The change is one line of deployment config. There is no implementation to
drive from a failing test, and no behaviour inside node to assert against:
`fly.toml` is read by Fly, not by the app, so nothing at runtime — in a test,
in a script, in CI — can observe whether the deployment sets the variable. The
file is the only place the answer exists, and the test asserts the file.

Retroactive form, the precedent being `docs/tdd/week2-numbers.tdd.md`: each
rule named, each shown failing under a mutation. *A test that no mutation can
fail proves nothing.*

## The defect

`[env]` in `fly.toml` held only `HOST`. `NFL_SEASON` has never been set in
production.

Nothing looks wrong today, which is why it survived. 79 sites read the variable
as `Number(process.env.NFL_SEASON) || <fallback>`, and **the fallback is not
the same everywhere**. Some hard-code 2026 (`projections.js:34`,
`trade-engine.js:118`, `season-sim.js:31`, a dozen more); the rest call
`new Date().getFullYear()` or `getUTCFullYear()` (`scheduler.js` in seven
places, `draft-assist.js:872`, `offseason-model.js:1824`, others). During the
2026 calendar year both produce 2026, so the two idioms agree and the gap is
invisible.

On 2027-01-01, in the middle of the 2026 playoffs, they split. The
calendar-year sites move to 2027 while the hard-coded ones stay on 2026, and
the app holds two different opinions about what season it is at the same time —
half of it querying a season with no rows in it while reporting healthy. Same
shape as everything else this thread has found.

One site changes behaviour **today** rather than in January.
`availableSeason()` (`nfl-model-growth.js:52-56`) is the only reader that does
not use the `||` idiom:

```js
const configured = Number(process.env.NFL_SEASON);
if (Number.isInteger(configured)) return configured;
return Number(row('SELECT MAX(season) season FROM game_lines')?.season) || …
```

Unset, it answers "the newest season we hold lines for". Set, it answers 2026
unconditionally. Those are the same answer only while `MAX(season)` in
`game_lines` is 2026. That is expected and **is not verified here** — it needs
a live read, and it is the one thing to confirm after this deploys.

## The rules, and the mutation that breaks each one

Two guarded rules in `test/fly-env-season.test.js`. Baseline: **2 pass, 0 fail.**

| # | Rule | Test |
|---|------|------|
| 1 | The value is present and a plausible four-digit season | `fly.toml declares NFL_SEASON as a four-digit year` |
| 2 | It is inside `[env]`, not some other table | `NFL_SEASON is declared inside [env], not in some other table` |

Each mutation applied to `fly.toml`, the test run, the file restored. The
harness reports whether the substitution actually changed the file, because a
no-op injection reads as a passing mutation sweep and is a stronger false claim
than no sweep at all.

```
=== BASELINE ===
# pass 2
# fail 0
### value-removed [applied] -> 0 pass / 2 fail
    not ok 1 - fly.toml declares NFL_SEASON as a four-digit year
    not ok 2 - NFL_SEASON is declared inside [env], not in some other table
### value-not-a-year [applied] -> 1 pass / 1 fail
    not ok 1 - fly.toml declares NFL_SEASON as a four-digit year
### value-implausible [applied] -> 1 pass / 1 fail
    not ok 1 - fly.toml declares NFL_SEASON as a four-digit year
### value-in-the-wrong-table [applied] -> 1 pass / 1 fail
    not ok 2 - NFL_SEASON is declared inside [env], not in some other table
```

- **value-removed** — the line deleted, i.e. production as it is right now.
- **value-not-a-year** — `"26"` instead of `"2026"`. TOML is happy, `Number()`
  is happy, and every reader would get season 26.
- **value-implausible** — `"1999"`. The band is a sanity check, not a freshness
  check: a test cannot know the current season without becoming the very
  calendar-year assumption this pins down. The annual bump is left to the
  comment beside the value.
- **value-in-the-wrong-table** — the key moved under `[[mounts]]`. TOML accepts
  a key in the wrong table and does nothing with it, so rule 1 still passes and
  production is unchanged. Rule 2 is the only thing standing between "the test
  is green" and "the variable is set".

## A latent bug in this PR's own test, found and fixed here

Rule 2's table scan was written as:

```js
const env = /^\[env\]$([\s\S]*?)(?=^\[|\Z)/m.exec(fly);
```

**JavaScript has no `\Z` anchor.** It is a literal `Z`. The alternation only
ever terminated on the next `[`, which works in this file purely because
`[[mounts]]` happens to follow `[env]`. The same idiom was copied into
`test/fly-health-check-grace.test.js` (PR #49), where the scanned table *is*
last in the file, and there it broke three tests outright — which is how it was
caught.

Fixed here to spell the end of input out, with a comment saying why:

```js
const env = /^\[env\]$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(fly);
```

The proof is the reordering, since the current file cannot show the difference:

```
fly.toml as it is today ([[mounts]] follows [env])
  old  \Z pattern: reads NFL_SEASON
  new  end-of-input pattern: reads NFL_SEASON
the same file with [env] moved last
  old  \Z pattern: NO MATCH
  new  end-of-input pattern: reads NFL_SEASON
```

It fails safe — `exec` returns null and `assert.ok` fires with a message about
a missing `[env]` table — so it would have been noisy rather than silent. But
it would have been noisy about the wrong thing, reporting a missing table when
the real cause was the pattern, and a maintainer reordering `fly.toml` would
have chased the file rather than the test.

## What this file does not settle

Whether `MAX(season)` in `game_lines` on the live machine is 2026. Until that
read happens, pinning `NFL_SEASON` changes `availableSeason()`'s answer from
measured to declared, and this suite cannot tell whether those two agree:

```sql
SELECT MAX(season) FROM game_lines;
```

Nor does it settle the code-side tidy. `draft-assist.js` uses the calendar year
where its neighbours hard-code 2026, and the two idioms should converge on one.
That is a change to 79 call sites and does not belong in a config PR.
