---
name: gridiron-holds-vs-the-six-fixes
description: The fourteen feature-audit holds checked against a locally projected main (791b131 + #63 + #52 + #49) — two prose staleness findings, everything else clean.
metadata:
  type: project
---

Measured 2026-09-20 16:05-16:13Z, before main moved, by projecting the merge
rather than waiting for it. Technique worth reusing: the PR heads are already
knowable, so fetch them read-only and build the merge locally.

```
git fetch origin refs/pull/<n>/head:refs/prhead/<n>     # emails nobody
git merge-base --is-ancestor refs/prhead/56 refs/prhead/63   # → true
```

**#56, #59 and #61 are all ancestors of #63**, so the four-PR fix stack is one
merge. Projected main `abc6151` = `791b131` + #63 + #52 + #49, all clean.

**Result: zero file-level overlap** between the six fix PRs and the fourteen
feature-audit holds. The six touch only `server/index.js`,
`server/platform/loop-watchdog.js`, `server/services/scheduler.js`, `fly.toml`
and eleven test/docs files. All fourteen holds merge clean onto `abc6151` and
run green there (283 passes, 0 fail, 0 `not ok`, each hold's own changed test
files).

**Two prose staleness findings, both queued behind the GitHub freeze because
both branches carry PRs:**

1. **`consensus-season` / PR #55.** Its evidence file says "**`NFL_SEASON` is
   not set in production** — `fly.toml`'s `[env]` block holds only `HOST`",
   that the live app therefore takes the calendar-year branch, and that
   setting it "is a deploy-time step, not a code change". **#52 adds
   `NFL_SEASON = "2026"` to that exact block**, so every sentence of that
   paragraph dies on merge. Replace it with a pointer to #52, whose own
   comment states the 2027-01-01 split better and names the September bump as
   the cost of pinning.
2. **`waiver-kdef` / PR #62.** Cites `server/index.js:129` for the
   `/api/decision-inbox` mount. #63 inserts 8 lines at `:72`, moving it to
   `:137`. Do not write 137 — cite by content, because `caac88a` on the
   wiring-map branch removes the mount entirely. See
   [[verify-a-pr-by-content-not-line-number]].

**Checked and NOT overtaken:** four holds (`week-callers`, `trade-week-hold`,
`season-weeks-hold`, `roster-read-hold`) say reconciling a league's own
`season` column against `SEASON` is "the NFL_SEASON tidy-up, not this change".
#52 pins the env var, making the env-derived sites agree with each other; it
does not touch the per-league column. Different reconciliation, comments hold.

**The brake survives #63:** `SCHEDULER_DISABLED === '1'` early return moves
`scheduler.js:1732` → `:1927`, same semantics, and `loop-watchdog.js:82` in
#63 is written for the synchronous callback that return produces. Every hold's
test preamble depends on this.

**Harness near-miss, not a flake:** the first sweep reported `roster-read-hold`
1 fail. Cause was `TypeError: mock.module is not a function` — bare
`node --test` where `package.json`'s `test` script passes
`--experimental-test-module-mocks`. My harness, not the hold. With the repo's
real flags it is 40/0. See [[gridiron-never-call-it-a-flake]].

**Limits, stated because they matter.** The sweep ran each hold's OWN changed
test files, not the full suite, so a hold breaking a test it does not touch
would not show. `npm run check` per hold against the REAL main is still
required before any PR opens. And `abc6151` is one merge order; a squash or a
different order could differ.
