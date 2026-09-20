# TDD evidence (retroactive, test-only): the week My Team reads was unpinned

**Change.** `claude/project-thread-5f9c3y-trade-week-hold`, one commit on top of
`7c27517` (PR #57's head). No server code changes — this adds the pin that the
served-field deletion sweep found missing.

## Defect

`selfScout` (`server/services/trade-engine.js:2591` on this base) serves

```js
    // The live NFL week, so a caller (the My Team ceiling-lineup tab, in
    // particular) doesn't have to hardcode week 1 for the whole season.
    week: tradeWeekContext(lg).week,
```

and the caller that comment names reads it as

```tsx
{tab === 'ceiling' && active && <CeilingLineup leagueId={active.id} teamId={myTeamId} week={scout?.week ?? 1} />}
```

— `client/src/pages/MyTeam.tsx:233`.

The `?? 1` is the entire reason the field exists, and it is also what makes the
field's disappearance invisible. Delete `week` from the payload and nothing
errors, nothing blanks: the ceiling tab renders week 1, in September and in
December alike, with a full lineup and real-looking numbers. That is the exact
failure the docstring on `leagueCurrentWeek` was written about — "Never a
hard-coded 1 — that is how the app spent two weeks showing week-1 lineups."

**Nothing pinned it.** The served-field deletion sweep (2026-09-20, run against
PR #60, which stacks on this branch) deleted the field and the whole suite
stayed green. `test/trade-week-context-league.test.js` exists and passes on
both sides, because it tests the week `tradeWeekContext` *computes*; the gap is
whether that answer is handed to the client at all. A unit test on the producer
cannot see a defect in the consumer's contract — which is the general shape of
this finding, not a detail of this field.

## RED — by mutation, four injections, each verified applied

A mutation is evidence only if it was applied, so each run prints its diffstat
and refuses to report a result on an empty diff
(`scratchpad/inj-week.sh`, the same refuse-on-empty-diff harness as `inject2.sh`; `scratchpad/` is gitignored, so the script is session scratch and the transcript below is the record).

```
### w1 delete the served field entirely (the sweep's own mutation)  APPLIED 0+ 1-
# tests 5   # pass 1   # fail 4
### w2 serve it, but hardcoded to 1 (the client fallback, moved server-side)  APPLIED 1+ 1-
# tests 5   # pass 1   # fail 4
### w3 revert to the zero-argument form (one week for the whole process)  APPLIED 1+ 1-
# tests 5   # pass 1   # fail 4
### w4 serve the machine week instead of the league's  APPLIED 1+ 1-
# tests 5   # pass 1   # fail 4
```

w1 is the sweep's own deletion. w2 and w4 are the two ways a field can be
present and still wrong — the client's fallback moved server-side, and the
machine's `NFL_WEEK` standing in for the league's matchup period. w3 is the
pre-#57 form, which served one week per process and let a second league inherit
the first's.

Under w1 exactly one test still passes: test 3 asserts the week is *not* 1, and
a deleted field is `undefined`, which is not 1. It is a control for the other
direction and is not the test carrying that injection; tests 1, 2, 4 and 5
catch it.

## GREEN

```
test/self-scout-serves-the-week.test.js
# tests 5   # pass 5   # fail 0
```

Full local check on this branch, whole `npm run check` plus `start:smoke`:

```
# tests 2978   # pass 2937   # fail 0   # skipped 41
Syntax checked 879 JavaScript files
built in 3.39s
Application startup smoke passed on isolated database (32 teams).
```

## The five questions

- **Is it well built?** It observes the field where the client observes it — on
  the JSON of `GET /api/trades/:leagueId/scout` — rather than on the function's
  return value, because the contract that broke is the served one.
- **Stats, or made up?** Neither: this pins a contract, not a number. The weeks
  in the fixtures (4, 6, 9, 11) are arbitrary on purpose, and `NFL_WEEK` is set
  to 2 so no fixture can agree with a fallback by luck.
- **How do we know?** Four applied mutations, each turning four of five tests
  red; the sweep's own deletion is the first of them.
- **Should this data point anywhere else?** Yes, and that is the open half:
  every other served field a client reads is unpinned by default. This fixes
  one row of the sweep, not the class.
- **How does it unify?** The week on this payload is the same
  `tradeWeekContext(lg)` #57 gave `lineup-brain` and `lineup-posture` through
  #60. Pinning it here means the three surfaces that price a Sunday cannot
  drift to different weeks without a test saying so.
