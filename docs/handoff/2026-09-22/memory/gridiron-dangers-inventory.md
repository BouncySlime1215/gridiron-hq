---
name: gridiron-dangers-inventory
description: Standing gotchas/dangers list, split out of MEMORY.md for its byte cap.
metadata:
  type: project
  modified: 2026-09-22T04:40:43.560Z
---

Linked from MEMORY.md "Dangers that outlive tonight".

Never rename an applied migration (main carries two 062s, #38 a third; 063 =
#48, 064 = #47, 065 = fantasy plan outlook fit store, 066 =
league_transactions_raw (collector job)); migration deploys need DB size + 2
GB free; no scheduled live-DB backup.

**Correction (2026-09-22, verified via all remote branch tips):** 062 = three
claimants confirmed (the two on main plus `062_roster_weekly_panel.js` on the
three `f921do` branches). Spelling out the #48/#47 shorthand above: 063 =
`063_espn_credentials.js` (PR #48), 064 = `064_league_history_tables.js` (PR
#47). 065/066 already correct, unchanged. 067, 068, 069 UNCLAIMED on every
remote branch as of this check (~04:31Z); 069 has since been claimed by the
R&D integration & cleanup thread for `069_nfl_route_splits.js`, committed
locally on `claude/project-thread-2oztzw`, not yet pushed. A separate note
elsewhere that Google sign-in used 068 refers to a local, not-yet-pushed
commit this remote check could not see and is not a conflict — don't treat
068 as taken on any branch this check covered.

**Authorship correction (2026-09-22):** 066 is NOT the scheduler thread's
work, contra the line above (kept for history) — see
[[gridiron-066-authorship-unconfirmed]].

**Correction retracted (2026-09-22 ~04:38Z):** the authorship correction
above was itself wrong. 066_league_transactions_raw.js IS the scheduler
thread's file, now doubly confirmed (authoring commit `9c7cf68` sits on
three `claude/project-thread-o3wt2p*` branch tips — Scheduler's own prefix).
The checking session had only swept its 5 current local branches, not the
thread's remote namespace. Full retraction and reusable lesson:
[[gridiron-066-authorship-unconfirmed]],
[[migration-ownership-is-a-namespace-question]]. The original line 12-13
above (066 = league_transactions_raw, collector job) stands as correct.

Memos in routes/model.js and draft-assist.js have no fit id; root =
player-week-engine.js:267 'active' constant, clearPlayerWeekEngineCache :68
uncalled. Bare `/api/model/availability` does not serve the fit. ESPN
cookies one global slot until #48. 35 `|| 2026` sites. weeklyAvailability
QB/RB/WR/TE only. `default_weeks_15_17` fallback (league 4 real).
activeKVectorFor withholds volume entries from season-long callers.
players.sleeper_id 751/8,556. O4 failed calibration G3.
GRIDIRON_ADMIN_EMAIL grants model:* only on create/link until #51.
cascades() multiplier unbounded until #72's fix.

Corpus 2,500 leagues / 27,586 team-seasons, 2021-2025 (fantasy plan 02:55Z,
its container); Nick's clone corpus OPEN, O4 figures not quoted until
answered.

nfl-pbp.js's fourth-down rate mixes go-rate/conversion-rate units, making
coachAggression's "aggressive" branch unreachable on real data; backlog, no
owner, needs a scoping call. See [[fourth-down-rate-unit-mismatch]].

Sibling nfl-pbp.js danger: td-regression.js's red-zone TD tier is priced at
one flat rate hiding up to an 11.6x real range. See
[[td-regression-tier-pricing-bug]].
