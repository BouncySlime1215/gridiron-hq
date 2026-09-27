---
name: anthropic-key-wiring
description: The Anthropic key works end to end on Fly as of 2026-09-19 15:40Z; the naming workaround is GRIDIRON_ANTHROPIC_API_KEY, and an open question remains over whether Fly holds the pre-rotation key.
metadata:
  type: project
---

Earlier notes said "the Anthropic key wasn't working". That was never a bad
key — it was a missing Fly secret. **Resolved 2026-09-19.**

## The naming workaround (this is "the specific way it has to be done")

Claude Code cloud environments refuse to pass a variable literally named
`ANTHROPIC_API_KEY` through to the process — it is silently absent at runtime,
which looks identical to never pasting it. So `getApiKey()` on the deployed
branch (`server/services/claude.js:27`, branch
`cursor/betting-model-audit-fixes-1c85` = PR #6) reads
`GRIDIRON_ANTHROPIC_API_KEY` first, then `ANTHROPIC_API_KEY`, then the
`app_settings` row `anthropic_api_key`. Any name the platform does not claim
works.

**`main` does NOT have that fallback** — it reads only `ANTHROPIC_API_KEY` (13
sites). Anything built from main hits the same wall in a cloud box. Handed to
the thread splitting PR #6 on 2026-09-19 so the three-line fix rides along with
the code half rather than becoming its own PR.

## Verified working on Fly (2026-09-19 ~15:40Z)

Nick ran `fly secrets set GRIDIRON_ANTHROPIC_API_KEY=... -a gridiron-hq`. Fly
secrets are a separate store from the project's environment-variables box, so
setting the variable in the box never reached the deployment — that was the
whole bug. Confirmed after:

- `GET /api/dev/status` → `api_key: {configured: true}`.
- One real call through the app's own path (`POST /api/news/analyze`, one
  throwaway item, row deleted after) returned a genuine model response, and
  `GET /api/dev/usage` recorded 216 in / 88 out, $0.0007, feature
  `news-analyze`. So the whole chain works, not just variable presence.

No flyctl and no Fly platform token exist in cloud sessions —
`GRIDIRON_FLY_TOKEN` is an app login token only, see
[[gridiron-fly-login-token]]. So a Fly secret is always Nick's to set.
Alternative needing no restart: `PUT /api/dev/key` writes the key into SQLite
on the `/data` volume (production change, ask first).

## Open question flagged to Nick, not yet answered

The key on Fly is masked ending in the same four characters as the key this
session's environment held, and that environment was frozen at 15:26Z, nine
minutes before Nick reported setting the secret. So Fly most likely received
the **pre-rotation** key — the one he accidentally pasted into project chat.
That key still authenticated against api.anthropic.com at 15:38Z, meaning the
exposed key had not been revoked. Nick was asked to compare the Console against
the Dev Hub's masked value, delete the exposed key, and re-run `fly secrets set`
if needed. **Unresolved as of this writing** — see also the unconfirmed
`AI_GATEWAY_API_KEY` exposure below.

Handy proof the deployment is newer than main: `/api/dev/status` returns
`pricing.cache_write_5m` and a `budgets` array, from
`server/services/llm-budget.js` — a file that exists only on the PR #6 branch.
See [[fly-deployment-outside-repo]].

Adjacent: `AI_GATEWAY_API_KEY` in the environment is a Vercel AI Gateway key
(`vck_…`), used only by `scripts/build-manager-archetypes.mjs`. Not an Anthropic
credential. It is the one exposed in a screenshot on 2026-09-18 whose revocation
was never confirmed.
