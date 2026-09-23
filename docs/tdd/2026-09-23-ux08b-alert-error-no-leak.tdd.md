# UX-08b — sanitize alert() and rendered server-error leaks left after UX-08

Plan item D23 (UI), UI rule 9. Branch `claude/local-ux-08b-alert-error-no-leak`.
Follow-up to UX-08 (branch `claude/local-ux-08-lineup-error-no-leak`, PR #167,
not yet merged into `origin/main` as of this unit's tree).

## 1. Audit — what already exists, extend or build

UX-08 added `logServerDetail`/sanitized `PageError` to
`client/src/components/PageState.tsx` and fixed `ModelRegistryPanel.tsx`,
`NewsHub.tsx`, `PostDraftPlan.tsx`, `WaiverWire.tsx`, `MatchupPosture.tsx` and
`Lineup.tsx` (checked by `git diff origin/main...origin/claude/local-ux-08-lineup-error-no-leak
--stat` on this unit's tree, base `89f69b3b`). It did not touch the 13 sites
this unit was assigned, and its own helper lives on an unmerged branch, so
this unit **builds** a small, separate helper
(`client/src/lib/errorSanitize.ts`) rather than editing `PageState.tsx` —
that file is UX-08's to edit, not this unit's (file-allocation rule).

Two site shapes, both were real leaks on `origin/main` (`89f69b3b`), verified
by reading each file before editing:

- `alert(...)`/`setMsg(...)` sites that put `e.message` straight into what
  the user sees: `Model.tsx:38` (`alert(\`Sync failed: ${e.message}\`)`),
  `TeamDetail.tsx:69`, `MyTeam.tsx:86`, `Settings.tsx:42,50`
  (`setMsg(\`...: ${e.message}\`)`, rendered at `Settings.tsx:54`),
  `EspnConnect.tsx:64,102` (same `setMsg` shape, rendered at
  `EspnConnect.tsx:257`).
- Rendered `.error` fields straight from a server payload:
  `TradeCard.tsx:343,372` (`{sense.error}`/`{impact.error}`),
  `PageExplainAssistant.tsx:177` (`{answer.error}` in `AnswerBlock`),
  `ManagerBoard.tsx:223` (`signals.error` interpolated into `SignalsGap`'s
  `reason`), `ManagerBoard.tsx:284` (`{p.error}`), `SourcePill.tsx:73`
  (`{bm.error}`, set from `e?.message` at `SourcePill.tsx:45`).

Line numbers cited above are as found on this unit's base tree (`89f69b3b`,
`git write-tree` before any edit: see §3); two of the assigned
`EspnConnect.tsx` line numbers (64, 102) turned out to be `setMsg` leaks, not
literal `alert()` calls — the queue row's shorthand ("alert() sites") does
not match the literal grep, but both lines are real, rendered, server-detail
leaks (confirmed by tracing `msg` to its render at line 257), so they are
fixed under the same rule.

**Not fixed** (found while reading the same files, not in this unit's
assigned list, logged here per the missing-data/gap rule rather than
silently expanded scope):
- `TradeCard.tsx`'s `err` state (a third catch path in the same component,
  not rendered near lines 343/372).
- `ManagerBoard.tsx:229` (`signals.data?.error` passed straight into
  `SignalsGap`'s `reason`) and `:279` (`<PageError message={profiles.error}>`
  — covered once UX-08's `PageState.tsx` fix merges).
- `EspnConnect.tsx:52` (`setPasteErr(e.message)`, rendered at line 202).

## 2. Pre-registration

Not applicable — this is a UI-defect fix (no model, projection, trade-value,
lineup or inventory number changes), so no statistical pre-registration
applies.

## 3. RED / GREEN

- **RED**: `db5298f2` "test: RED — UX-08b alert()/rendered .error leaks
  across 13 sites". 20 of 22 assertions failed against `89f69b3b` (verified
  by stashing the fix, running the suite, then restoring it). Failing
  assertion (representative):
  ```
  reach: ManagerBoard.tsx call sites use the sanitizing helpers, not a raw
  {p.error} paragraph
    assert.ok(src.includes('reason={signalsRequestFailedReason(signals.error)}'))
    AssertionError [ERR_ASSERTION]: expected true, actual false
  ```
  The 2 passing tests were controls proving the harness itself renders and
  the marker-detection check can fire (known-nonzero before any real
  assertion) — the contradiction-test rule.

