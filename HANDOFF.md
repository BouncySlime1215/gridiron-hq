# Handoff doc — written 2026-09-18, Nick: "let it happen while u give a handoff doc too"

This is a curated snapshot on top of the automatic switch report (which already
captures PIDs, transcripts, and raw git state). Read this first for the "why";
use `docs/FANTASY-ENGINE-MASTER-PLAN.md` part A5 for the mechanical recovery steps.

## Where things stand

**Top-level: step 2 of 6 (WA running).** See `docs/FANTASY-ENGINE-MASTER-PLAN.md`
section 00 part B1 for the full 6-step sequence and A4 for what each code means.

## The existing workflows (linked, so the next model doesn't have to search)

All run transcripts live under
`~/.claude/projects/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/subagents/workflows/<run-id>/journal.jsonl`.
25 run IDs exist total (most from 2026-09-17, earlier phases already absorbed
into the plan's E-sections) — only these three are from tonight and relevant
to resuming:

- **`wf_90ebcd25-088`** — `wa-essentials-audits-trade-brain`. **The active one.**
  Last journal write 17:23:57 (today). 34 journal lines so far. This is the
  one to watch and resume from.
- **`wf_07805a49-80b`** — `scenario-reaction-audit`. Finished, 8/8 agents done.
  Nothing to re-run. Findings already folded into plan section E6.
- **`wf_58081342-695`** — `early-season-and-skills-review`. Finished, 20 of 21
  done (1 "probably finished" — ended on a tool result, no need to re-run).
  Findings already folded into plan section E5.

To resume WA specifically if its run record shows it died: `Workflow({name:
'wa-essentials-audits-trade-brain', resumeFromRunId: 'wf_90ebcd25-088'})` —
per the tool's own contract this only works same-session; if this is a fresh
session after a handoff, `resumeFromRunId` won't apply and the move is a
**fresh** `Workflow()` call whose script only re-does the unfinished items
below (read each finished item's `"result"` from the journal and pass it in
rather than re-running it).

## Remaining tasks in the WA workflow, in order (Nick: "point the model that will start up to the remaining tasks in the workflow — starting with verify tactics and packaging")

1. **`verify:tactics-and-packages`** — IN PROGRESS right now (agent
   `ac60b583127cb402a`, started after commit `f92bb5f`, no result yet as of
   this write). **Check this first.** It's verifying `tactics-and-packages`,
   which built the nine trade tactics + "the edge test" enforcement the
   master plan specifies (line 245) and which the two open bugs below need.
   Read its `"type":"result"` entry in the journal once it lands; if verdict
   is `issues_unfixed`, read `problems` the same way the last two were read.
2. **Confirm whether the two open bugs got closed** (they may have — tactics'
   own scope includes the edge-test enforcement that bug #1 violates):
   - Edge-test violation in `perceptionFactorFor`, `trade-engine.js:1354-1358`
   - Wrong refusal on horizon upgrades in `offerFor`/`offerForMany`,
     `trade-engine.js:1935-1959` and `2101-2118`
   If still open after tactics' verify lands, they need a dedicated fix
   (~8 lines each, per the original verifiers) before Trade Brain is called
   done — do not let them ship to Nick silently.
3. **`build:value-and-acceptance`** (or equivalently named) — not started yet
   as of this write. Per B1/section C: value + P(accept) is the next Trade
   Brain stage after tactics.
4. **`build:sendable-proposals`** (Trade Lab) — last Trade Brain stage.
5. **WA integration/final verify pass** — after all Trade Brain stages land.
6. **Update B1's State column** (WA → Done) once WA's run record actually
   appears (not just its latest commit — see A2 rule/A5).
7. **Then, only then:** `~/claude-handoff/usage.sh` before touching WO+WB —
   expect TOO CLOSE given the trend (96% weekly as of this write), hand off
   via `handoff-now.sh` if so, per A5.

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

## Keep this current

`TASKS.md` and this doc's numbered task list both feed the switch report —
update the numbered list above as each item lands, don't let it go stale.
