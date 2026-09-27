---
name: gridiron-checker-unreadable-output
description: A wiring-map rule that printed 462 undifferentiated rows reported nothing in practice; the fix was scope and naming, not ranking, and the measurement rejected two plausible designs
metadata:
  type: project
---

`route-no-caller` named `GET /api/decision-inbox` and
`GET /api/trades/:leagueId/trends` — both genuinely dead, both with real work
behind them — and **both were found by hand anyway**, because the rule printed
462 undifferentiated rows and `toMarkdown` rendered bulk rules as a file-count
table that named nothing. The two endpoints were inside
`decision-inbox.js | 4` and `trades.js | 18`.

**A rule that produces 462 rows is, in practice, a rule that reports nothing.
The format is part of the rule.** That is a distinct failure from
[[gridiron-checker-tokenizer-blind-spots]], where the extractor lost data. Here
nothing was lost. It was all written down, correctly, where no one would read it.

Fixed 2026-09-20 on #36, local commits `f3f56d5` (RED) / `babe1bf` (GREEN),
held at `claude/wiring-map-8f96ur-route-gate-hold`. Evidence:
`docs/tdd/wiring-map-route-literal-absent.tdd.md`.

**How to apply:**
- **Rank by the axis the reader filters on, not by the axis you can compute.**
  `routeWorkload` ranks honestly and was useless here: the two target endpoints
  landed at 205 and 225 of 405, and the top five were betting sync routes —
  heavy, real, out of scope. 405 splits 27 fantasy / 54 shared / **324 betting**.
  Scope cut 80% in one move; weight cut nothing that mattered. Check the scope
  split before building a ranker.
- **Design a gate against the corpus, not against reasoning.** Two plausible
  versions of `routeLiteralAbsent` were built and rejected on numbers only:
  last-segment-only dropped 139 rows and silently took five `/api/betting` and
  `/api/edge` endpoints; longest-run-later-wins suppressed
  `POST /api/decision-inbox/:id/resolve` while its own sibling stayed a finding.
  **Two answers about one endpoint is the tell** — same shape as the
  `reapAbandonedRuns` catch.
- **Read every dropped row when a gate is added.** All 57 were listed and read
  and confirmed live. A gate that only reports its count is a gate nobody can
  check.
- **A category the rule cannot see is flagged, never annotated away.**
  `GET /api/auth/google/callback` is the top in-scope row and is called by
  Google. Routed to the thread that owns the file rather than suppressed.

Related: [[gridiron-wiring-map]] · [[gridiron-failure-modes]] ·
[[gridiron-tdd-defect-injection]] · [[gridiron-author-is-the-worst-reviewer]]
