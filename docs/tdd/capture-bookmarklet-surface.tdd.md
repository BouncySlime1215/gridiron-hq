# The bookmarklet that could not work — RED/GREEN evidence

`test/capture-bookmarklet-surface.test.js`,
`client/src/components/draft/SourcePill.tsx`.

Retroactive RED by mutation. No server file was changed; the route was already
serving everything needed.

## Two failures, both silent

`GET /drafts/:id/capture-bookmarklet` (`routes/draft-capture.js:73`) answers
with nine fields. The panel destructured **one**, `href`, and dropped the rest.

The one that mattered is `warnings`, which carries, in the server's own words:

> no tunnel is registered; falling back to http://localhost:… The https ESPN
> page will block an http script (mixed content) — run `npm run tunnel` first.

A user dragged a bookmarklet to their bookmarks bar, opened their ESPN draft
room, clicked it, and nothing happened. The app had been told exactly why and
threw it away. Draft night is the least recoverable moment in this product to
discover that.

The second failure is worse and was hiding behind the first. The route
**requires** `?ingest_key=…`, minted by `POST /drafts/:id/ingest-key`. The panel
never requested one, so every click returned 400 and the catch printed the
route's own parameter documentation at the user:

> Bookmarklet unavailable — ingest_key required: pass ?ingest_key=… obtained
> from POST /api/drafts/:id/ingest-key

That is an API error message as a user interface. The panel now mints the key
and passes it.

## The key is a credential

`mintIngestKey` returns the raw key once. It is put into the one call that
spends it and nowhere else: not into component state, not into a log, not onto
the screen. What is rendered is the `href` the server built with it, which is
what an href is for. Two assertions and two mutations hold that line, because
"read a value's presence, never its content" is only a rule if something fails
when it is broken.

Minting also **replaces** the draft's previous key (`draft-ingest.js:46`), so a
bookmarklet already on the bar stops working the moment this panel is opened
again. The panel says so. Nothing in the code said it before.

## Served-field decisions

Every field, render or drop, with the reason in the component header:

| field | decision |
|---|---|
| `href` | rendered — the draggable link |
| `warnings` | rendered, each one, **verbatim** |
| `tunnel_up` | rendered, as the state the warning is about |
| `origin` | rendered — naming the origin is what makes the warning actionable |
| `loader_url` | rendered — opening it in the ESPN tab is the one check a user can run when the click does nothing |
| `href_dry` | rendered as a second link that captures nothing; finding out before the draft is the whole value |
| `href_bytes` | rendered as a plain count, **with no threshold asserted** — this file does not know any browser's real bookmarklet limit and inventing one would be a number with nothing behind it |
| `draft_id` | dropped — it is the id this component was handed |
| `key_source` | dropped — `'query'` by construction now that this panel always passes the key that way |

The warning is rendered word for word rather than reworded. The server's
sentence already names the cause and the command that fixes it; a second
version here would be a second place for the claim to drift.

## Three assertions that proved nothing, and how they were caught

The first draft passed 6/6 and three of its mutations came back **green**:

1. *the warning is restyled as a quiet note* — the CSS assertion was
   `/var\(--warn\)/` over the whole rule. Turning the left stripe to `--edge`
   left `color: var(--warn)` behind, so it matched. Now the stripe and the
   colour are asserted separately.
2. *`loader_url` is dropped* and 3. *`href_dry` is dropped* — the served-field
   assertion checked that the identifier appeared **somewhere** in the file.
   Replacing the guard with `{false && (` left the identifier sitting inside a
   block that never renders. Each field is now pinned to the guard that decides
   whether its markup runs, plus an assertion that nothing in the returned
   markup is switched off by a literal.

This is the same lesson as `[[tests-that-slice-on-a-common-token]]`, reached
from a different direction: an assertion that watches a *symbol* rather than a
*decision* passes whatever the decision becomes.

## Mutation runs

Baseline: 6 tests, 6 pass, 0 fail. All eleven red.

| Mutation | Result | Caught by |
|---|---|---|
| the panel drops `warnings` again | 4 pass / **2 fail** | the warning is rendered; served-field |
| the warning's stripe is restyled to `--edge` | 5 pass / **1 fail** | the warning is rendered |
| the warning is reworded instead of rendered verbatim | 5 pass / **1 fail** | the warning is rendered |
| the panel stops minting a key (back to the 400) | 5 pass / **1 fail** | the panel mints a key |
| the key is minted but not passed to the route | 5 pass / **1 fail** | the panel mints a key |
| the key is held in component state | 5 pass / **1 fail** | the key never reaches the screen or the state |
| the key is logged to the console | 5 pass / **1 fail** | the key never reaches the screen or the state |
| `loader_url`'s markup is made unreachable | 5 pass / **1 fail** | served-field |
| `href_dry`'s markup is made unreachable | 5 pass / **1 fail** | served-field |
| the re-mint warning is removed | 5 pass / **1 fail** | re-opening invalidates the old bookmarklet |
| the route stops requiring a key | 5 pass / **1 fail** | the panel mints a key |

The last one is a guard on the *other* side: if the route ever drops its key
requirement, the panel's minting becomes a pointless round trip that also
invalidates the user's working bookmarklet, and this fails so someone looks.
