# INT-168-1: show the sim's own "median-game rule unknown" state on Model / My team

2026-09-23. Not a statistical unit (no model number changed, no fit run, no held-out
look) — presentational only. Sections 2/3/4 of the RD-HANDOFF-CONTRACT pre-registration
requirement do not apply; nothing added to `docs/evidence/HOLDOUT-LEDGER.md`.

## 1. Audit: what already exists for this surface

`league-rules.js#inferMedian` (one producer, per CE-05 / #168) writes `rules.median_game`
onto the object every league-rules caller reads:

- `null` — ESPN publishes no median-game setting on `leagues.payload` AND no regular-season
  week is decided yet to infer it from (`league-rules.js:161`, the "genuinely unknown" case),
  or the decided weeks show a mixed 1-vs-2-records-per-week pattern (`:166`, also pushed to
  `unknown`).
- `true` / `false` — the sim knows the rule either way.

`season-sim.js#simulateSeason` passes that field straight through on its return object
(`season-sim.js:439`, `median_game: rules.median_game`), which is exactly what
`GET /model/:leagueId/simulate` serves (`routes/model.js:450-460`, no re-shaping).

Two client pages call that route and render title/playoff odds from it:

- `client/src/pages/Model.tsx:240` (`Odds()`, the "Championship odds" tab) — reads
  `data?.title_odds`, `data?.playoff_weeks`, etc. Before this change: nothing about
  `median_game`.
- `client/src/pages/MyTeam.tsx:63` ("Your title odds right now" card) — same response,
  same gap.

Extend-or-build: extend. One new presentational component
(`client/src/components/MedianGameNotice.tsx`) is the one producer of the notice text,
imported by both pages, fed the same `median_game` field both pages already read the rest
of the sim response from. No new table, no new route, no new server code — the field was
already served; the pages just did not show it.

## 2. Pre-registration

Not applicable — no model, projection, trade-valuation, lineup or inventory number
changes. This is a UI notice keyed off an existing served field.

## 3. RED

Commit `6ffbba4a` — "test: INT-168-1 RED - median-game unknown notice missing from
Model/MyTeam". Failing assertions:

```
error: "ENOENT: no such file or directory, open '.../client/src/components/MedianGameNotice.tsx'"
error: 'client/src/pages/Model.tsx does not import the shared MedianGameNotice component'
```

(MyTeam.tsx's equivalent subtest failed the same way — not reached because the suite had
already asserted the missing import on Model.tsx first in that run, but re-run in isolation
it fails identically: "client/src/pages/MyTeam.tsx does not import the shared
MedianGameNotice component".)

Ran on: worktree tree at `6ffbba4a`, command:

```
SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u) node --experimental-test-module-mocks \
  --test --test-reporter=tap test/int-168-1-median-rule-unknown-notice.test.js
```
Result: `# pass 0 / # fail 3`.

## 4. GREEN

Commit (this push) — "feat: INT-168-1 show the median-game-unknown notice on Model and My
team". Changes:

- `client/src/components/MedianGameNotice.tsx` (new): renders a one-line amber notice when
  `medianGame === null`; renders nothing for `true`, `false`, or `undefined` (sim not
  loaded yet — distinguished so a page mid-fetch does not flash a false "unknown").
- `client/src/pages/Model.tsx`: `<MedianGameNotice medianGame={data?.median_game} />` under
  the Championship-odds panel's caption.
- `client/src/pages/MyTeam.tsx`: `<MedianGameNotice medianGame={sim?.median_game} />` under
  the "your title odds" card's caption.

Same command as above on the GREEN tree: `# pass 3 / # fail 0`.

## 5. Mutation sweep

Tree: GREEN commit, `test/int-168-1-median-rule-unknown-notice.test.js` unchanged.

| Mutant | Change | Result |
|---|---|---|
| M1 (unit) | `MedianGameNotice.tsx`: `if (medianGame !== null) return null;` → `if (medianGame === null) return null;` (inverted condition — the notice would show for known rules and hide for unknown ones) | **Killed** — `# pass 2 / # fail 1` |
| M2 (call site) | `Model.tsx`: `medianGame={data?.median_game}` → `medianGame={null}` (hard-codes "unknown" regardless of what the sim actually says) | **Killed** — `# pass 2 / # fail 1` |
| M3 (designed survivor) | `MedianGameNotice.tsx`: reword the notice body to `"The median-game rule is unknown for now."`, keeping the word "unknown" | **Survived** (as designed) — `# pass 3 / # fail 0`. The render test only checks the word "unknown"/"not known" appears, not the exact copy, so a wording edit that keeps that word is invisible to it. Known limitation, not a defect: the acceptance test is about the notice's *presence*, not its exact prose. |
| Not-applied control | No mutation, unmodified GREEN tree, re-run | `# pass 3 / # fail 0` (matches the GREEN run above — the harness itself is not stuck failing or passing) |

Each mutation was applied, tested, then reverted (`cp` backup / restore); `git status
--porcelain` was empty before committing GREEN.

## 6. What it does

`MedianGameNotice` is a plain, hookless, prop-only component (no `useApi`, no browser
global) so both pages can render it directly off data they already fetched — no extra
request, no new endpoint. It shows exactly when the sim's own field says the standings
rule is not yet knowable (no ESPN setting and no decided week), and stays silent the moment
either becomes true, false, or is still loading.

## 7. Numbers, with commands

- `# pass 0 / # fail 3` on RED tree `6ffbba4a`, command above.
- `# pass 3 / # fail 0` on GREEN tree (this commit).
- Mutation sweep table above; each row's pass/fail count is from the same command run
  against the mutated file, then reverted.
- One producer, one reader, control: `grep -rn "median_game\|MedianGameNotice" client/src
  server/services server/routes` on the GREEN tree returns exactly: the field's producer
  (`league-rules.js` ×4), its one pass-through (`season-sim.js` ×2), the new component
  (`MedianGameNotice.tsx`), and its two call sites (`Model.tsx`, `MyTeam.tsx`) — no other
  reader or a second copy of the notice.

## 8. Known defects / limits

- The mutation sweep's designed survivor (M3) shows the test does not pin exact copy —
  intentional, since Nick's standing rule is "plain-language stats," not frozen wording;
  a future copy edit that keeps "unknown" in the text will not trip this test.
- No server change: this ships only what `median_game` already carried. If `league-rules.js`
  changes when it reports `null` vs `true`/`false`, this notice's timing changes with it —
  that is out of this unit's scope (CE-05/#168 owns that logic).
- No test exercises the *live* app (a running server + browser); the render test compiles
  the real TSX and renders it with `react-dom/server`, which does not execute effects or
  browser APIs. `MedianGameNotice` uses neither, so this is not a gap for this component.

## Nick's five questions

1. **Well built?** Yes for its scope: one small, hookless component, reused by both
   consumers, fed the same field they already read the rest of the response from (verified
   by grep with a known-reachable control in the same test file).
2. **Stats or made up?** Neither — it is a direct pass-through of a boolean/null field the
   server already computes and serves; no new number.
3. **How we know:** RED/GREEN render test plus a mutation sweep (2 killed, 1 designed
   survivor, 1 not-applied control), all commands and counts above.
4. **Pointed anywhere else on the platform?** No other page currently reads `median_game`
   (grep control above); if a third page later shows title/playoff odds from this same sim
   response it should import this same component rather than growing a second copy.
5. **How it unifies:** one producer in the server (`league-rules.js#inferMedian`), one
   pass-through (`season-sim.js`), one notice component, two call sites reading the same
   field name off the same response object.
