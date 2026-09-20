# TDD evidence: playoff-odds-gate (2026-09-20)

Source: `docs/tdd/playoff-odds-calibration.tdd.md`, which graded this simulator's
own playoff probability against 184,959 real team-weeks and found it **worse than
saying nothing at all before four weeks of results**. This change makes the payload
say so. It flags; it does not blank.

Decision taken deliberately, and it is the narrower of the two options that were on
the table: **build the gate, do not substitute the fitted probability.** Swapping in
`team-outlook.js`'s logistic would be a better number on the corpus and an untested
one on Nick's leagues — the fitted model's win there is partly home advantage, and
claiming it transfers is the error the calibration exists to catch. A gate changes
what the app *claims*; a substitution changes what it *computes*.

Runner:

    GRIDIRON_DB_PATH="$(mktemp -u /tmp/gridiron-XXXXXX).sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test --test-concurrency=1 test/season-sim-odds-gate.test.js

## RED, then GREEN

| | |
|---|---|
| RED | 8 tests, `# pass 1 # fail 7` — neither `oddsGate` nor the constants existed. The one pass is the negative test (no gate on the error shape), which passes trivially when there is no gate at all, and says so. |
| GREEN | `# pass 8 # fail 0` |

**One test failed against the finished implementation and the test was wrong.** It
asserted the reason string matched `/base rate/i`; the implementation says "its
league's usual share of playoff places" instead, because the reader of a fantasy page
is not owed a term of art. The rule the assertion was reaching for — the reason must
name the alternative it loses to, so a bare "too early to say" cannot pass — is now
stated properly, and there is a mutation below that proves it bites.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| The threshold | "Publish from week 4" is a number someone could have picked. The next reader would have no way to tell whether it still followed from anything, and a calibration re-run would leave it stale and plausible. | **Derive it.** `MIN_PUBLISHABLE_WEEKS` is the first graded week whose measured Brier beats the base rate, computed from the table. Edit the table and the gate moves. |
| `fromWeek` vs weeks played | `fromWeek` is the first UNPLAYED week; the calibration's "week w" means w weeks are in the books. | `weeks_played = fromWeek - 1`, tested, because an off-by-one here gates on the wrong evidence in the one direction nobody would notice — it would publish a week early and still look right. |
| Zero weeks played | This is the live case: `MyTeam.tsx:62` sends no `from_week`, so `fromWeek` is 1 and **no results at all** are carried in. "Too early to say" undersells that: the number is not thin, it rests on projected rosters and nothing else. | **Its own reason string**, and a test that the two states cannot share one sentence. |
| Blanking vs flagging | A server that deletes the number leaves the client nothing to explain and no way to show a designed state. | **Flag.** Every `playoff_odds`, `title_odds` and interval stays in the payload byte for byte. The client renders. |
| The `{ error }` shape | `simulateSeason` returns `{ error: 'no remaining fixtures…' }` with no teams and no percentages. | **No gate there.** A flag about numbers that do not exist invites a consumer to read one. Tested by driving the error path. |
| The overconfidence facts | A gate does not fix them: even a published figure comes from a procedure whose "no chance" teams qualify 12% of the time and whose "certain" teams miss 10%. | **Travels with the flag**, in `calibration.extremes`, so a caveat is available at every week and not only before week 4. |

## The payload

One new top-level key on `simulateSeason`'s return, beside `odds_interval`:

    odds_gate: {
      published: false,            // weeks_played >= min_week
      min_week: 4,                 // derived from the calibration table
      weeks_played: 0,             // from_week - 1
      reason: 'These odds carry no results at all: …',   // null once published
      calibration: { graded_team_weeks: 184959, corpus, source, measured_on,
                     by_week: { 2, 3, 4, 8 }, extremes, not_graded }
    }

`calibration.not_graded` is in the payload on purpose: the configuration the app
actually runs — from week 1, no records, projections through last season — was never
graded, and a surface quoting the gate's evidence should be able to say so.

## Mutation: every guarded rule, shown failing

Each verified **applied** (the driver asserts the anchor occurs exactly once and
reports `ANCHOR NOT FOUND` otherwise), each restored from a pristine copy. Two of
these were re-run: a first attempt at the reason mutation was syntactically invalid
and the whole file failed to load, and a first attempt at the error-shape mutation
edited only a comment and was a no-op. **A no-op reads as a green sweep, which is why
the rule is to print applied or not.** Both were rewritten and are reported here as
run.

| Mutation | Result | Caught by |
|---|---|---|
| threshold hardcoded to 2 instead of derived | applied; pass 5, fail 3 | the threshold is the measurement, not a chosen number |
| derivation flipped to the first week it LOSES | applied; pass 5, fail 3 | (same, plus the gate's open/shut test) |
| week 2's measured Brier edited to beat the base rate | applied; pass 4, fail 4 | the threshold is the measurement; the calibration table says what the gate is for |
| off by one: `weeks_played` reads `fromWeek` | applied; pass 4, fail 4 | weeks_played is what the odds stand on |
| the zero case folded into the early case | applied; pass 7, fail 1 | no results at all is its own state |
| the early reason replaced by a bare "Too early to say." | applied; pass 7, fail 1 | the reason names the measurement, in plain words |
| the gate attached to the error shape as well | applied; pass 7, fail 1 | a payload with no odds in it carries no gate |
| `published` drops the calibration block | applied; pass 7, fail 1 | the server flags, it does not blank |

## What this does NOT do

- **It does not change a single percentage.** No projection, no sampler, no bracket,
  no run count. The diff is additive: one frozen constant, one derived constant, one
  pure function, one key on the return.
- **It does not render anything.** No client file is touched. The field names went to
  the UI thread before this was built so the rendering could be wired in parallel.
- **It does not substitute the fitted probability**, which remains the open proposal
  and would need its own grading on Nick's own leagues first.
- **It cannot make an ungraded configuration graded.** `not_graded` says so in the
  payload rather than leaving a reader to assume the gate blesses what is left.
- `season-sim.js` is also edited on #40 and #44. This will conflict at merge; both
  sides are additive, the file is this thread's, and it is resolved at merge time
  rather than by a rebase.

## The five questions

1. **Well built?** The threshold is derived from the evidence rather than chosen,
   the function is pure and separately testable, and nothing that produces a number
   was touched.
2. **Stats or made up?** Entirely measured, and the measurement is quoted in the
   payload with its source path so a reader can go and check it.
3. **How do we know?** 184,959 graded team-weeks across 2,500 leagues and five
   seasons; week 2 Brier 0.2855 and week 3 0.2439 against a base rate of 0.2410,
   week 4 0.2162 beating it. Stable across all five seasons. The gate is exactly the
   crossing point of those two columns.
4. **Pointed anywhere else?** Every other published probability in this app has the
   same problem and none has been graded — title odds beyond the playoff question,
   `predictRankGap`, the trade window, Trade Brain confidence. The same two-column
   test (measured score against the base rate) decides whether each of them should
   carry a gate, and `calibration-metrics.js` is what grades them.
5. **How does it unify?** One place says whether the odds are publishable, one
   sentence explains it, and the evidence travels with the flag instead of living
   only in a doc nobody reads at the moment the number is rendered.
