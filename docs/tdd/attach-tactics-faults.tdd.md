# A crashed read arrived on the card as a finding about Nick (2026-09-22)

`trade-engine.js#attachTactics` wrapped all three of its reads in bare catches,
six consecutive lines:

```js
try { timing = timingRead(...); } catch { timing = new Map(); }
try { climate = vetoClimate(...); } catch { climate = null; }
try { self = selfRead(...); }      catch { self = null; }
```

Each substitutes the one state the data cannot be told apart from, and each of
those states is a sentence the surface then states as fact:

| read | what a crash printed |
|---|---|
| `self` | "you have never made this manager an offer, and the league has nothing on you here" |
| `timing` | "nothing captured about when this manager answers, **so there is no reason to wait**" |
| `climate` | "this league has never voted against a package" |

### Why this is one defect and not three

The allocation named `:1843` — the `self` line. The other two are the same
mistake in the same function within six lines of it, and the `timing` one is the
worst of the three: its sentence does not stop at reporting an absence, it ends
in advice. *There is no reason to wait* is an instruction to send the offer now,
and a read that threw had earned no opinion about that. Fixing one of three
would have left the loudest one shipping.

### Where the fix goes, and why not in the catch

The vocabulary belongs with the reads, not with their caller. `readFault(kind)`
lives in `trade-tactics.js` beside `timingRead`, `vetoClimate` and the consumers,
and returns the state none of those three can report about themselves — *the
call did not complete* — because at that moment they are not running.

`available: false` on the fault object is load-bearing rather than decorative:
`how_nick_looks` already branches on exactly that field, so the self case needed
no change at the consumer at all. The fault simply arrives carrying a sentence
that is true. The other two consumers gained one guard each, and both are placed
**before** the existing no-data branch, because in each case that branch is the
one making the false claim.

The catches themselves stay. One unreadable input must not take down a whole
trade search — that judgement was right. What was wrong was what they handed on.

### RED -> GREEN

| | commit | result |
|---|---|---|
| RED | `119a88e` | 39 tests, 35 pass, **4 fail** — G9a, G9b, G9c, G9d |
| GREEN | see below | 39 tests, **39 pass**, 0 fail |

`G9c`'s first draft looked the note up on the wrong field and failed for that
reason rather than for the rule under test. It was corrected and the RED commit
amended before any push, and the corrected file was then re-run against RED's
source in a detached worktree: still 4 of 4 failing, for the right reasons. A
RED that fails for a neighbouring reason is not a RED, and this branch has
already had one such row corrected on `#100`.

`G9d` is the row that would catch a lazy fix: three reads must produce three
*distinct* sentences, so a single shared "something went wrong" cannot pass.

### What this is an instance of

The same rule as the rest of the lineage, at the last hop before the surface.
`#94` and `#100` taught these three reads to name their own absences. This is
the one place that vocabulary was thrown away again — by the caller, one line
before it reached the card.

## The five questions

**Is it well built?** The shape is right: the vocabulary sits with the reads
rather than with their caller, so `trade-engine.js` — a file this thread does
not own — takes three one-line changes and one import, and nothing about the
fault's wording lives there. The weakest part is `timingFault`, a separate local
flag carried alongside the Map, needed because `timing` is a per-partner Map and
a Map has no room for a state about the read that produced it. A cleaner shape
would have `timingRead` return `{ state, byPartner }`, and that is a bigger
change to a function two other PRs are editing.

**Are these statistics or are they made up?** Neither — no model, no price and
no ranking moves. What changes is what the card says when a read threw. The
defect was the reverse of a made-up statistic: three real states were being
replaced by a fourth that nobody measured.

**How do we know?** RED `119a88e`, 39 tests with 4 failing; GREEN below, 39 of
39. The corrected test file was re-run against RED's source in a detached
worktree and still fails 4 of 4, so the RED is a property of the source and not
of the test draft. `G9d` pins that the three sentences stay distinct, which is
what stops the fix decaying into one generic error string.

**Is it pointed anywhere else?** `attachTactics` is the only caller of all three
reads that catches them, so this closes the caller side. What it does not close:
nothing yet asserts that a fault reaches the HTTP response — the tests stop at
`tacticsForDeal`. Naming that rather than implying otherwise.

**How does it unify?** `#94` and `#100` taught these reads to name their own
absences. This is the one place that vocabulary was thrown away again, by the
caller, one line before the card. The rule is unchanged: an absence must say
which absence it is, and "the read crashed" is one of them.
