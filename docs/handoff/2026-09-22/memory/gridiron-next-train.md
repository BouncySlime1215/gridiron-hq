---
name: gridiron-next-train
description: The PR train after the 2026-09-19 release: order, what each carries, the migration numbering rule, syncEspnMarket ownership.
metadata:
  type: project
  modified: 2026-09-19T22:04:05.948Z
---

**Order:** grace_period 300s fly.toml PR (scheduler thread, one line; #17 set 60s and a boot with 11 migrations + VACUUM INTO exceeds it) FIRST, then #40 (head 671a9a3 on claude/project-thread-f921do-sim, a MERGE of main not a rebase, force-push blocked; 2,966 pass), #44 (4b8b3c3, on #40; O3, simulator basis switches at TWO games), UI odds-label PR (on #40), #36, #38, #39, #41, #42, #15, #43 (availability basis on Start/Sit/waivers/Trade Lab; matchup denominator), #45 (≥17 distinct weeks), #46, #47, #48, syncEspnMarket PR, UI Settings data section (Nick may veto), NFL_SEASON tidy, tradeWeekContext fix, season-long path onto the fit, fit id in cache keys, docs PR.

**#46** (UI): Mac-only copy removed; Phone access hidden off-loopback; NOW ALSO the account/invite/sign-out surface for #14's API (signed-in identity, admin invite list add/revoke, accounts list; gated on the session's admin grant and Google configured; 2,959 tests). After deploy Nick invites the Transfer portal managers from Settings.

**#47** (chat-sync): league_history job, 12h growth tier + FANTASY_LIVE_JOBS; the live box runs SCHEDULER_DISABLED=1 so scripts/refresh-live-data.mjs is the real schedule; ~41 additive scheduler.js lines.

**#48** (Google sign-in, f377a09): ESPN credentials per account; 063 carries the existing pair + connect token onto gridiron-local-owner, down() restores; no anonymous league fetch; 2,964 tests. NOT in tonight's train: first migration whose undo needs rows; wants its own deploy and snapshot. Follow-up (Google sign-in thread, 22:00Z): grantAdmin convergence in account-link.js (existing-identity branch :79-94 returns without granting; only :144 grants).

**O4 (#42)**: beats baselines 14/14, verdict tiers hold, FAILED pre-registered calibration on 2024; ship ordering + verdict + comps + luck/noise, playoff % as a band with error; re-run the unchanged rule after the crawl. Shared variance DEFERRED (cv ≈ 0.205; scripts/audit-team-week-spread.mjs on #42).

**Migration rule** (scheduler thread, 21:54Z): sequential `NNN_`, next number free across EVERY remote branch (not merged history), `name` export identical to the filename. #38 KEEPS 062_roster_weekly_panel (NOT #42, which has no migration; main already has 062_google_identity_and_invites and 062_league_payload_season, so it is the third 062 and the lint exempts that number), #48 keeps 063_espn_credentials, #47 moves from a timestamp name to 064_league_history_tables (timestamp names sort after NNN_, inverting run order). Never rename an applied migration.

**syncEspnMarket**: agreed rule and ownership in [[gridiron-sync-espn-market]].

**Wiring map v7 (#36)**: 20 gaps closed, 60 new; opportunity-model.js permanent orphan; four unrouted pages (Edge, Model, Projections, Rankings) baselined; UI thread decides deletion. Page https://claude.ai/artifact/CUKM2d3hSkhfYAGLRbuMjY.

**No backup of the live DB exists on any schedule** (release thread, 21:57Z): `scripts/nightly-backup.sh` runs from a LaunchAgent on Nick's Mac against his local clone, never /data; the pre-migration .bak this deploy writes is the only copy of the live rows ever taken. A live backup job belongs on the next train.

**Also queued (feature-audit, post-deploy):** one draft PR taking routes/aggregates.js: computeConsensus admits the ESPN source only when em.season is the current NFL season (board falls back to FFC/Sleeper and market.unsourced fires honestly), espnMarketFreshness returns MAX(season) for the UI thread to show on the Draft board, plus the tradeWeekContext fix. /aggregates/refresh-all never called syncEspnMarket. #38's annotations entry waits for #36 (annotations.json arrives with #36); injury-return.js goes in a separate _OWED_WIRING block, not the permanent-orphan list.
