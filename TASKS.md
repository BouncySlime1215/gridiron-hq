# TASKS — live Active / Waiting-On list

The fast-read summary A5 asks for. `docs/FANTASY-ENGINE-MASTER-PLAN.md` stays the
full authoritative record; this file is what a handoff report quotes.

Last updated: 2026-09-19, cloud session on `cursor/betting-model-audit-fixes-1c85`.

## Active

- **WA Trade Brain resumed in a second cloud session, 2026-09-19 (this entry).**
  Picked up cold from `HANDOFF.md` + the first Active entry below, per A5. Nick's
  laptop is off for the night; this session is cloud-side and unaffected by that.
  - **`build:value-and-acceptance` — in flight.** The next queued Trade Brain
    stage per D4 ("P(accept) ... a band from the heuristic ... with the observed
    accept rate as the anchor, labelled as a band"). Builder agent working
    test-first against pre-registered gates, owning a new
    `server/services/trade-acceptance.js` + its test + `docs/tdd/value-and-acceptance.tdd.md`,
    with only surgical additive wiring into `trade-engine.js`/`trade-tactics.js`.
    Not yet landed; no commits to report at the time of this write.
  - **Idea -> proposal pipeline being mapped** (read-only) so
    `build:sendable-proposals` can be briefed accurately rather than guessed at.
  - **Skills installed in this box** at `~/.claude/skills`, since a cloud session
    does not share Nick's Mac's `~/.claude`: `i-have-adhd` (A2 rule 5 names it for
    every message to Nick) plus `tdd-workflow`, `eval-harness`, `verification-loop`,
    `frontend-patterns`, `backend-patterns`, `coding-standards`, `security-review`,
    `clickhouse-io`, and the review agents from `worldflowai/everything-claude-code`.
    `silent-failure-hunter` and `mle-reviewer` are Nick's own and are NOT in that
    marketplace — they remain Mac-only, so any review pass run from a cloud
    session is a near-equivalent, not the same agent.
  - **Jev key: a key was created and then burned the same night.** Nick generated
    an `AI_GATEWAY_API_KEY` (Vercel AI Gateway, the `typesafe-ai/jev` model in
    `jev.ts`) and posted a screenshot of its value into the project chat — the
    same way the Anthropic key was burned on 2026-09-18. He was told to rotate it:
    create a fresh key, revoke the exposed one, and set the new value ONLY in the
    environment-variables box as `AI_GATEWAY_API_KEY`. **Confirm the exposed key
    was actually revoked before trusting that this is closed** — it was not
    verified from inside this session, which cannot see that dashboard.
    No Jev-dependent work was started, so nothing is blocked on it either way.
  - **What this box CANNOT check, because there is no database in it.** A cloud
    session is a fresh clone: `server/data.sqlite` is gitignored and absent, and
    so is the private chat DB (`GRIDIRON_CHAT_DB_PATH`). Everything built here is
    fixture-verified only. The list below is what needs Nick's Mac (or the Fly
    install) to actually settle, and none of it should be reported as closed
    until it is run there:
    1. **The real accept-rate anchor.** D4's "6 accepts, 24 declines" is a
       number from when the plan was written. The P(accept) band anchors on it
       and carries its `n`, but today's real counts per manager are unknown from
       here. Run the new service against the live DB and confirm the anchor it
       reads is the real one.
    2. **Whether the acceptance band changes anything.** D4's own acceptance
       criterion — "top ideas change when the sentiment map is zeroed" — needs
       the five real leagues. The ablation hook exists and is unit-tested; it has
       never been run against real rosters.
    3. **The two Trade Brain bugs, re-checked live.** They are recorded closed
       (edge-test violation in `perceptionFactorFor`; the horizon-upgrade refusal
       in `offerFor`/`offerForMany`), but closure was established by reading the
       shipped code, not by re-running the two live cases that found them — the
       Ja'Marr Chase refusal and the Tyler Warren/Mahomes deal. Re-run both.
    4. **QBR corruption is still in the live data.** 520 of 550 rows for season
       2026 in `nfl_qbr_weekly` are exact copies of the 2025 row; weeks 2-18 are
       100% copies. The ingestion fix shipped; the existing bad rows were
       deliberately left alone as a remediation call for separate review. Any
       consumer reading 2026 weeks 2-18 today still reads fabricated data.
    5. **Three things from tonight's earlier session, still unconfirmed:** the
       `POST /model/sync` historical pull triggered on Fly (outcome never
       confirmed — check `GET /model/setup-status`), the scheduler live-tier
       pass duration after `767d804` (did it actually halve), and `npm run check`
       on the Mac (a cloud box cannot boot the server, so the start-smoke fix
       from `5983e9e` has never been exercised).

