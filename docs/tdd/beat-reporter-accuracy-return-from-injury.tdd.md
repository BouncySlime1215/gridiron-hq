# TDD evidence: return_from_injury, the third beat-reporter claim type (2026-09-22)

**Item:** Self-directed unit, picked after role_change shipped. `return_from_injury` is
the third of the two claim types PART 5 asks Coach's source-map to score
(`injury_status`, `role_change` already shipped; `transaction`/`suspension` deliberately
not attempted — each needs its own ground-truth read). Unlike `role_change`, this one
does not need a new ground-truth read at all: "did this player log an offensive snap"
is exactly the same question `injury_status` already answers, just read from the other
side ("expected back" vs. "ruled out").
**Files:** `server/services/beat-reporter-accuracy.js` (new exports
`classifyReturnDirection`, `resolveReturnFromInjuryClaim`, `resolveReturnFromInjuryClaims`;
refactor: extracted the shared `playedOrNot(team, game, playerId)` helper out of
`resolveInjuryClaim` so both claim types call the same ground-truth read instead of
each carrying its own copy); `test/beat-reporter-accuracy.test.js` (12 new tests).
**Source:** `beat-reporter-accuracy.js:225-283` (this unit); `:128-149` (`playedOrNot`,
the shared helper this unit required extracting); `:56-62` (`classifyInjuryDirection`,
the sibling classifier this one's shape follows); PART 5 (Nick's ask: "Score sources
historically... whose reports actually predicted outcomes").
**LLM spend:** $0.
**Environment:** cloud box, isolated temp SQLite per test file; real-data hand-check used
free nflverse 2025 CSVs already in the session scratchpad (`snap_counts_2025.csv`,
`games.csv`).

## The five questions

- **Well built?** Yes, and it came out smaller than the other two claim types because it
  reuses rather than repeats: `locateGameAndPlayer` (team/game/player lookup) and
  `playedOrNot` (the played-or-not ground truth) are both shared with `injury_status`,
  extracted from it rather than copy-pasted — `resolveReturnFromInjuryClaim` is the
  vocabulary (`RETURNING`/`STILL_OUT`) plus a two-line predicted/actual comparison, the
  same shape as `resolveInjuryClaim` with the poles read from the opposite side. RED
  (`a95c072`) fails all new assertions against the pre-fix code; GREEN (`cbb3278`) passes
  46/46 in the file.
- **Stats or made up?** No number is introduced by this unit itself — like `injury_status`,
  it is a classification (returning/still_out) checked against a real snap count, not a
  measurement with a confidence interval. The one place a number could be silently wrong is
  the regex vocabulary, which is why it was checked against real claim-style text over real
  2025 outcomes rather than trusted from the synthetic tests alone (§4).
- **How do we know?** RED (`a95c072`) fails the return_from_injury assertions against the
  pre-fix code — confirmed by running the suite before `classifyReturnDirection` and the two
  resolvers existed, not just inspecting the diff. GREEN (`cbb3278`) passes 46/46 in
  `beat-reporter-accuracy.test.js` (12 of which are new to this unit). A real-data hand-check
  against Marvin Harrison Jr.'s (ARI, WR) actual 2025 IR stint found a real bug — the
  `RETURNING` regex's `activated from (the )?ir\b` did not match "activated from injured
  reserve" as reporters actually write it out — fixed before this unit was called done (§5).
  2x-verify below, guard pair on the local tree, held short of a push per the coordinator's
  09/22 11:17Z note (resume non-pushing work only).
- **Pointed anywhere else?** No. `locateGameAndPlayer` and `playedOrNot` were extracted
  from inside `resolveInjuryClaim` into standalone functions so `return_from_injury` could
  call them too — `resolveInjuryClaim`'s own behavior and its existing tests are unchanged
  (the extraction is refactor-only, confirmed by the full injury_status test block staying
  green with no edits). No route, no client file, no other claim type touched.
- **How does it unify?** It is the same architecture `role_change` already established
  (a dedicated keyword classifier + a resolver that compares predicted vs. actual and falls
  back to `'unresolved'` with a printed reason rather than guessing) applied to a claim type
  that, uniquely among the three shipped so far, shares its ground-truth read verbatim with
  an existing one instead of needing a new one — which is why this unit's real code addition
  is smaller than either of the first two despite covering a full third claim type.

## 1. What `return_from_injury` claims, and why it reuses `injury_status`'s ground truth

A `return_from_injury` claim ("activated from IR and expected to play" / "remains on IR,
will not return") is asking the same underlying question `injury_status` asks — will this
player log an offensive snap in the next game — just phrased from the other side: a
sidelined player who is expected to stay out vs. a sidelined player who is expected to come
back. Building a second ground-truth read for this would have meant re-deriving exactly
`playedOrNot`'s logic (the teammates-have-data-but-this-player-doesn't inference in
particular) a second time, with a second chance to get the edge case wrong. Instead,
`playedOrNot(team, game, playerId)` was pulled out of `resolveInjuryClaim` as a standalone
function so both claim types call the identical implementation.

## 2. The classifier

```js
const RETURNING = /\b(activated from (the )?(ir|injured reserve)\b|designated (for|to) return|
  eligible to return|cleared to return|will make his return|expected to return|
  returns? to action|off (the )?injured reserve|removed from (the )?injured reserve|
  practice window (has been |was )?opened?|returning (to action|this week))\b/i;
const STILL_OUT = /\b(will not return|has not been cleared to return|
  remains? on (the )?injured reserve|not (yet )?ready to return|to miss (another|more) week|
  stays? on ir|another week away)\b/i;
```

No existing rule set covers this vocabulary — `STATUS_RULES`/`ROLE_RULES`
(`nfl-news-signal.js`) classify current availability and role, not "activated from IR"
language — so this is its own classifier, checked in the same order/precedence discipline
as `classifyInjuryDirection`: a definite claim (`RETURNING`/`STILL_OUT`) wins, and text that
commits to neither returns `null` rather than a guessed default.

## 3. The resolver

`resolveReturnFromInjuryClaim` follows `resolveInjuryClaim`'s exact shape: classify
direction → locate game/player (shared `locateGameAndPlayer`) → read ground truth (shared
`playedOrNot`) → compare predicted vs. actual. The only difference is which direction maps
to which predicted outcome: `returning` → predicted `played`, `still_out` → predicted
`did_not_play` (the mirror image of `injury_status`'s `sidelined`/`clear`). Every
unresolvable case — no direction classified, team/player/position not found, game not yet
played, no snap data yet — returns `resolved_state: 'unresolved'` with a printed
`resolved_reason`, never a guess.

`resolveReturnFromInjuryClaims` is a one-line call into the already-shared
`resolveAndStore(events, resolverFn, asOf)` batch loop (the same one `role_change` and
`injury_status` use), scoped to `claim_type = 'return_from_injury'`.

## 4. Fixture design: date/week collisions across a shared, non-reset test DB

`locateGameAndPlayer`'s game lookup (`WHERE team_id = ? AND date >= ? ORDER BY date ASC
LIMIT 1`) reads across every scheduled game for a fixture team regardless of season/week,
and `schedule_games` carries `UNIQUE(season, team_id, week)`. Test fixtures in this file
accumulate across the whole run (no per-test DB reset), so a new test block's week number
and date must not collide with any earlier block's `makeGame()` call anywhere in the file.
`role_change` had already claimed weeks 1-2, 7, 14-21 (2026-2027 dates); this unit's blocks
use weeks 22-30 with dates 2027-04-12 through 2027-06-21, chosen to be both fresh week
numbers and later dates than every existing block so `ORDER BY date ASC LIMIT 1` cannot
pick up an earlier test's game by accident.

## 5. Real-data hand-check: the bug this unit actually found

Reused the session's free nflverse 2025 CSVs (`snap_counts_2025.csv`, `games.csv`) already
downloaded for the `role_change` hand-check. Case: Marvin Harrison Jr. (ARI, WR), who
missed real 2025 weeks 11-12 with no snap-count row (a real absence, not a fixture) and
returned week 13 with a real recorded `offense_pct`. Built claim text as a reporter would
plausibly write it ("Harrison has been activated from injured reserve and is expected to
play."), checked at week 13 (his real return) and, separately, at week 12 (while he was
still actually out, to check the contradicted path against a real non-return).

**First run found a real bug**: `RETURNING`'s IR clause was `activated from (the )?ir\b`,
which matches the literal abbreviation "IR" but not "injured reserve" spelled out — exactly
how the real claim text (and most real wire copy) says it. `classifyReturnDirection`
returned `null` instead of `'returning'`, so the claim would have gone `unresolved` in
production against real reporter language, not merely against contrived test text.

| case | claim | classified | real outcome | resolved |
|---|---|---|---|---|
| Harrison, checked at his real return week (13) | "...activated from injured reserve and is expected to play." | `returning` (after fix; was `null`, unresolved, before it) | played, real offense_pct on record | `confirmed` |
| Harrison, same claim checked at week 12 while still actually out | same claim text | `returning` (after fix) | no snap row — did not play | `contradicted` |

Fixed by widening the clause to `activated from (the )?(ir|injured reserve)\b`. Both real
cases then resolved correctly, and none of the 46 tests regressed. This is the same
category of finding CLAUDE.md's `nfl-news-events`/`page-explain` history warns about —
production text differs from what a synthetic test assumed — caught here specifically
because the hand-check used real claim-style phrasing over real outcomes instead of relying
on the synthetic fixtures alone.

## 6. Regression

```
node --test test/beat-reporter-accuracy.test.js
# tests 46
# pass 46
# fail 0
```

**2x-verify, guard-v3 form** (no `set -e`; `rc=0; npm run check || rc=$?`; no `| tee`; log
outside the repo; `find . -path ./.git -prune -o -newermt "@$t0" -type f -print` afterward),
run on the local tree at commit `e189567` (this evidence commit) — **held short of a push**
per the coordinator's 2026-09-22T11:17Z note (resume on non-pushing work only until Nick
restores push):

| pass | worktree | exit | tree hash before/after | status before/after | tests | files touched outside `client/dist/` |
|---|---|---|---|---|---|---|
| 1 | `/tmp/claude-0/return-verify-1` | 0 | `074371d9` / `074371d9` (unchanged) | empty/empty | 3168/3168 pass (3209 incl. 41 skipped), 0 fail | none |
| 2 | `/tmp/claude-0/return-verify-2` | 0 | `074371d9` / `074371d9` (unchanged) | empty/empty | 3168/3168 pass (3209 incl. 41 skipped), 0 fail | none |

Both passes identical. Held at `e189567` pending Nick restoring push authority.

## 7. File ownership

`beat-reporter-accuracy.js` and its test file are this unit's own scope, already owned by
this thread across all three claim types. No route, no client file touched — the two Coach
tool/catalog surfaces (`source_trust`, `nfl_news_events`) already describe
`beat_reporter_claim_resolutions` generically enough to cover a third `claim_type` value
with no code change there.

## 8. Known limits

- **Vocabulary is still finite.** The real-data hand-check found and fixed one gap
  (spelled-out "injured reserve"); it does not prove no other real reporter phrasing is
  missed. Same limit as `role_change`'s and `injury_status`'s hand-checks — a small number
  of real cases, not a corpus scan.
- **No new ground-truth read.** This was a deliberate scope choice (§1), not an oversight —
  a claim type that shares its ground truth with an already-proven read is lower-risk than
  inventing a new one, and PART 5's other two remaining types (`transaction`, `suspension`)
  do need their own reads, which is exactly why they were not attempted alongside this.
- **Push no longer held.** The 11:17Z hold applied while push authority was suspended; Nick
  restored it generally at 07:13Z (confirmed again in the 15:42Z resume order), so this
  lands as a normal push once the guard-pair above is recorded, not as an exception to that
  note.
