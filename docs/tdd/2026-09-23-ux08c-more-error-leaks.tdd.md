# UX-08c — remaining raw server-error leaks (plan item D23, UI rule 9)

Branch `claude/local-ux-08c-more-error-leaks`, built on
`claude/local-ux-08b-alert-error-no-leak`'s head (`c2d6a2e1`; PR #175 not yet
merged into main at time of writing — `git show origin/main:client/src/lib/errorSanitize.ts`
returns "does not exist" — so this worktree branched from UX-08b's head per
the unit's row rather than importing a merged file).

## 1. Audit (what already exists for this surface)

WORK-QUEUE.md row UX-08c lists: `TeamDetail.tsx:79,81,396/401`,
`MyTeam.tsx:302,444`, `Model.tsx:96,245`, `TradeCard.tsx:175/195/202`
(rendered `:319`), `EspnConnect.tsx:53`, `ManagerBoard.tsx:92`. Each was
traced to its server counterpart before writing any test:

| Site | Verdict | Evidence |
|---|---|---|
| `TeamDetail.tsx:79` (`refreshOutlook`, `t?.error` ternary) | **Leak** | `t` is `r.refreshed?.[0]` from `POST /analysis/refresh` → `server/routes/analysis.js` `refreshStaleAnalyses()`; on a rejected `Promise.allSettled` entry it pushes `{ abbr, error: settled[j].reason?.message }` (analysis.js:118) — a raw exception message. |
| `TeamDetail.tsx:81` (`refreshOutlook` catch) | **Leak** | `setAiMsg(e.message)` — `e` is `api()`'s thrown `Error(body.error \|\| ...)`, and `body.error` on any 500 is `server/index.js:163`'s global handler: `res.status(status).json({ error: err.message })` — the same raw-exception channel UX-08/UX-08b fixed at other sites. |
| `TeamDetail.tsx:396` (`ExplainButton` catch, rendered `:401`) | **Leak** | Same `api()` → global-handler channel, on `POST /news/:id/explain`. |
| `TradeCard.tsx:175/195/202` (rendered `:319`) | **Leak** | Same channel, on `/trades/:id/sense-check`, `/model/:id/trade-impact`, `/trades/:id/explain`. |
| `ManagerBoard.tsx:92` | **Leak** | Same channel, on `POST /trades/:id/brain/managers/:id`; `e instanceof Error ? e.message : ...` — the `.message` branch is the leak. |
| `EspnConnect.tsx:53` (`setPasteErr(e.message)`) | **Leak — but server-side.** | Client just renders whatever `error` field `POST /espn-connect/cookies` sends. Traced to `server/routes/espn-connect.js` `validateCookies()`: two branches (401/403/404, and timeout) already return plain, specific copy; the fallback branch returned `` `Couldn't verify those cookies with ESPN: ${e.message}` `` — a raw exception message (task note "check the server's cookie-validation messages first" flagged exactly this). Fixing the client side would have collapsed the two good branches too, discarding real user guidance for no reason — the actual defect is the third branch, server-side. |
| `MyTeam.tsx:302` (`scout.error`) | **Not a leak.** | `scout` = `useApi('/trades/:id/scout')` → `selfScout()` (`server/services/trade-engine.js:2502`). Function body has exactly one `error` field (`'your team not found'`, line 2508) and zero `try`/`catch`/`.message` anywhere in it — no path stuffs a raw exception into this field. |
| `MyTeam.tsx:444` (`data.error`) | **Not a leak.** | `data` = `useApi('/trades/:id/ceiling-lineup')` → `ceilingLineup()` (`server/services/ceiling-lineup.js:185`). Three `error` fields, all hardcoded plain text (`'league not synced yet'`, `'team not found in this league'`, a template with only `pools.length`/`slots.length`/`week` — never `.message`). |
| `Model.tsx:96,245` | **Out of scope — orphan page.** | `Model.tsx`'s own header comment (lines 1–24) records that on 2026-09-20, "sixteen [routes] were the read endpoints of `client/src/pages/Model.tsx` — a page that no file imports and no `<Route>` declares" and says **"DO NOT re-add a route here to give Model.tsx something to call."** Confirmed: `grep -rln "pages/Model'" client/src/` returns nothing; `App.tsx` never imports it. `/model/accuracy` and the accuracy-view `/model/:id/simulate` caller it used were deleted. No consumer reaches this code (rule: every field needs a reader reaching a route/job/page; the inverse holds too — a leak with no reachable renderer leaks to nobody). Rule 14 ("never rebuild a deleted page") argues against restoring it just to have somewhere to point a fix. Left untouched, documented as a control (`test/ux08c-more-error-leaks.test.js` asserts the orphan status so a future re-wiring of Model.tsx has to revisit this file). |

