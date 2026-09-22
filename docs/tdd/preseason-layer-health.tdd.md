# The three layers under the draft board that could go inert in silence

2026-09-20. `server/services/preseason-model.js`, `test/preseason-layer-health.test.js`. Off
`main` 791b131.

## What was wrong

`preseason-model.js` reads three optional data layers, and swallowed every fault from all
three. CLAUDE.md names this shape explicitly — *"Errors are handled or they throw. No bare
`catch {}` that swallows a fault — this project has shipped two real bugs of exactly that shape,
where a silent catch deleted a whole data layer and the page kept printing numbers as if nothing
had happened. If a layer goes inert, the surface must say so."*

**1. `seasonTotals`, `catch { continue; }` with no count.** A malformed JSON `features` blob
skipped the row. The skip happens *before* `cur.games += 1`, so an unreadable week reduces the
player's games count — and `games_1`, `games_2` and `availability_3` are all built from those
counts. A player whose weeks would not parse looks like a player who did not play. This module's
own header calls availability *"the audit's loudest finding"* and *"the most common way a draft
goes wrong"*, so this is the worst-placed of the three.

**2. `chartRows`, `catch { return new Map(); }`.** Its doc comment justifies tolerance for one
case — *"a database that has never run an offseason sync must still produce a board"* — and that
justification is sound. But the catch is indiscriminate. A renamed column, a typo in
`CHART_COLUMNS`, a corrupt file and a locked database all produced the same empty Map. Every
charting feature is then imputed to its median by `chartMedians`, and `driversFor` goes on to
describe those medians as if they were this player's own facts.

**3. `inHouseProjections`, `catch { /* a feature, not a dependency */ }`.** Same shape:
`buildProjections` throwing for any reason was indistinguishable from a player simply having no
projection.

## What changed, and what deliberately did not

Each layer records what happened, and `preseasonLayerHealth(season)` hands it to a caller. Every
layer reports `ok`, a `state` of `'ok'`, `'absent'` or `'error'`, and a `reason`;
`season_totals` also reports `unparsed_rows` and up to ten samples, because a count nobody can
investigate does not get acted on.

`absent` versus `error` is the distinction the bare catch could not draw, and the two call for
opposite responses. A table that does not exist is the documented, tolerated case: run the sync.
A table that exists and will not answer the query is a fault. Reporting the second as the first
is how a board built entirely on imputed medians passes for a board built on charting data.

**No number the board produces has changed, and that is a deliberate limit.** All three faults
still degrade rather than fail. Turning a working draft board into a 500 on a structural database
error is a product decision, and it is not one to take unilaterally inside a test — the question
is routed rather than answered. What changed is that the degradation is *reportable* instead of
silent.

The unreadable week is still not counted as a game. Stats that cannot be read are not evidence
that the player was on the field, so the old behaviour was right; what was missing was the count
beside it. A run that dropped a third of the league returned a result identical to one that read
all of it — the same defect, and the same fix, as the `unmatched` counter in
`docs/tdd/snap-share-ingest.tdd.md`.

`preseasonLayerHealth` **forces** the three layers rather than reporting on whatever is cached. A
caller asking "is this board sound" before the board is built would otherwise get a clean bill of
health for reads that never happened. `P7` is that mutation. The ledger is keyed by season and
cleared with the fit cache, because a layer's state is a fact about the read that populated the
cache; a stale verdict beside a fresh table would be this bug again in a new place.

One incidental change: `seasonTotals`' query did not select `week`, so a dropped row could be
counted but not named. It does now.

## Mutations

Base `preseason-model.js` = `26ae7769449b`. Each row applied alone from the clean base, hashed
before and after, before/after text printed by the runner, file restored to base at the end.

