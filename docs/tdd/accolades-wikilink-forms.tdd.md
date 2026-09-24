# `[[Super Bowl]] champion` counted as zero championships

RED `61b442d` · GREEN this commit · `server/routes/accolades.js`,
`test/accolades-wikilink-forms.test.js`

Found while building the fixture for the 4,000-character window fix
(`72da8f5`). Same user-visible result — a champion recorded with no rings,
written to the table as a successful sync — but a different cause, so it is its
own commit, its own test file and its own evidence.

## What was wrong

```js
num(/(\d+)×\s*\[?\[?Super Bowl champion/i)
  || (/Super Bowl\s*(champion|[IVXL]+\s*champion)/i.test(text) ? 1 : 0)
```

Both patterns allow an **opening** `[[` and neither allows the **closing**
`]]`. English Wikipedia writes the award as a wikilink with the qualifying word
outside it, so the form that actually appears on NFL infoboxes matched nothing.

Measured on the real function before the change:

| wikitext | super_bowls |
|---|---|
| `7× [[Super Bowl]] champion` | **0** |
| `7× Super Bowl champion` | 7 |
| `7× [[Super Bowl champion]]` | 7 |
| `[[Super Bowl]] champion` | **0** |
| `15× [[Pro Bowl]]` | (Pro Bowls correct: 15) |

## Why only Super Bowls

Worth recording, because "the brackets break the regex" would predict every
counter being broken and they are not. `Pro Bowl` and `All-Pro` are matched as
the wikilink **target** — `\[?\[?Pro Bowl` — where the closing brackets fall
*after* the matched text and never interfere. Super Bowls are the only accolade
whose label needs a word sitting **outside** the link, so they are the only one
where a `]]` lands in the middle of the pattern.

## The fix

`(?:\]\])?` in both patterns, and nothing else:

```js
num(/(\d+)×\s*\[?\[?Super Bowl(?:\]\])?\s*champion/i)
  || (/\[?\[?Super Bowl(?:\]\])?\s*(champion|[IVXL]+\s*champion)/i.test(text) ? 1 : 0)
```

`champion` is still required immediately after, which is what keeps the
loosening honest: an appearance, a loss, and a `[[Super Bowl MVP]]` line all
still count zero.

## Defect injection

Baseline (GREEN) `server/routes/accolades.js`
sha256 `56b2f0df50ed35d454717bed3a23a5e9efc7a6c840e7b47cfcb8bf09ad81a4d8`,
7/7 in `test/accolades-wikilink-forms.test.js` (and 6/6 still in
`test/accolades-long-highlights.test.js`).

| # | mutation | sha256 after edit | result | killed by (title) |
|---|---|---|---|---|
| B1 | revert — drop the closing-bracket tolerance | `00e6545a…59c1a` | **5 pass / 2 fail** | `a wikilinked Super Bowl with the word champion outside it counts`, `a real-shaped entry naming the specific game still counts` |
| B2 | over-loosen — any word after the link, not just `champion` | `4971658a…45db6` | **5 pass / 2 fail** | `an appearance is not a championship`, `a Super Bowl MVP award is not itself a championship count` |
| B3 | control: a comment appended to an unrelated line | `e6760b44…baa9b` | 7 pass | — (no-op by construction) |

B1 and B2 are the two directions this change could be wrong — too tight, and too
loose — and **they are killed by disjoint sets of tests**. That is the property
worth having: the tests that prove the fix works are not the tests that prove it
did not over-reach, so satisfying one set cannot accidentally satisfy the other.

An earlier attempt at B2 was written carelessly and broke the numeric capture
instead of the intended condition, so it failed the counting tests rather than
the guards. That proves nothing about over-matching, so it was redone properly
rather than recorded as a pass. A mutation that does not mutate the thing you
meant is not evidence.

B3's checksum differs from the baseline while its result does not, so no green
row here is the harness failing to apply an edit.

## The five questions

- **Well built?** Two optional characters, in the two places that needed them,
  with the requirement that actually discriminates a win left intact.
- **Stats or made up?** Measured — the table above is real output of the real
  function, not a description of what it ought to do.
- **How do we know?** The injection table, with too-tight and too-loose each
  killed by its own disjoint set of tests.
- **Pointed anywhere else on the platform?** The same wikitext-shape question
  applies to any other counter that needs a word outside a link. None of the
  current ones do, checked: the rest match link targets.
- **How does it unify?** With the window fix beside it: both write a confident
  zero into a table from a pattern that simply failed to match, and neither has
  any way to say "I did not understand this input" as distinct from "there is
  nothing here".
