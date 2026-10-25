---
name: gridiron-google-sign-in
description: How Google sign-in and real accounts were built for gridiron-hq on 2026-09-19 — the design decisions, the env vars Nick must set, and what merging it changes.
metadata:
  type: project
  modified: 2026-09-19T16:36:16.238Z
---

Built 2026-09-19 on branch `claude/project-thread-n4052e`, PR #14, based on
`claude/project-thread-o3wt2p-reentry` (PR #17's branch, retargeted 20:26Z
from `claude/project-thread-3ldl77-docs`; the docs branch is an ancestor of
it, so this still sits on the deployed stack and NOT on `main`). Phase 11 item 1 of the fantasy master plan.

## Design decisions worth not re-litigating

- **No new dependencies.** OIDC written directly on `node:crypto` in
  `server/platform/google-oidc.js`: auth-code flow with PKCE, RS256 against
  Google's JWKS, iss/aud/azp/exp/iat/nonce/email_verified, `alg` pinned by
  name. `passport` would have been the biggest thing in a 3-dep tree.
- **The session token never travels in a URL.** The callback sets a one-time
  `HttpOnly; SameSite=Lax; Secure` cookie scoped to `/api/auth`; the SPA POSTs
  `/api/auth/google/complete` to swap it for the bearer token it already uses.
- **Per-attempt secrets live in SQLite** (`auth_login_flows`, digests only),
  so a Fly restart mid-sign-in does not strand it.
- **Nick's Google account ADOPTS the existing `gridiron-local-owner` user row**
  on first sign-in (`server/platform/account-link.js`). That is why no data
  migration is needed: every `league_memberships` row, the `model:*` grant and
  all five ESPN leagues hang off exactly that user id. Adoption only happens
  while that row has no Google identity, so nobody else can inherit it.
- **Invite-only.** Refused before any row is written.
- Sessions are still `auth_sessions` rows: a second way to establish
  `req.auth.userId`, not a second mechanism. `local-auth.js` is untouched.

## What Nick has to do himself (nothing works until he does)

Full steps in `docs/GOOGLE-SIGN-IN-SETUP.md` in the repo. Short version:
create an OAuth 2.0 Web application client at
console.cloud.google.com/apis/credentials with authorised redirect URI exactly
`https://gridiron-hq.fly.dev/api/auth/google/callback`, then one command:

```
fly secrets set GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
  GRIDIRON_ADMIN_EMAIL=<his google address> \
  GRIDIRON_PUBLIC_URL=https://gridiron-hq.fly.dev -a gridiron-hq
```

Fly secrets are a separate store from the project env-vars box; the box does
not reach the deployment. `GET /api/auth/providers` prints the redirect URI it
expects — trust that over the Console.

Until both OAuth secrets are set the app reports `google: false`, draws no
button, and behaves exactly as before. Safe to merge unset.

New migration is `062_google_identity_and_invites` (`user_identities`,
`auth_invites`, `auth_login_flows`). It runs on boot, i.e. on the restart that
`fly secrets set` causes.

What is still single-user is in [[gridiron-multi-user-gaps]].

## The /api/health reconciliation with #17 (2026-09-19 20:26Z)

#14 and #17 both added `GET /api/health`. Git merges them with no conflict
into a file registering the path twice; Express answers with whichever came
first. #17's wins — it reads the database and 503s, which is what fly.toml's
new HTTP check needs; #14's was an unconditional 200. Mine is deleted.
#17 extracted theirs to `server/platform/health.js` and dropped
`error.message` from the 503 body (commit 63e0886) after #14 flagged the
disclosure. **Take #17 at or after 63e0886 or the leak comes back.**

`test/health-route-single.test.js` asserts the source registers exactly one
health path. It scans text, not responses, on purpose: a request only ever
reaches the first registration, so a duplicate is invisible over HTTP.

`start.mjs`, `tunnel.mjs`, `bootstrap-data.mjs` now assert `probe.ok` and a
JSON `ok` of true; they used to read any response, including a start-up 503,
as "up". Same healthy-looking-and-not-working shape as everything else.
