# CHESS-01a — title-odds chess (trade → claim → flip), TDD record

Unit: CHESS-01-a in `docs/handoff/local/ENGINE-SPECS.md` (branch
`claude/handoff-package-2026-09-22`), cut to the cloud scope: candidate
generation (1-for-1, 2-for-1, trade → claim → flip), scored with
`tradeImpactWorld` (fast rescore), priced with today's P(accept), beam search
depth 3, ranked paths with per-step probability and title-odds delta. Built on
PR #240 (RL-19-3 title-mutual, head `9153296`).

## What changed

- `server/services/title-chess.js` (new): `chessMode` (flag), `generateMoves`,
  `applyMove`, `chessSearch` (the beam), `todaysPAccept`, `titleChess` (the
  engine entry: one world, one search).
- `server/services/season-sim.js`: three additive exports. `rosterImpact(world,
  { myTeamId, rosters })` rescores any set of changed rosters in a prebuilt world
  and refuses a player outside the world's universe. `pairedTitleSe` and
  `expectedLineupTotal` (the shortlist proxy, never shown).
- `server/services/trade-engine.js` `findTradeSequences`: a `chess` block beside
  `sequences`, `{ status: 'off', paths: [] }` when the flag is off. It also takes
  `assetsOverride`, the same seam `findTrades` has, so a fixture league can be
  searched.
- `preview-mode.js` header lists the new converted site. Two suites that stub
  `season-sim.js` with a fixed export list get the three new names (never called).
- No migration. No UI (UI-ENG-5 renders paths; it is its own unit).

## RED

`21b2d91` "test: CHESS-01a RED — a searched trade/claim/flip path must beat every
single offer". On that tree the file fails at import:

    Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/title-chess.js'

Assertion-level RED, with `title-chess.js` and `season-sim.js` present but
`trade-engine.js` as on `21b2d91` (unwired): 9 pass, 1 fail —

    not ok 10 - CHESS-01a: findTradeSequences carries the chess block only when the flag is on
    Expected values to be strictly deep-equal:  + undefined  - { paths: [], status: 'off' }

## GREEN

`1de1b06` "feat: CHESS-01a title-odds chess paths (trade -> claim -> flip beam search)";
`test/chess-sequences.test.js` 10 of 10 pass.

## Merge gate

- `git merge origin/main` (main at `12a6de9`): clean merge. `git status --porcelain` empty.
- `npm ci` run on this fresh clone.
- `npm run check` on tree `f113eab`: **exit 0**. Tests 4,832: pass 4,790, fail 0, skipped 42.
  Startup smoke passed. `git write-tree` before and after: `f113eab` both times.
- This evidence-file edit (docs only) lands after that run.

## Liveness: mutation sweep (unit and call site)

Run on tree `2f35c5c` by a scratch script that applies one mutant, runs
`test/chess-sequences.test.js`, and restores the file.

| Mutant | Where | Result |
|---|---|---|
| M1 flip labelled as trade | title-chess `generateMoves` | killed (test 1) |
| M2 send-back guard removed | title-chess `generateMoves` | killed (test 1) |
| M3 EV uses the step's p, not P(reach k) | title-chess `chessSearch` | killed (tests 3, 7) |
| M4 P(accept) floor `<` → `<=` | title-chess `chessSearch` | killed (test 4) |
| M5 node-budget check removed | title-chess `chessSearch` | killed (tests 5, 9) |
| M6 claim cap read from the node, not today | title-chess `generateMoves` | killed (test 2) |
| M7 unsimulated-player guard removed | season-sim `rosterImpact` | killed (test 6) |
| M8 call site: flag ignored (`if (true)`) | trade-engine `findTradeSequences` | killed (test 10) |
| M9 call site: pairedSe not handed in | title-chess `titleChess` | killed (test 7) |
| M10 call site: wire not handed in | trade-engine `findTradeSequences` | killed (test 10) |
| C1 designed survivor: `limit` 10 → 11 | title-chess defaults | survived, as designed |
| C2 designed not-applied: absent search string | — | not applied, as designed |

M10 survived the first sweep (nothing asserted the free agents reached the
search). Fixed by returning `wire` on the block and asserting it; it is killed
above. M6 is the real bug found while measuring: the claim cap was the current
node's roster size, so a claim after a 2-for-1 still forced a drop.

## Measured

Fixture league, tree `2f35c5c`: 4 ESPN teams, 3 NFL games, the real copula,
1,200 paired runs, `tradeImpactSeed`, weeks 2-3 regular season, 2-team final in
week 4. No counterparty data, so every trade step's P(accept) is the band's
declared start point (0.30, basis `no_information`). One free agent on the wire.

- Search: 196 moves generated, 96 rescored, 0 errors, budget (150) not hit.
  Wall time 1.57 s / 1.27 s (first / second). `findTradeSequences` 35 ms flag
  off, 1.43 s flag on.
- Best single offer: my spare WR for team 3's spare WR, title odds **+0.0550
  (SE 0.0068)**, EV 0.0165.
- Best path (3 moves, P(complete) 0.027): (1) my spare WR for team 2's spare RB,
  +0.0525; (2) 2-for-1, my starting RB and WR for team 3's spare WR (team 3 drops
  its lowest-value player), +0.2950; (3) QB-for-QB with team 4, +0.3342 (SE
  0.0139). EV **0.0386**.
- Path vs best single, paired in the same world: **+0.2792 (paired SE 0.0150)**,
  18.6 SE. EV +0.0221.
- Claims are generated and scored; one appears in the top 10, not in the top 3.

## Nick's five questions

1. **Well built?** A pure search (`chessSearch`) with every league input injected,
   an engine entry that builds one world, and three additive season-sim exports.
   Errors are counted and the first one is returned; a failed world returns
   `status: 'failed'` with the sim's error. 10 tests, 10 of 10 mutants killed.
2. **Stats or made up?** Title deltas are the paired season sim. P(accept) is the
   existing acceptance band's midpoint (a heuristic, labelled as such by its
   `basis`). Depth, beam width, per-node shortlist, node budget, give pool, wire
   limit, P(accept) floor and value band are **guesses**, declared in
   `CHESS_DEFAULTS`.
3. **How we know:** a fixture only. No backtest. CHESS-01-b is the replay test.
4. **Pointed anywhere else?** `findTradeSequences` → `GET
   /:leagueId/find/sequences` (routes/trades.js:817) returns the block. No page
   reads it yet (UI-ENG-5).
5. **How it unifies:** the same world, seed and run count as every other
   title-odds surface (`rosterImpact` equals `tradeImpact` on a one-trade path in
   the same world, asserted), and the same acceptance band findTrades uses.

- **Gap fixed:** `findTradeSequences` (trade-engine.js:2342 on `9153296`) is a
  two-step greedy on lineup points; it cannot see a path whose steps only pay
  together.
- **Incumbent:** `findTradeSequences(lg, opts).sequences`, unchanged.
- **Not covered:** the trade deadline (RADAR-01-a not merged), rival claims
  (claims priced at 1, `rival_claims: 'not_modelled'`), REP-01 lopsidedness
  budget, clone P(accept) (CLONE-01b), MCTS, the counterparty's own title odds.
- **What would make it wrong:** P(accept) that does not track real acceptance
  (the EV ranking would then reward long paths wrongly), or a sim edge that is
  NFL-game correlation noise rather than roster quality (step 3 above, a
  same-projection QB swap, adds +0.039 on game correlation alone; a step's own
  paired SE is not computed, only the cumulative one).
