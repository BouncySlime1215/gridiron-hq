# Adversarial verification — reader G08-nfl-execution (11 claims)

Repo root: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only, no git repo present — commit hashes cited by the reader could NOT be checked via git and were instead checked against in-repo text/comments/tests where possible).

## #41 — nfl-teaser-execution.js:307, unauthenticated settlement from caller-supplied scores — CONFIRMED, P1

Read nfl-teaser-execution.js in full (368 lines).

- `settleTeaserExecution` (line 302-367): line 307 `const scores = Array.isArray(input.scores) ? input.scores : [];` — the function takes `input.scores` verbatim, computes `coverMargin = teamScore - opponentScore + leg.teased_line` (line 321) directly from caller-supplied numbers. There is **no lookup against `game_lines`** anywhere in this function — confirmed by reading the whole function body.
- Line 359-360: `db.prepare('UPDATE nfl_teaser_executions SET status=?,settled_at=?,profit_units=? WHERE id=?').run(...)` — writes the ledger row directly.
- Guard: line 305 `if (execution.status !== 'open') return { error: ... }` — so a given execution can only be settled once via this path (not infinitely re-writable through this function), but a fabricated settlement of an `open` ticket is a one-shot corruption that stands permanently once written (nothing re-validates it later).
- Routes: `server/routes/betting-hub.js:450` `r.post('/teasers/executions/:id/settle', ...)` calls `settleTeaserExecution(req.params.id, req.body ?? {})` with **no `requireModelPermission` wrapper** (confirmed by grepping every `r.post` in the file and checking which ones have `requireModelPermission` — this one does not). `server/routes/wong.js:629` `r.post('/tickets/:id/settle', ...)` — same call, same lack of permission.
- `server/index.js:104-107`: `app.use('/api/betting/wong', wongRouter); app.use('/api/betting', bettingHubRouter);` — neither is preceded by `...legacyAuthenticated`/`...legacyAdmin` (compare `/api/leagues`, `/api/tradelab`, `/api/trades`, `/api/players`, `/api/news`, which are). No app-wide auth middleware exists ahead of these mounts either (read all of index.js 1-156). So the claim's "no authentication" is accurate for these two route families specifically.
- Note: the server binds `127.0.0.1` only (`app.listen(PORT, '127.0.0.1', ...)`, index.js:135), so "any client that can reach the API" requires either a local process or a tunnel. Nick's own memory record (`gridiron-phone-access.md`) documents an existing cloudflared tunnel + pairing-code setup for phone access to this exact app, so external reachability is not hypothetical in this deployment.
- Impact confirmed: `teaserExecutionLedger.summary.placed_profit_units` (nfl-teaser-execution.js:295) sums `profit_units` for `mode='placed'` rows, and `profit` is exactly the value fabricated in `settleTeaserExecution`. `nfl-profitability.js:199,205` independently calls the teaser strategy "the only measured-positive strategy" / "closest_path: teaser" and folds `nfl_pick_decisions + shadow_decisions`-style ledgers into the "preregistered forward ledger" framing — teaser executions are the analogous forward-money ledger for this strategy.
- **Verdict: not refuted.** This is real, verified, and high-impact: an unauthenticated write path that lets a caller dictate the outcome (and thus P&L) of a real-money ("placed") ticket with no cross-check against the actual final score. P1 is justified.

## #42 — nfl-auto-picks.js:212, UPSERT conflict target omits policy_version — CONFIRMED but impact overstated, P2 (kept, borderline)

Read nfl-auto-picks.js in full (285 lines) and the `nfl_pick_decisions` schema.

