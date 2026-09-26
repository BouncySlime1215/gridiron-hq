---
name: wrong-head-correction-defect
description: A fitted correction added to a different number than it was fitted against produces a plausible wrong figure and never errors; both fantasy-coordinator.js and trade-engine.js did it.
metadata:
  type: project
  modified: 2026-09-20T02:56:00.000Z
---

**Verified 2026-09-20 by reading the fit and both call sites.** A class of defect
worth checking for wherever this app adds a learned correction to a base number.

`coordinateFantasy(fit, expertValues, structuralPpg)` returns
`structuralPpg + correction`, and that correction is fitted with
`target: actualPoints - projection.structural_ppg` (fantasy-coordinator.js:324;
the header's TARGET line says the same). **So the head is fixed by the fit, not a
preference.** Both callers passed `projection.ppg`, the ENSEMBLE number:

- `fantasy-coordinator.js:571` — **fixed** on branch
  `claude/project-thread-f921do-coordinator-head-hold`, head `42bbbc3` (held by the
  01:58Z GitHub freeze; RED `dce4665`, evidence
  `docs/tdd/fantasy-coordinator-head.tdd.md`).
- `trade-engine.js:354` — **still wrong**, feature-audit's file, routed to them.
  `weeklyPpg = weekProjection?.ppg ?? (proj / GAMES)`.

**Why it never showed:** the two heads differ by `projection.ensemble_shift`,
which **is itself one of the three experts the correction learned from**. So the
published number added that shift once outright and a learned multiple of it
again. Both figures are plausible fantasy points; nothing throws.

**Second half of the same fix:** `corrected_ppg` fell back to `projection.ppg`
when no fit is persisted — which is production's state — publishing an
uncorrected number under a corrected name beside `ensemble_ppg` holding the
identical value. Now `null`. A caller's own fallback is fine (trade-engine's
`currentWeekBasePpg` is documented as intended); a field NAMED `corrected_ppg` is
not the place for it.

**Consumer consequence, already handled:** `routes/drafts.js:1050` was the only
reader, as `corrected_ppg ?? structural_ppg`, so the null would have dropped the
draft sheet from the calibrated ensemble figure to the uncalibrated structural
one. Widened to `corrected_ppg ?? ensemble_ppg ?? structural_ppg`; printed number
unchanged in every state. **Untested — inline in a route's text template with no
harness, stated in the evidence file rather than implied.**

**Phase 3's gate numbers are unaffected:** `gradeFantasyCoordinator:521` grades
with `structuralPpg = 0`, i.e. the correction alone, so p ~0.0005 and MAE
4.28-4.40 vs 4.41-4.52 stand and need no re-run.

**Also found, not fixed:** `draft-assist.js:976` and `routes/players.js:94` both
wrap the call in `try { … } catch { return null; }`, the bare swallow CLAUDE.md
forbids — a real engine fault reads to the page as "no projection".

See [[gridiron-failure-modes]], [[mutation-sweep-finds-vacuous-tests]].
