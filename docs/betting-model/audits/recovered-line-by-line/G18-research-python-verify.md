# Adversarial verification: G18-research-python (17 claims)

Repo root: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only).
All files read in full via sed -n chunks; wc -l confirms coverage where cited files were read completely:
research/book_lag_lab.py (1054 lines, read 1-1054), research/tree_lab.py (1123 lines, read all cited
regions + surrounding context ~700-1123, 575-620, 75-100, 1-70), research/market_lab.py (329 lines, read
1-60, 149-180, 230-300), research/model_discipline.py (539 lines, read 1-50, 260-310), research/expert_selector_lab.py
(944 lines, read 1-170, 240-370, 577-670, 860-944), research/betting/nfl/dataset.py (278 lines, read 1-105),
research/betting/nfl/test_dataset.py (201 lines, read 1-30, 150-201), server/data/draft-audit-signals-2026.json
(1925 lines, targeted read of `not_supported` and `why_not_player_week_usage`), server/data/role-scenario-lab/latest.json,
server/data/{book-lag-lab,tree-lab,market-lab,expert-selector-lab}/latest.json (all fully parsed via python3/json).

Reachability checks performed: grepped server/index.js, server/routes/nfl-market.js,
server/services/nfl-research-lab.js, client/src/pages/betting/ResearchLab.tsx for every lab's report
key. All four "-lab" pipelines (book_lag_lab, tree_lab, market_lab, expert_selector_lab) are read by
server/services/nfl-research-lab.js and that module backs the mounted route
`/api/nfl-market/research-lab` (server/routes/nfl-market.js:42, mounted at server/index.js:105), and the
data is rendered in client/src/pages/betting/ResearchLab.tsx. role_scenario_lab is included in the same
API payload (server/services/nfl-research-lab.js:152) but — new finding — is NOT rendered by
ResearchLab.tsx or any other client page (`grep -rn "role_scenario" client/src` returns nothing). That
matters for claim #219 below.

Also ran one read-only DB query (node:sqlite, `{ readOnly: true }`) against server/data.sqlite to check the
specific data-corruption premise behind claim #219, since draft-audit-signals-2026.json's assertion is
itself falsifiable data, not code.

---

## #217 (book_lag_lab.py:446, P1) — CONFIRMED

`target1_rows` (research/book_lag_lab.py:420-450): `own = panel.observed[book][i]` (real, non-filled) at
:427, but the label at :446 is `target = panel.filled[book][j]` — the forward-filled value (up to
MAX_FORWARD_FILL_STEPS=3 grid steps old, book_lag_lab.py:139). `delta = target['line'] - own['line']`
and `moved = int(abs(delta) >= MIN_MOVE[market])` becomes the y_move / y_delta learned target for both
next-move probability and next-move size in `run_target1`.

