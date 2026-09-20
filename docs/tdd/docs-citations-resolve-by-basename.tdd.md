# A resolver that fails on a good path, and the third state a gate will not compute

Retroactive RED by injection, on `docs-citation-points-at-nothing` and on the report
built beside it. No defect shipped here: this closes two gaps that a second, by-hand
pass over the OTHER direction exposed before they could.

## What happened

A different thread audited citations written INSIDE the markdown under `docs/`,
pointing OUT at source `file:line`. Its first run reported 17 missing files. Thirteen
of them were the resolver rather than the docs: those citations carry absolute paths
beginning with a developer's home directory, and a resolver matching a fixed prefix
cannot match a path that is perfectly good.

That is a report with a 76% false-positive rate on its first run, and the reason it
matters here is not the number. It is that a gate which cries wolf on day one gets an
exception added to it and is then ignored, which leaves the repository worse off than
having no gate at all — the exception is invisible and the confidence is misplaced.

The rule in `scripts/wiring-map.mjs` runs the other direction and was never going to
hit it, because its pattern starts at the `docs/` segment wherever that segment sits
and it resolves by BASENAME. "Was never going to" is a claim, and a claim about a
failure mode somebody else has already been bitten by is exactly the kind that earns a
test rather than a sentence.

## The states, and why the gate stops at two

The gate carries **MOVED** and **GONE** and never shells out to git, because it runs
on every `npm run check` and a gate that reads history on every run is a gate somebody
turns off. But GONE is two different jobs wearing one name:

- **DELETED** — a commit added the file, a later commit removed it.
- **NEVER EXISTED** — no commit on any branch ever added it.

`scripts/docs-citation-history.mjs` is the slower companion that computes the split,
from the gate's own rows plus `git log --all --diff-filter=A`. On this tree: **93
citation sites, 28 distinct paths — 17 MOVED, 4 DELETED, 7 NEVER EXISTED.**

Neither of the last two is a licence to delete the sentence that cites it. A comment
records why a feature grew a particular behaviour, and that provenance outlives its
source: the fix is a sentence saying the document is not in this repository, never a
silent deletion of the reference and never a guess at a successor. The report says so
in its own output rather than assuming whoever reads it knows.

`docs/BETTING_CAPABILITY_AUDIT.md` is in the NEVER EXISTED list. Another thread found
that one by hand. A new checker is not trusted until it reproduces a finding somebody
already made without it, and this is that row.

## Mutations

Baseline GREEN `scripts/wiring-map.mjs` sha256 `5150c4a9f235`, 82 tests, 82 pass.

| id | injected defect | sha256 | pass/fail | killed by |
|---|---|---|---|---|
| D1 | the pattern anchors at the start of a line, prefix-style | `723d77fea698` | 80 / 2 | *a citation that resolves is not a finding, and one that moved says where it went*, *a citation carrying an absolute path from a developer machine still resolves* |
| D2 | resolution by whole path instead of basename | `e57da4afddd6` | 80 / 2 | *a citation that resolves …*, *a citation carrying an absolute path …* |
| D3 | NO-OP CONTROL: one word of a comment changed | `a8973122f5d1` | 82 / 0 | none, correctly |
| D4 | the pattern requires whitespace or a line start before `docs/` | `1da5b143f337` | 81 / 1 | *a citation carrying an absolute path from a developer machine still resolves* |

**D4 is the row that justifies the new test.** D1 and D2 are caught by the test that
already existed, so on those two the new one is confirmation rather than coverage. D4
is the thirteen-false-failures fault in its exact shape — a pattern that accepts
`see docs/X.md` and rejects `/Users/somebody/repo/docs/X.md` — and it passes
81 tests. Only the new one fails.

## What is NOT checked, said out loud

A citation that resolves is not checked for being TRUE. `aggregates.js` may cite a
document that exists and no longer says a word about consensus weights, and this
reports nothing. Existence is the whole measurement, no subset is checked more deeply,
and the report's own output says so — a reader who assumes otherwise has been misled
by the tool rather than by the repository.

That limit is the same one the other direction's report names for itself: a citation
that slid onto a different but non-empty line passes an in-range check. Neither report
closes it, and neither pretends to.

## The five questions

**Well built?** Two states in a gate that never touches git, a third computed by a
companion script that does, and each says in its output which is which.

**Stats or made up?** Neither. Four checksummed injections, and a count — 93 sites, 28
paths, 17/4/7 — read out of the generated map rather than typed.

**How do we know?** D4 fails one test and passes 81. Remove the new test and a
resolver with a 76% first-run false-positive rate ships green.

**Pointed anywhere else on the platform?** Every citation in the source tree, which is
how somebody finds out why a decision was made. `docs/CONSENSUS_WEIGHTS.md` at
`aggregates.js:217` is the pointer whose only job is to stop an experiment being
redone, and it was broken at exactly the moment of the redo.

**How does it unify?** One direction each, two reports, no shared rows, and a sentence
at the top of each saying which is which so nobody fixes one and reports the other
done.
