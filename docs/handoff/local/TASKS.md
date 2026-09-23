# TASKS (live checklist; update at every launch, merge, decision)
Updated 2026-09-23 5:30 PM ET by B coordinator (session c4cebb1f).

## Running
- [ ] ARCHITECTURE (Nick: SUPER IMPORTANT): wf_3a5297a9-950 -> ENGINE-ARCHITECTURE.md. #216 and #220 HELD from merge until its must-change list is applied. When it lands: reconcile with HEALTH-01 (ENGINE-SPECS); if the architecture lacks row health, add HEALTH-01a to #216's must-change list.
- [ ] PROJ-01-a-2025 confirm + TELLS-01a: wf_0f12e09a-f68
- [x] ENGINE-00a -> PR #216, QUICKFIX-01 -> PR #217 (queued B2 after queue B)
- [x] PROJ-00 -> PR #218 (ESPN 2025 blocked by licence)
- [ ] PROJ-02-a sharp chain: wf_6d6b49bd-e47
- [ ] R&D round 19: wf_547a56a4-b7f
- [x] Merge doctor: all 7 fixed
- [ ] Merge queues: B (53395) -> B3 (49912: 214 216 217 186 174 207 190 166 218 215 164) -> B4: 221 219

## Next (in order)
- [running wf_2a68df4c-bbc] RL-19-2. [x] LIVING-01a #220 (held). [x] RL-19-1 #224 (queued; follow-up: cap label 0.08 under flag). PACING HOLD: no new launches until in-flight done. NEXT FREE SLOT: SELF-01a (after #174), CE-03.
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
- Stop orphan refresh loop pid 74430 (writes the clone's server/data.sqlite)? Optional.

## Done today (B)
- Merged #205 #206 #170 #165. PROJ-03-a declined (#215, docs/study). All plan gaps specced into ONE ENGINE-SPECS.md. 4-lens insane exploration -> SYNTHESIS.md -> LIVING-01/SELF-01 rows. RULES v3.
- RULES v3 tooling built (5:33 PM ET): wf/build-unit-v3.js (build -> 1 diff reviewer -> max 1 fix), bin/gate-merge-v3.sh (5 sections + CI green on exact head w/ main), bin/merge-queue-v3.sh (v3 gate if '## Measured', else legacy). Dry-tested on #215/#208; nothing merged.
