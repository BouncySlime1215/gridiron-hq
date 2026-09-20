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
