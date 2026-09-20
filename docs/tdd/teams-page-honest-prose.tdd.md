# The teams page: prose labelled as prose — TDD evidence

Retroactive RED by mutation, the shape set by `docs/tdd/week2-numbers.tdd.md`.

## What the complaint actually was

Nick: "the page with the teams is so fucked lol. No model stuff but the
descriptions etc fucked."

The first half turned out to be wrong, and finding that out is most of this
change. There **is** model content on that page:
`server/services/nfl-team-tendencies.js` computes a "Measured identity" block
from thousands of team-weeks of play-by-play, every number a percentile against
the other 31 teams in the same season, served at `/teams/:abbr/tendencies` and
rendered by `TeamDetail.tsx`. It is good, and it was already there.

The second half is real. The scheme note and the coach outlook are prose
somebody typed — `server/db/seed/teams.js` says so in its own header,
"Schemes/analyses are editorial seed content" — and they sat directly beneath
the measured block in **identical cards at identical weight**. A sentence
written before the season read as authoritatively as a percentile computed from
play-by-play. Thirteen values in that file are still placeholders, several
reading `TBD (camp)`, and camp is over.

## What was NOT done, and why it matters more than what was

**The prose was not rewritten.** Who each team's actual offensive or defensive
coordinator is cannot be answered from anything in this repository. Filling those
in would replace a visible placeholder with an invisible invention, which is
strictly worse: "TBD (camp)" at least tells the reader the page does not know.

**No date was invented.** `nfl_teams` has no `updated_at` column
(`core-and-fantasy.js:62-84`) and the edit route at `routes/teams.js:103-112`
writes none, so nothing in the system knows when any of this text was written or
last edited. The label says it is undated rather than saying "as of preseason
2026", which would be a guess presented as provenance — the exact failure the
basis vocabulary exists to prevent. A test pins that: if a timestamp column is
ever added, that test fails and tells whoever added it to show the real date.

## What was done

1. A coaching slot whose stored value still matches `/\bTBD\b/i` renders as an
   absence rather than as a name. The head coach, which always renders, says
   "not recorded" — a blank where a name belongs reads as a layout bug, not as a
   fact.
2. Both hand-written cards carry an `assumed` chip with one shared note saying
   the text is hand-written, undated, and outranked by the measured block above
   it when the two disagree. That last clause is not new policy: the
   `Tendencies` component's own header already said "when the two disagree, the
   measurement is the one to trust". The page simply never told the reader.

## The mutations

Control after restoring: **5 pass, 0 fail**.

| # | Mutation | Result |
|---|---|---|
| t1 | Remove the placeholder guard from the head coach | **4 pass, 1 fail** |
| t2 | Label one prose card instead of both | **4 pass, 1 fail** |
| t3 | Make the note claim "as of the 2026 preseason" | **4 pass, 1 fail** |
| t4 | Move the prose above the measured identity block | **4 pass, 1 fail** |

t3 is the one worth keeping. It is the tempting change — a date makes the label
look more rigorous — and it is the dishonest one, because the date would be made
up. t4 guards an ordering that carries the whole argument: a page that leads with
the sentence and follows with the evidence has inverted which one it trusts.

## Honest limit

`node:test`, no DOM, source text only. Also: `/\bTBD\b/i` catches the thirteen
placeholders that exist today. A future placeholder phrased differently ("to be
named", "vacant") would pass straight through, and there is no way to detect
that generally — a test asserts at least one `TBD` still exists in the seed, so
if the seed is ever cleaned up, that test says so rather than the guard silently
protecting against nothing.

## Commands

```
GRIDIRON_DB_PATH=$(mktemp -u /tmp/gr-XXXXXX).sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/teams-page-honest-prose.test.js
```
