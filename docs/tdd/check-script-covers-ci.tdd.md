# The guard and CI have to gate on the same set

`test/check-script-covers-ci.test.js`, 7 cases.

## How this was found

PR #108's CI went red with 11 blocking findings from `npm run check:wiring`,
while the same commit exited 0 under the pre-push guard — twice, in two
source-isolated runs, on the tree that was pushed.

The guard runs `npm run check`. On `main` that was:

```
npm run typecheck && npm run lint && npm test && npm run build && npm run start:smoke
```

`check:wiring` is not in it. It was a CI step and nothing else, so the guard
could close clean while the one thing CI would refuse the branch for had never
been run on that tree. Two clean runs said nothing about it, and neither did the
report built on them.

## What this fixes, and what it deliberately does not

One line in `package.json`, placing the gate where CI already has it — after
lint, before test:

```
npm run typecheck && npm run lint && npm run check:wiring && npm test && npm run build && npm run start:smoke
```

**`ci.yml` is untouched, and its Wiring check step is not redundant.** That was
worth checking rather than assuming, because the assumption pointed the other
way. CI never invokes `npm run check`: every `run:` line in the workflow calls a
script directly — `npm run typecheck` (:57), `npm run lint` (:60),
`npm run check:wiring` (:70), `npm test` (:88), `npm run build` (:95),
`npm run start:smoke` (:104) — which is what gives a reader the failing step by
name instead of one opaque aggregate. So `ci.yml:70` is the gate's **only**
invocation in CI. Removing it as "now covered by `check`" would delete the gate
from CI entirely, and `check` would be the only thing left running it, which is
the original defect with the two sides swapped.

The cost is therefore 15 seconds added to a local `npm run check`, measured, and
**zero** added to CI.

## Why the test is about the workflow and not about one name

Asserting `check` contains `check:wiring` would pass today and say nothing about
the next step somebody adds to `ci.yml`. The defect is not a missing string, it
is that `ci.yml` and `check` are two hand-maintained lists of the same set with
nothing comparing them.

So the test reads the workflow, collects every script its `run:` lines invoke,
expands `check` transitively through `npm run` inside script bodies, and fails
naming whatever CI gates on that `check` does not reach. It also pins the
parser, because a parser that silently collects nothing would make this test
pass forever: `npm ci` is an install and not a script, `npm test` counts as the
`test` script, a chained `&&` line contributes every script on it, and a cycle
between two scripts terminates instead of recursing.

That the parser found exactly one uncovered script on the unfixed tree — named
in the failure message, with nothing else alongside it — is the evidence it is
reading the file rather than returning an empty set.

## The five questions

- **Well built?** One line of production change. The test derives its
  expectation from the workflow rather than restating it, so it keeps working as
  CI grows.
- **Stats or made up?** Measured: the gate takes 15 seconds; CI's six `run:`
  lines were read rather than recalled; the RED failure listed `check:wiring` and
  nothing else.
- **How do we know?** The claim that the `ci.yml` step becomes redundant was the
  natural one and it is false — checked by reading every `run:` line in the
  workflow, which shows CI never calls the aggregate at all.
- **Pointed anywhere else on the platform?** Yes, and this is the general case:
  any gate that lives in CI and not in `check` is invisible to the guard, and any
  future `ci.yml` step has the same hole until this test closes it. The same
  shape — two lists of one thing, hand-maintained, never compared — is what the
  accept-list retirement check closed in the wiring map a day earlier.
- **How does it unify?** A green check is a claim about a scope, and the scope
  was never stated. "Two clean runs, 0 failures" was read as "this tree passes",
  when it meant "this tree passes the five things `check` happens to list."
