---
name: gridiron-audit-findings-ledger-2026-09-20
description: Where the single consolidated list of every Gridiron HQ audit finding lives (fixed, held or open, each with an owner), and the three conclusions it supports — so nobody re-sweeps the audit documents.
metadata:
  type: project
  modified: 2026-09-20T06:16:16.810Z
---

Written 2026-09-20 on Nick's 04:30Z ask ("there's a bunch of audit docs here can
you go through them and make the fixes"), the audit-document half of which was
allocated to the model evidence audit thread.

**The file:** `docs/evidence/2026-09-20/AUDIT-FINDINGS-LEDGER.md`, on
`claude/project-thread-w0gpjt-hold` at **dc057e8** — **not on main**, so a fresh
clone will not have it. One row per finding: finding, `file:line` on 791b131,
state, owner. Sources swept: `/mnt/project-files/fantasy-audit-2026-09-19.md`,
`remaining-work-scope.md`, `docs/OPPORTUNITY-FINDINGS-2026-09-19.md`,
`docs/NUMBER-PROVENANCE.md`, `docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md`
and the three hold-branch ledger pages. `wiring-findings-inventory.md` is the
wiring map's and was deliberately left to them.

**Rows carry a `[v]` mark when that thread verified them itself; the rest are
the reporting thread's claim.** Keep that distinction on any re-use — an hour
was not enough to re-verify forty findings across six threads, and a ledger that
blends checked and reported claims is the failure this project keeps catching.

## The three conclusions, which are the reusable part

1. **The 2026-09-19 fantasy audit is essentially closed.** Nine of twelve fixed
   in `main` at 791b131, one a decided leave-it (`players.bye_week`), two open
   with agreed one-line defaults (`tradeWeekContext(lg)`; the `NFL_SEASON` env
   line). **Do not re-audit that ground.**
2. **Most of the night's output is held, not open.** Eight rows are fixed and
   sitting on no-PR `-hold` branches under the 01:58Z GitHub freeze. The night
   produced a queue of fixes waiting on one word, not a list of problems.
3. **The open list is one defect wearing different clothes: a number hand-set
   where it could be fitted, or fitted where nothing reads it.** The shrinkage
   promotion, the coordinator correction on the wrong base, the advice-layer
   literals and the unparsed weekly scores that would let them be fitted, the
   efficiency half, and `priorFfOpportunity`. That is the one-sentence answer to
   "what is actually wrong with the model".

Highest-value single item is unchanged: the volume shrinkage promotion, a
database write that is already gated — **conditional on**
[[gridiron-shrinkage-promotion-needs-restart]].

See [[gridiron-model-audit-2026-09-20]] · [[gridiron-model-audit-open-findings]]
· [[gridiron-held-branches-2026-09-20]].
