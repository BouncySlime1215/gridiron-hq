# TASKS — live Active / Waiting-On list

The fast-read summary A5 asks for. `docs/FANTASY-ENGINE-MASTER-PLAN.md` stays the
full authoritative record; this file is what a handoff report quotes.

Last updated: 2026-09-18, cloud session on `cursor/betting-model-audit-fixes-1c85`.

## Active

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