- `server/db/schema/nfl-a-to-m.js:100-108`: `PRIMARY KEY (season, week, policy_id, matchup, market, selection)` — `policy_version` is a plain column, not part of the key.
- `persistPickDecisions` (nfl-auto-picks.js:205-221): `ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET line=excluded.line, american_price=..., book=..., quote_at=..., quote_source=..., edge=..., disagreement=..., eligible=..., abstention_reason=..., policy_rank=..., feature_snapshot_json=..., recorded_at=excluded.recorded_at` — `policy_version` is never in the `DO UPDATE SET` list, confirmed by reading the full SQL text. So a re-run under a newer policy version updates every other column (including `recorded_at`, which becomes "now") but leaves the *original* `policy_version` value in place.
- Live-data corroboration (read-only `node:sqlite` query): `nfl_pick_decisions` for season=2026, week=1 currently has **16 rows, all `policy_version='1.1.0'`**, with `recorded_at='2026-09-12T11:44:42.474Z'` (today, well after `NFL_PRODUCTION_POLICY.version` in `server/services/nfl-policy.js:19` was bumped to `'1.2.0'`, documented at nfl-policy.js:10-16 as a deliberate economics change that "must never be compared as if unchanged" to 1.1.0). This confirms the mechanism is live, not just theoretical (the exact `recorded_at` timestamp the reader cited, `02:16:33Z`, no longer matches because the server has re-run since, but the pattern — stale `policy_version`, fresh `recorded_at` — persists).
- However: I searched for any code that branches on `policy_version` (`grep -rn "policy_version ===" server/`) and found **none** — nothing in this codebase currently compares/gates on this column programmatically. The client type `NflAutoPicks.tsx:19` declares a `policy_version` field but **never renders it** (only occurrence in the file is the type declaration) — and that page actually sources data from the *separate* `nfl_auto_picks` table (via `ensurePicksFor`/`pickResultsFor`), not `nfl_pick_decisions`, so this specific bug's stale column is not even the one feeding the picks page Nick looks at.
- The codebase's own `nfl-decision-tape.js:1-13` explicitly documents this exact defect as the reason the (correctly-versioned, append-only) decision-tape table exists, i.e., the maintainers already know about and have mitigated it at the evidence layer — `nfl_pick_decisions` is kept only as "a MUTABLE latest view" per that comment, and `migrations/027_decision_tape.js` calls it out too.
- `nfl_pick_decisions` is referenced by name (not by value) in `nfl-profitability.js:205` as part of the "preregistered 2026 forward ledger" label, and is read (line/price/quote fields, not `policy_version`) by `nfl-expert-council.js:668`.
- **Verdict: not refuted, but scope narrowed.** The mechanical claim is 100% correct and live-confirmed. The "impact" — mis-attribution reaching forward-ledger/evidence *readers* — is weaker than stated: nothing programmatically branches on this column, and the one UI type that declares it never displays it, and the UI page a user actually reads pulls from a different table. This is a genuine, live, data-integrity defect in an evidence/audit table (which the audit's own "data integrity" criterion covers on its own), not a defect that currently corrupts any number Nick reads or any staking decision. I did not refute it (data integrity alone qualifies per the instructions), but flag that the "forward-ledger and evidence readers... mis-attributed" language overstates concrete downstream consequence.

## #43 — nfl-execution-edge.js:625, stakeFor's model-gate is a deny-list on the literal string 'model' — CONFIRMED code fact, REFUTED impact → P3

Read nfl-execution-edge.js:590-660 (stakeFor and its docstring) in full.

- Line 623: `export function stakeFor({ winProbability, americanPrice, source = 'model', ... })`.
- Line 625: `if (source === 'model' && !(provenClv > 0)) { return { units: 0, blocked: true, ... } }` — confirmed: this is a strict-equality check against the literal string `'model'`. Any other value — `null`, `'Model'`, `'forecast'`, `'execution '` (trailing space) — skips the block and falls through to `kellyFraction`/Kelly sizing at line 629-641.
- Callers today, verified by `grep -rn "stakeFor(" server/`: only `server/services/nfl-teasers.js:272` (fixed string `'execution'`, intentionally allowed) and `server/services/execution-slate-reasoning.js:312-313` (`SOURCE_OF_KIND[c.kind] ?? 'model'`, a closed enum with a `'model'` fallback — see `execution-slate-reasoning.js:115` `SOURCE_OF_KIND` is `Object.freeze({...})`, a fixed map). Neither caller can currently produce an unrecognized string.
- The quoted line "a sizing gate that defaults to permitting is not a gate" is real, but it's a **test-file comment** (`test/execution-slate-reasoning.test.js:57`), not a commit message — there is no git repository here (`git log`/`git show` on the cited hash returns nothing, and no file in the repo mentions "14c5e65"), so I could not verify the "commit 14c5e65" attribution at all; I only verified the *quoted text itself* exists (in a different context — that test is about a *different* gate, `gateOpportunities`'s `qualified` flag, not about `stakeFor`'s `source` string).
- **Verdict: refuted (impact), claim's code observation stands but downgraded.** The deny-list-vs-allow-list design is a real robustness weakness, but by the reader's own admission it is "latent" — no code path today can trigger it, so it changes no number, no stake, and no decision currently. Per the impact lens this should be P3, not P2.

## #44 — nfl-execution-lifecycle.js:166, frozen forecast columns on an untriggered table — CONFIRMED, P2

Read nfl-execution-lifecycle.js:120-200 (openOpportunity) and cross-checked every migration.

- `openOpportunity` (line 125-183) inserts `model_line, model_probability, market_line_at_decision, decision_event_id, push_probability, push_treatment` into `nfl_execution_opportunities` (lines 160-176) — the comment at 127-137 explicitly calls these "frozen" so downstream gates can "read authoritative values later instead of trusting whatever a caller ... happens to supply at acceptance time."
- Grepped every migration file for `CREATE TRIGGER` naming any `nfl_*` table: found `no_update`/`no_delete` triggers for `nfl_execution_lifecycle_events`, `nfl_decision_events`, `nfl_decision_runs`, `nfl_decision_run_invalidations`, `nfl_alt_spread_captures`, `nfl_alt_spread_quotes`, `nfl_quote_batches`, `nfl_capacity_events`, and many `nfl_blind_input_*` tables — **none target `nfl_execution_opportunities`**.
- Confirmed against the *live* database's `sqlite_master` (read-only query): zero triggers on `nfl_execution_opportunities` (full trigger list captured; the table does not appear as a `tbl_name` anywhere in it).
- `nfl-execution-decision.js:28-39` and `:160-162` (read to confirm) use these same columns as gate inputs the file's comments call things "a caller cannot bypass."
- **Verdict: not refuted.** A plain `UPDATE nfl_execution_opportunities SET model_probability=... WHERE id=...` (or a future migration) is not blocked at the schema level, unlike every sibling ledger table in this same lineage. This is a real, verified integrity gap on a table that gates real execution decisions — satisfies the "decision recorded" / "data integrity" criteria directly. P2 is reasonable (not P1, since it requires an out-of-band UPDATE, not something the current HTTP surface exposes).

## #45 — nfl-execution.js:38, payoutPerUnit/breakEvenRate/rankBooks accept price 0 — CONFIRMED with live data match, P2

Read nfl-execution.js in full (through line 180 covering the cited functions and rankBooks/routeBet).

- `payoutPerUnit` (line 37-40): `odds > 0 ? odds/100 : 100/Math.abs(odds)`. For `odds=0`: `0 > 0` is false, so `100/Math.abs(0) = Infinity`. Confirmed.
- `breakEvenRate` (line 47-50): `1/(1+Infinity) = 0`. Confirmed — a price of 0 reports as literally free money with 0% required win rate.
- `rankBooks` (line 73 `usable = quotes.filter(q => Number.isFinite(priceOf(q)))`): `Number.isFinite(0)` is `true`, so a price-0 quote is not filtered out. It is then scored via `advantage()` (line 114-127): `priceEdge = refBreakEven - breakEvenRate(q.price=0) = refBreakEven - 0 = refBreakEven` (the maximum possible edge), so it will win the `.sort((a,b) => b.edge_vs_median - a.edge_vs_median)` at line 129-131 and become `best`.
- Live-data check (read-only): `nfl_line_snapshots` has exactly **one** row with `price=0`: `book='betrivers', market='h2h', side='San Francisco 49ers', provider='free:kambi', captured_at='2026-09-11T03:09:25.514Z'` — an exact match to the reader's cited evidence. I confirmed this is the *only* zero-price row in the whole table (`COUNT(*) WHERE price=0` = 1).
- Caveat found while verifying: at that exact `captured_at`, betrivers is the *only* book that posted for that event (`nfl:2026-09-11:SF@LAR`) — the other row at the same timestamp is the opposite side (Rams) from the same book, not a second book. So this particular occurrence would not by itself have entered a 2+-book comparison. This does not weaken the code defect (which is real and unconditional), only means this exact historical instance may not have been "live-exploitable" the moment it was captured.
- **Verdict: not refuted.** Real defect, demonstrated by an actual (not hypothetical) malformed value from the free odds feed. `routeBet`/`rankBooks` is explicitly the file's "only module... built on a measured positive," so this is a legitimate P2 (arguably higher, but not going to override the reader's severity absent stronger evidence of live triggering right now).