- **GREEN**: `5c412f99` "fix: GREEN — sanitize alert()/rendered .error leaks
  left after UX-08". All 22 assertions pass on the same tree plus this
  commit:
  ```
  $ DB=$(mktemp -d)/data.sqlite; SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH="$DB" \
    node --experimental-test-module-mocks --test --test-reporter=tap \
    test/ux08b-alert-error-no-leak.test.js
  # tests 22
  # pass 22
  # fail 0
  ```

**Liveness proof**: the RED commit's 20 failures against unfixed
`origin/main` code (§ above) is the liveness proof — a green test that also
passes on the broken code proves nothing; here the same 20 assertions
demonstrably fail on the unfixed tree and pass only once the fix lands.

**Test technique, and its limit**: this repo carries no `jsdom` or
`@testing-library` dependency (checked: `node_modules/jsdom` absent, no
`jsdom` in `package.json`), so a real click → `alert()`/DOM-render round
trip isn't available. Rendered `.error` sites (`TradeCard.tsx`,
`PageExplainAssistant.tsx`, `ManagerBoard.tsx`) are proven by compiling the
real `.tsx` with the repo's TypeScript and rendering with
`react-dom/server`'s `renderToStaticMarkup` — same technique as UX-08's own
`test/ux08-component-error-no-leak.test.js`. `SourcePill.tsx`'s error text
is state set only inside an effect's catch block (not a prop), so its fix is
proven by (a) a direct call to the shared `sanitizedMessage` helper with the
real leaking string, and (b) a reach check on the compiled source (test 21)
confirming the real call site invokes that helper and no longer assigns
`e?.message` straight into `bm.error`. The `alert()`/`setMsg` sites
(`Model.tsx`, `TeamDetail.tsx`, `MyTeam.tsx`, `Settings.tsx`,
`EspnConnect.tsx`) are proven the same two ways. This is a known, stated
limit, not a silent gap — see the mutation sweep below for exactly what it
does and doesn't catch.

## 4. What it does

Adds `client/src/lib/errorSanitize.ts`:
- `logServerDetail(where, detail)` — `console.error`'s a tagged detail
  string, no-ops on empty/null/undefined.
- `sanitizedAlert(where, prefix, detail)` — logs, then `alert()`s
  `"${prefix}. Try again in a moment."`.
- `sanitizedMessage(where, prefix, detail)` — logs, returns the same
  generic string for callers that render it (`setMsg`, `bm.error`).

Every one of the 13 listed sites now calls one of these instead of
interpolating `e.message`/`.error` into what the user sees:
`Model.tsx:38`, `TeamDetail.tsx:69`, `MyTeam.tsx:86`, `Settings.tsx:42,50`,
`EspnConnect.tsx:64,102` → `sanitizedAlert`/`sanitizedMessage`.
`TradeCard.tsx:343,372` → new exported `TradeSectionError` component.
`PageExplainAssistant.tsx:177` → `AnswerBlock` (now exported for testing)
calls `logServerDetail` and renders a generic paragraph.
`ManagerBoard.tsx:223,284` → new exported `signalsRequestFailedReason` (pure
function; keeps the honest 404 explanation, which is not server detail, so
it does not log) and `ManagerProfilesGap` component.
`SourcePill.tsx:73` (fed from line 45) → `sanitizedMessage` at the point the
error is captured; the render itself just shows the already-sanitized
string.

## 5. Mutation sweep

