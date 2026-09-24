# TDD evidence: health-check-grace (PR #49)

Source: the 2026-09-19 deploy, where the machine's cold start was measured at
60 to 180 seconds against a `grace_period` of 60s. Nothing was deployed and no
live machine was touched. LLM spend: $0.

Runner:

    NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test test/fly-health-check-grace.test.js

## This was filed as "a config change no test can pin". That was wrong.

The change is one value in `fly.toml`, a file node never reads, and the first
reading was that nothing in the suite could say anything about it. That is true
of the part that matters least — **whether 300s is enough on the real machine
is settled by a deploy and by nothing else** — and false of everything around
it. `test/fly-env-season.test.js` already pins a different `fly.toml` value by
reading the file as text, and the same instrument works here.

So the test exists, and it pins the two things that can be got wrong silently:
the number against **this app's own measured boot**, and the key being in the
table Fly actually reads. A TOML key in the wrong table is accepted and does
nothing.

**4 guarded rules, 4 with a mutation shown failing.**

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| `grace_period = "60s"` | This app's cold start was measured at 60-180s on 2026-09-19, before anything else happens; a boot carrying pending migrations additionally runs them and a `VACUUM INTO` of a ~445 MB database, all ahead of `app.listen`. The check began before a normal boot had finished. | **Raise to 300s**, set against this app's measured boot rather than against the wedge the check was added for. |
| What an early check costs | Not a restart loop, which is the intuition the old comment was written from. On Fly the check and the restart policy are independent: a failing check evicts the machine from routing and never restarts it — only a process exit does. One machine, updated in place, means nothing else to route to. **An evicted machine is a 502 with an empty body while the app boots perfectly well.** | Recorded in the comment beside the value, because the two failure shapes are separable in the log and only one of them is a crash. |
| The old comment | It already argued that "a restart loop caused by an impatient check would be worse than the bug being fixed". The argument was right and the number did not honour it. | **Keep the argument, fix the number.** |
| Testability | `fly.toml` is not read by node, so nothing at runtime can observe it — but the file is text, and `fly-env-season.test.js` already reads it. | **Write the test.** "No test is possible" was a claim about the deploy, applied to the config. |
| `\Z` in the existing fly.toml test | `test/fly-env-season.test.js` scopes its table match with `(?=^\[|\Z)`. **JavaScript has no `\Z` anchor** — that is a literal `Z`. It works there only because another table follows `[env]`. The http-check table is the last in the file, so the same idiom matched nothing here. | **Do not copy it.** This file spells the end of input out, with the reason in a comment. Noted for #52. |

## RED -> GREEN, by mutation

Each row: an edit to `fly.toml`, the output it produced, then a restore.

| Mutation | Result |
|---|---|
| `grace_period` back to `"60s"` | 3 pass, 1 fail — "the health check grace period clears this app's measured cold start" |
| `interval` drifts to `"20s"` | 3 pass, 1 fail — "grace_period is inside the http check table, not a stray key", which is the test that proves the table is being read rather than the file |
| `grace_period` raised to `"900s"` | 3 pass, 1 fail — "the grace period is not so long that a real wedge goes unnoticed" |
| `[[services.http_checks]]` becomes `[[services.tcp_checks]]` | 0 pass, 4 fail — every rule, correctly: a TCP check is satisfied by the kernel accepting a connection whether or not the event loop is turning, so raising the grace period is only safe while the check still executes JavaScript |

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/fly-health-check-grace.test.js` | 4 | `grace_period` exceeds the measured cold start (180s, named as a constant so a re-measurement moves the assertion with it); it is inside `[[services.http_checks]]` alongside the `interval` and `timeout` it was reasoned about with; it is not long enough to hide a real wedge; and the check is still an HTTP check, not a TCP one. |

## What this does NOT settle

Whether 300s is enough on the real machine. The bound it rests on is one
measurement, 60-180s on 2026-09-19, and a boot that runs migrations against a
larger database can exceed it. **The deploy log is what would falsify this, not
the suite**: a grace-period eviction reaches `Gridiron HQ listening on
http://0.0.0.0:5177` and then simply stops, with no error after it, which is
how it is told apart from a crash loop repeating the same error on a restart
cadence.
