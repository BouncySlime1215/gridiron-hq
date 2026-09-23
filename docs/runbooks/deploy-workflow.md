# Deploying from GitHub: the Deploy button

`.github/workflows/deploy.yml` deploys to gridiron-hq.fly.dev from GitHub's own
runner, off a fresh checkout. Nothing has to be run from a Mac, from inside the
repo folder, or with Fly logged in locally.

It starts only from the button. Nothing else triggers it: no push, no merge, no timer.

## One-time setup: the token (Nick only)

1. On the Mac, from any folder:

   ```
   fly tokens create deploy --app gridiron-hq --name github-actions-deploy --expiry 8760h
   ```

   It prints one line starting `FlyV1 `. That whole line is the token.
2. Open https://github.com/BouncySlime1215/gridiron-hq/settings/secrets/actions/new
   (Settings → Secrets and variables → Actions → New repository secret).
   Name: `FLY_API_TOKEN`. Secret: paste the whole line. Add secret.

Do not paste the token anywhere else. GitHub never shows it again, not even to
the workflow's log. To rotate it, create a new one, update the secret, then run
`fly tokens list` and revoke the old one with `fly tokens revoke <id>`.

## Running it

Actions tab → **Deploy** → **Run workflow** → branch `main` → **Run workflow**.

## What it does, in order

The order is [deploy-654ff93.md](deploy-654ff93.md)'s, cut down to what a runner
can do and prove on its own:

| step | what | proof it reads | if it goes red |
|---|---|---|---|
| 1 | prints the commit being deployed | the sha in the log | — |
| 2 | **re-asserts the brake before deploying**: `fly secrets set SCHEDULER_DISABLED=1 --stage`, then checks the name is in the app's secrets | `secrets list --json`, name only | **nothing was deployed.** Usually the token: missing, expired, or not allowed to manage secrets. |
| 3 | `flyctl deploy --remote-only --app gridiron-hq` | flyctl's own rollout and health-check wait | the release did not finish rolling out. Read `fly status` before retrying: a long first boot (a pending migration's backup) can outlast flyctl's wait while the machine is still starting. |
| 4 | **confirmation, after the deploy**: `/api/health` answers, its `uptime_s` is under 900 (a process started by this deploy, not the old one), and the new image's own boot line `Scheduler disabled via SCHEDULER_DISABLED=1` appears in `fly logs` | health JSON; a yes/no on the log line | the image is live but the brake is **not confirmed**. Treat it as off: `fly secrets set SCHEDULER_DISABLED=1 --app gridiron-hq`, then check `fly logs`. |

The brake is staged rather than set with an immediate release, so it arrives in the
deploy's own release: one restart, and the new image never boots without it.
deploy-654ff93.md step 2 accepted a separate release as a side effect. What it
required is that the brake be an app secret before the new image boots, and
staging meets that.

## What it never does

- **It never releases the brake.** `fly secrets unset SCHEDULER_DISABLED` stays a
  manual step after deploy-654ff93.md step 5's three proofs (15+ minutes of
  continuous uptime, several live-tier passes in the log, the runs query on the
  machine), and it stays Nick's.
- It does not roll back. The first rollback is still re-setting the brake
  (deploy-654ff93.md step 6); an image rollback is `fly releases` and
  `fly deploy --image …`, by hand.
- It does not change what happens on boot. The migration, backup and headroom
  conditions in deploy-654ff93.md apply exactly as before.

## The log is public

This repository is public, so every Actions log is too. The workflow prints the
commit, flyctl's deploy output, the `/api/health` JSON (a public endpoint anyway)
and fixed sentences. It does not print app logs, the secrets list, or the token.
Only a yes/no comes out of the log read. Keep it that way when editing the workflow:
`test/deploy-workflow.test.js` fails if a secret reaches a script instead of `env`.

## Not yet proven

A deploy token is scoped to this one app. It is expected to cover `secrets set`,
`secrets list` and `logs` for that app, but nobody has run it yet. The first run
settles it. If step 2 fails on permissions, nothing has been deployed.
