# DEP-HYGIENE: npm audit / outdated report, upgrade only with tests green (batch D item 39)

Item 39: "npm audit / outdated report; upgrade only with tests green."

## Cause (origin/main e466da4b, measured with npm 10.9.7 / Node 22.22.2)

1. Nothing reports dependency health. `npm ci` prints "6 vulnerabilities (5 moderate, 1 high)"
   and nobody reads it.
2. The advisories on main: nanoid < 3.3.18 (high, dev, via postcss/Vite), qs < 6.16.0 (moderate,
   prod, via express/body-parser), react-router / react-router-dom 6.x (moderate, client bundle).
   17 direct dependencies are behind their latest; 6 of those are behind inside their own range.

## Change (flag `GRIDIRON_DEP_HYGIENE`, "on" enables `--apply`; anything else is a report)

- `scripts/dep-hygiene.mjs` (`npm run deps:report`): classifies every `npm audit --json`
  advisory by severity, prod/dev (from the lockfile), direct/transitive and fix kind (in range,
  major, none); classifies `npm outdated --json` by bump kind, in-range update and exact pin.
- `--apply` (flag on only): `npm update <in-range names>`, then `npm audit fix` (never
  `--force`), then typecheck, lint, check:wiring, test, build. The first red step restores
  package.json and package-lock.json byte for byte and runs `npm ci`. Majors and exact pins are
  listed, never applied. Nothing is committed by the script.
- An audit that cannot run (no registry, bad output) is "Audit unavailable", exit 2, never zero.

## Pre-registered bar

- B1 every advisory classified (severity, scope, path, fix kind); fixture counts match by hand.
- B2 outdated rows carry bump kind (0.x minor counts as major), in-range and pin.
- B3 without the flag, `--apply` refuses and package.json / package-lock.json are byte-equal.
- B4 a red gate (or a failed npm step) restores both files byte-equal and names the gate.
- B5 no major bump, no exact pin, no `--force` is ever applied.
- B6 an audit that could not run is reported unavailable with its cause.
- B7 on the real tree: the kept upgrade lowers the advisory count with every gate green.
- Fails if: any file differs after a dry run or a restore; any major/pin/--force applied;
  "0 advisories" printed for an audit that did not run; the kept upgrade leaves a gate red.

## RED -> GREEN

- RED a32c5a63: test/dep-hygiene.test.js, 9 tests, the module does not exist.
- GREEN af9a73cb: 9/9.
- Real tree, first apply: `npm audit fix` exits 1 when a --force-only advisory remains (react-router
  needs 7.x) after fixing the rest. The script read that as a failed step and restored; the files
  were byte-equal after (sha256 check), which proved B4 on the real tree.
- RED (test added for that): 9 pass 1 fail. GREEN e54a9655: only an `npm error` line fails the
  audit-fix step; the gates judge the result. 10/10. A kept apply now re-audits for the after count.

## Measured (real tree)

- Dry run with `--apply` and no flag: refused, sha256 of both files unchanged (B3).
- Apply with the flag: kept, every gate green (npm update, npm audit fix, typecheck, lint,
  check:wiring, test, build). Advisories 6 -> 2; high 1 -> 0; runtime (prod) 3 -> 0.
  Left: react-router / react-router-dom (moderate, fix is 7.x, a major: listed, not applied).
- Lockfile: 22 packages move, all patch or minor (express 4.22.3, qs 6.16.0, nanoid 3.3.19,
  react-router-dom 6.30.6, ai 7.0.116, postcss 8.5.28, ...). package.json dependency ranges unchanged.
