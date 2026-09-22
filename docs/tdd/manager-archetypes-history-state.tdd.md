# An unreadable identity layer is not a pile of unowned ESPN slots

PR #131. `server/services/manager-archetypes.js`.

This fixes a hole in #113, which this thread also wrote.

## The defect

`teamMembers()` called `teamMembersState()` and returned only its `.byRoster`,
discarding the `{ present, reason, source }` it had just computed.
`teamMembersState()` answers with an empty Map when `league_season_teams`
cannot be read, so with that table absent every roster in `outcomeRows()` fell
through the branch #113 added:

```js
if (!team?.espn_member_id) { out.unownedSlots++; continue; }
```

whose own comment certifies the case as "A real ESPN state, not a fault". A
whole unreadable data layer was therefore counted and published under a label
that explicitly certifies it is *not* a fault, and no field on the build named
the failure. That is worse than the silent drop #113 replaced: a silent gap
invites a question, a confident wrong explanation closes it.

The state is reachable, not theoretical. `leagueHistoryState()`'s own docstring
records that migration 064 is not on `main`, while `league_draft_picks` is
created by nothing in this repository yet holds live rows.

## Measured

Two rosters, both owned by real ESPN members (`MEM-A`, `MEM-B`). Nothing about
them changes between the rows; `league_season_teams` is renamed away, and that
is the only difference.

| | `outcome_manager_seasons` | `outcome_unowned_slots` | `outcome_unreadable_slots` | `league_history_state` |
|---|---|---|---|---|
| HEALTHY (before & after) | 2 | 0 | 0 | `present` |
| UNREADABLE — before | 0 | **2** | — | *no such field* |
| UNREADABLE — after | 0 | **0** | 2 | `table_absent` |

## RED

#131, `test: RED - an unreadable identity layer counts as unowned slots`,
`eedeb64`.

`test/manager-archetypes-history-state.test.js`, 3 tests, all 3 failing. The
middle test asserts the miscount *before* it asserts the missing field, so the
RED output evidences the defect rather than only the absent reporting:

```
not ok 2 - an unreadable identity layer is named, not counted as unowned slots
  error: |-
    these rosters ARE owned — an unreadable table must never be reported as
    "ESPN gave this slot no owner", which is what the count certifies
```

## GREEN

#131, `fix: GREEN - an unreadable identity layer is named, not counted as unowned`,
`665cbb2`. Same 3 tests pass.

Test 3 is the guard on the fix: a genuinely unowned slot on a readable table
still counts, so this narrows the counter rather than gutting it.

## Liveness proof — mutation sweep

Run with `scripts`-free harness on head `501a575`, source
`server/services/manager-archetypes.js`, test file
`test/manager-archetypes-history-state.test.js`.

| Mutant | Kind | Expected | Verdict |
|---|---|---|---|
| `control-not-applied` — nothing mutated | control | pass | **PASS** |
| `M1` — `if (!present)` → `if (false)`, dropping the guard | unit | DIED | **DIED** |
| `M2` — `present: state.present` → `present: true` at the call site | call-site | DIED | **DIED** |
| `M3` — `league_history_state: … ? … : …` → `'present'` | unit | DIED | **DIED** |
| `CONTROL` — `source: LEAGUE_HISTORY_SOURCE` → a wrong label | control-surviving | SURVIVED | **SURVIVED** |

M1, M2 and M3 each died on
`not ok 2 - an unreadable identity layer is named, not counted as unowned slots`.

The two controls are designed, per the merge gate. The not-applied control
shows the harness reports a clean tree as passing. The surviving control is a
change these tests deliberately do not pin — the provenance label — and it
survived; had it died, the tests would reach further than claimed and the
verdicts above would not be trustworthy.

M2 is the call-site row the gate requires: the predicate the caller injects is
hardcoded to `true`, so `outcomeRows()` reads an unreadable layer as readable
even with its own branch intact.

## Merge gate

- `git fetch origin main && git merge origin/main` — merged `6e722719` (clean).
- `git status --porcelain` empty; `git write-tree` = `63bff245435d1e5b54e906219ec1883999e612d3`, unchanged after the run.
- `npm ci` run in a fresh worktree.
- `npm run check` — **exit 0**. Tests **3599 / 3558 pass / 0 fail / 41 skipped**.
- `npm run start:smoke` — **exit 0**, startup smoke passed on an isolated database.

The guard run above is on the code tree. The only change after it is this
document, which is Markdown under `docs/` imported by nothing; CI on the
pushed head is the check that covers it.

One logged line in the run, `# Error: no such column: espn_member_id`, is the
deliberate output of the passing test "read: a programming error in the
archetype read is NOT absorbed". It is the error propagating as designed, not
a failure.

## Nick's five questions

1. **Well built?** Yes. It removes a field-level lie rather than adding a
   feature: the state travels with the index it describes, matching the
   `draft_data_state` / `draft_data_reason` pair already on this build.
2. **Stats or made up?** Neither — this is a correctness change, no estimate
   or constant. The numbers in the table above are counts from a harness, not
   a model.
3. **How we know:** direct measurement, not a backtest. Two rosters owned by
   real ESPN members, `league_season_teams` renamed away and nothing else
   changed, counters read before and after; plus the five-row mutation sweep.
4. **Pointed anywhere else on the platform?** The build's return is read by
   `routes/trades.js` through `archetypesFor()`. `outcome_unowned_slots` has
   no consumer beyond the build's own summary yet, which is why narrowing it
   now is cheap. `league_history_state` is new and consumed by nothing — it is
   there so the next reader cannot repeat the mistake.
5. **How it unifies:** third use of one house pattern in this file —
   `draft_data_state`, then this, each a `{present, reason, source}` accessor
   surfaced as `<thing>_state` / `<thing>_reason`, deliberately uncached
   because a migration can create a table inside the life of a process.

**Defect fixed:** `manager-archetypes.js:254` discarded the state it computed;
consumed at `manager-archetypes.js:533`.
**Incumbent, by command:** rename `league_season_teams` away and build — two
owned rosters report `outcome_unowned_slots=2` and no field says a table is
missing.
**What this does NOT cover:** `picks_without_manager` is inflated by the same
empty index and is untouched here; it reads as "ESPN omitted memberIds" when
the truth is "we could not look". Worth its own change.
**What would make it wrong:** if `outcome_unreadable_slots` were ever non-zero
while `league_history_state` read `present`, the split is asking the wrong
question.
