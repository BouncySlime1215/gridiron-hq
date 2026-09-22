# TDD evidence: a data credit line that is always on screen (F-08)

Unit F-08, plan item F3 (licence). Branch `claude/local-f-08-data-credit-line`,
base `origin/main` `d6d7bd5a`.

**Before:** the app names no data source anywhere a user can see. The only
record of a data licence is the `sources` array on `GET /api/data-freshness`,
and no client code reads it. The freshness banner, the one component that reads
that route, returns `null` at `client/src/components/DataFreshnessBanner.tsx:132`
whenever every table is current or the banner was dismissed, so even a credit
placed inside it would vanish on a healthy day.

## 1. Audit (tree `d6d7bd5a`, before the first test)

### What `GET /api/data-freshness` says today

Mounted the route on a throwaway database (`GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite`,
`SCHEDULER_DISABLED=1`, `NFL_SEASON=2026`) with `.local-db/probe-sources.mjs`
(git-excluded) and printed `sources`:

```
status 200 keys season,week,all_fresh,tables,sources all_fresh false tables 1
{"repo":"nflverse/nflverse-data","dataset":null,"data_license":"CC BY 4.0","license_url":"https://creativecommons.org/licenses/by/4.0/","creator":"nflverse"}
{"repo":"ffverse/ffopportunity","dataset":null,"data_license":"CC BY 4.0","license_url":null,"creator":null}
```

So two sources, built at `server/routes/data-freshness.js:40` from
`NFLVERSE_SOURCE` (`server/services/nflverse.js:25`) and `FFOPPORTUNITY_SOURCE`
(`server/services/ffopportunity.js:17`). There is no FTN entry.

### What the client shows today

- `grep -c "report.sources\|\.sources" client/src/components/DataFreshnessBanner.tsx` → **0**.
  Control on the same file: `grep -c "report.tables"` → 3, so the grep finds
  fields the banner does read.
- `grep -rn -i -E "CC BY|CC-BY|creativecommons|licen[cs]e|attribut|FTN|nflverse" client/src`
  → 11 lines, none of them a credit. The hits are news-source attribution
  (`navigation.ts:51`, `features/news/*`, `pages/News.tsx`), an SVG
  `attributeName`, and a status count on `pages/Model.tsx:58`.

### Which licensed sources the app actually loads (grep of the loaders)

| Source | Loader (fetch) | Table and writer | Rows, local copy, not production |
|---|---|---|---|
| nflverse-data (CC BY 4.0) | `RELEASE` `server/services/nflverse.js:24` and 8 other files (listed in `docs/tdd/nflverse-attribution.tdd.md`) | many; e.g. `player_week_usage` | 42,624 (`player_week_usage`) |
| FTN charting via nflverse-data | `ingestCharting` `server/services/nfl-formations.js:135-136`, `${BASE}/ftn_charting/ftn_charting_${season}.csv` | `nfl_play_charting`, `INSERT … ON CONFLICT` at `nfl-formations.js:147` | 190,389 (2022: 41,643; 2023: 48,225; 2024: 48,031; 2025: 47,316; 2026: 5,174) |
| ffopportunity | `seasonCsv` `server/services/ffopportunity.js:31-32` | `nfl_ffopportunity_weekly` | 28,596 (2021-2025 about 5,600 a season; 2026: 315) |

Row counts: `sqlite3 .local-db/data.sqlite "SELECT season, COUNT(*) FROM nfl_play_charting GROUP BY season"`
(and the same for `nfl_ffopportunity_weekly`), on a `.backup` copy of
`gridiron-local/data.sqlite` taken 2026-09-22 about 20:13Z. Local copy, not production.

FTN charting is used, not just stored. It is read by
`nfl-weekly-feature-store.js:159` and `nfl-weekly-feature-store-v2.js:633` (the
`charting_*` team features behind `buildTeamFeatureVector`, which
`nfl-team-card.js:15` imports), and served raw at
`GET /api/nfl-betting/formations/charting` (`nfl-betting.js:1561-1564`,
`chartingSummary`). ffopportunity is read by `priorFfOpportunity` in
`player-week-engine.js:28` and refreshed by the scheduler job at
`scheduler.js:1552`.

### The licences, fetched 2026-09-22 20:08Z (not assumed)

