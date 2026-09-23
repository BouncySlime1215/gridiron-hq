# UX-10: phone-width fixes (Leagues table, Trade Lab tab strip, Teams grid)

Unit: UX-10 (WORK-QUEUE.md §3, row `| UX-10 | Phone-width fixes: Leagues raw table, Trade Lab 6-tab strip, Teams grid truncation | UI-STANDARD 7 | lean |`). Plan item: UI revamp findings, D23 UI mobile (docs/handoff/2026-09-22/PLAN-ITEMS-1-25.md). Source: `docs/handoff/local/ui/UX-01-audit.md` line 11 (Leagues), lines 13/32 (Trade Lab), line 19/32 (Teams). Not a statistical unit — no model, projection, trade-valuation, lineup or inventory number is touched. Holdout-look ledger: not applicable (no look at 2025/2026 held-out data).

## 1. Audit: what already exists for this surface (extend-or-build)

The three defects and their exact source locations are already named by `UX-01-audit.md` (written by the UX-01 unit), not rediscovered here:

- `client/src/pages/Leagues.tsx:184-185` — the roster-strength `<table>` is wrapped only in `overflow-x-auto`, no phone alternative → horizontal scroll at 375px (audit line 11, line 32).
- `client/src/pages/TradeLab.tsx:128` — the 6-tool tab strip (`TABS` array, `TradeLab.tsx:14-20`) is wrapped in `overflow-x-auto`; audit's 375px screenshot showed 4 of 6 tabs visible with a scrollbar (audit lines 13, 32).
- `client/src/pages/Teams.tsx:27` — the per-division team grid is a bare `grid-cols-2` with `truncate` on the name (`Teams.tsx:36`), so names cut mid-word at 375px, e.g. "New Englan…" (audit line 19, 32).

Decision: **extend**, not build — this is a targeted class/markup change to three existing pages, no new component or route.

## 2. Pre-registration

Not applicable. This unit changes no model, projection, valuation, or any number; it changes only CSS/layout classes and adds one mobile-only markup branch that renders the same `analysis.rosters` data already fetched by `Leagues.tsx`. No new field, table, or producer is introduced.

## 3. RED

Commit `b2e0cac2` — "test: RED for UX-10 phone-width fixes (Leagues table, Trade Lab tabs, Teams grid)". Added `test/ui-phone-width-ux10.test.js`, four source-level assertions pinned to the exact classes the audit named as defective. Ran against pre-fix code (this commit, before the GREEN commit):

```
$ GRIDIRON_DB_PATH=$(mktemp -u ...).sqlite SCHEDULER_DISABLED=1 \
  node --experimental-test-module-mocks --test --test-reporter=tap test/ui-phone-width-ux10.test.js
# tests 4
# pass 0
# fail 4
```

Failing assertions (inline):
- `Leagues.tsx`: `assert.match(tableWrap[1], /hidden/, ...)` — actual class was `"overflow-x-auto"` (no `hidden`).
- `TradeLab.tsx`: `assert.doesNotMatch(tabBar[1], /overflow-x-auto/, ...)` — actual class was `"flex gap-1 border-b border-slate-200 mb-4 overflow-x-auto"`.
- `Teams.tsx` (grid): `assert.equal(grid, null, ...)` — matched `"grid grid-cols-2 gap-2"`.
- `Teams.tsx` (names): `assert.doesNotMatch(nameLine[1], /\btruncate\b/, ...)` — actual class was `"text-sm font-semibold truncate"`.

### Why source-level assertions, not a rendered-DOM test

The app has no React test renderer, jsdom, `@testing-library/*`, or Playwright in `package-lock.json` (checked: `grep -iE "testing-library|jsdom|vitest|jest" package.json` and a `package-lock.json` package-name scan both come back empty). All existing tests in `test/*.test.js` are server-side `node:test` files; there is no client-component test convention to extend, and jsdom itself has no real layout engine (every element reports 0×0), so even adding it would not produce a truthful `scrollWidth` number. Introducing a full browser-automation test dependency (Playwright) for one lean CSS unit would also diverge `package-lock.json` from `origin/main`'s, which the shared node_modules symlink assumes stays identical. The literal DOM-width assertion (§5) was instead run against the real Chrome layout engine on the live dev server and is recorded here with its command and output, satisfying the acceptance's "or a DOM-width assertion per fix" clause without adding a dependency.

