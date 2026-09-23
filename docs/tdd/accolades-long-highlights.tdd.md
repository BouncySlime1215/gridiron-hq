# A 4,000-character window that silently zeroed the most decorated players

RED `bb0f678` · GREEN this commit · `server/routes/accolades.js`,
`test/accolades-long-highlights.test.js`

Found by the Independent Auditor, sweeping the fixed-size-window defect class
submitted from this thread. The three instances that prompted the sweep were
all in tooling; this one is in shipped `server/` code, which is why it matters
more than any of them.

## What was wrong

```js
wikitext.match(/highlights\s*=([\s\S]{0,4000}?)(?:\n\s*\|\s*[a-zA-Z_]+\s*=|\n\}\})/i)
```

The quantifier is lazy and capped at 4,000. When the terminator — the next
infobox key, or the closing `}}` — sits further than 4,000 characters from
`highlights =`, the match does not truncate. **It fails entirely.** `block` is
null, `text` becomes `''`, and every counter below falls through to 0.

## Why this is data loss, not a miscount

The zeros are written. At `server/routes/accolades.js:130-132` the sync upserts
`hi?.pro_bowls ?? 0`, `hi?.first_team_all_pro ?? 0`, `hi?.super_bowls ?? 0` and
`hi?.major_awards ?? null` directly into the table, and `wikiOk++` has already
counted the player as wiki-verified, because the object exists and is truthy.
The single trace is the `source` column reading `espn` instead of
`wikipedia+espn`.

So the run reports success, `wiki_verified` goes up, the table gains a row
stating that a decorated career has no Pro Bowls, and nothing goes red. That is
the failure CLAUDE.md names in its own words: a layer goes inert and the surface
keeps printing numbers as if nothing had happened.

**And the bias runs the wrong way.** The window is exceeded precisely when the
highlights block is long, and it is long for the players with the most
accolades. The defect cannot fire on a player with nothing to report; it fires
only on the ones the feature exists for.

## The fix

Not a bigger cap — that moves the cliff to the next unlucky article. What
bounds the block is its terminator, so the code finds that and lets the block be
as long as it is:

```js
const start = wikitext.match(/highlights\s*=/i);
const rest = start ? wikitext.slice(start.index + start[0].length) : null;
const end = rest === null ? null : rest.match(/\n\s*\|\s*[a-zA-Z_]+\s*=|\n\}\}/);
const block = end ? rest.slice(0, end.index) : null;
```

Two things deliberately preserved:

- **The terminator is still required.** A block with neither a following key nor
  a closing `}}` is a malformed infobox; reading to end-of-article would count
  every award mentioned anywhere in the prose. Unbounded is not the same as
  unterminated.
- **`found` still distinguishes absent from empty.** It became
  `block !== null`, because `block` is now the block's *text* and an empty block
  is falsy where the match object was truthy. A player with no accolades and an
  article with no highlights field must not collapse into the same answer — the
  caller uses exactly that difference to label the row.

## Defect injection

Baseline (GREEN) `server/routes/accolades.js`
sha256 `17d0557e9cc15a04b93d9b7d5ded5bcff451bf980b8b89a59ca84ae8f98150f8`,
6/6 in `test/accolades-long-highlights.test.js`.

| # | mutation | sha256 after edit | result | killed by (title) |
|---|---|---|---|---|
| A1 | restore the cap — scan only `rest.slice(0, 4000)` | `33445c02…4eb18` | **4 pass / 2 fail** | `the block is found even when it runs past four thousand characters`, `a decorated player keeps every accolade, not zero` |
| A2 | drop the terminator — `const block = rest` | `3c163bfa…29151a` | **5 pass / 1 fail** | `the block still stops at the next infobox key` |
| A3 | revert `found` to truthiness — `!!block` | `2a088e67…d8d32` | **5 pass / 1 fail** | `an empty highlights block is found, and is not the same as missing` |
| A4 | control: add a comment line above the function | `dd54dbb2…1bef29` | 6 pass | — (no-op by construction) |

A1 is the defect itself. A2 and A3 are the two ways the *fix* could be wrong —
scanning without stopping, and losing the absent/empty distinction — and each is
caught by a test written for it rather than by luck. A4's checksum moves while
its result does not, so no green row here is the harness failing to apply an
edit.

## A SECOND defect in the same function, fixed separately

While building the fixture: `[[Super Bowl]] champion`, which is the form English
Wikipedia actually uses, counts as **zero**. The counter allows an opening `[[`
(`\[?\[?`) but not the closing `]]` before "champion". Measured:

| wikitext | super_bowls |
|---|---|
| `7× [[Super Bowl]] champion` | **0** |
| `7× Super Bowl champion` | 7 |
| `7× [[Super Bowl champion]]` | 7 |
| `[[Super Bowl]] champion` | **0** |

It is a different defect with the same user-visible result, so it is fixed in
its own commit with its own test rather than folded in here. The fixture in this
file deliberately uses the working form, so that these six tests measure the
window and nothing else.

## The five questions

- **Well built?** The scan replaces a guess with the thing that actually bounds
  the block. Six tests: two for the defect, three guarding the fix against its
  own failure modes, one regression.
- **Stats or made up?** Measured. The `]]` table above is real output, and the
  first test asserts the fixture exceeds 4,000 characters before trusting it.
- **How do we know?** The injection table, every mutation killed by a named
  test.
- **Pointed anywhere else on the platform?** Yes — this is the fixed-window
  class, now four instances in `server/` found by the Auditor against three in
  tooling found here. The class sweep is the Auditor's.
- **How does it unify?** Same lesson as `bodyRange` and `moduleEdges`: a fixed
  window is a guess about the data, and it is always wrong at the tail — which
  is where the interesting records live.
