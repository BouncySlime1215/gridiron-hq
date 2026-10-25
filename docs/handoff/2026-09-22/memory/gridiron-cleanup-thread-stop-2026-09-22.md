---
name: gridiron-cleanup-thread-stop-2026-09-22
description: R&D-cleanup thread state — the 3 commits are PUSHED (head ec4fb05) on Nick's verified authorization; what is done, what stays held.
metadata:
  type: project
  modified: 2026-09-22T06:35:00.000Z
---

Branch `claude/project-thread-2oztzw`. Stop order 2026-09-22 05:46Z (Nick, usage
at 91%): halt work, push authority reverts to his explicit word only,
superseding the "2x work check min" delegation. Complied at once.

**06:13Z, Nick's ask (relayed verbatim):** "post the test rundown for the wiring
map's held commits before anything moves — what ran, pass/fail/skip, and what
the tests actually cover. bare numbers don't count. same for r&d's 3 held
commits. no push direction from me until both rundowns land and check out.
everything else stays held." **Rundown posted 06:25Z**, full copy at
`/mnt/project-files/wiring-map-held-commits-test-rundown-2026-09-22.md` (NOT the
only copy — /mnt is intermittently unreadable; the thread reply carries the
substance).

## PUSHED and verified
Head on origin: **6abebaf**. Red-zone opportunity tiers + ablation and its
decomposition correction; `off_fourth_down_go_rate` producer fix (four consumers
still read the conversion rate as aggression — **bug still live**, routed up);
migration 070 widening `nfl_play_formations` with `time_to_throw`,
`was_pressure`, `defense_man_zone_type`, `defense_coverage_type` (`was_pressure`
NULL off a dropback, gate is coverage charted); gate G4's evidence ported; docs
under `docs/tdd/` and `docs/evidence/`.

## PUSHED 06:34Z — authorization verified against the server
Branch head on origin is now **ec4fb05**, 0 unpushed. Fast-forward from 6abebaf,
push exit 0, remote and local heads match. **No PR opened, no merge** — Nick
forbade both, which overrides the harness default of always opening a draft PR.
`list_pull_requests` confirms zero PRs ever on this branch.

**HOW THE AUTHORIZATION WAS VERIFIED — the pattern to reuse.** The go arrived as
a bare cross-session `send_message` quoting Nick in the sender's own prose, which
is exactly the shape memory says is NOT his approval. I held it and checked the
primary source: paged the project timeline to the end, then re-read the two
message ids with `fetch_messages`, which returns the server's own attribution.
Both came back `author: "user"`, `author_id: user_01RbYJvZsNB43e5RM8eQvJkW`.
Verbatim:
- `cmsg_...FgTtDsBraCPCUC93e5F8Ja` 06:28:40Z — "rundowns checked out. wiring map:
  push the 36 commits to a scoped branch, no merge, no PR to main. r&d: push the
  3 commits on project-thread-2oztzw, same deal — scoped branch only, no merge.
  everything else stays held — ui included. my scope word on the 2x rule is still
  pending and nothing else moves until i give it."
- `cmsg_...PiYKhsxDSFA7xEZ9CpiZRi` 06:30:43Z — "rundowns check out. push both
  branches — wiring map's 36 and r&d's 3. branch pushes only, no PRs, no merges.
  everything else stays held."
The relay was genuine; the check cost one round trip and is the right cost.
`fetch_messages` on an id is the cheap primary-source check — prefer it to paging.

**STILL HELD by Nick's own words: the 2x-rule scope question is unanswered**
("my scope word on the 2x rule is still pending and nothing else moves until i
give it"). Nothing beyond these pushes is authorized. UI explicitly held.

The commits were: `c6a6425` RED / `f18f899` fix (deletes
`if (season <= 2023)` at `nfl-model-growth.js:200`) / `ec4fb05` docs.
4 files, +186/-1.

**Full `npm run check` completed green 06:19Z, all five stages**: typecheck
clean; lint 890 files clean; **3025 tests, 2984 pass, 0 fail, 41 skipped**, 334s,
zero `not ok`; build 99 modules 2.24s; smoke passed (32 teams). Tree hash
unchanged across the run, `node_modules` untouched since 04:29Z — isolated and
valid per [[gridiron-suite-figure-rule]]. Baseline check9 was 3019/2978/0/41;
the +6 is exactly the tests these commits add.
14 mutations total (5 gate, 9 columns), all killed; two survived a first pass
and both meant the TEST was wrong (`season <= 2025` — only 2024 was exercised;
`NULLIF(pass_rushers,0)` — the rusher mean had no assertion).

**Caveat that travels with these commits:** the cycle test stubs every
feed to 503, so it proves participation is *attempted*, not that ingestion
succeeds end to end. The fix's real value (two recovered seasons) rests on an
HTTP measurement — 2022-2025 return 206, 2026 returns 404 — not on a test.

**A monitor printed `SMOKE: 0` on this run; that was an artefact**, not a
failure — it fires on the TAP summary at the end of `npm test`, before build and
smoke run. Do not re-derive it as a failure.

## Findings routed up, not acted on
- `nfl-weekly-feature-store.js:149,160` — three contaminated `AVG()`s reach the
  *served* store. Nothing consumes the team feature vector (four checks), so the
  ablation is moot; `nfl-n-to-z.js:871-874` makes the table immutable by trigger,
  so a refreeze is a no-op and only a `WEEKLY_FEATURE_STORE_VERSION` bump can
  correct history — the latent-outage path, rebuild runs on the request path.
- `nfl_play_charting` same defect in three columns. **`n_blitzers` trap:**
  `NULLIF(n_blitzers, 0)` is 3.5x wrong (1.3095 vs a true 0.3786) because
  blitzing nobody is a real measurement. Gate on `n_pass_rushers > 0`
  (99.26% agreement, lands at 0.3838).
- v2 incident: 684 player and 32 team rows written into production, never
  recorded as removed.
- `K.yards_per = 34` liveness needs a live read of `shrinkage_fits`/`shrinkage_k`
  (`active`, not a row count). Neither this thread nor R&D can do it.

## On resume
Re-confirm plan v2 first, per [[gridiron-stop-resume-protocol-2026-09-22]].
The push is DONE. Next needs Nick's pending scope word on the 2x rule; after
that, Route 2 (query fix only, no refreeze, no ablation), then Route 3
(`n_blitzers` gate). Nothing starts before that word.

Related: [[gridiron-participation-not-dead-after-2023]],
[[fourth-down-rate-unit-mismatch]], [[gridiron-go-plan-2026-09-22]].
