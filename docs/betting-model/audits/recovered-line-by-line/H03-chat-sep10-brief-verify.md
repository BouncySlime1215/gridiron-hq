# Adversarial verification — H03-chat-sep10-brief (6 claims)

Verifier ran read-only. Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard
No files edited. No git state changed (only rev-list, log, merge-base --is-ancestor, status used).
DB opened read-only via `node:sqlite` `{readOnly:true}` one-liners against `server/data.sqlite` only.

## #276 — unpushed work / CI workflow-scope push block — CONFIRMED, P1

Verified directly against live repo state (not just the chat transcript):
- `git rev-list --count origin/main..main` = **58** (matches claim exactly)
- `git log -1 origin/main` = `7dfd3f2` dated `2026-09-08 22:13:22 -0400` (matches claim's "still 7dfd3f2 dated 2026-09-08 22:13")
- `git log -1 HEAD` = `14c5e65` dated `2026-09-10 22:38:47 -0400` (matches claim's HEAD)
- `git status`: "Your branch is ahead of 'origin/main' by 58 commits" — working tree clean, nothing staged
- `.github/workflows/ci.yml` first added in commit `a7bcf00`, `2026-09-10 03:25:29 -0400` (claim says 03:23 — 2-minute discrepancy, immaterial)
- `git merge-base --is-ancestor a7bcf00 origin/main` → NOT an ancestor — confirms the CI-workflow commit itself is among the 58 unpushed commits, consistent with the claimed push-blocking mechanism
- The quoted chat snippet at jsonl line 133 (`f96d39d8-9af2-4058-8794-515a2e30c315.jsonl`) matches verbatim: "main has 47 unpushed commits and one of them touches the CI workflow file. Your GitHub token lacks the `workflow` scope, so GitHub rejects the whole push." (47 vs today's 58 is just an earlier point in the same multi-day stall — consistent, not contradictory.)

Impact: genuinely satisfies the bar — multiple days of substantive work (weekly-learning phases, Codex plan implementation, T-60 work, FanDuel provider) sit on a single local disk with zero remote copy, and Nick's own standing rule ("after any push, always pull-forward every other local clone") is inert because there is nothing to pull. This is a real, current, verifiable state — not a stale complaint. I could not verify the "Documents clone is 58 commits behind" sub-claim directly (no access to that path from here) but it is a reasonable and low-risk inference from the same push block.

Verdict: **not refuted**, P1 confirmed.

## #277 — market_anchor reads CLOSING line in backtests, OPENER live — CONFIRMED, P1

File: `server/services/nfl-ensemble.js` (1423 lines; read 1-80, 570-650, 1030-1100, 1200-1280, 1355-1395, plus targeted greps).

- Line 60: `games()` (used to build `all`/historical training rows, called at lines 1241 and 1365) explicitly selects `NULL AS open_spread, NULL AS open_total` — confirmed verbatim.
- Lines 1246-1250 (the *single target-game* fetch inside `ensembleLine`): `CASE WHEN team_score IS NULL THEN open_spread END AS open_spread` — so open_spread survives only for a game with no score yet (i.e. a live/future game); for any already-played (historical/replayed) game it is forced NULL here too.
- `buildContext` (line 809, confirmed at 815-816): `spread: g.home_spread` (closing), `openSpread: g.open_spread` (whatever the query above produced).
- `market_anchor.predict` (lines 599-604): `margin: c.openSpread != null ? -c.openSpread : c.spread != null ? -c.spread : null` — so whenever openSpread is null (i.e., every historical/replayed/back-tested game, and also every row inside the weight-fitting loop at lines 1059-1067 which is built from `all = games()`, i.e. always-null open_spread), it silently falls back to the **closing** spread.
- The component's own note (line 600): "Starts from the number the books opened and keeps it — the market is a strong prior." This is materially false for every backtest/weight-fit path; true only for a genuinely live (unplayed) game evaluated once, on the day.

Empirically this means: the entire weight-fitting loop (`fitEnsemble`, which walks `scoreGames` derived from `all = games()`) always sees `market_anchor` anchored to the close, never the open, for every single historical game it fits/scores on. Only a live `ensembleLine()` call for an unplayed game gets the real opener. This is exactly the claim.

I could not fully verify the specific downstream percentages quoted in "impact" (17.7-17.9% margin weight, 0.00 deviation on 724 replayed bets, the "49.7% at the opener" headline, run 27/31/32 references) without running the (large, stateful) ensemble/backtest pipeline, which is out of scope for a read-only pass and risks nothing (I did not run it). But the causal mechanism is unambiguous and confirmed at the source, and it is exactly the kind of thing that leaks the close into an "opener" test — this clears the impact bar (backtest/validity contamination, a number Nick would read as "edge vs the opener").

Verdict: **not refuted**, P1 confirmed. (Corrected claim: same as stated; confidence very high on the code mechanism, moderate/unverified on the specific downstream percentages, which I did not independently reproduce.)

## #278 — game_lines.open_spread is a four-era, non-bettable patchwork — CONFIRMED, P1

Files: `server/services/nfl-opening-lines.js` (347 lines, read in full) and `server/services/odds-archive.js` (read 1-150).

- Header docstring of `ingestSuperContestLines` (lines 274-279) literally reads: "HONEST ABOUT WHAT THESE ARE. They are Westgate SuperContest lines, posted early in the week rather than the true first number a book hangs. So they are an EARLY line, not strictly an opening one..." — matches the claim's quoted snippet almost verbatim.
- `odds-archive.js` lines 22-24, 89-94, 136, 139-142 confirm the 2022-2025(+) mechanism: `median()` across up to 11 books' (`ARCHIVE_PAIDS`, 11 entries) `openingLines` (OddsTrader's "last quote each book posted before kickoff" framing is itself a bit fuzzy about true synchronicity), written into `game_lines.open_spread` only where null (`COALESCE`).
- Season coverage check (read-only DB query) confirms the claimed four-era structure: 2013-2020 SuperContest-sourced (256/256/.../251 of ~267-269 games), 2021 nflverse `initial_lines.csv` (272 of 285), 2022 mixed (267 of 284, i.e. partially archive-filled), 2023-2025 fully archive-covered (285/285 each).
- **Empirically reproduced the exact headline numbers**: `AVG(|spread-open_spread|)` and move counts by season (home rows only, both non-null):
  - 2021: n=272, avg=**3.40**, ≥3pt=**139**, ≥7pt=**29** — matches claim's "3.40 pts ... 139 games ... 29" **exactly**.
  - 2023: avg=1.19, 2024: avg=0.93, 2025: avg=1.17 — matches claim's "~1.x for 2023-25".
  - 2013/2018/2020 (SuperContest era): avg 0.88-1.16 — much tighter than 2021, consistent with 2021 being the outlier/corrupt season.
- **Exact-match rate vs Pinnacle's real archived opener** (joined `game_lines.open_spread` to `nfl_odds_archive` book='pinnacle', phase='open', market='spreads', side=home team, for the overlapping 2022-2026 seasons where both exist): 449/1138 = **39.5%**, i.e. ~40% — matches the claim's "matches Pinnacle's true opener exactly only 40% of the time" almost exactly. (Claim's "2021" framing for this stat is a bit loose — 2021 has no Pinnacle archive row to compare against since the archive only covers 2022-2026 — but the 40% figure itself reproduces cleanly against the seasons where the comparison is actually possible, so the substance holds.)
- Did not independently reproduce "43 of 201 checkable bets at 28-15 (65%) and 25 of 45 side-flips" (would require running the actual replay grading code, out of scope/risk for a read-only pass) but given how precisely every other quantitative claim in this item reproduced against the raw DB, I have no basis to doubt it and did not find anything contradicting it.

Verdict: **not refuted**, P1 confirmed — and unusually well-substantiated (three independently-reproduced exact statistics).

## #279 — "0 hypotheses survive, 8 refuted" is an artifact of total agent failure, not a real result — CONFIRMED, P2

File: `.../77190978-4d50-4315-861c-375dfc788580/workflows/wf_d6fb1c68-bd1.json` (single-line JSON, 74,372 bytes; parsed with `python3 -m json` rather than line-based reading since it has no newlines — read via `json.load` and printed every top-level field, `phases`, and all 39 `logs` entries in full).

- `status`: "completed", `agentCount`: 40 — matches "completed, 40-agent" framing.
- `result.report` = **null** — confirmed exactly.
- `result.surviving` = **[]** — confirmed exactly.
- `result.refuted` = list of exactly **8** hypotheses (H1-H8, with full text) — confirmed exactly.
- `result.proposal_count` = **0** — confirmed exactly.
- `logs` (39 entries) show, in order: 8/8 investigate lenses reported (45 findings) → 8 hypotheses to verify → 4 stalls → then **every one of the 24 verify agents** (`verify:H1..H8 : code-truth/stats/alt-explanation`, 8×3=24) fails with the identical string `"You've hit your session limit · resets 2:30am (America/New_York)"` → log line 30 literally reads `"0 hypotheses survive, 8 refuted"` immediately after 24/24 verify failures, with zero successful verifications preceding it → then all 3 `propose:*` agents fail the same way → `"0 proposals"` → both `judge:*` agents fail → `synthesize` fails → `critic` fails.
- This is an exact, line-for-line match to the claim: all 24 verify agents, all 3 propose, both judge, synthesize and critic all failed on session limit, and the pipeline still emitted a "surviving/refuted" verdict by (apparently) treating "verify agent didn't return a survive" as "refuted" rather than "unknown/inconclusive."

Impact: the claim itself flags that this is dangerous because a future reader (human or agent) sees a clean "8 refuted, 0 survive" JSON and would reasonably conclude the underlying hypotheses (shrinkage mechanism, -55.4u dog attribution, 0.705 edge-vs-line-move correlation, nfelo-vs-Pinnacle-opener signal) were disproven, when in fact they were never tested at all. This is a real, verified process/reporting defect with a plausible bad-decision consequence (someone deprioritizing or discarding real findings believing they're refuted). I did not audit whether the *underlying* H1-H8 claims themselves are true (that would require re-running the actual investigation, out of scope) — the claim under test here is narrowly about the verification pipeline's failure being mis-recorded as a substantive result, and that is fully confirmed.

Verdict: **not refuted**, P2 as assessed (could arguably be P1 given it invalidates an entire 40-agent audit's conclusions, but P2 is defensible since the JSON file itself is not something Nick reads directly on a dashboard — it's an internal artifact of a diagnostic run).

## #280 — plaintext Odds API key pasted into a persisted chat transcript — CONFIRMED (with one correction), P2

File: `.../77190978-4d50-4315-861c-375dfc788580.jsonl`, line 6812 (15,067 lines total; read the cited line plus ~150 surrounding lines across 6790-6950 in detail).

- Line 6812 (`type: user`) content is exactly: `"* 20K\n* 20,000 credits per month\n* $30 USD / month billed automatically each month\n\n15dcf76e1341d0d525df93568576fba1\n\nnew key for api"` — confirms the 32-hex-char key (`15dcf76e1341d0d525df93568576fba1`, 32 characters, ends `76fba1`) pasted in plaintext, on a $30/mo 20K-credit plan. Confirmed verbatim.
- **Correction to the claim's history**: the claim states "The assistant states it used the key transiently via an inline env var and never wrote it to .env." The assistant *does* say this later (an internal `thinking` block at line 7017: "...and .env stays clean since I only used it transiently via an inline env var, never persisted to disk") — so the claim accurately reports what the assistant *said*. However, tracing the actual tool calls shows this self-report is not fully accurate as a history: at line 6834 the assistant ran `printf '\nSPORTSGAMEODDS_API_KEY=%s\n' "$KEY_VALUE" >> .env` (confirmed appended — grep at line 6840 shows the new line present, `.env` now 9 lines), i.e. the raw key value *was* written to `.env` for a period, under the wrong variable name. It was later removed via a python cleanup at line 6846 ("Remove the incorrect SPORTSGAMEODDS_API_KEY line I added"), and only *after* that removal did the assistant switch to the transient inline-env-var approach for the actual historical-data pull (confirmed at lines 6864 and 7017). Current `.env` (checked directly, read-only, values redacted) has no `SPORTSGAMEODDS_API_KEY` and no `76fba1` substring — consistent with the end state being "not in .env now," but the claim's phrasing that it was "never written to .env" glosses over an actual (brief, since-corrected) write.
- The Nick-correction detail is confirmed: a queued user message at line 6841 reads "also this key does historicals - we need to just capture it once and store it \nthis is odds api" — this is what triggers the assistant's realization it had mis-assigned the key to `SPORTSGAMEODDS_API_KEY` instead of treating it as an Odds API historical-tier key (confirmed in the assistant's thinking block at line 6844/6845, and its response at line 6845: "Understood — this is a paid Odds API historical-tier key... Fixing the `.env` assignment first (I put it in the wrong variable)").
- Core exposure claim (plaintext key sitting in a persisted 15,067-line / ~large transcript file that any local agent could read) is real and independent of the .env nuance above.

Verdict: **not refuted**, P2. Corrected claim: the "never wrote it to .env" detail should read "briefly wrote it to `.env` under the wrong variable name, then removed it before the actual capture, which used a transient inline env var" — a minor factual correction that does not change the core finding or its severity (the credential is exposed in the chat transcript regardless of what happened with `.env`).

## #281 — opener PRICES exist in nfl_odds_archive but no grader reads them — CONFIRMED (file/mechanism nuance), P2

File: `server/services/nfl-replay.js` (1102 lines; read lines 1-120 in detail plus targeted greps across the file).

- Line 94 (exact): "There is no stored opening PRICE (no `open_spread_odds` column, only the opening line number)..." — matches the claim's quoted text exactly. Lines 94-98 go on to say opener win/loss is graded on the line number alone and "this never feeds `units`/staking, which still settle at the one price that was ever actually obtainable: the closing odds." So `nfl-replay.js` deliberately assigns **no price at all** to opener-side bets (not a flat -110 — it explicitly opts out of pricing them).
- Confirmed via DB query that `nfl_odds_archive` does hold real per-book opening **prices** (not just lines) for 2022-2026 — e.g., Pinnacle spreads phase='open': 2276 rows, of which 968 (**42.5% ≈ ~43%**) are NOT exactly ±110 — matches the claim's "~43%" almost exactly.
- Confirmed via `grep` that no service in `server/services/*.js` ever selects the `price` column from `nfl_odds_archive` (only `line`) — so the real opening-price data genuinely goes unread everywhere in the codebase for economics purposes.
- **Nuance vs. the claim's framing**: the actual "flat -110" *assumption* (rather than "no price at all") lives in a **different** file, `server/services/line-move-study.js` (line 433-436: `grade()` hard-codes ±0.909/-1, i.e. -110 both sides, for `units_at_opener`/`units_at_close`), and that file already labels the result "descriptive, not promotion evidence" rather than presenting it as a real ROI. So the claim's specific sentence "nfl-replay.js grades and settles at game_lines closing odds; the flat -110 assumption is wrong on ~43% of Pinnacle openers" conflates two files: `nfl-replay.js` (which assigns no price to openers, correctly, by its own design) and `line-move-study.js` (which does assume flat -110, but discloses it as descriptive-only). The core insight — the real per-book opener price data sits unused in `nfl_odds_archive` and every grader either avoids opener pricing entirely or falls back to a disclosed flat-vig approximation — is accurate and reproducible; the specific claim that `nfl-replay.js` "grades ... at closing odds" for opener bets is correct for the *primary* grade (line 341: "Historical payouts use each stored price; there is no synthetic -110" — real closing prices), but its *opener*-specific diagnostics use no price/units at all, not a -110 assumption.

Verdict: **not refuted** on substance (real opening prices exist and are unused for opener economics; the ~43% figure reproduces almost exactly), but the file attribution/mechanism description is imprecise — the flat -110 code lives in `line-move-study.js`, not `nfl-replay.js`, and `nfl-replay.js` itself avoids assigning any price to opener bets rather than assuming -110. corrected_severity: P2 (as assessed), with a corrected mechanism description.
