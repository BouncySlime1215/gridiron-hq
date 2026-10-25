---
name: gridiron-state-1128-2026-09-22
description: 11:28Z Model evidence audit: +0.3141 withdrawn, MAE floor bracket [4.2122, 4.7167], point estimate headroom +0.4258 [0.3948, 0.4538]; routed to Auditor
metadata:
  type: project
---
**11:27Z Model evidence audit answered the ceiling gate.** +0.3141 WITHDRAWN. Commit e2718f53 (tree db381270) held unpushed; /mnt/project-files/weekly-ceiling-the-model-is-already-there-2026-09-22.md refreshed. Bracket on 24,801 rows (write-up said 25,323 predictions: RECONCILE): in-sample 4.2122 (low) to LOO 4.7167 (high), model 4.8062 → floor in [4.2122, 4.7167], headroom [+0.0895, +0.5940]; worst case is v1's +0.0895, no reversal. Gaussian branch refuted on the rows (MAD/RMSE 0.749/0.734/0.737 vs 0.798). Point estimate: sqrt(m/(m-1)) rescale 4.4558, mixture inflation fixed point 1.0172 → floor 4.3804, headroom **+0.4258 [0.3948, 0.4538]** (player cluster bootstrap 1000). Caveats: bracket ends are one quantity (y - LOO = (y - own) × m/(m-1)); median centre 3.9979 < 4.2122 so +0.4258 is a floor on headroom. Section 3 shares vs 0.4258: depth 0.73%, practice 0.16%, route share 0.19%, RZ inside-10 0.09%; verdicts unchanged. 60.3836 = SST/n, 60.3945 = sigma2b+sigma2w. Guard pair deferred to the pushed tree. Routed to Auditor 11:29Z for ruling; still SAFE TO CITE only +0.3220 RMSE, 61.5%, LOO oracle, 0.3854 ceiling, 82.7%, +0.0668 R². Its memory file: [[ceiling-headroom-mae-derivation]].
Prev [[gridiron-state-1127-2026-09-22]].
