# Cloud builds, local verification

Nick (2026-09-22 ~6:40 PM ET): "we need to validate cloud work and make sure synergies and those verify checks happen. Cloud sessions should be quick, not massive context readers, and get the same level of verify as we have here."

## 1. Cloud: lean builder (Sonnet, Agent isolation "remote")

The coordinator hands each session a complete spec: the unit id, the exact files (file:line), the acceptance test, the RED expectation, and the constraints. The session:
- reads ONLY the listed files, their tests, and what they import directly (no repo-wide exploring, no handoff reading);
- builds test-first: a RED commit (failing assertion quoted), a GREEN commit, and an evidence file under docs/tdd/;
- runs `npm ci` + `npm run check` once (Node 22, same as CI) and records the exit code, test counts and write-tree before/after;
- opens a DRAFT PR whose body has Before/After and merge-gate sections 1-5;
- replies with the PR URL, head sha and check result, nothing more.

Only units classed CLOUD / CLOUD-DATA in WORK-QUEUE §10 go to the cloud. Anything needing Nick's data (local DB copy, Sleeper corpus, league payloads, real-row timing) stays local.

## 2. Local: same rigor as local builds

`~/gridiron-local/wf/verify-pr.js` runs on each cloud PR:
- four independent skeptics on the PR head: claims/statistics, wiring/consumer, test liveness, and structure (one number, one producer; no unwired data), tiered by risk;
- a fix loop: a local fixer commits to the PR branch (TDD); failed lenses re-check, up to 2 rounds;
- if clean: the skeptics' verified claims go into the PR body and it's marked ready; otherwise it's held with the open issues.

No local `npm run check`: CI on Node 22 is the full check, which spares this 8 GB Mac.

## 3. After verification (same as every build)

- `merge-queue.sh`: bring up to main, wait for CI on that exact head, gate script, merge, WORKLOG, integration card, integration log.
- Integration intake (INTEGRATION-PROCEDURE.md step 2) on the card.
- Synergy review about every 5 merges.
- Board updated (the keeper, every 10 min).
