# Plan 01's kill switch: GRADED_AVAILABILITY_ENABLED (Auditor §R40)

§R40 offered Plan 01 the same relief the target-share prior got: if the
multiplier ships default-off behind a flag nothing sets, pinned by a test
carrying the reason, it is not a behaviour change and #106 can merge on
green. The §R19.6 as-of refit still has to be regraded before the flag is
ever turned on.

## What shipped

`server/services/nfl-player-context.js`:

- `GRADED_AVAILABILITY_ENABLED = false`, exported, with the reason in the
  docstring above it.
- `gradedAvailabilityMultiplier(..., { enabled = GRADED_AVAILABILITY_ENABLED })`
  returns `{ multiplier: 1, known: false, reason: 'graded_availability_disabled' }`
  for every input while the flag is off — before any bucket lookup.

## Why this is zero behaviour change, checked rather than assumed

`grep -rn "gradedAvailabilityMultiplier" server/` (excluding tests) returns
one definition and **zero call sites**. Nothing in the projection path
calls it: it does not multiply anything, before or after the share shrink
at `projections.js:599-605`. So the flag changes no served number, because
no served number ever reached this function.

## Why a flag at all, if nothing calls it

Unreachable dead code and a default-off flag are not the same risk. With
no flag, the first caller to wire this up switches live behaviour in a diff
that only looks like wiring. With the flag, wiring and enabling are two
separate one-line changes, and the second one is the reviewable event.

## Why the flag is a default, not a hard block

`{ enabled: true }` runs the real logic. That is how this unit's existing
tests grade it — the look-ahead guard, the retained-bucket ratio, the
minN-floor collapse and the G1 invariant all describe what the multiplier
does when it runs, and they are Plan 01's evidence. Gating the logic itself
would have made those tests assert the kill switch instead, which is
deleting evidence to make a flag look clean. They now opt in explicitly
(`const ENABLED = { enabled: true }`), so each one reads as deliberately
exercising the disabled-by-default path.

## Where default-on is allowed to happen (§R51.1 condition 3)

At the coupled grade's named call site, and nowhere else. That is where
§R19.6's as-of refit binds — the refit whose numbers came back identical on
this container's single-snapshot revision store, which is exactly why the
grade is still owed. Anywhere earlier, flipping the flag would be adopting
an ungraded multiplier. This is stated in the flag's own docstring at
`server/services/nfl-player-context.js:526-536` and enforced by the scan
below, which permits a caller to *wire* the multiplier in and fails the
build if one *switches it on*.

## §R51.1 condition 1: the override is scanned for, not agreed to

`test/nfl-player-context-graded-availability.test.js` walks every `.js`,
`.mjs` and `.cjs` file under `server/` and `scripts/`, strips comments,
parses each `gradedAvailabilityMultiplier(...)` call site's balanced
argument list, and fails if any of them passes a 6th argument at all.

Why a scan and not a rule in this document: the failure mode §R51.1 names is
a caller forwarding its own `options` object through. That is a diff which
reads as plumbing, so no reviewer instruction catches it reliably and no
assertion about a *value* catches it either — the value is decided at run
time. What can be checked is the shape of the call.

Comments are stripped first because the flag's docstring spells out
`gradedAvailabilityMultiplier(..., { enabled: true })` as prose. A scan that
read comments would report the documentation as the violation, which is the
kind of false positive that gets a gate disabled.

A second test pins the test side: every opt-in must be the literal
`{ enabled: true }`, or `ENABLED` where that name is bound to that literal
in the same file's source. Both tests carry sanity assertions that fail
loudly if the scan stops actually reading the repository — a file-count
floor, and "exactly one declaration seen", whose failure message says a zero
there means the comment stripper broke rather than the repository changing.

### RED for the scan tests — a deliberate violation, not a committed state

A guard test has no honest committed RED: the only way to make one is to
commit a deliberate violation into production code for one commit. It was
done as a working-tree violation instead, introduced and removed, and both
failures are quoted here in full. Stated plainly rather than presented as a
normal RED/GREEN pair.

**Violation A** — appended to `scripts/r25-level-vs-information.mjs`, a call
forwarding a *variable* rather than a literal, which is the shape §R51.1
actually warns about:

```js
const _redOpts = { enabled: true };
gradedAvailabilityMultiplier('x', 2024, 1, '2024-01-01T00:00:00Z', {}, _redOpts);
```

