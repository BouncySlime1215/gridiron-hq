# uncalled-surface-audit — TDD report

**Item:** The wiring map's "route nothing calls" and "producer with no caller"
findings across the files this thread owns. Each one resolved to a caller that
exists, a caller a sweep cannot see, or a surface that was never built — and
two of them turned out to hide a real hole.

**Files owned and changed:** `server/routes/espn.js`,
`server/platform/providers.js`, `server/platform/provision-auth.js`,
`server/routes/google-auth.js` (comment only, earlier commit),
`scripts/backfill-news-entities.mjs` (new), `package.json` (one script entry),
`test/news-entity-backfill.test.js` (new), `test/google-sign-in.test.js`,
this document.

**Branch:** `claude/project-thread-n4052e-league-sync-creds-hold`. No PR; no
database is touched by anything here.

---

## The five questions

**Is this well built?** The two code changes are a script that calls an
existing repaired function, and a test. Neither adds a code path that did not
already exist; both give an existing one a caller it was missing.

**Is this based on stats, or is it made up?** Neither — it is a reachability
audit, and every claim below is a grep or an executed test, quoted with its
line number. Where a claim could not be checked without the live database, it
is marked as unchecked rather than asserted.

**How do we know?** Six mutations of `backfillNewsEntities`, each proved
applied by its own diff, are all caught. Two mutations of the session query
were run against the suite as it stood: one was caught, one survived, and the
survivor is the finding.

**Should this data be pointed anywhere else on the platform?** Yes, and that
is the largest result here: eight working auth routes have no screen. Their
contract is in §4 for the approved redesign to wire.

**How does it unify?** It gives the wiring map a category it was missing —
callers that are not in the repository — so the same sweep stops re-reporting
an operator's shell and Google's redirect as dead code.

---

## 1. What the sweep reported, and what was actually true

| Reported | Actually |
|---|---|
| `routes/espn.js` `/team-changes` — route nothing calls | True. Serves `player_team_changes`, which two real services read (`nfl-preseason-blend.js:223`, `nfl-roster-strength.js:188`). No screen shows it. |
| `routes/espn.js` `backfillNewsEntities` — producer with no caller | **True, and it mattered.** Zero references anywhere, tests included. Fixed below. |
| `platform/providers.js` — imported by nothing | True but not dead: `modeling/candidates.js:11` and `:30` name this module as the place a weather provider would be wired, and the user-facing "weather unavailable" message points at it. |
| `platform/provision-auth.js` — imported by nothing | Category error. It is a CLI script (`node server/platform/provision-auth.js --subject …`, its own line 5). The caller is a person at a terminal. |
| `routes/google-auth.js` — 8 uncalled routes | True. All eight are the signed-in and admin surface; none is dead. §4. |
| `revoked_at` / `disabled_at` read live, written nowhere | **False as stated.** Written at `google-auth.js:259`, `:265`, `:331`, `:334`. The true form: every writer sits inside one of those eight unreachable routes. |

## 2. The producer with no caller

`backfillNewsEntities` (`routes/espn.js:215`) repairs `news_items` rows that
ESPN's news pull inserted before it started calling `extractEntities` — rows
with `entities_json` NULL, which produce no typed claim however good the
extraction rules are. The ingest side was fixed; the backlog it names can only
be fixed by running this function, and nothing could run it.

It now has `scripts/backfill-news-entities.mjs`, following the existing
`backfill-prop-quote-reconcile.mjs` convention, and `npm run
backfill:news-entities`. Deliberately a script, not a scheduler step: it is a
repair for rows written before a fix, so it converges.

**Unchecked:** how many rows are still NULL on the live database. That needs a
read this thread is not taking tonight. The script prints the before and after
counts, so the first run answers it.

### RED — seven new tests, six mutations, all caught

`test/news-entity-backfill.test.js` is the first thing that has ever executed
this function. Injection rather than a RED commit is the right instrument
here: the function already existed and was already correct, so there is no fix
to withhold, and a RED commit would be theatre. A RED commit is preferred
wherever the *code* is new; these guards predate anyone testing them.

Each row records the file's SHA-256 before and after, because a pattern that
does not match leaves the file unchanged and the run is the baseline wearing a
mutation's name. Each row also names the one test it must turn red: an
injection that lands but kills a different test is unfinished, not a result.
The last row is a deliberate control whose pattern is not in the file — it is
what shows the verification can fail.

| Mutation | Verification | Result | Fails | Named test red? |
|---|---|---|---|---|
| stop filtering to unfilled rows | APPLIED `253aa248d291` → `19c8c54cdba5` | RED | 4 | yes |
| stamp the run time instead of the story date | APPLIED `253aa248d291` → `64bc510d4886` | RED | 1 | yes |
| overwrite an existing `published_at` | APPLIED `253aa248d291` → `80229498e36a` | RED | 1 | yes |
| count every row as having resolved a player | APPLIED `253aa248d291` → `fefb6875df12` | RED | 1 | yes |
| leave a no-match story NULL instead of answering it | APPLIED `253aa248d291` → `37fc2751be04` | RED | 5 | yes |
| report success without writing anything | APPLIED `253aa248d291` → `3f36ef603f58` | RED | 7 | yes |
| **CONTROL** — pattern not in the file | **NO-OP — pattern not found** | — | — | — |

