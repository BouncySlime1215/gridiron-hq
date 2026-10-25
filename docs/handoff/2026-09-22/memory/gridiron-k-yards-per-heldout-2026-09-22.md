---
name: gridiron-k-yards-per-heldout-2026-09-22
description: "WITHDRAWN by Auditor R34: the K.yards_per=34 finding does not survive. Kept for the method it produced — identified sets, sensitivity tables, and fitting against the prior production actually serves."
metadata:
  type: project
---
2026-09-22, Explorer. Train 2023 REG, held out 2024 REG, **2025 never opened**.
Estimator is `server/services/stats-util.js:17` itself. Package
`/mnt/project-files/PACKAGE-K-YARDS-PER-HELDOUT-2026-09-22.md`, prereg
`KHELD-PREREG-2026-09-22.md`, script `KHELD-kheld.mjs`, output `KHELD-kheld.json`.

Held-out 2024 weighted MSE (lower better), k chosen on 2023 only:

- **yards per target** — incumbent k=34: 2.99859. Train-chosen k=64: 2.84222. k=70: 2.83523 (held-out optimum is k=81 at 2.83123). **Claim survives: 34 is too low for ypt, ~70 is sound out of sample.**
- **yards per carry** — incumbent k=34: 0.73889. Train-chosen k=134: 0.75853. k=115: 0.74840. **Claim FAILS. The 115-for-ypc proposal in EFFICIENCY-K-SPEC.md (package #8) is WITHDRAWN.** The in-sample ICC fit over-shrinks rushing; n is thin (82/88 player-seasons clear 50 carries).

Level cost, mean signed error on ypt: −0.029 at k=34 → −0.116 at k=70. More shrinkage buys squared error and sells the level. Report both. [[gridiron-mae-flat-changes-move-bias]]

**Correction to the earlier package:** `K.yards_per` has THREE consumers on origin/main 1a136145, not two — `projections.js:562` (ypt), `:570` (ypc) and **`:575` (ypa)**. ypa was never measured in any arm.

**Why:** package #8 asserted 70/115 from a pooled in-sample variance decomposition over 2023-2025 with no held-out split, and it read 2025. Half of it did not survive a real split.

**How to apply:** if anyone proposes touching `projections.js:97`, ypt-only is the supported change and it still needs the walk-forward run that produced 4.773 vs 4.749. Do not quote 115 for ypc. Do not quote package #8's "rushing needs three to four times" line.

---

## R31 CORRECTION, same day. Read this part, not just the part above.

Auditor R31 required a PLAYER-CLUSTERED interval (cluster = 140 players, not 17,013 targets), an identified RANGE instead of a point, and the k-mu coupling recorded. All three change what can be said.

- **Registered comparison, player-clustered.** ypt, 34 minus train-chosen 64: **+0.15636 [+0.01753, +0.29121]** — excludes zero, the claim SURVIVES, but the lower bound nearly touches zero. ypc, 34 minus 134: −0.01964 [−0.11402, +0.06830] — spans zero. **So ypc is UNRESOLVED, not refuted. "Refuted" was my word and it was too strong.**
- **The optimum is a flat unidentified range.** ypt k in **[31, 232]**, ypc k in **[13, 294]**, both contiguous, **and 34 is inside both**. 34→64 moves wMSE 0.156; 64→115 moves it 0.018. **"64" and "70" are false precision — do not quote either as a value to adopt.**
- **k and mu are jointly fitted, and the coupling is fatal-scale.** At mu − 1.00 yard the train-chosen k is **35** (the incumbent) and the advantage is 0.0011. The live code uses a **positional** prior (`projections.js:562`), and TE's ypt is well below the pooled 7.3515 used here. **This finding is conditional on a pooled prior production does not use.**
- **REMEDY, as R31 redirected it:** the finding is NOT "set 34 to 64". It is that **one constant (`projections.js:97`) does three jobs — :562 ypt, :570 ypc, :575 ypa — that need different values**. Split per consumer, then grade. **Do not change the shared value on ypt's evidence.** Code unit for projections.js's owner (Model evidence audit), not Explorer's.
- **Level cost owed before adoption:** ypt mean signed error −0.029 at k=34 vs −0.116 at k=70, four times the bias for a 5.2% gain. Consumers sum over a lineup. A projection-level walk-forward closes it.

**BURNED SEASONS for the K.yards_per question** (R31's new rule: a season read by any analysis, INCLUDING A RETRACTED ONE, is no longer clean for that quantity): **2023 burned** (train), **2024 burned** (held out), **2025 partially burned** by the withdrawn EFFICIENCY-K-SPEC.md pooled fit. Withdrawing a conclusion does not un-read a season.

Addendum published in the package; scripts /mnt/project-files/KHELD-kband.mjs, KHELD-kclean.mjs, KHELD-kmu.mjs. [[gridiron-burned-seasons-rule]]

---

## AUDITOR R34, FINAL: THE FINDING DOES NOT SURVIVE. Do not quote any k from this work.

Three reasons, the third decisive alone:
1. **34 is inside both identified sets** — ypt [31, 232], ypc [13, 294].
2. **The ypt interval's lower bound is 11% of its point** (+0.0175 vs +0.156).
3. **The prior fitted is not the prior served.** Fit used pooled mu = 7.3515; `projections.js:562` serves `prior.ypt` PER POSITION. The sensitivity table shows mu − 1.00 takes the train-chosen k to **35** and the advantage to 0.0011. **Checkable before any number was computed.**

R34 also **withdrew its R31 credit for the ypc "self-refutation"** — a null read as a negative.

**"One constant doing three jobs" (projections.js:562 ypt, :570 ypc, :575 ypa) is an OPEN STRUCTURAL QUESTION with no evidence either way.** R31.2's "they need different values" is half-retracted. Not a finding, do not route it as one.

**R34's coherence question, answered and measured:** the reference k in the 34-vs-argmin interval was **FIXED**, computed once on the full held-out sample (kband.mjs:89), never re-selected per resample. The wider interval at a larger point is ordinary dispersion growth — per-player paired differences, weighted SD/mean 5.67 at k=57 → 6.23 at 64 → 7.75 at 81 → 11.90 at 115, so t falls 2.09 → 1.90 → 1.53 → 0.99 monotonically. Same seed, identical resamples, so not seed noise. Evidence `/mnt/project-files/KHELD-kwidth.mjs`, `KHELD-kwidth.out`.

**WHAT SURVIVES IS METHOD:** [[gridiron-fit-against-the-served-prior]] — and the identified-set requirement and sensitivity table named there are mandatory on every constant proposal from now on.
