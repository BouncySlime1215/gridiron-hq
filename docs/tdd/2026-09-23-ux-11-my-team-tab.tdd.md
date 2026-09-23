# UX-11: My team promoted to its own top-level tab route

Unit: UX-11 (WORK-QUEUE.md `| UX-11 | ... |`). Nick's decision, WORK-QUEUE.md
2026-09-23 08:20Z: "'my team good' = My team becomes its own tab route. X's &
O's: ... to keep nav at 8 it lives as a section of News (Intelligence group)
unless Nick names a tab to replace." This matches
`docs/handoff/local/ui/UX-02-ia.md` item 1 (My team → `/my-team`, first in
nav) and its closing recommendation to fold X's & O's into News rather than
carry a 9th nav concept.

## 1. Audit (extend-or-build)

- `client/src/navigation.ts` `NAV_GROUPS` (single source for the sidebar and
  the command palette, per the file's own header comment) shipped 8 items:
  League Hub, Start/Sit, Trade Lab, Trade Brain, Draft, News, X's & O's,
  Settings — with "My team" only a *group label*, not a tab.
- `client/src/pages/LeagueHub.tsx:9-22` (pre-change) held an inner
  `?view=team` tab that rendered `MyTeam.tsx` in place; `App.tsx:143`
  (pre-change) had `<Route path="/my-team" element={<Navigate to="/league?view=team" replace />} />`
  — the reverse of what UX-02 asks for.
- Decision: extend, not rebuild. `MyTeam.tsx` (543 lines) is untouched;
  only its entry point moves. `Teams.tsx`/`TeamDetail.tsx` (X's & O's) are
  untouched; only the nav item and a discovery link move.

Not a statistical unit (no model/projection/number changes) — pre-registration
(process step 2) does not apply.

## 2. RED

Commit `cac2372f` "test: RED — nav 8 items with My team first, /my-team
route, old deep link" (`test/ux-11-my-team-tab.test.js`).

Failing assertion against pre-change code (`assert.equal(items[0].label,
'My team', ...)`):
```
AssertionError [ERR_ASSERTION]
  expected: 'My team'
  actual: 'League Hub'
```
The other two subtests failed with `no /my-team route found in App.tsx` and
`LeagueHub.tsx does not redirect ?view=team to /my-team`.

Known-nonzero control (rule 8): `NAV_GROUPS` pre-change already resolves to
8 items (just the wrong 8 / wrong order), so the test isn't trivially green
on an empty or broken import — the source-level parse succeeds and produces
real, comparable content before the fix lands.

Command run (matches `npm test`'s DB/scheduler env, targeted to this file):
```
GRIDIRON_DB_PATH="$(mktemp -u "$TMPDIR/gridiron-test-XXXXXX").sqlite" \
SCHEDULER_DISABLED=1 node --experimental-test-module-mocks --test \
  --test-reporter=tap test/ux-11-my-team-tab.test.js
# tests 3 / pass 0 / fail 3
```

## 3. GREEN

Commit `da87e992` "feat: promote My team to its own top-level tab route
(UX-11)".

- `client/src/navigation.ts`: `NAV_GROUPS[0].items` now starts with
  `{ to: '/my-team', label: 'My team', icon: 'M', end: true }`, followed by
  League Hub, Start/Sit, Trade Lab, Trade Brain, Draft (6 items). The
  Intelligence group drops to `[News]` only (X's & O's removed). Total:
  6 + 1 + 1 (Settings) = **8**. `/teams` moved to `DEEP_DESTINATIONS` (still
  in the command palette, "My Team" deep-dest entry removed since it's now
  a real nav item) so ⌘K still reaches it.
- `client/src/App.tsx`: added `const MyTeam = lazy(() => import('./pages/MyTeam'))`
  and `<Route path="/my-team" element={<MyTeam />} />`; removed the old
  `<Route path="/my-team" element={<Navigate to="/league?view=team" .../>} />`.
- `client/src/pages/LeagueHub.tsx`: dropped the `team`/`connections` tab
  state (only one view is left) and its `MyTeam` import; `?view=team` now
  returns `<Navigate to="/my-team" replace />` — the deep-link redirect now
  points the other way, out of League Hub instead of into it.
- `client/src/pages/News.tsx`: added a plain link, `X's & O's →` → `/teams`,
  in the existing view-tab row (`role="tablist"`), so the retired sidebar
  concept is still one click from News per Nick's decision. No content
  moved, deleted, or duplicated — `Teams.tsx` still owns and renders it at
  its existing route.

Command (same as RED):
```
GRIDIRON_DB_PATH=... SCHEDULER_DISABLED=1 node --experimental-test-module-mocks \
  --test --test-reporter=tap test/ux-11-my-team-tab.test.js
# tests 3 / pass 3 / fail 0
```

Regression check on the nearest existing coverage of `navigation.ts`
(`test/trade-brain-surface.test.js`, `test/route-deletion-impact.test.js`):
20/21 pass; the one failure (`route-deletion-impact.test.js`'s
"already-unreached function" subtest) reproduces identically on
`origin/main` unmodified (checked against the read-only repo clone,
`131a7ba0`), so it predates and is unrelated to this change — not touched
here.

## 4. Mutation sweep

Unit under test: `NAV_GROUPS` array composition/order (`navigation.ts`);
call sites: the `/my-team` route registration (`App.tsx`) and the
`?view=team` redirect predicate (`LeagueHub.tsx`).

| Mutant | Change | Result |
|---|---|---|
| 1 (unit) | Swap order: League Hub before My team in `NAV_GROUPS` | **Killed** — `pass 2 / fail 1` (label-order assertion) |
| 2 (call site) | `App.tsx` route path `/my-team` → `/my-team-x` | **Killed** — `pass 2 / fail 1` (no `/my-team` route found) |
| 3 (call site) | `LeagueHub.tsx` predicate `'team'` → `'teamz'` | **Killed** — `pass 2 / fail 1` (redirect assertion) |
| Designed survivor | `navigation.ts` My team `icon: 'M'` → `icon: 'Z'` | **Survived** (expected — icon glyph isn't asserted; not part of the unit's acceptance criteria) |
| Not-applied control | No mutation (baseline) | **Pass** — `tests 3 / pass 3 / fail 0` |

All mutants that touch an asserted behaviour die; the one designed survivor
is an intentionally uncovered cosmetic field.

## 5. Live verification (docs/RD-HANDOFF-CONTRACT.md process step; not a
   substitute for the source-level tests, which are this unit's real gate)

Ran the client dev server from this worktree only (`npm run dev:client`,
port 5178, proxying `/api` to the already-running shared backend on 5177 —
the repo clone at `/Users/nick_matta/Documents/GitHub/gridiron-hq` was never
edited, checked out, or `npm`'d):

- `GET /my-team` renders `MyTeam.tsx` directly (title "My Team", title-odds
  ladder, post-draft plan, best lineup) — no League Hub chrome around it.
- `GET /league?view=team` → `location.href` becomes
  `http://localhost:5178/my-team` (confirmed via `javascript_exec`).
- Sidebar `nav[aria-label="Primary navigation"]` (`read_page`, live DOM):
  `My team, League Hub, Start/Sit, Trade Lab, Trade Brain, Draft, News,
  Settings` — 8 links, My team first, hrefs match `navigation.ts`.
- `/news` has a `X's & O's →` link to `/teams` (`find`, live DOM).
- Screenshots taken at desktop (1400×900) and mobile (375×812) on `/my-team`
  in-session (Browser pane); all league/manager names redacted client-side
  (`javascript_exec` text-node substitution: real league and team names →
  `[league]`/`[user]`) before capture per the no-names-committed rule.
  **Known limitation:** this environment's browser tool renders screenshots
  inline to the session transcript and has no file-export action, so no PNG
  file exists under `docs/evidence/` for this unit — the visual check is
  recorded here as a description of what was seen, not as a checked-in
  image. If a screenshot file is required, it needs a capture path (e.g. a
  Playwright script) that this tool does not currently expose.

## 6. Holdout looks

None. This unit touches nav/routing only, not a model or the 2025/2026
held-out seasons.

## 7. Known defects / out of scope

- `/league` (League Hub) keeps only its "connections" content now that My
  team left; the tab UI is gone since there's exactly one view left. The IA
  doc's fuller League Hub re-scope (manager reads, streaming board, injury
  alerts) is not this unit.
- Phone-width layout bugs (header wrapping, table truncation) are UX-10's
  scope, not fixed here; `/my-team` at 375px renders without crashing but
  wasn't polished.
- X's & O's is a link out of News, not an embedded section — Nick's note
  says "lives as a section of News"; a fuller merge (embedding `Teams.tsx`
  content inline) is a larger UI change than this unit's acceptance
  criteria call for and isn't done here. Said explicitly so a later unit
  doesn't assume it's finished.
- XO-01 (the film-room learning hub) is a separate, later unit — not
  touched.

## Nick's five questions

1. **Well built?** Yes for what it claims: a routing/nav change, verified
   by a source-level test (house pattern, no DOM harness in this repo) and
   by driving the actual dev server.
2. **Stats or made up?** N/A — no model number in this unit.
3. **How we know:** Nothing statistical; the guarantee is a passing
   RED→GREEN test plus a live click-through, not a backtest.
4. **Pointed anywhere else on the platform?** `navigation.ts` is the single
   source of truth for both the sidebar and the command palette
   (`DESTINATIONS`), so both update together automatically.
5. **How it unifies:** No duplicate nav list exists elsewhere (grepped
   `client/src` for `NAV_GROUPS`/`DESTINATIONS`/hardcoded tab arrays before
   editing — `QuickJump.tsx` only re-exports from `navigation.ts`).

Defect fixed: nav item order/composition didn't match `docs/handoff/local/ui/UX-02-ia.md`
item 1 (`client/src/navigation.ts:27-42` on `131a7ba0`); My team was an
inner tab (`LeagueHub.tsx:9-22` on `131a7ba0`), not a route.
Incumbent, by command: `git show 131a7ba0:client/src/navigation.ts | sed -n '27,42p'`.
What this does NOT cover: League Hub's broader re-scope, phone-width polish,
XO-01, embedding Teams content inline in News.
What would make it wrong: a second, undiscovered nav-list definition this
grep missed, or a route consumer (e.g. a hardcoded `/league?view=team` link
elsewhere in the app) not covered by the LeagueHub-level redirect.
