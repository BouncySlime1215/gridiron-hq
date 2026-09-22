---
name: gridiron-swallow-sites-per-branch-1303
description: Measured 13:03Z 2026-09-22 — the swallow-scan unmigrated-table sites on each of the trade-brain branch heads, so nobody re-runs the seven-branch sweep; includes one claim in the older note that this contradicts.
metadata:
  type: project
---

Ran `scripts/swallow-scan.mjs server` (taken from `tactics-absence`, run with cwd
set to each worktree so `migratedTables` resolves) against seven heads. Every
figure below is measured, and each line names the branch and sha it was measured
on — the rule adopted after the fifth "measured on one tree, reported under
another tree's name" failure.

| branch | sha | bare catches | over an unmigrated table |
|---|---|---|---|
| jev-4b-port (integration of #89+#91+jev) | 7e57a9ba / tree a51e318e | 30 | 9 |
| accessor-hold (#91) | 3c949d9f | 29 | 8 |
| datakey-absence (#100) | f8aa2303 | 29 | 8 |
| manager-read | dff747f4 | 29 | 8 |
| integration | 6918a985 | 29 | 8 |
| tactics-absence (#103) | a830c2b2 | 27 | 6 |
| outcome-ledger (#94) | e3bca568 | 27 | 6 |

The 27/6 on `e3bca568` reproduces [[gridiron-swallow-scan-tool]] exactly, so that
note's figures are confirmed for their tree and need no correction.

**MY FILES, the sites that appear on every one of my heads** (line numbers shift
per branch; the two sites are the same two):

- `counterparty-pricing.js` — `league_transactions_raw` (:817 on tactics/ledger/engine-fault, :831 on datakey, :1056 on accessor-hold, :808 on integration)
- `counterparty-pricing.js` — `negotiation_profiles` (:934 / :989 / :1173 / :925)
- `trade-tactics.js` — `league_transactions_raw` twice (:235/:388, or :239/:404 on accessor-hold); ABSENT on tactics-absence, outcome-ledger and engine-fault, which carry `c56be56`

**OPEN QUESTION, do not resolve from memory.** [[gridiron-swallow-scan-tool]] says
"counterparty-pricing.js:817 and :934 (fixed on #100)". Both sites still match the
scanner on #100's own head (`f8aa2303`, at :831/:989). That is not proof the fix is
missing — #100 added `tx_read_state` reporting, and the scanner matches the SHAPE
of a bare catch over an unmigrated read, not whether the absence is reported. Read
the two sites before claiming either way.

**`negotiation_profiles` looks unclaimed.** It is not in the older note's list of
six and no thread has been allocated it. Candidate unit, not a finding.

**Why:** re-running this sweep costs seven worktrees and a scan each. Nick's 13:02Z
order names redundant reruns specifically.

**How to apply:** a candidate site is only open if it is still bare on the branch
that OWNS that file, which is not the branch in the working directory. My own fixes
live scattered across my own branches — `c56be56` is the example: the trade-tactics
sites read as open on four of my seven heads and are fixed on the other three.
