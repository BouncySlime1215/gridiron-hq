---
name: migration-numbering-gridiron
description: How to name and number a Gridiron HQ migration — why the timestamp form must not go in one file at a time, and why a free number cannot be read off merged history.
metadata:
  type: reference
  modified: 2026-09-22T04:41:27.177Z
---

Settled 2026-09-19 between the chat-sync and scheduler (#39) threads, while
adding `064_league_history_tables.js` (see [[league-history-orphan-closed]]).

**Migration numbering, settled 2026-09-19 with the scheduler thread (#39):**
the file is `064_league_history_tables.js`. The timestamp form was wrong here
even though timestamps are the right destination convention — `migrate.js`
sorts filenames lexicographically, so a 14-digit name sorts after every `0xx`
file today and *before* every `0xx` file written after it. One file switching
early inverts the order for the next numbered migration that depends on it.
The switch has to be project-wide or not at all, and #39 owns it.

**A free migration number cannot be read off merged history.** Swept every
remote branch 2026-09-19: 060, 061, 062 (three claimants —
`google_identity_and_invites`, `league_payload_season`, `roster_weekly_panel`)
and `063_espn_credentials` (on `claude/project-thread-n4052e`, unmerged) were
all taken. Sweep the branches, do not take the next number after `ls`.

**Correction (2026-09-22, verified via all 150 remote branch tips):** as of
~04:31Z, 067, 068, 069 are UNCLAIMED on every remote branch — 064 =
`064_league_history_tables.js`, 065 = fantasy plan's outlook fit store, 066 =
`066_league_transactions_raw.js` (exists, branch-tip confirmed), all
confirmed, nothing above 066 taken remotely. 069 has since been claimed by the
R&D integration & cleanup thread for `069_nfl_route_splits.js`, committed locally
on `claude/project-thread-2oztzw`, not yet pushed — re-sweep before anyone
else takes 067, 068, or 069.

**Authorship correction (2026-09-22):** 066 is NOT "the scheduler's collector
job" as previously stated here — author/owning thread not yet confirmed. See
[[gridiron-066-authorship-unconfirmed]].

**Correction retracted (~04:38Z):** wrong — 066 IS the scheduler's file,
confirmed via authoring commit `9c7cf68` sitting on three `o3wt2p*` remote
branch tips (Scheduler's own prefix). The check that produced the retraction
only swept 5 current local branches; ownership questions need the thread's
remote namespace, not local state. Lesson:
[[migration-ownership-is-a-namespace-question]]. 066 = collector job,
Scheduler's, as originally stated.

`migrate.js`'s name-export/filename mismatch hazard, the permanent-old-numbers
rule, and the discovery regex moved to
[[migration-numbering-gridiron-mechanics]] for this file's byte cap.
