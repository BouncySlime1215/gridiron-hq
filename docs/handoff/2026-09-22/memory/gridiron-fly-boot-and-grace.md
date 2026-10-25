---
name: gridiron-fly-boot-and-grace
description: fly.toml's 60s health-check grace period is shorter than this app's measured cold start (PR #49 raises it to 300s), but it is NOT the likely cause of the 2026-09-19 failed deploy, and the deploy error itself identifies no cause.
metadata:
  type: project
  modified: 2026-09-19T22:12:00.000Z
---

**Open defect, mine, introduced in #17.** `fly.toml`'s `[[services.http_checks]]`
has `grace_period = "60s"`. The measured cold start for this app is **60 to
180 seconds** ([[gridiron-fly-cold-start]]), and a boot with pending
migrations additionally runs them plus a `VACUUM INTO` of a ~445 MB database
before `app.listen`. So the grace period is shorter than a normal boot and far
shorter than a migration boot. It wants **300s or more**. The comment above the
value already says a restart loop from an impatient check would be worse than
the bug being fixed, which is the argument against the number chosen.

**How a boot failure becomes a permanent 502.** `server/index.js` does
`await runMigrations()` at top level before `app.listen`. A rejection there
exits non-zero; `fly.toml` has no `[restart]` block, so Fly's default
`on-failure` restarts; the restart re-runs migrations and hits the same thing.
That is 502-with-no-instance indefinitely, and each cycle re-attempts the
445 MB snapshot. Distinguish it from a slow boot by the log markers:

1. `Refusing to migrate: a pre-migration snapshot of …` → disk gate threw,
   `fly volumes extend` ([[gridiron-pre-migration-snapshot]]).
2. `[db] backing up /data/data.sqlite to … before …` → gate passed, VACUUM
   started. Last line seen means the snapshot is still running or died.
3. Nothing, then a stack trace → one of the migrations threw.
4. `Gridiron HQ listening on http://0.0.0.0:5177` → boot completed; a 502 now
   is routing, not boot.

**Demoted 2026-09-19 22:08Z by the release thread, and the demotion is the
useful part.** A grace-period eviction is *survivable on its own*: once the
process listens, the next check at the 15-second interval passes and routing
resumes with nobody doing anything. On 2026-09-19 that did not happen, so the
app was most likely **not listening at all**, which puts the disk gate and a
throwing migration back in front of the grace period as causes. PR #49 (60s →
300s) still merges first in the next train regardless, because extending the
volume makes the snapshot actually run and therefore makes the retry's boot
*longer*, not shorter.

**The failed deploy's own error identifies no cause.** `flyctl` ends with
`timeout reached waiting for health checks to pass for machine
84ed41eae1dd68`, and every one of the four candidates below ends exactly that
way — the error is downstream of the whole list. The trailing
`net/http: request canceled` is flyctl's own in-flight poll being cancelled,
not a second failure. **The last marker in the machine log is the only thing
that separates them**, which is what the numbered list above is for.

**Two things a 502 is never.** The #29 watchdog cannot kill a long boot:
`armed_by: 'first completed HTTP response'`, armed only from
`res.once('finish')`, so it is inert until a request has been served. And a
failing health check never restarts a machine, only removes it from routing —
so the check cannot cause a loop, only hide a machine that is actually up
([[gridiron-wedge-mechanism]]).
