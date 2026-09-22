# Deploy runbook: 654ff93 onto gridiron-hq.fly.dev

Written 2026-09-22 as PREP ONLY. Nothing in this file has been executed. Every
`fly` command here is Nick's to run; this session cannot and does not run them.

Base: `origin/main` **654ff93** (full 654ff933), the tree after Nick squash-merged
#63, #52 and #49 on 2026-09-21. Currently deployed: the **pre-merge** image, built
from **791b131**.

---

## The answer first

**This deploy applies no schema.** `git ls-tree server/migrations/` is byte-identical
between 791b131 and 654ff93 — 63 files either side, highest still the two 062s.
#49 changes only `fly.toml`, #52 only the `NFL_SEASON` env line, #63 only the
scheduler and its tests.

That removes the largest hazard the earlier plan carried. `backupBeforeMigration`
(`server/db/index.js:118`) runs **only when new schema is about to be applied** —
it is gated on `SELECT COUNT(*) FROM schema_migrations WHERE name <> '000_legacy_schema'`
having prior rows *and* a pending migration to run. With nothing pending there is
**no `VACUUM INTO` of the 445 MB database on boot**, so:

- the `SNAPSHOT_HEADROOM_BYTES = 2 GiB` guard (`server/db/index.js:144`) does not fire,
- boot is the plain cold start measured at 60–180 s on 2026-09-19,
- and that sits well inside the `grace_period = "300s"` #49 just set (`fly.toml`).

**This is conditional on the deploy carrying no migration.** Two branches in flight
do add one: the ESPN transaction collector adds `066_league_transactions_raw.js`, and
the fantasy-plan outlook fit store adds 065. **Neither may ride this deploy.** If
either lands first, the whole snapshot/headroom section of the older plan comes back
and this runbook must be re-read before use.

---

## The hazard this runbook exists for

`SCHEDULER_DISABLED=1` — the brake — **is not in `fly.toml`.** `grep -rn SCHEDULER_DISABLED`
across the repo finds it only in code that reads it (`server/services/scheduler.js:1927` at 654ff93)
and in comments. It is set out-of-band on the running machine.

That matters because how it was set decides whether it survives `fly deploy`:

- set with `fly secrets set` → it is app-level and **persists** across deploys,
- set with `fly machine update --env` → it is machine-level and a `fly deploy`
  that replaces the machine **can drop it**.

If the brake is dropped, the new image starts all 24 live-tier jobs on a 90-second
timer — the exact condition the brake was applied for, on an image that fixes only
one of the two 90-second starters. **So step 1 is to establish which kind it is, and
step 2 is to re-assert it as a secret regardless.**

`fly secrets list` prints names and digests, never values. Reading it satisfies the
project's secrets rule: presence, never content. Do not paste its output anywhere.

---

## Sequence

Each step says what proves it. A step without its proof read is a step not done.

### 1. Establish how the brake is set

```
fly secrets list --app gridiron-hq
fly machine list --app gridiron-hq
```

Proof: `SCHEDULER_DISABLED` appears in the secrets list, or it does not.
If it does **not** appear there, it is machine-level and step 2 is mandatory.

**Never touch `LOOP_WATCHDOG_*`.** Those env vars are not the brake and changing
them changes the watchdog's own threshold.

### 2. Re-assert the brake as an app secret, before deploying

```
fly secrets set SCHEDULER_DISABLED=1 --app gridiron-hq
```

Proof: the command reports the release, and `fly secrets list` now shows the name.
Note this itself triggers a release — which is fine and is deliberately ordered
*before* the code deploy, so the brake is app-level by the time the new image boots.

### 3. Deploy 654ff93 with the brake still on

```
fly deploy --app gridiron-hq
```

Proof, in this order:

```
curl -s https://gridiron-hq.fly.dev/api/health
```

`server/platform/health.js:45` returns `{ ok: true, uptime_s }`.

- `uptime_s` small and rising on successive reads = the new image is up.
- **The self-validating read:** if `uptime_s` is *below the elapsed seconds of the
  request itself*, the process crossed a restart between the two reads. A restart
  is where `uptime_s` **drops**, not where a probe goes dark — a blocked loop stops
  answering and then answers again inside the same life, and reading darkness as a
  restart is how the earlier count was inflated.
- Compute boot time as `read timestamp − that read's own uptime_s`. That is
  grace-independent. Do **not** measure last-answer-to-next-answer: that window
  includes Fly's `grace_period`, so it partly measures `fly.toml` rather than the app.

Then confirm the brake actually took:

```
fly logs --app gridiron-hq | grep -i 'Scheduler disabled'
```

Proof: `Scheduler disabled via SCHEDULER_DISABLED=1 — no background jobs will run.`
(`server/services/scheduler.js:1928` at 654ff93). **If that line is absent, the brake is off.
Stop and re-assert it before going further.**

### 4. Land the live-tier fix, still with the brake on

Nick's v2 item 5 named **two** 90-second starters: the `nfl_model_growth` job and
the live data tier. #63 covers the first. The second is the branch rebuilt for this
deploy:

