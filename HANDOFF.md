# Handoff doc — written 2026-09-18, Nick: "let it happen while u give a handoff doc too"

This is a curated snapshot on top of the automatic switch report (which already
captures PIDs, transcripts, and raw git state). Read this first for the "why";
use `docs/FANTASY-ENGINE-MASTER-PLAN.md` part A5 for the mechanical recovery steps.

## 2026-09-19, later — WA Trade Brain resumed overnight (newest; read this first)

A second cloud session picked the work up cold from this doc and `TASKS.md`
while Nick's laptop was off. Where to look, in order: `TASKS.md`'s first
**Active** entry (what is in flight and what only the Mac can settle), then the
newest **B3** status-log entry in the master plan (the structural audit taken at
that boundary, including the corrected read of migration 057 and the existing
`nfl_news_event_extraction_cache` pattern that `build:sendable-proposals`
should follow instead of inventing a cache).

**The one thing to carry into any Mac session:** nothing from that overnight run
is verified against real data. A cloud box is a fresh clone with no
`server/data.sqlite` and no chat DB, so it is fixture-verified only and must not
be promoted past "tested". `TASKS.md` lists the five items that need the Mac,
including the real accept-rate anchor and a live re-run of the two Trade Brain
bugs that are currently recorded closed on a code reading alone.

**Also open:** the `AI_GATEWAY_API_KEY` Nick created for Jev on 2026-09-19 was
exposed in a screenshot in chat the same night. He was asked to rotate it and
revoke the exposed one; **that revocation was never confirmed from inside the
session.** Verify it before assuming it is closed.

## 2026-09-19 — cloud keys thread (the earlier thread this night)

Written by the thread session that handled Nick's "check the keys work / what do
I need to do so I can shut the laptop" run. Everything below is committed and
pushed to `cursor/betting-model-audit-fixes-1c85`; nothing is sitting on a local
branch. Full detail is the first **Active** entry in `TASKS.md`.

**Shipped:** `cc6a788` (merge of `claude/project-thread-jwjblu`, itself `85bddac`).
`getApiKey()` accepts `GRIDIRON_ANTHROPIC_API_KEY` before `ANTHROPIC_API_KEY`
before `app_settings`, because a Claude Code cloud environment claims the
`ANTHROPIC_API_KEY` name for its own session auth and never forwards it to the
process. `check-environment.mjs` accepts either and reports which one carried the
key. New test in `test/llm-plumbing.test.js`; 31/31 pass, lint exit 0.
(`npm run typecheck` fails in a cloud box on `client/src` only — React is not
installed there. Not caused by this work; do not chase it.)

**2026-09-19 update — the Mac install is live.** `npm start` was broken by two
bugs found that night, both fixed and pushed (`5983e9e`, `0507265`): the
launcher's readiness poll hit a bearer-authenticated route, read the 401 as
"never came online" and SIGTERMed its own healthy server; and every loopback URL
said `localhost` while the server binds `127.0.0.1`, which on macOS resolves to
`::1` first. Details in `TASKS.md`. Repo on the Mac is
`~/Documents/GitHub/gridiron-hq`. ESPN is connected with five leagues, and the
league chat is pulled locally (15,993 messages) rather than the uploaded
snapshot. **Still to verify on the Mac: `npm run check`**, since a cloud box
cannot boot the server to run `start:smoke`.

**2026-09-19 update — scheduler freeze, diagnosed and partially fixed.**
Shipped `481e216`: `runIfStale` and each tier's pass now log
`[scheduler] '<job>' took Xs` / `[scheduler] <tier> tier pass took Xs total`
whenever either crosses 750ms, so a freeze names its own cause instead of
needing a guess. Nick ran it live and pasted real output: the `live` tier
(checked every 90s) regularly took **67.4s per pass**, and `growth`'s
`nfl_learned_shadow` alone took **72.5s** (it shells out to a Python subprocess
to retrain a model, gated to once an hour). Within the live tier, two jobs —
`nfl_prop_feeds` (19.7-28.6s) and `beat_the_close` (20.2-22.0s) — were the
large majority of the 67.4s. Both only carry an hour-scale staleness budget
(`maxAgeMinutes: 60`), so checking them every 90 seconds bought nothing; it
just meant the tier's genuinely time-critical jobs (pick watch, play-by-play,
line watch) queued up behind whichever of the two happened to be due.