Extend-or-build: extend. `client/src/lib/errorSanitize.ts` (UX-08b) already
has `sanitizedMessage`/`sanitizedAlert`/`logServerDetail` and is reused
as-is, no changes to that file.

## 2. Pre-registration

Not applicable — no model/projection/valuation number changes; this is a
UI/error-handling fix.

## 3. RED

Commit `e57bef10` — `test: RED — UX-08c remaining raw server-error leaks`,
`test/ux08c-more-error-leaks.test.js`. 8 of 16 tests failed pre-fix:

- `TeamDetail.tsx:81 (refreshOutlook)` — `AssertionError: ... leaked "nfl_availability_role_rates" to the user: {"name":"setAiMsg","args":["nfl_availability_role_rates is missing or empty ..."]}`
- `TeamDetail.tsx:396 (ExplainButton)` — same shape, `setErr`
- `TradeCard.tsx:175 (senseCheck)`, `:195 (odds)`, `:202 (explain)` — same shape, `setErr`
- `ManagerBoard.tsx:92 (set tier)` — same shape, `setSaveError`
- `TeamDetail.tsx:79` — `TypeError` on first pass (test bug: two `setAiMsg` calls in the file, walker picked the catch's `setAiMsg(e.message)` instead of the ternary; fixed by filtering call sites for `t?.error`/`t.error` text before the RED commit's tests were finalized) then, corrected, failed on the real assertion: raw `t.error` reached `aiMsg` unsanitized.
- `espn-connect.js validateCookies()` — `AssertionError: validateCookies still interpolates e.message: ... return { ok: false, reason: \`Couldn't verify those cookies with ESPN: ${e.message}\`, leagues: [] };`

Controls and audit assertions (harness sanity, the two MyTeam/ceiling-lineup
contradiction tests, the Model.tsx orphan-page check, nav-untouched) passed
from the start, as expected for things that were already correct or don't
need a code change.

## 4. GREEN

Commit `667f4541` — `fix: UX-08c — sanitize remaining raw server-error leaks`.

- `client/src/pages/TeamDetail.tsx`: `refreshOutlook`'s `t?.error` branch now
  reads `sanitizedMessage('TeamDetail.refreshOutlook', 'AI refresh failed', t.error)`;
  its catch reads `sanitizedMessage('TeamDetail.refreshOutlook', 'Outlook refresh failed', e.message)`.
  `ExplainButton`'s catch reads `sanitizedMessage('TeamDetail.ExplainButton', "Couldn't explain that", e.message)`.
  Import line extended: `sanitizedAlert, sanitizedMessage`.
- `client/src/components/TradeCard.tsx`: `senseCheck`, `odds`, `explain`
  catches each wrap `e.message` in `sanitizedMessage(...)` with a
  site-specific prefix. Import extended: `logServerDetail, sanitizedMessage`.
- `client/src/components/brain/ManagerBoard.tsx`: `set()`'s catch now calls
  `sanitizedMessage('ManagerBoard.set', 'Could not save that tier', e.message)`
  on the `Error` branch; the non-`Error` fallback string was left as
  `'Could not save that tier. Try again in a moment.'` (was `'... — try
  again.'`, restyled to match the sanitized copy's period-based phrasing —
  this branch is not exercised by any real server error, see the mutation
  sweep for the resulting gap).
- `server/routes/espn-connect.js`: `validateCookies()`'s fallback branch no
  longer interpolates `e.message`; it logs `console.error('[espn-connect.validateCookies]', e)`
  and returns the generic `"Couldn't verify those cookies with ESPN. Try
  again in a moment."`. The two other branches (401/403/404, timeout) are
  byte-for-byte unchanged.

`node --experimental-test-module-mocks --test --test-reporter=tap
test/ux08c-more-error-leaks.test.js` (`SCHEDULER_DISABLED=1`): **16/16 pass.**
`test/ux08b-alert-error-no-leak.test.js` re-run on the same tree: **28/28
pass**, no regression.

## 5. Mutation sweep

Each mutation applied by hand, tested, then reverted (`git status --porcelain`
confirmed clean before the GREEN commit and again after the sweep).

