# The fourth-down trait, describing the number it actually has

RED `5a89d05` · GREEN `6058b5d` · branch `claude/project-thread-xiezr0-data-freshness`
off `origin/main 654ff93`.

## 1. The defect

`football-context.js:195` printed a sentence about a coach — "goes for it on
fourth down", or its inverse "punts and kicks" — driven by
`off_fourth_down_rate`. That field is not a go-for-it rate.

`nfl-pbp.js:247` increments `fourth_att` on **every** fourth-down play, punts
and field goals included, while `fourth_conv` only rises on a first down, which
only a go-for-it attempt produces. `:461` divides one by the other. The field is
therefore the share of all fourth downs that ended in a first down —
approximately go-for-it rate × conversion rate.

Measured on the 2024 regular season, from the same play-by-play the code reads
(`docs/evidence/2026-09-22/fourth-down-rate-unit-mismatch.md`, Model evidence
audit's branch `origin/claude/project-thread-w0gpjt`):

| quantity | value |
|---|---|
| what the code computes, `fourth_conv/fourth_att` | **0.1199** |
| the go-for-it rate the old label claimed | 0.1866 |
| go-for-it rate × conversion rate | 0.1060 |

The label overclaimed by a factor of 1.6, and it did so in one of the few places
the mismatch is **directly visible to Nick**: it renders as an English sentence
asserting a coach's style.

## 2. Why the obvious fix was not available

The handoff said an additive `off_fourth_down_go_rate` had already been pushed,
so this would be a one-line swap. It had not. Checked across **all 155 remote
branches**, with `off_fourth_down_rate` as a control in the same scan:

- control `off_fourth_down_rate` — present on 155 branches
- `off_fourth_down_go_rate` — present on **0**
- `off_fourth_down_situations` — present on **0**

The evidence file that diagnosed the bug says so itself, in its second
paragraph: *"None of these files is mine to edit (one editor per server file).
This is a report, not a change."* It is a report that was read as a shipped fix.
`nfl-pbp.js` is not this thread's file, so the correct rate could not be
produced here either.

## 3. The fix that was available

Stop claiming a quantity this file does not have, and describe the one it does.

| | before | after |
|---|---|---|
| label | goes for it on fourth down | converts fourth downs into first downs |
| inverse | punts and kicks | ends its fourth downs without a first down |

This is not a softening of the old claim, it is a different claim. A team high
on this number either goes for it often or converts well, and the number cannot
say which. The old wording picked one and told Nick it was the coach's style.

The swap point is marked in the file. When `nfl-pbp.js` publishes a rate whose
denominator keeps punts and field goals, the key becomes that field and the
aggression wording is true again. The field is deliberately **not referenced
now**: reading a column that is not published would make `meanOf` return null
and drop the trait silently, which is the failure mode this project keeps
finding rather than a fix.

`off_fourth_down_situations` should arrive with it and should then gate the
trait on a minimum sample. The one-week figure runs on 1-3 snaps often enough
that its p25/p75 are 0.000/1.000, so a season mean is noisier than it looks.
That gate is blocked on the same missing work.

## 4. A vacuous test, caught before RED

The first fixture gave every team the same value on the other four tendencies,
intending to leave fourth down as the only trait in play. It does the opposite:
with identical values the percentile is 0 for all of them, so all four fire as
their inverse, and since `reading` prints only its **first three** traits, the
fourth-down sentence never appears at all. The sentence test passed while
exercising nothing.

The other tendencies are now spread across the league and rotated so both teams
under test sit mid-pack on each, and a guard test (`the fixture leaves fourth
down as the only tendency in play`) pins that property so it cannot rot back.
Mutation **M7** exists to kill that guard.

## 5. A real gap the sweep found

**M5** — swapping `pct >= 0.75 ? t.label : t.inverse` to its opposite, so the
league's best converting team is described as the one that fails to convert —
**survived the first sweep**. The direction assertion was `/first down/i`, and
both the label and its inverse contain "first down", so the swap was invisible.

The test was wrong, so the test was fixed: the top team must now match
`/converts fourth downs/i` and the bottom `/without a first down/i`. M5 dies
after that, and the sweep below was then re-run **in full** so every row comes
from one consistent state rather than two.

## 6. Mutation sweep

Sweep re-run in full on `6058b5d` after the M5 gap was closed, so every row below is from one consistent state. Hashes are the first 12 of the file's SHA-256, recorded before the edit, after it, and again after the restore.

| # | mutation | aimed at | hash before → after | pass/fail | outcome |
|---|---|---|---|---|---|
| 1 | M1 the aggression label comes back | T2 top team, T4 the sentence | `4aa3e062525f` → `58b16e51663c` | 3/3 | **killed** by "the top team is not described as going for it on fourth down"; "the sentence Nick reads makes neither claim"; "the trait still says something true rather than being deleted" |
| 2 | M2 the timidity inverse comes back | T3 bottom team, T4 the sentence | `4aa3e062525f` → `4890cfea7250` | 3/3 | **killed** by "the bottom team is not described as punting and kicking"; "the sentence Nick reads makes neither claim"; "the trait still says something true rather than being deleted" |
| 3 | M3 the trait is deleted rather than relabelled | T1 fixture guard, T5 still says something true, T6 the value | `4aa3e062525f` → `95faed28fe37` | 1/5 | **killed** by "the fixture leaves fourth down as the only tendency in play"; "the top team is not described as going for it on fourth down"; "the bottom team is not described as punting and kicking"; "the trait still says something true rather than being deleted"; "the trait carries the value it was derived from, so the sentence can be checked" |
| 4 | M4 the label and inverse stop being distinguishable | T5 top and bottom must not read alike | `4aa3e062525f` → `ad5807cb4b03` | 5/1 | **killed** by "the trait still says something true rather than being deleted" |
| 5 | M5 the percentile stops inverting the direction | T5 percentile ordering | `4aa3e062525f` → `85d8c8cf42ce` | 5/1 | **killed** by "the trait still says something true rather than being deleted" |
| 6 | M6 the trait stops carrying the value it came from | T6 the value | `4aa3e062525f` → `d8334d89c786` | 5/1 | **killed** by "the trait carries the value it was derived from, so the sentence can be checked" |
| 7 | M7 the percentile gate lets every tendency through | T1 fixture guard — a neighbour trait would make T4 vacuous | `4aa3e062525f` → `8d0d5e251455` | 5/1 | **killed** by "the fixture leaves fourth down as the only tendency in play" |
| 8 | C1 NO-OP: a multi-site anchor must be refused, not mutated | the runner itself — designed NOT APPLIED | `4aa3e062525f` → `4aa3e062525f` | — | **NOT APPLIED** (anchor x4) — as designed |
| 9 | C2 NO-OP: a comment-only edit changes no behaviour and must survive | the suite itself — designed SURVIVING | `4aa3e062525f` → `3bb73f22422e` | 6/0 | **SURVIVED** — as designed |

All 6 tests appear in a `killed_by` list. Every applied row's hash moved and
every row restored to its before-hash.

**C1** uses an anchor matching four times and must come back NOT APPLIED — the
runner refuses a multi-site anchor rather than mutating whichever site comes
first. **C2** edits a comment, applies, moves the hash and must survive, which
is what proves a kill elsewhere came from behaviour.

## 7. The full check

`npm run check` on GREEN `6058b5d`:

- **exit 0**
- **3037 tests, 2996 pass, 0 fail, 41 skipped**
- `git write-tree` `ca4d3c3c6a86f528375fd17b90aba8dae3b587e2` before and after —
  identical.
- `node_modules` mtime `1789853354` before and after.
- State: **source-isolated** — own source tree, `node_modules` symlinked to
  `/home/user/gridiron-hq/node_modules`.

(The evidence-file commit adds the direction assertions from §5, so the tree at
that commit is `0d1bd6232babc87990f649f25b6afda1948f67cc`, not the one measured above.)

## 8. What this does not settle

- **The underlying field is still wrong for its name**, and this change does not
  touch it. `off_fourth_down_rate` remains conversions ÷ all fourth downs.
- **`nfl-sim-policy.js:503` carries the same false claim** — "how often this
  team actually goes for it" — and `:510` subtracts a league go-for-it rate of
  0.20 from this quantity. The audit's replay over 256 team-seasons found 91.8%
  classified conservative and **0% aggressive**, with a mean
  `ep_threshold_shift` of +0.2716. That file is not this thread's, and it is not
  fixed here. It is the larger half of this bug.
- **`nfl-features.js:60`** labels the same field "Fourth down conversion rate",
  wrong in the other direction by a factor of 4.7. Also not this file.
- **No sample-size gate**, per §3.

## The five questions

- **Well built?** The wording now matches the arithmetic, the swap point is
  marked so the real fix is one line, and the missing field is left unreferenced
  rather than read speculatively.
- **Stats or made up?** Stats: 4,094 fourth-down plays in the 2024 regular
  season (punt 2,046, field goal 1,016, pass 459, run 305, no_play 267, kneel 1).
  The absence of the go-rate field is a measurement too — 0 of 155 branches,
  against a control that hit all 155.
- **How do we know?** 9 mutations, all 6 tests killed, two controls with
  designed outcomes, hashes either side of every edit, all restored. One
  mutation survived the first pass, exposed a real gap, and the sweep was re-run
  whole rather than patched.
- **Pointed anywhere else on the platform?** `coachingProfile` feeds the
  coaching section and the `reading` sentence. The same underlying field feeds
  `nfl-sim-policy.js` and `td-features.js`, neither of which is fixed here — §8.
- **How does it unify?** Same move as the start/sit curve: where a number cannot
  support the word attached to it, change the word to the truth rather than
  leaving the sentence standing because it reads well.
