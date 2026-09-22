---
name: imported-by-nothing-is-not-unused
description: On gridiron-hq, a grep that excludes the defining file answers "is this imported", never "is this used" — three threads called live code dead this way on 2026-09-22.
metadata:
  type: feedback
  modified: 2026-09-22T02:54:50.255Z
---

**The two questions have different answers, and the second one is the one
people mean.** `git grep <symbol> -- ':!the-file-that-defines-it'` is the
standard way to ask "does anything import this". Its result is routinely
reported as "zero consumers anywhere", which is a different claim and is often
false: a symbol used only inside its own module has zero importers and many
consumers.

**Measured 2026-09-22, main at 654ff93.** `SEASON_ENDING_RE` and `RELEASED_RE`
in `server/services/player-availability.js:19-20` were reported as dead code
with "zero consumers anywhere, git grep confirms empty, excluding the defining
file". Both are used at `:77` (inside `newsSeverityFor`, reached from
`server/routes/teams.js:4`) and `:152` (inside `seasonEndingEspnIds`, reached
from `server/services/trade-engine.js:62`). The ~200-character alternation runs
in production. What is unused is the `export` keyword on those two lines.

**The wiring map already words this correctly and should be quoted rather than
re-derived.** Its rule is `export-imported-by-nothing`, and its detail string
is *"exported and never imported"* — not "dead". Run
`node scripts/wiring-map.mjs` and read the findings before grepping by hand;
if the map has it, it has it more precisely.

**How to apply.**
- Never exclude the defining file when the question is whether something is
  used. Exclude it only when the question is literally "who imports this", and
  then report it in those words.
- An unused export is a one-line tidy-up (drop `export`), not a deletion. The
  value behind it is usually live.
- Before writing an inventory row for someone else's finding, re-run it
  yourself on your own tree. Two of three findings relayed on 2026-09-22 did
  not survive that: this one, and `availability-basis.js`, which does not exist
  on main at all — it is a new file on another thread's local branch, and a
  single-scope inventory takes no row for it.

**Related.** [[gridiron-import-graph-orphans-are-not-dead]] is the same rule at
module level and holds the entry points an import graph cannot see; this is the
symbol-level case. [[a-grep-finds-a-pattern-not-a-shape]] is the other half —
there the pattern cannot match the site, here the search excludes it. See also
[[verify-the-consumer-not-the-producer]] and [[gridiron-failure-modes]].
