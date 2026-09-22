---
name: gridiron-thread-detail-b-2026-09-22
description: Release/UI/Fantasy-plan/Opportunity detail as of 02:00Z, split from the state record for its byte cap.
metadata:
  type: project
  modified: 2026-09-22T03:34:52.260Z
---

Linked from [[gridiron-state-record-2026-09-22]].

**Release:** item6 CLOSED, head f5b6552. Triage doc: #15 figure filled(2,986/2,945/0/41 merged-tree), #72 still open(no commit named), #64 CI cause corrected(coordinator's 2026-09-20 freeze action, not a minutes cap), needs-Nick's-word section written(close #56/#59/#61/#65/#69, kill #6+f921do, re-enable CI 357164314), f921do obituary citation folded in. Confirmed 02:31Z unchanged(cse_016rykKAHmB43LAZp6eqwedG): idle, standing by. Branch claude/release-train-2yv3x6-hold head 7a1fd115ca43ec62058035269e6cb05c44b34fea unchanged; tree 7d6c7377b135a649d4aa2367b65fa52fa8789d7d, clean, no delta. Wiring n/a(docs-only).

**UI (session cse_012mJNcQKskfZmyq4qTmFqDe, head 85c72b2, unpushed):** freshness endpoint DONE(fe6ba16,3,007/2,966/0/41). Absorbed all coordinator notes; index.js lines backed out to ecf4604(scheduler owns them in integration). servedTablesRegistry()(the servedTables() consumer) already generic-prefers source-registry's servedTables() when non-empty, falls back to a single player_week_usage entry until then; no further UI code change needed when the 17-entry version lands. Built a 2nd grain(fit stores): entries carry grain(feed|fit)+reader field; a fit store's verdict is coverage-based(current-season fit=fresh, fits only from a prior season=stale-the "stale-fit trap"-pinned by a test). StaleBanner.tsx CONFIRMED dead code(MLB-slate banner, unrelated domain, wired to nothing). Found+fixed a mutation-sweep survivor R3(current-week plumbing was unpinned; added a test seeding a current-season row at a distinguishing week; R3 now dies). Full check on tree 56f06dfb1137(source-isolated): 3,012/2,971/0/41, exit0. Evidence: docs/tdd/data-freshness.tdd.md. Item3(freshness registry) reads as DONE on UI's side. Open: Coach hook(told to hold, out of Phase0 scope); servedTables() wiring at integration(consumer already ready, no action needed from UI). UI told to idle until Phase0 fully closes.

**Fantasy plan — Phase A item1 STARTED (03:31Z):** league config auto-ingest — model auto-verifies league scoring/lineup/waiver/FAAB/playoffs/keeper-dynasty settings, proves projections use them. Item text/citation: [[gridiron-phase-a-start-2026-09-22]].

**Fantasy plan (Phase0):** unit DONE-effk merged onto 654ff93 clean(97063a5,3,014/2,973/0/41), f921do obituary(kill/no-salvage, 4 of 112 branch-only lines regress incl. fly.toml undoing #49). Needs Nick's word: push 4 local-only commits(4061604/2709263/0d97e7c/c3dc554) or they stay local. Confirmed 02:31Z unchanged(cse_01U2PQK2qw4VrXdytNqpq5an): branch effk-on-654 head c3dc554, clean. Correction: 0d97e7c is on branch memokey, NOT this branch; only c3dc554 is here, docs-only. Check on 97063a5: exit0, 3,014/2,973/0/41; tree 28f515e4b024ab010041c4e787166d9dcaef6a59 unchanged. Source-isolated, not cross-checked. Still holding 4061604/2709263 pending Nick.

**Opportunity:** RECLASSIFIED HIGH-MEDIUM(Opus5/high) by Nick 01:44Z. Unit DONE-3 local suite runs on #85/#72/#15 merged trees, all green, source-isolated with hard-linked node_modules. Closed #15's missing-figure and confirmed #72's missing-commit-name triage notes.