## 4. GREEN

Commit `ccf2eaee` — "fix: UX-10 phone-width fixes for Leagues, Trade Lab, Teams".

- `Leagues.tsx`: table wrapper class → `hidden sm:block overflow-x-auto`; added a sibling `sm:hidden` card-per-team list rendering the same `analysis.rosters` (owner, per-position `StatusPill` + up to 3 starters, needs/surplus) so the data is not merely hidden on phones.
- `TradeLab.tsx`: tab-bar container class → `flex flex-wrap gap-1 border-b border-slate-200 mb-4` (dropped `overflow-x-auto`), so all tabs wrap onto additional rows instead of requiring horizontal scroll.
- `Teams.tsx`: inner team grid → `grid grid-cols-1 sm:grid-cols-2 gap-2`; name and coach lines → `break-words` (was `truncate`); added `shrink-0` to the team-abbr badge so it doesn't compress when the name wraps to two lines.

```
$ GRIDIRON_DB_PATH=$(mktemp -u ...).sqlite SCHEDULER_DISABLED=1 \
  node --experimental-test-module-mocks --test --test-reporter=tap test/ui-phone-width-ux10.test.js
# tests 4
# pass 4
# fail 0
```

`npx tsc --noEmit -p .` run on the full tree: no errors in `Teams.tsx`, `Leagues.tsx`, or `TradeLab.tsx` (grep of the typecheck output for those three filenames returned nothing).

## 5. Live DOM-width verification (real Chrome, 375×812)

Ran against **my own worktree's dev server**, not the shared `localhost:5177` (that port is the read-only repo clone's live server on `origin/main`, per the "never run npm in that directory" rule — it does not carry this branch's fix). Server: `API_PORT=5277 VITE_CLIENT_PORT=5278 GRIDIRON_DB_PATH=.local-db/data.sqlite SCHEDULER_DISABLED=1 npm run dev`, DB is my own `.backup` copy of `~/gridiron-local/data.sqlite` (925 MB, label: **local copy, not production**; deleted at the end of this unit, see §7). Browser pane viewport set to 375×812 (mobile preset).

| Page | Command (browser JS, `document.documentElement.*`) | Result |
|---|---|---|
| `/teams` | `{scrollWidth, clientWidth}` | `{"scrollWidth":375,"clientWidth":375}` — no horizontal scroll |
| `/trade-lab` | `{scrollWidth, clientWidth}` | `{"scrollWidth":375,"clientWidth":375}` — no horizontal scroll |
| `/trade-lab` tab bar | queried the `TABS.map` container, read its `className`, `scrollWidth`/`clientWidth`, and each button's `offsetParent` | `tabBarClass: "flex flex-wrap gap-1 border-b border-slate-200 mb-4"`; `tabBarScrollWidth: 343 === tabBarClientWidth: 343`; all 7 buttons (`News edge, Find deals, Title impact, Target a player, Go get them, Mock a trade, Matchups`) have a non-null `offsetParent`, i.e. all reachable without scrolling or a hidden overflow |
| `/league` → Connections | `{scrollWidth, clientWidth}` | `{"scrollWidth":375,"clientWidth":375}` — no horizontal scroll (this account's leagues have no FantasyCalc trade values loaded locally, so the roster table itself didn't render — `values_missing:true`, confirmed via a patched `window.fetch` capturing the real `/api/leagues/1/analysis` response the page consumer used; syncing real trade values needs a live external fetch, out of scope for a phone-width unit) |
| `/league` → Connections, injected probe | Appended two throwaway `<div>`s with the *exact* classes used in the `Leagues.tsx` fix (`hidden sm:block overflow-x-auto` and `sm:hidden divide-y divide-slate-100`) to the live page at 375px and read `getComputedStyle(...).display` | `{"viewportWidth":375,"desktopTableWrapperDisplay":"none","mobileCardWrapperDisplay":"block"}` — confirms the responsive classes the fix uses do gate on the real Tailwind build at this exact viewport, in lieu of a same-account league with priced trade values to show the populated table |

