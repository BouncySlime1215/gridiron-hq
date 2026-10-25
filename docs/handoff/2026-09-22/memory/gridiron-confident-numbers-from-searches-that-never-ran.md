---
name: gridiron-confident-numbers-from-searches-that-never-ran
description: The single failure shape behind almost every Gridiron HQ fantasy-audit finding on 2026-09-19/20 — a surface stating a confident verdict produced by a search that never ran.
metadata:
  type: project
  modified: 2026-09-20T02:50:00.000Z
---

**The theme, which is the useful part.** Almost none of these produced a wrong
number. They produced *confident* numbers from searches that never ran: a board
ranking on a stale row at double weight, a waiver page calling an unsearched
position "a good sign about your roster", a bye page calling an unrun search
"nothing on the wire fixes it", a trade priced for week 1 in week 2, a redraft
league told to trade for a future it does not have. The fixes mostly do not
change what the model scores; they change what the surface claims about what it
scored. See [[gridiron-failure-modes]].

Later findings, same shape: Trade Lab reporting a confident NEED at every
position the VOR board cannot price (`0 / (avg || 1)` = 0, below WEAK) — and
that false need reaching `trade-engine.js:156` as a counterparty's `theirNeeds`,
so the engine proposed trades to fill it. And the waiver board publishing a
hand-set `0.9` into the Decision Inbox's `confidence` column, which the trade
publisher fills with a fitted `p_right`.

**The tell, for finding more of these:** a served number that is *extreme*
(zero, one, a perfect ratio) and *uniform across every row*. A real measurement
varies. A structural absence does not. Where one is rendered without a basis
field beside it, check what produced it before believing it.

The fix for each is nearly always the same and it is not a model change: name
the basis on the wire, and refuse the verdict where the input is absent. Three
surfaces now carry it — `availability_source` (#57), `window.basis` (#74),
`acceptance` (#62) — and a fourth that does not is the next one worth finding.

Full branch list: [[feature-audit-shipped-prs-55-57]].
