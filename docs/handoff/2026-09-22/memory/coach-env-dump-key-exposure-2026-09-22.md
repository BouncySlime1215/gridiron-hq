---
name: coach-env-dump-key-exposure-2026-09-22
description: Coach thread printed the LIVE VALUES of GRIDIRON_FLY_TOKEN and GRIDIRON_ANTHROPIC_API_KEY via `env | grep -i GRIDIRON`; rotation requested 03:35Z, unconfirmed. Second, separate incident from the 2026-09-18 AI_GATEWAY_API_KEY exposure.
metadata:
  type: project
  modified: 2026-09-22T03:36:33.063Z
---

**2026-09-22T03:35Z — Coach thread (cse_016PjGEhxy64vLJRHjfRmZAH) printed two
live secret values, not just presence/existence.** While trying to locate an
unset `GRIDIRON_DB_PATH`, Coach ran `env | grep -i GRIDIRON`, which dumped the
actual values of `GRIDIRON_FLY_TOKEN` and `GRIDIRON_ANTHROPIC_API_KEY` into
its own tool output.

Coach self-reported immediately, citing CLAUDE.md's rule that a key shown
anywhere is burned and must be rotated, rotation confirmed. Coach states: it
has not repeated the values anywhere since; nothing was written to disk
beyond the single stdout print; going forward it will use `find`/explicit
paths instead of `env` dumps.

Coordinator posted to Nick at 03:35Z asking him to rotate BOTH
`GRIDIRON_FLY_TOKEN` and `GRIDIRON_ANTHROPIC_API_KEY` and confirm once done.
**As of this writing, NEITHER rotation is confirmed.**

**This is a SEPARATE, second key-exposure incident — do not conflate with the
earlier one.** The first was `AI_GATEWAY_API_KEY`, exposed via a screenshot
Nick posted in chat on 2026-09-18, rotation also still unconfirmed; see
[[gridiron-open-risks]] (and MEMORY.md Phase 0 item 10, which currently only
names that first exposure plus "the Fly token pasted in chat" — a possibly
distinct, unreconciled reference that predates this incident; do not assume
it already covers this GRIDIRON_FLY_TOKEN dump).

**Net: three credentials with rotation requested and NONE confirmed** —
`AI_GATEWAY_API_KEY` (since 2026-09-18), `GRIDIRON_FLY_TOKEN` and
`GRIDIRON_ANTHROPIC_API_KEY` (since 2026-09-22 03:35Z). Anyone touching
Fly secrets or the Anthropic key wiring should check with Nick first — do not
assume either the Fly token or the Anthropic key currently in use is still
good, and do not write any of these key values anywhere.
