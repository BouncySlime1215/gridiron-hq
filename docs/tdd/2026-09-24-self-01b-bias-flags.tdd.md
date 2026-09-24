# SELF-01b: bias flags and the War Room follow / ignore card

Unit SELF-01b (ENGINE-SPECS.md, row "SELF-01b", branch `claude/handoff-package-2026-09-22`).
Branch `claude/cloud-self-01b`, cut from PR #245's head (`ca0e2cdf`, SELF-01a follow ledger).
PR #231's head (`cce5005e`, the War Room) is merged in so the card has a place to go, and so is
origin/main. Merge #174, then #245, then #231, then this PR. After that, this PR's diff shrinks to the files below.

## 1. What exists, and extend or build

| Surface | Table / writer | Used here as |
|---|---|---|
| Follow ledger (#245) | `follow_ledger` (081); `logShown()` / `resolveDue()` in `server/services/engine/follow-ledger.js` | which calls he followed or skipped: rows with `outcome` in (`follow`, `ignore`) |
| Trade outcome ledger | `trade_outcomes` (067); `settleObservedOutcomes()` in `server/services/trade-outcomes.js:113` | his accepted, observed trades |
| ESPN transactions | `league_transactions_raw` (DDL at `scripts/collect-league-transactions.mjs:21`) | the scoring period of each trade (`scoring_period`, joined on `espn_tx_id`) |
| Realised points | `player_gamelog` (`server/db/schema/core-and-fantasy.js:348`) | points each side scored over the 4 weeks after the trade |
| War Room (#231) | `client/src/components/warroom/*`, `GET /trades/:id/war-room` | the new "You, from your own moves" panel sits in its grid |

**What was built.** `server/services/engine/self-bias.js` is a new read-only reader. No table and no
migration: flags are computed on read.

## 2. Pre-registration (fixed 2026-09-24, before any flag was computed on real rows)

- `MIN_FIT_N = 4`: a category needs at least 4 events from earlier weeks before it can be active in a week.
- `MIN_EVAL_N = 4`: a flag needs at least 4 forward predictions before its precision is read.
- `OVERPAY_HORIZON_WEEKS = 4`: a trade is scored on realised points in weeks sp+1 to sp+4. It is
  scored only once those weeks are over: season finished, or the week is below `leagueCurrentWeek`.
- The PRE rule (ENGINE-SPECS SELF-01b, "PRE per flag"): the flag's precision on Nick's own forward
  weeks must be strictly above its base rate, or the flag is not shown. The base rate is the hit rate
  of all events in the weeks where the flag was active.
- All three constants are guesses. None was fitted.

## 3. Definitions

| Bias | Event | Hit | Categories |
|---|---|---|---|
| `ignores` | a follow_ledger row resolved to `follow` or `ignore` | `ignore` | the kind, and kind × position of the pick's player(s) |
| `overpays` | an observed, accepted trade Nick was party to, with its horizon over | he sent more realised points than he got | `acquire:<position>` for each position he received |

- `no_action` and open rows are not events. An unchanged lineup is not a skip, and a missing capture is
  not anything. They are counted per kind and shown on the card as "no move" and "open".
- A trade is left unscored when it has no scoring period, its horizon is still open, a player has no
  local row, it is one-sided, or its items don't parse. Each case is counted by reason, in `trades.unscorable`.
- **Walk-forward** (`walkForward()`): the weeks are replayed in order. In each week the model fits on
  earlier weeks only. A category is active when its earlier rate is strictly above the earlier overall
  rate, over at least `MIN_FIT_N` events. Every event in an active category counts as a forward prediction.
- A per-position flag is dropped when its parent kind is shown with at least the same precision.
- **Killed, not built:** endowment and post-loss panic (`KILLED_BIASES`).

## 4. TDD record

| Round | Commit | `test/self-01b-bias-flags.test.js` + `test/war-room-self-card.test.js` (Node 22) |
|---|---|---|
| RED | `e43a103b` test: RED bias flags and War Room follow/ignore card (SELF-01b) | 0 pass / 15 fail, all on behaviour against stubs. Test 1: `'waiver is a candidate'` (`expected: true`, the stub returns no candidates) |
| GREEN | `b8241bdd` feat: bias flags and War Room follow/ignore card (SELF-01b) | 17 / 17 (2 boundary tests added after the sweep, below) |

One test was fixed during GREEN because the test itself was wrong: test 6 looked up `period === 1`, but
`period` is `season * 100 + week` by design (documented in `walkForward()`). The lookup now uses
`SEASON * 100 + 1`.

## 5. Mutation sweep

Script: 16 rows, run against the two test files. Unit mutants and call-site mutants.

| # | Mutant | Result |
|---|---|---|
| M1 | active needs `>` overall → `>=` | survived the first set; **killed** by the "only ties the overall rate" test |
| M2 | shown needs precision `>` base → `>=` | survived the first set; **killed** by the "equal to the base rate" test |
| M3 | no minimum forward n | killed |
| M4 | fit sees the current week (leak) | killed |
| M5 | overpay sign flipped | killed |
| M6 | counterparty side not swapped | killed |
| M7 | horizon check removed | killed |
| M8 | `no_action` counted as an event | killed |
| M9 | child-of-shown-parent dedupe removed | killed |
| M10 | declined trades scored | killed |
| M11 | call site: view ignores `GRIDIRON_SELF_CLONE_ENABLED` | killed |
| M12 | call site: view serves `held_by_reason` | survived the first set (the regex missed the key); **killed** after tightening it |
| M13 | call site: WarRoom passes `null` to the card | killed |
| M14 | card drops the base rate | killed |
| C1 | control, designed to survive: precision rounded to 5 dp instead of 4 | survived, as designed |
| C2 | control, designed not to apply: search string absent | not applied, as designed |

## 6. Five questions

1. **Well built?** A read-only reader with no migration. Its one entry point is `selfBiasFlags()`.
   The route checks league membership first, then the War Room switch, then `GRIDIRON_SELF_CLONE_ENABLED`.
   All three default to off.
2. **Stats or made up?** The flags are counts and rates from his own rows. The thresholds (4, 4,
   4 weeks) are guesses and are labelled as guesses.
3. **How we know.** The engine is checked by the fixture tests and the mutation sweep. For the flags,
   the only evidence is the forward check on his own record. That check has **not** been run on the real
   database from this cloud session; the PR carries a `LOCAL:` line for it. There is no backtest.
4. **Pointed anywhere else?** Only at the War Room card, `GET /trades/:id/war-room/self`. Coach, the
   trade engine and projections do not read it.
5. **How it unifies.** It reads the SELF-01a ledger and the 067 outcome ledger. It writes nothing
   anywhere, and it follows the War Room's Field contract (ok / unknown / failed, with no value on unknown).

- **Gap filled:** SELF-01a records follow and ignore but grades nothing (`follow-ledger.js:1-8`, "Grading is SELF-01b's job").
- **Incumbent:** none. On the #245 head (`ca0e2cdf`), `git grep -ln follow_ledger ca0e2cdf -- server`
  lists only the migration, `follow-ledger.js` (its own `followSummary()`) and `scheduler.js`, so nothing else reads it.
- **Not covered:** the doubly robust OPE grading of follow against ignore, and the start/sit near-tie
  discontinuity design. The spec gates both on n (about week 8). Also not covered: a regret ledger, the
  concession guard, and the LIVING-01a activity model pointed at Nick.
- **What would make it wrong:** if ESPN's `scoring_period` on a trade row is not the week it
  executed, the horizon shifts. And realised points ignore roster fit, bye cover and the rest of the season,
  so "overpay" here means "lost the 4-week points exchange", not "lost the trade".