| # | Mutant | Where | Applied to | Result |
|---|---|---|---|---|
| 1 | `sanitizedMessage` returns `` `${prefix}: ${detail}` `` (undoes the fix) | unit (`errorSanitize.ts`) | the shared helper | **Killed** — tests 3, 12 fail |
| 2 | `ManagerBoard.tsx`'s call site reverted to `` reason={`The signals request failed: ${signals.error}.`} `` | call site (`ManagerBoard.tsx:223`) | the caller, not the helper | **Killed** — test 20 fails |
| 3 (designed survivor) | `SourcePill.tsx`'s `sanitizedMessage` prefix argument changed from `'Bookmarklet unavailable'` to `'Bookmarklet is down'` | call site (`SourcePill.tsx:45`) | wording only, detail still sanitized | **Survived** — all 22 pass. Known gap: no test pins the exact end-user wording at this one call site (only that it's generic and logged); a wording typo here would ship unnoticed. |
| 4 (not-applied control) | `SourcePill.tsx`'s `setBm({...})` object literal keys reordered (`open`/`error` swapped), semantically identical | call site (`SourcePill.tsx:45`) | a no-op change | **Correctly not flagged** — all 22 pass, proving the suite isn't failing on unrelated diffs |

Mutants 1 and 2 together cover both required classes (the unit itself, and
its call site). Mutant 3 is recorded as a real, accepted gap rather than
hidden.

## 6. Nick's five questions

1. **Well built?** Yes for the 13 listed sites: each has its own
   test (render test for the 6 prop-driven `.error` sites, helper + reach
   test for the 7 `alert()`/`setMsg` sites, since no `jsdom` is available to
   drive a real click). Not exhaustive — see §1's "not fixed" list and the
   designed-survivor gap in §5.
2. **Stats or made up?** Neither — this is a UI defect fix, no model or
   number involved.
3. **How we know:** the RED/GREEN pair in §3, plus the mutation sweep in
   §5. No backtest applies.
4. **Pointed anywhere else on the platform?** No — `errorSanitize.ts` is a
   plain client-side utility with no server route, no config and nothing
   the wiring/reach grader would need to see beyond the imports already
   added.
5. **How it unifies:** one producer for "hide server detail, log it
   instead" (`errorSanitize.ts`), used by all 13 sites here; UX-08's
   `logServerDetail` on `PageState.tsx` is the same concept on a different,
   not-yet-merged branch — noted in the file's own doc comment so whichever
   merges second can consolidate rather than keep two copies live
   indefinitely.

Defect fixed: 13 named sites across 8 files put a server or fetch error's
raw text (which can carry a file path or table name) in front of the user;
`file:line` cited in §1. Incumbent: none — this shape shipped as-is until
now (checked by `git log -p` on each file showing no prior sanitization).
Does NOT cover: the sites listed as "not fixed" in §1, or any leak this repo
already showed on a page UX-08 or UX-08b didn't touch. Would make it wrong:
a call site added later that still interpolates `e.message`/`.error`
straight into rendered JSX or an `alert()` — this unit adds no lint rule or
grader for that, so it relies on review and grep, same as before.

## 7. Revision 2 (after skeptic review) — supersedes the reach checks in §3 and mutant 3 in §5

Command for every run below: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/ux08b-alert-error-no-leak.test.js`.

**What the skeptics found, all confirmed:** the old reach checks were regexes for one shape (`alert(\`...${e.message}\`)`) plus an "imports the helper" check. So the pre-fix ternary at EspnConnect:64, `alert('Sync failed: ' + e.message)` at Model:38, and a new sibling `<p>{impact?.error}</p>` in TradeCard all passed 22/22. RED was mostly ENOENT on the helper file, not a leak being seen. `GENERIC_LOAD_ERROR` had no readers.

**Test changes (test/ux08b-alert-error-no-leak.test.js):**
- *Catch-body evaluation*, which replaces the regex reach loop. For each named site, the real `catch` clause is found with the TypeScript parser, using an anchor unique to its `try` block. The clause is transpiled and run with `e = new Error(LEAKY)`. Every free identifier it touches (alert, setMsg, setBm...) is a recorder, and the real helpers are wired in. The test asserts: (1) no marker in anything shown to the user; (2) the exact expected user text; (3) the detail reaches console.error. Sites: Model:38, TeamDetail:69, MyTeam:86, Settings:42, Settings:50, EspnConnect:64 (both `silent` branches), EspnConnect:102, SourcePill:45. A control test feeds the pre-fix template, concatenation and ternary bodies to the evaluator and checks that it sees the leak.
- *Token check*, which replaces the substring checks in TradeCard, PageExplainAssistant, ManagerBoard and SourcePill. Every `x.error` / `x?.error` read in the whole file must sit in a non-rendering position: a condition, an argument to a sanitizing helper, or the `error` prop of TradeSectionError/ManagerProfilesGap. Anything else fails with file:line and the reason. A control confirms it flags all 4 leak shapes (JSX child, optional-chain JSX child, template prop, PageError prop).

