# TDD evidence: a test fixture could clear a gating finding

**Item:** `column-read-never-written` counted a SQL write inside the test tree as a
writer, so one fixture line could silence a rule that fails the build.

**Files owned and changed:** `scripts/wiring-map.mjs`, `test/wiring-map.test.js`,
`docs/wiring/WIRING-MAP.md`, `docs/wiring/wiring-map.json`, this document.

**Origin:** the standing audit, run against feature audit's PR #67 on 2026-09-20. That
PR changes one service and adds one test file, and
`SHOULD-WIRE column-read-never-written players.bye_week` vanished from the gating list.
Nothing had started writing the column. What cleared it was a fixture line in the new
test:

```js
run(`UPDATE players SET bye_week = 9 WHERE id IN (${squad.map(p => p.id).join(',')})`);
```

---

## The asymmetry

The read side of the rule already excluded the test tree — a test reading a column is
not a live surface, and the code said so in as many words. The write side did not. So:

| side | test tree | effect |
|---|---|---|
| read | excluded | correct |
| write | **counted** | any fixture silences the rule |

The same hole exists through the second door: `opaqueWrite`, which suppresses every
column finding on a table when a write names its columns through a template or a `*`.
A fixture insert of that shape would have silenced the whole table.

## Why this one is worse than the previous two

`docs/tdd/wiring-map-template-literal-uses.tdd.md` and
`docs/tdd/wiring-map-namespace-imports.tdd.md` both made the map confidently wrong out
loud: findings that were there and should not have been, on rules that do not gate.
This one makes it **silent, on a rule that does gate**. The finding does not move or
weaken; it disappears. And the thing most likely to introduce the fixture is the test
someone writes while fixing the very area the finding is about.

## RED

`columnEvidence()` was lifted out of `findings()` unchanged so the evidence can be
tested on its own; the RED commit's behaviour is exactly what shipped. Three cases, two
failing:

```
not ok 28 - a test fixture is not a writer: it cannot clear a column-read-never-written finding
not ok 30 - a test fixture cannot mark a table opaque either
# tests 43
# pass 41
# fail 2
```

Case 29 — a `scripts/` write still counts — passes in both states by design. It is the
guard against over-correcting: a backfill script is a real writer, run by hand or by a
job, and excluding it would invent findings rather than hide them. A fix that excluded
every non-server tree would pass cases 28 and 30 and be wrong.

Commit `155e90f`.

## GREEN

One `continue` at the top of the file loop, and the read side's now-redundant guard
removed. `scripts/` and `client/` stay evidence; only `test/` is excluded.

## Blast radius, measured

Against `origin/main` at `791b131`, same script, before and after: **identical**. All
three gating column findings are present in both runs —
`draft_pick_corrections.applied_at`, `draft_pick_quarantine.first_seen_at`,
`players.bye_week` — and no finding appeared or disappeared.

That is the honest result and it is the point: **nothing on main was masked today.** The
hole was open, and #67 had just walked into it. With the fixed script, `players.bye_week`
is back on #67 where it belongs.

| | before | after |
|---|---|---|
| `origin/main` 791b131 | 2196 | 2196 |
| #67 `89bbf68e` — gating column findings | 2 | 3 |

The map's own `--check` gate still passes on this branch.

## The pattern, now three deep

Three blind spots in this file in two days, all the same question left unasked: **what
does the extractor actually see, and does every rule built on it agree about that?**
Here the two sides of one rule disagreed about whether a test counts, and the answer had
been written down correctly on one side and forgotten on the other.

All three were found by running the tool against another thread's branch. None was found
by inspection, and none by the attacks written against the tool directly. When a finding
moves and no code in that area changed, the tool moved — that is the signal worth
chasing every time.
