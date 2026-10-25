# Tasks

## Active

- [ ] **WA — finish the Trade Brain build sequence** - correctness (done), valuation-map (done), tactics-and-packages (built + 2 follow-up fixes, verify in progress), value + P(accept), sendable proposals in Trade Lab remain; last checked via `git log` (`f92bb5f`)
- [ ] **Two open bugs from WA's own verifiers, unconfirmed fixed** - edge-test violation (valuation-map, trade-engine.js perceptionFactorFor) and wrong-refusal on horizon upgrades (trade-engine-correctness, offerFor ceiling gate) - see HANDOFF.md; check tactics-and-packages's verify result first, it may be relevant to #1
- [ ] **SESSION PAUSED 2026-09-18, safely, at Nick's request** - WA left running (Nick's own background workflow, not stopped); resume per plan A5 + this file

## Waiting On

- [ ] **Launch step 3 of 6 (WO + WB)** - since WA started; blocked on WA's own run record appearing (not just its latest commit), then a fresh `~/claude-handoff/usage.sh` check before launch. Scope: H1 (league history), O1 in 3 parts (O1a core scaffold, O1b 4 event triggers, O1c wiring into Coach/trade-engine), O2-O6, C0, B1-B6 incl. the widened Coach tool catalog
- [ ] **Fly.io account + payment** - for WF (hosting), Nick's decision, ~$5-7/mo
- [ ] **Invite list for WF** - who else gets an account on the hosted platform
- [ ] **Empty the Trash** - 47 GB, verified safe table-by-table, still Nick's click (B2 item 1)
- [ ] **ESPN cookie bookmarklet re-save** - closes the last open auth gap (B2 item 2)
- [ ] **Phone notification service** - Nick's choice, for game-day alerts (B2 item 4)

## Someday

- [ ] **Step 4 of 6 (WC + WD)** - every page audited/cleaned; remaining model refinements, weekly learning loop
- [ ] **Step 5 of 6 (WE)** - final integration, restart, push, morning report
- [ ] **Step 6 of 6 (WF)** - put the platform online: Google sign-in, per-user Claude keys (BYOK), Nick's chat-reading hidden from every other account, auto-deploy on push, security checklist, slimmed betting-archive tables shipped alongside the main DB - deliberately last

## Done

- [x] ~~W0 — early-season projections, ROS value, fake floors, waiver/IR fixes~~ (shipped, live)
- [x] ~~WA essentials — chance to play w/ ESPN designations, manager data all 5 leagues, LLM budgets, infra, 2 missing reviews~~
- [x] ~~Ingestion gap fix (nfl_model_growth/ffopportunity onto the live refresh loop)~~
- [x] ~~Sleeper crawler data-quality fix (leaguePlayed filter, 33% false positives purged)~~
- [x] ~~Bluff-detector ownership fix (declarations checked against real roster)~~
- [x] ~~FTN charting loaded 2022-2026 (~187k plays)~~
- [x] ~~Trade-engine-correctness (WA T0) - full suite 2,568/2,610~~
- [x] ~~E5 structural relook - 18 items checked, 2 factual corrections (7 not 12 seasons; no FAAB)~~
- [x] ~~E6 scenario-reaction audit - 8 real-world triggers traced, 8 gaps found and routed~~
- [x] ~~O1 generalized to 11 items, then split into O1a/O1b/O1c~~
- [x] ~~Plan-doc rules consolidated (A2/A3/A4/A5) - logging, structural audit, code reference, handoff mechanics~~
- [x] ~~mcpmarket-me plugin installed and enabled~~
