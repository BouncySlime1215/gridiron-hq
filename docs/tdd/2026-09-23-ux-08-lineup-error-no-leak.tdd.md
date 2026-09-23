# UX-08: Lineup (and 3 other pages) stop leaking server file paths/table names (2026-09-23)

**Item:** Work-queue row UX-08 / plan item D23, UI rule 9. `client/src/pages/Lineup.tsx`
showed an internal server error to the user including a file path and a table name, found
by the UI audit: `docs/handoff/local/ui/UX-01-audit.md` ("grep Lineup") quotes the on-screen
text verbatim — "the fitted chance-to-play role layer is not running:
nfl_availability_role_rates is missing/empty (docs/tdd/play-chance.tdd.md)" — and calls it
"explicitly...prohibited by rule 9 ('no file paths')".
**Files:** `client/src/components/PageState.tsx` (the shared `PageError` card — the fix),
`client/src/features/model-lab/ModelRegistryPanel.tsx`, `client/src/components/PostDraftPlan.tsx`,
`client/src/features/news/NewsHub.tsx` (three inline renderers with the same defect pattern),
`test/page-error-no-leak.test.js` (new, 2 tests), `test/lineup-error-no-leak.test.js` (new, 2 tests).
**Source:** `client/src/pages/Lineup.tsx:107` (`{error && !d && <PageError message={error}
onRetry={refetch} />}`); `client/src/api.ts:75-76,169` (the writer of that string —
`useApi`'s fetch throws `new Error(body.error || ...)` at `api.ts:76`, and its `catch`
at `api.ts:168-169` does `setError(e.message)`, which is what `error` is downstream);
`client/src/components/PageState.tsx:19` (`PageError` — before this fix, rendered
`{message}` verbatim).

## 1. Audit — extend or build

Existing surface: `PageState.tsx` already defines a shared `PageError` card, used by 15+
pages (grep below). The defect is not "no shared error state exists" — it's that the shared
state rendered whatever the server said, unfiltered, and three pages bypass it entirely with
their own one-off inline render of the same raw string. This is an **extend**, not a build:
fix `PageError` once (covers every page that already calls it), then fix the three
bypasses the same way.

```
$ grep -rn "PageError\b" client/src/pages client/src/components | wc -l
39   # (message=... call sites across pages/components, incl. Lineup.tsx:107)
$ grep -rn "{.*\.message}\|{error}\|{err}\b" client/src | grep -v "PageError\|test"
client/src/features/model-lab/ModelRegistryPanel.tsx:19: ...Model registry is unavailable: {error}
client/src/features/news/NewsHub.tsx:63: ...News is degraded: {error}
client/src/components/PostDraftPlan.tsx:24: ...Couldn't load the post-draft plan: {error}
(+ 5 alert(`...${e.message}`) call sites in EspnConnect.tsx, Model.tsx, Settings.tsx,
  TeamDetail.tsx, MyTeam.tsx — a different surface (a browser alert(), not a rendered
  page), out of scope for this unit; flagged in §6.)
```
Command run on this unit's branch (`git write-tree` `06cab961bacbed33db54be63d2dd2e9e225bcb95`,
head `fe296384b2b1a2b2604bc417dd731529fcdaed57`).

Not a statistical/model unit — no pre-registration required (§2 of the process is
skipped by design).

## 2. RED

