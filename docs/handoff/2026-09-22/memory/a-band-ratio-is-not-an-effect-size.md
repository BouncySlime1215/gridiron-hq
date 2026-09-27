---
name: a-band-ratio-is-not-an-effect-size
description: Ranking candidate model splits by the ratio between their bands got the ordering backwards; rank by a paired ablation with an interval, and decompose any ablation that moved two things at once.
metadata:
  type: feedback
---

2026-09-22, gridiron-hq. Two threads made the matching halves of one mistake
on the red-zone opportunity tiers.

**Mine.** I measured a 3.53x TD-rate gap across the pooled rushing band and a
1.41x gap across the pooled receiving band, and withdrew the receiving tier
because 1.41x "looked too small". A ratio between bands is not an effect size.
How much volume sits in each band, and how badly the pooled rate misprices the
players actually in it, matter as much as the ratio. Decomposed, the receiving
half had **twice** the rushing half's point estimate (-0.456% vs -0.230% MAE).
My ordering was exactly backwards.

**Theirs.** Their ablation moved rushing and receiving from three tiers to
four at the same time and reported one number (-0.684%, interval excluding
zero). That establishes the **pair**. Every reader takes it as establishing
both halves. Decomposed, the rushing half alone excludes zero; the receiving
half alone **includes** it, despite the larger point estimate, because its
interval is wider.

**Why:** a ratio is a statement about two conditional rates. An effect size is
a statement about the forecast, which also depends on exposure. And a joint
ablation confounds its arms by construction.

**How to apply:**
1. Never rank candidate splits, tiers or features by a ratio between their
   bins. Rank by a paired ablation with an interval.
2. When an ablation moves more than one thing, its number establishes the
   combination. Decompose before attributing it to any part, and say "the
   pair" until you have.
3. "Not established" (interval includes zero) is not "does nothing". Say the
   one you mean.
4. Apply the `nfl-model-watch.js:1-18` suspicion to your own reasoning, not
   only to other people's changes.

Numbers, the decomposition table and the corrected conclusion:
[[gridiron-redzone-bands-corrected]]. Related: [[gridiron-failure-modes]],
[[gridiron-offense-entropy-dead-end]] (the same shape — a monotone bin table
that dissolved once the confounder was held fixed).
