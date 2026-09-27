---
name: feature-audit-shipped-prs-55-57
description: What the feature-audit thread shipped from the week-2 fantasy sense-check — seven branches, what each fixes, and the one theme they share.
metadata:
  type: project
  modified: 2026-09-20T02:20:00.000Z
---

Feature-audit thread (cse_01XL5WQkomfhtJ925G1wZ9yr). All branch from
`origin/main` at **791b131** unless stated. Draft PRs, none merged.

| PR | Branch (suffix of `claude/project-thread-5f9c3y-`) | Head | Fixes |
|----|-----|------|-------|
| #55 | `consensus-season` | **9d44431** (origin d3eb62d, push at go) | last season's ESPN ADP voted at **double weight** on this season's draft board; `espnMarketFreshness` now reports which season |
| #57 | `trade-week` | **7c27517 PUSHED** | `tradeWeekContext()` took the week from the betting feed, falling back to 1; `availability_source` on the asset; **plus F1 and F2, below** |
| #62 | `waiver-kdef` | **b61b557** (origin 25d911c) | no kicker or defense could **ever** be recommended (two independent causes); **plus F4, below** |
| #64 | `week-callers` | 1b66a80 (origin 7eb5118) | seven more week reads pointed at the league; test 1 rewritten after an injection |
| #67 | `byerisk-honest` | **305c612 PUSHED** | bye risk called an unrun search a verdict; **based on #62, not main**; two of its four tests rewritten |
| **#74** | `window-honest` | **b5f3996** (origin 6457d97, push at go) | contention window's core-age axis gated on `isDynasty`; opened 02:00Z after a clean full check |

The findings added after those six branches — F1 the coordinator base, F2 the
season horizon, F4 the waiver confidence, F3 which was NOT built, and the Trade
Lab need guard: [[gridiron-feature-audit-findings-f1-f4]]. Two surfaces nothing
reads: [[gridiron-server-surfaces-with-no-client-reader]]; one module nothing
imports: [[gridiron-espn-market-has-no-caller]].

**FREEZE 01:58Z**: no pushes to PR branches, no new PRs, no comments. I pushed
four times after it and before reading it (#74 branch + PR 02:00Z, #57 02:09Z,
#55 02:10Z, #67 02:12Z), reported each, nothing since. #57 already being at
7c27517 on origin is why this thread needs no -hold branch
([[gridiron-held-branches-2026-09-20]]).

**Every head checked clean, exit 0** (typecheck, lint, suite, build,
start:smoke), 41 skipped throughout: #55 9d44431 2955/0, #57 7c27517 2973/0,
#62 b61b557 2964/0, #64 1b66a80 2967/0, #67 305c612 2961/0, #74 b5f3996 2964/0.
**Go-list of pushes owed:** #55 d3eb62d→9d44431, #62 25d911c→b61b557,
#64 7eb5118→1b66a80, #74 6457d97→b5f3996. #57 and #67 already final on origin.

Heads as of 2026-09-20 ~02:50Z, each carrying its `docs/tdd/` evidence file as a
commit on the code branch (the 01:31Z board rule: **no docs-only PRs**). **#62 and #64 merge clean with each other** (real merge in a detached worktree
~01:50Z; re-probed with `git merge-tree` at `9ecebf4` after F4, still 0
conflicts against #64, main and #67). #67's base is #62's branch, so #62 first.

The theme all of these share, and it is the useful part:
[[gridiron-confident-numbers-from-searches-that-never-ran]].

**Deferred on purpose, not forgotten:** the window does not read O4's Team
Outlook verdict — `team-outlook.js` is not on main, AND the O4 model cannot run
on Fly at all (`data/derived/` is not in the image), so there is no verdict to
point at. Fantasy plan must persist the fit in the app DB first. The `act`
gating of Trade Lab stays out by agreement with Opportunity.

Silent fixture traps these branches were rebuilt around:
[[gridiron-test-fixture-traps]] and [[mocking-trade-engine-in-tests]].

What the injections found: [[gridiron-injections-that-did-not-bite]].

Related: [[espn-adp-double-weight-on-draft-board]],
[[feature-audit-espn-market-sweep-943d2c5]], [[espn-market-caller-decision]], [[gridiron-fantasy-audit-open-items]],
[[github-actions-freeze-2026-09-20]].
