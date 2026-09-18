# TASKS — live Active / Waiting-On list

The fast-read summary A5 asks for. `docs/FANTASY-ENGINE-MASTER-PLAN.md` stays the
full authoritative record; this file is what a handoff report quotes.

Last updated: 2026-09-18, cloud session on `cursor/betting-model-audit-fixes-1c85`.

## Active

- **WA / Trade Brain — the two open bugs: both now closed.**
  - *Bug 1, edge-test violation (`perceptionFactorFor`).* **Closed by the tactics
    step, not by a new fix.** `tactics-and-packages` (`ffe97c9`) added
    `edgeTest()` in `server/services/trade-tactics.js` and `findTrades` applies it
    as a hard filter (`trade-engine.js`, `const eligible = shaped.filter(d => d.edge.passes)`).
    Its fourth check, `not_only_perception`, re-scores every deal with the
    counterparty read removed and drops anything that is only positive with it —
    exactly the Tyler Warren / Mahomes case the verifier raised. Verified by
    reading the shipped code, not by trusting the commit message.
  - *Bug 2, wrong refusal on horizon upgrades (`offerFor` / `offerForMany`).*
    **Fixed this session.** The rung loop had already been moved to
    `ladderGain` (horizon-weighted); the free-add ceiling gate above it was still
    a `bestLineup` diff on this week alone, so a player who helps across the rest
    of the season but not this Sunday was refused outright and his ladder never
    ran. Both gates now read a shared `freeAddCeiling()` that goes through
    `evaluate()` + `ladderGain` — the same call the rungs make, so they cannot
    drift apart again. Three regression tests in
    `test/trade-engine-correctness.test.js` (G9a/G9b/G9c).

## Waiting On

- **Nick — the live five-league check.** The cloud box has the code but not the
  data: `server/data.sqlite`, `data/derived/league_chat.sqlite` (the iMessage
  corpus the whole counterparty layer reads — not re-fetchable), the line-history
  and nflverse archives, and `.env` are all gitignored. The Trade Brain can be
  built and tested here; verifying it against the real leagues needs his machine
  or those files moved up.
- **Nick — WA's remaining stages.** WA was stopped entirely, so the next three
  Trade Brain stages are no longer running anywhere:
  1. `build:value-and-acceptance` — value + P(accept) band.
  2. `build:sendable-proposals` — Trade Lab.
  3. WA integration / final verify pass.
- **Usage gate.** Desktop weekly was 96% (TOO CLOSE) at the pause. Per A5, the
  next workflow launch runs `~/claude-handoff/usage.sh` first and hands off to
  Terminal on TOO CLOSE.

## Someday

- Everything in the master plan's part F (the full deferred queue), unchanged.
- The plan docs live only on this branch — it is 305 commits ahead of `main`.
  Merging is Nick's deliberate call, not a side effect of any task here.

## Done

- W0 — early-season projections, ROS value, fake floors, waiver drops, IR starts,
  10-lens skills review. Shipped and live.
- WA essentials — play-chance with ESPN designations, manager data for all 5
  leagues, LLM costs and budgets, the two missing reviews, infra.
- WA Trade Brain — correctness, valuation map, tactics-and-packages (incl. the
  edge test), and its verifier fix (`5deb33a`).
- Both open verifier bugs (see Active above for which was closed how).
