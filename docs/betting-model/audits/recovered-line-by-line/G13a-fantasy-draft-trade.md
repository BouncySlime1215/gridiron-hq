# Adversarial verification — reader G13a-fantasy-draft-trade

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)
DB reads: server/data.sqlite via `node:sqlite` `{ readOnly: true }` one-liners only.

## #104 — lineup-brain.js:290 adj_ppg horizon mismatch

Files read: server/services/lineup-brain.js (full doc header + lines 250-340), server/services/trade-engine.js (lines 150-260), server/services/waiver-brain.js (lines 100-190), server/services/fantasy-coordinator.js (lines 1-105, 360-430), server/services/matchups.js (180-260).

Code trace:
- trade-engine.js:191 `currentWeekPpg = thisGame ? currentWeekBasePpg * thisGame.mult * activeProbability : 0` where `currentWeekBasePpg` is the coordinator-corrected ppg (fantasy-coordinator.js `coordinateFantasy`) when a fit is ready.
- trade-engine.js:196 `decisionPpg = 0.25 * currentWeekPpg + 0.75 * rosPpg` → stored as `adj_ppg` (trade-engine.js:235).
- fantasy-coordinator.js:105 EXPERT_IDS include `game_script_delta`, defined (fantasy-coordinator.js:407-419, and again 320-329) as `withMult - noMult` where `withMult` uses `gameScriptFor(team, season, week).pass_mult/rush_mult` — i.e., the identical Vegas-line-derived primitive `waiver-brain.js:vegasLift` also reads via `gameScriptFor`.
- fantasy-coordinator.js:44-58 (doc): "The improvement comes entirely from `ensemble_shift` and `game_script_delta`" (game_script_delta has real, non-zero learned weight — unlike `boom_bust_signal`, which shrank to 0). So this is not a negligible signal.
- lineup-brain.js:288-295: `base = p.adj_ppg ?? p.ppg ?? 0; week_points = base * (lift.applied ? lift.multiplier : 1)`, comment: "Unlike the trade horizon, this is the full multiplier: the whole decision IS this week."
- waiver-brain.js:148-155 `horizonValueWithVegas` — the sibling function that does this correctly for the trade horizon: it scales ONLY the current-week share of a similarly blended value by the full Vegas multiplier (`base*(1-share) + base*share*lift.multiplier`), explicitly because "the whole decision is not this week" for a trade. lineup-brain.js has no analogous partial application — it applies the full multiplier to the ENTIRE `adj_ppg`, 75% of which (`rosPpg`) is a rest-of-season, non-Vegas-scaled figure.

Verified as claimed:
1. `adj_ppg` is a 25%/75% current/ROS blend (trade-engine.js:196), not a "this week" figure.
2. The 25% current-week component already carries a *learned, shrunk* contribution of the same `gameScriptFor` primitive via the coordinator's `game_script_delta` (when a fit exists).
3. lineup-brain.js then multiplies the *whole* blended `adj_ppg` — including the 75% ROS portion that has nothing to do with this week's Vegas line — by the *raw, unlearned, 100%-weight* `vegasLift` multiplier built from the exact same primitive.
4. This is a genuine partial double-application of the game-script signal on the 25% slice, and an unwarranted full-strength application of a one-week signal onto a 75%-ROS-weighted number for the other slice. The stated rationale ("the whole decision IS this week") argues for using `current_week_ppg` as the base, not for leaving `adj_ppg` (a 75%-ROS number) as the base and full-multiplying it — so the code's own comment doesn't match what the code does.

