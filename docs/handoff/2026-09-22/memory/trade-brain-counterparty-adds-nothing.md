---
name: trade-brain-counterparty-adds-nothing
description: The Trade Brain's counterparty layer was measured against 30 real decisions and adds AUC 0.000 over our own value number; it ships as a read, not a price.
metadata:
  type: project
---

Answered 2026-09-20 for Nick's "is this based on stats or just made up" rule.
Full write-up: `docs/evidence/2026-09-20/trade-brain-signal-provenance.md`
(PR #70, docs only). Every line below is `origin/main` at `791b131`.

**The measured result, already in the repo — do not re-derive it.**
`docs/tdd/valuation-map.tdd.md` §6, on all 30 decided 2026 proposals (6 accepts,
24 declines, 13 deciders, 130/130 items resolved): own value gain AUC **0.813**,
the map cutoff-safe **0.806**, contaminated arm 0.833. Decider-clustered
bootstrap, 2,000 resamples: **B−A median 0.000** (−0.017…0.000). On the 16
decisions made by someone other than Nick — the ones the layer is for — B−A is
exactly **0.000, zero-width interval**. The contaminated arm's whole lift is the
part that can see the future. §7's ablation agrees: zero each source in turn and
**no source changes which ideas surface**; three change their order. The binding
constraint is `perceptionFactorFor` in trade-engine.js, ±10% of a deal's score.

Say it plainly, never softened: with 6 accepts people decide on value, and the
chat layer's contribution is smaller than 30 decisions can detect. It is worth
having as what Nick is TOLD (tactics + Coach consume it), not as a price.

**Provenance, three layers.** Six of seven declared signal sources
(`manager-signals.js:66-78`) are measurements; `nick` is the one hand-set input
allowed to price, entering as nudges −0.10/−0.05/+0.08
(`counterparty-pricing.js:185-187`). All eight `VALUATION_SOURCES`
(`counterparty-pricing.js:62-93`) carry **`fitted: false` in the data**, each
with its own cap (0.05–0.12) and a `min_n` that reports itself inert WITH a
reason. Unfittable because 30 decided / 6 accepted (:41-45). Tested: the SHAPE
(caps, provenance, samples, no double-charging), not the sizes.

**The history test that failed, and was wired rather than filed.**
`study/features/archetypes.md`, 12 league-seasons / 108 manager-seasons: no
draft metric survived year-over-year repeatability. Auto-draft rate's r = 0.70
is one man (Spearman 0.16, worst leave-one-manager-out 0.26). So `draft` is the
one source with `priceable: false`, joined onto every served row at
`routes/trades.js:446`.

**Latent hardening, not a bug — state it that way.** The `priceable` flag is
enforced ONLY in the route; `manager_signals` has no such column
(`manager-signals.js:42`), and `managerSignalsFor` (:502) — "everything the
trade engine needs" — returns metrics with no flag, which is what
`counterpartyLayer` reads (`counterparty-pricing.js:132`). Checked: the four
draft metrics are `draft_auto_rate`, `draft_reach_rate`,
`draft_pick_vs_consensus`, `draft_name_brand_excess` (:266-267) and NO consumer
in `server/` or `client/` reads any by name. Nothing prices on a failed metric
today; there is also nothing stopping it. Move the join below the route BEFORE
pointing the signals at a second page.

**Routing, today and recommended.** Today: `counterpartyLayer` at
`trade-engine.js:1522`, `:2052`, `routes/trades.js:493`; `archetypesFor` at
`trades.js:502`. Nothing else. Recommended: Waivers yes (`tx` is priceable and
the board prices a claim with no notion of who else claims it), League Hub yes
(one `recency_post_loss` line), **Draft NO** — archetypes are built from draft
day, so it is the obvious target and the one place the test forbids — Start/Sit,
News, X's & O's, Settings no.

Related: [[gridiron-failure-modes]] · [[ci-disabled-local-checks-are-the-gate]]