- **Fly.io self-host — LIVE, confirmed 2026-09-19 04:58Z.** App name
  `gridiron-hq`, URL **https://gridiron-hq.fly.dev/**. Nick logged in and saw
  the app's real UI (ESPN-connect onboarding modal, expected on a fresh empty
  DB). Shipped: `6b0e06a` (Dockerfile, fly.toml, `.dockerignore`,
  `server/index.js` binds `HOST` env var — 0.0.0.0 in prod, still 127.0.0.1
  locally), `9a42219` (`server/db/index.js` `mkdirSync`s the DB's parent dir
  before opening it — a fresh Fly volume mount has no pre-existing directory
  and `DatabaseSync` throws instead of creating one), `d1ba0f7` (real security
  fix — `POST /espn-connect/cookies` was deliberately unauthenticated for the
  bookmarklet, harmless behind a private tunnel but a free anonymous-hijack on
  a public hostname; now token-gated, 29/29 tests pass), `69f86ba` (hardened
  the loopback check against Fly's own proxy headers, defensively). Full
  detail: memory `gridiron-hq-fly-self-host` and `gridiron-hq-fly-security-gaps`.
  **Never docker-build-tested locally** (no docker daemon in the cloud
  sandbox) — `fly deploy` was the real first build test, and it passed.

  **Redeploying / picking this up cold — exact steps:**
  1. `git pull` on the Mac first. If it fails with "untracked working tree
     files would be overwritten" on `.dockerignore`/`Dockerfile`/`fly.toml`,
     those are stale local copies from the Fly web "Launch" UI — move them
     aside (`mv fly.toml fly.toml.local-backup`, same for the other two) and
     pull again.
  2. `fly deploy -a gridiron-hq` (the app already exists; a bare `fly deploy`
     fails with "missing an app name" unless `fly.toml` has `app = "..."` in it).
  3. Watch `fly logs -a gridiron-hq` or the dashboard for the health check to
     go passing and `Gridiron HQ listening on http://0.0.0.0:5177`.

  **No real remote login exists yet** (`local-session`/`pairing-code` both
  require direct loopback — see `gridiron-hq-fly-security-gaps`). To get a
  session token onto a fresh browser:
  ```
  fly ssh console -a gridiron-hq -C "node -e \"fetch('http://127.0.0.1:5177/api/auth/local-session',{method:'POST'}).then(r=>r.json()).then(o=>console.log(o.token))\""
  ```
  (the container is `node:22-slim` — **no `curl` binary**, must use node's
  fetch). Copy the printed token straight into the browser's own console —
  never paste a live token into chat/a doc/a commit. In that console:
  `localStorage.setItem('gridiron_session_token', '<token>')`, then reload.
  Chrome's DevTools blocks pasting into the console by default — type
  `allow pasting` and press Enter once first, or the paste silently no-ops.

  **State as of 2026-09-19 05:03Z, for whoever picks this up next:**
  - Nick is logged into https://gridiron-hq.fly.dev/ in his Mac's Chrome.
  - He clicked "Update now" on the historical-data banner (`POST /model/sync`
    — pulls 5 seasons of play-by-play/nflverse/advanced/ADP/coaches/
    ffopportunity and refits models). Outcome not confirmed in this session —
    check `GET /model/setup-status` or `fly logs -a gridiron-hq` before
    assuming it finished; it can take several minutes and this is a small Fly
    machine, so a timeout/OOM on the first real heavy job is plausible.
  - **ESPN is not yet connected on this Fly install** — it's a brand-new DB,
    separate from the Mac's. Reconnecting is the next real step to make the
    app useful there (same bookmarklet flow, now posts to the Fly URL).
  - A session token got pasted into the project chat twice during the login
    bootstrap (not the repo, not a commit — just chat). Not revoked as of
    this note. Low risk (private thread, single user) but not zero; revoking
    it needs a fresh token minted and confirmed working first — see
    `gridiron-hq-fly-self-host` memory for why, and don't just revoke by
    itself or it locks Nick out with nothing to log back in with.
  - Anthropic key rotation (flagged 2026-09-18, unrelated to tonight's work)
    is still unresolved — see the Outstanding section below.

- **`npm start` was broken for everyone; fixed 2026-09-19.** Two independent bugs,
  both found live on Nick's Mac, both pushed to this branch.
  - *`5983e9e` — the one that actually blocked startup.* `start.mjs`'s readiness
    poll called `GET /api/teams`, which is behind `legacyAuthenticated`
    (`server/index.js:82`) and answers 401 with no bearer token. `response.ok`
    was false on all 60 attempts, so the launcher printed "did not come online"
    and **SIGTERMed a healthy server**. Readiness now probes
    `GET /api/model/status` (unauthenticated on purpose) and counts any HTTP
    reply as up. Same wrong probe fixed in `tunnel.mjs` and `bootstrap-data.mjs`.
    `start-smoke.mjs` had it too — so `npm run check` would have failed on a
    healthy app — and now mints a loopback session via
    `POST /api/auth/local-session` to keep its real assertion.
  - *`0507265` — a second, latent one.* Everything addressed the server as
    `localhost` while `server/index.js:143` binds `127.0.0.1`. On macOS
    `localhost` resolves to `::1` first, so probes and the browser hit an
    address nothing listens on. All loopback URLs are now `127.0.0.1`,
    including the one the server advertises on boot.
  - *Not verified in a cloud box:* its `node_modules` is incomplete, so the
    server will not boot there and `start:smoke` cannot run. Lint passes; the
    diagnosis came from the code plus Nick's terminal. **Run `npm run check` on
    the Mac to confirm the smoke fix.**

- **Scheduler freeze: diagnosed with real data, partially fixed 2026-09-19.**
  With the scheduler on, the app accepted connections but felt unresponsive —
  Settings spun and `curl` sometimes hung. `481e216` shipped instrumentation
  (`[scheduler] '<job>' took Xs`, `[scheduler] <tier> tier pass took Xs total`,
  threshold 750ms). Nick ran it and pasted real output: the `live` tier (every
  90s) took **67.4s per pass**; `growth`'s `nfl_learned_shadow` took **72.5s**
  on its own (it shells out to a Python subprocess to retrain a model, gated
  hourly). Within the live tier, `nfl_prop_feeds` (19.7-28.6s) and
  `beat_the_close` (20.2-22.0s) were the large majority of the 67.4s — both
  only need hourly freshness (`maxAgeMinutes: 60`) but were being *checked*
  every 90 seconds, stalling the tier's genuinely time-critical jobs (pick
  watch, play-by-play, line watch) behind them whenever either was due.
  *Fixed in `767d804`:* moved both to the `metered` tier (5-minute check
  cadence — no meaningful freshness loss against an hour-scale budget), which
  should cut the live tier's per-pass time roughly in half. **Not yet
  confirmed live** — next step is Nick restarting with the scheduler on and
  reporting the new live-tier pass duration. If it's still bad, the remaining
  suspects are `polymarket` (15.3s/run, kept in `live` on purpose — it wants
  3-minute freshness) and `nfl_learned_shadow`'s Python subprocess. Workaround
  if needed in the meantime: `SCHEDULER_DISABLED=1 npm start`.

- **Mac install is live as of 2026-09-19.** Repo is at
  `~/Documents/GitHub/gridiron-hq`. ESPN connected with the stored cookies, five
  leagues added (Matta - Kodsi Annual, DMV 23-24, Transfer portal, My 2026,
  My 2025). League chat pulled on the machine itself — 15,993 messages,
  515,790 classified, 10 managers, 122 player reads, reading "Up to date"
  rather than the uploaded snapshot it showed before.

- **Cloud keys and the laptop-closed run (2026-09-18/19 session). Code side done,
  one manual step left for Nick.**
  - *Done, merged to this branch as `cc6a788`.* `getApiKey()` now reads
    `GRIDIRON_ANTHROPIC_API_KEY` first, then `ANTHROPIC_API_KEY`, then
    `app_settings`. A Claude Code cloud environment claims the name
    `ANTHROPIC_API_KEY` for its own session auth and will not forward it to the
    process — the settings screen says so under the box — so the key was pasted
    and saved correctly the whole time and never arrived. `check-environment.mjs`
    accepts either name and prints which one carried it. Covered by a new test in
    `test/llm-plumbing.test.js` (31/31 pass, lint clean).
  - *Waiting on Nick.* He must (a) rotate the Anthropic key — the old one was
    exposed in a screenshot posted to the project thread on 2026-09-18 — and
    (b) re-paste it in the Environment variables box as
    `GRIDIRON_ANTHROPIC_API_KEY=`, deleting the dead `ANTHROPIC_API_KEY=` line.
    Until then every LLM path still fails on the call.
  - *Keys verified live in a cloud box, 2026-09-18.* `ODDS_API_KEY` works but the
    plan is at 1,920 of 20,000 requests left, so it is nearly spent (it is a paid
    plan, not the 500/month free tier the code comments assume). `TWITTERAPI_IO_KEY`
    works. `CFBD_API_KEY` works — `/player/usage?year=2025` returned 5,613 players,
    so `draft-assist.js`'s `college_signal` will stop returning null once the
    7-day `cfbd_rookie_usage` job runs. `PARLAY_API_KEY` (MLB-only),
    `SPORTSGAMEODDS_API_KEY` (free tier is 2.5k objects/month, gone in ~3 days at
    the scheduler's 30-min cadence) and `PFF_API_TOKEN` (paid, no free tier) were
    all assessed and deliberately skipped.
  - *Open decision.* The app cannot run in a Claude Code session — no
    browser-reachable port, so ESPN cannot be connected and `server/data.sqlite`
    cannot be rebuilt there. Making the app genuinely laptop-independent is
    WF / Phase 11 (Fly.io, Google sign-in, per-user Claude keys). Nick has not
    said yes to starting it. See `docs/CLOUD-MIGRATION.md`.

- **WA / Trade Brain — the two open bugs: both now closed.**
  - *Bug 1, edge-test violation (`perceptionFactorFor`).* **Closed by the tactics
    step, not by a new fix.** `tactics-and-packages` (`ffe97c9`) added
    `edgeTest()` in `server/services/trade-tactics.js` and `findTrades` applies it
    as a hard filter (`trade-engine.js`, `const eligible = shaped.filter(d => d.edge.passes)`).
    Its fourth check, `not_only_perception`, re-scores every deal with the
    counterparty read removed and drops anything that is only positive with it —
    exactly the Tyler Warren / Mahomes case the verifier raised. Verified by
    reading the shipped code, not by trusting the commit message.
  - *Bug 2, wrong refusal on horizon upgrades (`offerFor` / `offerForMany`).*
    **Fixed this session.** The rung loop had already been moved to
    `ladderGain` (horizon-weighted); the free-add ceiling gate above it was still
    a `bestLineup` diff on this week alone, so a player who helps across the rest
    of the season but not this Sunday was refused outright and his ladder never
    ran. Both gates now read a shared `freeAddCeiling()` that goes through
    `evaluate()` + `ladderGain` — the same call the rungs make, so they cannot
    drift apart again. Three regression tests in
    `test/trade-engine-correctness.test.js` (G9a/G9b/G9c).

- **Cloud migration — corrected 2026-09-18 after a real cloud-box test.** The
  first version of `docs/CLOUD-MIGRATION.md` said ESPN could be connected from a
  cloud session's Settings page. It cannot: **a Claude Code cloud session has no
  browser-reachable URL** (`SESSION_INGRESS_URL` resolves to
  `api.anthropic.com`, no preview URL on the session record, container reclaimed
  after inactivity), verified in this box. That also invalidated the doc's
  `curl <cloud-url>/api/league-chat/upload`. Both fixed, and the doc now states
  plainly what laptop-closed buys today: **Claude sessions doing repo work with
  the keys live — not the app running with its scheduler and UI.** Hosting the
  app (**WF / Phase 11**) is the real prerequisite for the full thing, and the
  doc says so rather than leaving the gap implied. One thing worth keeping:
  `POST /api/espn-connect/cookies` *is* session-free and mounted without the
  auth wrapper, so there is a CLI way to hand cookies to a headless box — the
  doc records it with the caveat that those cookies are a live ESPN session and
  a chat thread is a bad place to paste one.
- **Cloud migration tooling — built.** `docs/CLOUD-MIGRATION.md` is the path;
  `scripts/check-environment.mjs` names every missing file and key and what each
  costs (exits non-zero when something required is absent, so it works as a
  startup gate); `scripts/import-league-chat.mjs` installs an uploaded corpus and
  refuses one that is not the corpus. ESPN needs no file copy at all — the
  bookmarklet posts back to whatever host served it, so it works against a cloud
  URL as-is. The archives never move: line-history is betting-side only and the
  fantasy engine never opens it; nflverse rebuilds from public feeds if WO
  needs it.
- **Pull Messages — built.** `server/services/league-chat-sync.js` +
  `server/routes/league-chat.js` + the League chat card in Settings. On the Mac
  the button runs the whole incremental pull (extract, classify, rollup); in a
  cloud box the same card is a staleness read, because the server reports its own
  capability rather than the client guessing. `/pull` is loopback-only — it
  spawns a process that reads a private message store and the tunnel makes this
  app internet-reachable. 8 tests in `test/league-chat-sync.test.js`.

- **Suite state in this cloud box, measured 2026-09-18.** A full `npm test` runs
  to completion here: **2,609 pass / 14 fail / 41 skipped of 2,667**. Every one
  of the 14 is an environment gap, not a code fault:
  - `nfl-news-events` (7) and `page-explain` (4) reach the Anthropic API and
    fail `Connection error.` — no `ANTHROPIC_API_KEY` in this box.
  - `prop-clv-free-capture` (3) are the known pre-existing prop-CLV failures
    already filed in Q4. Unchanged by anything in this session.
  - `report-cache` (3) aborts spawning a worker thread (`Promise resolution is
    still pending but the event loop has already resolved`). Node's own summary
    scores that file `fail 0`, which is why a raw `not ok` count reads 17
    against a reported 14.

  Excluding the two key-dependent files, the rest of the suite is
  **2,613 pass / 3 fail / 41 skipped of 2,660** — the 3 being the prop-CLV ones.
  Re-check the key-dependent and worker-thread groups on the Mac.

## Waiting On

- **Nick — the live five-league check.** The cloud box has the code and now the
  migration path, but not the data itself. Verifying against the real leagues
  needs the chat corpus pulled from the laptop and ESPN connected once.
- **Nick — WA's remaining stages.** WA was stopped entirely, so the next three
  Trade Brain stages are no longer running anywhere:
  1. `build:value-and-acceptance` — value + P(accept) band.
  2. `build:sendable-proposals` — Trade Lab.
  3. WA integration / final verify pass.
- **Usage gate.** Desktop weekly was 96% (TOO CLOSE) at the pause. Per A5, the
  next workflow launch runs `~/claude-handoff/usage.sh` first and hands off to
  Terminal on TOO CLOSE.

- **Secrets could ride the environment's credential injector, but not as the
  code stands.** Checked, not assumed: `CFBD_API_KEY` travels as
  `Authorization: Bearer` and three more as custom headers, so the injector
  could carry them and never expose the value to the process. The blocker is
  upstream — every feed gates itself on `Boolean(process.env.X)` before it makes
  a request (`odds-api.js:21`, `cfbd.js:32`), so a key held only by the injector
  makes the feed report itself unconfigured and no-op. Would mean splitting "is
  this configured" from "here is the secret". **[WD]**, worth doing if these ever
  run somewhere less private than a private project. Two keys travel in the query
  string and could never use it.
- **The offline guard does not cover the Anthropic SDK.**
  `test/offline-guard.mjs` replaces `globalThis.fetch`, which the SDK does not
  go through, so `nfl-news-events.test.js` (7 tests) and `page-explain.test.js`
  (4) make real network calls and fail with `Connection error.` wherever there
  is no key. (Each call burns its SDK retry budget before giving up, so the
  suite is slow through those files rather than stopped at them — an earlier
  note here said the runner died at that point; it does not, a full run
  completes.) Deferred with evidence rather than fixed here: it is unrelated to either Trade
  Brain bug and belongs with **[WD]** housekeeping, next to the 3 prop-CLV
  failures. Everything else in the suite passes offline.

## Someday

- Everything in the master plan's part F (the full deferred queue), unchanged.
- The plan docs live only on this branch — it is 305 commits ahead of `main`.
  Merging is Nick's deliberate call, not a side effect of any task here.

## Done

- W0 — early-season projections, ROS value, fake floors, waiver drops, IR starts,
  10-lens skills review. Shipped and live.
- WA essentials — play-chance with ESPN designations, manager data for all 5
  leagues, LLM costs and budgets, the two missing reviews, infra.
- WA Trade Brain — correctness, valuation map, tactics-and-packages (incl. the
  edge test), and its verifier fix (`5deb33a`).
- Both open verifier bugs (see Active above for which was closed how).
