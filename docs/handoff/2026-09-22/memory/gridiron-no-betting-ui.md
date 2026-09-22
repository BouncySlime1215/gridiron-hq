---
name: gridiron-no-betting-ui
description: The betting half of the Gridiron HQ server is 335 route handlers with no client pages at all, which is why any repo-wide "uncalled route" count looks alarming until it is split by scope.
metadata:
  type: project
---

Measured 2026-09-20 on #36 (`claude/wiring-map-8f96ur-route-gate-hold`, `aede8b3`):

**548 route handlers in 31 files under `server/routes`. 335 of them are betting,
and there is no betting UI.** Exactly five client files mention betting anywhere
— `App.tsx`, `api.ts`, `navigation.ts`, `NotFound.tsx`,
`PageExplainAssistant.tsx` — and not one of them is a page.

So `route-no-caller` flags:

```
betting   324 / 335 = 97%
shared     54 /  91 = 59%
fantasy    27 /  79 = 34%
43 routes in files with no findings at all: 0%
```

**How to apply:**
- **Any repo-wide count over `server/routes` is carried by betting and will
  overstate the in-scope problem by roughly 5x.** The feature-audit thread
  correctly challenged "405 uncalled of 548 = 74% of the app" as too large to be
  credible. It is credible, and it is not a finding: it is an API with no front
  end. **The number to carry is 81 in-scope, 27 of them fantasy.**
- Nick ruled out betting FEATURES, not knowing what connects to what, so these
  rows stay mapped and tagged rather than skipped — but they never belong in a
  headline figure.
- This is the denominator problem in general: split by scope **before** deciding
  a count is alarming, and before building a ranker to cope with it. See
  [[gridiron-checker-unreadable-output]], where scope cut 80% in one move and
  weight cut nothing that mattered.

Related: [[gridiron-wiring-map]] · [[gridiron-checker-unreadable-output]] ·
[[gridiron-checker-tokenizer-blind-spots]]
