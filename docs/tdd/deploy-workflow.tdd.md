# TDD evidence: the Deploy button and the build context

**Before:** deploying meant Nick running `fly deploy` on his Mac. Run from outside
the repo it fails. Run from inside it, it uploaded a 2.3 GB build context
(2.2 GB of it `data/`), and nothing re-asserted the scheduler brake unless
someone remembered to.

**After:** `.github/workflows/deploy.yml` deploys from GitHub on the Actions tab's
**Run workflow** button only. It stages the brake before the deploy and fails
unless the new image proves the brake held. `.dockerignore` keeps local data and
databases out of the build context and out of the image.

Commits, all on #127, base `main` `c90d283`:

- **RED:** #127 `62816a9` "test: RED - deploy workflow and build-context guards"
- **GREEN:** #127 `ba97ee8` "feat: GREEN - a Deploy button that re-asserts the brake first and proves it held"
- Evidence: this file, in the commits after them.

(Rebased twice: `b61fb37`/`3794636` on `bf359c6`, then `7de8da4`/`79d45f3` on `f620a12`,
now these on `c90d283`. Each rebase changed the shas and nothing else in these commits.)

## RED → GREEN

`test/deploy-workflow.test.js`, 8 tests.

**RED #127 `62816a9`:** 7 fail, 1 pass. This is the output of
`node --test test/deploy-workflow.test.js`, run on that commit:

```
not ok 1 - deploy runs only when someone presses the button, never on push or on a timer
  error: '.github/workflows/deploy.yml exists'
not ok 2 - one job, with a timeout
  error: '.github/workflows/deploy.yml exists'
not ok 3 - the first step names the commit being deployed
  error: '.github/workflows/deploy.yml exists'
not ok 4 - brake re-asserted before the deploy, confirmation read after, and never released here
  error: '.github/workflows/deploy.yml exists'
not ok 5 - the deploy is remote-only, against the right app, through flyctl-actions
  error: '.github/workflows/deploy.yml exists'
not ok 6 - the Fly token only ever reaches a step through env, never a script
  error: '.github/workflows/deploy.yml exists'
not ok 7 - the build context leaves out what the image never runs
  error: 'data is excluded from the build context'
ok 8 - the build context keeps everything the Dockerfile copies or builds from
```

The keep-list test (8) passes against the old `.dockerignore`, and is meant to.
It guards against excluding too much.

**GREEN #127 `ba97ee8`:** 8 of 8.

Two test changes landed in GREEN, both named here rather than folded in:

1. The "never unsets the brake" check now ignores comment lines. The workflow's
   header names `fly secrets unset SCHEDULER_DISABLED` in order to say it is
   absent. Mutation M7 (a real unset step) is still killed.
2. The app-name match changed from `gridiron-hq\b` to `gridiron-hq(\s|$)`.
   Mutation M9 survived the first version because `\b` treats a hyphen as a word
   boundary, so `--app gridiron-hq-staging` passed. That was a real gap in the test.

## Mutation sweep: 22 applied, 22 killed

`node docs/tdd/sweeps/deploy-workflow-mutations.mjs` runs on copies in a temp dir
and never writes the working tree.

| | mutation | killed by |
|---|---|---|
| M1, M2 | adds a `push` trigger / a `schedule` | button only |
| M3, M15 | drops the timeout / adds a second job | one job, with a timeout |
| M4–M7 | deploy before the brake, no brake step, no confirmation, unsets the brake | brake before, confirm after, never released |
| M8, M9 | not `--remote-only` / `--app gridiron-hq-staging` | remote-only, right app |
| M10–M13 | token in a script, token echoed, `set -ex`, `${{ github.sha }}` inline in a script | token only through env |
| M14 | first step no longer prints the commit | commit named first |
| M16–M19 | `data`, `test`, `**/*.sqlite*` removed; `**/node_modules` narrowed back | context leaves out |
| M20–M22 | `data` unanchored to `**/data` (would take `server/data/`); `server` excluded; `client/src` excluded | context keeps |

**The first run was 20 of 22.** M9 is the test gap above. M8 was an invalid
mutation: it rewrote the first `flyctl deploy --remote-only` in the file, which
is in the header comment, not the command. The runner now rejects any mutation
that changes only comment lines, and re-running the old M8 against it prints
`INVALID … (changed nothing, or only comments)`.