`claude/project-thread-o3wt2p-live-tier-offthread` — local at time of writing,
unpushed, off 654ff93. It declares `offThread: true` on **14** live-tier jobs so the
flag holds on the timer path as well as the boot path, and makes `MAIN_THREAD_ONLY`
outrank both the flag and the override in `resolveOffThread`.

Why it matters here: on 654ff93 the boot pass calls `runIfStale(j, { offThread: bootOffThread(j) })`
(`server/services/scheduler.js:1952` at 654ff93) but the tier timer calls `runIfStale(j)` with no
override (`:1997`, same tree), so `resolveOffThread` falls back to `job.offThread ?? job.tier === 'heavy'`
— false for an unflagged live job. **#59's boot fix does not survive the first live tick.**
Unsetting the brake on 654ff93 alone would put those jobs back on the request thread
90 seconds later.

Proof before it goes anywhere near the app: full `npm run check`, exit status read,
numbers stated. This branch needs Nick's explicit word to be pushed at all.

### 5. Only then, release the brake

```
fly secrets unset SCHEDULER_DISABLED --app gridiron-hq
```

Nick's hands, and the one irreversible-in-effect step here.

Proof, all three, not one:

1. **`uptime_s` past 900** on a single continuous life — at least 15 minutes with no
   drop. 900 s is chosen because the live tier fires every 90 s, so it is ten
   consecutive live passes, not one lucky one.
2. **Several live cycles visible in the log**, with the per-pass wall time the tier
   guard prints: `[scheduler] live tier pass took …s total (N jobs)`
   (`server/services/scheduler.js:2005` at 654ff93). A pass time under the watchdog threshold
   across several cycles is the actual claim.
3. **The runs query**, on the machine:

```
fly ssh console --app gridiron-hq
sqlite3 /data/data.sqlite "SELECT id, started_at, status FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 10;"
ls -la /data
```

Proof: rows appearing with `status` progressing, and `/data` listing the database
plus any `.bak` files. **Never delete `/data/data.sqlite.pre-migration-*.bak`.**

### 6. Rollback

**First rollback is re-setting the brake, not rolling the image back:**

```
fly secrets set SCHEDULER_DISABLED=1 --app gridiron-hq
```

It is one command, it is reversible, and it addresses the only failure mode this
deploy introduces. Reach for it before anything else.

Image rollback, only if the brake does not settle it:

```
fly releases --app gridiron-hq
fly deploy --image <the pre-merge image> --app gridiron-hq
```

The recorded pre-merge image is `deployment-01M2VZ9JRYSXVHCRWJ83V360QH`. **Verify it
against `fly releases` before using it** — it is carried from a 2026-09-20 note, not
read today. A full rollback that also restores the database needs the `.bak` and
Nick's explicit word, separately.

---

## What this runbook does not cover

- **The measured stall table found no killer.** The 24 live-tier jobs, run once each
  under `monitorEventLoopDelay`, produced a worst single stall of 1,835 ms
  (`polymarket`), 33× under the 60 s fuse — see
  `docs/evidence/2026-09-22/live-tier-stall-table.md`. That is a **lower bound, not a
  clean bill of health**: it ran against an empty 265-table database, five jobs
  returned no verdict (403 or throw), and five more did no work. So this deploy is
  not being made on a claim that the live tier is proven safe; it is being made with
  the brake on, and the brake stays on until step 5's three proofs are in hand.
- **`player_rosters` throws** — `Provided value cannot be bound to SQLite parameter 3`,
  measured 2026-09-22. That is a Phase 0 inventory row, not a fix, and it stays
  untouched here.
- Key rotation (`AI_GATEWAY_API_KEY` and the Fly token pasted in chat) and the ESPN
  cookie are Nick's hands and are not deploy steps.

## The five questions

- **Well built?** It is a sequence of commands with a proof per step and a named
  first rollback. Its load-bearing claims are read from the tree, not remembered.
- **Stats or made up?** Read today: 63 migrations identical either side of 791b131→654ff93;
  `grace_period = "300s"` in `fly.toml`; `SCHEDULER_DISABLED` absent from `fly.toml`;
  the boot/timer override asymmetry at `scheduler.js:1952` vs `:1997`; 14 `offThread: true`
  additions on the rebuilt branch. The 60–180 s cold start and the rollback image id
  are carried from 2026-09-19/20 notes and are labelled as such.
- **How do we know?** Every claim above names its file and line or its command. Scheduler line numbers are 654ff93's, because 654ff93 is the tree being deployed -- they shift by +188 on the live-tier branch this file sits on, which is why each is labelled. The
  step-3 and step-5 proofs are reads of the running app, which only Nick or a thread
  with egress can take — a coordinator worker's "undetermined" means the network
  policy blocked it and says nothing about the app.
- **Pointed anywhere else on the platform?** Yes: releasing the brake is what makes
  every data-freshness surface real. Until step 5 the freshness registry
  (`servedTables()` in `server/services/source-registry.js`, added on branch
  `claude/project-thread-o3wt2p-servedtables` -- not on this branch or on 654ff93 yet) will honestly report
  almost everything as not current, because nothing is being collected.
- **How does it unify?** It is the single ordered path from "main has moved but the app
  has not" to "the scheduler is running and we can prove it", with the two 90-second
  starters handled in one sequence instead of two.