- **nflverse-data.** Probed LICENSE, LICENSE.md, LICENSE.txt, COPYING and
  README.md on `master`, `main` and `gh-pages`. Only `LICENSE.md` exists (on
  `master` and `main`, identical: 18,651 bytes, sha256
  `2a82ac9bbc3e3ee066908381e8d373896db5a6025d083fbd59692fe9ccfb9111`, same hash
  #133 recorded). Its first line is "Attribution 4.0 International". The
  README (699 bytes) has no licence text. Repo HEAD `81b5d757`.
- **FTN charting.** The nflverse-data README says nothing about FTN. The
  terms are in nflreadr's loader docs, `R/load_ftn_charting.R` on `main`
  (`23f915a5`), lines 4-7, rendered at
  `https://nflreadr.nflverse.com/reference/load_ftn_charting.html` (HTTP 200).
  It says the data "is released under the CC-BY-SA 4.0 Creative Commons license
  and attribution must be made to **FTN Data via nflverse**". The FTN data
  dictionary page (`articles/dictionary_ftn_charting.html`) carries no licence
  text; the loader docs are the source.
- **ffopportunity.** `LICENSE.md` exists on `main`, `master` and `gh-pages`, and
  it is the GPL (package code). The README's "Terms of Use" (`main`, HEAD
  `74dcb35a`, which is the exact commit `FFOPPORTUNITY_SOURCE.pinned_code_commit`
  names) says the models and expected points data are "licensed under Creative
  Commons Attribution-ShareAlike 4.0 International". **The repo's descriptor says
  `CC BY 4.0`. That is wrong; the data is CC BY-SA 4.0.**

### Producers of the same concept

`grep -rn "CC BY\|CC-BY\|creativecommons" server client/src scripts test`:
`nflverse.js:14,29,30` (CC BY 4.0, correct), `ffopportunity.js:9,21` (CC BY 4.0,
wrong per above), `nfl-rookie-ingest.js:3,118` (`license: 'CC-BY-4.0'` on the
rookie ingest result, correct, a different field shape), the route comment
`data-freshness.js:25`, and the #133 test. One producer of the served source
list exists (`sources` on the freshness route); nothing else lists sources.

### File ownership

