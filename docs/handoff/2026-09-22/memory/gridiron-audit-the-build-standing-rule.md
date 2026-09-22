---
name: gridiron-audit-the-build-standing-rule
description: Nick's standing rule for every Gridiron HQ thread, given 2026-09-20 01:21Z — before delivering anything, ask whether it is built on stats or made up, how we know, and where else on the platform the data should point.
metadata:
  type: feedback
---

**His words, 2026-09-20 01:21Z**, now in the project instructions for every
thread:

> "You need to seriously consider ok is this well built: is this based on stats,
> is this just made up. How do we know this. Audit the structure. Audit the
> overall build. Ask if this data should be pointed anywhere else on the
> platform. How can we unify everything. ASK YOURSELF THAT EVERY TIME."

**Why:** it arrived the same night as a deploy whose plan carried a false
"all migrations are additive", a diagnosis argued for two hours from timing
arithmetic before anyone read one field across six lives, and a merge-order
reason invented as "would not compile" when the real case compiles and ships
wrong. The rule is aimed at the project's recurring failure — see
[[gridiron-release-train-2026-09-19]] — where a thing looks healthy and is not.

**How to apply.** Four questions, before the deliverable goes out, not after:

1. **Measured, read, or inferred?** Say which, in the artifact itself, per
   claim. A table of provenance beside the claims costs ten minutes and is what
   tells the reader which sentences survive being wrong about something else.
   Done for the release plan's morning block as section 7.0c-0 — worth copying
   the shape.
2. **How would I know if this were wrong?** A claim with no answer is a guess
   wearing a citation. Prefer the check that *would have caught us* over the
   one that confirms what we already believe.
3. **Audit the structure, not only the change.** The census that found the
   `nfl_model_growth` flag gap came from enumerating all 62 jobs' tiers and
   flags, not from reading the boot path again.
4. **Where else should this point?** A number computed for one surface and
   rendered on one surface is usually wrong about the other places it is
   already implied. Ask before shipping it, not in the next audit.

**Pairs with** [[gridiron-cite-the-shipping-tree]] (cite the tree, and check a
reason you restate in your own words) and
[[verify-the-consumer-not-the-producer]].
