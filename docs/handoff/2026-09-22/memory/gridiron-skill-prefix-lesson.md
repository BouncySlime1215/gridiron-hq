---
name: gridiron-skill-prefix-lesson
description: Lesson (four threads, 18:14Z; Feature audit found the fix 18:17Z) — skills Nick saves load only under the `anthropic-skills:` prefix (`anthropic-skills:gridiron-merge-gate-v2`, `anthropic-skills:gridiron-token-efficiency`); the bare name returns "Unknown skill"
metadata:
  type: project
  modified: 2026-09-22T18:22:00.000Z
---
**Why:** UI, Feature audit, Model evidence audit and Wiring map all invoked `gridiron-merge-gate-v2` by its bare name at 18:14Z and got "Unknown skill". The skill was saved and listed — but the skills listing prints it as `anthropic-skills:gridiron-merge-gate-v2`, and the Skill tool takes the exact listed name. Feature audit found the fix 18:17Z; the fleet was told 18:21Z. Four threads each burned a turn on a name, not a finding.

**Rule:** invoke saved skills exactly as the listing prints them: `anthropic-skills:gridiron-merge-gate-v2`, `anthropic-skills:gridiron-token-efficiency`. When a rule or handoff names a skill, it names it with the prefix. A coordinator message that says "load gridiron-merge-gate-v2" means the prefixed name. See [[gridiron-merge-gate-self-audit-skill]]. Origin [[gridiron-state-1290-2026-09-22]].