`not ok 11 - Auditor §R51.1: no caller under server/ or scripts/ passes the enabled override`, failing on:

> a caller under server/ or scripts/ passes a 6th argument to
> gradedAvailabilityMultiplier. Production code inherits
> GRADED_AVAILABILITY_ENABLED; it never overrides it. Forwarding the
> override out of caller options is precisely how an ungraded multiplier
> gets switched on in a diff that reads as wiring (Auditor §R51.1). Turning
> it on belongs at the coupled grade's named call site, where §R19.6's
> as-of refit binds
>
> `+ [ "scripts/r25-level-vs-information.mjs: 6 args -- 'x', 2024, 1, '2024-01-01T00:00:00Z', {}, _redOpts" ]`
> `- []`

**Violation B** — the retained-bucket test's opt-in replaced with a computed
value, `{ enabled: process.env.X !== '0' }`:

`not ok 12 - Auditor §R51.1: every opt-in under test/ is the literal { enabled: true }, never a computed value`, failing on:

> an opt-in that is not the literal { enabled: true } (or ENABLED, bound to
> that literal in the same file) can carry a value decided at run time,
> which is a forwarded override in a test's clothes
>
> `+ [ "test/nfl-player-context-graded-availability.test.js: { enabled: process.env.X !== '0' }" ]`

Both violations were reverted and `git diff --stat` confirmed
`scripts/r25-level-vs-information.mjs` byte-identical to its committed form
before the commit was made.

## §R51.1 condition 2: each opt-in names itself

The five `ENABLED` call sites each carry, inline, what the test would be
grading if the flag were left off — the reason string
`feature_never_recorded` that only the enabled path produces, the as-of read
that only happens past the flag check, the one non-neutral return value the
kill switch would hollow out while leaving the test passing.

## Citations (Auditor §R52.2)

| stage | PR | commit subject | sha |
| --- | --- | --- | --- |
| flag, RED | #106 | (working tree, not committed separately — see RED below) | — |
| flag, GREEN | #106 | `feat: Plan 01 ships default-off behind GRADED_AVAILABILITY_ENABLED (R40)` | `d4c6e49` |
| scan tests, RED | #106 | (working-tree violations A and B above, quoted in full) | — |
| scan tests, GREEN | #106 | `test: source-scan the enabled override, name every opt-in (R51.1)` | `7c00e40` |

Both shas are on `refs/pull/106/head`, unreachable from `main` until #106
merges. Neither RED was a separate commit, and this table says so rather
than citing a sha that does not exist.

## RED

Two tests added to `test/nfl-player-context-graded-availability.test.js`
before the flag existed:

1. `Auditor §R40: GRADED_AVAILABILITY_ENABLED defaults false, and nothing in
   this repo sets it true` — failed because the export did not exist, on:

   > default-off until the R19.6-conditioned fit is independently regraded
   > (Auditor §R19.5/§R19.6). Flipping this is a one-line, reviewable change;
   > leaving the multiplier as unreachable dead code instead would let a
   > future call site switch it on with nothing to review
   >
   > `undefined !== false`

2. `Auditor §R40: the flag is a hard kill switch, not a formality -- it
   overrides a real, retained bucket` — failed for the same reason, the
   import resolving to `undefined`.

`# pass 8 / # fail 2`.

## GREEN

`# tests 10 / # pass 10 / # fail 0` at `d4c6e49`; `# tests 12 / # pass 12 /
# fail 0` at `7c00e40`, once the two §R51.1 scan tests joined the file.

The kill-switch test does not merely assert "returns 1": it first asserts
`fit.ratios.Questionable` is strictly between 0 and 1 on the fixture, then
records a real `Questionable` revision and reads it at a decision time that
would resolve to that retained bucket. Returning 1 there can only happen if
the flag check runs before the bucket lookup — a fixture that fell through
to one of the already-neutral branches would pass a weaker assertion.

## What this does NOT cover

- Whether the multiplier's numbers are right. §R19.5/§R19.6 accepted Plan
  01 as built-ungraded; the grade is still owed, and the flag is what keeps
  an ungraded number out of production in the meantime.
- Any call site. There is none. Wiring it into the projection path is
  `projections.js`'s owner's decision (Model evidence audit), not this
  file's, and is explicitly not done here.
- The §R19.6 refit's identical-numbers result, which is a property of this
  container's revision store (a single reconstructed snapshot per
  player-week), not evidence the conditioning question is settled — see
  `injury-participation-term.tdd.md`.
