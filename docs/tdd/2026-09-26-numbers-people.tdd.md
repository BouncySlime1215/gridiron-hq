# NUMBERS-PEOPLE: Claude's and Jev's reads side by side (agree / differ / same call, different reasons)

Nick's ask: "a Numbers and People tab: each model's thoughts right now, and their agreements,
differences and sames, for current and going forward." Corrections during the build (Nick, via
the coordinator): the lanes are **Claude** (numbers alone) and **Claude -> Jev** (Claude's read fed
to Jev, Jev leads with its own people take); the reads are ONE shared component used in the Trades
tab and inline in Coach answers.

## What is pinned (tests)

| Test file | Pins |
|---|---|
| `test/numbers-people.test.js` | verdicts (differ / agree / same_but / no_people_read); Claude once per run, Jev once per item with a stored signal and fed Claude's read; caching (no call inside the 6 h window; plan change and Refresh run); history kept by week; no chat text or names in any prompt or stored row; a why stating a number is withheld; spend in ai_usage; flag off; budget used up -> 'budget' run, last reads + notice, no error; scheduler job registered off-thread; thread focus is ids only; a Coach answer about an item with a read carries it (and stores it); jevLane state, answer parsing, not-configured and failure skips |
| `test/numbers-people-scoreboard.test.js` | only DIFFER reads scored, last per item per week; trade outcomes (accepted / declined / expired, offered after the read) and points outcomes (ppg after vs before, >= 2 games); honest n below MIN_N = 5 |
| `test/numbers-people-ui.test.js` | the tab rendered and clicked: summary line, DIFFER first and highlighted, Claude / Jev columns, "chat read (ungraded)", verdict badges, scoreboard thin vs scored, timeline, Refresh with the thinking animation, budget notice without an error, Ask Coach sets the focus then opens Coach, fold after four cards, primitives only |
| `test/numbers-people-coach.test.js` | the same NumbersPeopleCard, compact, inside a Coach answer; Details expands; nothing extra without a read; one copy of the card |

## Red / green

The unit was written against its tests in one pass (no separate RED commit). The tests were shown
to bite by mutation before commit: renaming the summary text ("Agree on" -> "Agreed on") fails 2 of
the UI tests; the stored-row chat-text check failed on its first draft (it matched JSON's own quotes)
and was fixed to walk string values.

## Measured (dev copy of the live DB, real calls, 2026-09-25 local)

See the PR body.