Commit `3f5f62d6` ("test: RED — Lineup page and shared PageError leak server file
paths/table names"). Two new test files, both failing against the pre-fix code:

- `test/page-error-no-leak.test.js`, "PageError never renders a file path or table name
  from the server message" — **failing assertion, run against `3f5f62d6` with the fix
  reverted**:
  ```
  error: "rendered text leaked the table name: Couldn't load this. the fitted
  chance-to-play role layer is not running: nfl_availability_role_rates is
  missing/empty (docs/tdd/play-chance.tdd.md) ↻ Retry"
  ```
- `test/lineup-error-no-leak.test.js`, "Lineup page: a server error with a path and table
  name shows no path/table text; page header unchanged" — same failure, full page render:
  ```
  error: "page leaked the table name: This week Who to start Every call carries how
  close it was. ... Couldn't load this. the fitted chance-to-play role layer is not
  running: nfl_availability_role_rates is missing/empty (docs/tdd/play-chance.tdd.md)
  ↻ Retry"
  ```
  (The page header "Who to start" is present either side — confirms the header/nav
  region is untouched by the defect and by the fix.)

Both tests render the real TSX (`ts.transpileModule` + `react-dom/server`
`renderToStaticMarkup`), the same technique `test/start-sit-gate-panel.test.js` already
uses for `StartSitGate.tsx` — no new test dependency added.

Liveness proof: reverting only `client/src/components/PageState.tsx` from commit `fe296384`
(`git stash push -- client/src/components/PageState.tsx`) reproduces the RED failures above
verbatim; restoring it (`git stash pop`) returns to GREEN. Command: run from the repo root
of this worktree, tree `06cab961...` for the revert, `fe296384`'s own tree for GREEN.

## 3. GREEN

Commit `fe296384` ("fix: GREEN — stop rendering raw server errors on Lineup and 3 other
pages"). `PageError` (`client/src/components/PageState.tsx:19-33`) now:
- logs the raw `message` to `console.error('[PageError]', message)` (debuggable, never
  shown), and
- renders a fixed plain-words string, "Something went wrong loading this. Try again in a
  moment.", plus the existing retry button — unchanged for every one of the 39 call sites
  that pass `message={...}` into it, since none of them need to change.

The three inline bypasses get the same shape (generic user-facing line + `console.error`
of the raw string): `ModelRegistryPanel.tsx:19-23`, `PostDraftPlan.tsx:16-19,26-30`,
`NewsHub.tsx:63,108-113` (extracted to a small `NewsHubError` component so the
`console.error` call isn't inline in a JSX expression).

```
$ GRIDIRON_DB_PATH="$(mktemp -u /tmp/gridiron-test-XXXXXX).sqlite" SCHEDULER_DISABLED=1 \
  node --experimental-test-module-mocks --test --test-reporter=tap \
  test/page-error-no-leak.test.js test/lineup-error-no-leak.test.js
...
# tests 4
# pass 4
# fail 0
```
Run on tree `fe296384`'s own write-tree (head of this unit).

## 4. Mutation sweep

Unit under test: `PageError` (`PageState.tsx`), plus its call site in `Lineup.tsx:107`.

| Mutant | Change | Expected | Result |
|---|---|---|---|
| Call-site revert (= RED) | Un-fix `PageState.tsx` back to rendering `{message}` | killed | **killed** — both test files fail with the leak assertion (§2 quotes the exact failure) |
| Designed survivor | `↻ Retry` → `⟳ Retry` (cosmetic glyph change to the retry button) | survives (test only asserts `/retry/i`, not the glyph) | **survived**, as designed — `node --test test/page-error-no-leak.test.js test/lineup-error-no-leak.test.js` → 4/4 pass with the mutant applied |
| Not-applied control | No mutation, GREEN code as committed | passes | **passed** — 4/4 (§3's run) |

Both mutation runs used the same command as §3 with `client/src/components/PageState.tsx`
edited in place then restored (`cp` before/after, not `git checkout`, so the working tree
was never left dirty against the commit).

## 5. What this does NOT cover

- The 5 `alert(\`...${e.message}\`)` call sites (`EspnConnect.tsx:64,102`, `Model.tsx:37`,
  `Settings.tsx:42,50`, `TeamDetail.tsx:69`, `MyTeam.tsx:86`) still put raw server text in a
  browser `alert()`. Different surface than "shows an internal server error on the page" (no
  DOM node to grep, not caught by a render test) and not named in the audit finding this
  unit acts on. Flagged as a follow-up, not fixed here.
- `PageError`'s generic message is not per-page-context ("Couldn't load the lineup" vs.
  "Couldn't load this") — it says the same generic sentence everywhere. That's a strictly
  smaller UI regression than a leaked file path, so it ships now; a context-aware version
  is a separate, larger change (would need every one of the 39 call sites to pass a label).
- No server-side change: `api.ts:75-76`'s `throw new Error(body.error || ...)` still puts
  the raw server string into `e.message`. That's fine — the client now never displays it,
  console-only, which is where a developer debugging actually needs it.

## Nick's five questions

1. **Well built?** Yes — one shared-component fix covers 39 existing call sites (Lineup
   included) with no per-page changes needed, plus the 3 bypasses fixed the same way.
2. **Stats or made up?** N/A — not a statistical/model unit; a UI defect fix.
3. **How do we know:** RED/GREEN + mutation sweep above; no backtest applicable.
4. **Pointed anywhere else on the platform?** Yes — every page using `PageError`/`PageData`
   (Lineup, TradeLab, Model, Edge, Projections, TeamDetail, MyTeam, Leagues, DraftRoom,
   LiveDraft, LeagueHub, Drafts, News, TradeBrain, PlayerDetail, WaiverWire, StartSitGate,
   MatchupPosture, ProposalSlate, ManagerBoard) gets the same fix from one component change.
5. **How it unifies:** One producer of the error-card UI (`PageError`); no second error-card
   implementation was added — the three bypasses were fixed to the same generic-message +
   console.error shape rather than given their own new component.

## Defect / incumbent / scope

- Defect fixed: `client/src/components/PageState.tsx:19` (`PageError` rendering `{message}`
  verbatim) on `origin/main` at `89f69b3b`.
- Incumbent behavior confirmed by: `git stash` revert reproducing the audit's exact quoted
  string (§2).
- Does NOT cover: alert()-based leaks (§5); nav is untouched (no nav file in this diff;
  `git diff origin/main...HEAD --stat` touches only `client/src/components/PageState.tsx`,
  `client/src/components/PostDraftPlan.tsx`, `client/src/features/model-lab/ModelRegistryPanel.tsx`,
  `client/src/features/news/NewsHub.tsx`, and the two new test files).
- Would make it wrong: a page that needs to show *which* action failed and relies on the
  raw server string for that (none found — every reviewed call site treats `error` as
  opaque already).

## Holdout looks

None — no 2025/2026 held-out data touched by this unit.
