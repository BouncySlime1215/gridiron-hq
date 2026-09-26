---
name: gridiron-wiring-gate-landed-red
description: "The check:wiring CI step landed red with #108 (eb19f475) on 2026-09-22, so every PR's CI has been red since; and the stale accept-list block never causes the exit"
metadata:
  type: project
  modified: 2026-09-22T17:21:44.083Z
---

**PR #108 (`eb19f475`, merged 2026-09-22) added the `Wiring check` CI step
(`.github/workflows/ci.yml:69`, `npm run check:wiring` = `package.json:36`) to a
main that already failed it.** Main's own push runs are failures from that
commit onward — `eb19f475` job 106849112961, `f620a120` job 106850797914 — and
every PR rebased onto main since inherits the red. While that holds, the
coordinator's "merge only on CI green" rule is unsatisfiable by anyone.

Verified by running `npm run check:wiring` on a clean worktree of `origin/main`
at `f620a120` (`git status --porcelain` empty): exit 1, three blocking findings
— `table-never-written pbp_participation`, `table-never-written play_by_play`,
`producer-with-no-caller refreshLeagueRosters()`. Fix owned by the Wiring map
thread (head `c3527d4a`, not pushed as of 17:22Z).

**The stale accept-list block is NOT a cause of the exit.** In
`scripts/wiring-map.mjs`, the "accept-list entr(ies) have outlived their reason"
block only `console.log`s; the file's sole `process.exit(1)` is at `:4095`,
driven by `blocking`. I read the CI log positionally — the
`server/services/cascade-grade.js` stale line prints immediately above
`##[error]` — and named it as the cause in a PR comment. Wrong, and the
damaging kind of wrong: the comment at `:4060-4066` says that entry is a
deliberate pre-registration for a module arriving with #72, and that failing a
build on a merge-order accident "would teach people to delete the entry rather
than land the file". My text recommended exactly that deletion. Corrected on
#94 comment 5780772048 at 17:20Z.

**Why: a tool's output order is not its control flow.** Read the exit path
before naming a cause. See [[gridiron-bespoke-tool-cross-check-rule]] and
[[gridiron-report-keyed-to-a-throw]].

**How to apply:** `npm run check` does not include `check:wiring` — the local
gate must be `npm run check && npm run check:wiring`, and any evidence file
saying "local check exit 0" written before 2026-09-22 17:00Z covers five of
CI's six steps, not six.
