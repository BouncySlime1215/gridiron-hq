---
name: gridiron-checker-template-literal-blindness
description: The wiring map's value-computed-never-used rule was 76% false positives because scan() blanks template literals — fixed 2026-09-19, and the general lesson is that a scanner's stripping choices silently define what every rule built on it can see.
metadata:
  type: project
  modified: 2026-09-19T22:40:00.000Z
---

Fixed on `claude/wiring-map-8f96ur`: RED `06e3779`, GREEN `731a725`, evidence
`docs/tdd/wiring-map-template-literal-uses.tdd.md`. Keep the lesson even after
the commits are ancient history.

**What happened.** `scan()` in `scripts/wiring-map.mjs` blanks the entire body
of a template literal out of the code view, interpolations included. That is
correct for its SQL purpose and its comment says so. But it was also the input
to `value-computed-never-used`, so any value whose only other use sat inside a
`${...}` read as declared-and-abandoned. Across the tree that rule went from
**95 findings to 23** once fixed, and in fantasy scope from **15 to 0** — every
fantasy-scope finding it had ever produced was a value used to build a message.

**How it was found, which is the part worth keeping.** Not by reading the
checker and not by any test written for it. It surfaced on a delta run against
a tree this thread did not build — the UI thread's #43 and #46 merged onto the
gate head. The author's own tree happened to contain no value used solely
inside a message, so no amount of self-review would have reached it. Five
deliberate attacks had already been designed against this same tool and all
five passed; none of them was this.

**The general rule.** A scanner that strips or blanks anything silently defines
the ceiling of every rule built on top of it. When adding a rule, ask what the
tokenizer threw away before the rule ever ran — not what the rule does. The
stripping is usually right for the purpose it was written for and wrong for the
next purpose someone points at it.

**Choose the direction of theimprecision deliberately.** The fix
over-counts: a nested template's own interpolation is reached on a later pass,
and a name appearing anywhere extra simply silences the rule. That is the right
way round. A value wrongly called abandoned costs someone a real investigation
into working code and costs the tool its credibility; one wrongly left alone
costs a missed finding.

**Note the rule never gated.** It is in neither `GATING` nor `NEW_ORPHAN`, so
no build was ever blocked by the 72 wrong findings. They sat in the report and
on the published map instead, which is its own kind of damage — the failure
family in [[gridiron-wiring-map-blind-spot]] and the practice in
[[gridiron-author-is-the-worst-reviewer]].
