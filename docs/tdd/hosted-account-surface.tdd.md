# TDD evidence (retroactive): the app stops asserting which install it is

**What this is.** PR #46 (head `aaaefde`) added
`client/src/components/AccountPanel.tsx` (233 lines) and
`client/src/state/deployment.ts` (70 lines), changed `App.tsx`,
`EspnConnect.tsx`, `EspnConnectGate.tsx` and `Settings.tsx`, and committed
three test files: `test/account-surface-live.test.js` (8),
`test/deployment-copy-is-asked-not-asserted.test.js` (6) and
`test/invite-surface-exists.test.js` (6).

There is no RED commit. The defect was copy already on screen — the sidebar
told every hosted visitor "data stays on your Mac" — found by reading the
strings against what the server actually answers, not from a specification. A
RED commit written afterwards would prove only that a test can be written to
fail against code already known to be wrong.

**How the retroactive RED was shown.** Each guarded rule was reverted in the
shipped source — one mutation at a time, a real edit, run, then restored.
Run at `aaaefde` on 2026-09-20.

| Guarded rule | Mutation | Test that failed |
|---|---|---|
| No flat "your Mac" claim anywhere | App.tsx's branch replaced by the old flat line | copy 1, 2, 3 |
| A failed probe is "unknown", never "local" | `.catch(() => null)` → `.catch(() => ({local: true, …}))` | copy 6 |
| Pairing is offered only where its endpoints work | `{deployment?.local && <PhoneAccess />}` → `<PhoneAccess />` | copy 5 |
| The credential claim is conditional in both places | EspnConnect's branch collapsed to "only on this machine" | copy 2, 4 |
| The panel is mounted, not merely written | `<AccountPanel />` removed from Settings.tsx | invite 2 |
| Re-enabling does not resurrect old sessions | the session revoke removed from the disable route | live 5 |
| A disabled account's browser is out | **both** the revoke and `disabled_at IS NULL` removed | live 4, 5 |

7 mutations that turned tests red. One that did not, below, and it is the
most useful line in this file.

## The mutation that changed nothing, and what it means

`server/platform/auth.js:22` ends its session lookup with
`AND u.disabled_at IS NULL`. Removing that clause alone turns **nothing**
red:

```text
### g6 (platform/auth.js: the disabled flag ignored)
# tests 8
# pass 8
# fail 0
```

That is not a hole in the tests. It is two independent mechanisms producing
one outcome, and the mutations separate them:

- **g6**, only the `disabled_at` guard removed: 0 failures. Disabling still
  ends the browser session, because `google-auth.js:328` revokes every live
  session in the same request.
- **g7**, only the revoke removed: live test 5 fails, `200 !== 401`. Test 4
  still passes, because while the account is disabled the `disabled_at`
  guard blocks the lookup on its own.
- **g8**, both removed: live tests 4 **and** 5 fail, `200 !== 401` each.

```text
### g7 (google-auth.js: only the session revoke removed)
not ok 5 - turning it back on does not silently restore the old sessions
  error: |-
    200 !== 401
# tests 8
# pass 7
# fail 1

### g8 (BOTH removed)
not ok 4 - turning an account off ends the session already in that browser
    200 !== 401
not ok 5 - turning it back on does not silently restore the old sessions
    200 !== 401
# tests 8
# pass 6
# fail 2
```

So **test 4 pins the outcome, and test 5 is what pins the revoke.** Test 5 is
the discriminating one because after re-enabling, `disabled_at` is null
again and only the revoke can still hold the old token dead. Reading test 4
alone as evidence that the revoke works would have been wrong, and this is
exactly the "verify the consumer, not the producer" rule applied to the
tests themselves.

`server/platform/auth.js` and `server/routes/google-auth.js` belong to the
Google sign-in thread, not to this PR. All three mutations were applied and
restored, never committed.

## Why the live tests exist at all

An earlier version of this surface was tested by reading its source text.
That is fine for copy — a string either says the conditional thing or it does
not — and it is worthless for authorisation, because the thing being claimed
is what a running server does with a request. So
`test/account-surface-live.test.js` boots a real Express listener on an
ephemeral port and makes real HTTP calls with real tokens. The offline guard
exempts localhost precisely so a test can do this.

Live test 2 is the one that would be easy to get wrong: an anonymous caller
must get **401, not 403**, or the guards are in the wrong order and the app
is telling strangers which endpoints exist.

## Mutation output, pasted

### g1 — the flat Mac line restored in the sidebar

```text
not ok 1 - the flat "your Mac" claim is gone from every user-facing string
  error: 'client/src/App.tsx still asserts the Mac to every reader'
not ok 2 - every file that claims a location asks the server which install this is
  error: 'client/src/App.tsx imports the answer but does not branch on it'
not ok 3 - the hosted branch says the true thing, not a softened version of the Mac one
  error: 'the sidebar names where hosted data actually is'
# tests 6
# pass 3
# fail 3
```

Test 2 catching it is the point: importing `useDeployment` and not branching
on it is the shape a half-done fix takes, and it looks correct in a diff.

### g2 — a failed probe defaulting to local

```text
not ok 6 - an unanswered probe is never treated as local
  error: 'a failed probe resolves to unknown'
# tests 6
# pass 5
# fail 1
```

Every default here is a claim about where someone's data is, so the probe
resolves to null and the copy renders nothing rather than guessing.

### g3 — pairing offered on the hosted app

```text
not ok 5 - phone pairing is only offered where its endpoints work
  error: 'the pairing card is gated on the deployment actually being local'
# tests 6
# pass 5
# fail 1
```

### g4 — the credential claim made flat again

```text
not ok 2 - every file that claims a location asks the server which install this is
  error: 'client/src/components/EspnConnect.tsx imports the answer but does not branch on it'
not ok 4 - the credential claim is conditional in both places that make it
  error: 'the Settings card has a hosted branch'
# tests 6
# pass 4
# fail 2
```

This is the worst place in the app to be confidently wrong: the reader is
handing over a session credential while being told where it goes.

### g5 — the panel written but not mounted

```text
not ok 2 - the panel is actually mounted, not merely written
  error: 'and renders it'
# tests 6
# pass 5
# fail 1
```

## What this does not claim

No live read backs this. The account tests run against a real server, but a
real server booted in-process against an isolated temp SQLite database — not
the deployed app, and nothing here is a measurement of production.

Nothing here proves Google sign-in works end to end. The live tests mint
sessions directly; the OAuth exchange belongs to #51 and to the morning's
ten-minute check once the client credentials exist.