`gh pr list --state open --limit 200` (56 open PRs, under the limit), filtered to
files matching `ffopportunity|routes/data-freshness|source-registry`: only
`source-registry.js` (#38, #96, #104) and `docs/tdd/ffopportunity-season-completeness.tdd.md`
(#45) match. The `source-registry` hits are the control that the filter finds
real files. No open PR touches `server/routes/data-freshness.js`,
`server/services/ffopportunity.js`, `DataFreshnessBanner.tsx` or `App.tsx`.
`server/services/nfl-formations.js` is being edited by unit R-02
(`claude/local-r-02-formations-ingest-404`, 29 lines), so this unit does not
edit it; the FTN descriptor goes in a new file and a test ties it to that
loader's fetch URL instead.

### Extend or build: **extend**

- The server's `sources` array stays the one producer of "which sources, under
  which licence". This unit adds the missing FTN entry (new file
  `server/services/ftn-charting-source.js`, one line in the route) and corrects
  ffopportunity's licence in its own descriptor.
- The client gets one credit line, rendered by App below every page, outside
  the banner, so neither `all_fresh` nor a dismissal can hide it. It is static
  on purpose: attribution must still show when the freshness request fails or
  has not resolved (the route sits behind `legacyAuthenticated`, and the banner
  has a whole branch, `:116`, for the request failing). A test fails if the
  client's list and the route's `sources` ever differ in source or licence.
- No table, column or migration. Not a statistical unit (no model number), so
  no pre-registration and no look at the 2025 holdout.

## 2. Pre-registration

Not applicable. This unit produces no model number and grades no decision, so
there is no hypothesis, held-out split or ship rule to register.

**Holdout looks:** none. The 2025 held-out season was not read.
`docs/evidence/HOLDOUT-LEDGER.md` does not exist on `origin/main` (`d6d7bd5a`).

## 3. RED → GREEN

`test/data-credit-line.test.js`, 7 tests at RED and GREEN (9 after the
skeptic round below). It is the repo's first test that
renders a client component: the TSX is transpiled with the repo's own
`typescript` (`transpileModule`, `jsx: react-jsx`), its `../api` import is
swapped for a stub whose `useApi` returns the state each case picks, and it is
rendered with `react-dom/server`. Any other import makes the harness fail
loudly rather than skip. `sessionStorage` is stubbed per render to set the
dismissal.

Command, every run:
`GRIDIRON_DB_PATH=$(mktemp -u …).sqlite SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test --test-reporter=tap test/data-credit-line.test.js`

**RED, `801e5b89` "test: RED - no data credit is rendered, FTN is missing from
sources, ffopportunity's licence is wrong"**, on the unfixed code of `d6d7bd5a`:
7 of 7 fail, exit 1.

```
not ok 1 - the credit renders when every source is current and the banner is dismissed (the DataFreshnessBanner.tsx:132 path)
    the component under test is not exported        (+ 'undefined'  - 'function', at test line 156)
not ok 2 - the credit still renders while the freshness check is loading or after it fails
    the component under test is not exported
not ok 3 - each credit links its source and its licence, and says the data was changed
    the component under test is not exported
not ok 4 - the credit line and GET /api/data-freshness name the same sources under the same licences
  error: 'DataFreshnessBanner.tsx exports no DATA_CREDITS list'
not ok 5 - the FTN descriptor names the release the charting loader fetches, under CC BY-SA 4.0, credited as FTN Data via nflverse
  error: 'server/services/ftn-charting-source.js exports FTN_CHARTING_SOURCE'
not ok 6 - ffopportunity data is CC BY-SA 4.0, as its README Terms of Use says, not CC BY 4.0
    + 'CC BY 4.0'   - 'CC BY-SA 4.0'
not ok 7 - App renders the credit once, on every page, outside any condition
  error: 'App does not import DataCredit'
```

Test 1 failed at line 156, the credit render. Lines 146-155 passed on the
unfixed code. Those lines are the known-nonzero control: the harness renders
the real banner for a behind table ("not current for 2026 week 3"), the banner
asked `/data-freshness`, and then the banner returned `''` on the
`all_fresh=true, dismissed=true` path. So the `''` is the `:132` early return,
not a broken harness.

**GREEN, `1d875dea` "feat: GREEN - a data credit line under every page, FTN on
the freshness sources, ffopportunity marked CC BY-SA 4.0"**: 7 of 7 pass, exit 0.

No assertion changed between RED and GREEN. The RED run above is against the
same test file that passes at GREEN.

Neighbouring suites on the GREEN tree: 17 files, `test/data-credit-line`,
`test/data-freshness*` (6 files), `test/nflverse-attribution`, and every other
test that names ffopportunity except `wiring-map.test.js` (left to the Gate's
one `npm run check`). Result: **203 tests, 203 pass, 0 fail, 0 skipped**,
exit 0.

Typecheck of the changed client file alone, with the repo's `tsconfig` options
on the command line: `tsc --noEmit … client/src/components/DataFreshnessBanner.tsx`
exits 0. Known-error control: a file passing `foo={1}` to `DataCredit` and
assigning a licence string to a `number` gets 2 errors, exit 2. `node --check`
passes on all four changed JS files.

### Skeptic round 1 (head `687b9c39`): the tests were too weak, not the component

An independent skeptic found three gaps. All three were real; reproduced
before any test was touched by adding the skeptic's mutants to the sweep
(M16-M21, section 5) and running it against `687b9c39`:
**21 applied, 15 killed, 6 SURVIVED** (M16-M21, each 7 pass / 0 fail), 3 of 3
controls as designed. Output kept at
`scratchpad/f08-sweep-before-687b9c39.txt` (not committed).

1. **Statelessness was claimed, not pinned.** `react-dom/server` runs no
   effects and has no `window`, so a credit that hid itself in a `useEffect`
   once the banner was dismissed (M16, skeptic U1) or only when `window`
   exists (M18, U3) passed every render.
2. **The call-site check read only the characters before `<DataCredit />`.**
   A condition followed by a wrapper element got through: `{cond && <div>
   <DataCredit /> </div>}` (M20, S1) and `<div hidden><DataCredit /></div>`
   (M21, S2). The one-line `{cond && <DataCredit />}` (S3) was already killed;
   it is M14.
3. **"Visible" was not pinned.** Tests 1-3 read text with tags stripped, so a
   `hidden` class on the footer (M17, U2) passed.

The component did not change behaviour. The fix is in the tests, in two
commits:

- **`0f49ceb2`** "test: pin the credit's statelessness, visibility and call
  site that react-dom/server cannot see (F-08)". The file now has 9 tests; the
  old tests 4-7 are now 6-9.
  - **New test 4, visible.** No element of the rendered credit carries a hiding
    class (`hidden`, `sr-only`, `invisible`, `collapse`, `opacity-0`,
    `text-transparent`, `h-0`/`w-0`/`size-0`/`scale-0` and kin, with any
    variant prefix such as `max-sm:`), a `hidden`, `inert` or
    `aria-hidden="true"` attribute, or an inline `display:none`,
    `visibility:hidden`, `opacity:0` or `font-size:0`. Checked in the
    fresh-and-dismissed state and in a failed check with browser globals.
    Known-nonzero control: the checker flags all 7 marks in a known-hidden
    sample and none in a known-visible one.
  - **New test 5, stateless**, four pins. (1) `DataCredit()` called as a plain
    function outside any render returns an element; a hook call throws there.
    Control: the banner, which uses `useState`, throws. (2) Five states (no
    report; fresh and dismissed; behind in a browser; fresh and dismissed in a
    browser; failed check, dismissed, in a browser) render byte-identical
    markup and never call the freshness route. "In a browser" means
    `window`, `document` and `localStorage` exist and all say dismissed. (3)
    Its compiled source matches no hook call and no browser global
    (`sessionStorage`, `localStorage`, `window`, `document`, `globalThis`,
    `navigator`, `location`, `matchMedia`). Control: the banner's source
    yields exactly `sessionStorage`, `useApi(`, `useState(`. (4) Read with the
    TypeScript AST, the only names DataCredit's body takes from outside itself
    are `DATA_CREDITS` and `creditLink`, and both are module-level `const`s
    whose initialisers reference nothing. Control: the same walk finds
    `useApi`, `useState` and `sessionStorage` in the banner.
  - **Test 9 (was 7), call site, now on the TypeScript AST.** The credit is a
    prop-less `<DataCredit />` whose parent is the same node as `<main>`'s
    parent, placed after `<main>`. Every node from it up to App's `return` is a
    plain element or fragment (no `&&`, ternary, callback or call), and none
    carries a hiding class or attribute. That `return` is App's last top-level
    statement. Known-nonzero control: the JSX checker finds real hiding in
    App.tsx (the header's `hidden sm:inline` label and the drawer overlay's
    `aria-hidden="true"`).
- **`3d215a60`** "test: AST failures print their message, a hook call fails by
  name, the component says what the test holds it to (F-08)". While checking
  the kills, M20 and M21 showed that `assert.equal` on two TypeScript nodes
  dumps the whole circular syntax tree into the TAP output. Identity is now
  compared with `assert.ok(a === b, message)`. A hook call now fails as
  "DataCredit calls a hook". DataCredit's doc comment names the pin, so a
  future editor updates the test on purpose. The sweep's `spawnSync` gets a
  64 MB buffer.

Two more mutants were written to get past the skeptic's own proposed fix (a
`toString()` regex): **M22** reads `window.sessionStorage` once at module load
into a constant that DataCredit checks, and **M23** computes `DATA_CREDITS` as
`[]` in a browser once dismissed. Neither name appears in DataCredit's body,
and the module loads without `window` in the test, so both **SURVIVED** the
`687b9c39` tests (7 pass / 0 fail, exit 0) and pass pins (1)-(3). Pin (4)
kills them.

