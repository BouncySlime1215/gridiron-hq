# Handoff doc — written 2026-09-18, Nick: "let it happen while u give a handoff doc too"

This is a curated snapshot on top of the automatic switch report (which already
captures PIDs, transcripts, and raw git state). Read this first for the "why";
use `docs/FANTASY-ENGINE-MASTER-PLAN.md` part A5 for the mechanical recovery steps.

## Where things stand

**Top-level: step 2 of 6 (WA running).** See `docs/FANTASY-ENGINE-MASTER-PLAN.md`
section 00 part B1 for the full 6-step sequence and A4 for what each code means.

**WA (`wf_90ebcd25-088`) right now:** Trade Brain sequence — correctness (done),
valuation-map (done, issues logged below), tactics-and-packages (just shipped
GREEN, 31/31, commit `ffe97c9`) — next up is its verify pass, then value +
P(accept) and sendable proposals in Trade Lab remain.

**Usage gate: TOO CLOSE.** Desktop account weekly usage is at 95% (climbing —
was 90% ~15 min ago). Per the standing rule, the next workflow launch (WO+WB,
once WA finishes) will almost certainly hand off to the Terminal account
(nsmatta@unc.edu) instead of launching here. This is expected, not a problem —
Nick's decision this turn was explicitly "let it happen" rather than force an
early handoff.

## Two real bugs found by WA's own verifiers, not yet fixed

Both violate this project's own hard rules and would show Nick a wrong number
if Trade Lab shipped as-is today. Full detail in `wf_90ebcd25-088`'s journal
(`grep issues_unfixed`), summarized here:

1. **valuation-map — edge-test violation.** One surfaced trade (Tyler Warren for
   Mahomes, league 3) scores positive only via the new perception multiplier,
   while it's actually -0.48 ppg for Nick on our own numbers — violates the
   plan's non-negotiable "must be positive on our numbers" rule. Root cause:
   `perceptionFactorFor` in `server/services/trade-engine.js:1354-1358`.
2. **trade-engine-correctness — wrong refusal on a real upgrade.** `offerFor`/
   `offerForMany` still gate on a weekly-only ceiling while the ladder below it
   was fixed to use horizon-weighting. Verified live: offering Ja'Marr Chase
   gets refused as "would not crack your starting lineup" despite being +0.17
   ppg horizon-weighted. Root cause: `server/services/trade-engine.js:1935-1959`
   and `2101-2118`.

Both were explicitly routed by their verifiers to "the tactics step" / "T1/T2"
— check whether `tactics-and-packages`'s GREEN commit (`ffe97c9`) or its
upcoming verify pass actually addressed them before assuming they're still
open. If still open once WA's Trade Brain sequence fully lands, they need a
dedicated fix (both are small, ~8 lines each per the verifiers' own notes) —
**do not let them ship to Nick unfixed and unmentioned.**

## If WA's run died mid-flight (desktop account hit its limit)

Per A5: finished agents' results survive in their own transcripts even though
the run itself died. Recovery is: read `wf_90ebcd25-088`'s journal for which
items got a `"type":"result"` entry (done) vs. which only got `"started"` with
no matching result (unfinished, re-run these). Do not re-run anything that
already has a result — reuse it.

## What to do next, in order

1. Confirm whether `tactics-and-packages` shipped, and whether its own verify
   pass or content addressed the two bugs above.
2. If WA's whole Trade Brain sequence + integration finishes: update B1's
   State column (WA → Done), run `~/claude-handoff/usage.sh` before touching
   WO+WB at all — expect TOO CLOSE given the trend, hand off if so.
3. Keep `TASKS.md` and this doc's "Where things stand" section current as
   state changes — both feed the switch report.
