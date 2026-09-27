# COACH-CHAIN: after this move, what fills the hole

RED `c04a7884` · GREEN follows · `test/coach-chain.test.js`, 10 cases.

## What it is

Nick: "this is what coach should be doing ... getting me ok after we have this move lets go trade for
this player to fill this hole", then: "a trade is only as good as its next steps".

- `server/services/campaign/chain.js`: `chain(adapter, moves, ctx)` applies Nick's moves in sequence to
  a roster copy. Per step: lineup points a week and playoff odds from the campaign world's rescore (the
  War Room plan's world and seed), Nick's rules (`never-give.js#ruleVerdict`), the hole (his weakest
  starting slot against the same slot on every team) and the rule-passing fills (the planner's
  `searchTarget`, direct paths; flip claims when the world simulates free agents).
- `server/services/campaign/chain-lookahead.js`: expectimax over acceptance, three moves deep, on the
  same dice. `V_L(s) = max(V_(L-1)(s), max_m [p_m V_(L-1)(s+m) + (1 - p_m) V_(L-1)(s)])`. First moves are
  ranked by continuation value, with "now" and "with the best follow-ups" beside it, and the
  wait-then-best baseline.
- Coach intent (`coach/chain-intent.js`, flag `GRIDIRON_COACH_CHAIN`): words to moves, the chain in the
  engine worker, a `chain_read` ledger, verdict-format lines that verify.js grounds; the model only
  narrates the rows.
- `ChainView` (client): the card, full on a page, compact in the drawer.

## Cases

1. moves apply in sequence on a copy; each number equals the world rescore of that state;
2. the chain stops at 3 steps; a player the chain brought in is never traded on;
3. a hole is found (rank, median gap, replacement gap); the slot lineup starts who the sim starts;
4. flip claims appear only with a claim universe, and the claimed player is always flipped;
5. RULE-FUZZ over 40 made-up leagues: every fill, suggested step and ranked lookahead move passes the
   gate's rules (0 violations; 189 fills, 76 suggested steps, 542 lookahead moves);
6. a protected player's step needs Nick's OK (never a plain Send), and Coach says so;
7. question parsing, name resolution, ambiguous names asked about;
8. the $0 answer cites only `chain_read` cells;
9. a recorded narration ships only its grounded lines; an invented number never ships;
10. the flag: default off, on with its own flag or preview, `0` vetoes preview.
