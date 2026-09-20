# Six unreachable client files — RED/GREEN evidence

`test/deleted-pages-stay-deleted.test.js`.

Retroactive RED by mutation, the shape `docs/tdd/week2-numbers.tdd.md` set.

## What was deleted, and why it needed a test

`Edge.tsx`, `Model.tsx`, `Projections.tsx`, `Rankings.tsx`,
`components/StaleBanner.tsx` and `features/model-lab/ModelRegistryPanel.tsx`.
No route reached them and no file imported them.
`docs/EXISTING-SYSTEMS-INVENTORY.md:192` has listed them as "never used" the
whole time. Listing a thing is not deleting it, and a file that ships in the
repository reads to the next person as a feature that exists.

The test is not ceremony. On 2026-09-16 nine tabs were deleted deliberately
(commit 1694694) and the nav is eight destinations. A deleted page that quietly
comes back is the regression that rule exists to prevent, and nothing else in
the suite would have noticed.

## The palette was still advertising two of them

`/rankings` and `/projections` were rows in `DEEP_DESTINATIONS`, reading "Your
rankings and tiers" and "Weekly and rest-of-season projections". Both routes
redirect to League Hub, which has neither view. `navigation.ts` already called
them "the weakest of those" in its own comment.

That is the same defect the comment above it describes — the palette sending a
user somewhere that does not have what the row named — in a politer form: the
user arrives somewhere real and still does not find it. The rows are gone.

**The routes stay.** `/rankings` and `/projections` still redirect, so an old
bookmark resolves. What is gone is the app offering them by name. The test
asserts both halves, because deleting the redirect as well would break
bookmarks and would look like tidying.

## A guard that could never fail, caught by its own mutation run

The first draft of "nothing routes to a deleted page" built its pattern as

```js
new RegExp(`import\\\\('\\\\./pages/${name}'\\\\)`)
```

which is double-escaped into a pattern matching a literal backslash. It can
never match anything. The mutation that re-added the lazy import to `App.tsx`
came back **GREEN** — 4 pass, 0 fail — and the test looked exactly as healthy
as it does now.

It is rewritten with plain string checks, and it now walks the whole client
tree rather than `App.tsx` alone, with an assertion that the walk found files
at all so it cannot pass vacuously. This is the third instance of
`[[tests-that-slice-on-a-common-token]]` in this stack; the mutation run is
what tells a real guard from a decorative one, every time.

## Mutation runs

Baseline: 4 tests, 4 pass, 0 fail.

| Mutation | Result | Caught by |
|---|---|---|
| `Rankings.tsx` is recreated | 3 pass / **1 fail** | the six files are gone |
| `App.tsx` lazy-imports `./pages/Rankings` again | 3 pass / **1 fail** | nothing imports or renders a deleted page |
| `App.tsx` renders `<Rankings />` on `/rankings` | 2 pass / **2 fail** | that, and the bookmark redirect |
| another page imports `StaleBanner` | 3 pass / **1 fail** | nothing imports or renders a deleted page |
| the `/rankings` bookmark redirect is dropped | 3 pass / **1 fail** | the palette test's second half |
| the palette re-advertises `/rankings` | 3 pass / **1 fail** | the palette no longer advertises it |
| a ninth destination appears in the sidebar | 3 pass / **1 fail** | the nav is still eight |

Six of the seven were run against the first draft as well; the second is the
one that exposed it.

## One file is now orphaned on purpose

`client/src/components/StatTable.tsx` was imported only by `Rankings.tsx` and
is now imported by nothing. It is deliberately **not** deleted in this change:
it is being rebuilt as the design system's table component, and deleting it in
the same commit that deletes its only caller would make that a new component
rather than a replacement. It is the one knowingly-unimported file in the
client tree until that lands.

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

Files mutated: `client/src/App.tsx`, `client/src/navigation.ts`, `client/src/pages/News.tsx`.

