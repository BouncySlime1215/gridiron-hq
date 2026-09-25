# COACH-01a: Coach's people gate, two verdicts and separate windows

Spec: ENGINE-SPECS.md `| COACH-01a |` and WORK-QUEUE.md `RL-18-3` (handoff package).
Step 0 evidence: `docs/evidence/2026-09-24/coach-01a-gate-rerun.md`. **Step 0 is not run yet.**
It needs the Sleeper copy on the Mac.

## RED → GREEN

| stage | commit | what |
|---|---|---|
| RED | `faea933` | `test/coach-gate-rerun.test.js` (new, 12 tests) and `test/coach-person-grading.test.js` (+6 tests, 3 edited). 10 failures |
| GREEN | this PR's next commit | `grading.js` two verdicts, refusal of constant-in-time columns, window counts; `gate-rerun.js`; runner and panel scripts |

One test edit after RED, **a test bug, not a moved goalpost**: the constant-in-time test called
`addPersonContext` with `scope: 'fixture'`, which `context.js` rejects. It now passes `'other'`.

## Spec RED list → tests

| spec RED | test |
|---|---|
| (1) passes repeatability, no outcome evidence → `priceable=0`, `predictive:'untestable'` | `repeatable with no outcome evidence stays unpriceable, predictive untestable` |
| (2) a constant-in-time column is refused (`not_gradeable`, with a reason) | `a constant-in-time column is refused, not passed` |
| (3) early and late windows share no event (fixture with a straddling event) | `early and late windows share no event, and a straddling event goes to neither` (population), `early and late windows share no message, including one at the cut itself` (chat) |
| (4) today's repeatable verdicts unchanged on the existing fixtures | `the repeatable verdict is today's verdict, unchanged`, plus every pre-existing grading test still green |

Beyond the list:
- The pass path (repeatable AND predictive → priceable) is tested.
- A tell under the support floor is `untestable`; a dead tell is `fail`, with the screen's reason.
- Precision is reported next to the base rate with a clustered CI, and only claimed when the CI
  clears the base rate.
- "predicts nothing" never appears in any output.

## Removal checks (does each test fail without its code?)

- `CONSTANT_IN_TIME` emptied → `a constant-in-time column is refused` fails. Unrefused,
  `context_rules` scored `pass` at skill 1 and rank 1 on the fixture. That is a real hole in
  today's gate: a count read from `coach_person_context` lands the same in both halves, so it
  "repeats" perfectly.
- `priceable` built from `passed` (the old rule) → `repeatable with no outcome evidence…` fails.

## Checks run

- `npm run lint`, `npm run typecheck`: clean.
- `npm run check:wiring`: exit 0. It has one new accepted orphan, `gate-rerun.js`, annotated the
  same way as TELLS-01a's `refit.js`. The `grading.js corpus` query count stays at the baselined 4:
  the message total rides the existing span query rather than adding a fifth.
- `test/coach-*.test.js test/tells-*.test.js`: 202 pass, 0 fail.
- Full `npm test`: see the PR body.
