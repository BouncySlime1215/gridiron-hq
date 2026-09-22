# A stat that does not describe a position says so, instead of blaming the data

RED `8d1d581` · GREEN `ccd3c5d` · branch
`claude/project-thread-xiezr0-position-applicability`, cut from `c8c75e4`
(PR #86's head), 2026-09-22.

## What a reader saw, and what was wrong with it

Open a quarterback's page and the advanced-stats block said this, four times:

> **Target share** — The usage rows on file for this season do not carry this column.
> **Weighted opportunity (WOPR)** — The usage rows on file for this season do not carry this column.
> **Yards per route run** — No routes-run data exists on this platform. Route counts are not in the weekly files this page is built from, and the sources that publish them are paid.
> **Route participation** — (the same sentence again)

Every one of those is false, and two of them are false in a way a reader can
act on.

The first two blame the file. The file is not at fault:
`server/services/nflverse.js:218` carries `target_share` and `wopr` in
`USAGE_COLS`, and `numAt` (`nflverse.js:58-64`) turns nflverse's `NA` or blank
into SQL `null`. The column is there and the ingest writes it. A quarterback's
rows are null because a passer is not targeted.

The last two are worse. Telling a quarterback that the sources publishing route
participation are paid says he would have route participation if somebody
bought it. He would not. Quarterbacks do not run pass routes. A reader who
believed that sentence would go looking for a data source to fix a problem that
does not exist.

After the change, the same page reads:

> **Not statistics about a QB**
> **Target share** — Not a statistic about a QB: target share counts the passes thrown at a player. This is a fact about the position, not a gap in the data.
> **Yards per route run** — Not a statistic about a QB: running pass routes is not part of the job. This is a fact about the position, not a gap in the data.

under its own heading, separate from the things that genuinely were not
measured.

## Why this is the third instance of one bug, not a new one

This branch keeps finding the same defect wearing different clothes.

| where | the two things that were collapsed | what split them |
|---|---|---|
| freshness registry | "the table holds current rows" / "I could not run the check" | `unknown` as a fourth status |
| this module, first pass | "the rate is zero" / "there is no denominator" | a denominator check before the division |
| this module, now | "nobody measured it" / "it is not about this position" | `unavailable_kind` |

Each time the honest answer needed its own word, and each time the absence of
that word produced a sentence that was confident and wrong. The general rule is
the one `routes/trades.js` and PR #111 landed on independently: **an absence has
to say which absence it is.**

## The design, and the three decisions inside it

**A set, not an exception.** `RECEIVING_POSITIONS` is `RB, FB, HB, WR, TE`.
Writing the rule as "not a quarterback" would have been shorter and would have
quietly put kickers, defences and every unlisted position on the wrong side of
it. Sweep row P5 exists because the first draft of the sentence hardcoded `QB`
and a kicker was handed a quarterback's explanation.

**Three answers, and the third is the point.** `appliesToPosition` returns
`true`, `false` or `null`. `null` means we do not know the position —
`players.position` is `TEXT NOT NULL` (`core-and-fantasy.js:89`), so unknown
arrives as a blank string, and a player with no row at all reaches the function
as `null`. Neither may be ruled on. Answering "not applicable" to a player whose
position we do not know would be a guess presented as a fact, which is the same
mistake this change removes, in a third costume. Two tests and sweep row P4 pin
it.

**Applicability is asked before the data.** A quarterback who never played has
no target share for exactly the reason a quarterback with twelve weeks has
none. "No usage rows on file" would be a true sentence about him and still the
wrong answer, because it implies rows would have produced a number. This
ordering is the one the sweep caught (P12, below).

**Red-zone share is deliberately not gated.** A quarterback takes red-zone
carries, so the position does not rule the stat out. What rules it out is that
`nfl_play_by_play` carries field position and no player column
(`nfl-a-to-m.js:306`), so a red-zone touch cannot be attributed to anybody
without parsing prose. Gating it on position would have been a true-sounding
sentence for the wrong reason — and it would have gone on being wrong after the
attribution problem was solved. Sweep row P11 is there to keep somebody from
"tidying" it into the positional group.

**The page groups on a field, never on the sentence.** Each absence carries
`unavailable_kind`: `not_applicable` or `not_measured`. The panel filters on
that. Grouping by running a regex over the prose is how a reworded sentence
silently moves a row into the wrong list, and it is exactly what sweep row P14
did.

## How do we know

`npm run check` — typecheck, lint, the whole suite, build and `start:smoke` —
on the tree this branch head points at. Figures and the guard either side of the
run are in **The check** below.

## Mutation sweep

`python3 docs/tdd/sweeps/mutation-runner.py
docs/tdd/sweeps/player-advanced-stats-position.mutations.json <out>`

17 rows: 14 mutations, all killed; 3 controls, all behaving as designed. Each
row's file hash is recorded before, after, and again after the restore, and a
row is only counted as applied when its anchor matches exactly once.

| | mutation | result |
|---|---|---|
| P1 | applicability is never asked, so a QB is blamed on the data file | KILLED ×5 |
| P2 | every position is receiving-eligible, so nothing is ever inapplicable | KILLED ×5 |
| P3 | no position is receiving-eligible, so a back loses his target share | KILLED ×3 |
| P4 | a blank position is ruled inapplicable rather than left undecided | KILLED ×2 |
| P5 | the sentence names a position it was not given | KILLED ×2 |
| P6 | the sentence stops saying it is not a gap in the data | KILLED ×1 |
| P7 | the positional absence is labelled as an ordinary missing measurement | KILLED ×2 |
| P8 | every absence is labelled positional, so the kind means nothing | KILLED ×1 |
| P9 | a measured stat is stamped with a kind of absence | KILLED ×1 |
| P10 | the routes stats go back to the paid-source sentence for everyone | KILLED ×5 |
| P11 | red-zone share is gated on position too | KILLED ×1 |
| P12 | applicability is asked after the data | KILLED ×1 |
| P13 | the panel pools both absences under one heading | KILLED ×1 |
| P14 | the panel groups by reading the sentence instead of the label | KILLED ×1 |
| C1 | control: a comment reworded, nothing behavioural | SURVIVED, as designed |
| C2 | control: an anchor that does not exist | NOT APPLIED, anchor ×0 |
| C3 | control: an anchor that matches more than once | NOT APPLIED, anchor ×4 |

`restored; unrestored rows: none`.

C1 proves the suite is not failing on everything that moves. C2 and C3 prove the
runner reports a row it could not apply rather than counting it as evidence —
C3 with a real four-site anchor, so the count check is exercised and not just
the zero case.

### The three that survived the first pass

All three were the same failure, and it is the failure this suite has now hit
four times: **an assertion on a word, or on a constant compared to itself, is
not an assertion on the behaviour.**

**P12 — applicability moved below the no-rows check, and nothing noticed.** The
"same sentence, busy or idle" test compared a quarterback with two weeks of rows
against one with a single empty week. Both have rows, so `noUsage` was false for
both and the reordering could not be observed. Fixed by adding a quarterback
with no usage rows at all, which is the only fixture that can see the order.

**P13 — the positional list replaced with a literal `[]`.** The test asserted
that `inapplicable.map(` appeared in the panel and that the string
`not_applicable` appeared somewhere. Both survived: the `.map(` call was still
there, mapping over an empty array, and the word was still in the TypeScript
interface. Every positional row vanished from the page and the test was happy.

**P14 — grouping by regex over the sentence.** Same shape. Every word the test
looked for was still present; only the field the grouping read had changed.

P13 and P14 are now anchored on the two filter expressions themselves, and a
third assertion forbids testing the sentence. This is the same fix the freshness
banner needed for its M9 row, and the same one the routes reason needed for A4.
The lesson is cheap to write down and apparently expensive to remember: when a
test reads source text, anchor it on the expression that decides the behaviour,
not on the vocabulary that surrounds it.

## The five questions

**Is it well built?** The rule is a set membership and a three-valued answer,
which is about as small as this can be. The weakest part is that the positional
vocabulary now lives in two places — `RECEIVING_POSITIONS` here and the various
`SCORED` sets scattered through `waiver-brain.js`, `week-postmortem.js`,
`ceiling-lineup.js` and others. They are not the same set and should not be
merged (those are fantasy-scoring sets, this is a "can be thrown to" set), but
somebody will eventually try. The doc comment on the export says which question
it answers, so the next reader has a reason not to.

**Are these statistics or are they made up?** Neither, and that is the point. No
number changes and no number is added. What changes is the sentence attached to
the numbers that do not exist. Every stat that had a value before has the same
value now, and the two existing suites covering this module pass unchanged.

**How do we know?** The defect was confirmed at the ingest, not inferred from
the page: `USAGE_COLS` at `nflverse.js:218` carries both columns and `numAt` at
`:58-64` writes null for `NA`, so the "file does not carry this column" sentence
was demonstrably false rather than merely suspicious. RED `8d1d581` failed 7 of
14 with 7 controls green; GREEN `ccd3c5d` passes 14 of 14; the sweep above
killed all 14 mutations after three real holes were closed.

**Is it pointed anywhere else?** Yes, twice. First, every other surface that
reports a stat it cannot compute has the same question to answer, and most of
them currently have one absence where they need two. Second, and more general:
any place a page groups rows by matching on prose rather than on a field. P14 is
a worked example of why that fails silently.

**How does it unify?** One rule, the same one the freshness registry's `unknown`
status and PR #111's archetype state land on independently: an absence has to
say which absence it is, and it has to say so from a field, not from a sentence.
