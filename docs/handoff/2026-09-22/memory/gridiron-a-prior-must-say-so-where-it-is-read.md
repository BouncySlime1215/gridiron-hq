---
name: gridiron-a-prior-must-say-so-where-it-is-read
description: Third corollary of the gridiron-hq as-of rule, from the 2026-09-20 Jev read — a stored basis column that never travels to the surface is no protection, and a model answer with no evidence under it must say so where a person reads it.
metadata:
  type: project
---

**A value that is a prior must say so where it is READ, not only where it is
stored.** Corollary three of the as-of rule
([[trade-brain-transactions-as-of]], with "an absence must say which absence it
is").

**The case.** `manager_archetype_jev` in gridiron-hq stores a model's answers to
typed questions about a manager, each row carrying a `basis` column: `'draft'`
means the record shown to the model bears on the question, `'inference_only'`
means it does not and the model was told to stay near the prior. Five of the
eight questions are `inference_only` — there are no trades, no waiver claims and
no timestamps in a draft record. The column had been written since the store
shipped and **had never travelled anywhere a person could see it**, so nothing
stopped a surface rendering `trade_style: counters 34%` as a fact about him.

**Shipped 2026-09-20** on `claude/project-thread-3xqh5l-accessor-hold`, branch
head **4b0fb02** (no PR, the freeze): RED 5bd079c, GREEN 1f8562e; the manager
page and explain-prompt half RED abc9c89, GREEN 7156e8a. Evidence
`docs/tdd/jev-model-read.tdd.md` and `docs/tdd/manager-page-reads.tdd.md`.
Seven gates (G11a-g in `test/valuation-map.test.js`) plus six, nineteen
mutations, all killed first pass. `jevEvaluated()` in `manager-signals.js` is the
fourth accessor in the as-of family; the display shaping and the shared
`managerModelReads()` are in `counterparty-pricing.js`. Full check on 7156e8a:
3,006 tests, 2,965 pass, 0 fail, 41 skipped, 357.5 s, 877 lintable files.

**Three things worth carrying to any similar read.**

1. **The stamp is per manager, not per league.** The Jev pass is opt-in
   (`--jev`, needs a gateway key) while the archetype build is not, so the two
   clocks drift apart by design — and the pass costs a gateway call per manager,
   so it can stop halfway through a league. A league-wide `MAX()` prints the
   newest manager's date under everybody's name.
2. **Displayed is a claim that needs a guard.** The gate that makes "it prices
   nothing" mean anything is: delete the entire store, recompute, and assert no
   price, multiplier, factor, inert entry **or receptiveness** changes. Two
   injections wiring it into each of those go red.
3. **Shaping a stored distribution has three traps.** A boolean is stored as its
   `true` leg alone and the other leg has to be put back, or every boolean reads
   as unmeasurable. A score question's `mean` summary is not one of its
   outcomes and must not be ranked among them. And `0.34/0.33/0.33` is an even
   spread, not a 33% chance — served as three numbers it invites a bar chart of
   noise.

**Settled overlap, and why it is NOT merged in-branch.** Chat sync owns the
member-keyed stamp: `archetypesBuilt(leagueId, season, memberId)` at
`manager-archetypes.js:947` on their hold `f61f5d4`, returning `jev_as_of` and
`jev_answers` **omitted rather than nulled** when no member is passed — so
`'jev_as_of' in built` is the check. Take `priced_as_of`, never `as_of`, and
import their exported `PRICED_SOURCES`. The swap is a FOLLOW-ON after their
branch and #47 reach `main`, not a stacked merge: their hold is stacked on #47,
so merging it would put two other pull requests inside PR #41. Conflict surface
when it happens: `test/manager-signals-api.test.js` only.

Related: [[gridiron-league-season-teams-is-not-a-core-table]],
[[assertion-must-name-the-thing-it-guards]].