| # | mutation | hash after | result |
|---|---|---|---|
| P1 | stop counting unparseable rows, back to the bare skip | `06133070808f` | 1 fail |
| P2 | count them but keep the layer `ok`, so nothing reads as wrong | `bcad4461f152` | 1 fail |
| P3 | drop the samples, leaving a count nobody can investigate | `c8f370e528b9` | 1 fail |
| P4 | report a broken charting table as the tolerated `absent` case | `ede31f09531b` | 1 fail |
| P5 | report an absent charting table as an `error`, losing the distinction | `13e2850e2373` | 1 fail |
| P6 | keep the charting layer `ok` when it failed | `8420b396b546` | 2 fail |
| P7 | report on what is cached instead of forcing the layers | `56dc9c96d82c` | 3 fail |
| P8 | drop a layer from the frozen name list | `553997a5874b` | 2 fail |
| P9 | swallow the in-house projections fault again | `48f32f4544ae` | 1 fail |

**P9 survived the first sweep at 0 fail, and the response was the missing test.** The five tests
written first asserted that the layer appears in the report with a boolean `ok`, which nothing
about the third site could violate: no test drove `buildProjections` to actually throw. The sixth
test renames `player_week_usage` out from under it, which makes it throw for a reason that is a
genuine fault rather than a player having no projection — the exact distinction the bare catch
could not draw — and restores the table in a `finally`. P9 then fails. This is the same correction
shape as S6 in the snap-share table, found the same way: by running the sweep rather than trusting
the design.

P8 is the row that keeps the report honest as the file grows. A fourth layer added without a line
in `LAYER_NAMES` is a layer that can go inert with no way to ask about it, so the test asserts the
exact key set rather than the presence of the three it knows.

## Numbers

RED: 5 tests, 0 passed, 5 failed, all on the absent export. GREEN after the P9 correction: 6
tests, 6 passed, 0 failed.

Two of my own test bugs, recorded rather than quietly fixed. The first asserted `seasonTotals`
returns a Map; it returns `{ players, teamTargets, teamCarries, teamAttempts }`. The second
asserted a clean season directly after the test that inserts an unreadable row, and
`resetPreseasonCache` clears the cache, not the table — so the count correctly came back as 1. The
verdict being re-derived from the read rather than remembered from the last one is the behaviour I
wanted; the test was wrong, and it now deletes the row first and says why.

Full local check `npm run check`: exit 0 — **2,971 tests, 2,930 passed, 0 failed, 41 skipped**;
typecheck, lint and build clean; `start:smoke` passed on an isolated database (32 teams). CI is
not consulted: the Actions allowance is spent and the workflow is off.

## The five questions

**Is this well built?** One ledger, one shape per layer, a frozen list of layer names so a fourth
cannot be added unreportably, and the `absent`/`error` split expressed once rather than inferred
at each call site. The report is a separate export rather than a field bolted onto a `Map`, so no
existing caller's contract moved.

**Is this based on stats, or is it made up?** Neither — it is about whether the statistics are
there at all. That is the point: the module's numbers were already honest about *what* they
compute and silent about *whether the inputs existed*, and a median imputed for every player in
the league is not a statistic about any of them.

**How do we know?** Nine mutations, all failing, including the one that survived the first sweep
and the one that reports on a cache instead of forcing a read. Each row carries the file hash
before and after, and a pattern matching nothing or matching twice is reported as a NO-OP rather
than as evidence.

**Should this data be pointed anywhere else on the platform?** Yes, and this is the honest gap:
**nothing surfaces `preseasonLayerHealth` yet.** The draft board is served from `routes/drafts.js`,
which is not mine to edit beyond two lines, so the surface work is routed rather than done. Until
a route reads it, a fault is *askable* but not *shown* — which is better than silent, and not yet
the rule's full demand. The same question applies to whether a structural database error should
fail the board outright instead of degrading it; that is a product decision and is routed too.

**How does it unify?** It gives three differently-worded silences one vocabulary, and it is the
same vocabulary as the availability basis (`docs/tdd/availability-basis-vocabulary.tdd.md`) and
the snap-share ingest's `unmatched`/`out_of_range` counts: a closed set of states, a reason
attached to each, and a count with samples rather than a bare drop. Three places in this codebase
now answer "where did this number come from, and did its inputs exist" the same way.
