# TDD evidence: nflverse's CC BY 4.0 attribution on the API

**Before:** most of the NFL data the app serves comes from `nflverse/nflverse-data`,
which is CC BY 4.0, and nothing in the app says so. `data_license` appeared once
in `server/`, `client/` and `scripts/`, at `server/services/ffopportunity.js:21`.
That descriptor is returned only on the betting route
`/api/nfl-betting/profitability` (`nfl-profitability.js:282`).

**After:** `server/services/nflverse.js` exports a frozen `NFLVERSE_SOURCE` beside
`RELEASE`, in the same shape as `FFOPPORTUNITY_SOURCE`. `GET /api/data-freshness`
returns both CC BY descriptors as `sources`. That is the fantasy-side report the
app's data banner already reads (`client/src/components/DataFreshnessBanner.tsx:100`).

Commits, all on #133, base `main` `f620a12`:

- **RED:** #133 `0c47e60` "test: RED - nflverse data carries no CC BY 4.0 source descriptor"
- **GREEN:** #133 `471d3f0` "feat: GREEN - nflverse data carries its CC BY 4.0 descriptor on the freshness report"
- **Test fix:** #133 `2505240` "test: the release-URL check needs a path boundary, not a bare prefix"
- **Evidence:** this file and the sweep runner, in the commit after them.

## Pre-registration (sent to the coordinator before RED)

- **Claim:** the app serves CC BY 4.0 nflverse data and returns no source or
  licence descriptor for it on any API surface.
- **file:line on `f620a12`:**
  - `server/services/nflverse.js:18` (`RELEASE`)
  - `server/services/nfl-advanced.js:27` (`REL`)
  - `server/routes/data-freshness.js:30-35` (the response, with no source field)
- **Incumbent:** none. The comparator is the repository's own practice in
  `ffopportunity.js:17-23`, which this matches rather than beats.

## The licence, fetched

`https://raw.githubusercontent.com/nflverse/nflverse-data/master/LICENSE.md` returned
HTTP 200, 18,651 bytes, sha256
`2a82ac9bbc3e3ee066908381e8d373896db5a6025d083fbd59692fe9ccfb9111`. It opens
"Attribution 4.0 International". Section 3(a)(1), quoted from that file:

> If You Share the Licensed Material (including in modified form), You must:
> a. retain the following if it is supplied by the Licensor with the Licensed
> Material: i. identification of the creator(s) of the Licensed Material […]
> v. a URI or hyperlink to the Licensed Material to the extent reasonably
> practicable; b. indicate if You modified the Licensed Material and retain an
> indication of any previous modifications; and c. indicate the Licensed
> Material is licensed under this Public License, and include the text of, or
> the URI or hyperlink to, this Public License.

Section 3(a)(2) says a URI to a resource holding that information is a reasonable
way to meet it. The descriptor carries each piece:

- `creator`
- `release_url`
- `modified`: `true`, since the app derives weekly, rolling and team-level features
- `modification`
- `data_license`
- `license_url` (creativecommons.org)
- `license_file` (the upstream `LICENSE.md`)

## RED → GREEN

`test/nflverse-attribution.test.js`, 4 tests.

**RED #133 `0c47e60`:** 4 of 4 fail. This is the output of
`node --experimental-test-module-mocks --test test/nflverse-attribution.test.js`,
run under the suite's offline guard on that commit:

```
not ok 1 - nflverse has a frozen source descriptor naming its data licence
  error: 'nflverse.js exports NFLVERSE_SOURCE'
not ok 2 - the descriptor says the data is modified, as Section 3(a)(1)(b) asks
  error: |-
    the app derives features from the data, so it is modified
    + actual - expected
    + undefined
    - true
not ok 3 - every nflverse-data release URL the server fetches from is the one the descriptor names
  error: 'the descriptor names its release URL'
not ok 4 - the data-freshness report carries both CC BY sources, verbatim
  error: 'the report has a sources array'
```

**GREEN #133 `471d3f0`:** 4 of 4 pass. So do the 45 tests already in
`test/data-freshness*.test.js`, `test/ffopportunity*.test.js` and
`test/nflverse*.test.js`: 49 of 49 together.

## Mutation sweep: 10 applied, 10 killed

`node docs/tdd/sweeps/nflverse-attribution-mutations.mjs` runs in a throwaway git
worktree at HEAD and never writes the working tree.

| | mutation | killed by test |
|---|---|---|
| M1, M2 | route drops `sources` / drops ffopportunity from it | 4 |
| M3–M5, M8 | not frozen / `CC BY-SA 4.0` / licence link dropped / creator dropped | 1 |
| M6, M7 | `modified: false` / modification not described | 2 |
| M9 | `nfl-advanced.js` fetches from `…/releases/download-mirror` | 3 |
| M10 | descriptor names `…/releases/download/players` | 3 |

**The first sweep was 9 of 10.** M9 survived because test 3 used a bare
`startsWith`, so `…/download-mirror` passed as being under `…/download`. That
was a real gap in the test. #133 `2505240` requires an exact match or a following
`/`, and M9 is now killed. The test was fixed, not the implementation, and the fix
is its own commit so it can be seen.

Test 3 finds the release URL in **nine** files under `server/`: `nflverse.js`,
`nfl-advanced.js`, `nfl-event-archive.js`, `nfl-formations.js`, `nfl-officials.js`,
`nfl-pbp.js`, `nfl-qbr.js`, `nfl-rookie-ingest.js` and `offseason-data.js`. All
nine sit under the descriptor's `release_url`.

## What this does not cover

- **Nothing a user can see yet.** The visible line is client code, which is
  UI's. The line proposed for it is in the PR body.
- **`nflverse/nfldata` is a different repository**, and its licence is not
  established here. `gamescript.js:23`, `nfl-coaches.js:31`, `nfl-officials.js:25`,
  `nfl-opening-lines.js:31` and `nfl-profitability.js:19` fetch from it. `LICENSE`
  and `LICENSE.md` on both `master` and `main` return 404, and this session cannot
  read that repository through the GitHub API. No descriptor was invented for it.
  Establishing its licence is a separate check.
- **Not legal advice.** This matches the licence's own wording and the pattern the
  repository already uses; whether it is sufficient is a judgement for Nick.
- **gridiron-hq's own licensing is untouched.** The repository has no `LICENSE`
  file. That is Nick's call, and it goes to him as an observation only.

## The five questions

- **Is it well built?** It is one frozen object in the file that owns the fetch
  URL, in the shape the codebase already uses, returned on the surface the app
  already reads. Test 3 ties the descriptor to all nine fetch sites, so it cannot
  drift from what is actually fetched without a test failing.
- **Stats or made up?** There are no statistics here. It is a presence check
  against a fetched licence file, with its sha256 and byte count recorded, plus
  a grep over `server/` whose count is stated.
- **How do we know?** RED #133 `0c47e60` fails 4 of 4. GREEN #133 `471d3f0`
  passes 4 of 4. The sweep kills 10 of 10, including the gap its first run found.
  The full gate figures (`npm run check && npm run check:wiring` under one guard)
  are in the PR body, measured on the exact pushed head, which includes this file.
- **Pointed anywhere else on the platform?** Yes. `nflverse/nfldata` feeds five
  services and its licence is unknown from here. The `sources` array is where a
  third descriptor goes once it is known.
- **How does it unify?** One shape of source descriptor for every CC BY feed,
  carried on the data surface, where before there was one for one feed on a
  betting route.
