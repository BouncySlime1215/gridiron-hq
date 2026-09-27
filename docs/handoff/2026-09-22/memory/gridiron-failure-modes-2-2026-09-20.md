---
name: gridiron-failure-modes-2-2026-09-20
description: Page 2 of the gridiron-hq "healthy-looking and not working" catalogue and rules; entries from 03:15Z 2026-09-20 on that did not fit on the first page.
metadata:
  type: project
---

Continues [[gridiron-failure-modes]].

**Catalogue (cont.):** a branch no fixture can reach (every test league's my_team_id = '1', so selfRead's me == null path had no test in any file; third fixture blind spot of the night, Trade Brain 2026-09-20); four go-list heads that existed only in one container until 03:17Z (feature-audit, 2026-09-20).

**Rules (cont.):** a test pinning one floating-point summation order pins an accident (compare within 1e-12, say why); equal-width calibration bins average extreme miscalibration away against thousands of middle rows, use equal-count bins (fantasy plan, 2026-09-20); test the unification (deepEqual across surfaces), not three plausible values (Trade Brain, 2026-09-20); 'committed' is not 'safe': a container is the only copy until a push, so every GREEN goes to a no-PR hold branch at once (feature-audit, 2026-09-20: four go-list heads existed only in one container).

**Catalogue (cont., 06:10Z-06:20Z 2026-09-20):** (1) an injection harness that restores with `git checkout -- .` run against an uncommitted fix deletes the fix along with the injection (feature audit, 06:15Z); (2) an import-graph orphan scan flags entry points reached by `fork(new URL(...))` or by a package.json script as "imported by nothing" (scheduler, 06:18Z: server/scripts/run-nfl-ai-replay.js is forked at nfl-ai-replay.js:376; sync-history.js is package.json:27); (3) a served or priced value stamped with the time it was COPIED (manager_signals.computed_at, sync_log.last_run_at) instead of the time it was MEASURED (Trade Brain, 06:13Z); (4) a static wiring map and a live sqlite_master walk disagree by construction: 308 vs 343 tables, 59 migration-only tables invisible to a schema catalog, 37 test/script-only tables never in the live DB (wiring map, 06:10Z).

**Rules (cont.):** commit GREEN before injecting, and the harness refuses a dirty tree; fork-by-URL, Worker-by-URL and npm scripts are roots of the import graph, not orphans; a stamp is the stamp of the process that measured the value, never of one that copied, scheduled or reported it; run both the static map and the live walk, and tolerate the 37 test/script-only tables by name.

**(5)** a fetch that silently degrades to a public payload when credentials are absent, then written as if authenticated (espn-market.js:31 with #50's 12 h job as its first deployed caller; scheduler, 06:23Z). Rule: no credentials means refuse (throw EspnCredentialsMissing), never fetch anonymously and store.

**(6)** a column rule that says "written nowhere" when the writer exists behind an unreachable route (auth_sessions.revoked_at, users.disabled_at: written at google-auth.js:259/:265/:331/:334, all inside the eight uncalled auth routes; Google sign-in, 06:23Z). Rule: report the writers found and their reachability; an unreachable writer is route-no-caller, not a missing writer.

**(7)** a guard shadowed by a stronger guard on every tested path survives its mutant (`u.disabled_at IS NULL` survived 20/20 because disabling also revokes sessions at google-auth.js:334); it is not redundant when a writer bypasses the stronger guard (provision-auth.js inserts auth_sessions directly and never reads disabled_at; Google sign-in, 06:33Z). Rule: build the bypassing state directly in the test (unrevoked session + disabled user).

**(8)** an accepted-orphan annotation used to silence a checker bug: three of the four modules retracted at 06:31Z were "accepted" in annotations.json (wiring map). Rule: an accepted line means unwired-and-meant, never checker-is-wrong.

Continues (entries from 06:43Z on): [[gridiron-failure-modes-3-2026-09-20]].
