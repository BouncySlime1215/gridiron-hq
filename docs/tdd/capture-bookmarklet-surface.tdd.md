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

---

## Mutation re-run at the stack tip

Re-run against **one tree**, the tip of this stack at `af7f01a`, so every row
below is measured on the same code rather than on the tree each commit had when
it was written. Each entry records the mutated file's SHA-256 before and after,
which is what proves the mutation was APPLIED: a pattern that does not match
leaves the file unchanged, and the run is then the baseline wearing a
mutation's name. Each entry names the **test title** that turned red, not the
rule it was meant to check — a mutation that lands and kills a different test is
unfinished, not a result. And each quotes the **exact before and after text**,
not a description of the edit, so the mutation can be reproduced from this file
rather than taken on trust.

Files mutated: `client/src/components/draft/SourcePill.tsx`, `client/src/index.css`, `server/routes/draft-capture.js`.

**the capture panel drops warnings again** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `8f57ddfeb920` — **RED**, 2 failing · killed by *the warning the user never saw is rendered, in the server's own words*

```diff
-          {d?.warnings?.map((w, i) => (
+          {[].map((w: string, i: number) => (
```

**the warning's stripe is restyled to --edge** (`client/src/index.css`) — APPLIED `4aabd9008a92` → `2d1c0da54fe3` — **RED**, 1 failing · killed by *the warning the user never saw is rendered, in the server's own words*

```diff
-.capture-warning {
-  flex-basis: 100%;
-  border-left: 3px solid var(--warn);
+.capture-warning {
+  flex-basis: 100%;
+  border-left: 3px solid var(--edge);
```

**the warning is reworded instead of rendered verbatim** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `e3ab37b0343b` — **RED**, 1 failing · killed by *the warning the user never saw is rendered, in the server's own words*

```diff
-className="capture-warning">{w}<
+className="capture-warning">Setup needed<
```

**the panel stops minting a key (back to the 400)** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `7169b5a38cfe` — **RED**, 1 failing · killed by *the panel mints a key, so the button is not a 400 with documentation in it*

```diff
-      const minted = await api<{ key?: string }>(`/drafts/${draftId}/ingest-key`, { method: 'POST' });
-      if (!minted?.key) throw new Error('the server did not return a key');
+      const minted = { key: '' };
```

**the key is minted but not passed to the route** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `a002269ec96c` — **RED**, 1 failing · killed by *the panel mints a key, so the button is not a 400 with documentation in it*

```diff
-`/drafts/${draftId}/capture-bookmarklet?ingest_key=${encodeURIComponent(minted.key)}`
+`/drafts/${draftId}/capture-bookmarklet`
```

**the ingest key is held in component state** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `d6588a92d1ff` — **RED**, 1 failing · killed by *the key is a credential and never reaches the screen or the state*

```diff
-      setBm({ open: true, data });
+      setBm({ open: true, data, key: minted.key } as any);
```

**the ingest key is logged to the console** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `9578dd1ade36` — **RED**, 1 failing · killed by *the key is a credential and never reaches the screen or the state*

```diff
-      setBm({ open: true, data });
+      console.log(minted.key);
+      setBm({ open: true, data });
```

**loader_url's markup is made unreachable** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `c44e64ea7f5e` — **RED**, 1 failing · killed by *every served field is rendered or named as dropped, with a reason*

```diff
-                {d.loader_url && (
+                {false && (
```

**href_dry's markup is made unreachable** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `dfb895c4d8c4` — **RED**, 1 failing · killed by *every served field is rendered or named as dropped, with a reason*

```diff
-                {d.href_dry && (
+                {false && (
```

**the re-mint warning is removed** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `10f0e5aedb27` — **RED**, 1 failing · killed by *re-opening the panel invalidates the old bookmarklet, and says so*

```diff
-                stops working. Drag the new one over it.
+                is still fine.
```

**the route stops requiring a key** (`server/routes/draft-capture.js`) — APPLIED `9954c53a04c4` → `5a345e94fee9` — **RED**, 1 failing · killed by *the panel mints a key, so the button is not a 400 with documentation in it*

```diff
-ingest_key required:
+ingest key optional:
```

**NO-OP CONTROL: a comment word changed in the capture panel** (`client/src/components/draft/SourcePill.tsx`) — APPLIED `e83ce1460b82` → `c0265ade5390` — **green — survived, as intended**

```diff
- * THE BOOKMARKLET THAT COULD NOT WORK, AND SAID NOTHING.
+ * THE BOOKMARKLET THAT COULD NOT WORK, AND SAID NOTHING (control).
```

11 mutations applied and red, 1 applied and green. The green
row is the deliberate no-op control — an edit that is real (the SHA changes) but
touches nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database, **measured on commit `6a8df0d`** — the commit this
section lands in, whose parent is `af7f01a`. The source was restored after the
mutation run and verified clean with `git status` rather than assumed clean
because the runner said so.
