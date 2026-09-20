# TDD evidence (retroactive): no kicker or defense could ever be recommended

**Change.** `claude/project-thread-5f9c3y-waiver-kdef`, PR #62, one commit
(`25d911c`) on top of `791b131`.

**Defect, in two independent parts.** Every league in this database starts a
kicker and a defense, and the waiver board could recommend neither.

1. **A spelling mismatch put defenses outside the pool.** `waiver-brain.js`
   filtered its scored set on `'DST'`; the `players` table spells the position
   `'DEF'`. No defense was ever a free agent as far as this module was concerned.
2. **Even in the pool, neither could ever rank.** `waiverUpgrades` ranks a
   candidate by the gain it produces through `bestLineup`, and `bestLineup`
   (`trade-engine.js:615`/`:636`) filters both the player pool and the slot list
   to `SCORED = new Set(SKILL)` = QB/RB/WR/TE, deliberately, because kickers and
   defenses are near-random week to week. A kicker therefore scores exactly zero
   gain and sorts last, always.

Fixing (1) alone would have changed nothing visible — which is the point of test 5
below. The two together are why the honest fix is not "make them rank": the solver
genuinely does not model them, and pretending otherwise would invent a number. The
board now marks each row `lineup_modelled`, skips the unmodelled ones **where they
are skipped**, and returns `not_modelled: { positions, in_pool, why }` so the
closing note can no longer claim a clean search it did not run.

**A third possible cause, ruled out rather than assumed.** `freeAgents` also
filters on `(p.adj_ppg ?? 0) > 0`. Checked against the real seed: `Cardinals D/ST`
carries `adj_ppg 8.82`, so defenses are priced and that filter was not a third
gate. Had it been, the `'DST'` → `'DEF'` fix would have changed nothing.

## RED (`test/waiver-kicker-defense.test.js`, 7 tests, at `791b131`)

```
# tests 7
# pass 3
# fail 4
not ok 1 - a free-agent defense reaches the pool at all
ok 2 - the spelling this file uses is the spelling the data uses
not ok 3 - the pool records which rows the lineup solver can score
not ok 4 - the waiver list says what it does not cover, instead of just not covering it
ok 5 - a kicker or defense still never appears as a ranked upgrade
ok 6 - a genuinely better skill player still ranks, unchanged
not ok 7 - the closing note cannot claim a clean search it did not run
```

Three of the seven pass at `791b131` and are meant to: **5 and 6 are the
regression pins** — this change must not start offering a kicker as an upgrade,
and must not disturb a real skill-player recommendation. Test 2 asserts the
spelling against the data rather than against the constant, so it is red only if
the data's spelling changes.

## GREEN

At `25d911c` all 7 pass, and the full suite is green.

## The fixture trap this file was rebuilt around

A roster payload of `{ playerPoolEntry: { player: { fullName } } }` makes
`loadRosters` match nobody, silently. `me.players` comes back empty, `bestLineup`
scores 0, and **every** free agent then shows a positive gain — so "a real upgrade
is still found" passes against a completely broken fixture. Rosters in this file
carry `id` and `defaultPositionId` (QB 1, RB 2, WR 3, TE 4, K 5, DEF 16), and the
tests print `pool_size` and the resolved owner so the failure cannot be silent
again.

## Injections

Three of the seven pass at `791b131`, so the RED run does not prove them.

**Test 6** — the skip inverted, so only unmodelled rows rank:

```js
- if (!fa.lineup_modelled) continue;
+ if (fa.lineup_modelled) continue;
```
```
# pass 6  # fail 1
not ok 6 - a genuinely better skill player still ranks, unchanged
```

**Test 5, first attempt — it did not bite, and that is the useful part.**
Widening only this file's own set:

```js
- const LINEUP_MODELLED = new Set(['QB', 'RB', 'WR', 'TE']);
+ const LINEUP_MODELLED = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
```
```
# pass 4  # fail 3
not ok 3 - the pool records which rows the lineup solver can score
not ok 4 - the waiver list says what it does not cover, instead of just not covering it
not ok 7 - the closing note cannot claim a clean search it did not run
```

Test 5 survived. That is the honest answer to "what keeps a kicker off the board":
not the filter this PR adds. Letting a kicker through still ranks him nowhere,
because `bestLineup` does not score him and his gain is zero. **The filter is what
lets the page say why; the solver is what makes it true.** Adding the second half:

```js
- const SCORED = new Set(SKILL);                       // trade-engine.js:125
+ const SCORED = new Set([...SKILL, 'K', 'DEF']);
```
```
# pass 3  # fail 4
not ok 3 - the pool records which rows the lineup solver can score
not ok 4 - the waiver list says what it does not cover, instead of just not covering it
not ok 5 - a kicker or defense still never appears as a ranked upgrade
not ok 7 - the closing note cannot claim a clean search it did not run
```

**Test 2 has no applicable injection and is recorded as such.** It asserts that
nothing in the database spells the position `'DST'` and that things do spell it
`'DEF'`. That is a claim about the data, not about a line of code, so no mutation
of this repository can fail it. It is kept because the defect it describes *was* a
literal that matched no row, and if the seed's spelling ever changes this file
says so immediately. It should not be counted as a guarded rule.

## Is this well built

- **Well built:** the fix is honest rather than clever. It does not start scoring
  kickers, which would mean inventing a weekly number for a position the model
  deliberately declines to forecast.
- **Stats, or made up:** the exclusion is a **modelling choice, not a data gap**,
  and the injection above is what proves it — K and DEF do carry a `ros_ppg`
  (it is `proj / GAMES`), so they could be scored; `SCORED = new Set(SKILL)`
  declines to, on the stated grounds that they are near-random week to week. The
  `gain <= 0.05` cutoff is a hand-set constant and is untouched here.
- **How we know:** no backtest of the near-randomness claim exists in this
  repository. It is received fantasy wisdom, stated in a comment, and it should be
  treated as hand-set until someone measures week-to-week autocorrelation of K and
  DEF scoring against QB/RB/WR/TE on `nfl_player_week_stats`. What this PR
  verifies is narrower and solid: the spelling mismatch (`'DST'` occurs nowhere
  else in `server/`), and that a defense is genuinely priced in the seed
  (`Cardinals D/ST`, `adj_ppg 8.82`) so the `(p.adj_ppg ?? 0) > 0` filter was not a
  third cause.
- **Pointed anywhere else:** `not_modelled` is deliberately the same field and the
  same meaning in `waiverUpgrades` and in `byePatches`. Any other surface that
  ranks through `bestLineup` — the lineup card, trade proposals — has the same
  silent gap and should carry the same field. That is the unification this starts.
- **How it unifies:** one name for "the model does not score this", rather than
  each page inventing its own silence.
- **A held-out test would look like:** week-to-week rank correlation for K and DEF
  against the four skill positions over several seasons. If they are genuinely
  near-random the exclusion is right and this PR is the correct fix forever; if
  they are not, the right fix becomes scoring them, and this PR's `not_modelled`
  field is what would make that change visible.
