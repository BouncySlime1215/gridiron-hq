# Recovery plan — the deleted live database (2026-09-16)

**Incident.** At about 21:29 EDT on 2026-09-16 the folder
`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/` was deleted, including
`server/data.sqlite` (about 16 GB), its `.env`, and the launcher logs. A separate chat
deleted it. No Claude session transcript on this machine contains the deleting command;
the Trash is empty; no Time Machine destination is configured; no running process held
the file open. The file is not recoverable from this machine.

**What this document is.** A sorted inventory of what that database held, grouped by
where each table's data came from, with the surviving row counts, and an ordered plan to
get back everything that can come back. The full 221-table inventory with writer files
and counts is in `docs/evidence/2026-09-16/recovery/table_inventory.csv`.

**Counting convention.** "Live" is the row count I read from the deleted file earlier the
same evening (read-only queries between 21:05 and 21:28). "Repo copy" is
`gridiron-hq/server/data.sqlite` (280 MB, last written 13:29 on 09-16). "Extract" is
`/tmp/gridiron-extract/real.sqlite` (104 MB, a read-only extract made from the live file
earlier on 09-16). Blank means I did not record it.

---

## 1. What survived untouched

| Asset | Where | Notes |
|---|---|---|
| All code, migrations, tests | `gridiron-hq` repo, `origin/main` and `origin/cursor/betting-model-audit-fixes-1c85` | The decision-tape and news-event code from 09-15/16 is present. The repo database is 10 migrations behind the schema (206 tables vs 216), so `db:migrate` creates the missing ones. |
| Research evidence | `docs/evidence/**` | Walk-forward forecasts per game 2021-2025 (opener-clv JSONL), repaired openers, leaderboard JSON, scorecards, every report. |
| Repo database | `server/data.sqlite` + 3 `.pre-migration-*.bak` copies | 206 tables. Full `game_lines`. 98% of nflverse tables. 16 pick decisions, 56 shadow decisions. |
| Extract | `/tmp/gridiron-extract/real.sqlite` | Full snaps (127,958), depth (179,325), injuries (28,574), 9,270 game lines. `/tmp` is not durable: copy it to `data/line-history/` today. |
| New line-history archive | `data/line-history/line_history.sqlite` (gitignored) | Built tonight, independent of the deleted file. Covers: 2,529 games, 1.91M per-change rows, 4 books, 3 markets, 2019-2026. Polymarket: 16.6M per-minute points, 3,049 markets, 2024-2026. Action Network: 36K ticks, 31 games, 2026 weeks 1-2. |
| Old backup | `~/Documents/gridiron-db-backups/data.sqlite.pre-restore-backup-20260903-143356` | 23 MB, 2026-09-03. Only useful for app state older than that. |

## 2. What the deleted database held, sorted by source

### 2a. Public football data — rebuild free from nflverse and the existing loaders

| Table | Live | Repo copy | Extract | Source / loader |
|---|---:|---:|---:|---|
| game_lines | 15,096 | 15,096 | 9,270 | nflverse schedules + odds; intact |
| nfl_injuries | 28,585 | 27,983 | 28,574 | nflverse injuries (`server/services/nflverse.js`) |
| nfl_snaps | 127,958 | 126,561 | 127,958 | nflverse snap counts |
| nfl_depth | 179,325 | 171,240 | 179,325 | nflverse depth charts |
| player_week_usage | 43,771 | 41,572 | 0 | nflverse player stats |
| player_week_snaps | 43,461 | 0 | 0 | nflverse snap counts by gsis id |
| nfl_play_by_play, nfl_ngs, nfl_pfr_adv, nfl_qbr_weekly, nfl_nfelo_* | | present | | nflverse, Next Gen Stats, PFR, ESPN QBR, nfelo |
| nfl_team_coaches | 384 | 0 | 0 | PFR coaching history |
| nfl_game_weather | | present | | Open-Meteo history |
| nfl_stadiums, nfl_team_stadiums, nfl_teams | | present | | static seed |

Loss: none that matters. Gaps close with one sync run.

### 2b. Derived from public data — rebuild free by re-running builders

| Table | Live | Repo copy | Builder |
|---|---:|---:|---|
| nfl_verified_events | 119,639 | 0 | verified-event archive builder from nflverse injuries + weekly roster snapshots; minute timestamps come from nflverse `modified_at` (through Jan 2025) |
| nfl_team_week_features, nfl_player_week_features, feature vectors | | present | feature builders |
| nfl_historical_signal_replay | 8,520 | 0 | signal replay |
| nfl_ensemble_fit_artifacts | 848 | present (older) | weekly `fitEnsemble` |
| nfl_historical_adp*, nfl_historical_ffc_adp | 28,211 | present | ADP scrapes (historical, re-scrapeable) |

