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

Why a scan and not a rule in this document: the failure mode §R51.1 names is
a caller forwarding its own `options` object through. That is a diff which
reads as plumbing, so no reviewer instruction catches it reliably and no
assertion about a *value* catches it either — the value is decided at run
time. What can be checked is the shape of the call.

The scanner in `test/nfl-player-context-graded-availability.test.js` is a
function over `{ path, source }` records rather than over the file system
(§R54.3). It resolves every local name that refers to the target, finds each
call site by balanced-paren parse, and reports one if the call passes a 6th
argument at all. Wiring the multiplier in stays permitted; switching it on
does not.

Two things are removed from a source before it is scanned, for two different
reasons:

- **comments**, because the flag's own docstring spells out
  `gradedAvailabilityMultiplier(..., { enabled: true })` as prose, and a scan
  that read comments would report the documentation as the violation — the
  kind of false positive that gets a gate disabled;
- **string bodies**, because the fixtures below are violating source code held
  in template literals *in that same test file*, so a scanner that read string
  bodies would report its own fixtures as real findings the moment it reached
  `test/`.

A second test pins the test side: every opt-in must be the literal
`{ enabled: true }`, or `ENABLED` where that name is bound to that literal in
the same file's source, so reading a call site is enough to know what was
passed without running anything.

Three sanity assertions fail loudly if the scan stops actually reading the
repository: a file-count floor; "exactly one declaration seen", whose message
says a zero there means the source normaliser broke rather than the repository
changing; and — in the declaring file — that the binding resolver finds
exactly one local name, the exported one, since anything extra would mean it
is reading a call as an alias and every later finding would be suspect rather
than merely noisy.

### RED and GREEN, in §R54.3's committed-fixture form

§R54.3 refused both forms of RED otherwise available here. A committed
production violation would put the override into this repository's history. A
working-tree violation is not reproducible by anyone else. So the cases are
committed as inline fixtures: five that must be flagged, three that must not.

The must-not-flag cases exist because a scanner that flagged everything would
pass all five must-flag cases and still be useless. They are: wiring without
an override (what condition 3 permits), the override as docstring prose, and
the override held in a string.

**RED — `60dc4f0`, `# tests 20 # pass 18 # fail 2`.** Two of the five
required shapes fail against a bare-name parse, which is the §R33 blind spot
§R54.3 required them for:

`not ok 13 - Auditor §R54.3: the scan flags an ALIASED import, which a bare-name parse misses entirely (R33)`:

> this shape must be flagged exactly once and was not (0 findings). It is an
> ALIASED import, which a bare-name parse misses entirely (R33). Fixture
> source:
> `import { gradedAvailabilityMultiplier as gam } from './nfl-player-context.js';`
> `export const m = (id, fit) => gam(id, 2024, 1, 'now', fit, { enabled: true });`
>
> `0 !== 1`

`not ok 15 - Auditor §R54.3: the scan flags a destructured dynamic import, renamed on the way out`:

> this shape must be flagged exactly once and was not (0 findings). It is a
> destructured dynamic import, renamed on the way out. Fixture source:
> `const { gradedAvailabilityMultiplier: gam } = await import('./nfl-player-context.js');`
> `return gam(id, 2024, 1, 'now', fit, { enabled: true });`
>
> `0 !== 1`

The namespace case (`ctx.gradedAvailabilityMultiplier(...)`) passed in the
RED, and it is kept as a fixture rather than a remark: it works because the
call-site pattern is anchored on a word boundary and `.` is not a word
character. That is a property worth pinning, not an accident worth trusting.

**GREEN — `d01aac8`, `# tests 20 # pass 20 # fail 0`.** Binding resolution
for the renamed static import (`as`), the renamed destructuring of a dynamic
import (`:`), and the indirect form (`const gam = ctx.target`). The real tree
still scans clean, so the resolution introduced no false positives.

### The earlier working-tree demonstration (extra, and labelled as such)

Before §R54.3 settled the form, the same two behaviours were demonstrated as
working-tree violations. Kept here as corroboration only — it is not the RED,
and it is not reproducible from this history:

- a call appended to `scripts/r25-level-vs-information.mjs` forwarding a
  *variable*, `const _redOpts = { enabled: true }`, reported as
  `scripts/r25-level-vs-information.mjs: 6 args -- 'x', 2024, 1, '2024-01-01T00:00:00Z', {}, _redOpts`;
- the retained-bucket test's opt-in replaced with `{ enabled: process.env.X !== '0' }`,
  reported as `test/nfl-player-context-graded-availability.test.js: { enabled: process.env.X !== '0' }`.

Both were reverted, and `git diff --stat` confirmed
`scripts/r25-level-vs-information.mjs` byte-identical to its committed form
before any commit was made. The first of those two is now fixture case 2.

## §R51.1 condition 2: each opt-in names itself

The five `ENABLED` call sites each carry, inline, what the test would be
grading if the flag were left off — the reason string
`feature_never_recorded` that only the enabled path produces, the as-of read
that only happens past the flag check, the one non-neutral return value the
kill switch would hollow out while leaving the test passing.

## Citations (Auditor §R52.2)

| stage | PR | commit subject | sha |
| --- | --- | --- | --- |
| flag, RED | #106 | (working tree, not a separate commit — see RED below) | — |
| flag, GREEN | #106 | `feat: Plan 01 ships default-off behind GRADED_AVAILABILITY_ENABLED (R40)` | `d4c6e49` |
| scan, first form | #106 | `test: source-scan the enabled override, name every opt-in (R51.1)` | `7c00e40` |
| scan, RED | #106 | `test: RED -- commit the scanner's cases as fixtures (R54.3)` | `60dc4f0` |
| scan, GREEN | #106 | `test: GREEN -- resolve local bindings so aliases cannot hide the override` | `d01aac8` |

Every sha is on `refs/pull/106/head` and unreachable from `main` until #106
merges, which is why the branch ref is named rather than left implied.

The flag's own RED was not a separate commit and this table says so rather
than citing a sha that does not exist. The scan's RED is a real commit
(`60dc4f0`), per §R54.3.

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
# fail 0` at `7c00e40`, once the first form of the §R51.1 scan joined the
file; `# tests 20 / # pass 20 / # fail 0` at `d01aac8`, once §R54.3's
committed fixtures replaced it.

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
