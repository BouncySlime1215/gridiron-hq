# espn-credential-ownership — TDD report

**Item:** ESPN credentials belong to a user. No code path may fetch a league
with a pair that does not belong to someone who can see that league, and a
league nobody has connected must fail loudly rather than be fetched
anonymously.

**Files owned and changed:** `server/platform/espn-credentials.js` (new),
`server/migrations/063_espn_credentials.js` (new),
`server/services/espn-draft.js`, `server/routes/espn-connect.js`,
`server/routes/espn.js`, `test/espn-credential-ownership.test.js`,
`test/espn-cookie-owner-e2e.test.js`, this document.

**PR:** #48, on `main` at `791b131`.

---

## 1. Audit — what was there

One `espn_s2`/`SWID` pair for the whole install, in `app_settings`, plus a
single `espn_connect_token` any holder could use to overwrite it. Two
independent copies of the same global-then-fallback lookup, in two files that
had drifted apart:

| Copy | File | Behaviour |
|---|---|---|
| cache-fill | `espn-connect.js:100-113` | read the global slot; if empty, took the most recently fetched league's pair **and wrote it back into the global slot** |
| read-only | `espn-draft.js:27-36` | `espnCookies()`, the same query without the write-back |

The fallback was `ORDER BY fetched_at DESC LIMIT 1` — literally "whoever synced
last".

Not hypothetical. `services/scheduler.js:27-39` carries a 2026-09-06
investigation: Nick's ESPN session was repeatedly kicked during a live draft
because the hourly roster sweep hit ESPN with the same cookies his browser was
drafting with, "because `espnCookies()` is one global lookup". That was
mitigated with a draft-window gate rather than fixed.

## 2. RED — stated on the wire, not in a return value

The first round of tests asserted on the resolver's return value. That is the
wrong altitude for this defect: the bug was never a lookup returning the wrong
answer, it was **two call sites each carrying their own copy of a lookup**. A
resolver that refuses correctly proves nothing about whether callers go through
it.

So `test/espn-cookie-owner-e2e.test.js` drives a real Express server — two
signed-in accounts, three leagues — and inspects the `Cookie` header on the way
to ESPN. The same scenario was then run against a `791b131` worktree:

| | 791b131 | this branch |
|---|---|---|
| Nick links **his own** league | `espn_s2=<guest>; SWID={2222…}` — the other account's pair | Nick's pair |
| A league no member has connected | **200**, two ESPN calls carrying that borrowed pair | **409**, zero ESPN calls |

The second row is worse than the PR originally claimed: an unconnected league
did not merely fetch anonymously, it fetched **as another account**, and
returned success.

Counting the calls is the load-bearing part. An anonymous fetch of a private
ESPN league returns 200 with a thin public payload, so "refused" and "asked
anonymously and liked the answer" are indistinguishable from a return value.

## 3. GREEN

`server/platform/espn-credentials.js` is the single place the question "whose
credentials?" is answered — deliberately single, since the defect was that
logic existing twice. Resolution order: the league's own stored pair, then a
member of that league (commissioner first, then lowest user id, so the choice
cannot change under you because someone else synced), then a throw.

`EspnCredentialsMissing` is a distinct type carrying `status: 409` rather than
a null return, because the failure it replaces was silent. 409 rather than 401:
the caller **is** authenticated, it is the ESPN connection that is missing, and
a 401 would send the client to the sign-in page for the wrong reason.

Three narrower leaks went with it, all only survivable while there was one
user: connecting stamped your cookies onto every league row with a null `swid`
including leagues you had never heard of; `GET /status` listed every ESPN
league on the install to anyone signed in; `DELETE /cookies` disconnected
everyone.

## 4. Gaps found by re-reading, not by the tests failing

Three things the first round asserted rather than exercised:

- **The consumer was never tested** — see section 2. Fixed.
- **`down()` was described in the PR body and never run.** Now executed,
  including an up→down→up round trip, because roll-back-fix-redeploy is the
  real shape of a recovery and a rollback that dropped the table without
  restoring the pair would leave an older image running and disconnected, with
  no source to re-derive a cookie pair from.
- **The migration's commissioner fallback branch** — the path taken on any
  database that never went through the loopback auth path — had no coverage.

## 5. Injection sweep

Every check was run against a deliberately broken copy. A test that stays green
under a mutation is a test that proves nothing, so a surviving injection is
treated as a defect in the test, not a pass.

| Injection | Result |
|---|---|
| baseline, no injection | 26 pass / 0 fail |
| most-recently-fetched fallback restored | **5 fail** |
| commissioner preference dropped | **1 fail** |
| `requireCredentialsForLeague` returns nulls instead of throwing | **6 fail** |
| league refresh reads the league row directly again | **3 fail** |
| per-user lookup borrows when the row is **missing** | **1 fail** |
| per-user lookup borrows when the row is **blank** | **3 fail** |
| connect token matches any account | **3 fail** |
| league's own stored pair ignored | **1 fail** |

**One injection survived on the first pass** and produced a real test: a
fallback in `credentialsForUser` for a *missing* row went undetected, because
every fixture account had a row — `reset()` nulls the columns rather than
deleting them, so "an account that has simply never connected" was never asked
for. A lookup quietly answering that with somebody else's pair would have
passed the entire file. The case is now pinned, and the injection fails.

## 6. Scope of the migration fixture, stated precisely

Migration 063's fixture rebuilds the pre-migration world — global pair, global
connect token, an owner row with the `gridiron-local-owner` subject, ESPN
league rows with memberships — which is real-shaped for every column the
migration reads. It is **not** a copy of the production database, and `up()` is
called directly rather than through `runMigrations()`; the runner path is
covered only against an empty database, as it is for every migration here.

## 7. Full suite

2,975 tests, 2,934 passed, 0 failed, 41 skipped. `npm run typecheck`,
`npm run lint`, `npm run build`, `npm run start:smoke` clean.
