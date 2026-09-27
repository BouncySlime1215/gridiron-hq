---
name: league-chat-sync-command
description: Nick syncs the league chat corpus with one command, `npm run chat:sync`, added 2026-09-19 in draft PR #24 (was #13); it needs GRIDIRON_FLY_TOKEN set on his Mac.
metadata:
  type: project
  modified: 2026-09-19T15:47:43.172Z
---

Built 2026-09-19. Now draft **PR #24**
(https://github.com/BouncySlime1215/gridiron-hq/pull/24), branch
`claude/project-thread-sytruo-stacked`, stacked on
`claude/project-thread-3ldl77-server` (**PR #10** of the split). It started as
PR #13 on `cursor/betting-model-audit-fixes-1c85`; that would have been
stranded when PR #6's branch goes away, so the two commits were replayed onto
#10 (no conflicts — all four files byte-identical between the branches) and
#13 was closed. It sits on #10 as a unit rather than split with #9, because
its `docs/CLOUD-MIGRATION.md` edit documents `npm run chat:sync`, which does
not exist until #10.

Replaces the old two-step flow (click Pull in the local app, then hand-write a
curl). `scripts/chat-sync.mjs` preflights the host and token, runs
`scripts/chat/extract_league_chat.py --classify --rollup`, refuses to upload a
missing or empty corpus, POSTs to `/api/league-chat/upload`, and prints one
line saying how many messages are live.

**The one-time setup Nick needs, and the non-obvious part:**
`/api/league-chat/upload` is mounted behind `legacyAuthenticated` in
`server/index.js`, so the upload genuinely requires a bearer token — the curl
in `docs/CLOUD-MIGRATION.md` predated that and would 401. The script reads
`GRIDIRON_FLY_TOKEN` (or `GRIDIRON_CHAT_TOKEN`/`GRIDIRON_TOKEN`) from the
environment or `.env`, never argv. Minting it is the `fly ssh` one-liner in
[[gridiron-fly-login-token]]. Host is configurable via `--host` /
`GRIDIRON_CHAT_HOST`, defaulting to the live app.

The extraction cannot move to the cloud: Apple Messages has no API, so reading
`~/Library/Messages/chat.db` needs his Mac with Full Disk Access. Everything
after it is automated. This is the one permanent exception to
[[gridiron-cloud-goal]] — see [[fly-deployment-outside-repo]].

As of 2026-09-19 22:12Z, re-read after the deploy, the live app still holds
**no corpus at all**: `capability.reason` is `no_messages_db`, `corpus` is
`null` (that is `corpusStats()` returning null because the FILE is absent —
league-chat-sync.js:88 — not an empty corpus), `last_pull` null,
`freshness.state` `absent`.

**Checking the corpus landed takes TWO reads, not one.**
`GET /api/league-chat/status` only proves the file arrived. The binding is
`POST /api/trades/managers/rebuild`, whose per-league rows carry
`chat_corpus` and `rosters_with_chat`. The failure that matters looks like
success: 200 with a healthy message count while every league reports
`chat_corpus: false` and `rosters_with_chat: 0`, because
manager-signals.js:449 keys on confirmed `league_member_identity` rows. See
[[gridiron-live-data-state]].

**Uploading the corpus is NOT sufficient on its own — do not tell Nick to run
this until PR #26 is deployed.** See [[chat-corpus-league-binding]] for why
and for the league-3 identity seeding he must supply once.

Note `manager_chat_profile` in the corpus is `GROUP BY name` — no league
column, so its ~10 profiles are 10 *people*, not per-league. The per-league
`manager_profiles` table is a different thing, written by league-brain.js.

**Upload size ceiling, fixed 2026-09-19.** The first real run failed on a
61.8 MB corpus with a bare 502. Measured against the live app: 5/20/35 MB
returned a normal 400, 48/55/62 MB died in seconds. Not a timeout and not a
proxy limit — `express.raw` buffered the whole body and concatenated it, about
2x the corpus resident, and the process was killed. Nick resized the machine
to 2 GB, which unblocked it (the same 62 MB now returns 400). PR #24 also
makes the route stream the body to disk so it no longer depends on machine
size; **that part needs a deploy to take effect.**
