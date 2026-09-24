# SELF-01a: the follow ledger

Unit SELF-01a (ENGINE-SPECS.md, row "SELF-01a", branch `claude/handoff-package-2026-09-22`).
Branch `claude/cloud-self-01a-07ofag`, cut from PR #174's head
`claude/local-gr-01-recommendation-ledger` (`442d7a4e`), with origin/main merged in (`d861c11c`).

## 1. What exists, and extend or build

| Surface | Table / writer | Used here as |
|---|---|---|
| GR-01 recommendation ledger (#174) | `rec_ledger` (071); `record()` / `recordRoute()` in `server/services/rec-ledger.js` | source of every shown call: live through the `recordRoute()` hook, and a backfill of rows frozen before this ledger |
| ESPN lineups | `league_roster_snapshots` (058); writer `scripts/collect-roster-snapshots.mjs:102` `writePeriod` | what was started, per scoring period; `lineup_locked` for lock |
| ESPN transactions and offers | `league_transactions_raw` (no migration; DDL inline in `scripts/collect-league-transactions.mjs:21`, upsert at `:34`) | waiver/FA adds, trade proposals and accepts |
| ENGINE-00a `engine_events` | #216, migration 075, **not merged** | not used. The spec says "logged as an engine event"; that cannot be built on a table that does not exist on main. See "Not confirmed". |
| `forward-ledger.js`, `decision-basis.js` | betting-side | read only, as the spec asks: nothing to reuse; both are NFL betting modules |

**Build a new table, `follow_ledger` (migration 081).** `rec_ledger` holds one row per (call, grading
horizon) and grades the call on points; this holds one row per decision shown and records what Nick did.
Neither stores the other's number; `rec_ledger_hash` joins them.

## 2. Pre-registration (fixed before any row resolved)

- `NEAR_TIE_EPSILON = 1.0` projected fantasy point (`server/services/engine/follow-ledger.js`). A guess,
  not fitted. Stored on every start/sit row (`epsilon`), so a later change cannot rewrite an old flag.
- `WINDOW_DAYS = 7`: a waiver or trade move counts as the response to a call if it lands in
  [shown_at, shown_at + 7 days]. A guess.
- Start/sit resolves at lock: league clock past the week, or ESPN has locked both players.

## 3. Definitions

| Action | follow | ignore | no_action |
|---|---|---|---|
| start/sit (live, shown-time pair state known) | pair changed since shown, final lineup starts the pick and benches the alternative | pair changed, final lineup does not carry the call | pair state unchanged since shown |
| start/sit (backfill, shown-time state unknown) | final lineup carries the call | it does not | never (cannot tell) |
| waiver | executed add of the pick to my team in the window | a different add | no add |
| trade idea | my proposal/accept in the window bringing any `get` player to me | another proposal/accept | none |
| War Room next move | as its `action` above | | |

`complied` (1/0) is stored alongside: whether the final state carries the call, whatever the outcome.
A missing capture (no lineup rows for my team, no raw transaction table, no ESPN id, unreadable
items_json) leaves the row open with `unresolved_reason`; it is never `no_action`.

## 4. TDD record

| Round | Commit | Result (`test/self-01a-follow-ledger.test.js`, Node 22) |
|---|---|---|
| RED | `502e6265` test: RED follow ledger (SELF-01a) | 0 pass / 14 fail, all on behaviour against a stub, e.g. test 1 `expected: 1 actual: 0` (rows), test 6 `epsilon is a fixed positive constant` |
| GREEN | `888f037e` feat: follow ledger (SELF-01a) | 15 / 15 (14 RED tests + one added to kill M10 below) |

## 5. Liveness: mutation sweep on the GREEN tree

| Mutant | Change | Result |
|---|---|---|
| M1 | near-tie `<` becomes `<=` | killed (14/15) |
| M2 | drop the `no_action` branch | killed |
| M3 | drop the `no_lineup_capture` guard | killed |
| M4 | `INSERT OR IGNORE` becomes `OR REPLACE` | killed |
| M5 | window start filter disabled | killed (13/15) |
| M6 | lock only by the league clock | killed |
| M7 | resolver re-reads resolved rows | killed |
| M8 | never capture the shown-time lineup | killed (13/15) |
| M9 | any trade action counts as follow | killed |
| M10 | the `disposition` guard removed from `decisionsFromRecs` | **survived** the RED set (backfill SQL and `recordRoute` filter too). Test 15 added; now killed (14/15) |
| call site | `recordRoute` hook removed | killed by test 12 (no live row) |

## 6. Nick's five questions

1. **Well built?** One writer (`insertDecisions`), one resolver (`resolveDue`), one reader
   (`followSummary`). SQL is parameterised. The one catch logs and returns `state: 'error'`. Unreadable
   evidence gets a named reason, never a default.
2. **Stats or made up?** No statistic. The epsilon (1.0) and the window (7 days) are hand-set guesses,
   pre-registered here.
3. **How we know:** fixture tests with exact outcomes per branch and a 10-mutant sweep. No backtest,
   and nothing has run on the real data.
4. **Pointed anywhere else?** Written from the five recommending routes through `recordRoute`, and read
   by nothing yet except `followSummary()` (SELF-01b is the consumer). There is no route and no page change.
5. **How it unifies:** calls come from `rec_ledger` (same `recsFromRoute` shapes, same `inputs_hash`), and
   lineups and moves come from the existing ESPN captures. No new ESPN fetch.