| # | Mutation | Site | Kind | Result |
|---|---|---|---|---|
| 1 | `TradeCard.tsx` `senseCheck` catch reverted to `setErr(e.message)` | call site | reintroduce the fixed leak | **Killed** — `TradeCard.tsx:175` fails: `leaked "nfl_availability_role_rates" to the user` |
| 2 | `espn-connect.js` fallback reverted to `` reason: `Couldn't verify those cookies with ESPN: ${e.message}` `` | unit (`validateCookies`) | reintroduce the fixed leak | **Killed** — `espn-connect.js validateCookies() — no reason string interpolates e.message` fails |
| 3 (designed survivor) | `ManagerBoard.tsx` non-`Error` fallback string changed back from `'Could not save that tier. Try again in a moment.'` to `'Could not save that tier — try again.'` | call site (`ManagerBoard.tsx:94`), the branch not covered by RED | wording only, no leak path | **Survived** — `ManagerBoard.tsx:92 (set tier)` still passes. Known gap: the catch-body evaluator always constructs `new Error(LEAKY)`, so the `e instanceof Error ? ... : ...` false branch (a non-`Error` throw, which the `api()` helper never produces) has no test coverage. Not a real-world exposure — `api()` always throws a real `Error` — but a future edit to that fallback string could ship a typo or, worse, an interpolated value, unnoticed. |
| 4 (not-applied control) | `espn-connect.js` fallback return object's keys reordered (`{ ok, leagues, reason }` instead of `{ ok, reason, leagues }`), semantically identical | call site | no-op | **Correctly not flagged** — both `espn-connect.js` tests still pass, confirming the suite isn't failing on unrelated diffs |

## 6. What this does

Seven real raw-server-error-leak call sites (six client-side `setState`
sites plus one server-side response-building site) now show plain,
site-specific words to the user and log the real detail to
`console.error` for whoever is debugging — the same pattern UX-08/UX-08b
established. Two queue-listed sites (`MyTeam.tsx:302/444`) were audited and
found already safe (no code change). Two more (`Model.tsx:96/245`) sit on a
page with no reachable route or import — fixing them would touch dead code
with zero real user exposure, so they were left alone and the reason
recorded as a test.

## 7. Known defects / gaps

- Mutant #3 above: `ManagerBoard.tsx`'s non-`Error`-instance fallback
  wording is untested (would need a thrown non-`Error` value from `api()`
  to exercise, which doesn't happen in practice).
- The catch-body evaluator (same technique as UX-08b) only proves the catch
  body; a leak assigned to state *before* a `throw`, inside the `try`, isn't
  covered by that half of the suite. None of the seven fixed sites do that
  (`TeamDetail.tsx:79` is the one non-catch site and has its own dedicated,
  non-catch test).
- `EspnConnect.tsx:53` itself was not edited — it was already just a plain
  render of whatever `error` field the server sends. The fix is one level
  up, server-side; a future new client call site that renders a fresh
  server `error` field without going through the sanitizer would not be
  caught by this suite (only the two audited files + TradeCard/ManagerBoard
  have a token-level whole-file check inherited from UX-08b, and it wasn't
  extended to `TeamDetail.tsx`/`EspnConnect.tsx` in this unit for lean-reading
  reasons — a real limit, not a false confidence claim).

## Nick's five questions

1. **Well built?** Same technique as UX-08b (real TSX compiled with the
   repo's TypeScript, real catch bodies executed with a leaking `Error`,
   marker-based assertions) — reused rather than reinvented, extended only
   where UX-08c's sites needed a shape UX-08b didn't have (the non-catch
   `t?.error` ternary at `TeamDetail.tsx:79`).
2. **Stats or made up?** No stats/model numbers in this unit.
3. **How do we know it works?** RED→GREEN commits above, 16/16 new tests
   plus 28/28 UX-08b tests, and a mutation sweep with one real kill each on
   the client and server fix, one honest designed survivor, one not-applied
   control proving the suite doesn't rubber-stamp unrelated diffs.
4. **Pointed at the right thing?** Two of the eight listed sites
   (`MyTeam.tsx`) were verified NOT to be leaks before touching anything, and
   two (`Model.tsx`) were verified to be unreachable before being left alone
   — both documented with their own tests rather than silently skipped.
5. **How does it unify with everything else?** Reuses UX-08b's
   `errorSanitize.ts` unchanged (no new sanitizing mechanism); same
   console-tag convention (`'File.function'`); same generic-copy suffix
   ("Try again in a moment.").
