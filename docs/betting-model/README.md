# Gridiron HQ betting-model library

## Start with the latest plan

**[OPEN THE LATEST PLAN → plans/LATEST-PLAN.md](plans/LATEST-PLAN.md)**

Consolidated September 15, 2026. This folder gathers our planning work, Claude's recovered research and audits, source papers, implementation prompts, test evidence, and repository reference material. The latest plan contains the full detailed specification plus the current review-driven execution order.

| Folder | Contents |
|---|---|
| [research/](research/README.md) | Advanced statistics, AI/ML, GitHub catalogs, source papers, sweeps, experiment results |
| [plans/](plans/README.md) | Latest plan, Claude instructions, agent playbook, 20 prompts, historical plans |
| [audits/](audits/README.md) | Latest independent review, line-by-line audits, audit-system research, reproducible checks |
| [archive/](archive/README.md) | Original recovery indexes, previous handoff versions, planning drafts and utility scripts |

Read the latest plan first, then the September 15 review, then the relevant work-package prompt and research. Do not reread the entire collection for every task.

The branch includes Claude's source-code history through `ffe4e72`. Organization did not implement fixes or certify later commits. Earlier plans, prompts, results and audits can contain superseded instructions, paths, or counts. The latest plan controls sequencing on this branch; historical documents preserve what was known then.

## Preservation and navigation

Exact duplicate source contents are stored once. Both older ZIP handoffs were inspected and their distinct contents preserved; redundant ZIP containers and OS/cache junk are omitted. Every input, including duplicate/archive-member aliases, is mapped in [MANIFEST.json](MANIFEST.json) and [FILE-INVENTORY.csv](FILE-INVENTORY.csv). Original source hashes and committed hashes distinguish link-rewritten documents from their inputs.

Markdown links that could be mapped to recovered files or repository code were made relative for GitHub. Source prose, old manifests, local-path examples, and historical scripts retain their original context. Archived scripts are working evidence, not a supported one-command build pipeline.

Credentials, live databases, dependencies and caches are not part of this documentation collection. Existing application documentation remains in its original locations for code references; this library adds an organized snapshot.

One API-key value embedded in an older audit snippet was redacted in this collection; the finding and original source hash remain in the inventory.