## Flags and behaviour checked against flyctl itself, not memory

flyctl v0.4.105 `--help`: `deploy --remote-only --app`, `logs --no-tail --app`,
`secrets set --stage --app`, `secrets list --json`, and
`tokens create deploy --app --name --expiry`/`tokens list`/`tokens revoke` all exist.

From flyctl's source at tag `v0.4.105` (`internal/command/secrets/`):

- `set.go` `SetSecretsAndDeploy` → `appsecrets.Update` → `DeploySecrets`. With
  `--stage`, `DeploySecrets` prints one line and returns nil (`secrets.go:67-71`).
  There is no unchanged-value error path, so re-setting `SCHEDULER_DISABLED=1` on
  every deploy exits 0 rather than turning every run after the first red.
- `list.go` `--json` emits `name` in both of its shapes (`SecretWithStatus`, and the
  `secretBasic` fallback). The workflow's `jq` presence check reads only `name`.

`superfly/flyctl-actions` is pinned to tag `1.6`,
`ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1` (`git ls-remote`), whose
`setup-flyctl/action.yml` was read at that commit. This follows the hash-pinning
rule `ci.yml` states. `ci.yml` itself is untouched.

## Why staged, not an immediate release

deploy-654ff93.md step 2 sets the brake without `--stage` and accepts the extra
release as a side effect. What it requires is that the brake be an app-level
secret before the new image boots. `--stage` meets that: the staged secret goes
out in the deploy's own release, so there is one restart, and the old image is
not restarted first.

## The build context and the image: a real Docker build

Docker 29.3.1, `node:22-slim` at
`sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9`.

**Setup.** One copy of this tree (no `.git`, no `node_modules`) plus 453 MB of
simulated local-only files of the kinds Nick's upload contained:

- `data/derived/local-copy.sqlite` (300 MB)
- `data/export.csv` (100 MB)
- `analysis/notebook.parquet` (8 MB)
- `server/local-dev.sqlite` (40 MB)
- `server/data.pre-migration-20260922.bak` (5 MB)

Each build differs only in `.dockerignore`. The builder cache is pruned before
each context measurement, because BuildKit syncs contexts incrementally. An
unpruned second build reported 46 kB, a delta, not a size.

| | old `.dockerignore` | new |
|---|---|---|
| context transferred | **491.44 MB** | **12.18 MB** |
| context bytes (`du -sb`) | 491,507,835 | 12,350,544 |
| database files in context | 3 | 0 |
| final image | 142,239,603 B | 95,036,168 B |
| database files **inside the image** | `/app/server/local-dev.sqlite`, `/app/server/data.pre-migration-20260922.bak` | none |
| `/app` top level | client node_modules package-lock.json package.json scripts server | identical |

**The finding beyond size.** The final stage copies `server/` and `scripts/` whole.
The old file excluded only `server/data.sqlite*`, so a local database under any
other name, or any `.bak`, under `server/` was baked into the image and pushed
to Fly's registry. The new `**/*.sqlite*` and `**/*.bak` close that. No
`.sqlite` or `.bak` is tracked in git (`git ls-files`).

**The sandbox needed one change, and it is recorded.** This container's egress goes
through an intercepting CA, so `npm ci` inside `docker build` fails TLS
(`self-signed certificate in certificate chain`). The image builds used a bench
copy of the Dockerfile. It is identical except for two lines after each `FROM`:
`COPY .bench-ca.crt /bench-ca.crt` and
`ENV npm_config_cafile=… NODE_EXTRA_CA_CERTS=…`. The repo's Dockerfile is not
changed. The context measurements used a probe Dockerfile with no network step
(`COPY . /ctx`, then `du`/`find`).

**Smoke boot of the new image**, with fly.toml's `[env]` (`HOST=0.0.0.0`,
`NFL_SEASON=2026`), `SCHEDULER_DISABLED=1`, and an empty `/data` volume. It was
checked with the workflow's own confirmation logic:

- `/api/health` answered after 2 s: `{"ok":true,"uptime_s":2}`. Uptime check passes.
- `Scheduler disabled via SCHEDULER_DISABLED=1` is in the boot log. Brake check passes.
- `GET /` → 200: `client/dist` is served.
- **Negative control:** the same image without `SCHEDULER_DISABLED`, run with no
  credentials in its environment, does **not** print the line. So the check
  separates brake-on from brake-off rather than matching something always present.

The first boot attempt got no health answer: without `HOST` the server binds
`127.0.0.1` inside the container (`server/index.js:181`). That was a harness error,
not an image fault. Fly sets `HOST=0.0.0.0` in `fly.toml`.

## Excluded paths, and why each is safe

The final stage copies only `package*.json`, `client/dist` (built in the build
stage), `server/` and `scripts/`. The build stage runs `npm ci` and
`vite build --config client/vite.config.ts` (root `client/`). The live database is
the `/data` volume (`GRIDIRON_DB_PATH=/data/data.sqlite`).

- **`data`**: never copied into the final stage, and not read by the vite build.
  The pattern is anchored to the root, so `server/data/`, which holds JSON the
  server reads, stays. The test and M20 guard that.
- **`analysis`**: not in the repo; local-only on the Mac.
- **`test`**: never copied into the final stage, and not needed by `npm ci` or the
  vite build. Five offline scripts (`verify-m4-coverage`, `joint-score-report`,
  `ensemble-rank-report`, `governed-reevaluation`, `forecast-combination-report`)
  import `test/helpers/` for fixture modes. None is run by `server/`, and none
  could run inside the image before this change either, since `test/` was
  never in it.
- **`**/*.sqlite*`, `**/*.bak`**: nothing tracked. The runtime DB is on the volume.
- **`**/node_modules`**: `.dockerignore` patterns are root-anchored, so the old
  `node_modules` line missed nested ones. The image installs its own.

## What this does not cover

- **No real Fly deploy has run from this workflow.** The button, the token, and
  flyctl against the live app are proven only by the first press. Until then,
  the confirmation logic is proven on a local boot of the same image.
- **The deploy token's scope** (`fly tokens create deploy`) is expected to cover
  `secrets set`, `secrets list` and `logs` for this one app, but this has not
  been exercised. If step 2 fails on permissions, nothing has been deployed.
- **The `flyctl logs --no-tail` window** is Fly's recent-log buffer. The step polls
  12 times, 15 s apart. If the boot line has scrolled out, the job fails
  (brake not confirmed), not passes. That is the safe direction.
- **Nick's actual 2.2 GB and 73 MB are not seen from here.** The simulation uses
  the kinds of file his upload listed. That his `server/` held a database or
  `.bak` is inferred from its size, not read.
- **The live image may already carry a local database.** If an earlier local
  `fly deploy` had one under `server/` with a name other than `data.sqlite*`,
  it is in that image. Checking needs Nick's hands:
  `fly ssh console --app gridiron-hq -C "find /app -name '*.sqlite*' -o -name '*.bak'"`.

## The five questions

- **Is it well built?** It is one job, in the runbook's order. Every flyctl flag
  was checked against the CLI, and the two behaviours it relies on were read in
  flyctl's source. It fails closed: no brake, no deploy; brake not seen, red job.
  The weakest part is the log-buffer read, and it fails in the safe direction.
- **Stats or made up?** Measured. The 491.44 MB → 12.18 MB context and
  142 MB → 95 MB image come from real builds on one tree, with the cache pruned.
  The smoke results come from a real boot. The sweep is 22 of 22 and re-runs
  from the committed runner.
- **How do we know?** RED #127 `62816a9` fails 7 of 8. GREEN #127 `ba97ee8` passes 8 of 8. The
  mutation runner, the bench Dockerfile's two-line diff, and the negative control
  are all above. The full gate figures (`npm run check && npm run check:wiring`
  under one guard) are in the PR body. They were measured on the exact pushed
  head, which includes this file.
- **Pointed anywhere else on the platform?** Yes. Any image built by a local
  `fly deploy` could have shipped a local database under `server/`. The live one
  should be checked with the command above. The runbook's step-5 brake release
  stays manual and Nick's.
- **How does it unify?** The deploy now carries the runbook's order itself, and
  the brake check fails loudly instead of depending on someone remembering it.
  This is the project's rule that a layer that has gone inert must say so on
  the surface.
