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

## 9. Skeptic round 1: fixes (supersedes sections 3-6 where they disagree)

Test command for every line below (tree = commit named):
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u) node --experimental-test-module-mocks --test --test-reporter=tap test/int-168-1-median-rule-unknown-notice.test.js`

**Finding A (test liveness), accepted.** The call-site tests only grepped source, so
`{false && <MedianGameNotice .../>}` in MyTeam.tsx still passed 3/3 on 2bdf491a. The grep
tests are replaced with page-level renders: Model.tsx (`<Model tab="odds" embedded />`) and
MyTeam.tsx (whole page) are compiled with the repo's TypeScript, `useApi`/`useLeague` stubbed
with a `/model/7/simulate` response, rendered with react-dom/server. Each asserts the odds
section rendered (control), the notice appears for `median_game:null`, and not for `true`.

**Finding B (hard-coded cause), accepted for the mixed-ratio path.** inferMedian returns null on
two paths, each pushing its own `median_game:` reason into `rules.unknown` (league-rules.js:161
no decided week, :166 mixed records-per-week ratios), served as `rules_unknown`
(season-sim.js:439). The old text always claimed "no regular-season week has been decided
yet". The component now takes `rulesUnknown`, shows the `median_game:` entry verbatim after
"Why:", or no reason when there is none. It also says the odds are simulated without a median
game, which is what the sim does while unknown (season-sim.js:310 `rules.median_game === true`).

**Finding B, emptyRules part (non-ESPN / no payload / unparseable), rejected as unreachable.**
Those null paths never reach either page: simulateSeason returns `simRulesProblem(rules)`
before building a response (season-sim.js:285), Model's Odds shows `data.error` as an empty
state (Model.tsx:246), and MyTeam's card needs `sim.teams` (MyTeam.tsx:66). Command and output:

```
node -e "import('./server/services/league-rules.js').then(m=>{for(const lg of [{platform:'sleeper',payload:'{}'},{platform:'espn',payload:null},{platform:'espn',payload:'not json'}]){const r=m.leagueRules(lg);console.log(lg.platform, r.source, 'median_game=',r.median_game, 'simRulesProblem=', JSON.stringify(m.simRulesProblem(r)?.error))}})"
sleeper unsupported_platform median_game= null simRulesProblem= "league rules incomplete: settings (no rules reader for platform sleeper)"
espn no_payload median_game= null simRulesProblem= "league rules incomplete: leagues.payload"
espn unparseable_payload median_game= null simRulesProblem= "league rules incomplete: leagues.payload (not JSON: ...)"
```
Even so, the component no longer states any cause of its own, so it is safe on those paths too.

**Finding C (second producer of the reason), accepted; fixed by B.** Producer -> component test
runs the real `leagueRules()` on synthetic ESPN payloads (no-decided-week, mixed 1/2 ratio,
and a known control with 2 records per week -> `median_game:true`) and feeds `unknown` straight
into the component. The mixed-ratio render must carry "records per decided week are 1, 2" and
must NOT say no week is decided.

| tree | result |
|---|---|
| e48de2af new tests, old src (2bdf491a) — RED | pass 1 fail 3: mixed-ratio render carries the old hard-coded cause; Model and MyTeam notices lack the sim's reason |
| 1d200cb8 fix — GREEN | pass 4 fail 0 |

Mutation sweep on 1d200cb8 (each applied, run, reverted; `git diff --quiet` check that it applied):

| mutant | result |
|---|---|
| control, unmodified | 4/4 pass |
| MC1 MyTeam `{false && <MedianGameNotice …/>}` (skeptic's mutant) | killed, 3/4 |
| MC1b Model `{false && …}` | killed, 3/4 |
| MC2 MyTeam drops `rulesUnknown={sim?.rules_unknown}` | killed, 3/4 |
| MC3 component hard-codes the old "no week decided" cause | killed, 0/4 |
| MC4 invert `medianGame !== null` | killed, 0/4 |
| MC5 reason taken from any rules_unknown entry, not `median_game:` | killed, 3/4 |
| not-applied control after sweep | 4/4 pass |

Section 8's note about the designed survivor (wording) still holds for the "still unknown"
phrase; the reason itself is now pinned to the producer's string.
