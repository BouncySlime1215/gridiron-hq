---
name: gridiron-swallow-scan-tool
description: scripts/swallow-scan.mjs enumerates bare catches over SQL reads; its real counts, its blind spot, and the five interpolated sites that are correct and must not be flagged.
metadata:
  type: project
  modified: 2026-09-22T08:41:05.043Z
---

`scripts/swallow-scan.mjs` (PR #103, branch `claude/project-thread-3xqh5l-tactics-absence`,
based on #94 not main) is the committed, re-runnable version of the sweep that
found the veto-climate, counterparty-data-key and self-read defects. Run it with
`node scripts/swallow-scan.mjs server`. Tests: `test/swallow-scan.test.js`, 9.

**Numbers on e3bca56, replacing the earlier scratch figures.** 273 tables are
created by `server/migrations` + `server/db/schema` — NOT 62; the old hand-built
scratch list was badly incomplete and over-reported risk. 27 bare catches sit
over a literal SQL read in `server/`; 6 read a table with no migration:
counterparty-pricing.js:817 and :934 (fixed on #100), league-chat-sync.js:105
(chat-sync thread), nfl-ensemble-rank.js:656 and nfl-rebuild-progress.js:13/:17
(coach thread). The two trade-tactics.js sites are already fixed by c56be56.

**Why:** the sweep's own output was the last figure on this lineage with no
provenance, which is the exact defect the lineage exists to stop.

**How to apply:**
- BLIND SPOT, still open: it reads literal SQL only. An interpolated or
  concatenated query (`FROM ${table}`, `'... FROM ' + table`) is invisible to
  it. Every site it reports is real; the set is a FLOOR, not a total.
- **Five interpolated sites are CORRECT — never flag them:** contingency.js:552
  and :563, compute-cache.js:56, nfl-experiments.js:81, llm-budget.js:395. The
  discriminator is missing-table versus every other error.
- Do not reintroduce a fixed lookback cap. Max try→catch span in server/ is 122
  lines; 26% of sites exceed 12. The 25-line cap hid polymarket.js:204.
- A catch body's own prose is not a read: `'invalid JSON from Python scoring
  worker'` was reported as a table named `python` until attribution was limited
  to the try block's own span.

Related: [[gridiron-threads-directory]]
