---
name: fly-deployment-outside-repo
description: The live gridiron-hq.fly.dev app runs code that is not in this repository's main branch, so the checkout does not match production.
metadata:
  type: project
  modified: 2026-09-19T15:10:32.018Z
---

The platform at gridiron-hq.fly.dev is genuinely live and running, but it was
built and deployed from an earlier cloud session on the same environment,
before Projects existed. That work is not in `main` of
https://github.com/BouncySlime1215/gridiron-hq.

Verified against `main` at commit `ffe4e72` (2026-09-15) on 2026-09-19:

- No `fly.toml`, no `Dockerfile`, and no occurrence of "fly.dev", "fly.io" or
  "flyctl" anywhere in the repository.
- `scripts/build-manager-signals.mjs` does not exist (referenced by bring-up plans).
- No league chat feature at all: no `/api/league-chat/upload` route, no client
  page, no Apple Messages or `chat.db` code anywhere in `server/`, `client/`,
  `scripts/` or `mac/`.

These exist in the deployed code, not here. **Consequence: files read in this
checkout are not the files running in production.** Resolve this before making
any change intended to affect the live app. See [[fly-network-access-resolved]].

What does match the repo and is safe to rely on:
- `scripts/bootstrap-data.mjs` boots its own server on a free port and drives
  the sync routes over HTTP, authenticating via the loopback-only provisioner.
- `/api/auth/local-session` at `server/routes/local-auth.js:57` answers only a
  direct loopback caller with no forwarding headers, so a `fly ssh console`
  call against `127.0.0.1:5177` satisfies it.
- The ESPN bookmarklet posts back to whichever host served it
  (`server/routes/espn-connect.js:26`), so it works against any host.
