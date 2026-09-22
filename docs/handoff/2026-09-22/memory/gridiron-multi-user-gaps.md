---
name: gridiron-multi-user-gaps
description: What in gridiron-hq still assumes exactly one user after Google sign-in landed — ESPN cookies, the Anthropic key and the missing encryption helper, audited 2026-09-19.
metadata:
  type: project
  modified: 2026-09-19T16:31:48.480Z
---

Audited 2026-09-19 on `claude/project-thread-3ldl77-docs`. That branch is the
deployed code: `git diff` against `cursor/betting-model-audit-fixes-1c85` over
`server/ client/ scripts/ test/ package.json` is EMPTY. It is the right base
for new work, not `main`.

## STILL install-wide — the real blockers before a second person uses it

1. **ESPN cookies: one credential slot for the whole install.** THE first
   follow-up after #14 — re-read 2026-09-19 20:50, worse than first audited.
   Two stores: `leagues.espn_s2`/`swid` per league AND a global `app_settings`
   pair. The WRITE (`espn-connect.js:251`) is gated, but by
   `cookieWriteAuthorized` = "any session, or the per-install token" — which
   before #14 meant Nick and after #14 means any invited account. (An earlier
   note here calling it unauthenticated was WRONG.)
   The read at `espn-connect.js:100-113` is the dangerous half: it is a CACHE
   FILL, not a read. Empty global pair → `ORDER BY fetched_at DESC LIMIT 1`
   from `leagues` → writes that league's cookies INTO the global slot. So the
   pair changes to another person's credentials with nobody connecting
   anything; one sync of their league does it. No error, no log, right-looking
   boards computed from the wrong ESPN account.
   Must land BEFORE the first invite goes out. Fix shape: give the credentials
   an owner, delete the global pair and its cache-fill, make "no cookies for
   this user" fail loudly instead of borrowing a stranger's.
2. **There is NO encryption-at-rest helper anywhere in the codebase.** Grep for
   `createCipheriv`, `aes-256`, `encrypt` — zero hits outside node_modules. The
   Phase 11 plan says per-user secrets are "encrypted at rest, same pattern as
   ESPN cookies". That pattern does not exist; the plan is wrong there.
3. **The Anthropic key is global**, resolved in `claude.js:26` from env or
   `app_settings`, no `userId` anywhere. Plan item 4 wants bring-your-own-key
   per user. Any `model:*` holder's `PUT /api/dev/key` reconfigures everyone,
   and `ai_usage` has no `user_id`, so there is no attribution.
4. **Tables with no owner column:** `manager_profiles` (PK `league_id,
   roster_id` — defensible now league access is scoped), `saved_prop_tickets`,
   `decision_recommendations`, `nfl_user_bets`, `ai_usage`. `manager_notes`,
   `entity_map`, `coach_threads`, `tactic_exposure_log` — all named in the plan
   — **do not exist yet**; they need `user_id` from day one.
5. **`espn_connect_token` is one per install**; any holder can overwrite the
   global cookie pair. Folded into item 1.

## Facts worth not rediscovering

- `model:*` in `model_permissions` IS the platform-admin grant
  (`legacy-access.js:27`). Granted in exactly two places, neither an HTTP route.
- `modeling/authz.js:20` tests `principal.role !== 'admin'` but `modelPrincipal`
  never sets `role` — dead clause today, latent bypass if anything populates it.
- Migrations and the runner's backup trap: [[gridiron-migration-runner]].
- A test importing routers must `await runMigrations()` at top level BEFORE the
  imports — several routers prepare statements at import time.

What was fixed is in [[gridiron-google-sign-in]]. See also
[[fly-deployment-outside-repo]].