**Code changes this revision:**
- `client/src/lib/errorSanitize.ts`: `GENERIC_LOAD_ERROR` deleted (0 readers: `git grep -n GENERIC_LOAD_ERROR 4458be90` returned only its definition).
- `ManagerBoard.tsx:252`: `SignalsGap reason={signals.data.error}` now goes through `sanitizedMessage('ManagerBoard.signalsPayload', ...)`. This was listed as open in rev 1, and the token check flagged it.
- `ManagerBoard.tsx:303`: `PageError message={profiles.error}` now goes through `sanitizedMessage('ManagerBoard.profilesFetch', ...)`. PageError on main renders `message` raw (client/src/components/PageState.tsx:23), so this no longer waits on UX-08.
- `SourcePill.tsx`: the state field `error` is renamed to `message`, since it only ever holds sanitized text. It is always set through `sanitizedMessage` (the old `'not available yet'` fallback rendered with no prefix).

**RED (tree origin/main 131a7ba0 + new test file only; main's only change since 89f69b3b is client/src/pages/Lineup.tsx, which does not overlap):** 4 pass / 24 fail. 9 fail on `leaked "nfl_availability_role_rates" to the user`: every catch-eval site, including SourcePill:45. 4 fail on `unsafe .error reads`, which names TradeCard:343/372, PageExplainAssistant:177, ManagerBoard:220/223/229/279/284 and SourcePill:73. The rest fail on ENOENT/missing exports for the helper and the new components. So every named site now has a RED that sees the leak, not just a missing file.

**GREEN (branch tree, this revision): 28/28 pass.**

**Mutants (each applied alone to the GREEN tree, then reverted):**

| # | Mutant | Result |
|---|---|---|
| M1 | EspnConnect:64 pre-fix ternary restored (skeptic's) | killed: tests 18, 19 |
| M2 | Model:38 `alert('Sync failed: ' + e.message)` (skeptic's) | killed: test 13 |
| M3 | TeamDetail:69 concatenation | killed: test 14 |
| M4 | MyTeam:86 `alert('Sync failed: ' + String(e))` | killed: test 15 |
| M5 | TradeCard sibling `{impact?.error && <p>{impact?.error}</p>}` (skeptic's) | killed: test 23 |
| M6 | SourcePill prefix wording changed (was the rev-1 designed survivor) | killed: test 21 (exact user text pinned) |
| M7 | ManagerBoard:252 back to `reason={signals.data.error}` | killed: test 25 |
| M8 | `sanitizedMessage` returns `${prefix}: ${detail}` | killed: tests 3, 16-21 |

No survivors this round. Known limit: the catch evaluator runs only the catch body, so a leak put into state *before* the throw, inside the `try`, is not covered. None of the named sites do that.

**Still open (found by this revision's grep, outside the named 13; proposed follow-up UX-08c):** TeamDetail.tsx:79 (`AI refresh failed: ${t.error}`), :81 (`setAiMsg(e.message)`), :396/401 (`setErr(e.message)` rendered); MyTeam.tsx:302, :444 (`{scout.error}` / `{data.error}` JSX children); Model.tsx:96, :245 (`description={data.error}`); TradeCard.tsx:175/195/202 (`setErr(e.message)`, rendered at :319); EspnConnect.tsx:53 (`setPasteErr(e.message)`; this may carry useful cookie-validation text, so it needs a look at the server's messages first); ManagerBoard.tsx:92 (`setSaveError(e.message)`). Command: `grep -nE 'catch|\.message|\.error\b|\berr\b'` over the 9 files.

## Holdout looks

None — not a statistical unit, nothing touches the 2025/2026 held-out
seasons.
