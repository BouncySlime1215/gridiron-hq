# Verification evidence — September 10, 2026

This is an evidence index, not a work queue. Use CLAUDE-NEXT-STEPS.md for all implementation instructions.

Reviewed committed source: 401a5d01ea488ec1da96d4c9ac6db995e2ed38b2. Latest dirty source captured at 15:49 UTC is separately identified in final-review-last-observation.json. The live project was not modified by this audit.

- Focused committed tests: 114 passed, zero failed.
- Full committed suite: 1,337 tests, 1,307 passed, 24 failed, six skipped; local Node 24.19.0. This is not certification of the hosted Node 22 CI job.
- Latest dirty packet tests: 14 passed. Independent cross-game and receipt-time repro still demonstrates the defect.
- Prior and new reproduction scripts run against isolated fixtures. Successful reproduction is evidence of an open defect.
- DB observations are read-only, timestamped snapshots. At 15:49 UTC migrations were through 028, with zero decision runs and execution opportunities. The earlier 025 observation is retained to explain concurrent progress.
- Folder inventory: 792 tracked paths plus captured untracked migration 029 = 793 dispositions. Ownership proposals require caller/path verification before execution. Shared content destinations are explicitly flagged.

## Reproduction

Check out the recorded commit into an independent review directory. Preserve and overlay only the separately captured dirty source when evaluating that variant. Use the project's declared dependencies without modifying the active checkout. The .mjs repro scripts contain an explicit review-root path; change that path to the isolated checkout. They use temporary fixture databases and disable scheduling. Read each script before execution. The full suite must be run with a temporary fallback DB and an external-network guard; never import app DB services against the user's database for an audit. The text logs record what was executed here.

No live databases, private raw provider payloads, credentials or complete dependency trees are included. Source paths/hashes and minimal dirty source needed to understand the in-flight changes are included. The newest index migration received source review rather than a real deployment test.
