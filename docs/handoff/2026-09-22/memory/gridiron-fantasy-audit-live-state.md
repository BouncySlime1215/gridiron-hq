---
name: gridiron-fantasy-audit-live-state
description: The 2026-09-19 live verification of Gridiron HQ's fantasy side — every surface works, the dramatic audit symptoms were a local thin-data artefact, and the deployed binary is not main.
metadata:
  type: project
---

Part of [[gridiron-fantasy-audit-findings]].

**Live verification 19:29Z — the fantasy side works.** Re-ran every surface
against the real leagues: league analysis returns real FantasyCalc values with
a sensible need/ok/surplus spread (no `NEED 0%` grid); Start/Sit returns week 2,
69.11 points, three coin flips and real margins; the matchup card returns a
58.4% win probability; waivers considers 248 free agents and finds 6 upgrades;
all five leagues connected at week 2, matching ESPN's scoreboard.

**The audit's dramatic symptoms were reproduced on a *local* thin-data DB and
are NOT what Nick sees.** They remain real conditional bugs — they fire when
the data thins — but nothing on that list was firing live.

## The deployed binary is not main

At audit time `/api/trades/1/lineup` returned `availability_basis.basis:
"constants"` with `availability_note` **absent** (not null — that distinction
cost an hour, see [[detecting-branch-vs-deployed-drift]]), and its warnings read
"about 74% likely to play this week" with no caveat. The branch cannot produce
that: `lineup-brain.js:562` calls `availabilityDegradation` unconditionally,
`contingency.js:611` returns a note for every basis but `'role'`, and
`lineup-brain.js:638` would append "that is not the fitted number".

**Where a code citation and live behaviour disagree, live wins.**

Settled further at 21:05Z: live `GET /api/model/availability?week=2` returns
**13** keys from `weeklyAvailability` where main returned **9**. The extra four
(`designation`, `designation_source`, `espn_status`, `role`) come from
`cfa0e6f`, which is on the `-3ldl77` line and seventeen other branches but not
on the old main. So the machine was running **branch** work. An earlier claim
that the build "sits *inside* `cfa0e6f`" was retracted — a build is at a
commit, not partway through one. See [[gridiron-deployed-build-bracket]].

## The one live, unflagged defect

Uncaveated chance-to-play percentages. The underlying fix is
`scripts/fit-availability.mjs`, since both fitted tables are absent. It was
offered to Nick and withdrawn on the belief that the script was not on the
deployed machine — **that belief was wrong**: Nick's 20:58Z probe showed it is
present. See [[gridiron-availability-fit]].

The fantasy plan thread ran it against a local full-history rebuild: main gate
passes on 8,663 held-out rows, log loss 0.558 -> 0.397, calibration
0.082 -> 0.017, and a starter with no injury report actually plays **94.5%**
where the app shipped 69.5%. The role table stayed empty on one 60-row
unknown-tier cell failing a per-cell check; that veto is what #37 (gate v2)
restructured, with Nick's approval, before re-running.

Full write-up with per-item evidence:
`/mnt/project-files/fantasy-audit-2026-09-19.md`.

See [[gridiron-player-universe-real]] and [[fly-deployment-outside-repo]].
