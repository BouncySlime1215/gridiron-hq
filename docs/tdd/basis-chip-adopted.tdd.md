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

---

## Mutation run at the stack tip

Re-run against **one tree**, the tip of this stack at `af7f01a`, so every row
below is measured on the same code rather than on the tree each commit had when
it was written. Each entry records the mutated file's SHA-256 before and after,
which is what proves the mutation was APPLIED: a pattern that does not match
leaves the file unchanged, and the run is then the baseline wearing a
mutation's name. Each entry names the **test title** that turned red, not the
rule it was meant to check — a mutation that lands and kills a different test is
unfinished, not a result. And each quotes the **exact before and after text**,
not a description of the edit, so the mutation can be reproduced from this file
rather than taken on trust.

Files mutated: `client/src/components/DataBehindNumbers.tsx`, `client/src/components/OddsBasis.tsx`, `client/src/components/lineup/WaiverWire.tsx`, `client/src/pages/Lineup.tsx`, `client/src/pages/News.tsx`, `client/src/pages/TradeLab.tsx`.

**T1 Start/Sit stops rendering the shared chip** (`client/src/pages/Lineup.tsx`) — APPLIED `848aedd218a3` → `6c3f56d58f77` — **RED**, 1 failing · killed by *all six provenance renderings now use the one component*

```diff
-<BasisChip
+<BasisChipX
```

**T1 News stops rendering the shared chip** (`client/src/pages/News.tsx`) — APPLIED `6823539e5c08` → `fe684f24ca41` — **RED**, 1 failing · killed by *all six provenance renderings now use the one component*

```diff
-<BasisChip
+<BasisChipX
```

**T2 the waiver board hand-writes "(assumed)" again** (`client/src/components/lineup/WaiverWire.tsx`) — APPLIED `afabf1bf27df` → `7ac1bb31af88` — **RED**, 1 failing · killed by *the ad-hoc suffixes the chip replaced have not come back*

```diff
-<BasisChip
+'(assumed)'}{null}<BasisChip
```

**T3 Start/Sit decides its own wording from the basis** (`client/src/pages/Lineup.tsx`) — APPLIED `848aedd218a3` → `1631498237e8` — **RED**, 1 failing · killed by *the server vocabulary is mapped, never compared to inline*

```diff
-AVAILABILITY_BASIS[
+// const measured = basis === 'role'
+AVAILABILITY_BASIS[
```

**T4 the percentage is greyed by its basis again** (`client/src/pages/Lineup.tsx`) — APPLIED `848aedd218a3` → `c7e4c4ca2192` — **RED**, 1 failing · killed by *a low chance to play and an assumed basis are no longer the same grey*

```diff
-% to play
+% to play{measured ? 1 : 0}
```

**T4 the low-chance colour is removed** (`client/src/pages/Lineup.tsx`) — APPLIED `848aedd218a3` → `b66e2d2bb055` — **RED**, 1 failing · killed by *a low chance to play and an assumed basis are no longer the same grey*

```diff
-play < 75 ? 'bg-amber-50
+play < 0 ? 'bg-amber-50
```

**T5 Trade Lab stops mapping the server basis** (`client/src/pages/TradeLab.tsx`) — APPLIED `7fe62418f0da` → `37916d759c93` — **RED**, 1 failing · killed by *Trade Lab no longer uses the warning colour for a gap on our side*

```diff
-AVAILABILITY_BASIS[rosters.model_context.availability_basis.basis]
+'assumed'
```

**T6 the odds bracket loses its chip** (`client/src/components/OddsBasis.tsx`) — APPLIED `503545e44d69` → `ad78b085837b` — **RED**, 1 failing · killed by *the odds bracket says assumed in the basis ramp, not in the warning colour*

```diff
-basis={assumed ? 'assumed' : 'measured'}
+basis='measured'
```

**T6 the page rewords the server bracket sentence** (`client/src/components/OddsBasis.tsx`) — APPLIED `503545e44d69` → `1dcf2dba735e` — **RED**, 1 failing · killed by *the odds bracket says assumed in the basis ramp, not in the warning colour*

```diff
-<span>{bracket}</span>
+<span>{bracket.replace('assumed', 'estimated')}</span>
```

**T7 the usage row stops saying whether this season is loaded** (`client/src/components/DataBehindNumbers.tsx`) — APPLIED `cbe86bf5faf5` → `b2dbd24bb7d5` — **RED**, 1 failing · killed by *the freshness card says whether THIS season is in each row*

```diff
-basis={missingThisSeason ? 'missing' : 'measured'}
+basis='measured'
```

**T7 the game-lines row loses its chip** (`client/src/components/DataBehindNumbers.tsx`) — APPLIED `cbe86bf5faf5` → `8ccf1ffd91c7` — **RED**, 1 failing · killed by *the freshness card says whether THIS season is in each row*

```diff
-basis={linesThisSeason ? 'measured' : 'missing'}
+basis='measured'
```

**T7 the freshness card takes the season from the calendar** (`client/src/components/DataBehindNumbers.tsx`) — APPLIED `cbe86bf5faf5` → `7c87ea6b030a` — **RED**, 1 failing · killed by *the freshness card says whether THIS season is in each row*

```diff
-const season = active?.season ?? null
+const season = new Date().getFullYear()
```

**NO-OP CONTROL: a comment word in the odds bracket** (`client/src/components/OddsBasis.tsx`) — APPLIED `503545e44d69` → `41a8ac918739` — **green — survived, as intended**

```diff
- * 
+ *  
```

12 mutations applied and red, 1 applied and green. The green
row is the deliberate no-op control — an edit that is real (the SHA changes) but
touches nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**Two mutations survived the first run, and the assertion was wrong both times.**
Renaming the rendered element to `<BasisChipX>` on Start/Sit and on News left
the suite green: the check was `assert.match(src, /<BasisChip/)`, and that
pattern matches any tag with the same prefix. A page could rename the component
to something that is not the shared chip and still pass the test whose whole job
is to prove it renders the shared chip. The assertion now requires the tag to
end — `/<BasisChip[\s/>]/` — and both mutations are red above. Reading the test
did not find this; the mutation run did.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database. The tree is `af7f01a` plus the working tree of
the commit this section lands in; the source was restored and verified clean
after the run.
