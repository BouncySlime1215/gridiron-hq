---
name: gridiron-free-data-first-rule
description: Nick's 2026-09-22 standing rule — hunt for a free online source before falling back to an estimate, and register every data gap explicitly for him to chase.
metadata:
  type: feedback
  modified: 2026-09-22T04:19:05.630Z
---

Nick, 2026-09-22 03:53:38Z (cmsg_01YAsw8AnFv4ioRMQw8dfPmTEhe6e4aum5My5N1kUagRNd):
"if we lack data - lets go find it online for free / if we seriously cant find
it then create workarounds that obide statsistcially - make a note for
everythiong we are missing and ill see what i can do"

Three obligations, in order:
1. Search for a free online source before designing around the gap.
2. Only if the search genuinely fails, build a statistically defensible
   workaround — and label it as one wherever it surfaces to a user.
3. Register the gap explicitly as "missing: X" and route it up, because Nick
   may be able to obtain it himself (a paid feed, an account, an export).

**Why:** he would rather buy or fetch the real thing than ship an estimate
nobody flagged. A silent workaround costs him the chance to fix the root cause.

**How to apply:** the register lives at `docs/data/missing-data-register.md`
in the repo; add a row rather than burying the gap in a thread. State the
search you actually ran, not that you "looked". Anything paywalled or behind
an account is a candidate for Nick's hands, so name the source and its price
if known.

**Correction (2026-09-22):** `docs/data/missing-data-register.md` was checked
against `main` at `654ff93` and does not exist there. Do not treat it as a
live repo artifact until some thread actually creates it — until then, log
gaps per [[gridiron-missing-data-workaround-rule]] /
[[gridiron-missing-data-log-2026-09-22]].

Worked example, routes run: searched nflverse (every release probed, headers
read), Kaggle Big Data Bowl (reachable but API 401, needs his account), and the
open web. Confirmed no free per-player routes-run feed exists — HeatRadar states
"No public play-by-play feed records whether a player ran a route" and charts it
proprietarily with no export; PFF is paywalled. The free analytics world uses
the same participation-derived proxy this project built. See
[[gridiron-five-questions-rule]] and [[gridiron-suite-figure-rule]].