**Liveness, one failing assertion per new mutant, on `3d215a60`** (a
throwaway worktree per mutant, same test command; scratch runner
`scratchpad/f08-fix/messages.mjs`):

| mutant | result | failing assertion |
|---|---|---|
| M16 `useEffect` hides after mount (U1) | 8 pass / 1 fail | test 5: "DataCredit calls a hook: called outside a render it threw TypeError: Cannot read properties of null (reading 'useState')" |
| M17 `hidden` class on the footer (U2) | 8 / 1 | test 4: "with all_fresh=true and dismissed=true, part of the credit is hidden" |
| M18 hides when `window` says dismissed (U3) | 7 / 2 | test 4: "with a failed freshness check, in a browser, the credit does not render its footer"; test 5: "with all fresh, dismissed, in a browser, the credit renders differently" |
| M19 `max-sm:hidden` on each entry | 8 / 1 | test 4: "with all_fresh=true and dismissed=true, part of the credit is hidden" |
| M20 condition + wrapper div (S1) | 8 / 1 | test 9: "the credit is not a direct sibling of <main> … its parent is JsxElement "<div className="mt-auto"> <DataCredit /> </div>"" |
| M21 `<div hidden>` wrapper (S2) | 8 / 1 | test 9: same message, parent `<div hidden><DataCredit /></div>` |
| M22 browser read at module load | 8 / 1 | test 5: "DataCredit uses something from outside its body other than DATA_CREDITS and creditLink" |
| M23 `DATA_CREDITS` computed in a browser | 8 / 1 | test 5: "DATA_CREDITS is computed from something rather than written out as data" |

