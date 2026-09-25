# WAIVERS PERISHABLE (plan item 13, research R10)

2026-09-25. Off `main` `9eb9d57d`. New `server/services/waiver-perishable.js`;
wired into `waiver-wire.js#claimPriority`, `roster-risk.js#fragility`,
`contingency.js#handcuffValue`, `streaming-board.js#streamingBoard`.
Test: `test/waivers-perishable.test.js` (10 tests).

## Why

ONE-PLAN 4d spot-check row 9: league 4 resets the waiver order weekly
(`waiverOrderReset = 1`, CONFIRMED), so priority not spent this week is gone.
Section 4d: "claim real upgrades before the reset; handcuffs only after a
workload test". Nick's item 13 adds: DST streaming reads points allowed.

## Pre-registration (written before the GREEN commit)

| Rule | Metric | Pass bar | What fails it |
|---|---|---|---|
| (a) never advise "save priority" | `advisesSavingPriority` on every served priority line in a weekly-reset league | 0 hits; `assertPerishable` throws on any | any canned or composed line matching the save-priority pattern in a reset league |
| (b) handcuff needs a workload test | `handcuffWorkload` on the cascades evidence | passes only with >= 2 games without the starter AND >= RB 12 / WR 6 / TE 4 / QB 25 opportunities a game (guesses, chosen not fitted) | a thin (1-game) or light-workload backup passing; the fragility reading advising a handcuff unconditionally |
| (c) DST reads points allowed | `paTier` at the market's expected points allowed, the league's own per-tier points | correct ESPN tier and league points on fixtures; ranking and suggestion identical flag on vs off | a tier mismatch, a 0 where the league pays nothing (must be null), or any change to ranking/suggestion |

Nothing served moves a number. The new fields appear only with
`GRIDIRON_WAIVERS_PERISHABLE=1` and are labelled `shadow: true`. Rule (a) is
always on: it only refuses wording.

## RED

Commit `9143aea4`: the test file alone. Run:

    Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/waiver-perishable.js'

With the module present but before wiring, 7 pass / 3 fail (claim_priority
perishable block, fragility wording, streaming-board points-allowed fields).

## GREEN

    ok 1 - (a) save-priority wording is detected in its common phrasings
    ok 2 - (a) a weekly-reset league refuses save-priority text; a rolling league may say it
    ok 3 - (a) flag off: claim_priority is exactly as before (no perishable block)
    ok 4 - (a) flag on: a weekly-reset league says priority is perishable and to claim before the reset
    ok 5 - (b) a backup who carried a real workload in games the starter missed passes the workload test
    ok 6 - (b) too few games, or too little work when the starter sat, fails the test
    ok 7 - (b) the fragility reading no longer advises a handcuff without the workload test
    ok 8 - (c) paTier maps expected points allowed to the ESPN tier and the league's points for it
    ok 9 - (c) flag off: the streaming board carries no points-allowed fields
    ok 10 - (c) flag on: each defense reads expected points allowed and the league tier, ranking and suggestion unchanged
    # pass 10
    # fail 0

## Not confirmed

- The workload bars are guesses. Grading them needs league-4 history of
  backups who became starters (local only).
- Tier-at-expectation ignores the spread of real scores; it is a label, not a
  projection, and the board does not rank on it.
