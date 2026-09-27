---
name: gridiron-availability-fit
description: Index to the Gridiron HQ availability fit — what scripts/fit-availability.mjs writes, what it moves, the traps that make it read as "nothing changed", and how to undo it.
metadata:
  type: project
---

The live app prices every chance-to-play number on hand-set constants.
`availability_basis.stamp` reads `"absent|absent"` — the **missing-table**
state, not the empty state. `nfl_availability_rates` and
`nfl_availability_role_rates` do not exist on the live database.
`scripts/fit-availability.mjs` is what changes that. As of 2026-09-19 21:30Z
it has **not been run**; the train is merged to `main` at **791b131** and the
deploy is in progress.

This note was split 2026-09-19 because it had grown past the 4 KB that recall
shows. Read the piece you need:

- **[[gridiron-availability-fit-what-it-writes]]** — the two tables, the
  pre-registered gate (and that #37's gate **v2** is what ships), the
  `--dry-run --report` step, and the `DROP TABLE` undo. Start here.
- **[[gridiron-availability-fit-blast-radius]]** — which surfaces move, by how
  much, and which reading to trust. Trade values move single digits while the
  percentages move ~25 points; the odds are the sensitive instrument; the
  projection engine and waiver board do **not** move.
- **[[gridiron-availability-fit-cache-traps]]** — the simulate memo that fakes
  a null result, the endpoint named "availability" that cannot show the fit at
  all, and the two cache-free reads that need no restart.
- **[[gridiron-availability-fit-role-window]]** — with 2026
  `player_week_usage` empty, the role layer runs on **last season's** roles,
  and the gate cannot detect it. Read before judging any gate result.
- **[[gridiron-availability-fit-what-the-rate-means]]** — the fitted event is
  **recorded usage**, not playing; why the designation band collapses; and the
  K/DEF 0.92 claim that was retracted in full.
- **[[gridiron-designated-band-occupied]]** — whether any rostered player is
  actually in the band the fit moves furthest.

**The one-line version:** the fit replaces hand-set constants with rates
measured on 2021-2024 and validated on a held-out 2025; a healthy starter goes
from **0.805** to **~0.952**; playoff odds move most, trade values least; the
undo is `DROP TABLE` on both tables and needs no restart.

**Before quoting anything from these files:** line numbers are pinned to
`origin/main` at 791b131, not to any working tree. Several claims here were
retracted during the evening — each retraction is kept in place rather than
deleted, so a reader who saw the earlier version learns it was withdrawn and
why. See [[verify-the-consumer-not-the-producer]] for the error pattern that
produced them.

Operational runbook: `/mnt/project-files/availability-fit-runbook.md`.
