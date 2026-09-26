---
name: gridiron-open-risks
description: Status of Gridiron HQ open risks — the 2026 QBR corruption is NOT present in the live Fly database (checked 2026-09-19); three key-exposure incidents, five credentials, zero rotations confirmed.
metadata:
  type: project
  modified: 2026-09-22T08:24:52.271Z
---

**QBR corruption: refuted against the live Fly database on 2026-09-19.**
Checked read-only through `GET /api/nfl-betting/data-consistency` on
gridiron-hq.fly.dev with an authenticated token. `nfl_qbr_weekly` reports
**0 rows for every season 2021 through 2026**, not 550 for 2026. Corroborated
by `GET /api/dev/sources`: the scheduled job that syncs QBR,
`nfl_qbr_weather`, has **never run** on that machine (`last_run_at: null`,
status "never run"), so the table could not have been filled there.

Caveat on the method: `tableCoverage` in
`server/services/nfl-data-consistency.js:40` returns the same all-zero shape
whether the table is empty or absent, so this proves "no 2026 QBR rows live",
not which of the two. Either way there is nothing to purge on Fly.

Conclusion: the 520-of-550 finding came from a **different database** — a
local `data.sqlite` in an earlier session — not from the deployment. There is
no `data.sqlite` in the checkout now. `scripts/flag-qbr-2026-placeholders.mjs`
does exist in `main` (contrary to the sibling claim about
build-manager-signals) and is still unrun; it is only useful against whichever
database actually holds those rows. Do not describe this as a live-data risk
again without re-checking the specific database first.

**Still open: exposed credential, revocation unconfirmed.** An
`AI_GATEWAY_API_KEY` appeared in a screenshot in chat on 2026-09-18. Rotation
was requested and never confirmed. Do not write the key itself anywhere.

**Second, separate incident (2026-09-22 03:35Z):** the Coach thread printed
the live values of `GRIDIRON_FLY_TOKEN` and `GRIDIRON_ANTHROPIC_API_KEY` via
`env | grep -i GRIDIRON`. Rotation of both requested; also unconfirmed. Do
not conflate with the `AI_GATEWAY_API_KEY` exposure above — see
[[coach-env-dump-key-exposure-2026-09-22]].

**Incident 3 (08:23Z 2026-09-22), Model evidence audit thread:** ran `env | grep -i 'GRIDIRON\|DB_PATH'`, printing GRIDIRON_FLY_TOKEN and GRIDIRON_ANTHROPIC_API_KEY into its transcript. Nothing transmitted, nothing committed. Both burned by rule. Escalated to Nick 08:24Z with rotation block (fly tokens list/revoke/create deploy; console.anthropic.com revoke+create; update Claude Code environment variables). Rotation NOT yet confirmed. Running tally: three incidents, five credentials, zero confirmed rotations. Rule for every thread: never print env values; presence check is `[ -n "$VAR" ] && echo set`.

See [[fly-deployment-outside-repo]] and [[gridiron-live-data-state]].