**Fixed in `767d804`:** moved both to the `metered` tier (checked on the
5-minute background cadence instead of every 90s) — same eventual freshness
against an hourly budget, roughly half the live tier's per-pass time. **Not
yet confirmed live** — next step is Nick restarting with the scheduler on and
reporting whether the live-tier pass duration actually dropped, and whether
the app still feels frozen at all (if it does, `polymarket`, still in the live
tier at 15.3s/run because it deliberately wants 3-minute freshness, or
`nfl_learned_shadow`'s Python subprocess are the remaining suspects — see the
instrumentation output for whichever tier is slow next). `SCHEDULER_DISABLED=1
npm start` remains the immediate workaround if it's still bad.

**What Nick still has to do by hand, in order:**

1. Rotate the Anthropic key. The previous one was readable in a screenshot he
   posted into the project thread on 2026-09-18 — treat it as burned.
2. In the environment's **Environment variables** box, set the new key as
   `GRIDIRON_ANTHROPIC_API_KEY=…` and delete the old `ANTHROPIC_API_KEY=` line.
3. On the Mac, connect ESPN and run `node scripts/bootstrap-data.mjs`, then pull
   the league chat from Settings. The exact click-path was given in the thread
   and is also in `docs/CLOUD-MIGRATION.md`.

**Do not repeat these dead ends** (each was checked, not assumed):
- The app cannot be reached in a browser from a Claude Code session, so ESPN
  cannot be connected there and `server/data.sqlite` cannot be rebuilt there.
  `scripts/tunnel.mjs` does not help — it is Mac-side and points outward.
- `scripts/launcher.mjs` / `npm run tunnel` are likewise Mac-side.
- The **API credentials** box cannot carry any of these keys: every feed gates on
  `Boolean(process.env.X)` before it makes a request, so the injector never gets
  a request to decorate.

**2026-09-19 update — Fly.io self-host is LIVE.** Confirmed 04:58Z:
**https://gridiron-hq.fly.dev/**, app name `gridiron-hq`. Nick logged in and
saw the real app UI. Full redeploy steps, the no-curl/node-fetch login
bootstrap, and gotchas hit along the way (Chrome's console paste-block, a
stale local `fly.toml` blocking `git pull`) are in the first **Active**
entry of `TASKS.md` — read that before touching Fly again. Still open: real
remote login (Phase 11) — today's workaround is SSH-bootstrapping a session
token by hand, one person, one time per browser.

**Open, awaiting Nick's word:** full WF / Phase 11 (Google sign-in,
per-user Claude keys, real remote login) is what would replace that
workaround. He was offered it and has not answered.

## Where things stand

**Top-level: step 2 of 6 (WA running).** See `docs/FANTASY-ENGINE-MASTER-PLAN.md`
section 00 part B1 for the full 6-step sequence and A4 for what each code means.

## The existing workflows (linked, so the next model doesn't have to search)

