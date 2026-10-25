---
name: gridiron-step8-decision
description: The decision Nick must make before step 8 (promoting the fitted k vector) — which screens move, which keep constants, the measured effect, and the recommended option.
metadata:
  type: project
  modified: 2026-09-19T21:58:40.759Z
---

Promotion reaches only the weekly path. Settled on origin/main 791b131: `activeKVectorFor` (shrinkage-fit.js:515-521) returns the fit unchanged only under WEEKLY_ROLE_RECENCY (sole caller player-week-engine.js:273) and the vector minus VOLUME_METRIC_NAMES (→ null) to season-long callers. With no active row it is null for everyone, so before step 8 both paths run constants and the divergence BEGINS at step 8. The guard is already in the deployed build (not #15's); it is a deliberate units guard (weekly recency 0.05 vs 0.35; shrinkage-fit.js:513 "not claimed to be right, only untested with the fitted k").

**Measured:** 0/1,130 season-long projections move, 1,155/1,174 weekly move, startable +4.75 ppg wk2, MAE 5.22→2.32, McBride 7.45→18.61. Guard-lifted counterfactual mean −0.41: label it "different projection window", NEVER "five points low".

**Screens (traced by the UI thread, verify the consumer):** Start/Sit, Trade Lab values, League Hub, waivers AND the ROS list move (ROS attenuated by a preseason prior at n/(n+4); magnitude unmeasured). The draft board is ESPN's projection nudged by RELATIVE disagreement (draft-assist.js:430-435), so a uniform shift cancels. ONLY My Team playoff/title odds and Trade Lab's championship ranking keep the constants; those get the label.

**Options:** (1) promote, fit the season-long path next train; (2) plus a served `projection_basis` field; (3) hold. **Recommend 1+2.**

Put to Nick in ONE message together with the O4 one-liner and the Settings "data behind these numbers" section (recommend yes), then the run sheet. See [[gridiron-post-deploy-chain]].