On `3d215a60` with the unchanged component: **9 of 9 pass, exit 0**. The
three suites that read `DataFreshnessBanner.tsx` (`data-credit-line`,
`data-freshness-banner-swap`, `data-freshness-grain`): **22 tests, 22 pass,
0 fail, 0 skipped**, exit 0. The server files are unchanged since `1d875dea`,
so the 17-file neighbour run above was not repeated. Typecheck of the banner
file with the repo's `tsconfig` options: exit 0; the 2-error control file:
exit 2, 2 errors. The rendered credit text is unchanged
(`node .local-db/render-credit.mjs`).

## 4. What it does

On screen, under every page of the app (App's main column, after `<main>`):

> Data from nflverse (CC BY 4.0), FTN Data via nflverse (CC BY-SA 4.0) and ffopportunity (CC BY-SA 4.0), adapted for this app.

That is the exact text `react-dom/server` renders from `DataCredit` on
`1d875dea` (`.local-db/render-credit.mjs`, a git-excluded script). Each source name links to the data
(the nflverse-data repo, the `ftn_charting` release, the ffopportunity repo).
Each licence name links to its Creative Commons deed. It is 11px slate text
above a thin rule, with no icon, badge or colour of its own.

- `client/src/components/DataFreshnessBanner.tsx`: `DATA_CREDITS` (three
  entries keyed by repo and dataset) and `DataCredit`, appended. `DataCredit`
  takes no props and reads no state, so the banner's `all_fresh`, dismissal and
  error branches cannot reach it. The banner itself is unchanged.
- `client/src/App.tsx`: one import and one `<DataCredit />`, unconditional,
  after `</main>`.
- `server/services/ftn-charting-source.js` (new): frozen `FTN_CHARTING_SOURCE`,
  with `attribution: 'FTN Data via nflverse'`, `data_license: 'CC BY-SA 4.0'`,
  the BY-SA deed and `release_url` `…/releases/download/ftn_charting`.
- `server/routes/data-freshness.js`: `sources` gains `FTN_CHARTING_SOURCE`, and
  the doc comment now says CC BY and CC BY-SA.
- `server/services/ffopportunity.js`: `data_license` `CC BY 4.0` → `CC BY-SA 4.0`,
  plus a `license_url`. The header comment now quotes the README. The same
  descriptor is also returned by the betting route's profitability payload
  (`nfl-profitability.js`), so that payload now states the right licence too.

After the change, `GET /api/data-freshness` `sources` lists three sources:
nflverse-data (CC BY 4.0), ffopportunity (CC BY-SA 4.0) and nflverse-data
`ftn_charting` (CC BY-SA 4.0). Test 6 fails if the on-screen list and that
array ever differ in source or licence. Test 7 fails if the FTN descriptor's
`release_url` stops being the URL `ingestCharting` fetches. (Test numbers from
here on are the 9-test file at `3d215a60`; the RED and GREEN output in
section 3 uses the 7-test numbering it ran with.)

Nav: `client/src/navigation.ts` untouched (`git diff --stat origin/main -- client/src/navigation.ts`
is empty). It still has 8 `to:` entries.

## 5. Mutation sweep: 23 applied, 23 killed; 3 of 3 controls as designed

`node docs/tdd/sweeps/data-credit-line-mutations.mjs`. It runs in a throwaway
git worktree at HEAD and never writes the working tree. On `3d215a60`:
**23 applied, 23 killed, 0 survived or invalid; 3 of 3 controls as designed**,
exit 0, 73 s wall (machine load about 12). The first run, on `1d875dea` with
M1-M15 and C1-C2, gave 15 of 15 killed in 17.8 s; on `687b9c39` with M16-M21
added, 15 killed and 6 survived (section 3). Test numbers below are the 9-test
file.

| | mutation | where | killed by |
|---|---|---|---|
| M1 | credit returns null when `all_fresh` | unit | tests 1, 3, 4, 5 |
| M2 | credit returns null once dismissed | unit | tests 1, 3, 4, 5 |
| M3 | FTN dropped from `DATA_CREDITS` | unit | tests 1, 2, 5, 6 |
| M4 | FTN credited under CC BY 4.0 | unit | tests 1, 2, 5, 6 |
| M5 | FTN named "FTN Data" without "via nflverse" | unit | tests 1, 2, 5 |
| M6 | licence names shown but not linked | unit | test 3 |
| M7 | "adapted for this app" removed | unit | test 3 |
| M8 | route drops FTN from `sources` | producer | tests 6, 7 |
| M9 | ffopportunity back to CC BY 4.0 | producer | tests 6, 8 |
| M10 | FTN descriptor names `…/ftn_charts` | producer | test 7 |
| M11 | FTN descriptor not frozen | producer | test 7 |
| M12 | `ingestCharting` fetches a different release (`nfl-formations.js`) | loader | test 7 |
| M13 | App no longer renders `<DataCredit />` | call site | test 9 |
| M14 | App renders it as `{!inBetting && <DataCredit />}` (skeptic S3) | call site | test 9 |
| M15 | App renders it above the page, beside the banner | call site | test 9 |
| M16 | `useState` + `useEffect` hide it after mount once dismissed (skeptic U1) | unit | test 5 |
| M17 | `hidden` class on the footer (skeptic U2) | unit | test 4 |
| M18 | returns null when `window.sessionStorage` says dismissed (skeptic U3) | unit | tests 4, 5 |
| M19 | `max-sm:hidden` on each credit entry | unit | test 4 |
| M20 | `{cond && <div className="mt-auto"><DataCredit /></div>}` (skeptic S1) | call site | test 9 |
| M21 | `<div hidden><DataCredit /></div>` (skeptic S2) | call site | test 9 |
| M22 | browser read once at module load into a constant DataCredit checks | unit | test 5 |
| M23 | `DATA_CREDITS` computed as `[]` in a browser once dismissed | unit | test 5 |

**Controls:**
- **C1, designed survivor:** the footer's text colour, `text-slate-500` →
  `text-slate-400`. This is real code that no test pins, and it **survived**.
  So the tests do not over-pin styling.
- **C2, not applied:** a replace aimed at `data_license: 'ODbL'`, which is not
  in the file. It was reported **INVALID** and not counted as killed.
- **C3, designed survivor for the call site:** `<main>`'s padding `p-4` →
  `p-5`. It **survived**, so the AST check pins the credit's placement, not
  App's markup.

## 6. Known defects and what this does not cover

1. **ShareAlike is not settled by a credit line.** FTN's and ffopportunity's
   data are CC BY-SA 4.0. Section 3(b) says that adapted material you *share*
   has to be offered under the same licence. The credit gives notice. It does
   not license the app's derived numbers, whether on the deployed app or as any
   derived data committed to the public repo. This is Nick's call, and it is not
   legal advice.
2. **#133's sweep runner now reports M1 and M2 INVALID, and exits 1.** Its
   replace targets the two-entry `sources` text, and this unit adds a third
   entry. `node docs/tdd/sweeps/nflverse-attribution-mutations.mjs` on
   `1d875dea` gives 10 applied, 8 killed, 2 INVALID, and 2 of 2 controls as
   designed. No gate runs it: `grep -rn docs/tdd/sweeps package.json scripts test .github`
   finds only the Coach `.json` spec checker. The fix is changing two patterns
   in that file. It belongs to the #133 thread, so it is reported here, not
   edited.
3. **Other sources, not probed here.** `nflverse/nfldata` has no licence
   (memory `gridiron-licence-before-measurement-rule`), and 6 server files still
   name it: `gamescript.js`, `nfl-coaches.js`, `nfl-officials.js`,
   `nfl-opening-lines.js`, `nfl-profitability.js`, `scheduler.js`. A credit does
   not license it, so it is not credited. Open-Meteo feeds `nfl-weather*.js`;
   its terms were not read in this unit. Guess: it asks for attribution. That
   needs its own licence check before anyone adds it to the list. A-13 extends
   this line with "officials and schedules".
4. **The FTN descriptor lives outside its loader.** Unit R-02 is editing
   `nfl-formations.js`, so `FTN_CHARTING_SOURCE` went into a new file, tied to
   the loader by test 7 (M12 proves the tie). Follow-up: once R-02 merges, move
   the descriptor next to `ingestCharting`.
5. **No browser check.** The render is `react-dom/server`, and placement is
   checked from App's source. Nobody has looked at it in a running app. The
   `#133` test finds `NFLVERSE_SOURCE` with `sources.find(s => s.repo === 'nflverse/nflverse-data')`,
   and FTN shares that `repo`. That test passes only because nflverse comes first
   in the array. The ordering is kept, and it is fragile.
6. **What the visibility and statelessness pins still do not see.** They read
   the credit's own markup and App's JSX. They do not see a stylesheet rule
   elsewhere that targets the footer, a sibling that covers it (a fixed
   overlay), off-screen positioning (`absolute -left-[9999px]`, a translate),
   or text the same colour as the background (C1 shows colour is
   deliberately unpinned). The closure pin (test 5, part 4) is strict on
   purpose: extracting a helper component or constant fails it until the test
   names the new dependency. The early `return` in App for `/sign-in` and
   `/sign-in/complete` renders outside the chrome with no credit; those pages
   fetch only `/api/auth/providers` and `/api/auth/google/complete`
   (`grep -n fetch client/src/pages/SignIn*.tsx`), so no licensed data is
   shown there.

## 7. Nick's five questions

1. **Well built?** Yes. The server's `sources` stays the one list of what the
   app loads and under which licence. The on-screen line mirrors it, and a test
   fails if they differ. The credit is its own component, mounted once and
   unconditionally, so no banner state can hide it. After the skeptic round,
   the tests also pin what server rendering cannot see: no hooks or browser
   reads (directly or through what it closes over), nothing hidden, and a
   plain sibling of `<main>` in App's syntax tree. 23 of 23 mutants die,
   including five at the App call site and one in the loader.
2. **Stats or made up?** Neither. There are no statistics here. The licences
   were fetched and quoted: nflverse-data `LICENSE.md` sha256 `2a82ac9b…`,
   nflreadr `R/load_ftn_charting.R` at `23f915a5`, and the ffopportunity README
   at `74dcb35a`.
3. **How we know:** no backtest applies. What stands behind it: RED `801e5b89`
   fails 7 of 7, GREEN `1d875dea` passes 7 of 7, 203 of 203 in the neighbouring
   suites. After the skeptic round, `3d215a60` passes 9 of 9, the three
   banner-reading suites pass 22 of 22, and the sweep kills 23 of 23 with 3 of
   3 controls as designed; the 6 skeptic mutants (and 2 more of the same
   family) survived the old tests and each now fails a named assertion. The
   loaders were grepped, and the local copy (not production) holds 190,389 FTN
   charting rows and 28,596 ffopportunity rows, so both sources are really used.
4. **Pointed anywhere else?** Yes. The corrected ffopportunity licence also
   flows to the betting profitability payload. FTN's charting reaches
   `GET /api/nfl-betting/formations/charting` and the team feature vectors.
   The nfldata and Open-Meteo gaps are listed in section 6.
5. **How it unifies:** there is one source list, on the freshness route, with
   one descriptor shape (`repo`, `dataset`, `data_license`, `license_url`), and
   one credit line checked against it. A new licensed source needs one
   descriptor and one `DATA_CREDITS` row. Test 6 fails until both exist.

**Defect fixed:** no visible credit anywhere
(`client/src/components/DataFreshnessBanner.tsx:132` returns null, and nothing
else names a source; tree `d6d7bd5a`). FTN was missing from `sources`
(`server/routes/data-freshness.js:40`). ffopportunity was labelled CC BY 4.0
(`server/services/ffopportunity.js:21`).
**Incumbent:** none. `grep -rn -i -E "CC BY|…|nflverse" client/src` found no
credit.
**Does NOT cover:** ShareAlike obligations, nfldata, Open-Meteo, a browser
check, and the hiding routes listed in section 6 item 6.
**What would make it wrong:** a licensed source that the app loads but that
is missing from `sources`. Test 6 only holds the two lists to each other, so a
source missing from both is invisible to it. Or a licence that changes upstream
after 2026-09-22.
