# Adopting the basis chip — TDD evidence

Retroactive RED by mutation, the shape set by `docs/tdd/week2-numbers.tdd.md`.

## What changed

**Six**, not four. Four were named when this started; grepping for the strings
the chip replaced found the waiver board's own `(assumed)` suffix
(`WaiverWire.tsx:311`) and Trade Lab's pair of hand-rolled pills
(`TradeLab.tsx:130-138`). Nobody knew there were six, and that is exactly how
six vocabularies happen.

Six pages answered "where did this number come from" six different ways.
They now use one component. The interesting part is not the deduplication — it
is what each of the four was getting wrong on its own.

**Start/Sit** put the chance to play and its provenance in a single grey pill:
`77% to play (assumed)`. Those are two different facts. A low chance to play is
about the player and is a reason to think about sitting him; an assumed basis is
a gap on our side and is not. The same grey said both, and a reader could not
tell which they were looking at. They are now a coloured percentage and a chip
beside it.

**News** wrote `(assumed)` after the number and **nothing at all** when the
number was measured. Three of the four sites did this. A page that only mentions
provenance when something is degraded is indistinguishable from a page that
forgot to check — which is the argument `Lineup.tsx` had already made correctly
in its own comment, for its page-level line, and then did not apply to its rows.

**The odds sentence** coloured an assumed playoff bracket `text-amber-700`. That
is the colour the rest of this app uses for something wrong with the manager's
team. A bracket we had to assume is a gap on our side, and it now says so in the
basis ramp, which exists precisely so those two never share a colour. The
server's sentence is still rendered verbatim — a page that paraphrases what it
was told is a second place for the claim to drift.

**The Settings freshness card** listed which seasons are loaded and never said,
in one glance, whether the season being played is among them. That is the live
failure mode this whole card was written for: the model falls back to the most
recent season it has and says nothing, so the app looks completely healthy while
projecting this year off last year's football. Each of the two season-dependent
rows now carries `measured` or `missing` for the current season, taken from the
league rather than the calendar.

## The mutations

Each reverts one change, runs `test/basis-chip-adopted.test.js`, and is
restored. Control after restoring: **6 pass, 0 fail**.

| # | Mutation | Result |
|---|---|---|
| q1 | News drops the chip and hand-writes `(assumed)` again | **4 pass, 2 fail** |
| q2 | Start/Sit greys the percentage by its basis again | **5 pass, 1 fail** |
| q3 | The odds bracket goes back to `text-amber-700` | **5 pass, 1 fail** |
| q4 | The usage row stops saying whether this season is loaded | **5 pass, 1 fail** |
| q5 | The game-lines row loses its current-season check | **5 pass, 1 fail** |

q1 fails two tests rather than one, and that is the point of the second test in
this file. This does not fail by someone deleting the shared component — nobody
does that. It fails by someone adding one page's own suffix *next to* the chip
for one special case, and a month later there are two vocabularies again. So the
exact strings the chip replaced are asserted absent, not just the chip asserted
present.

**Trade Lab** used `bg-amber-50` / `text-amber-900` for its assumed pill — the
same misuse of the warning colour as the odds bracket, and under it every deal
on the page was being ranked.

## TWO TESTS WERE CHANGED, AND WHY

`test/availability-honest-degradation.test.js` went red on this change, at
"the row that was priced by a chance to play shows it" and "a Start/Sit row is
marked by the model that priced THAT player". CLAUDE.md says to fix the
implementation, not the test, unless the test is wrong. These were wrong about
their means and right about their intent: they asserted the **literal strings**
`(assumed)` and `unfitted_position.*not modelled` inside one file, which is the
wording of one implementation rather than the guarantee that a row says where
its number came from.

The guarantee is preserved and is now stronger. The assertions follow the path
to the reader instead of the text in one file: Start/Sit maps the server's value
through `AVAILABILITY_BASIS`, the chip gives `unfitted_position` its own tier
separate from `assumed`, and that tier's label is "Not modelled". Three
mutations confirm the re-pointed assertions still bite — removing the row's chip
fails **two** tests where the old string assertion failed one, folding
`unfitted_position` into `assumed` fails one, and renaming the not-modelled tier
fails one. Control 11 pass, 0 fail.

The chip is also strictly more than the strings were: it renders in the
**measured** state, where three of the six surfaces rendered nothing at all, so
a reader could not distinguish a checked page from one that forgot to check.

## Honest limit

`node:test`, no DOM, source text only. A page that renders the chip and also
writes its own suffix forty lines away passes the first test and fails the
second, which is why the second exists — but a page that renders the chip and
then visually hides it would pass both.

## Commands

```
GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr-XXXXXX).sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/basis-chip-adopted.test.js
```