**App.tsx lazy-imports a deleted page again** (`client/src/App.tsx`) — APPLIED `b7e2e067d536` → `db10264cf63d` — **RED**, 1 failing · killed by *nothing imports or renders a deleted page, anywhere in the client*

```diff
-const Teams = lazy(() => import('./pages/Teams'));
+const Teams = lazy(() => import('./pages/Teams'));
+const Rankings = lazy(() => import('./pages/Rankings'));
```

**App.tsx renders <Rankings /> on /rankings** (`client/src/App.tsx`) — APPLIED `b7e2e067d536` → `9cd47e95596f` — **RED**, 2 failing · killed by *nothing imports or renders a deleted page, anywhere in the client*

```diff
-<Route path="/rankings" element={<Navigate to="/league" replace />} />
+<Route path="/rankings" element={<Rankings />} />
```

**another page imports the deleted StaleBanner** — **NOT APPLIED: the anchor below is not in `client/src/pages/News.tsx` at this tip, so nothing ran.**

```diff
-import { useState
+import StaleBanner from '../components/StaleBanner';
+import { useState
```

**the /rankings bookmark redirect is dropped** (`client/src/App.tsx`) — APPLIED `b7e2e067d536` → `9b5579e26f93` — **RED**, 1 failing · killed by *the palette no longer advertises a page that is not there*

```diff
-<Route path="/rankings" element={<Navigate to="/league" replace />} />
+  (the text is removed)
```

**the palette re-advertises a deleted page** (`client/src/navigation.ts`) — APPLIED `3bca5e69272f` → `5ff014d6a203` — **RED**, 1 failing · killed by *the palette no longer advertises a page that is not there*

```diff
-export const DEEP_DESTINATIONS: readonly (readonly [string, string, string])[] = [
+export const DEEP_DESTINATIONS: readonly (readonly [string, string, string])[] = [
+  ['Rankings', '/rankings', 'Your rankings and tiers'],
```

**a ninth destination appears in the sidebar** (`client/src/navigation.ts`) — APPLIED `3bca5e69272f` → `e9f10f153d26` — **RED**, 1 failing · killed by *the nav is still the eight destinations Nick chose*

```diff
-{ to: '/news', label: 'News', icon: 'N' },
+{ to: '/news', label: 'News', icon: 'N' },
+    { to: '/model', label: 'The Model', icon: 'M' },
```

**another page imports the deleted StaleBanner** (`client/src/pages/News.tsx`) — APPLIED `6823539e5c08` → `d585a3e0e078` — **RED**, 1 failing · killed by *nothing imports or renders a deleted page, anywhere in the client*

```diff
-import { useEffect, useState } from 'react';
+import { useEffect, useState } from 'react';
+import StaleBanner from '../components/StaleBanner';
```

**NO-OP CONTROL: a comment line is reworded in the nav** (`client/src/navigation.ts`) — APPLIED `3bca5e69272f` → `cabe90c0d63d` — **green — survived, as intended**

```diff
- * The one place a first-class destination in this app is declared.
+ * The one place a first-class destination in this app is declared (control).
```

6 mutations applied and red, 1 applied and green, and 1 reported NOT APPLIED — its pattern is not in the file at this tip, so it ran nothing and is counted as a gap rather than as a pass; where a re-anchored version of the same mutation appears in the table, that row is the result. The green
row is the deliberate no-op control — an edit that is real (the SHA changes) but
touches nothing any assertion claims to read. A control that went red would mean
the tests were pinning the file rather than its behaviour.

**Full check on this exact tree:** typecheck clean, 3,182 tests, 3,141 pass, 0 fail, 41 skipped, build 2.61s, startup smoke
passed on an isolated database, **measured on commit `6a8df0d`** — the commit this
section lands in, whose parent is `af7f01a`. The source was restored after the
mutation run and verified clean with `git status` rather than assumed clean
because the runner said so.