Screenshots were taken in the Browser pane at 375px for all three pages (Teams division grid with unbroken word-wrapped names; Trade Lab's 7 tabs wrapped across 3 rows with no scrollbar; League Hub → Connections with no PII visible). They are not committed as image files: **no league or manager names appear in the committed evidence** (the non-negotiable), and the falsifiable claims above (scrollWidth/clientWidth equality, `offsetParent` reachability, computed `display`) are the actual acceptance criteria, already recorded verbatim. The league-selector `<option>` text and league-name text nodes were redacted client-side (`opt.textContent = 'League'`, matching text nodes replaced with `[redacted league name]`) purely for on-screen review before any screenshot was taken; this was done in the browser DOM of my own throwaway dev server against my own `.local-db` copy, never against `~/gridiron-local/data.sqlite` or the shared server.

## 6. Mutation sweep

Ran each mutant against `test/ui-phone-width-ux10.test.js`, restoring the file immediately after (verified via `git status --porcelain` after the sweep — clean).

| Mutant | Change | Result |
|---|---|---|
| A (unit) | `Leagues.tsx`: `hidden sm:block overflow-x-auto` → `sm:block overflow-x-auto` (drops `hidden`) | 3 pass, 1 fail — killed |
| B (unit) | `TradeLab.tsx`: `flex flex-wrap gap-1 ...` → `flex gap-1 ... overflow-x-auto` (reverts to the old defect) | 3 pass, 1 fail — killed |
| C (unit) | `Teams.tsx`: `grid grid-cols-1 sm:grid-cols-2 gap-2` → `grid grid-cols-2 gap-2` (reverts) | 3 pass, 1 fail — killed |
| D (designed survivor) | `Teams.tsx`: `gap-2` → `gap-3` (cosmetic, out of the test's stated scope) | 4 pass, 0 fail — survived, as designed: the test asserts column-count and wrap behaviour, not gap spacing |
| Control (not-applied) | No mutation, tree as pushed | 4 pass, 0 fail |

## 7. Cleanup (disk)

Deleted at the end of this unit: `.local-db/data.sqlite` (925 MB backup copy), stopped the two ad hoc dev-server processes (`API_PORT=5277`/`VITE_CLIENT_PORT=5278`). `.local-db/` was already excluded via `.git/worktrees/UX-10/info/exclude`, so nothing was staged. The worktree itself (`/Users/nick_matta/gridiron-local/wt/UX-10`) is left for the coordinator/merge step per the harness instructions; it is not removed by this unit since the unit is still open pending merge.

## 8. Known defects / limits

- No automated test literally measures pixel-level `scrollWidth` in CI; the regression tests are source-level Tailwind-class assertions (see §3 for why), backed by a one-time live-browser DOM measurement recorded above. A future regression that keeps the right classes but breaks Tailwind's build (e.g. a purge misconfiguration dropping `sm:` variants) would not be caught by `npm test`.
- The Leagues.tsx mobile card fallback was verified structurally (probe divs, computed `display`) but not against a real populated roster-strength table, because no connected league in the local data copy has FantasyCalc trade values synced. The card markup was written by hand from the same `analysis.rosters` shape the desktop table already consumes (`ro.owner`, `ro.positions[pos]`, `ro.needs`, `ro.surplus` — identical field access to the existing `<table>` body), so it is not new, unread code, but it has not been visually confirmed with real priced data at 375px.
- `Trade Lab`'s 6-tab strip is now 7 buttons (`TABS` also includes `matchups`, not named in the audit); the fix and its test cover all of them.

## Nick's five questions

1. **Well built?** Yes for the specific defect (verified against the real Tailwind build in a live browser at 375px; see §5); the mobile Leagues card list itself is not visually confirmed with real priced data (§8).
2. **Stats or made up?** Neither — this is layout-only, no numbers.
3. **How we know:** DOM measurement on the live dev server (§5) plus 4 regression tests (§3-4), not a backtest (not applicable to a UI unit).
4. **Pointed anywhere else on the platform?** No — Leagues.tsx, TradeLab.tsx, and Teams.tsx are each edited once, at the exact lines the audit named. No other page reuses these tab-strip/grid patterns verbatim (not grepped exhaustively; out of this unit's scope, which is these three named defects).
5. **How it unifies:** Closes out the three `UX-01-audit.md` "horizontal scroll survives on phone" findings (audit finding 6) under UI-STANDARD #7 ("375px, no horizontal scroll"). No nav change, no page rebuilt or deleted (nav still 8 tabs).

## 9. Skeptic round 1: blocking fixes (2026-09-23)

Skeptic (TEST LIVENESS lens) found two holes. Both were real, so the fix went into the tests. No page code changed.

1. **The phone-view check was met by a comment.** Deleting the Leagues `sm:hidden` card list still gave pass 4 fail 0, because `assert.match(src, /sm:hidden/)` matched the comment at Leagues.tsx:186. Fix: comments are now stripped before matching. The regex requires `<div className="...sm:hidden...">` with `{analysis.rosters.map` directly inside it. It also asserts that `analysis.rosters.map` appears exactly twice: once in the desktop table, once in the phone cards.
2. **No width guard.** New tests:
   - `<main>` in App.tsx must keep `min-w-0` and have no fixed width.
   - Leagues.tsx, TradeLab.tsx and Teams.tsx must have no unprefixed `w-*`/`min-w-*` class wider than 343px (375 minus main's `p-4` on each side). Arbitrary px and rem values count. Responsive-prefixed classes (`sm:w-...`) are ignored.
   - The Trade Lab tab bar must not carry `whitespace-nowrap` or `flex-nowrap`, and the Teams name must not carry `whitespace-nowrap`.

Command for every run below (tree = the worktree at the new test commit; each mutant was reverted with `git checkout --` afterwards, and `git status` showed only the uncommitted test file / clean):
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp) node --experimental-test-module-mocks --test --test-reporter=tap test/ui-phone-width-ux10.test.js`

| Mutant | Result |
|---|---|
| unmutated control | # pass 9 # fail 0 |
| M1 (skeptic) delete Leagues.tsx lines 223-251 (phone card list) | # pass 8 # fail 1 (killed) |
| M3 (skeptic) App.tsx `<main className="min-w-[640px] flex-1` | # pass 8 # fail 1 (killed) |
| M4 (skeptic) TradeLab tab bar `flex flex-wrap w-[640px]` | # pass 8 # fail 1 (killed) |
| M5 Leagues card grid (line 228) + `w-96` (384px) | # pass 8 # fail 1 (killed) |
| M6 Teams name + `whitespace-nowrap` | # pass 8 # fail 1 (killed) |
| M7 TradeLab tab bar `w-[40rem]` (640px) | # pass 8 # fail 1 (killed) |
| S1 designed survivor: tab bar `sm:w-[640px]` (applies only at >=640px viewport, so 375px is unaffected) | # pass 9 # fail 0 |

(My first M5 run sed-edited line 227, which does not hold the grid class. The mutation was never applied and the run gave pass 9 fail 0. On the correct line 228 the mutant is killed.)

Remaining limit: these are still source-level guards, not a rendered layout. Overflow from content (a long unbreakable string, for example) is caught only by the manual 375px `scrollWidth === clientWidth` check in section 5. Re-run command for the gate, in Chrome at 375×812 on /teams, /trade-lab and /league: `document.documentElement.scrollWidth === document.documentElement.clientWidth` should return `true` on each route.