Loss: none in content. The fit artifacts' original creation timestamps are gone; regenerated fits reproduce the committed evidence JSON but are dated today.

### 2c. Market history before 2026 — mostly better than before, one paid gap

| Table | Live | Repo copy | Replacement |
|---|---:|---:|---|
| nfl_odds_archive (10 books, open + close, 2022-2025) | 135,930 | 0 | Covers gives open + every change for bet365, BetVictor, William Hill, Betway 2019-2026. Pinnacle and the US books' open/close need The Odds API historical (paid). The repaired Pinnacle openers survive in `docs/evidence/2026-09-16/opener-repair/repaired-openers.json`. |
| nfl_line_snapshots 2022-2025 (~5 h cadence) | ~130K/yr | 10,263 | Covers per-change rows are strictly denser. Nothing lost that the old table could answer. |
| nfl_quote_tape 2020-2025 (weekly Odds API snapshots) | ~160K | 4,080 | Odds API historical (paid) if wanted; low value. |
| polymarket_price_history | 29,758 | 0 | Rebuilt: 16.6M points. |

Loss: only the multi-book open/close for the 6 books Covers does not carry, and only until the paid pull runs.

### 2d. Market capture during 2026 — the real loss, partly patchable

| Table | Live | Repo copy | Replacement |
|---|---:|---:|---|
| nfl_quote_tape 2026 (13-min cadence, 30 books, Sep 2-16) | ~2.24M | 0 | The Odds API historical at 5-min spacing, from Sep 2. About 40K credits at 15-min spacing for spreads/totals/h2h in one region: one month of the mid tier, roughly $60-100. |
| nfl_line_snapshots 2026 (free feeds, ~hourly) | ~2.5M | 0 | Action Network holds week 1-2 ticks for about two weeks (captured 31 games already). Otherwise the paid pull. |
| polymarket_quotes (order book, seconds) | 22.9M | 69,655 | Per-minute mid price rebuilt. Bid/ask sizes and sub-minute detail are gone. |
| prediction_market_quotes (Kalshi) | | 1,024 | Kalshi public trades since Sep 2025: rebuildable. |
| nfl_prop_quote_snapshots, nfl_prop_clv (props, 2026) | 101,820 | 2,539 | Odds API historical props (paid, 5-min, since May 2023). |
| nfl_alt_spread_quotes, nfl_sgp_quotes | | present | Odds API historical (paid) for alternates; SGP quotes gone. |
| espn_line_moves | 149 | 17 | Gone. Forward capture only. |
| nfl_game_weather_forecast_history (point-in-time forecasts) | 3,810 | 0 | Open-Meteo previous-runs API can reconstruct past forecasts by lead time. Test before relying on it. |
| nfl_pregame_snapshot_history (roster/QB/injury snapshots per week, 2026) | 4,554 | 32 | Gone as captured. Approximate from nflverse weekly data. |

### 2e. News and coach speak — partly gone

| Table | Live | Repo copy | Replacement |
|---|---:|---:|---|
| press_conferences (YouTube transcripts, Aug-Sep 2026) | 2,455 | table missing until migrate | Re-scrape with yt-dlp from the validated team channel ids in `server/services/press-conference.js`. Can extend back to 2021. |
| press_availability | 171 | table missing | Re-derived from transcripts. |
| news_items (ESPN + Twitter, 2026) | 4,223 | 438 | ESPN items partly refetchable. Tweets only if the Twitter API replays timelines. |
| nfl_news_signals, nfl_news_extraction_attempts | 704 / 416 | 26 / ? | Re-derived from whatever news_items come back. |
| nfl_tweet_line_watch (tweet -> line move, 23.9K) | 23,900 | 0 | Gone. It needed the line at tweet time. Rebuild forward only. |
| nfl_news_events, nfl_news_event_extraction_cache | 30 / 44 | table missing | Small; re-derived. |

### 2f. Decision and audit record — gone, nothing financial

| Table | Live | Repo copy | Note |
|---|---:|---:|---|
| nfl_pick_decisions | 16 | 16 | intact |
| shadow_decisions | 189 | 56 | 133 rows gone |
| nfl_decision_events (append-only tape) | 0 | table missing | was empty |
| audit_registry (sealed preregistrations) | 15 | table missing | Gone. Re-run produces the same statistics; the seal dates are lost and the docs must say so. |
| nfl_bet_log, nfl_execution_log, nfl_execution_opportunities, forward_picks, nfl_replay_bets | 0 | 0 | were empty: no real-money ledger existed |
| nfl_teaser_executions | 1 (paper) | table missing | gone, paper only |

### 2g. App state

users, leagues, drafts, settings, auth sessions, ai_usage, odds_usage: present in the repo
copy as of 09-16 13:29. `.env` (API keys) is gone and must be re-entered.

