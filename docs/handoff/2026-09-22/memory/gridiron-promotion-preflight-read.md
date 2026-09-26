---
name: gridiron-promotion-preflight-read
description: The read-only query to run BEFORE any weekly-fit promotion script, and what each outcome means — zero promoted rows does not distinguish never-promoted from promoted-then-demoted, and the data_hash conflict trap makes a demoted hash unrecoverable by re-running.
metadata:
  type: project
---

Written by the auditor 2026-09-22. Precondition for
[[gridiron-no-promoted-fit-has-ever-run]].

**BEFORE ANYONE RUNS A PROMOTION SCRIPT — one more read.** Zero promoted rows does
not distinguish *never promoted* from *promoted then demoted*. `saveWeeklyFit`
inserts `ON CONFLICT(data_hash) DO NOTHING` (weekly-weight-store.js:150), so a
demoted hash can never be re-promoted by re-running: the insert no-ops, promoted
stays 0, verify fails for a reason unrelated to the model, exit 1 forever.
Settle it read-only:
`SELECT id, data_hash, through_season, through_week, promoted,
 substr(rejection_reason,1,200) FROM weekly_ensemble_fits ORDER BY id;`
No rows -> clean, script works first time. Rows with promoted=0 -> read
rejection_reason; it is both the blocker and the only evidence of why promotion
never landed.

**Gap this exposes in Scheduler's loud-fallback fix** (branch
`claude/project-thread-o3wt2p-epoch-fallback-loud`): it warns only when the lookup
finds nothing AND an orphaned promoted fit exists in another epoch. With zero
promoted fits anywhere the orphan probe finds nothing and no warning fires — so
the condition actually occurring in production stays exactly as silent after the
fix as before. The fix must also warn on zero promoted fits.

**Cookie caveat:** `IS NOT NULL` proves presence, not non-emptiness or validity.
`has_cookies:1` rules out "no cookie stored" as the transactions-collector
blocker; it does not prove the cookies still authenticate.

**How to apply:** treat any claim about which weights, k-vector or fit is "live"
as unverified until a `promoted=1`/`active=1` row is read from the live DB. This
is the predicted failure in [[fit-stores-default-to-not-live]], now observed.
Record: /mnt/project-files/audit-unit-1-gate3-live-read-resolved-2026-09-22.md.
See [[gridiron-auditor-thread-standing-2026-09-22]].

**The comment has flipped once already — `:12` says "This block used to
describe those constants as if they were what production runs" — so it is a claim
that has been edited in both directions. **A comment is a claim; the live read is
evidence.** `weekly-ensemble.js:5-12` should be corrected in the same PR that
lands a promotion; it misled the Planner on 2026-09-22.

**Why it matters:** `saveWeeklyFit` inserts `ON CONFLICT(data_hash) DO NOTHING`
(`weekly-weight-store.js:150`) and the hash is stored prefixed `e{epochId}:`, so a
re-run in the same epoch with identical inputs **inserts nothing and still prints
OK**. Read `report.saved.inserted`; exit 0 does not prove a write.
