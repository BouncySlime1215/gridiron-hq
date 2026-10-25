---
name: gridiron-rerun-red-after-assertion-change-lesson
description: Lesson (Feature audit #130, 18:05Z) — re-run RED against the untouched code after EVERY assertion change, not only when the test is first written; a relaxed regex let the pre-fix code pass trivially
metadata:
  type: project
  modified: 2026-09-22T18:06:00.000Z
---
**Why:** while extending #130 to the fourth floorOf surface (RiskStrip.tsx), Feature audit loosened a test's regex to accept a new wording. The test still passed GREEN — but it would also have passed on the unfixed code, because the relaxed pattern matched the old output too. The RED commit that "proved" the test fails without the fix was made before the regex change, so the evidence file cited a RED that no longer described the assertion being merged. Caught on re-run: RED e7d2a84 5/5 fail, GREEN 389c2ac 44/44, evidence :120 corrected in place.

**Rule:** a RED result belongs to one exact assertion text. Every time an assertion changes — regex relaxed, expected value edited, matcher swapped — check out the untouched code (or stash the fix) and run the test again; it must fail again for the reason the evidence names. Cite the RED sha that matches the final assertion, not the first one. Pairs with [[gridiron-evidence-citation-rule]] (RED assertion inline) and [[gridiron-comment-right-assert-wrong-lesson]]. Origin [[gridiron-state-1283-2026-09-22]].
