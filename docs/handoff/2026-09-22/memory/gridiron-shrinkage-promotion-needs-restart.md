---
name: gridiron-shrinkage-promotion-needs-restart
description: Promoting the volume shrinkage fit on Gridiron HQ changes nothing a running process serves — the player-week engine memo keys the fit as a constant string — and it moves only the weekly path, not the title odds or the draft board.
metadata:
  type: project
  modified: 2026-09-20T03:01:15.692Z
---

Verified 2026-09-20 on `origin/main` at **791b131**, consumer end, on a scratch
rebuild. Evidence section 6b of
`docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md`, held at **813d084** on
`claude/project-thread-w0gpjt-hold` (no PR, under the GitHub freeze).

## The read, and the size

One read: `projections.js:461` → `activeKVectorFor` → `cutoffSafeKVector`
(`shrinkage-fit.js:540`) → `activeFitMeta` (`:537-539`), which is
`SELECT id, through_season FROM shrinkage_fits WHERE active = 1 ORDER BY id DESC LIMIT 1`.
The promoted row is exactly what that read selects.

2025 week 10, the `active` flag the only difference — target share, then the ppg
Start/Sit ranks with:

| player | tgt share | ppg |
|---|---|---|
| Ja'Marr Chase | 0.202 → 0.327 | **16.25 → 22.01** |
| C. McCaffrey | 0.155 → 0.248 | **22.26 → 26.69** |
| J. Jefferson | 0.187 → 0.311 | **12.95 → 17.14** |
| Travis Kelce | 0.127 → 0.186 | **8.92 → 11.87** |
| Chase Claypool | 0.060 → 0.062 | **3.62 → 3.63** |

Claypool is the control: almost no sample, almost no move. That is what proves
this is shrinkage and not a scale factor.

## Two bounds nobody had stated

- **THE MEMO DOES NOT BUST ON THE FIT.** `player-week-engine.js:267` keys on
  `{season, week, scoring, kOverride: kOverride ?? 'active', version, weightFit:
  weightChampion.id, redistributeVolume}`. `weightFit` carries the **weekly
  ensemble** fit's id, so promoting *that* busts the cache by construction; the
  shrinkage fit enters as the constant string `'active'`, so flipping
  `shrinkage_fits.active` changes nothing a live process serves.
  `clearPlayerWeekEngineCache()` (`:68`) **has no caller** in `server/` or
  `scripts/`. So: **one database write flips it, and the app must restart before
  anyone sees it.** Free while the app restarts every ~176 s; invisible until a
  deploy once the scheduler stack lands. Order the morning so the promotion
  precedes that deploy, or route the fit id into the key (one line in
  `player-week-engine.js`, the scheduler thread's file, not mine). This is the
  ROOT of the memo note about `routes/model.js` and `draft-assist.js`.
  Reproduce with `useCache: false`; with the cache on, both arms are one object.
- **Season-long callers get null on purpose.** `activeKVectorFor` withholds the
  volume entries under any recency but `WEEKLY_ROLE_RECENCY`
  (`shrinkage-fit.js:499-513`), so `season-sim`, `draft-assist`,
  `preseason-model`, `week-postmortem` and `ceiling-lineup` keep the hand-set k.
  The promotion moves Start/Sit, News and the Trade Lab this-week number; the
  **title percentage and the draft board will not move.** Say that before he
  looks.

See [[gridiron-model-audit-2026-09-20]] · [[gridiron-failure-modes]].
