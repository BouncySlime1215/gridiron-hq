# Documentation index

**This is a link map, not a plan.** The plan's own words: "A short
documentation index may link to this plan, evidence, generated status, and
references; it must not become a second plan." Nothing here sets priorities,
authorizes spending, or promotes a model.

## The one active work-order plan

- **[CLAUDE-NEXT-STEPS.md](../../plans/archive/CLAUDE-WORK-QUEUE-at-ffe4e72.md)** — the only maintained work
  queue. Everything else on this page is evidence or reference.
  - [Audit evidence](../../audits/repository-evidence/2026-09-09/AUDIT-EVIDENCE.md) — the findings and
    numbers behind it
  - [Folder and document disposition](reference/architecture/FOLDER-REORGANIZATION.md)
  - [File migration inventory](reference/architecture/folder-map.csv)

## Evidence (measured results — never instructions)

- [evidence/2026-09-09/](../../audits/repository-evidence/2026-09-09) — the September 9 audit, its
  verification bundle, and the run-27/31 comparison
- [evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md](../../audits/repository-evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md)
  — what was implemented against the plan, what was deferred, and why
- [evidence/historical/](../../audits/repository-evidence/historical) — dated results, failed
  experiments and superseded status narratives, preserved as record, including
  [platform-audit-2026-08-24-findings.md](../../audits/repository-evidence/historical/platform-audit-2026-08-24-findings.md)
  (the August audit's observations, with its proposal backlog removed)
- [evidence/2026-09-10/](../../audits/repository-evidence/2026-09-10) — the September 10 review, its
  verification bundle, and
  [CODEX-6-HANDOFF.md](../../audits/repository-evidence/2026-09-10/CODEX-6-HANDOFF.md): what was
  implemented against it, how, and what each correction still cannot claim
- [evidence/history/WORK_LOG.md](../../audits/repository-evidence/history/WORK_LOG.md) — the running
  change log
- [evidence/history/platform-audit-implementation-2026-09-08.md](../../audits/repository-evidence/history/platform-audit-implementation-2026-09-08.md)
  — what was actually implemented and verified against the August audit
- [evidence/contracts/](../../audits/repository-evidence/contracts) — frozen experiment and policy
  contracts, including
  [profitability-policy-v1.3.md](../../audits/repository-evidence/contracts/profitability-policy-v1.3.md)
  (the 200/75 forward-sample gates `nfl-policy.js` cites by name)
- [evidence/baselines/](../../audits/repository-evidence/baselines) — byte-preserved baseline
  manifests
- [evidence/NFL_AUDIT_RUN_8_MANIFEST.json](../../audits/repository-evidence/2026-09-01/NFL_AUDIT_RUN_8_MANIFEST.json)

## Reference (how things actually work)

- [reference/model-governance-manual.md](reference/model-governance-manual.md)
  — system contract, learning loop, news-verification rules, and (section 18)
  the model operations protocol, endpoints and release commands merged from the
  former root `MODEL_OPERATIONS.md`
- [reference/architecture/](reference/architecture/) — ownership map, folder
  companion, domain boundaries
- [reference/betting/execution-slate.md](reference/betting/execution-slate.md)
- [reference/fantasy/](reference/fantasy/) — draft capture, trade/draft verify
  loops, offseason and preseason models, device runbook
- [reference/football/](reference/football/) — shared weekly data and rebuild
  notes
- [reference/research/](../../research/repository-catalogs) — external source surveys with
  their URLs, retrieval dates and license caveats

## A note on the older documents

Files under `evidence/` and `reference/` carry a header stating their status.
Several were written as active plans and still contain "next steps", phase
lists or ranked recommendations. Those are a record of what was planned **at
the time** — not instructions to execute now. Their measured results, source
URLs and frozen contracts remain valid evidence and are preserved verbatim.