All run transcripts live under
`~/.claude/projects/-Users-nick-matta-Claude/b8d740e9-a5f3-4cad-8a9a-765d40f59b44/subagents/workflows/<run-id>/journal.jsonl`.
25 run IDs exist total (most from 2026-09-17, earlier phases already absorbed
into the plan's E-sections) — only these three are from tonight and relevant
to resuming:

- **`wf_90ebcd25-088`** — `wa-essentials-audits-trade-brain`. **The active one.**
  Last journal write 17:23:57 (today). 34 journal lines so far. This is the
  one to watch and resume from.
- **`wf_07805a49-80b`** — `scenario-reaction-audit`. Finished, 8/8 agents done.
  Nothing to re-run. Findings already folded into plan section E6.
- **`wf_58081342-695`** — `early-season-and-skills-review`. Finished, 20 of 21
  done (1 "probably finished" — ended on a tool result, no need to re-run).
  Findings already folded into plan section E5.

To resume WA specifically if its run record shows it died: `Workflow({name:
'wa-essentials-audits-trade-brain', resumeFromRunId: 'wf_90ebcd25-088'})` —
per the tool's own contract this only works same-session; if this is a fresh
session after a handoff, `resumeFromRunId` won't apply and the move is a
**fresh** `Workflow()` call whose script only re-does the unfinished items
below (read each finished item's `"result"` from the journal and pass it in
rather than re-running it).

## Remaining tasks in the WA workflow, in order (Nick: "point the model that will start up to the remaining tasks in the workflow — starting with verify tactics and packaging")

1. **`verify:tactics-and-packages`** — IN PROGRESS right now (agent
   `ac60b583127cb402a`, started after commit `f92bb5f`, no result yet as of
   this write). **Check this first.** It's verifying `tactics-and-packages`,
   which built the nine trade tactics + "the edge test" enforcement the
   master plan specifies (line 245) and which the two open bugs below need.
   Read its `"type":"result"` entry in the journal once it lands; if verdict
   is `issues_unfixed`, read `problems` the same way the last two were read.
2. **Confirm whether the two open bugs got closed** (they may have — tactics'
   own scope includes the edge-test enforcement that bug #1 violates):
   - Edge-test violation in `perceptionFactorFor`, `trade-engine.js:1354-1358`
   - Wrong refusal on horizon upgrades in `offerFor`/`offerForMany`,
     `trade-engine.js:1935-1959` and `2101-2118`
   If still open after tactics' verify lands, they need a dedicated fix
   (~8 lines each, per the original verifiers) before Trade Brain is called
   done — do not let them ship to Nick silently.
3. **`build:value-and-acceptance`** (or equivalently named) — not started yet
   as of this write. Per B1/section C: value + P(accept) is the next Trade
   Brain stage after tactics.
4. **`build:sendable-proposals`** (Trade Lab) — last Trade Brain stage.
5. **WA integration/final verify pass** — after all Trade Brain stages land.
6. **Update B1's State column** (WA → Done) once WA's run record actually
   appears (not just its latest commit — see A2 rule/A5).
7. **Then, only then:** `~/claude-handoff/usage.sh` before touching WO+WB —
   expect TOO CLOSE given the trend (96% weekly as of this write), hand off
   via `handoff-now.sh` if so, per A5.

**Usage gate: TOO CLOSE.** Desktop account weekly usage is at 95% (climbing —
was 90% ~15 min ago). Per the standing rule, the next workflow launch (WO+WB,
once WA finishes) will almost certainly hand off to the Terminal account
(nsmatta@unc.edu) instead of launching here. This is expected, not a problem —
Nick's decision this turn was explicitly "let it happen" rather than force an
early handoff.

## Two real bugs found by WA's own verifiers, not yet fixed

Both violate this project's own hard rules and would show Nick a wrong number
if Trade Lab shipped as-is today. Full detail in `wf_90ebcd25-088`'s journal
(`grep issues_unfixed`), summarized here:

1. **valuation-map — edge-test violation.** One surfaced trade (Tyler Warren for
   Mahomes, league 3) scores positive only via the new perception multiplier,
   while it's actually -0.48 ppg for Nick on our own numbers — violates the
   plan's non-negotiable "must be positive on our numbers" rule. Root cause:
   `perceptionFactorFor` in `server/services/trade-engine.js:1354-1358`.
2. **trade-engine-correctness — wrong refusal on a real upgrade.** `offerFor`/
   `offerForMany` still gate on a weekly-only ceiling while the ladder below it
   was fixed to use horizon-weighting. Verified live: offering Ja'Marr Chase
   gets refused as "would not crack your starting lineup" despite being +0.17
   ppg horizon-weighted. Root cause: `server/services/trade-engine.js:1935-1959`
   and `2101-2118`.

Both were explicitly routed by their verifiers to "the tactics step" / "T1/T2"
— check whether `tactics-and-packages`'s GREEN commit (`ffe97c9`) or its
upcoming verify pass actually addressed them before assuming they're still
open. If still open once WA's Trade Brain sequence fully lands, they need a
dedicated fix (both are small, ~8 lines each per the verifiers' own notes) —
**do not let them ship to Nick unfixed and unmentioned.**

## If WA's run died mid-flight (desktop account hit its limit)

Per A5: finished agents' results survive in their own transcripts even though
the run itself died. Recovery is: read `wf_90ebcd25-088`'s journal for which
items got a `"type":"result"` entry (done) vs. which only got `"started"` with
no matching result (unfinished, re-run these). Do not re-run anything that
already has a result — reuse it.

## Keep this current

`TASKS.md` and this doc's numbered task list both feed the switch report —
update the numbered list above as each item lands, don't let it go stale.
