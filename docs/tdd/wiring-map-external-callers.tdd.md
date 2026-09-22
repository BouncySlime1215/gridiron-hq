# A route can have no caller here and still be called

RED — this commit's test cases 43-45 · GREEN — this commit · raised by the Google sign-in thread

## The five questions

- **Is it well built?** It derives rather than declares. The Google sign-in thread
  proposed a category with entries in it; the evidence turned out to be in the
  repository already, so there is nothing to keep up to date.
- **Is it based on stats, or made up?** Measured: 405 → 401, and every one of the
  four rows moved was traced to the exact line that calls or publishes it.
- **How do we know?** Three injections run and shown to fail, plus the ordering
  bug below, which measurement caught rather than reasoning.
- **Should this point anywhere else on the platform?** Yes — every provider
  callback and webhook on the platform reads the same way, which is why the
  Google sign-in thread raised it as a category rather than one annotation.
- **How does it unify?** `route-no-caller` now answers one question ("nothing
  reaches this") instead of three, and the other two get their own row with the
  reason on it.

## The ask, and the half of it that was already done

> *"`/api/auth/google/start` is reached from the client by an href, not a fetch, so a
> fetch-shaped sweep misses it too, and every provider callback or webhook on the
> platform reads the same way."*

The href half **was already handled** and the check confirms it: `/api/auth/google/start`
is not in the findings, because the gate added earlier reads the whole client text
rather than parsed `api(`/`fetch(` calls, and `SignIn.tsx:51` contains the literal.
That was true of the old rule, not the current one.

The external half is real. `GET /api/auth/google/callback` was the **top in-scope row**
of `route-no-caller` at w111. Google calls it.

## It does not need declaring

The server publishes the path itself:

```
google-auth.js:42   return `${publicOrigin(req)}/api/auth/google/callback`;
```

So `outboundUrlPaths()` looks for a path literal sitting directly after an origin —
an interpolation it is appended to, or a written-out absolute URL.

## Two facts, kept apart

The first cut called all of them "published", which is wrong in the way that matters.
Three of the four routes it suppressed are dialled by **scripts in this repository**:

```
POST /api/league-chat/upload    scripts/chat-sync.mjs:351     (npm run chat:sync)
GET  /api/auth/tunnel-url       scripts/launcher.mjs:247
POST /api/auth/tunnel-url       scripts/tunnel.mjs:54
```

`POST /api/league-chat/upload` was the **number one fantasy row** of the list. It is
not dead; the rule had only ever scanned the client tree, so a script calling a route
over HTTP was invisible to it. That is a second blind spot, found by building the
first fix.

"A maintenance script calls this" and "Google calls this" lead a reader to opposite
conclusions about whether a route can go, so the kind survives into the output:

```
GET  /api/auth/google/callback  the server publishes this path outward, so the caller
                                is a provider or a webhook
POST /api/league-chat/upload    a script in this repository dials it over HTTP
```

Neither is silently dropped. They leave `route-no-caller` and appear as
`route-called-from-outside-the-app` with the reason attached.

## The ordering bug, caught by measuring rather than by thinking

The first wiring put the outbound check **before** the client check, and three extra
routes appeared in the new category:

```
GET /api/teams                 "no page calls it; a script dials it"
GET /api/model/setup-status    same
GET /api/trades/dvp            same
```

All three **are** called by pages. A script dialling a route says nothing about
whether a page also does, so the client check has to run first or the map states a
falsehood with a reason attached to it — worse than the bare row it replaced. Fixed;
those three now produce no row at all, which is the correct answer.

## Injections (run, and shown to fail)

| Injection | Result |
|---|---|
| `kindAt` always returns `published` | `not ok 44` |
| `kindAt` always returns `called` | `not ok 43`, `not ok 44` |
| lookbehind for the dialer name instead of walking back to the call | `not ok 44` |
| drop the still-open check on the enclosing call | `not ok 44` |

**The fourth one took two attempts and is the reason it is listed.** Replacing the
ternary alone changed nothing, because the fixture exits at the earlier
`return 'published'` and never reaches it — an injection into an unreachable branch
proves nothing, and the first version of this file claimed it as a pass. Dropping the
still-open check then failed nothing either, so the check was genuinely untested. The
case that pins it is a dialer that has already **closed**:

```js
outboundUrlPaths('await fetch(z); return `${ORIGIN}/api/a/b`;')  // published, not called
```

That fixture also took two attempts. Written with `${publicOrigin(req)}` it still
proved nothing, because the nearest preceding `(` is then `(req)` rather than
`fetch(`, so the guard was never reached that way either. The interpolation has to
contain no call of its own for the walk-back to land on the closed `fetch(`.

## Measured effect

```
route-no-caller                     405 → 401
route-called-from-outside-the-app   4 rows, each traced to its calling line
```

## What this does not fix

A webhook whose URL is typed into a provider's dashboard and never written down here
is still invisible, and always will be — there is no evidence in the repository to
find. That case needs a declaration, and none exists today, so none was added.