### 2h. Tables with no writer in the repo (14)

Listed in the CSV as "no writer found". Legacy or written by code paths that never
reached this branch. Ignore unless something reads them.

---

## 3. The plan, in order

Owner column: "this chat" is the session that wrote this file; "other chat" is the
session on `cursor/betting-model-audit-fixes-1c85`. One database, one writer at a time.

| # | Step | Owner | Cost | Time |
|---|---|---|---|---|
| 0 | Copy `/tmp/gridiron-extract/real.sqlite` to `data/line-history/extract-2026-09-16.sqlite`. `/tmp` does not survive a reboot. | this chat | free | 1 min |
| 1 | Nightly backup before anything else: a launchd job that calls `backupBeforeMigration('nightly')` from `server/db/index.js` (it uses `VACUUM INTO`, safe under WAL) into `~/Documents/gridiron-db-backups/`, and keeps 7 copies. | this chat | free | 30 min |
| 2 | New `.env` in the repo from `.env.example`: The Odds API key, Twitter API key, YouTube key if used, Anthropic key. Keys are Nick's to enter. | Nick | | 10 min |
| 3 | `npm run db:migrate` on the repo database. Creates the 10 missing tables (press_conferences, audit_registry, nfl_decision_events, ...). Takes its own pre-migration backup. | one chat, not both | free | 5 min |
| 4 | Public syncs: `npm run sync:data`, then `node server/scripts/sync-history.js 2021 2022 2023 2024 2025`, then the nflverse injury/snap/depth/coaches loaders (routes under `server/routes/edge.js` and `nflverse.js`). Verify counts against §2a. | same chat as 3 | free | 1-2 h runtime |
| 5 | Rebuild derived tables: verified-event archive, feature vectors, signal replay. Verify 119,639 verified events and that `time_precision='timestamp'` rows end 2025-01-05 as before. | same chat | free | 1-2 h |
| 6 | Wire the line-history archive into the readers. One adapter module that serves (game, book, market, time) -> line/price from `covers_line_history`, `pm_price_history`, `an_line_history`, with the same interface the opener/CLV code used on `nfl_line_snapshots`. Team-code map: Covers `JAC`->`JAX`, `LA`->`LAR`. | this chat | free | half a day |
| 7 | Keep Action Network capture running weekly: `python3 scripts/line-history/actionnetwork_capture.py` every Tuesday and Friday. Add to launchd. It is the only free source of US-book ticks and it expires after two weeks. | this chat | free | 15 min |
| 8 | Paid pull (Nick's call): The Odds API historical, 2026-09-02 to now at 15-min spacing for spreads/totals/h2h, plus one open and one close snapshot per game 2022-2025 for the 10-book archive. `nfl-quote-tape.js` already targets the historical endpoint. Estimate credits before running: 10 per region per market per snapshot. | Nick decides, then one chat | ~$60-100 | 1 day |
| 9 | Press conferences: yt-dlp over the validated channel ids, auto-captions, from 2021 forward. Store to `press_conferences` with the same columns. | this chat | free | 1-2 days runtime |
| 10 | News: refetch ESPN items for Aug 15 onward; re-run signal extraction. Accept that tweets and the tweet-line study restart forward from now. | other chat | free | 2 h |
| 11 | Regenerate fits and audits with the lab scripts. Confirm they reproduce the committed JSON. Add a dated note to `LATEST-PLAN.md` that the audit registry was re-sealed on the regeneration date. | other chat | free | half a day |
| 12 | Point every path in code, launchd plists, and docs at the repo, and retire the Artifacts location. Kill the four orphaned node processes still running from the deleted folder (pids 50918, 86535, 50971, 18014) once nothing depends on port 5199. | Nick or either chat | free | 30 min |

## 4. Verification checklist after steps 3-5

- `SELECT count(*) FROM nfl_verified_events` = 119,639, with 39,052 `official_injury_report` rows at `time_precision='timestamp'`.
- `nfl_injuries` 28,585; `nfl_snaps` 127,958 + 2026 weeks; `nfl_depth` 179,325 + 2026.
- `game_lines` 15,096 and `open_spread_source` populated by the opener repair.
- Full test suite green (was 2,202 passing before the incident).
- `node scripts/run-historical-leaderboard.mjs` reproduces `docs/evidence/2026-09-13/historical-leaderboard-report.json` except `generated_at`.

## 5. Rules while recovering

- One writer per database at a time. Agree which chat runs steps 3-5 before starting.
- Every script that touches the live file takes a `VACUUM INTO` backup first, as the migration runner already does.
- Nothing from `data/line-history/` is committed; the collectors are.
- Do not delete the `.pre-migration-*.bak` files until the nightly backup has run twice.
