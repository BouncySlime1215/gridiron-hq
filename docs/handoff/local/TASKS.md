# TASKS (live checklist; update at every launch, merge, decision)
Updated 2026-09-23 7:50 PM ET by B coordinator (session c4cebb1f). Pace: 4.4%/h vs 0.76%/h target -> launches held.

## Running
- [ ] META-01 the Referee design + historical probe (Nick: insane unified learner): wf_8ae32cdf-0a8 -> META-01-DESIGN.md, rnd/meta/probe.md. Supersedes BLEND-02 + JEV-01b blend when it lands.
- [x] ARCHITECTURE v2 -> ENGINE-ARCHITECTURE.md (HEALTH-01a folded in). #216/#220/#226 stay HELD until EA-00/EA-01 apply the must-change lists (§11.2, §11.5).
- [x] TELLS-01a -> #226 (HELD with #216/#220; arm B killed)
- [x] ENGINE-00a -> PR #216, QUICKFIX-01 -> PR #217 (queued B2 after queue B)
- [x] PROJ-00 -> PR #218 (ESPN 2025 blocked by licence)
- [ ] PROJ-02-a sharp chain: wf_6d6b49bd-e47
- [ ] R&D round 19: wf_547a56a4-b7f
- [x] Merge doctor: all 7 fixed
- [ ] Merge queues: B (53395) -> B3 (49912: 214 216 217 186 174 207 190 166 218 215 164) -> B4: 221 219

## Next (in order)
- MERGE FIXES (need an agent when pace allows): #224 CI fail, #218 CI fail, #174 conflict, #219 conflict. Queue B9 (pid 11520) re-running 207 190 166 164 (stale vs main).
- META-01a (script-only lab, ~1 day, no deps) when pace allows; then META-01b after EA-00/EA-04.
- FIRST when pace allows (run together, disjoint files): BROKEN-01a+b (in-app Number health card; Nick asked 7:20 PM) and EA-00 (#216 rewrite per ENGINE-ARCHITECTURE §11.2, 9 items) then EA-01 (#220 per §11.5), then EA-02.. in the ENGINE-SPECS 'ARCHITECTURE UNITS' order.
- PROJ-01-a-2025 one-time confirm, relaunch (v3 rule 2 fixed): base on #222 branch, add a --confirm-2025 path that requires a HOLDOUT-LEDGER.md row in the same commit; keep refuseHoldout as default; frozen spots only.
- [x] RL-19-2 #225 (queued). [x] LIVING-01a #220 (held). [x] RL-19-1 #224 (queued; follow-up: cap label 0.08 under flag). PACING HOLD: no new launches until in-flight done. NEXT FREE SLOT: SELF-01a (after #174), CE-03.
- R&D round 20: Workflow({scriptPath:"/Users/nick_matta/gridiron-local/wf/rnd-loop-v3.js", args:{round:20, ideas:3}}) once IDEAS.json lands. Stuck "testing" ideas: re-run with ids. Copy rnd/loop/HOLDOUT-LEDGER-PENDING.md rows into the repo ledger via a PR each few rounds. Refresh backlog with Fable weekly.
- After #218 merges: load PROJ-00 history onto production Fly (Nick approved ~5:45 PM). Find the deploy path first (fly ssh / release job); log exactly what ran.
- [x] ESPN 2025 local pull (L162)
- [ ] IDEA backlog (~200, Fable max) wf_9901c7c0-4a8 -> then point rnd-loop-v2 lanes at rnd/backlog/IDEAS.json top-down
- [ ] LIVING-01a (first v3 unit) running: wf_e24db1a4-31c on #216 branch
1. (done, see Done) RULES v3 tooling.
2. #214 merged -> preview switch on + restart (after214.sh logic).
3. SELF-01a follow ledger (after #174).
4. LIVING-01a engagement + activity (after ENGINE-00a).
5. ENGINE-00b-a daemon (after ENGINE-00a); JEV-01a after.
6. [x] PROJ-03-a v2 declined (#219). [running wf_b6eba3c3-466] PROJ-01-a Mistake Map
7. RATCHET-01: BENCHMARKS.md rows -> CI job.
8. Then ENGINE-SPECS.md launch order (PROJ-01-a, CE-03, CLONE-01a, TELLS-01a ...).

- [x] Prompt audit: orchestration applied; app -> #223 (queued B5). After merge: Coach 6-round cache probe (~$0.05, in-app Anthropic cap) + Haiku length check

## Blocked / needs Nick
- NEWS EXTRACTOR BROKEN since 9/22 6:26 PM (401 Anthropic key, 29 runs). Approve Anthropic spend for it (+ restart refresh loop with real key)? 
- META-01: OK to serve ESPN's weekly point as the anchor (our range + chance-to-play + reasons on top)? Reader model: Sonnet on ~10% disagreement rows (+$1-2/wk) or Haiku only?
- Sleeper 2026 forward panel (~950 public leagues, in-season pull): unlocks 5 ideas; needs Nick's word.
- Stop orphan refresh loop pid 74430 (writes the clone's server/data.sqlite)? Optional.

## Done today (B)
- Merged #205 #206 #170 #165. PROJ-03-a declined (#215, docs/study). All plan gaps specced into ONE ENGINE-SPECS.md. 4-lens insane exploration -> SYNTHESIS.md -> LIVING-01/SELF-01 rows. RULES v3.
- RULES v3 tooling built (5:33 PM ET): wf/build-unit-v3.js (build -> 1 diff reviewer -> max 1 fix), bin/gate-merge-v3.sh (5 sections + CI green on exact head w/ main), bin/merge-queue-v3.sh (v3 gate if '## Measured', else legacy). Dry-tested on #215/#208; nothing merged.
