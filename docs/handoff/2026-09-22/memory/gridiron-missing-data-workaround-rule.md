---
name: gridiron-missing-data-workaround-rule
description: Nick's 2026-09-22 standing rule for every thread when a feature or verification needs data the project doesn't have — free online source first, statistically-sound labeled estimate only if genuinely unavailable, and always log the gap for Nick.
metadata:
  type: feedback
  modified: 2026-09-22T03:55:03.765Z
---

Nick, 2026-09-22T03:53:38Z, cmsg_01YAsw8AnFv4ioRMQw8dfPmTEhe6e4aum5My5N1kUagRNd, verbatim:

"this is a new rule - if we lack data - lets go find it online for free
if we seriously cant find it then create workarounds that obide statsistcially - make a note for everythiong we are missing and ill see what i can do"

**Priority order for every thread, whenever a feature or verification needs data this project doesn't have:**

1. **FIRST — search for a free, legitimately usable online source.** Public datasets, nflverse, Kaggle competitions, official APIs, etc. Check reachability from the container the way threads already did tonight for Fly and nflverse (a 403 vs 206 test, etc.) — don't assume blocked, test it.
2. **ONLY IF genuinely unavailable free online — build a statistically sound workaround/estimate.** Must be labeled as an estimate wherever it's consumed (never presented with the authority of a real measurement), and validated the same way the project already validates real features (held-out error, lift-over-baseline, etc.). Same discipline as Model evidence audit's two-stage routes-run estimator (learn on 2016-2025 real history, serve a labeled ESTIMATE for 2026 from live snap data, gated on a held-out accuracy/lift check, auto-fallback if it fails) — approved 2026-09-22 ~03:44Z, precedent: [[gridiron-phase-a-0346-2026-09-22]].
3. **ALWAYS — log the gap** to the running missing-data list so Nick can decide whether to source it himself (his own ESPN/ESPN-adjacent access, ask Kaggle, buy data, etc.). This is a standing deliverable, not a one-off: [[gridiron-missing-data-log-2026-09-22]].

**Routing:** per the standing "threads report up, never sideways" rule ([[threads-report-to-coordinator]]), threads report a data gap UP to the coordinator; the coordinator — not each thread individually — appends it to the one running log file. Threads do not keep their own separate missing-data files.

**Context that prompted this (2026-09-22 night):** Model evidence audit found nflverse's free historical data could unblock predictive features it had thought were gated on a DB copy; separately, Nick surfaced two free Kaggle Big Data Bowl links (2026 competition data + hackathon winners) as further sources, both already routed to threads.

Related: [[gridiron-five-questions-rule]] (stats or made up — this rule is the "what to do about it" half), [[gridiron-audit-the-build-standing-rule]], [[gridiron-decision-routing]].