## #46 — nfl-shopping-board.js:143, bestExecution throws on |price|<100, unhandled in shoppingBoard — CONFIRMED, P2

Read nfl-shopping-board.js in full (429 lines) and the relevant slice of nfl-execution-edge.js (`assertRealPrice`, `dec`, `bestExecution`, lines 55-72 and 405-470).

- `assertRealPrice` (nfl-execution-edge.js:65-70): throws `TypeError` when `Math.abs(american) < 100` (this explicitly includes `0`).
- `dec` (line 72) calls `assertRealPrice` unconditionally.
- `bestExecution` (nfl-execution-edge.js:421-429): `usable = quotes.filter(q => Number.isFinite(q.american_price))` — does **not** filter on magnitude, so a 0 (or any sub-100-magnitude) price passes through as "usable." Line 429: `prices = usable.map(q => dec(q.american_price))` — this `.map` will throw the first time it hits such a quote.
- `shoppingBoard` (nfl-shopping-board.js:127-206): the call `const exec = bestExecution(quotes, { takingPoints });` (~line 143) is **not** wrapped in try/catch (confirmed by reading the full function body — the only error handling in the whole file is the router level).
- Router: `server/routes/betting-hub.js:120-131`, `r.get('/execution/board', ...)` explicitly allows `market` to be `'spreads' | 'totals' | 'h2h'` (line 122) and wraps the whole handler in try/catch → `next(e)` → the app-wide error handler (`server/index.js:110-115`) returns HTTP 500 for any error without a `.status` (a plain `TypeError` qualifies). So an unhandled throw here surfaces as a 500 to the caller ("the board goes down"), not a server crash — a nuance the claim's own phrasing ("500s the whole board") already captures correctly.
- I confirmed this exact family of malformed data has occurred in the live feed (the same price=0 row found for #45, market `h2h`), though as noted in #45 it did not coincide with a second book at that instant, so it would not currently reproduce a live crash via `/execution/board?market=h2h` today.
- `executionBoardSummary` (nfl-shopping-board.js:395-397) calls `shoppingBoard({market:'spreads', limit:200})` directly, also unguarded. By contrast, `server/routes/execution-slate.js:34-42`'s `liveOpportunities` **does** wrap its `shoppingBoard()` call in try/catch and degrades gracefully — so the slate recommender is actually more resilient than the claim implies for that one call site, though `executionBoardSummary`'s own internal call is still unguarded and would still throw into that same recommender's other paths that call `executionBoardSummary` directly (not checked exhaustively for every summary consumer).
- **Verdict: not refuted.** Real defect, demonstrated feed behavior. P2 reasonable.

## #47 — nfl-execution-lifecycle.js:470, lifecycleFunnel ignores settlement_correction rows — CONFIRMED, dormant today, P2

Read nfl-execution-lifecycle.js:370-491 in full (correctSettlement, netRealizedUnits, lifecycleFunnel) and nfl-execution-clv.js's three `netRealizedUnits` call sites.

- `correctSettlement` (line 381-408): stores the correction as a new `'settlement_correction'` event whose `realizedPnlUnits` is the **delta** (`corrected - priorNet`, line 402-405), exactly as its own comment (370-378) documents: "realized economics are the NET of ledger events, never whatever the last row says."
- `netRealizedUnits` (line 417-421): sums `realized_pnl_units` over `state IN ('settled','settlement_correction')` — correct per the module's own design.
- `lifecycleFunnel` (line 461-464): `settled = rows(... JOIN nfl_execution_lifecycle_events e ON e.opportunity_id=o.id AND e.state='settled' ...)` — restricted to `state='settled'` only. `totalPnl` (line 468) sums `s.realized_pnl_units` from that restricted set — so a correction event is invisible to this computation.
- `nfl-execution-clv.js:36,253,306,330` — confirmed `netRealizedUnits` (the correct, correction-inclusive function) is what the CLV report actually uses at all three sites, including line 330 (`accepted.reduce((sum,o)=>sum+netRealizedUnits(o.id),0)`).
- `server/routes/nfl-market.js:351-353`: `GET /execution/funnel` calls `lifecycleFunnel` directly — confirms this is a live, reachable endpoint, i.e., a real "number Nick reads" once corrections start happening.
- Live-data check: `SELECT ... WHERE state='settlement_correction'` on the running database returns **zero rows** — no correction has ever been recorded yet, so today `lifecycleFunnel.realized_pnl_units` and the CLV report's net figure agree by coincidence (nothing to diverge from). The bug is real but currently dormant.
- **Verdict: not refuted.** This is a genuine, verified divergence that will manifest the first time `correctSettlement` is ever called (a function that exists specifically to be called), at which point two endpoints Nick can read will silently disagree on realized P&L. P2 is appropriate.

## #48 — staking.js:292, safeStakeFor's gates are caller-asserted flags — CONFIRMED code fact, REFUTED impact → P3

Read staking.js:276-330 (safeStakeFor) in full and both HTTP call sites (nfl-betting.js:935-1004).

- `safeStakeFor` (line 291-293): `calibrationPassed = false, forwardSettled = 0, uncertaintyWidth = null` are plain parameters with no independent verification inside the function — confirmed by reading the whole body (330 lines total in file, the whole function read).
- `server/routes/nfl-betting.js:966-976` (`GET /stake/safe`): `calibrationPassed: req.query.calibrated === '1', forwardSettled: Number(req.query.forward_settled) || 0, uncertaintyWidth: ...Number(req.query.interval_width)` — directly off the query string, unauthenticated (no `requireModelPermission` on this route, confirmed by reading lines 930-1010).
- `server/routes/nfl-betting.js:990-1003` (`POST /stake/safe/slate`): same pattern off `req.body`.
- Grepped every call site of `safeStakeFor(` in `server/` — **only these two routes** call it; nothing internal computes and passes a verified value.
- Grepped the entire `client/src` tree for `stake/safe`, `calibrated=`, `forward_settled`, `interval_width` — **zero matches**. No UI page currently calls either endpoint, so no number on any page Nick actually looks at is produced by this path today.
- Nothing is persisted by either route (both just `res.json(...)` a computed object) — confirmed by reading both handlers in full.
- **Verdict: refuted (impact), code fact stands.** The code does exactly what's described, but as things stand nothing consumes it: no UI renders its output, nothing downstream reads its `execution_eligible` flag, and it writes nothing to any ledger. Triggering the misleading behavior requires a caller to *already* be supplying false calibration/sample-size claims to itself — there is no scenario today where an honest caller is deceived by another party's input, since the caller supplies its own gate values. Per the impact lens ("changes nothing a user or model sees") this is P3, not P2.

## #49 — nfl-execution-edge.js:276, marginsByPostedLine pools all seasons including corrupted 2025/2026 — CONFIRMED with exact live-data match, P2

Read nfl-execution-edge.js:200-290 in full (marginResidualDistribution, marginsByPostedLine and their doc comments) and nfl-teasers.js:1-60 (the corruption documentation) plus teaser-leg-rates.js's `MEASUREMENT_SEASONS`.

- `marginsByPostedLine` (line 264-267): `SELECT team_score, opp_score, spread FROM game_lines WHERE team_score IS NOT NULL AND opp_score IS NOT NULL AND spread IS NOT NULL AND home = 1` — no `season` predicate anywhere in the query, confirmed by reading the full function. Same is true of `marginDistribution` (line 91-93) and `marginResidualDistribution` (line 218-219) — all three read the *entire* `game_lines` history with no season bound.
- `nfl-teasers.js:33-38`: "2025 and 2026 are EXCLUDED and the exclusion is load-bearing... Integer share falls 47.7% -> 24.9% -> 16.2%..." and `MEASUREMENT_SEASONS = Object.freeze({from: 1999, to: 2024})` (`teaser-leg-rates.js:88`), which `wongHistory` (nfl-teasers.js:121-125) actually respects.
- Live-data check (read-only, `spread IS NOT NULL` denominator, matching the reader's own methodology, which I initially mis-verified using a stricter `team_score/opp_score NOT NULL` filter before realizing the reader's numbers use the broader "spread posted" denominator): **2023: 276/570, 2024: 272/570, 2025: 142/570, 2026: 92/544** — all four numbers match the claim's cited evidence exactly, character for character.
- Note: for season 2026 specifically, only 4 rows currently have `team_score`/`opp_score` populated (2 games have finished as of 2026-09-12), so the *actual* pollution `marginsByPostedLine` ingests today is overwhelmingly the 2025 collapse (142/570 = 24.9% integer, vs ~47-48% in 2023/2024), not 2026 (negligible row count so far, though this will grow as the season plays out and remains uncorrected).
- **Verdict: not refuted.** Genuine, precisely verified defect — the exact contamination the sibling `nfl-teasers.js` module explicitly excludes is pooled here with no bound, corrupting the margin distribution behind `lineMoveValue`, `coverProbabilities`, and `expected_net_return` for every side on the shopping board. Confirmed as ranking/display-only (not stake-affecting) per the claim's own honest scoping ("qualified is false"). P2 stands.

## #50 — nfl-shopping-board.js:205, cross-side sort by expected_net_return carries underdog bias to the top of the board — CONFIRMED (test file corroborates exact figures), P2

Read nfl-shopping-board.js:395-421 (executionBoardSummary) and the sort at the end of `shoppingBoard` (~195-206), plus `test/execution-slate-reasoning.test.js:1-60`.

- `shoppingBoard`'s final `.sort((a,b) => ... b.expected_net_return - a.expected_net_return)` sorts **across every side of every game**, confirmed by reading the loop structure (it iterates `bySide` per event and pushes into one flat `rowsOut` array before the single final sort).
- `executionBoardSummary` line 414: `best_expected_return: spreads[0]?.expected_net_return ?? null` — the literal first element of that globally-sorted array — and line 417 `qualified: false` is hardcoded with an explicit comment ("Nothing on this board is a qualified edge").
- Independent corroboration found in `test/execution-slate-reasoning.test.js:33-42`: a test comment states, verbatim, "That rate carries the historical underdog bias: +6.5 measures 53.53% against a 52.38% break-even, so every dog cleared the bar by construction," and separately documents that `qualified` was "written in six places and read in none" until the staking gate (`gateOpportunities`) was fixed to reject any `qualified !== true` row — meaning the actual staking pipeline **is** already gated against this (a `shoppingBoard` row can never size a stake), matching the claim's own honest framing ("it cannot reach a stake").
- I could not verify "commit 14c5e65" (no git history available in this checkout), but the substantive figures (53.53%, 52.38%) are corroborated by the repository's own test comments almost verbatim.
- **Verdict: not refuted.** The claim is precisely scoped to display/ranking misleadingness (not stake risk), which the codebase's own tests corroborate is a real, known property of this empirical baseline. This is exactly the kind of "misleads the human who sizes by hand" case the impact lens is meant to keep, since it is literally the first number on a page Nick would look at. P2 stands.

## #51 — betting-hub.js:433, inconsistent authorization on money-ledger routes vs. nfl-market.js's requireModelPermission — CONFIRMED, P2

- `server/routes/betting-hub.js:433` `r.post('/teasers/executions', ...)`, `:450` `r.post('/teasers/executions/:id/settle', ...)`, `:557` `r.post('/execution/log', ...)` — none has `requireModelPermission`, confirmed by grepping every `r.post`/`requireModelPermission` pairing in the file (only `/sgp/quotes` and `/sgp/fit` carry it).
- `server/routes/wong.js:622` `r.post('/tickets', ...)` — same, no permission wrapper (confirmed by reading lines 600-645).
- `server/routes/nfl-market.js:293-297`: `r.post('/bets', requireModelPermission('model:execute'), ...)` — the direct contrast the claim draws, confirmed verbatim.
- `server/index.js:104-108`: `/api/betting/wong` and `/api/betting` mounted with no `legacyAuthenticated`/`legacyAdmin` wrapper (unlike `/api/leagues`, `/api/tradelab`, `/api/trades`).
- **Verdict: not refuted.** Confirmed, real inconsistency across otherwise-parallel "record a bet" endpoints. Overlaps substantively with #41 (same underlying `settleTeaserExecution` route is cited in both), but #51's broader framing (three additional unguarded routes: `/teasers/executions`, `/execution/log`, `/tickets`) is independently verified and not fully redundant. P2 stands as the general-authorization-inconsistency finding, distinct from #41's specific settlement-fabrication P1.

---

## Summary table

| key | reader severity | verdict | corrected severity |
|---|---|---|---|
| #41 | P1 | not refuted | P1 |
| #42 | P2 | not refuted (impact narrowed) | P2 |
| #43 | P2 | refuted (impact) | P3 |
| #44 | P2 | not refuted | P2 |
| #45 | P2 | not refuted | P2 |
| #46 | P2 | not refuted | P2 |
| #47 | P2 | not refuted | P2 |
| #48 | P2 | refuted (impact) | P3 |
| #49 | P2 | not refuted | P2 |
| #50 | P2 | not refuted | P2 |
| #51 | P2 | not refuted | P2 |
