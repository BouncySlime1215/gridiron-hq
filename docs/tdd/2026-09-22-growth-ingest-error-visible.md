# TDD evidence: a growth cycle whose ingestion step threw no longer reports itself `ok`

Branch `claude/project-thread-o3wt2p-ingest-error-visible`, cut from `main` at
`1a136145`. Three commits: `459b7ed1` refactor, `c07a4852` RED, `5663ca7d` GREEN.

## The defect

`runNflModelGrowthCycle` runs ten ingestion steps through `attempt()`
(`server/services/nfl-model-growth.js:149`):

```js
async function attempt(name, fn, detail) {
  try { detail[name] = await fn(); }
  catch (error) { detail[name] = { error: error.message }; }
  return detail[name];
}
```

Catching each step individually is deliberate and right — one late nflverse
release must not throw away the nine feeds that did publish. The defect is that
**nothing read what the catch wrote.** The run's verdict was an inline ternary
over three other things: the finalized week, `requiredLag`, and the fit.

`requiredLag` cannot stand in for it, by construction. It is
`after.sources.filter(source => source.required && !source.current)`, and of the
ten ingestion steps:

| ingestion step (`:217-231`) | its `sources` entry | `required` |
|---|---|---|
| `weekly_usage_and_base_snaps` | `weekly_player_usage` | true |
| `play_by_play` | `team_/player_play_by_play_features` | true |
| `next_gen_stats` | `next_gen_tracking` | **false** |
| `pfr_advanced` | `pfr_player_charting` | **false** |
| `snap_counts` | `snap_counts` | **false** |
| `depth_charts` | `depth_charts` | **false** |
| `injury_reports` | `injury_reports` | **false** |
| `verified_event_archive` | `verified_events` | **false** |
| `formation_participation` | **none** | — |
| `ftn_charting` | **none** | — |

Eight of the ten are invisible to `requiredLag`. Two of them have no entry in
`sources` at all, so nothing anywhere in the result recorded that they were even
attempted.

The consequence: a cycle in which `depth_charts` 404s finished with
`status: 'ok'` and the note

> Outcomes became immutable labels, current-season features were ingested, and
> the next-week fit was recorded without auto-promotion.

The note is the half a person reads, and on that run it was false. This is the
shape `CLAUDE.md` names under "Errors are handled or they throw": a layer goes
inert and the surface keeps printing as if nothing had happened.

## Why the RED needed the refactor first

Three attempts were made to reach this state by driving the whole cycle against
a seeded warehouse. Each one was **masked by an earlier branch of the same
ternary**, so the fixture never got to the case it was built for:

| fixture | what it produced | why it never reached `ok` |
|---|---|---|
| warehouse with no final game | `waiting` | `finalized_week === 0` short-circuits everything |
| finalized week, nothing seeded | `source_lag` | the four required sources are all behind |
| required sources seeded to the finalized week | `fit_error` | the fit has nothing to fit on |

Reaching the case needs a warehouse in which **everything succeeds except the one
thing under test**, which is a fixture more elaborate than the code it would be
testing. Two of the attempts also died on unrelated schema work first
(`NOT NULL constraint failed: nfl_team_week_features.features`, then
`FOREIGN KEY constraint failed` on `player_week_usage.player_id -> players.id`),
which is the tell that the fixture, not the code, was becoming the object.

So `459b7ed1` extracts the decision as a pure function, `cycleOutcome({
finalizedWeek, requiredLag, detail })`, with no behaviour change: same order of
checks, same four statuses, same note strings byte for byte. **That commit has no
RED of its own, on purpose** — it changes nothing, so a failing test could only
be manufactured by first reverting production code, which would be theatre.

## RED — `c07a4852`

7 tests added against the extracted function. 4 failed:

```
not ok 7  - an ingestion step that failed is not reported as a clean run
    error: 'depth_charts is required:false, so requiredLag never sees this; the verdict must'
    code: 'ERR_ASSERTION'   expected: 'ok'   actual: 'ok'   operator: 'notStrictEqual'
not ok 8  - the verdict names the step that failed
not ok 9  - every failed step is named, not just the first
not ok 12 - a failed download outranks a failed fit
# tests 13  # pass 9  # fail 4
```

The 9 that passed are the four pre-existing statuses. They are in the same file
so the fix has to preserve them rather than re-order the decision.

## GREEN — `5663ca7d`

A fifth status, `ingest_error`, between `source_lag` and `fit_error`:

