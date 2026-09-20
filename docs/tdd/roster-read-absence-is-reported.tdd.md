# TDD evidence: a failed roster read looked exactly like a league with no needs

**Change.** `claude/project-thread-5f9c3y-roster-read-hold`, RED `38dd7fb`,
GREEN `0f1fc71`, plus the comment fix `4af1a07`. Stacked on
`claude/project-thread-5f9c3y-trade-week-hold` (`eb55f1d`), which is #57's head
plus the `selfScout` week pin.

Found by the wiring map thread, confirmed here against the code.

## Defect

`rosterContext(lg)` in `server/services/trade-engine.js` ended:

```js
  } catch { /* analyzeLeague needs the same synced payload findTrades already checked for */ }
  return byRoster;   // the empty Map
```

An empty Map is the same shape a league with no needs anywhere produces, so
every downstream read degraded to absent with no signal:

- `evaluate()`'s `ctx.theirNeeds` is `undefined`, so `hurtsNeed` is always
  empty and `brokenForThem` collapses to "does it leave a hole";
- `their_window` is `null`, indistinguishable from a team we have no window on.

`evaluate`'s own docstring says the context exists so the check can see
"whether this package actually makes sense for them, **not just whether the
numbers pencil out**". With an empty map that is precisely what it falls back
to, and the offers come out reading exactly as confident as the ones where the
check had real input. CLAUDE.md names this shape: two shipped bugs where a
silent catch deleted a data layer and the page kept printing numbers.

**The tell is the sibling, and it is why this is not a design argument.**
`counterparty-pricing.js#deriveRosterNeeds` catches the *same call* and the
*same failure*, returns `null`, and its caller records
`{ source, reason: 'no roster read for this league (analyzeLeague produced none)' }`
at `:773`. One surface reports, the other hides. The house already answered;
`trade-engine.js` was the outlier.

## A third state, found while writing the test

`POST /api/trades/:leagueId/evaluate` (`routes/trades.js:934`, the Trade Lab
"check this trade" button) calls `evaluate()` with **no context at all**.
Nothing failed there — the read was never asked for.

That changes the fix. A two-state field defaulting to `null` would have that
surface start claiming a roster-fit check it never ran, which is worse than the
defect being fixed. So `roster_read_absent` defaults to the not-supplied reason
instead, and the route becomes honest without an edit. `routes/trades.js` is
another thread's file under the one-editor rule; whether it should pass the
context is theirs to decide, and has been routed to them.

## RED — `38dd7fb`

```
# tests 6   # pass 1   # fail 5
ok 1   - the mock actually reaches the engine ...
not ok 2 - a league whose roster read failed says so on every offer it prices
not ok 3 - the same shape of league says nothing is absent once the read works
not ok 4 - the absence does not silently widen what counts as plausible
not ok 5 - the wording is the one counterparty-pricing already uses
not ok 6 - an evaluation handed no context at all cannot claim a read it never had
```

Test 1 is the precondition control: it asserts the mocked `analyzeLeague`
actually throws *inside the engine*. Without it, a `mock.module` that failed to
take would leave every "absent" assertion quietly testing the happy path.

**One honest correction.** Test 6 was red in the RED commit for a harness
reason rather than the defect: the request helper sent no `content-length`, so
`express.json()` never parsed the body and the route answered "pick at least
one player on each side". Fixed in the GREEN commit, and its ability to fail is
established by injection r2 below rather than by that RED line.

## GREEN — `0f1fc71`

```
# tests 6   # pass 6   # fail 0
```

`rosterContext` returns `null` on the throw. A small `rosterReadAbsence(context,
teamCtx)` maps that to one of three reasons, every call site passes it as
`ctx.rosterReadAbsent`, and `evaluate` serves `roster_read_absent`.

## Injections — six, each verified applied

Run against the committed tree, and the harness refuses to report a result on
an empty diff. (The first attempt at this ran against an *uncommitted* fix, so
its `git checkout -- .` restore deleted the work; the fix was rebuilt and
committed before re-running. Worth recording: an injection harness that
restores by checkout is only safe on a clean tree, which this one now asserts.)

```
### r1 the original defect: return the empty Map on the throw   APPLIED 0+ 1-   # pass 4 # fail 2
### r2 report absence, but default a context-less caller to null APPLIED 1+ 2-  # pass 5 # fail 1
### r3 always report the read as present                        APPLIED 1+ 2-   # pass 3 # fail 3
### r4 always report the read as absent, whatever happened      APPLIED 1+ 2-   # pass 4 # fail 2
### r5 reword the reason so the two surfaces disagree           APPLIED 1+ 1-   # pass 3 # fail 3
### r6 stop passing the reason from the search's call sites     APPLIED 2+ 2-   # pass 4 # fail 2
```

r1 is the defect itself. r3 and r4 are the two ways the field can be present
and constant — one claims a check that never ran, the other cries absence on a
healthy league — and both are caught, which is what makes the control test earn
its place. r2 is the case the third state exists for.

## Full local check

Whole `npm run check` plus `start:smoke`, exit 0:

```
# tests 2984   # pass 2943   # fail 0   # skipped 41
Syntax checked 880 JavaScript files
built in 3.04s
Application startup smoke passed on isolated database (32 teams).
```

## The comment fix — `4af1a07`

`tradelab.js#analyzeLeague` stated the invariant "needs/surplus stay on VOR".
`needs[].gap` is VOR units; `surplus[].value` is market units (FantasyCalc),
deliberately, and the push site says so four lines later. Both consumers read
only `.position` (`trade-engine.js:180`, `counterparty-pricing.js:301`), so the
divergence is real and inert — no consumer, no bug. The comment was the defect:
the first caller to reach for a magnitude would compare points over replacement
against dollars on its authority. Comment only, no code change.

## The five questions

- **Is it well built?** It copies a shape the codebase already had rather than
  inventing one, down to the wording of the reason.
- **Stats, or made up?** Neither — this is a contract, not a number. Nothing
  here changes a projection, a price or a ranking. What changes is whether a
  verdict admits which of its inputs was missing.
- **How do we know?** Six applied mutations, all of which bite, including both
  directions of a constant field; and a precondition control proving the mock
  reaches the engine.
- **Should this data point anywhere else?** Yes. `roster_read_absent` is served
  on every deal and every evaluation, so any surface rendering a plausibility
  verdict can show it. The client half is not in this change and belongs to the
  UI thread.
- **How does it unify?** It makes `trade-engine.js` and `counterparty-pricing.js`
  report one failure in one set of words, instead of one reporting and one
  hiding. The class this belongs to — a silent catch turning a missing layer
  into a confident answer — is the same class as PR #7's `Connection error.`
  and the two bugs CLAUDE.md records.
