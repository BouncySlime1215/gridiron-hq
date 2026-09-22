# Phase 0 — feature-audit thread branches vs main 654ff93

Measured 2026-09-22 ~01:33Z, local, read-only. Main = 654ff93 (#63, #52, #49
squash-merged by Nick). Nothing resolved, nothing pushed.

## 1. merge-tree against 654ff93 — ALL CLEAN

Nine no-PR holds: alternation-hold 9393762, docpaths-hold c0571a9,
espn-market-auth-hold 48ec7ce, tradeimpact-hold 860e1a2, draft-chain-hold
c6df372, unpriced-hold ec13adb, inbox-stop-hold b104fab, season-weeks-hold
b048c86, roster-read-hold 9fc851e — all merge clean, zero conflicts.

Five PR branches (remote heads): #55 consensus-season d3eb62d, #57 trade-week
7c27517, #62 waiver-kdef 25d911c, #64 week-callers 7eb5118, #74 window-honest
6457d97 — all merge clean, zero conflicts.

trade-week-hold eb55f1d — clean.

The zero-overlap result from before the merge holds: the six merged files
(scheduler.js, loop-watchdog.js, index.js, fly.toml + tests) are touched by
none of these branches, so nothing conflicts and nothing is reintroduced.

## 2. Each hold vs its PR branch — all holds AHEAD, FF still applies

| PR | branch head | hold head | relationship |
|---|---|---|---|
| #55 | d3eb62d | 9d44431 | hold ahead; PR→hold FF clean; hold adds **docs only** |
| #57 | 7c27517 | eb55f1d (trade-week-hold) | hold ahead; adds **code** (self-scout test) + docs |
| #62 | 25d911c | b61b557 | hold ahead; adds **code** (waiver-brain.js) + test + docs |
| #64 | 7eb5118 | 1b66a80 | hold ahead; adds **code** (test) + docs |
| #74 | 6457d97 | b5f3996 | hold ahead; adds **code** (tradelab.js) + test + docs |

Every PR branch is BEHIND its hold. The pending action (fast-forward the PR
branch up to the hold head) still applies cleanly, exactly as before the
freeze.

## 3. PR-body check figures — 3 name their commit, 2 do not; ALL need re-measuring

| PR | figure | names commit? | usable as-is? |
|---|---|---|---|
| #55 | 2955/2914/0/41 | yes, d3eb62d = head | no — main moved; hold adds docs only, so code figure holds but must be re-confirmed at FF head vs 654ff93 |
| #57 | 2973/2932/0/41 | yes, 7c27517 = head | no — hold adds a code file beyond the head; re-measure at eb55f1d vs 654ff93 |
| #62 | 2,957 / 0 failed | **NO commit named** | no — hold adds waiver-brain.js beyond the head; re-measure |
| #64 | 2,967 / 0 failed | **NO commit named** | no — stacked on #57; re-measure |
| #74 | 2957/2916/0/41 | yes, 6457d97 = head | no — hold adds tradelab.js beyond the head; re-measure |

Every figure was measured at the PR head. Four of five holds carry code the PR
head does not, and main has moved under all of them, so no figure can be
reused on fast-forward — each must be re-measured at the FF head against
654ff93 before any push. This is the standing pre-push rule, not a new problem.

## 4. Two content overtakes now LIVE (were latent before the merge)

- **#55 consensus-season evidence** (`docs/tdd/consensus-season.tdd.md`): the
  paragraph "NFL_SEASON is not set in production — fly.toml's [env] holds only
  HOST" is FALSIFIED by #52, which merged into 654ff93 and adds
  `NFL_SEASON = "2026"` to that block. Fix: repoint to #52. Docs edit on a
  PR-bearing branch.
- **#62 waiver-kdef evidence**: cites `server/index.js:129` for the
  decision-inbox mount; #63 (merged) inserted 8 lines above it, moving the
  mount to :137. Cite by content, not line.

## 5. Structural notes for the deploy/merge sequence

- #64 is stacked on #57 (base = trade-week aca74f9), mergeable_state
  "unstable", carries 1 review comment. Its base must move to main (or #57
  must land first) before it is mergeable on its own.
- #57 and #62 both edit waiver-brain.js on branches off different bases; the
  hunks are close but non-adjacent (noted in #64's own body).