6/6 caught by the test that names them; the control reported NO-OP and ran
nothing. Source restored and verified clean afterwards.

The third row is a test I did not have until the sweep asked for it: the
original cases covered a row with both columns already set, which is skipped
entirely, but not a row with `entities_json` NULL and `published_at` already
present — the only row on which `COALESCE(published_at, ?)` does any work.

## 3. The session guard that had no test

`platform/auth.js:21-22` refuses a bearer token whose session is revoked or
whose user is disabled. Both were deleted, one at a time, and the suite as it
stood was run against each.

Both runs are the whole suite against the code as it stood, from worktrees
restored to `HEAD` with the new case absent:

| Guard deleted | Suite as it stood | Verdict |
|---|---|---|
| `s.revoked_at IS NULL` | 2,976 tests, 2,934 pass, **1 fail** — "logout revokes only the session that was used" | covered |
| `u.disabled_at IS NULL` | 2,976 tests, 2,935 pass, **0 fail** | **not covered by anything** |

Deleting the disabled guard from the session query breaks nothing, anywhere.
(A first attempt at this measurement was thrown away: a test file was
overwritten while the run was in flight, so the number would have been
meaningless.)

The disabled guard survived because the test named for it —"disabling an
account revokes the sessions it already holds" — passes either way: disabling
also revokes that account's live sessions (`google-auth.js:334`), so
`revoked_at` catches the token first and the disabled branch never decides
anything.

That guard is not redundant. `platform/provision-auth.js` inserts an
`auth_sessions` row directly for any user id an operator names and never looks
at `disabled_at`. For such a token, this guard is the only thing between a
disabled account and working access.

**RED:** the new case, `'a live, unrevoked session belonging to a disabled
account is still refused'`, builds that state directly and asserts the session
is unrevoked and the user disabled *before* the request, so it cannot
accidentally re-assert the other guard. Both guards now die by the test that
names them:

| Mutation | Verification | Result | Fails | Named test red? |
|---|---|---|---|---|
| drop the revoked-session guard | APPLIED `b816ff37cf3c` → `ce0023cd8de9` | RED | 1 | yes |
| drop the disabled-account guard | APPLIED `b816ff37cf3c` → `9afb499a0669` | RED | 1 | yes |
| **CONTROL** — pattern not in the file | **NO-OP — pattern not found** | — | — | — |

The general lesson, worth more than this one guard: **a guard that a stronger
guard shadows on every tested path is not redundant if any writer bypasses the
stronger one.** The test has to build the bypassing state directly, because no
path through the product reaches it.

## 4. Eight routes, no screen

None of these should be deleted; all eight are the surface a signed-in owner
and an administrator need, and `POST /invites` is what the morning plan uses
to invite the Transfer portal league. Admin means the persisted `model:*`
grant (`legacy-access.js:24`), not a header or a role claim.

| Method | Path | Request | Response | Who |
|---|---|---|---|---|
| GET | `/api/auth/session` | — | `{authenticated, account}` | signed in |
| POST | `/api/auth/logout` | — | `{ok}` | signed in |
| POST | `/api/auth/logout-all` | — | `{ok}` | signed in |
| GET | `/api/auth/invites` | — | array: `id, email, note, created_at, expires_at, accepted_at, revoked_at, accepted_by` (200 max) | admin |
| POST | `/api/auth/invites` | `{email, note?, expires_in_days?}` | 201 invite row; 400 bad address; 409 already open | admin |
| DELETE | `/api/auth/invites/:id` | — | `{ok}`; 404 unknown; 409 already accepted | admin |
| GET | `/api/auth/accounts` | — | array: `id, display_name, email, disabled_at, created_at, last_login_at, leagues, google_linked, admin` | admin |
| POST | `/api/auth/accounts/:id/disabled` | `{disabled}` | `{ok, disabled}`; 404 unknown; 409 own account | admin |

`account` is `accountSummary` (`account-link.js:155`): `id, display_name,
email, avatar_url, admin, providers[], leagues, created_at, last_login_at`.

Two consequences worth naming for whoever builds the screen. A signed-in user
currently cannot sign out at all — `/logout` works and nothing calls it.
Disabling is the only way to remove someone: `DELETE /invites/:id` returns 409
on an accepted invite and says so.

## 5. Served and not rendered

`/google/complete` returns `{token, expires_in_days, account}` and the client
reads `token` alone (`SignInComplete.tsx:29`); `/local-session` returns
`{token, expires_in_days, leagues}` and `api.ts:37` likewise. `account` is
exactly what a settings header needs, so the answer is render, not stop
serving — left for the redesign rather than trimmed now.

## 6. Full check

`npm run check` — typecheck, lint, suite, build, start:smoke — recorded with
the commit.
