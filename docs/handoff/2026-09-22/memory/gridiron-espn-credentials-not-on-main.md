---
name: gridiron-espn-credentials-not-on-main
description: server/platform/espn-credentials.js exists ONLY on PR #48 (f377a09), not on main 791b131 — anything told to "go through the resolver" must either stack on #48 or build a seam.
metadata:
  type: project
  modified: 2026-09-20T06:20:00.000Z
---

**Checked 2026-09-20 on `791b131`: `server/platform/espn-credentials.js` is not
there.** It was added by `f377a09` ("Give ESPN credentials an owner") and lives
only on PR #48's branch. It is also not on the scheduler thread's stack.

This matters because it is being referred to across threads as if it were
shipped ("the job goes through platform/espn-credentials.js", "the resolver fix
lands with the caller"). **Its interface is not the problem; its absence from
main is.** A thread told to route through it either stacks on #48 — changing
its base and the morning merge order — or builds a seam.

**The interface, for whoever needs to plan against it** (read from `f377a09`):

- `credentialsForLeague(leagueRowId)` -> `{ s2, swid, source, userId }`, nulls
  when none. `source` is explicitly "for diagnostics and for the connect UI,
  never for a decision".
- A throwing variant for callers that want to fail loudly.
- `EspnCredentialsMissing`, status **409** not 401 — the caller is
  authenticated, the ESPN connection is what is missing.
- `braceSwid(v)` — ESPN wants the SWID in braces; the cookie sometimes has them.
- Resolution order: the league's own stored pair; else a member of that league,
  commissioner first; else nothing, and the caller says so out loud.
- What it deliberately removes: "whichever league was fetched most recently,
  install-wide", which is how one person's cookies made another's requests.

**The seam that works without it** (used by `league-transactions.js`, 2026-09-20):
make the lookup an injected parameter whose default implements **rule 1 only** —
the league's own stored pair — returning that exact `{ s2, swid, source }` shape
with nulls for "none", never throwing, never falling back. When #48 lands the
default is a one-line swap and rules 2 and 3 arrive with it. Do not edit
`espn-credentials.js` from another thread; it has one owner.

Related: [[gridiron-league-transactions-raw-unwritten-on-fly]]. PR #71
("League refresh asks whose cookies") is the other consumer and is stacked on
#48's own branch, which is the alternative pattern if stacking is acceptable.
