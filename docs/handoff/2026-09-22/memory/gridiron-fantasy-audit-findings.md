---
name: gridiron-fantasy-audit-findings
description: Index to the 2026-09-19 fantasy audit of Gridiron HQ — the live surfaces all work, the findings are conditional bugs, and the three fixes shipped.
metadata:
  type: project
---

The 2026-09-19 audit of Gridiron HQ's fantasy side: Start/Sit, matchups, the
draft room, waivers, trades and league sync, across all five leagues at week 2
of the 2026 season.

**The headline, so nobody re-derives the wrong one:** the live fantasy surfaces
all **work**. The audit's dramatic symptoms were reproduced on a *local*
thin-data database and are not what Nick sees. They are real **conditional**
bugs — they fire when the data thins — and three PRs fixing them have shipped.

This note was split 2026-09-19 because it had grown past the 4 KB that recall
shows. Read the piece you need:

- **[[gridiron-fantasy-audit-live-state]]** — the 19:29Z live verification,
  surface by surface, and the evidence that the deployed binary was **not**
  main. Start here before re-auditing anything.
- **[[gridiron-fantasy-audit-shipped-fixes]]** — what #21, #27 and #30 fixed,
  and the confirmation they are in `main` at 791b131.
- **[[gridiron-fantasy-audit-open-items]]** — the four items filed as "needing
  a decision". **None of them does.** Each has a default; the coordinator
  accepted all four. Includes the `syncEspnMarket` sole-writer warning, which
  was previously past the recall cut and invisible.
- **[[gridiron-startsit-availability-labels]]** — how chance-to-play is
  labelled across Start/Sit and the waiver board, the "% of weeks" confusion
  corrected twice, and the third unlabelled surface.

**The one live, unflagged defect** was uncaveated chance-to-play percentages.
Its fix is the availability fit — a separate body of work, indexed at
[[gridiron-availability-fit]].

**The loudest single finding, if you read only one:** `syncEspnMarket` is the
sole writer of `espn_player_market` and has no callers, so the draft board's
ESPN ADP and injury columns are permanently null while the consensus model
gives that source a live weight of 2. Inferred from code; one `COUNT(*)` would
settle it. In [[gridiron-fantasy-audit-open-items]].

Full write-up with per-item evidence:
`/mnt/project-files/fantasy-audit-2026-09-19.md`.

**Before quoting anything from these files:** line numbers are pinned to
`origin/main` at 791b131, not to a working tree. Several claims were retracted
during the evening and each retraction is kept in place rather than deleted, so
a reader who saw the earlier version learns it was withdrawn and why. The error
pattern behind them is [[verify-the-consumer-not-the-producer]].

See [[gridiron-player-universe-real]] and [[fly-deployment-outside-repo]].