```
waiting        a week that is not final explains everything after it
source_lag     an unpublished required release explains the failed download
ingest_error   a failed download explains a fit built on stale rows   <- new
fit_error      the fit, once nothing upstream explains it
ok
```

The note names the steps, and agrees in number with them:

> A finalized week was available and every required release had published, but a
> download failed: depth_charts. The rest of the cycle ran against rows that feed
> did not update, so anything derived from it is as stale as the last successful
> run. The scheduler retries it on the next cycle.

```
# tests 14  # pass 14  # fail 0
```

A step with no `error` key is a success whatever else it returned; a feed that
returned zero rows without throwing is a separate question this does not answer.

**Adding a fifth status is safe because nothing outside this file switches on the
value.** Checked, not assumed: `'source_lag'` and `'fit_error'` occur only at
`:174` and `:188`; `latestRun()` (`:112-115`) does not branch on status;
`scheduler.js:1042` and `routes/nfl-betting.js:231` pass the result straight
through; no client code reads it; and `nfl_model_growth_runs.status`
(`server/db/schema/nfl-a-to-m.js:521`) is a bare `TEXT NOT NULL` with no `CHECK`.

## Mutation sweep — 6 applied, 6 killed, 0 survived

Each injection was verified applied by **md5 before and after the write**, and the
file restored and re-md5'd afterwards. Base `e95ca116fff8d436161d182a064f04d8`,
restored to the same value. Script: `/tmp/claude-0/mutate-growth.py` (session
scratch, not committed).

| # | mutation | md5 after | verdict | killed by |
|---|---|---|---|---|
| M1 | remove the `ingest_error` block entirely | `57a72bff…` | KILLED | 7, 8, 9, 12, 14 |
| M2 | check ingestion **after** the fit | `822fc2e8…` | KILLED | 12 |
| M3 | swap ingestion **before** `source_lag` | `37f67650…` | KILLED | 11 |
| M4 | filter on the step, not on `step.error` | `799deb48…` | KILLED | 9, 10 |
| M5 | drop the step names from the note | `d33c84a7…` | KILLED | 8, 9, 14 |
| M6 | only report when **more than one** step failed | `31ed83b7…` | KILLED | 7, 8, 12, 14 |

M3 is worth recording as a near-miss of the method rather than of the code. Its
first form removed the `source_lag` block and re-inserted it immediately before
the ingest block — where it already was — so it was a no-op. **The md5 check
caught it as `NOT APPLIED` and it was rewritten as a genuine swap.** A grep-based
"did the injection apply" check would have reported it applied and then reported
it survived, which is the false clean bill of health this project has produced
before.

## What this does NOT establish

- **It does not fix the failures.** A 404 from nflverse still leaves the feed
  stale. This makes the run say so instead of claiming it ingested.
- **It says nothing about a feed that returns zero rows without throwing.** That
  is a different defect, in a different place, and test 10 deliberately pins the
  current behaviour rather than changing it.
- **`formation_participation` and `ftn_charting` still have no `sources` entry.**
  Their failure is now named in the note, but the warehouse snapshot still does
  not represent them, so `requiredLag`, `lag_weeks` and `current` are silent on
  them. Left alone: adding a source row changes `learned_through_week` and is a
  bigger question than this fix.
- **No live run produced this.** The evidence is the pure function's behaviour
  under inputs set on purpose. `SCHEDULER_DISABLED=1` is on and `main` is
  undeployed, so no real cycle has executed this path.

## Five questions

**Is it well built?** The decision is now a pure function with its own tests,
which is what made a RED possible at all. The status list grew by one value in a
place that already had four; nothing else in the repo reads it.

**Are the numbers real stats or made up?** There are no statistics here. The only
numbers are test counts (13/9/4 RED, 14/14/0 GREEN) and the mutation table, each
copied from a run in this file.

**How do we know?** The RED failure text is quoted with its `ERR_ASSERTION`,
`expected`, `actual` and `operator`. The six mutations are md5-verified applied
and each names the test that killed it. The "safe to add a status" claim is four
`file:line` checks, not an assumption — see the grep in the GREEN commit message.

**Is this pointed anywhere else?** Yes. `attempt()`'s pattern — catch per step,
write `{ error }`, and let the caller decide — is correct and worth keeping; what
was missing was a caller that decided. Anywhere else in this codebase that
catches into a detail object should be checked for a reader.

**How does it unify?** It is the third instance this week of the same shape: a
guard that catches, a surface that does not say so. The depth-chart zero-row pin
(`2b5b19ad`, `docs/tdd/2026-09-22-depth-zero-rows-loud.md`) is the same defect
one layer down, in the feed this status now names.
