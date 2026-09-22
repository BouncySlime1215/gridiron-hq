---
name: gridiron-te-pressure-null-2026-09-22
description: Pressure allowed does NOT predict TE target share (r=0.057, CI crosses zero) — do not build the bad-O-line TE downgrade; but TE target share is drifting up 0.211 to 0.245 across 2022-2025.
metadata:
  type: project
---

Tested 2026-09-22, free data only. Spec `TE-PRESSURE-SPEC.md`, scripts
`te-build.mjs` / `te-test.mjs`, data `te-team-week.jsonl` (project files).

**The hypothesis.** Big Data Bowl 2025's TendencIQ observes that teams allowing
more pressure use their tight ends more in pass protection. The fantasy rule
people draw from that: a TE behind a bad line blocks more, runs fewer routes,
and should be downgraded.

**NULL. Do not build it.** 1,658 team-weeks, 2022-2025 REG, week >= 5, prior
pressure pooled over weeks 1..W-1 only, bootstrap clustered on team-season:

- pooled cross-team **r = 0.0574, 95% CI −0.0523 .. 0.1499**
- within team-season **r = 0.0197, 95% CI −0.0432 .. 0.0718**

Both intervals contain zero, quintiles are non-monotone (Q3 is the lowest TE
share in the table), and the point estimate has the **opposite sign** to the
rule — more pressure allowed goes with slightly *more* TE targets.

**Scope: this refutes the fantasy rule, not the notebook.** The notebook
measured blocking *rate*; this measures target *share*. A TE can run fewer
routes and keep his share of the targets that remain. Testing the notebook's
own claim needs per-player route participation, which the free file does not
give — its `route` column is the **targeted** receiver's route only.

**A confound I expected and did NOT find.** TE share rises every season, so I
expected the pooled 0.0574 to be that trend leaking in. Season-demeaned it is
**0.0583** — unchanged. Guessing at a confound is not checking one.

**The one positive finding: TE target share is drifting up, monotone.**
0.2115 → 0.2180 → 0.2324 → 0.2449 across 2022-2025, +3.3 points (~16% relative)
in four years, while pressure allowed stayed flat (0.292-0.312). Position shares
validated against published league values, 0.20% of targets unmatched.

`projections.js:415-427` is **not** buggy here — those positional rates are
computed from the weighted history window and the literals are zero-denominator
fallbacks. The open question is whether the `RECENCY` half-lives adapt fast
enough to a +0.8 point per season drift. Testable by walking the TE prior
forward against the realised season share; not tested. **Belongs to whoever
owns `projections.js` tuning, not to R&D.**

Method notes: [[gridiron-throughweek-two-conventions]] (the prior window is the
same cutoff trap), [[a-band-ratio-is-not-an-effect-size]] (report the interval).