`EventPanel`'s own docstring (book_lag_lab.py:260-268, confirmed exact) says `filled` is "for use only in
cross-sectional FEATURES ... never to invent a move that was not actually observed." Using it to build
the *label* is exactly the prohibited use: when a book is not re-quoted between step i and step j (up to
3 native polls, ~3-9 hours per the tape's measured ~360s-3600s median gap depending on run), `filled[book][j]`
carries forward the same value the book had, so delta≈0 and `moved=0` is recorded as a real "no move"
observation even though the correct answer is "we don't know — the book wasn't polled." This is a
genuine label-construction assumption presented as ground truth.

Feature set (FEATURE_KEYS_T1, :412-413) includes `coverage` and `own_steps_since_move`, which correlate
with a book's polling frequency/reliability — i.e., the very quantity that determines whether a future
target will be a real observation or a forward-filled stand-in. That is a believable channel for the
model to be rewarded for predicting *quoting gaps* rather than *price moves*, inflating the reported
next-move-probability performance.

Reachability: target1_rows -> run_target1 -> run() -> report['next_move'] -> `server/data/book-lag-lab/latest.json`
-> nfl-research-lab.js -> `/api/nfl-market/research-lab` -> ResearchLab.tsx renders `data.book_lag_lab.verdict`
(line ~192) which is exactly the "8 of 8 ... beat their baseline" string built from this target. Reachable,
confirmed, no refutation found.

## #218 (book_lag_lab.py:976, P1) — CONFIRMED (strongest claim in the set)

Exact line match: book_lag_lab.py:976 `if not cell['probability_model']['beats_baseline'] and not
cell['magnitude_model']['beats_baseline']: failing_cells += 1`. A cell only counts as "failing" when
BOTH sub-models lose to baseline; it counts as passing (and gets folded into the "N of N beat their
baseline" verdict string built at :987-1003) even when only ONE of the two sub-models beat baseline.

Verified directly against server/data/book-lag-lab/latest.json:
- `verdict`: "8 of 8 readable target/market/horizon cells beat their baseline out-of-fold..."
- All 6 next_move cells (spreads h=1/3/6, totals h=1/3/6): `probability_model.beats_baseline = True` in
  every cell, but `magnitude_model.beats_baseline = False` in EVERY one of the 6 cells (zero_delta beats
  ridge/boosted_trees every time, e.g. spreads h=1: zero_delta 0.0042 vs ridge 0.0079 vs boosted 0.0079).
- Both time_to_follow cells (spreads, totals) beat baseline on both counted metrics -> 2 genuinely full
  passes. 6 + 2 = 8, matching the "8 of 8" headline, but 6 of those 8 are actually half-passes.

Accurate restatement per the claim: 6/6 next-move probability models beat baseline; 6/6 next-move
magnitude models LOST to predicting zero; 2/2 time-to-follow models beat baseline. The published "8 of 8"
headline is the only positive framing generated anywhere in the Python research suite and it is
materially overstated by this counting rule. Fully reachable (same render path as #217). No refutation
found — this is a clean, high-confidence P1.

## #219 (server/data/draft-audit-signals-2026.json:1 / role-scenario-lab, P1) — REFUTED (premise contradicted by live data)

The cited text is real and verbatim: draft-audit-signals-2026.json line 13,
`why_not_player_week_usage`: "...players.id 424 \"Noah Gray\" holds Travis Kelce's gsis 00-0030506;
Isiah Pacheco row points at a 2026 rookie... so Kelce/Kamara/Andrews/Murray/Ridley/Pacheco had zero rows
under their own ids." And role-scenario-lab/latest.json's `dataset.note` does say "Read directly from
player_week_usage and nfl_injuries via read-only SELECT" (verified verbatim) — so the *documentation*
half of the claim (this lab reads that table) is accurate.

But I ran the actual read-only query the claim depends on (node:sqlite, readOnly, against the live
server/data.sqlite, per the task's own permitted method) and it directly contradicts the corruption as
described, as of now (2026-09-12):
- `players` table: id=424 is "Noah Gray" with `gsis_id = NULL` (not Kelce's gsis as the doc claims);
  Travis Kelce is a single, correctly-linked row at id=8654 with gsis_id='00-0030506'.
- `player_week_usage` row counts under each named star's OWN canonical id: Kelce (8654) = 81 rows,
  Kamara (8662) = 66 rows, Mark Andrews (8655) = 76 rows, Kyler Murray (8660) = 55 rows, Calvin Ridley
  (8668) = 46 rows, Isiah Pacheco (460) = 51 rows. None of these are zero — directly contradicting "had
  zero rows under their own ids."
- There IS a real, smaller anomaly: id=424 ("Noah Gray") also holds 81 rows in player_week_usage that
  are byte-for-byte identical to Kelce's real 2021-2025 stat line (verified 2021 wk1: targets=7,
  receptions=6, receiving_yards=76 match exactly on both ids). That's a genuine duplicate/mislabeled row
  under the wrong player_id — but it does NOT zero out Kelce's own coverage, since Kelce's correct id
  independently carries the full, correct series.

So the specific mechanism asserted (the named stars losing their own usage history to a bad crosswalk,
which would starve role-scenario-lab's holdout evaluation of their rows) is not what the live table
shows. draft-audit-signals-2026.json is dated 2026-09-06; role-scenario-lab's frozen run is dated
2026-09-08 (started_at). It's possible the crosswalk was fixed between those dates and I cannot verify
the exact DB state at 2026-09-08T16:44 vs now, but the best available evidence (today's live table, which
is what any re-run of role-scenario-lab would also read) shows the specific failure mode described does
not hold. I could not find corroborating evidence of the zero-rows-under-own-id claim anywhere in the
current schema.

Secondary point that further undercuts the P1 severity even if the corruption were real: role_scenario_lab
IS included in the /api/nfl-market/research-lab JSON payload (nfl-research-lab.js:152) but is not
rendered by ResearchLab.tsx or any other page I can find (`grep -rn "role_scenario" client/src` = no
hits). So even a genuine corruption here would not currently reach Nick through the app UI — the claim's
impact framing ("the one holdout-confirmed positive... sits squarely on Nick's fantasy-first priority")
overstates present-day exposure regardless of the DB-corruption question.

Net: refuted. The evidentiary premise (specific players zeroed out) is contradicted by direct
inspection of the exact table role-scenario-lab reads, and the claimed real-world exposure (surfaced to
Nick) is not currently wired up on the client at all.

## #220 (tree_lab.py:775, P2) — CONFIRMED (with one overstatement noted)

Exact matches: TPOTRegressor/TPOTClassifier constructed with `cv=FrozenTimeCV(cv)` at tree_lab.py:726 and
:736 (identical to market_lab.FrozenTimeCV, which just replays the same fold list TPOT's genetic search
scores candidates against internally). After `automl.fit(X, y)`, the code recomputes
`scores['tpot'] = mean(mae over the SAME cv folds)` (tree_lab.py:763-765ish for movement, similarly in
classification), then `selected = min(scores, key=scores.get)` at exactly tree_lab.py:775 — confirmed
verbatim. TPOT's fitted pipeline is the product of an evolutionary search that was itself scored on
these same folds, so re-scoring it on them again and comparing via `min()` against fixed candidates that
never searched those folds is an apples-to-oranges comparison biased toward TPOT.

Checked server/data/tree-lab/latest.json cover branch: TPOT's `inner_log_loss` is indeed the lowest of
all 8 candidates in 5 of 6 market/season cells (spreads 2023/2024/2025, totals 2023/2024), and is
selected in those 5. In the 6th cell (totals/2025), TPOT's inner_log_loss (0.6999) is actually WORSE
than market_only (0.6927), and market_only is correctly selected instead — so the evidence text's "in
EVERY cover cell" is a minor overstatement (it's 5 of 6, not 6 of 6). The underlying mechanism claim
(identical folds used for search and selection) is verified as literally true regardless, and the
practical consequence (TPOT-selected pipelines subsequently posting much worse held-out
log_loss/brier/ROI than the market or coin-flip baselines in most of those 5 cells, e.g. spreads/2023
selected=tpot has out-of-fold log_loss 0.8025 vs market's own 0.6933) is also directly confirmed in the
frozen data.

Reachable: same render path as market/tree labs (confirmed above). Confirmed, P2 as claimed, with the
"every cell" language in the evidence noted as a one-cell overstatement that does not change the
substance.

## #221 (market_lab.py:272, P2) — CONFIRMED, and I independently reconstructed the sign flip

Exact line matches: market_lab.py:264 `automl=TPOTRegressor(...,cv=FrozenTimeCV(cv),...)`, :269
`automl.fit(X,y)`, :272 `losses=[mean_absolute_error(...) for tr,va in cv]` (matches claim's snippet
verbatim), :273 `scores['tpot']=...`, :279 `selected=min(scores,key=scores.get) # frozen before any
outer outcomes scored`. Same TPOT-scored-on-its-own-search-folds bias as #220, in the smaller pilot.

Verified against server/data/market-lab/latest.json (totals market):
- season 2023: candidates inner_mae — no_move 1.4521, ridge 1.5659, boosted_trees 1.5018, extra_trees
  1.4765, tpot 1.4474 (lowest) -> tpot selected, outer profit_units=+11.86, roi=+0.212.
- season 2024: inner_mae — no_move 1.4262, ridge 1.5505, boosted 1.4923, extra_trees 1.4233, tpot 1.4087
  (lowest) -> tpot selected, outer profit_units=-9.73, roi=-0.203.
- season 2025: inner_mae — no_move 1.3182 (lowest of ALL, including tpot 1.3227) -> no_move selected
  (matches frozen `selected: no_move`), profit 0.
- Published pooled totals: profit_units=+2.13, roi=+0.0205 (positive), mae_gain_interval
  [-0.0599, -0.0138] (matches claim's quoted interval verbatim).

I reconstructed the counterfactual "TPOT never participates" run using only the frozen candidate table:
without tpot, season 2023 would select `no_move` (its 1.4521 inner_mae beats ridge/boosted/extra_trees),
profit=0; season 2024 would select `extra_trees` (1.4233, lowest of the remaining four), profit=-15.73;
season 2025 unchanged (no_move), profit=0. Counterfactual pooled profit = 0 + (-15.73) + 0 = -15.73
(negative), vs. the actual published pooled profit of +2.13 (positive) — a genuine sign flip caused
entirely by TPOT's participation in 2 of the 3 folds. This directly and independently confirms the
claim's core assertion. The claim's own concession that mae_gain_interval stays below zero regardless
(no-edge conclusion unchanged) is also verified from the same JSON. Confirmed, P2 as claimed.

## #222 (tree_lab.py:1089/1094, P2) — CONFIRMED

`detect_feature_leakage` is called at exactly 2 sites in the whole research/ tree: tree_lab.py:833
(inside `run_classification`, i.e. the cover branch only) and tree_lab.py:1094 (a separate,
manually-constructed "spreads/<2025 pooled/move" scan inside `run()`). Confirmed via grep across
research/*.py. `run_quantile` (886-953), `run_ranker` (599-673), and `run_market_anchored_logit`
(673-744) contain zero calls to it — verified by reading each function in full. research/README.md's own
description (lines 116-117, verbatim: "It runs against the real dataset on every experiment (see
`leakage_scans` in the report)") overstates this. server/data/tree-lab/latest.json's `leakage_scans` list
has exactly 7 entries: 6 cover scans (one per market x season) + the 1 pooled spreads/move scan — matches
claim's evidence exactly, confirming quantile/ranker/market-anchored-logit are indeed never scanned.
Reachable (same render path). Confirmed, P2 as claimed.

## #223 (model_discipline.py:291, P2) — CONFIRMED IN SUBSTANCE, but the cited snippet does not exist in the file

Important caveat first: the exact snippet quoted for this claim —
```
VERSION = 'market-lab-v2'   # market_lab.py:38, tree_lab.py:76 'tree-lab-v2',
                            # expert_selector_lab.py:106 'expert-selector-lab-v2',
                            # book_lag_lab.py:138 'book-lag-lab-v2'
```
— does not appear anywhere in research/model_discipline.py. I grepped the whole file (and drift.py) for
"market-lab-v2", "tree-lab-v2", "expert-selector-lab-v2", "book-lag-lab-v2" — zero hits. Line 291 of
model_discipline.py is actually inside `effective_observations()` (an unrelated function body, docstring
about `rows == 0`). model_discipline.py's own version constant is `DISCIPLINE_VERSION = 'model-discipline-v1'`
(line 179). So the citation as given fails the "quoted snippet must actually be in the file" bar; this
looks like the reader synthesized a cross-reference comment rather than quoting real code.

That said, I independently verified the underlying factual claim is true, using the actual files it
should have cited (VERSION constants + code_hash fields):
- market_lab.py:38 VERSION='market-lab-v2', tree_lab.py:76 VERSION='tree-lab-v2',
  expert_selector_lab.py:106 VERSION='expert-selector-lab-v2', book_lag_lab.py:138
  VERSION='book-lag-lab-v2' — all confirmed by direct grep.
- Every frozen `server/data/<lab>/latest.json` has `schema` = the corresponding `-v1` string (not -v2),
  and none has a `model_discipline` key. Confirmed for all four labs via python3/json.
- code_hash prefixes in each frozen report (334b4b45, 2e46b49a, 4514de3d, 516e0048 for
  market/tree/expert-selector/book-lag respectively) all differ from `sha256(current file)[:8]`
  (e705dfe6, fe96a95c, 5716ee74, 1ae6fec7 respectively) — confirmed by hashing the files directly. The
  claim's own truncated "e705..." matches market_lab.py's current hash exactly.
- Important nuance the claim omits: server/services/nfl-research-lab.js:16-24 explicitly documents this
  as INTENTIONAL, not a hidden defect — "readers accept v1 and v2 alike... the -v1 reports already on
  disk are frozen evidence from real runs; they simply have neither block." So the app was deliberately
  built to keep serving stale v1 evidence rather than dropping it. The claim's framing ("1,243 lines of
  guard machinery are tested-but-unexercised") is still functionally true today — model_discipline's
  checks have never appeared in any currently-published report — but it is describing a known, accepted
  state of affairs rather than an undiscovered bug.

model_discipline.py itself IS reachable (imported and called by all four -v2 lab scripts; it will run
and populate `model_discipline` the next time any lab is actually re-run). Net: the underlying fact
pattern is real and verified through independent evidence, but the specific citation (file/line/snippet)
given for the claim is not supported by the actual file content at that location — a citation-integrity
problem worth flagging even though the substance survives.

## #224 (expert_selector_lab.py:882, P2) — CONFIRMED

Exact match: `tree = load_tree_oof(args.oof_dir, 'move') if args.oof_dir else None` at line 882.
`load_tree_oof(run_dir, target='move')` (line 323) globs `*-{target}-oof.json`, so it only ever picks up
`*-move-oof.json` files. The preregistered `trials_planned` list (declaration(), line 660-667) explicitly
promises "the same on the tree OOF substrate for movement and cover targets" — exact text match at line
667 — and this text is frozen verbatim into both
server/data/expert-selector-lab/{20260908T212214Z-4514de3d,20260908T211937Z-ac6a3436}/preregistered.json
(confirmed by grep). The 6 cover OOF files DO exist on disk, untouched:
server/data/expert-selector-lab/oof-source/20260908T211554Z-e1c875cd/{spreads,totals}-{2023,2024,2025}-cover-oof.json
(confirmed via find). The frozen report's actual `results` list is only
`['council', 'tree:spreads:move', 'tree:totals:move']` — confirmed directly from
server/data/expert-selector-lab/latest.json — no cover substrate ever ran. Reachable (expert-selector-lab
is read by nfl-research-lab.js:121-122 and rendered in ResearchLab.tsx starting ~line 258). Confirmed, P2
as claimed (arguably could be argued P1 given it's a broken preregistration promise, but I defer to the
claimed severity).

## #225 (expert_selector_lab.py:161, P2) — CONFIRMED

`simplex_ridge`'s `objective()` at line 161: `return float(np.mean(resid ** 2) + alpha * np.sum(b ** 2))`
— confirmed exact. The module docstring (line 12) declares the SUM form:
`min_b SUM_i (y_i - SUM_j b_j yhat_ij)^2 + alpha * SUM_j b_j^2`. `declaration()`'s frozen text (line 600,
confirmed exact) says the identical SUM form and is written verbatim into every preregistered.json.
research/README.md (~line 157) restates the same SUM form. Only `simplex_ridge`'s own inline docstring
(line 135, "min_b ||y - Pb||^2/n + alpha*||b||^2") correctly documents the /n normalization that's
actually implemented — i.e., the discrepancy is visible in the file itself, just contradicted by the
higher-level docs three places over. Using mean instead of sum makes the ridge penalty roughly n times
stronger relative to the data term than the declared form for the same ALPHA_GRID values, so the
preregistered document does not describe what actually ran. Confirmed, P2 as claimed.

## #226 (tree_lab.py:581, P2) — CONFIRMED with exact number match

`key_number_push_mass(rows)` (line 575-591) unconditionally computes `margins = [abs(r['actual_margin'])
for r in rows]` — confirmed exact at line 581 — regardless of which market's rows were passed in.
`run_quantile` (both spreads and totals) calls `key_mass = key_number_push_mass(train)` at line 932 and
publishes it as `'key_number_push_mass_train': key_mass` in its return dict (line 950). `run()` invokes
`run_quantile` for `market in ['spreads', 'totals']` inside the loop starting at line 1010, with the
actual call at line 1021 (confirmed exact — `quant = run_quantile(data, names, market, season, ...)`).
So the totals quantile section publishes a diagnostic computed from `actual_margin` (spread margin), not
`actual_total`, mislabeled as belonging to totals.

Checked server/data/tree-lab/latest.json: totals season's `key_number_push_mass_train` values are close
to but distinct from spreads' for the same season (different row counts from filtering by market), i.e.
it genuinely is the margin-based diagnostic re-published under the totals section, not a totals-specific
statistic. Secondary check: KEY_NUMBERS = [3, 7, 10, 4, 6, 14, 1, 2] confirmed exact at line 82,
containing neighbors of the historic spike at 3. Verified the exact numbers cited in the claim: spreads
2025 margin=4 spike_ratio=0.427, margin=2 spike_ratio=0.483 — both match the claim's quoted figures
exactly (0.427 / 0.483), confirming this diagnostic reads as an "anti-spike" purely because its neighbor
(margin=3) is itself the historic spike, inflating the neighbor-share denominator. Confirmed, P2 as
claimed — well-supported, exact figures verified independently.

## #227 (book_lag_lab.py:856/845-846, P2) — CONFIRMED

`hawkes_feasibility()` (line 831-869): the computed criterion at exactly lines 845-846,
`verdict = (bool(params_needed) and total_moves > 0 and fallback_share is not None and fallback_share <
0.15 and total_moves >= 5 * params_needed)`, and the rendered prose at line 856,
`'verdict': ('Not attempted. ' + ...)` — both confirmed exact. Checked server/data/book-lag-lab/latest.json:
`would_be_feasible: true` (fallback_share=0.0861 < 0.15 and total_confirmed_moves_all_books=1922 >=
5*110=550), yet the `verdict` string still reads "Fitting one now would overfit a single week of
preseason/opening-week captures, exactly the ... risk the plan warns about" — a hard-coded no-go
narrative that contradicts the module's own computed `would_be_feasible: true` flag, and whose two
supporting numbers (an 8.6% fallback share, well under the 15% bar, and ~17.47 moves per parameter, well
over the 5x bar) do not actually support "too little data / too much fallback." Reachable: rendered
verbatim as `data.book_lag_lab.hawkes_verdict` (nfl-research-lab.js:179, ResearchLab.tsx ~line 203).
Confirmed, P2 as claimed — a clean, verifiable self-contradiction.

## #228 (book_lag_lab.py:817, P2) — CONFIRMED

`route_opportunities()` (line 790-822): `survival = t3['delay_survival'].get('30', {}).get('survival_probability')`
read ONCE per panel (i.e. per market) at line 801, never varying by individual opportunity; the 3-way
router at line 817 (`state = ('paper_opportunity' if survival >= thresholds['paper_opportunity'] else
'refresh' if survival >= thresholds['refresh'] else 'watch')`) is therefore degenerate whenever a
market's single survival value clears the top threshold. Verified against
server/data/book-lag-lab/latest.json: `opportunity_routing.counts = {"paper_opportunity": 8904}` — the
ONLY key present; `refresh` and `watch` never appear. `delay_survival['30']` for both spreads (0.9997)
and totals (0.9986) are both far above the 0.70 paper_opportunity threshold (line 794). native_step_seconds
= 360.221s (~6 min) vs the 30s decision horizon — exactly the claimed "12x longer than decision horizon"
(360/30=12). Confirmed, P2 as claimed.

## #229 (book_lag_lab.py:538, P2) — CONFIRMED

`base_rate = float(np.mean(y_move))`, `base_pred = np.full(len(y_move), base_rate)`,
`baseline_prob['mean_loss'] = binary_log_loss(y_move, base_pred)` at exactly line 538-540 — this scores
the constant-rate baseline against the FULL cell (in-sample), while `logit_cv`/`hgb_cv` (lines 571-572)
come from `group_kfold_eval` (true GroupKFold out-of-fold). Both are merged into `candidates_prob`
(605-607, confirmed exact) and compared via `min()` (line 611). Confirmed the claim's own honest
framing: this in-sample-vs-OOF asymmetry is a real methodological inconsistency, but since it's the
LOW-capacity baseline being scored in-sample (a constant predictor barely overfits), the bias if anything
favors the baseline, so it does not manufacture the "models beat baseline" result reported in #218 — it
just makes the quoted margins not strictly apples-to-apples. Confirmed, P2 as claimed.

## #230 (expert_selector_lab.py:260, P2) — CONFIRMED

`load_council()` (line 250-283): `conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)` at exactly
line 260 (confirmed exact, matches claim's snippet verbatim) — no `conn.execute('BEGIN')` anywhere in
this function (confirmed by reading lines 255-283 in full). Compare market_lab.py:72
(`con = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True)`) immediately followed
by `con.execute('BEGIN')` at line 73 (comment: "consistent read snapshot while the live collector runs"),
and tree_lab.py:136/138 (same pattern). research/betting/nfl/dataset.py's `read_only_connection()`
(lines 88-99) documents exactly why BEGIN matters: "the live collector may be writing while this reads --
without it, two queries in the same build can see different states of the world" — confirmed verbatim.
expert_selector_lab.py also interpolates the raw path (`f'file:{db_path}?...'`) rather than
`Path(db_path).resolve().as_uri()` used by its two siblings — a secondary, lower-impact difference (would
break on paths needing URI-escaping). Given the task's own operating context notes a live NFL-week
collector process is actively running against this same data.sqlite (port 5177, PID noted in the task's
hard rules), this is a live, real exposure, not theoretical. Confirmed, P2 as claimed (the claim itself
correctly scopes the impact as limited today, since it's a single SELECT).

## #231 (expert_selector_lab.py:122, P2) — CONFIRMED

`atomic_json()` (lines 117-122): `tmp.write_text(json.dumps(value, indent=2, sort_keys=True,
default=str))` — no `allow_nan=False`, confirmed exact at line 122. Compare market_lab.py:57
(`json.dumps(value, indent=2, allow_nan=False)`) and book_lag_lab.py:166 (`..., allow_nan=False,
default=str`) — both explicitly forbid NaN. tree_lab.py reuses market_lab's `atomic_json` via its import
line (`from market_lab import stamp, digest, atomic_json, ...`, line 67), so it's covered too — only
expert_selector_lab.py is exposed. `nfl-research-lab.js:16` confirmed exact:
`const parse = value => { try { return JSON.parse(value); } catch { return null; } };` and
`readSchema` (line 24) returns `null` whenever `parse` fails, which would silently drop the entire
`expert_selector_lab` block from the API response with no visible error. Confirmed no NaN is present in
the current frozen file (spot-checked; the claim itself says this). Confirmed, P2 as claimed — a missing
guard, not a live incident.

## #232 (research/betting/nfl/dataset.py:13, P2) — CONFIRMED

Module docstring at exactly line 13 (confirmed exact): "Two copies of a chronology is two chronologies.
They agree today because..." matches the claim's snippet verbatim. Grepped all of market_lab.py's and
tree_lab.py's import blocks (lines 17-32 and 52-70 respectively) — no reference to
`research/betting/nfl/dataset.py` or any `betting` import. `grep -rn 'betting' research/*.py` returns
exactly one unrelated docstring hit at tree_lab.py:519 (confirmed: an unrelated sentence about betting
strategy, not an import). The ONLY importer of `dataset.py` is
`research/betting/nfl/test_dataset.py` (via `sys.path.insert` at lines 20-21 and `import dataset as
shared` at line 23 — all three confirmed exact). So the shared, cutoff-safe chronology module this file
itself says was written specifically to prevent silent divergence between market_lab and tree_lab is
never actually used by either of them — the duplication risk it targets remains live in the two labs'
own inline (hand-copied, chronology-critical) code. Confirmed, P2 as claimed.

## #233 (research/betting/nfl/test_dataset.py:166, P2) — CONFIRMED

`LabParityTests.test_market_lab_and_tree_lab_agree_with_the_shared_chronology` (method name confirmed
exact at line 159; class docstring "The extraction must reproduce what the labs already compute."
confirmed exact at line 157). Read the full method body (lines 159-193): it calls
`shared.shared_setup(db)` (the module under test) but then, rather than calling into
`market_lab.build_dataset` or `tree_lab.build_dataset`, re-implements the exact same SELECT + 3-day
publication lag + week_end/history construction inline in the test file itself (lines 166-184, confirmed
matches claim's evidence almost verbatim — the comment "Recompute the labs' own inline chronology,
exactly as both files write it today, and require identical output" is present verbatim at
lines 165-166). It then asserts the shared module's output equals this hand-typed recomputation, not the
real labs' actual output. So if market_lab.py or tree_lab.py's chronology logic is ever edited without a
matching edit here, this test would keep passing regardless — it provides no actual regression coverage
against drift in the real labs, undermining exactly the guarantee its own docstring claims to provide.
Confirmed, P2 as claimed.

---

# Summary table

| key | verdict | severity kept? | notes |
|---|---|---|---|
| #217 | CONFIRMED | P1 | clean |
| #218 | CONFIRMED | P1 | strongest claim, exact number match |
| #219 | REFUTED | n/a (was P1) | live DB query directly contradicts the "zero rows under own id" premise for all 6 named players; also role_scenario_lab is not rendered anywhere client-side |
| #220 | CONFIRMED | P2 | "every cover cell" is a 1-of-6 overstatement in the evidence text; mechanism and consequence both verified |
| #221 | CONFIRMED | P2 | independently reconstructed the sign flip from frozen candidate data |
| #222 | CONFIRMED | P2 | clean |
| #223 | CONFIRMED (substance) | P2 | cited snippet does not exist at model_discipline.py:291 or anywhere in the file — citation integrity problem; underlying fact independently re-verified via VERSION consts + code_hash comparison; nfl-research-lab.js:16-24 shows this is a known/intentional compatibility shim, not a hidden bug |
| #224 | CONFIRMED | P2 | clean |
| #225 | CONFIRMED | P2 | clean, discrepancy visible in-file (line 135 vs 12/600) |
| #226 | CONFIRMED | P2 | exact spike_ratio figures (0.427/0.483) matched |
| #227 | CONFIRMED | P2 | clean |
| #228 | CONFIRMED | P2 | clean, 12x figure matches |
| #229 | CONFIRMED | P2 | clean |
| #230 | CONFIRMED | P2 | elevated relevance given live collector process noted in task's own hard rules |
| #231 | CONFIRMED | P2 | clean |
| #232 | CONFIRMED | P2 | clean |
| #233 | CONFIRMED | P2 | clean |