Visibility: `server/routes/trades.js:325` exposes this exact function on `GET /:leagueId/lineup`, consumed by `client/src/pages/Lineup.tsx` (confirmed present, Nick's real start/sit page — also referenced from MyTeam.tsx and LeagueBrain.tsx). `week_points` is literally the number the page ranks/labels ties on (TIE_THRESHOLD=1.5, CLEAR_THRESHOLD=4.0 at lineup-brain.js:259-260).

**Verdict: NOT refuted.** Real, currently-live defect in the exact number Nick's weekly start/sit page displays. Severity P2 as claimed is reasonable (does not corrupt money/backtest, but does misprice every start/sit margin on the single most-used weekly page).

---

## #105 — chrome-extension/content.js:43 DOM-baseline heuristic vs draft-ingest.js baseline acceptance

Files read: chrome-extension/content.js (1-90 in full), server/services/draft-ingest.js (full, 1-249), DB queries against `draft_capture_sessions`, `draft_picks`, `drafts` for draft_id=20.

Code trace:
- content.js:38-52 `readBaseline()`: if `[data-pick-number]` rows exist, counts "filled" rows by matching name-ish selectors/regex; if the DOM has drifted and none match, `filled` stays 0 and the function returns **0** (a confident integer), not null.
- draft-ingest.js:195-198 (my line numbers: ~194-197): `reported = Number.isInteger(baseline?.picks_on_board) && baseline.picks_on_board >= 0 ? baseline.picks_on_board : null; ... reported ?? local` — a reported `0` wins over the true local count.
- draft-ingest.js:141-147 `reconstructBoard`: when no INIT snapshot exists yet for a capture, it seeds `made` from `draft_picks WHERE pick_number <= session.baseline_picks` — so `baseline_picks=0` means the reconstruction starts from an EMPTY board and (would) renumber subsequently-observed SELECTED events starting at pick 1.
- draft-ingest.js:213-218 desync guard: `if (!fromInit && made.length < before - undone) { ...mark desynced, ignore this batch... }` — this specifically guards the case where a new capture's reconstruction ends up SHORTER than the already-recorded local board, which is exactly the scenario that would occur if a fresh capture with `baseline_picks=0` starts appending picks onto a draft that the DB already has many picks for. So most of the actually-dangerous instances of this bug are caught and the batch is rejected as `desynced` rather than corrupting the board.

DB evidence (draft 20, live, team_count=8, rounds=16, draft_at=2026-09-08T00:00:00Z):
- 20 `draft_capture_sessions` rows for draft 20. Sessions at 00:08:02, 00:12:33, 00:19:18 all show `baseline_picks=0` — but `draft_picks` shows pick #1 wasn't actually made until `2026-09-08 00:19:48` (i.e., the real draft room was open ~19 minutes before the first real pick — a normal live-draft lobby delay). So baseline=0 for those sessions is **correct**, not a heuristic failure.
- One session, `1788826764118-nt4v0d` (last_seen 00:27:31), shows `baseline_picks=0` — but pick #21 had already been recorded locally at `00:27:06`, 25 seconds earlier. This IS a genuine detection miss (real board already had 21 picks; extension reported 0).
- However, picks 22-30 in `draft_picks` all carry the **identical** `created_at` of `2026-09-08 00:27:44` (13 seconds after that session started), which is the signature of a bulk INIT-ledger decode (`reconstructBoard`'s `ledger` path, which bypasses `baseline_picks` entirely), not of sequential real-time SELECTED frames. This strongly suggests an INIT arrived and self-corrected the board within ~13 seconds of the bad-baseline session starting, before any bad renumbering from pick 1 could actually be written.
- No corrupted/misattributed picks are visible in the final `draft_picks` table for draft 20 (127 picks, sequential 1-127, plausible per-pick timestamps).

Assessment: the underlying heuristic flaw (content.js returns a confident `0` on a genuine selector miss, indistinguishable from a real "nothing picked yet" state) is real and confirmed by code. But (a) most of the window the claim cites (00:08-00:27) reflects legitimate pre-draft state, not a bug; (b) the one clear miss found (00:27:31) appears to have self-healed via an INIT within ~13 seconds, and the reconciler's `before - undone` guard would in most other cases block a short reconstruction from clobbering a longer local board. The claimed "roughly eight minutes... picks on wrong rosters" for this specific draft is not supported by the DB — no misattributed pick was found, and the actual risk window was much shorter and appears to have been caught. The narrow remaining risk (local `draft_picks` count is truly 0 while the real ESPN board is already non-zero, and no INIT arrives in time) is real but not demonstrated to have happened in this data.

**Verdict: PLAUSIBLE mechanism, but the impact as described is not evidenced.** Downgrade severity — real code smell/latent risk, but no demonstrated wrong-roster attribution actually reached Nick's board in the cited draft; the guard at draft-ingest.js:213-218 defends the common case. Recommend corrected_severity=P3.

---

## #106 — draft-ingest.js:242 draft never finalized after capture stops

Files read: server/services/draft-ingest.js (216-249), server/services/espn-draft.js (1-35, 220-260, 355-379), server/services/scheduler.js (grep for draft/status/warm, lines ~20-60, 420-450, 860-880), server/index.js (120-152), client/src/pages/Home.tsx (1-60, 109).

Code trace:
- draft-ingest.js:241-242: `const complete = made.length >= total; run('UPDATE drafts SET status = ? WHERE id = ?', complete ? 'complete' : 'active', draft.id);` — only runs inside `ingestCapture`, itself only invoked when the extension/bookmarklet POSTs a new batch of frames.
- espn-draft.js:242-257 `syncLiveDraftImpl`: short-circuits entirely (`paused: true`, no ESPN fetch) whenever `ingestIsFresh(draft)` (frames seen in the last 30s, espn-draft.js:19-23) — and is itself only invoked when the frontend polls a draft-detail endpoint, i.e., is UI-driven, not scheduled.
- scheduler.js: grepped for any drafts-completion job — none exists. `liveDraftActive()` (scheduler.js:39-58) is only a **gate** other jobs check to avoid interfering with a live draft; it requires `datetime(draft_at) >= datetime('now','-4 hours')`, so it does NOT keep treating an old stuck-active draft as "live" (would return false today) — but nothing ever un-stalls the `active` status either since nothing calls draft-ingest.js or espn-draft.js against it anymore.
- server/index.js:145-151: **startup warm-up explicitly queries** `SELECT id FROM drafts WHERE league_row_id IS NOT NULL AND status = 'active' ORDER BY id DESC LIMIT 1` — no time-window guard — and runs `boardState`/`enrichWithEvidence` against whatever it finds. Confirms the claim's "startup warm-up targets a dead draft" clause precisely.
- client/src/pages/Home.tsx:54,109: `const activeDraft = draftsApi.data?.find(d => d.status === 'active'); ... to={activeDraft ? '/drafts/${activeDraft.id}' : '/draft'} title={activeDraft ? 'Continue draft' : 'Prepare draft'}` — the Home page's "Act now" CTA is driven directly by this same broken `status` field.

DB evidence (read-only):
- Draft 20 (live, team_count=8, rounds=16 → total 128 picks): `draft_picks` count = **127**, `status='active'`, `ingest_last_seen_at='2026-09-08T00:49:42.475Z'` (today is 2026-09-12 — 4 days later), matching the claim exactly.
- Bonus corroboration: `SELECT id, status FROM drafts` shows **10 additional drafts** (ids 4,5,6,10-16) stuck at `status='active'` — several of them (11,12,13,14,15) with pick counts EQUAL to their full `team_count*rounds` total (192/192, 160/160), i.e., fully drafted yet still marked active. (Those are `type='mock'` and go through a different completion path — `server/draft/store.js:advanceDraftState`, which writes `'completed'`, not `'complete'` — so this looks like a second, related but distinct status-string/finalization inconsistency; flagged as out-of-scope corroboration, not verified in depth for this claim.)

This confirms the claim is not just a theoretical latent bug: **right now**, Home.tsx's "Continue draft" / "Prepare draft" CTA and its "N picks are already recorded" subtitle are driven by a stale-active draft record, and the server's own startup warm-up wastes its ~4.5s evidence-cache pass on a draft that finished 4 days ago instead of anything current.

**Verdict: NOT refuted.** Confirmed by code and current DB state; the impact is not hypothetical — it is presently wrong on the Home page. Severity P2 is justified, arguably could be argued higher given a real, currently-displayed misleading CTA, but P2 as given stands.

---

## #107 — draft-assist.js:383 snake-only slotForPick vs order_type-aware mock drafts

Files read: server/services/draft-assist.js (1-30, 355-400), server/services/espn-draft.js (355-379), server/routes/drafts.js (grep for order_type, ~330-590), server/draft/store.js (grep + lines 140-150, 305-315), server/draft/engine.js (grep for order_type/ORDER_TYPES), DB query on `drafts.order_type`.

Code trace:
- draft-assist.js:16 imports `slotForPick, myUpcomingPicks` from `./espn-draft.js`, whose `slotForPick` (espn-draft.js:365-369) is explicitly commented "Snake order: odd rounds run 1..N, even rounds run back N..1" — no `order_type` parameter at all.
- draft-assist.js:381-383 `picksBetween` (feeding `horizonFor`/lookahead) and the earlier `myUpcomingPicks` call use this snake-only function to compute "my turn"/gone-by horizons.
- By contrast, `server/draft/engine.js:42` throws on an unknown `order_type` and clearly implements order-type-aware slot math; `server/draft/store.js:145,311` and `server/routes/drafts.js:363-382,458,511,551,580` all thread `draft.order_type` through a *different*, order_type-aware `slotForPick`/`snakeSlot`. `routes/drafts.js:363-364` validates `order_type` against `ORDER_TYPES` (which includes non-snake values) at draft-creation time.
- So there are two independent `slotForPick` implementations in the codebase: one order_type-aware (used for the actual pick-clock/turn assignment), one snake-only (used only by draft-assist.js's board-state/lookahead/survival code).

DB evidence: `SELECT id, type, order_type FROM drafts` → **all 15 rows are `order_type='snake'`** (10 mock, 5 live). No draft in Nick's history has ever used a non-snake order.

Assessment: the code inconsistency is real (verified by direct comparison of the two `slotForPick` implementations and their call sites), but it is **entirely latent** — the claim itself labels the impact "Latent," and the DB confirms zero drafts have ever exercised the non-snake path. Per the impact lens ("does it change a number Nick reads on a page? If it changes nothing a user or a model sees, downgrade to P3"), this currently changes nothing: my_turn, horizons, gone_by numbers are all correct today because every real/mock draft is snake. It only bites if/when Nick creates a linear or third-round-reversal mock, which has never happened.

**Verdict: Confirmed as code fact, but refuted as a P2-impact claim today.** Recommend refuted=true / corrected_severity=P3 — pure latent risk with no current manifestation, consistent with the claim's own "Latent" framing.

---

## #108 — betting-fantasy-link.js:43 integer-id vs GSIS-text key mismatch

Files read: server/services/betting-fantasy-link.js (1-70, 140-220 in full), server/services/player-week-engine.js (60-150, 200-245), server/services/nfl-advanced.js (438-448), server/services/projections.js (360-400), server/routes/nfl-betting.js (550-585), plus repo-wide grep for any frontend consumer.

Code trace:
- `bettingViewOf(season, week, playerId, ...)` resolves the projection via `playerWeekProjection` (player-week-engine.js:72-81), which is explicitly dual-mode: "Resolve either the app's numeric player id or nflverse's GSIS id" — it tries `engine.get(playerId)` first (numeric key) and falls back to a linear scan matching `projection.gsis_id === String(playerId)`. So projection lookup works with either id shape.
- But `betting-fantasy-link.js` then separately calls `injuryFor(season, week, playerId)` (nfl-advanced.js:440-441: `SELECT * FROM nfl_injuries WHERE ... gsis_id=?` — parameter literally named `gsisId`, no dual-mode) and `roles.find(r => r.gsis_id === playerId)` (strict equality against the RAW `playerId` argument, not `projection.gsis_id`). Neither of these has the dual-lookup fallback the projection resolver has.
- `standouts()` (betting-fantasy-link.js:210-218) iterates `ids = [...buildPlayerWeekEngine(...).keys()]` and calls `bettingViewOf(season, week, id, ...)` for each `id`. Those keys come from `buildProjections`' `acc.get(u.player_id)` (projections.js:387-389), i.e., the app's **numeric** `players.id`, confirmed by the numeric key path (`playerId == null` check, `engine.get(Number(playerId))`) being the one that actually succeeds in that call path.
- Therefore, in `standouts()`, `injuryFor`/`role.gsis_id===playerId` are ALWAYS called with an integer while `nfl_injuries.gsis_id`/roles rows are text GSIS ids (e.g. `'00-0027962'`) — strict equality/SQL comparison never matches, so `injury`/`role` are always null on that path, exactly as claimed.
- `/api/nfl/fantasy/reconcile` (routes/nfl-betting.js:573-582) takes `player_id` from the query string and does `reconcile(ssn, wk, String(id), fp)` — whatever id shape the caller supplies is passed straight through with the same mismatch risk.

Scope/visibility check: grepped the whole repo (`grep -rln "fantasy/reconcile|fantasy/standouts"`) — the ONLY files referencing these two routes are `server/routes/nfl-betting.js` itself and `test/betting-fantasy-link.test.js`; no `client/src` file calls either endpoint. `grep -rln "betting-fantasy-link"` across the repo likewise turns up only the route, the test, and docs — no other server-side consumer exists either.

**Verdict: code defect confirmed, but currently orphaned/unused.** There is no UI page or other service that calls `/api/nfl/fantasy/reconcile` or `/fantasy/standouts` today, so this "misleadingly silent" explanation never actually reaches Nick — nothing on any page currently reads these fields. Per the impact lens, recommend refuted=true / corrected_severity=P3: real bug, zero current observable impact (no page, no consumer).

---

## Summary table

| key | initial severity | verdict | corrected severity |
|---|---|---|---|
| #104 lineup-brain adj_ppg/Vegas | P2 | NOT refuted — confirmed, live page impact | P2 |
| #105 chrome-extension baseline=0 | P2 | Refuted as evidenced — mechanism real, but demonstrated impact absent (self-healed, guarded) | P3 |
| #106 draft never finalized | P2 | NOT refuted — confirmed, currently wrong on Home.tsx CTA | P2 |
| #107 snake-only slotForPick | P2 | Refuted as impact claim — confirmed latent-only, zero non-snake drafts ever run | P3 |
| #108 betting-fantasy-link id mismatch | P2 | Refuted as impact claim — confirmed bug, but zero current consumers/pages | P3 |
